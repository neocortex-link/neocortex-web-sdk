/**
 * A stand-in for the Neocortex API, so the playground works without an API key
 * or credits. It answers every endpoint the proxy uses with plausible data, and
 * synthesizes "speech" as a soft tone so audio playback can be heard end to end.
 *
 * Only used when NEOCORTEX_API_KEY is not set.
 */

import { encodeWav } from "../src/core/wav";

export const MOCK_API_KEY = "sk_mock-playground";
export const MOCK_CHARACTERS = [
  { id: "mock-cora", name: "Cora" },
  { id: "mock-bram", name: "Bram" },
  { id: "mock-ivy", name: "Ivy" },
];
export const MOCK_QUESTION_SET = { id: "mock-capitals", name: "World capitals", questionCount: 3 };

type Session = { characterIds: string[]; history: Array<Record<string, unknown>> };
const sessions = new Map<string, Session>();
const quizzes = new Map<string, { index: number; score: number; done: boolean; playerId?: string }>();

const QUESTIONS = [
  { questionId: "q1", questionText: "What is the capital of Turkey?", options: [{ id: "a", text: "Istanbul" }, { id: "b", text: "Ankara" }, { id: "c", text: "Izmir" }], answer: "b" },
  { questionId: "q2", questionText: "What is the capital of Japan?", options: [{ id: "a", text: "Kyoto" }, { id: "b", text: "Osaka" }, { id: "c", text: "Tokyo" }], answer: "c" },
  { questionId: "q3", questionText: "What is the capital of Canada?", options: [{ id: "a", text: "Ottawa" }, { id: "b", text: "Toronto" }, { id: "c", text: "Vancouver" }], answer: "a" },
];

const EMOTIONS = ["HAPPY", "CURIOUS", "PLEASED", "AMAZED", "CONFIDENT"];

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function nameOf(id: string) {
  return MOCK_CHARACTERS.find((c) => c.id === id)?.name ?? "Stranger";
}

function replyLines(message: string | undefined, name: string) {
  const said = message?.trim();
  const pick = EMOTIONS[Math.floor(Math.random() * EMOTIONS.length)]!;
  if (!said) return [{ text: `${name} looks around. "Quiet today, isn't it?"`, emotion: "CURIOUS" }];
  return [
    { text: `You said: "${said.slice(0, 80)}".`, emotion: pick },
    { text: `I'm ${name}, a mock character. Connect a real API key to talk to your own characters.`, emotion: "HAPPY" },
  ];
}

/** A soft, decaying chord: long enough to hear, short enough not to annoy. */
function tone(text: string, rate = 24000): Float32Array {
  const seconds = Math.min(3, 0.4 + text.length * 0.03);
  const samples = new Float32Array(Math.floor(rate * seconds));
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate;
    const envelope = Math.min(1, t * 20) * Math.exp(-t * 1.2);
    samples[i] = envelope * 0.15 * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 330 * t));
  }
  return samples;
}

