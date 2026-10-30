import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toNodeHandler } from "../src/server";

let server: Server;
let base = "";
let lastBody = "";

beforeAll(async () => {
  const handler = toNodeHandler(async (request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/echo")) {
      lastBody = await request.text();
      return new Response(JSON.stringify({ path: url.pathname, host: url.host, body: lastBody }), {
        headers: { "content-type": "application/json" },
      });
    }
    // A slow stream, to prove chunks are written as they come rather than buffered.
    let n = 0;
    return new Response(
      new ReadableStream({
        async pull(controller) {
          if (n++ === 3) return controller.close();
          await new Promise((r) => setTimeout(r, 20));
          controller.enqueue(new TextEncoder().encode(`chunk${n};`));
        },
      }),
    );
  });

  server = createServer((req, res) => {
    // Simulate express.json() having already consumed the body.
    if (req.url?.includes("parsed")) {
      (req as unknown as { body: unknown }).body = { already: "parsed" };
    }
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("toNodeHandler", () => {
  it("passes the body and the full path through, and returns the whole response", async () => {
    const response = await fetch(`${base}/api/neocortex/echo`, { method: "POST", body: '{"a":1}', headers: { "content-type": "application/json" } });
    expect(await response.json()).toMatchObject({ path: "/api/neocortex/echo", body: '{"a":1}' });
  });

  it("uses a body a parser already read", async () => {
    const response = await fetch(`${base}/parsed/echo`, { method: "POST", body: '{"ignored":true}', headers: { "content-type": "application/json" } });
    expect((await response.json()).body).toBe('{"already":"parsed"}');
  });

  it("honours forwarded host and protocol", async () => {
    const response = await fetch(`${base}/x/echo`, { headers: { "x-forwarded-host": "game.example", "x-forwarded-proto": "https" } });
    expect((await response.json()).host).toBe("game.example");
  });

  it("streams responses chunk by chunk", async () => {
    const response = await fetch(`${base}/stream`);
    const reader = response.body!.getReader();
    const arrivals: number[] = [];
    const started = Date.now();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivals.push(Date.now() - started);
      text += new TextDecoder().decode(value);
    }
    expect(text).toBe("chunk1;chunk2;chunk3;");
    expect(arrivals.length).toBeGreaterThan(1);
  });
});
