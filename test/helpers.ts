import { encodeWav } from "../src/core/wav";

export type UpstreamCall = { url: string; method: string; headers: Headers; body: unknown };

/**
 * A fake Neocortex API that records every call the proxy makes and answers with
 * whatever the test sets for that path.
 */
export function fakeUpstream(routes: Record<string, (call: UpstreamCall) => Response | Promise<Response>> = {}) {
  const calls: UpstreamCall[] = [];
  const fetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/v3\//, "");
    let body: unknown = init.body;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    const call = { url: input, method: init.method ?? "GET", headers: new Headers(init.headers), body };
    calls.push(call);
    const route = routes[path];
    return route ? route(call) : json({ error: "Not found" }, 404);
  };
  return { fetch, calls, last: () => calls[calls.length - 1] };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function chatReply(sessionId = "sess-1", lines = [{ text: "Hello there.", emotion: "HAPPY" }]) {
  return json({ sessionId, messages: [{ characterId: "char-a", name: "Cora", lines, actions: [{ name: "WAVE", targetId: "" }] }] });
}

export function streamingWav(samples = 2400, rate = 24000): Uint8Array {
  const wav = encodeWav(new Float32Array(samples).fill(0.25), rate);
  new DataView(wav.buffer).setUint32(40, 0xffffffff, true);
  return wav;
}

/** Splits bytes into chunks of awkward sizes, the way a network delivers them. */
export function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size));
      controller.close();
    },
  });
}
