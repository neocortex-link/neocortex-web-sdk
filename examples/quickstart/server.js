/**
 * A minimal Neocortex site: one page with a character, and the proxy that keeps
 * the API key on this server. No framework and no bundler.
 *
 *   cp .env.example .env   # add your key and a character id
 *   npm install
 *   npm start
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createNeocortexHandler, toNodeHandler } from "@neocortex-link/web/server";

try {
  process.loadEnvFile(".env");
} catch {
  // Variables can also come from the shell.
}

const { NEOCORTEX_API_KEY, NEOCORTEX_CHARACTER_ID, NEOCORTEX_BASE_URL } = process.env;
const PORT = Number(process.env.PORT) || 3100;
if (!NEOCORTEX_API_KEY || !NEOCORTEX_CHARACTER_ID) {
  console.error("Set NEOCORTEX_API_KEY and NEOCORTEX_CHARACTER_ID in .env (see .env.example).");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Visitors. A real site would use its own login; this one gives every browser
// an anonymous id in a signed, httpOnly cookie, so the id cannot be forged or
// read by page scripts. Rate limits and credit caps hang off this id.
// ---------------------------------------------------------------------------

const COOKIE = "nx_visitor";
const secret = process.env.SESSION_SECRET || randomBytes(32).toString("hex");

const sign = (id) => createHmac("sha256", secret).update(id).digest("base64url");

function visitorFrom(cookieHeader) {
  const match = new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]+)\\.([\\w-]+)`).exec(cookieHeader ?? "");
  if (!match) return null;
  const [, id, signature] = match;
  const expected = Buffer.from(sign(id));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given) ? id : null;
}

function visitorCookie(id) {
  return `${COOKIE}=${id}.${sign(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
}

// ---------------------------------------------------------------------------
// The Neocortex proxy
// ---------------------------------------------------------------------------

const neocortex = toNodeHandler(
  createNeocortexHandler({
    apiKey: NEOCORTEX_API_KEY,
    baseUrl: NEOCORTEX_BASE_URL || undefined,
    characters: [NEOCORTEX_CHARACTER_ID],
    authorize: (request) => {
      const id = visitorFrom(request.headers.get("cookie"));
      return id ? { id } : null;
    },
    // Trusted context comes from the server, never the page.
    buildContext: () => ({
      events: [{ priority: 1, content: `The shop opened at ${new Date().toLocaleTimeString("en-GB")}` }],
    }),
  }),
);

// ---------------------------------------------------------------------------
// Static files: the page, and the SDK's browser build straight from node_modules
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const sdkDist = join(dirname(fileURLToPath(import.meta.resolve("@neocortex-link/web/package.json"))), "dist");
const TYPES = { ".js": "text/javascript", ".map": "application/json", ".html": "text/html; charset=utf-8" };

async function sendFile(res, file) {
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");

  if (pathname.startsWith("/api/neocortex/")) return neocortex(req, res);

  if (pathname.startsWith("/vendor/neocortex/")) {
    // Resolve inside dist only, so "../" cannot reach the rest of the disk.
    const file = normalize(join(sdkDist, pathname.slice("/vendor/neocortex/".length)));
    if (!file.startsWith(sdkDist + sep)) return res.writeHead(404).end();
    return sendFile(res, file);
  }

  if (pathname === "/") {
    if (!visitorFrom(req.headers.cookie)) res.setHeader("set-cookie", visitorCookie(randomUUID()));
    const page = await readFile(join(here, "public", "index.html"), "utf8");
    res.writeHead(200, { "content-type": TYPES[".html"] });
    return res.end(page.replaceAll("{{CHARACTER_ID}}", encodeURIComponent(NEOCORTEX_CHARACTER_ID)));
  }

  res.writeHead(404).end("Not found");
});

server.listen(PORT, () => console.log(`Neocortex quickstart → http://localhost:${PORT}`));
