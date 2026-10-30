// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLogger, GroupDirector, MemorySessionStore, QuizAgent, SmartAgent, UsageGate } from "../src/client";
import { NeocortexClient } from "../src/core/client";
import { chatReply, fakeUpstream, json } from "./helpers";

afterEach(() => vi.restoreAllMocks());

function client(routes: Parameters<typeof fakeUpstream>[0]) {
  const upstream = fakeUpstream(routes);
  return { upstream, client: new NeocortexClient({ baseUrl: "https://api.test/v3", fetch: upstream.fetch }) };
}

describe("direct mode in a browser", () => {
  it("refuses an API key without the explicit flag", () => {
    expect(() => new NeocortexClient({ apiKey: "sk_x" })).toThrow(/public/);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(new NeocortexClient({ apiKey: "sk_x", dangerouslyAllowBrowser: true }).mode).toBe("direct");
    expect(warn).toHaveBeenCalled();
  });
});

describe("SmartAgent", () => {
  const lines = [
    { text: "Hi!", emotion: "HAPPY" },
    { text: "Welcome.", emotion: "PLEASED" },
  ];

  it("plays a reply line by line and runs registered actions", async () => {
    const { client: c } = client({ chat: () => chatReply("s1", lines) });
    const agent = new SmartAgent({ client: c, characterId: "char-a", paceLines: false, sessionStore: new MemorySessionStore() });
    const seen: string[] = [];
    agent.on("busy", (b) => seen.push(`busy:${b}`));
    agent.on("playerMessage", (t) => seen.push(`player:${t}`));
    agent.on("lineStarted", ({ line, index }) => seen.push(`line${index}:${line.text}`));
    agent.on("emotionChanged", ({ emotion }) => seen.push(`emotion:${emotion}`));
    agent.on("replyFinished", () => seen.push("finished"));
    const wave = vi.fn();
    agent.registerAction("wave", wave);

    const message = await agent.textToText("hello");
    expect(message?.name).toBe("Cora");
    expect(wave).toHaveBeenCalledWith({ name: "WAVE", targetId: "" }, expect.anything());
    expect(seen).toEqual(["busy:true", "player:hello", "emotion:happy", "line0:Hi!", "emotion:pleased", "line1:Welcome.", "finished", "busy:false"]);
    expect(agent.sessionId).toBe("s1");
  });

  it("remembers the session and sends it back", async () => {
    const store = new MemorySessionStore();
    const { client: c, upstream } = client({ chat: () => chatReply("s9") });
    await new SmartAgent({ client: c, characterId: "char-a", paceLines: false, sessionStore: store }).textToText("one");
    const again = new SmartAgent({ client: c, characterId: "char-a", paceLines: false, sessionStore: store });
    expect(again.sessionId).toBe("s9");
    await again.textToText("two");
    expect((upstream.last()!.body as { sessionId: string }).sessionId).toBe("s9");
  });

  it("queues messages sent while busy, in order", async () => {
    const { client: c, upstream } = client({ chat: (call) => chatReply("s", [{ text: `re:${(call.body as { message: string }).message}`, emotion: "NEUTRAL" }]) });
    const agent = new SmartAgent({ client: c, characterId: "char-a", paceLines: false, sessionStore: null });
    const replies = await Promise.all([agent.textToText("a"), agent.textToText("b"), agent.textToText("c")]);
    expect(replies.map((r) => r?.lines[0]?.text)).toEqual(["re:a", "re:b", "re:c"]);
    expect(upstream.calls.map((c) => (c.body as { message: string }).message)).toEqual(["a", "b", "c"]);
  });

  it("reports failures as error events and resolves null", async () => {
    const { client: c } = client({ chat: () => json({ error: "No credits", code: "insufficient_credits" }, 402) });
    const agent = new SmartAgent({ client: c, characterId: "char-a", sessionStore: null });
    const errors: string[] = [];
    agent.on("error", (e) => errors.push(e.code ?? ""));
    expect(await agent.textToText("hi")).toBeNull();
    expect(errors).toEqual(["insufficient_credits"]);
    expect(agent.isBusy).toBe(false);
  });

  it("sends interactables and events when given", async () => {
    const { client: c, upstream } = client({ chat: () => chatReply() });
    const events = new EventLogger();
    events.push("Low", 0);
    events.push("The vault opened and it is a very long event that will be cut to sixty-four chars", 2);
    const agent = new SmartAgent({ client: c, characterId: "char-a", paceLines: false, sessionStore: null, eventLogger: events });
    await agent.textToText("hi");
    const sent = (upstream.last()!.body as { events: Array<{ content: string; priority: number }> }).events;
    expect(sent.map((e) => e.priority)).toEqual([2, 0]);
    expect(sent[0]!.content).toHaveLength(64);
  });

  it("clears a session the server no longer knows when loading history", async () => {
    const store = new MemorySessionStore();
    store.set("char-a", "gone");
    const { client: c } = client({ "chat/session": () => json({ error: "nope", code: "session_not_found" }, 404) });
    const agent = new SmartAgent({ client: c, characterId: "char-a", sessionStore: store });
    expect(await agent.history()).toBeNull();
    expect(agent.sessionId).toBeNull();
  });
});

