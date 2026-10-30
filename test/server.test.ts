import { describe, expect, it, vi } from "vitest";
import { createNeocortexHandler, type NeocortexHandlerOptions } from "../src/server";
import { chatReply, chunked, fakeUpstream, json, streamingWav, type UpstreamCall } from "./helpers";

const API_KEY = "sk_test-secret-key";
const ORIGIN = "https://game.example";

function setup(options: Partial<NeocortexHandlerOptions> = {}, routes: Parameters<typeof fakeUpstream>[0] = {}) {
  const upstream = fakeUpstream({ chat: () => chatReply(), ...routes });
  const handler = createNeocortexHandler({
    apiKey: API_KEY,
    baseUrl: "https://api.test/v3",
    characters: ["char-a", "char-b"],
    authorize: (request) => {
      const user = request.headers.get("x-test-user");
      return user ? { id: user } : null;
    },
    fetch: upstream.fetch,
    onError: () => {},
    ...options,
  });

  const call = (path: string, init: { method?: string; body?: unknown; user?: string | null; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    if (init.user !== null) headers["x-test-user"] = init.user ?? "alice";
    let body: BodyInit | undefined;
    if (init.body instanceof FormData || typeof init.body === "string") body = init.body;
    else if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers["content-type"] ??= "application/json";
    }
    return handler(new Request(`${ORIGIN}/api/neocortex/${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body }));
  };
  return { call, upstream };
}

async function bodyOf(response: Response) {
  return (await response.json()) as Record<string, any>;
}

describe("routing and auth", () => {
  it("refuses requests without a user", async () => {
    const { call, upstream } = setup();
    const response = await call("chat", { body: { characterIds: ["char-a"], message: "hi" }, user: null });
    expect(response.status).toBe(401);
    expect((await bodyOf(response)).code).toBe("unauthorized");
    expect(upstream.calls).toHaveLength(0);
  });

  it("treats a throwing authorize as unauthorized", async () => {
    const { call } = setup({ authorize: () => Promise.reject(new Error("db down")) });
    expect((await call("chat", { body: { characterIds: ["char-a"] } })).status).toBe(401);
  });

  it("404s unknown and disabled routes, and paths outside the mount", async () => {
    const { call } = setup();
    expect((await call("account")).status).toBe(404);
    expect((await call("characters")).status).toBe(404);
    expect((await call("../v3/chat")).status).toBe(404);
    expect((await call("sdk/license/activate", { body: {} })).status).toBe(404);
  });

  it("405s the wrong method", async () => {
    const { call } = setup();
    const response = await call("chat", { method: "GET" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("requires a characters allowlist, apiKey and authorize", () => {
    expect(() => createNeocortexHandler({ apiKey: "", characters: [], authorize: () => null })).toThrow(/apiKey/);
    expect(() => createNeocortexHandler({ apiKey: "k", characters: undefined as never, authorize: () => null })).toThrow(/allowlist/);
  });
});

describe("chat", () => {
  it("sends the key upstream, never to the browser", async () => {
    const { call, upstream } = setup();
    const response = await call("chat", { body: { characterIds: ["char-a"], message: "hi" } });
    expect(response.status).toBe(200);
    expect(upstream.last()!.headers.get("x-api-key")).toBe(API_KEY);
    expect(JSON.stringify(await bodyOf(response))).not.toContain(API_KEY);
  });

  it("overwrites playerId with the authorized user and drops unknown fields", async () => {
    const { call, upstream } = setup();
    await call("chat", {
      body: { characterIds: ["char-a"], message: "hi", playerId: "victim", publicLink: "abc", evil: true },
    });
    const sent = upstream.last()!.body as Record<string, unknown>;
    expect(sent.playerId).toBe("alice");
    expect(sent).not.toHaveProperty("publicLink");
    expect(sent).not.toHaveProperty("evil");
  });

  it("accepts a singular characterId", async () => {
    const { call, upstream } = setup();
    await call("chat", { body: { characterId: "char-b", message: "hi" } });
    expect((upstream.last()!.body as { characterIds: string[] }).characterIds).toEqual(["char-b"]);
  });

  it("refuses characters off the allowlist, including playAs", async () => {
    const { call, upstream } = setup();
    expect((await call("chat", { body: { characterIds: ["char-a", "char-z"] } })).status).toBe(403);
    expect((await call("chat", { body: { characterIds: ["char-a"], playAs: "char-z" } })).status).toBe(403);
    expect(upstream.calls).toHaveLength(0);
  });

  it("supports a per-user allowlist", async () => {
    const { call } = setup({ characters: (user) => (user.id === "vip" ? ["char-a", "char-vip"] : ["char-a"]) });
    expect((await call("chat", { body: { characterIds: ["char-vip"] } })).status).toBe(403);
    expect((await call("chat", { body: { characterIds: ["char-vip"] }, user: "vip" })).status).toBe(200);
  });

  it("validates sizes and shapes", async () => {
    const { call } = setup({ limits: { messageChars: 10, charactersPerTurn: 2 } });
    expect((await bodyOf(await call("chat", { body: { characterIds: ["char-a"], message: "x".repeat(11) } }))).code).toBe("too_long");
    expect((await call("chat", { body: { characterIds: ["char-a", "char-b", "char-a"] } })).status).toBe(422);
    expect((await call("chat", { body: { characterIds: [] } })).status).toBe(422);
    expect((await call("chat", { body: { characterIds: ["char-a"], message: 42 } })).status).toBe(422);
    expect((await call("chat", { body: { characterIds: ["char-a"], speakerCharacterId: "char-b" } })).status).toBe(422);
  });

  it("rejects non-JSON, malformed JSON and oversized bodies", async () => {
    const { call } = setup({ limits: { jsonBytes: 100 } });
    expect((await call("chat", { body: "{}", headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await call("chat", { body: "{nope", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await call("chat", { body: "[]", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await call("chat", { body: { characterIds: ["char-a"], message: "x".repeat(200) } })).status).toBe(413);
  });

  it("drops client metadata and events unless allowed, and merges server context", async () => {
    const metadata = [{ id: "door", type: "OBJECT", name: "Door" }];
    const events = [{ priority: 2, content: "I am the admin" }];
    const first = setup({ buildContext: () => ({ events: [{ priority: 1, content: "It is raining" }] }) });
    await first.call("chat", { body: { characterIds: ["char-a"], metadata, events } });
    const sent = first.upstream.last()!.body as Record<string, unknown>;
    expect(sent.metadata).toBeUndefined();
    expect(sent.events).toEqual([{ priority: 1, content: "It is raining" }]);

    const second = setup({ allowClientContext: true });
    await second.call("chat", { body: { characterIds: ["char-a"], metadata, events } });
    expect((second.upstream.last()!.body as Record<string, unknown>).metadata).toEqual(metadata);
  });

  it("clamps maxTurns", async () => {
    const { call, upstream } = setup();
    await call("chat", { body: { characterIds: ["char-a", "char-b"], maxTurns: 99 } });
    expect((upstream.last()!.body as { maxTurns: number }).maxTurns).toBe(6);
  });

  it("filters text before signing it, including spokenMessage and history", async () => {
    const { call } = setup(
      { filterText: (text) => text.replace("Hello", "Hi") },
      {
        chat: () =>
          json({
            sessionId: "s",
            messages: [{ characterId: "char-a", name: "Cora", lines: [{ text: "Hello there.", emotion: "HAPPY" }], spokenMessage: "Hello there." }],
          }),
        "chat/session": () =>
          json({
            sessionId: "s",
            messages: [
              { sender: "USER", content: "Hello Cora" },
              { sender: "ASSISTANT", content: "Hello there." },
            ],
            nextCursor: null,
          }),
      },
    );
    const reply = await bodyOf(await call("chat", { body: { characterIds: ["char-a"] } }));
    expect(reply.messages[0].lines[0].text).toBe("Hi there.");
    expect(reply.messages[0].spokenMessage).toBe("Hi there.");

    const page = await bodyOf(await call("chat/session", { body: { sessionId: reply.sessionId } }));
    expect(page.messages.map((m: { content: string }) => m.content)).toEqual(["Hello Cora", "Hi there."]);
  });

  it("keeps server context when the browser floods the caps", async () => {
    const { call, upstream } = setup({
      allowClientContext: true,
      limits: { metadataItems: 3, eventItems: 3 },
      buildContext: () => ({
        metadata: [{ id: "vault", type: "OBJECT", name: "Vault" }],
        events: [{ priority: 2, content: "Server event" }],
      }),
    });
    const flood = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `x${i}`, type: "OBJECT", name: "X", priority: 0, content: "spam" }));
    await call("chat", { body: { characterIds: ["char-a"], metadata: flood(10), events: flood(10) } });
    const sent = upstream.last()!.body as { metadata: Array<{ id: string }>; events: Array<{ content: string }> };
    expect(sent.metadata).toHaveLength(3);
    expect(sent.metadata[0]!.id).toBe("vault");
    expect(sent.events).toHaveLength(3);
    expect(sent.events.at(-1)!.content).toBe("Server event");
  });
});

describe("sessions", () => {
  it("wraps session ids in a token bound to the user", async () => {
    const { call, upstream } = setup();
    const reply = await bodyOf(await call("chat", { body: { characterIds: ["char-a"] } }));
    expect(reply.sessionId).toMatch(/^nxs_sess-1\./);

    await call("chat", { body: { characterIds: ["char-a"], sessionId: reply.sessionId } });
    expect((upstream.last()!.body as { sessionId: string }).sessionId).toBe("sess-1");
  });

  it("starts fresh rather than continue a session that is not yours", async () => {
    const { call, upstream } = setup();
    const reply = await bodyOf(await call("chat", { body: { characterIds: ["char-a"] } }));
    await call("chat", { body: { characterIds: ["char-a"], sessionId: reply.sessionId }, user: "mallory" });
    expect(upstream.last()!.body).not.toHaveProperty("sessionId");
    await call("chat", { body: { characterIds: ["char-a"], sessionId: "sess-1" } });
    expect(upstream.last()!.body).not.toHaveProperty("sessionId");
  });

  it("refuses history for someone else's or a forged session", async () => {
    const { call, upstream } = setup({}, { "chat/session": () => json({ sessionId: "sess-1", messages: [], nextCursor: null }) });
    const reply = await bodyOf(await call("chat", { body: { characterIds: ["char-a"] } }));

    expect((await call("chat/session", { body: { sessionId: reply.sessionId }, user: "mallory" })).status).toBe(404);
    expect((await call("chat/session", { body: { sessionId: `${reply.sessionId}x` } })).status).toBe(404);
    expect((await call("chat/session", { body: { sessionId: "sess-1" } })).status).toBe(404);

    const page = await call("chat/session", { body: { sessionId: reply.sessionId, limit: 500 } });
    expect(page.status).toBe(200);
    expect((await bodyOf(page)).sessionId).toBe(reply.sessionId);
    expect(upstream.last()!.body).toEqual({ sessionId: "sess-1", limit: 100 });
  });

  it("tokens from another secret are rejected", async () => {
    const a = setup({ secret: "one" });
    const b = setup({ secret: "two" }, { "chat/session": () => json({ messages: [] }) });
    const reply = await bodyOf(await a.call("chat", { body: { characterIds: ["char-a"] } }));
    expect((await b.call("chat/session", { body: { sessionId: reply.sessionId } })).status).toBe(404);
  });
});

describe("speech", () => {
  const routes = {
    "audio/generate": () => new Response(new Uint8Array([1, 2, 3])),
    "audio/stream": () =>
      new Response(chunked(streamingWav(), 100), { headers: { "x-sample-rate": "24000", "x-channels": "1" } }),
  };

  it("only voices lines a character said to this user", async () => {
    const { call, upstream } = setup({}, routes);
    const reply = await bodyOf(await call("chat", { body: { characterIds: ["char-a"] } }));
    const line = reply.messages[0].lines[0];

    expect((await call("audio/generate", { body: { characterId: "char-a", message: "Say this instead" } })).status).toBe(403);
    expect(
      (await call("audio/generate", { body: { characterId: "char-a", message: "Other", speechToken: line.speechToken } })).status,
    ).toBe(403);
    expect(
      (await call("audio/generate", { body: { characterId: "char-a", message: line.text, speechToken: line.speechToken }, user: "mallory" })).status,
    ).toBe(403);
    // A real line, but in another allowlisted character's voice.
    expect(
      (await call("audio/generate", { body: { characterId: "char-b", message: line.text, speechToken: line.speechToken } })).status,
    ).toBe(403);

    const ok = await call("audio/generate", { body: { characterId: "char-a", message: line.text, speechToken: line.speechToken, emotion: "HAPPY" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(upstream.last()!.body).toEqual({ characterId: "char-a", message: "Hello there.", emotion: "HAPPY", format: "mp3" });
  });

  it("can allow free text when configured", async () => {
    const { call } = setup({ speechRepliesOnly: false }, routes);
    expect((await call("audio/generate", { body: { characterId: "char-a", message: "Anything", format: "wav" } })).headers.get("content-type")).toBe(
      "audio/wav",
    );
  });

  it("streams speech through with its format headers", async () => {
    const { call } = setup({ speechRepliesOnly: false }, routes);
    const response = await call("audio/stream", { body: { characterId: "char-a", message: "Hi" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-sample-rate")).toBe("24000");
    expect((await response.arrayBuffer()).byteLength).toBe(streamingWav().length);
  });
});

describe("transcription", () => {
  it("rebuilds the upload with a filename the server can read", async () => {
    const { call, upstream } = setup({}, { "audio/transcribe": () => json({ response: "hello", model: "x" }) });
    const form = new FormData();
    form.append("characterId", "char-a");
    form.append("audio", new Blob([new Uint8Array(100)], { type: "audio/webm" }));
    form.append("extra", "dropped");

    const response = await call("audio/transcribe", { body: form });
    expect(await bodyOf(response)).toEqual({ response: "hello" });
    const sent = upstream.last()!.body as FormData;
    expect((sent.get("audio") as File).name).toBe("speech.webm");
    expect(sent.get("extra")).toBeNull();
  });

  it("enforces the character allowlist and the size limit", async () => {
    const { call } = setup({ limits: { audioBytes: 50 } });
    const form = (character: string, size: number) => {
      const f = new FormData();
      f.append("characterId", character);
      f.append("audio", new Blob([new Uint8Array(size)], { type: "audio/wav" }));
      return f;
    };
    expect((await call("audio/transcribe", { body: form("char-z", 10) })).status).toBe(403);
    expect((await call("audio/transcribe", { body: form("char-a", 60) })).status).toBe(413);
    expect((await call("audio/transcribe", { body: { characterId: "char-a" } })).status).toBe(415);
  });
});

describe("quiz", () => {
  const turn = (sessionId = "quiz-1") => ({ sessionId, lines: [{ text: "Question one?", emotion: "CURIOUS", role: "question" }], expecting: "answer", done: false });

  it("starts with an allowed question set and binds the session", async () => {
    const { call, upstream } = setup({ questionSets: ["set-1"] }, { quiz: () => json(turn()) });
    expect((await call("quiz", { body: { characterId: "char-a", questionSetId: "set-2" } })).status).toBe(403);

    const started = await bodyOf(await call("quiz", { body: { characterId: "char-a", questionSetId: "set-1", playerId: "x" } }));
    expect(started.sessionId).toMatch(/^nxq_quiz-1\.char-a\./);
    expect(started.lines[0].speechToken).toBeTruthy();
    expect((upstream.last()!.body as { playerId: string }).playerId).toBe("alice");

    await call("quiz", { body: { sessionId: started.sessionId, say: "Paris" } });
    expect(upstream.last()!.body).toEqual({ sessionId: "quiz-1", say: "Paris" });
    expect((await call("quiz", { body: { sessionId: started.sessionId, say: "x" }, user: "mallory" })).status).toBe(404);
  });

  it("signs the closing turn replayed with quiz_finished", async () => {
    const { call } = setup({}, { quiz: (c: UpstreamCall) => ((c.body as { sessionId?: string }).sessionId ? json({ error: "Over", code: "quiz_finished", turn: turn() }, 409) : json(turn())) });
    const started = await bodyOf(await call("quiz", { body: { characterId: "char-a", questionSetId: "s" } }));
    const finished = await call("quiz", { body: { sessionId: started.sessionId, say: "x" } });
    const body = await bodyOf(finished);
    expect(finished.status).toBe(409);
    expect(body.code).toBe("quiz_finished");
    expect(body.turn.sessionId).toBe(started.sessionId);
  });

  it("refuses a second turn while one is running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { call } = setup({}, { quiz: async (c: UpstreamCall) => ((c.body as { sessionId?: string }).sessionId ? (await gate, json(turn())) : json(turn())) });
    const started = await bodyOf(await call("quiz", { body: { characterId: "char-a", questionSetId: "s" } }));

    const first = call("quiz", { body: { sessionId: started.sessionId, say: "a" } });
    await new Promise((r) => setTimeout(r, 10));
    const second = await call("quiz", { body: { sessionId: started.sessionId, say: "b" } });
    expect(second.status).toBe(409);
    expect(second.headers.get("retry-after")).toBe("2");
    release();
    expect((await first).status).toBe(200);
  });
});

describe("usage and catalogue", () => {
  it("forces the player to the signed-in user", async () => {
    const { call, upstream } = setup({}, { usage: () => json({ status: "ok", creditsRemaining: 5 }) });
    await call("usage?playerId=victim&characterId=char-a");
    expect(new URL(upstream.last()!.url).searchParams.get("playerId")).toBe("alice");
    expect((await call("usage?characterId=char-z")).status).toBe(403);
  });

  it("filters the character list to the allowlist", async () => {
    const { call } = setup(
      { routes: { characters: true } },
      { characters: () => json({ characters: [{ id: "char-a", name: "A" }, { id: "secret", name: "S" }] }) },
    );
    expect(await bodyOf(await call("characters"))).toEqual({ characters: [{ id: "char-a", name: "A" }] });
  });
});

describe("abuse limits", () => {
  it("rate limits per user", async () => {
    const { call } = setup({ rateLimit: { limit: 2, windowSeconds: 60 } });
    const body = { characterIds: ["char-a"] };
    expect((await call("chat", { body })).status).toBe(200);
    expect((await call("chat", { body })).status).toBe(200);
    const limited = await call("chat", { body });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await call("chat", { body, user: "bob" })).status).toBe(200);
  });

  it("refuses cross-site requests unless the origin is allowed", async () => {
    const { call } = setup({ cors: { origins: ["https://partner.example"] } });
    const body = { characterIds: ["char-a"] };
    expect((await call("chat", { body, headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" } })).status).toBe(403);
    expect((await call("chat", { body, headers: { origin: "https://evil.example", host: "game.example" } })).status).toBe(403);

    const allowed = await call("chat", { body, headers: { "sec-fetch-site": "cross-site", origin: "https://partner.example" } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://partner.example");
    expect((await call("chat", { body, headers: { "sec-fetch-site": "same-origin", origin: ORIGIN } })).status).toBe(200);
  });

  it("refuses sibling subdomains, which could otherwise post forms with the visitor's cookies", async () => {
    const { call } = setup();
    const form = new FormData();
    form.append("characterId", "char-a");
    form.append("audio", new Blob([new Uint8Array(10)], { type: "audio/wav" }));
    const response = await call("audio/transcribe", {
      body: form,
      headers: { "sec-fetch-site": "same-site", origin: "https://forum.game.example" },
    });
    expect(response.status).toBe(403);
  });

  it("answers CORS preflight only for allowed origins", async () => {
    const { call } = setup({ cors: { origins: ["https://partner.example"] } });
    const good = await call("chat", { method: "OPTIONS", headers: { origin: "https://partner.example" } });
    expect(good.status).toBe(204);
    expect(good.headers.get("access-control-allow-headers")).toContain("content-type");
    const bad = await call("chat", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("upstream failures", () => {
  it("hides a rejected API key behind a generic 502", async () => {
    const onError = vi.fn();
    const { call } = setup({ onError }, { chat: () => json({ error: "Invalid API key" }, 401) });
    const response = await call("chat", { body: { characterIds: ["char-a"] } });
    expect(response.status).toBe(502);
    expect((await bodyOf(response)).code).toBe("proxy_misconfigured");
    expect(onError).toHaveBeenCalled();
    expect(JSON.stringify(onError.mock.calls)).not.toContain(API_KEY);
  });

  it("hides a deactivated key or suspended workspace the same way", async () => {
    for (const body of [{ error: "API Key is not active." }, { error: "Ask its owner to upgrade.", code: "MEMBER_SUSPENDED" }]) {
      const { call } = setup({}, { chat: () => json(body, 403) });
      const response = await bodyOf(await call("chat", { body: { characterIds: ["char-a"] } }));
      expect(response.code).toBe("proxy_misconfigured");
      expect(JSON.stringify(response)).not.toMatch(/API Key|upgrade/);
    }
    // A plan gate is the visitor-facing kind of 403 and still comes through.
    const gated = setup({}, { chat: () => json({ error: "Group chat needs a Pro plan." }, 403) });
    expect((await gated.call("chat", { body: { characterIds: ["char-a"] } })).status).toBe(403);
  });

  it("relays client errors and masks server errors", async () => {
    const credits = setup({}, { chat: () => json({ error: "Out of credits", code: "insufficient_credits" }, 402) });
    const relayed = await credits.call("chat", { body: { characterIds: ["char-a"] } });
    expect(relayed.status).toBe(402);
    expect((await bodyOf(relayed)).code).toBe("insufficient_credits");

    const broken = setup({}, { chat: () => json({ error: "stack trace at line 4" }, 500) });
    const masked = await bodyOf(await broken.call("chat", { body: { characterIds: ["char-a"] } }));
    expect(masked.code).toBe("upstream_error");
    expect(JSON.stringify(masked)).not.toContain("stack trace");
  });

  it("reports an unreachable upstream as 502", async () => {
    const { call } = setup({ fetch: () => Promise.reject(new TypeError("fetch failed")) });
    expect((await call("chat", { body: { characterIds: ["char-a"] } })).status).toBe(502);
  });
});
