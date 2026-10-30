/**
 * The SDK playground: a local page that exercises every endpoint through the
 * real proxy handler.
 *
 *   npm run playground
 *
 * With NEOCORTEX_API_KEY in .env.local it talks to Neocortex (or to
 * NEOCORTEX_BASE_URL). Without one it runs against a built-in mock, so the UI can
 * be tried with no account and no credits.
 */

import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { createNeocortexHandler, toNodeHandler } from "../src/server";
import { MOCK_API_KEY, MOCK_CHARACTERS, MOCK_QUESTION_SET, mockFetch } from "./mock-upstream";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Optional.
  }
}

const mock = !process.env.NEOCORTEX_API_KEY;
const apiKey = process.env.NEOCORTEX_API_KEY || MOCK_API_KEY;
const characters = mock
  ? MOCK_CHARACTERS.map((c) => c.id)
  : (process.env.NEOCORTEX_CHARACTERS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
const questionSet = mock ? MOCK_QUESTION_SET.id : process.env.NEOCORTEX_QUESTION_SET || "";
const port = Number(process.env.PLAYGROUND_PORT) || 5173;

/** Who is "signed in": a cookie the page sets, standing in for your app's real auth. */
function readUser(request: Request): { id: string } | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = /(?:^|;\s*)pg_user=([^;]+)/.exec(cookie);
  const id = match ? decodeURIComponent(match[1]!) : "";
  return /^[\w-]{1,64}$/.test(id) ? { id } : null;
}

const handler = createNeocortexHandler({
  apiKey,
  baseUrl: process.env.NEOCORTEX_BASE_URL || undefined,
  basePath: "/api/neocortex",
  authorize: readUser,
  characters,
  questionSets: questionSet ? [questionSet] : undefined,
  routes: { characters: true, questionSets: true },
  rateLimit: { limit: 40, windowSeconds: 60 },
  allowClientContext: true,
  fetch: mock ? mockFetch : undefined,
  onError: (error, context) =>
    console.error(`[proxy] ${context.route ?? "-"} ${context.status}:`, error instanceof Error ? error.message : error),
});
const proxy = toNodeHandler(handler);

const root = fileURLToPath(new URL(".", import.meta.url));
const vite = await createViteServer({
  root,
  configFile: false,
  appType: "spa",
  server: { middlewareMode: true },
  logLevel: "warn",
});

const server = createHttpServer((req, res) => {
  const url = req.url ?? "/";
  if (url.startsWith("/api/neocortex/")) return void proxy(req, res);
  if (url === "/playground/config") {
    res.setHeader("content-type", "application/json");
    // Only what the page needs to render; the key itself never leaves this process.
    res.end(JSON.stringify({ mock, characters, questionSet, baseUrl: mock ? "mock" : process.env.NEOCORTEX_BASE_URL || "https://api.neocortex.link/v3" }));
    return;
  }
  vite.middlewares(req, res);
});

server.listen(port, () => {
  console.log(`\n  Neocortex playground → http://localhost:${port}`);
  console.log(mock ? "  Mode: mock (set NEOCORTEX_API_KEY in .env.local for the real API)\n" : `  Mode: live, ${characters.length} character(s) allowed\n`);
  if (!mock && characters.length === 0) console.warn("  NEOCORTEX_CHARACTERS is empty: every chat will be refused.\n");
});
