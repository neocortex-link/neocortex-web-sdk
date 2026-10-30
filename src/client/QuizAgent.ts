import type { NeocortexClient } from "../core/client";
import type { Emotion } from "../core/emotions";
import type { NeocortexError } from "../core/errors";
import type {
  QuizContinueRequest,
  QuizExpecting,
  QuizLeaderboardEntry,
  QuizLine,
  QuizParticipant,
  QuizQuestion,
  QuizResult,
  QuizTurnResponse,
} from "../core/types";
import { StreamingAudioPlayer } from "./audio/StreamingAudioPlayer";
import { Emitter } from "./emitter";
import { type ClientSource, resolveClient, toNeocortexError } from "./shared";
import { LineSpeaker } from "./speech";

export type QuizAgentEvents = {
  busy: boolean;
  hostLine: { line: QuizLine; index: number };
  emotionChanged: Emotion;
  /** The host finished speaking this turn's lines. */
  hostFinished: QuizTurnResponse;
  questionChanged: QuizQuestion | null;
  upcoming: { questionId: string; keyword?: string };
  expectingChanged: QuizExpecting;
  result: QuizResult[];
  leaderboardChanged: QuizLeaderboardEntry[];
  /** Every turn, as the server sent it. */
  turn: QuizTurnResponse;
  finished: QuizTurnResponse;
  /** Input arrived while a turn was running and could not be queued. */
  inputDropped: { reason: "busy" | "finished" | "not_started" };
  creditsExhausted: NeocortexError;
  error: NeocortexError;
};

export type QuizAgentOptions = ClientSource & {
  characterId: string;
  questionSetId: string;
  playerId?: string;
  participants?: QuizParticipant[];
  questionCount?: number;
  selectionMode?: "sequential" | "random";
  /** Speak the host's lines aloud. */
  voice?: boolean;
  /** Hold input that arrives mid-turn and send it afterwards, instead of dropping it. */
  queueInputWhileBusy?: boolean;
  language?: string;
  player?: StreamingAudioPlayer;
};

/**
 * A quiz host that asks questions, judges answers and keeps score (Team plan).
 * The web counterpart of Unity's `NeocortexQuizAgent`.
 */
export class QuizAgent extends Emitter<QuizAgentEvents> {
  readonly client: NeocortexClient;
  readonly player: StreamingAudioPlayer;
  voice: boolean;
  queueInputWhileBusy: boolean;

  sessionId: string | null = null;
  question: QuizQuestion | null = null;
  progress: { asked: number; total: number } | null = null;
  expecting: QuizExpecting = "nothing";
  leaderboard: QuizLeaderboardEntry[] = [];
  lastResult: QuizResult[] = [];
  lastIntent?: string;
  attempt = 0;
  attemptsLeft = 0;
  hintGiven = false;
  pending: string[] = [];
  answered: string[] = [];
  isFinished = false;

