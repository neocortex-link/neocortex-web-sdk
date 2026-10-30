import { describe, expect, it, vi } from "vitest";
import { audioFilename, NeocortexClient } from "../src/core/client";
import { toAudioEmotion, toEmotion } from "../src/core/emotions";
import { isNeocortexError, NeocortexError } from "../src/core/errors";
import { decodePcm16, encodeWav, PcmStreamDecoder, readWavHeader, resample } from "../src/core/wav";
import { chatReply, chunked, fakeUpstream, json, streamingWav } from "./helpers";

describe("wav", () => {
  it("reads a streaming header with an unknown length", () => {
    expect(readWavHeader(streamingWav())).toEqual({ offset: 44, sampleRate: 24000, channels: 1 });
    expect(readWavHeader(new Uint8Array(20))).toBeNull();
  });

  it("decodes a stream split at awkward places, including mid-sample", () => {
    const wav = streamingWav(1001);
    for (const size of [1, 3, 7, 45, 333]) {
      const decoder = new PcmStreamDecoder();
      let frames = 0;
      for (let at = 0; at < wav.length; at += size) {
        const chunk = decoder.push(wav.slice(at, at + size));
        if (chunk) {
          frames += chunk.channels[0]!.length;
          expect(chunk.sampleRate).toBe(24000);
          expect(chunk.channels[0]![0]).toBeCloseTo(0.25, 2);
        }
      }
      expect(frames).toBe(1001);
    }
  });

  it("refuses a body that is not WAV", () => {
    expect(() => new PcmStreamDecoder().push(new TextEncoder().encode('{"error":"nope"}'))).toThrow(/not WAV/);
  });

  it("round-trips samples through encode and decode", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const wav = encodeWav(samples, 16000);
    const decoded = decodePcm16(wav.subarray(44), 16000, 1).channels[0]!;
    decoded.forEach((value, i) => expect(value).toBeCloseTo(samples[i]!, 3));
  });

  it("resamples to the requested rate", () => {
    expect(resample(new Float32Array(48000), 48000, 16000)).toHaveLength(16000);
  });
});

describe("emotions", () => {
  it("normalizes casing and unknown values", () => {
    expect(toEmotion("HAPPY")).toBe("happy");
    expect(toEmotion("whatever")).toBe("neutral");
    expect(toAudioEmotion("curious")).toBe("CURIOUS");
  });
});

describe("isNeocortexError", () => {
  it("recognises an error from another copy of the package", () => {
    const foreign = Object.assign(new Error("No credits"), { name: "NeocortexError", status: 402, code: "insufficient_credits" });
    expect(foreign instanceof NeocortexError).toBe(false);
    expect(isNeocortexError(foreign)).toBe(true);
    expect(isNeocortexError(new Error("plain"))).toBe(false);
  });
});

describe("audioFilename", () => {
  it("names recordings after their type", () => {
    expect(audioFilename(new Blob([], { type: "audio/webm;codecs=opus" }))).toBe("speech.webm");
    expect(audioFilename(new Blob([], { type: "audio/mp4" }))).toBe("speech.m4a");
    expect(audioFilename(new Blob([], { type: "" }))).toBe("speech.wav");
    expect(audioFilename(new File([], "clip.ogg", { type: "audio/ogg" }))).toBe("clip.ogg");
    expect(audioFilename(new File([], "clip", { type: "audio/mpeg" }))).toBe("speech.mp3");
  });
});