describe("GroupDirector", () => {
  it("addresses one character and uses a group session key", async () => {
    const store = new MemorySessionStore();
    const { client: c, upstream } = client({ chat: () => chatReply("g1") });
    const group = new GroupDirector({ client: c, characterIds: ["b", "a"], maxTurns: 2, paceLines: false, sessionStore: store });
    await group.sendTo("a", "hi");
    expect(upstream.last()!.body).toMatchObject({ characterIds: ["b", "a"], speakerCharacterId: "a", maxTurns: 2 });
    expect(store.get("group:a,b")).toBe("g1");
    group.addCharacter("c");
    expect(group.sessionId).toBeNull();
  });
});

describe("QuizAgent", () => {
  it("tracks question, progress and the end of the quiz", async () => {
    let turnNo = 0;
    const { client: c } = client({
      quiz: () =>
        json(
          ++turnNo === 1
            ? { sessionId: "q", lines: [{ text: "Q1?", emotion: "CURIOUS", role: "question" }], expecting: "answer", question: { questionId: "1", type: "mc", questionText: "Q1?", options: [{ id: "a", text: "A" }] }, progress: { asked: 1, total: 1 }, done: false }
            : { sessionId: "q", lines: [{ text: "Done!", emotion: "HAPPY", role: "closing" }], expecting: "nothing", done: true, leaderboard: [{ participantId: "p", displayName: "P", totalScore: 10, rank: 1 }] },
        ),
    });
    const quiz = new QuizAgent({ client: c, characterId: "host", questionSetId: "set" });
    const finished = vi.fn();
    quiz.on("finished", finished);

    await quiz.begin();
    expect(quiz.question?.questionText).toBe("Q1?");
    expect(quiz.expecting).toBe("answer");
    await quiz.choose("a");
    expect(quiz.isFinished).toBe(true);
    expect(quiz.leaderboard[0]!.totalScore).toBe(10);
    expect(finished).toHaveBeenCalledOnce();

    const dropped = vi.fn();
    quiz.on("inputDropped", dropped);
    expect(await quiz.say("again")).toBeNull();
    expect(dropped).toHaveBeenCalledWith({ reason: "finished" });
  });
});

describe("UsageGate", () => {
  it("fails open and fires credit events", async () => {
    const { client: c } = client({ usage: () => json({ status: "empty", creditsRemaining: 0 }) });
    const gate = new UsageGate({ client: c });
    expect(gate.canUse()).toBe(true);
    const empty = vi.fn();
    gate.on("creditsEmpty", empty);
    await gate.refresh();
    expect(gate.canUse()).toBe(false);
    expect(empty).toHaveBeenCalled();

    const broken = new UsageGate({ client: new NeocortexClient({ fetch: () => Promise.reject(new Error("x")) }) });
    await broken.refresh();
    expect(broken.canUse()).toBe(true);
  });
});