export const mockFetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
  const url = new URL(input);
  const path = url.pathname.replace(/^.*\/v3\//, "");
  const headers = new Headers(init.headers);
  if (headers.get("x-api-key") !== MOCK_API_KEY) return json({ error: "Invalid API key" }, 401);
  await new Promise((r) => setTimeout(r, 250 + Math.random() * 400));

  const body = typeof init.body === "string" ? JSON.parse(init.body) : null;

  switch (path) {
    case "chat": {
      const ids: string[] = body.characterIds;
      let sessionId: string = body.sessionId;
      if (!sessionId || !sessions.has(sessionId)) {
        sessionId = `mock-session-${crypto.randomUUID()}`;
        sessions.set(sessionId, { characterIds: ids, history: [] });
      }
      const session = sessions.get(sessionId)!;
      if (body.message) session.history.push({ content: body.message, sender: "USER", createdAt: new Date().toISOString() });
      const speakers = body.speakerCharacterId ? [body.speakerCharacterId] : ids.length > 1 ? ids.slice(0, 2) : ids;
      const messages = speakers.map((id: string, i: number) => {
        const lines = replyLines(i === 0 ? body.message : undefined, nameOf(id));
        for (const line of lines) {
          session.history.push({ content: line.text, sender: "ASSISTANT", speakerCharacterId: id, name: nameOf(id), emotion: line.emotion, createdAt: new Date(Date.now() + i).toISOString() });
        }
        const wantsDoor = /door|open/i.test(body.message ?? "");
        return { characterId: id, name: nameOf(id), lines, ...(wantsDoor && i === 0 ? { actions: [{ name: "OPEN_DOOR", targetId: "" }] } : {}) };
      });
      return json({ sessionId, messages });
    }
    case "chat/session": {
      const session = sessions.get(body.sessionId);
      if (!session) return json({ error: "Session not found" }, 404);
      return json({ sessionId: body.sessionId, messages: session.history.slice(-(body.limit ?? 20)), nextCursor: null });
    }
    case "audio/generate":
      return new Response(encodeWav(tone(body.message), 24000) as Uint8Array<ArrayBuffer>);
    case "audio/stream": {
      const pcm = encodeWav(tone(body.message), 24000);
      // Rewrite the header as a streaming one (unknown length), like the real endpoint.
      new DataView(pcm.buffer).setUint32(40, 0xffffffff, true);
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let at = 0; at < pcm.length; at += 4801) {
            controller.enqueue(pcm.slice(at, at + 4801));
            await new Promise((r) => setTimeout(r, 30));
          }
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "audio/wav", "x-sample-rate": "24000", "x-channels": "1" } });
    }
    case "audio/transcribe": {
      const form = init.body as FormData;
      const audio = form.get("audio") as File;
      return json({ response: `(mock transcript of ${Math.round(audio.size / 1024)} KB ${audio.name})`, model: "mock" });
    }
    case "quiz": {
      if (body.characterId) {
        const sessionId = `mock-quiz-${crypto.randomUUID()}`;
        quizzes.set(sessionId, { index: 0, score: 0, done: false, playerId: body.playerId });
        return json(quizTurn(sessionId, [{ text: "Welcome to the capitals quiz!", emotion: "HAPPY", role: "greeting" }]));
      }
      const quiz = quizzes.get(body.sessionId);
      if (!quiz) return json({ error: "Quiz not found", code: "not_found" }, 404);
      if (quiz.done) return json({ error: "The quiz is over.", code: "quiz_finished", turn: quizTurn(body.sessionId, [{ text: "That's the end!", emotion: "PLEASED", role: "closing" }]) }, 409);
      const question = QUESTIONS[quiz.index]!;
      const said = String(body.say ?? "").toLowerCase();
      if (/hint/.test(said)) return json(quizTurn(body.sessionId, [{ text: "Hint: it's not the biggest city.", emotion: "CONFIDENT", role: "reaction" }], { hintGiven: true }));
      const chosen = body.optionId ?? question.options.find((o) => said.includes(o.text.toLowerCase()))?.id;
      const correct = chosen === question.answer;
      if (correct) quiz.score += 10;
      quiz.index++;
      if (quiz.index >= QUESTIONS.length) quiz.done = true;
      const reaction = { text: correct ? "Correct!" : `Not quite. It was ${question.options.find((o) => o.id === question.answer)!.text}.`, emotion: correct ? "HAPPY" : "DISAPPOINTED", role: "reaction" };
      const closing = quiz.done ? [{ text: `That's the quiz! You scored ${quiz.score}.`, emotion: "PLEASED", role: "closing" }] : [];
      return json(quizTurn(body.sessionId, [reaction, ...closing], { result: [{ verdict: correct ? "correct" : "incorrect", score: correct ? 10 : 0 }] }));
    }
    case "quiz/session": {
      const id = url.searchParams.get("sessionId")!;
      const quiz = quizzes.get(id);
      if (!quiz) return json({ error: "Quiz not found" }, 404);
      return json({ state: { phase: quiz.done ? "finished" : "asking", expecting: quiz.done ? "nothing" : "answer" }, leaderboard: board(quiz.score), startedAt: new Date().toISOString(), finishedAt: quiz.done ? new Date().toISOString() : null });
    }
    case "usage":
      return json({ status: "ok", creditsRemaining: 4200, player: { interactionsToday: 3, creditsUsedAllTime: 12, overLimit: false } });
    case "characters":
      return json({ characters: MOCK_CHARACTERS });
    case "question-sets":
      return json({ questionSets: [MOCK_QUESTION_SET] });
    case "account":
      return json({ tier: "TEAM", email: "mock@example.com", creditsRemaining: 4200, nextRefresh: null });
    default:
      return json({ error: "Not found" }, 404);
  }
};

function board(score: number) {
  return [
    { participantId: "player", displayName: "You", totalScore: score, rank: 1 },
    { participantId: "ai", displayName: "Bram (AI)", totalScore: Math.max(0, score - 5), rank: 2 },
  ];
}

function quizTurn(sessionId: string, lines: Array<Record<string, string>>, extra: Record<string, unknown> = {}) {
  const quiz = quizzes.get(sessionId)!;
  const question = quiz.done ? undefined : QUESTIONS[quiz.index];
  const questionLine = question ? [{ text: question.questionText, emotion: "CURIOUS", role: "question" }] : [];
  return {
    sessionId,
    lines: [...lines, ...questionLine],
    expecting: quiz.done ? "nothing" : "answer",
    attempt: 1,
    attemptsLeft: 1,
    hintGiven: false,
    done: quiz.done,
    ...(question ? { question: { questionId: question.questionId, type: "multiple_choice", questionText: question.questionText, options: question.options, hasHint: true } } : {}),
    progress: { asked: Math.min(quiz.index + (quiz.done ? 0 : 1), QUESTIONS.length), total: QUESTIONS.length },
    leaderboard: board(quiz.score),
    ...extra,
  };
}