  private readonly options: QuizAgentOptions;
  private readonly speaker: LineSpeaker;
  private controller = new AbortController();
  private running = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: QuizAgentOptions) {
    super();
    this.options = options;
    this.client = resolveClient(options);
    this.player = options.player ?? new StreamingAudioPlayer();
    this.voice = options.voice ?? false;
    this.queueInputWhileBusy = options.queueInputWhileBusy ?? true;
    this.speaker = new LineSpeaker(this.client, this.player);
  }

  get isBusy(): boolean {
    return this.running > 0;
  }

  /** Starts a new quiz, replacing any current one. */
  begin(participants?: QuizParticipant[]): Promise<QuizTurnResponse | null> {
    this.abort();
    this.reset();
    const { characterId, questionSetId, playerId, questionCount, selectionMode } = this.options;
    return this.run({
      characterId,
      questionSetId,
      ...(playerId ? { playerId } : {}),
      ...((participants ?? this.options.participants) ? { participants: participants ?? this.options.participants } : {}),
      ...(questionCount ? { questionCount } : {}),
      ...(selectionMode ? { selectionMode } : {}),
    });
  }

  /** The player answers (or asks for a hint, says "repeat", ...) in their own words. */
  say(text: string, options: { typed?: boolean } = {}) {
    return this.continueWith({ say: text, ...(options.typed ? { typed: true } : {}) });
  }

  sayAs(participantId: string, text: string, options: { typed?: boolean } = {}) {
    return this.continueWith({ say: text, participantId, ...(options.typed ? { typed: true } : {}) });
  }

  /** Picks one of the question's options. */
  choose(optionId: string) {
    return this.continueWith({ optionId });
  }

  chooseAs(participantId: string, optionId: string) {
    return this.continueWith({ optionId, participantId });
  }

  /** Skips the question. */
  pass() {
    return this.continueWith({ say: "" });
  }

  passAs(participantId: string) {
    return this.continueWith({ say: "", participantId });
  }

  /** Re-reads the quiz state from the server, e.g. after a reconnect. */
  async resync(): Promise<void> {
    if (!this.sessionId) return;
    try {
      const session = await this.client.quizSession(this.sessionId, { signal: this.controller.signal });
      this.setLeaderboard(session.leaderboard ?? []);
      if (session.state?.expecting) this.setExpecting(session.state.expecting);
      if (session.finishedAt) this.isFinished = true;
    } catch (error) {
      this.fail(error);
    }
  }

  abort(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.player.stop();
  }

  primeAudio(): void {
    this.player.prime();
  }

  private continueWith(input: Omit<QuizContinueRequest, "sessionId">): Promise<QuizTurnResponse | null> {
    if (!this.sessionId) return this.drop("not_started");
    if (this.isFinished) return this.drop("finished");
    if (this.isBusy && !this.queueInputWhileBusy) return this.drop("busy");
    return this.run(() => ({ sessionId: this.sessionId!, ...input }));
  }

  private drop(reason: "busy" | "finished" | "not_started"): Promise<null> {
    this.emit("inputDropped", { reason });
    return Promise.resolve(null);
  }

  private run(body: Parameters<NeocortexClient["quizTurn"]>[0] | (() => Parameters<NeocortexClient["quizTurn"]>[0])) {
    this.running++;
    if (this.running === 1) this.emit("busy", true);
    const signal = this.controller.signal;

    const task = this.queue.then(async () => {
      if (signal.aborted || (typeof body === "function" && this.isFinished)) return null;
      try {
        const turn = await this.client.quizTurn(typeof body === "function" ? body() : body, { signal });
        await this.apply(turn, signal);
        return turn;
      } catch (error) {
        const failure = toNeocortexError(error);
        if (failure.code === "quiz_finished" && failure.turn) {
          await this.apply(failure.turn, signal);
          return failure.turn;
        }
        this.fail(failure);
        return null;
      }
    });
    this.queue = task.catch(() => null);
    return task.finally(() => {
      this.running--;
      if (this.running === 0) this.emit("busy", false);
    });
  }

  private async apply(turn: QuizTurnResponse, signal: AbortSignal): Promise<void> {
    this.sessionId = turn.sessionId ?? this.sessionId;
    this.lastIntent = turn.intent;
    this.attempt = turn.attempt ?? 0;
    this.attemptsLeft = turn.attemptsLeft ?? 0;
    this.hintGiven = turn.hintGiven ?? false;
    this.pending = turn.pending ?? [];
    this.answered = turn.answered ?? [];
    if (turn.progress) this.progress = turn.progress;
    this.emit("turn", turn);

    if (turn.result?.length) {
      this.lastResult = turn.result;
      this.emit("result", turn.result);
    }
    if (turn.leaderboard) this.setLeaderboard(turn.leaderboard);

    let lastEmotion: Emotion | null = null;
    await this.speaker.speak({
      characterId: this.options.characterId,
      lines: turn.lines,
      voice: this.voice,
      pace: true,
      language: this.options.language,
      signal,
      onLineStart: (index) => {
        const line = turn.lines[index]!;
        if (line.emotion !== lastEmotion) this.emit("emotionChanged", (lastEmotion = line.emotion));
        this.emit("hostLine", { line, index });
      },
      onSpeechError: (error) => this.emit("error", toNeocortexError(error)),
    });
    this.emit("hostFinished", turn);

    // The question appears after the host has finished reading it out.
    if (turn.question && turn.question.questionId !== this.question?.questionId) {
      this.question = turn.question;
      this.emit("questionChanged", turn.question);
    }
    if (turn.upcoming) this.emit("upcoming", turn.upcoming);
    this.setExpecting(turn.expecting ?? "nothing");

    if (turn.done && !this.isFinished) {
      this.isFinished = true;
      this.question = null;
      this.emit("questionChanged", null);
      this.emit("finished", turn);
    }
  }

  private setExpecting(expecting: QuizExpecting) {
    if (expecting === this.expecting) return;
    this.expecting = expecting;
    this.emit("expectingChanged", expecting);
  }

  private setLeaderboard(leaderboard: QuizLeaderboardEntry[]) {
    this.leaderboard = leaderboard;
    this.emit("leaderboardChanged", leaderboard);
  }

  private fail(error: unknown) {
    const failure = toNeocortexError(error);
    if (failure.isAborted) return;
    if (failure.isOutOfCredits) this.emit("creditsExhausted", failure);
    this.emit("error", failure);
  }

  private reset() {
    this.sessionId = null;
    this.question = null;
    this.progress = null;
    this.expecting = "nothing";
    this.leaderboard = [];
    this.lastResult = [];
    this.attempt = this.attemptsLeft = 0;
    this.hintGiven = false;
    this.pending = [];
    this.answered = [];
    this.isFinished = false;
  }
}