describe("NeocortexClient", () => {
  it("defaults to the proxy path without a key and sends no key", async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => chatReply());
    const client = new NeocortexClient({ fetch });
    await client.chat({ characterIds: ["a"] });
    expect(fetch.mock.calls[0]![0]).toBe("/api/neocortex/chat");
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).has("x-api-key")).toBe(false);
  });

  it("talks to the API directly with a key, normalizing emotions", async () => {
    const upstream = fakeUpstream({ chat: () => chatReply() });
    const client = new NeocortexClient({ apiKey: "sk_x", baseUrl: "https://api.test/v3", fetch: upstream.fetch });
    const reply = await client.chat({ characterIds: ["char-a"], message: "hi" });
    expect(upstream.last()!.headers.get("x-api-key")).toBe("sk_x");
    expect(reply.messages[0]!.lines[0]!.emotion).toBe("happy");
    expect(reply.messages[0]!.actions).toEqual([{ name: "WAVE", targetId: "" }]);
  });

  it("adds custom headers per request", async () => {
    const upstream = fakeUpstream({ usage: () => json({ status: "ok", creditsRemaining: 1 }) });
    let n = 0;
    const client = new NeocortexClient({ baseUrl: "https://api.test/v3", fetch: upstream.fetch, headers: () => ({ authorization: `Bearer ${++n}` }) });
    await client.usage();
    await client.usage({ characterId: "c" });
    expect(upstream.calls.map((c) => c.headers.get("authorization"))).toEqual(["Bearer 1", "Bearer 2"]);
    expect(upstream.last()!.url).toContain("usage?characterId=c");
  });

  it("turns error bodies into NeocortexError", async () => {
    const upstream = fakeUpstream({ chat: () => json({ error: "No credits", code: "insufficient_credits" }, 402, { "retry-after": "5" }) });
    const client = new NeocortexClient({ baseUrl: "https://api.test/v3", fetch: upstream.fetch });
    const error = await client.chat({ characterIds: ["a"] }).catch((e) => e);
    expect(error).toBeInstanceOf(NeocortexError);
    expect(error).toMatchObject({ status: 402, code: "insufficient_credits", retryAfter: 5, isOutOfCredits: true });
  });

  it("ignores HTML error pages", async () => {
    const client = new NeocortexClient({ fetch: async () => new Response("<html>502</html>", { status: 502 }) });
    const error = await client.characters().catch((e) => e);
    expect(error.message).toBe("Request failed (502)");
  });

  it("reports timeouts, aborts and network failures distinctly", async () => {
    const hang = (_: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const slow = new NeocortexClient({ fetch: hang, timeouts: { lookup: 20 } });
    expect((await slow.characters().catch((e) => e)).code).toBe("timeout");

    const controller = new AbortController();
    const pending = new NeocortexClient({ fetch: hang }).characters({ signal: controller.signal }).catch((e) => e);
    controller.abort();
    expect((await pending).isAborted).toBe(true);

    const offline = new NeocortexClient({ fetch: () => Promise.reject(new TypeError("failed")) });
    expect((await offline.characters().catch((e) => e)).code).toBe("network_error");
  });

  it("retries quiz turns the server is still busy with", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const upstream = fakeUpstream({
      quiz: () => (++attempts < 3 ? json({ error: "busy", code: "operation_in_progress" }, 409) : json({ sessionId: "q", lines: [], expecting: "answer" })),
    });
    const client = new NeocortexClient({ baseUrl: "https://api.test/v3", fetch: upstream.fetch });
    const turn = client.quizTurn({ sessionId: "q", say: "hi" });
    await vi.runAllTimersAsync();
    expect((await turn).sessionId).toBe("q");
    expect(attempts).toBe(3);
    vi.useRealTimers();
  });

  it("gives up after the retry budget", async () => {
    const upstream = fakeUpstream({ quiz: () => json({ error: "stale", code: "state_changed" }, 409) });
    const client = new NeocortexClient({ baseUrl: "https://api.test/v3", fetch: upstream.fetch });
    expect((await client.quizTurn({ sessionId: "q" }).catch((e) => e)).code).toBe("state_changed");
    expect(upstream.calls).toHaveLength(2);
  });

  it("labels generated audio and uppercases emotion", async () => {
    const upstream = fakeUpstream({ "audio/generate": () => new Response(new Uint8Array([1])) });
    const client = new NeocortexClient({ baseUrl: "https://api.test/v3", fetch: upstream.fetch });
    const blob = await client.generateAudio({ characterId: "a", message: "hi", emotion: "happy", format: "wav", speechToken: "t" });
    expect(blob.type).toBe("audio/wav");
    expect(upstream.last()!.body).toEqual({ characterId: "a", message: "hi", emotion: "HAPPY", format: "wav", speechToken: "t" });
  });

  it("does not send speech tokens to the API directly", async () => {
    const upstream = fakeUpstream({ "audio/generate": () => new Response(new Uint8Array([1])) });
    const client = new NeocortexClient({ apiKey: "sk_x", baseUrl: "https://api.test/v3", fetch: upstream.fetch });
    await client.generateAudio({ characterId: "a", message: "hi", speechToken: "t" });
    expect(upstream.last()!.body).not.toHaveProperty("speechToken");
  });

  it("streams speech as PCM chunks", async () => {
    const upstream = fakeUpstream({ "audio/stream": () => new Response(chunked(streamingWav(4800), 999)) });
    const client = new NeocortexClient({ baseUrl: "https://api.test/v3", fetch: upstream.fetch });
    const stream = await client.streamAudio({ characterId: "a", message: "hi" });
    let frames = 0;
    for await (const chunk of stream.chunks) frames += chunk.channels[0]!.length;
    expect(frames).toBe(4800);
  });

  it("transcribes with a readable filename", async () => {
    const upstream = fakeUpstream({ "audio/transcribe": () => json({ text: "legacy field" }) });
    const client = new NeocortexClient({ baseUrl: "https://api.test/v3", fetch: upstream.fetch });
    const result = await client.transcribe({ characterId: "a", audio: new Blob([new Uint8Array(4)], { type: "audio/ogg" }), language: "tr" });
    expect(result.response).toBe("legacy field");
    const form = upstream.last()!.body as FormData;
    expect((form.get("audio") as File).name).toBe("speech.ogg");
    expect(form.get("language")).toBe("tr");
  });
});
