import type { NeocortexClient } from "../core/client";
import type { Emotion } from "../core/emotions";
import type { NeocortexError } from "../core/errors";
import type { ChatAction, ChatHistoryResponse, ChatLine, ChatRequest, ChatResponse, GroupMessage } from "../core/types";
import { StreamingAudioPlayer } from "./audio/StreamingAudioPlayer";
import { Emitter } from "./emitter";
import type { EventLogger } from "./EventLogger";
import type { Interactables } from "./Interactables";
import { LocalSessionStore, type SessionStore } from "./SessionStore";
import { type ClientSource, resolveClient, toNeocortexError } from "./shared";
import { LineSpeaker } from "./speech";

/** When registered actions run, relative to the reply. */
export type ActionTrigger = "whenResponseReceived" | "whenSpeechStarts" | "afterReplySpoken";

export type ActionHandler = (action: ChatAction, message: GroupMessage) => void | Promise<void>;

export type ConversationEvents = {
  /** True while a turn is in flight or being played. */
  busy: boolean;
  /** True while waiting on the server, or between paced lines: show a thinking indicator. */
  composing: boolean;
  /** What the player said, typed or transcribed. */
  playerMessage: string;
  transcription: string;
  /** The whole reply, as soon as it arrives. */
  response: ChatResponse;
  /** A character begins its part of the reply. */
  speaker: { characterId: string; name: string };
  lineStarted: { characterId: string; name: string; line: ChatLine; index: number };
  emotionChanged: { characterId: string; emotion: Emotion };
  action: { characterId: string; action: ChatAction; message: GroupMessage };
  /** A character finished its part of the reply. */
  message: GroupMessage;
  /** Every character has finished speaking. */
  replyFinished: ChatResponse;
  history: ChatHistoryResponse;
  error: NeocortexError;
};

export type ConversationOptions = ClientSource & {
  /** Speak replies aloud. Can also be chosen per call. */
  voice?: boolean;
  /** Show multi-line replies one line at a time. Defaults to true. */
  paceLines?: boolean;
  actionTrigger?: ActionTrigger;
  /** Persists the session between page loads. Pass `null` to start fresh every time. */
  sessionStore?: SessionStore | null;
  /** Scene entities to send with each turn (needs `allowClientContext` on the proxy). */
  interactables?: Interactables;
  /** Game events to send with each turn (needs `allowClientContext` on the proxy). */
  eventLogger?: EventLogger;
  /** Language for speech and transcription, e.g. "en" or "tr". */
  language?: string;
  player?: StreamingAudioPlayer;
};

type TurnInput = Omit<ChatRequest, "characterIds" | "sessionId" | "playerId"> & { voice?: boolean };

/**
 * The shared engine behind `SmartAgent` and `GroupDirector`: sending turns one at
 * a time, remembering the session, playing each character's lines, and running
 * the actions they ask for.
 */
export class Conversation extends Emitter<ConversationEvents> {
  readonly client: NeocortexClient;
  readonly player: StreamingAudioPlayer;
  voice: boolean;
  paceLines: boolean;
  actionTrigger: ActionTrigger;
  language?: string;

  protected characterIds: string[];
  private readonly store: SessionStore | null;
  private readonly speaker: LineSpeaker;
  private readonly interactables?: Interactables;
  private readonly eventLogger?: EventLogger;
  private actions = new Map<string, ActionHandler>();
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private controller = new AbortController();
  private _sessionId: string | null;
  private speaking = false;

  constructor(characterIds: string[], options: ConversationOptions) {
    super();
    if (characterIds.length === 0) throw new Error("A conversation needs at least one characterId.");
    this.characterIds = characterIds;
    this.client = resolveClient(options);
    this.player = options.player ?? new StreamingAudioPlayer();
    this.voice = options.voice ?? false;
    this.paceLines = options.paceLines ?? true;
    this.actionTrigger = options.actionTrigger ?? "whenResponseReceived";
    this.language = options.language;
    this.store = options.sessionStore === undefined ? new LocalSessionStore() : options.sessionStore;
    this.interactables = options.interactables;
    this.eventLogger = options.eventLogger;
    this.speaker = new LineSpeaker(this.client, this.player);
    this._sessionId = this.store?.get(this.sessionKey) ?? null;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get isBusy(): boolean {
    return this.pending > 0;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Runs `handler` whenever a character asks for the action `name` (e.g. "OPEN_DOOR"). */
  registerAction(name: string, handler: ActionHandler): () => void {
    this.actions.set(name.toUpperCase(), handler);
    return () => this.unregisterAction(name);
  }

  unregisterAction(name: string): void {
    this.actions.delete(name.toUpperCase());
  }

  /** Forgets the conversation; the next turn starts a new session. */
  clearSession(): void {
    this._sessionId = null;
    this.store?.clear(this.sessionKey);
  }

  /** Cancels the turn in flight and anything queued, and stops speech. */
  abort(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.player.stop();
  }

  /** Unlocks audio output. Call from the click or key press that sends a message. */
  primeAudio(): void {
    this.player.prime();
  }

  /** Loads one page of this conversation's history, newest page first. */
  async history(limit = 20, before?: string): Promise<ChatHistoryResponse | null> {
    if (!this._sessionId) return null;
    try {
      const page = await this.client.chatHistory({ sessionId: this._sessionId, limit, before }, { signal: this.controller.signal });
      this.emit("history", page);
      return page;
    } catch (error) {
      const failure = toNeocortexError(error);
      // A session the server no longer knows is simply a fresh start.
      if (failure.status === 404) this.clearSession();
      else if (!failure.isAborted) this.emit("error", failure);
      return null;
    }
  }

  /** Transcribes a recording with the first character's speech settings. */
  async transcribe(audio: Blob): Promise<string | null> {
    try {
      const { response } = await this.client.transcribe(
        { characterId: this.characterIds[0]!, audio, language: this.language },
        { signal: this.controller.signal },
      );
      const text = response.trim();
      this.emit("transcription", text);
      return text || null;
    } catch (error) {
      const failure = toNeocortexError(error);
      if (!failure.isAborted) this.emit("error", failure);
      return null;
    }
  }

  protected get sessionKey(): string {
    return this.characterIds.length === 1 ? this.characterIds[0]! : `group:${[...this.characterIds].sort().join(",")}`;
  }

  /** Queues one turn. Resolves with the reply once it has been played, or null on failure. */
  protected turn(input: TurnInput): Promise<ChatResponse | null> {
    this.pending++;
    if (this.pending === 1) this.emit("busy", true);
    const signal = this.controller.signal;

    const run = this.queue.then(() => (signal.aborted ? null : this.runTurn(input, signal)));
    this.queue = run.catch(() => null);
    return run.finally(() => {
      this.pending--;
      if (this.pending === 0) this.emit("busy", false);
    });
  }

  private async runTurn(input: TurnInput, signal: AbortSignal): Promise<ChatResponse | null> {
    const { voice = this.voice, ...request } = input;
    if (request.message !== undefined) this.emit("playerMessage", request.message);
    this.emit("composing", true);

    let response: ChatResponse;
    try {
      response = await this.client.chat(
        {
          ...request,
          characterIds: this.characterIds,
          ...(this._sessionId ? { sessionId: this._sessionId } : {}),
          ...(this.interactables ? { metadata: this.interactables.toMetadata() } : {}),
          ...(this.eventLogger ? { events: this.eventLogger.getLogs() } : {}),
        },
        { signal },
      );
    } catch (error) {
      this.emit("composing", false);
      const failure = toNeocortexError(error);
      if (!failure.isAborted) this.emit("error", failure);
      return null;
    }

    this._sessionId = response.sessionId;
    this.store?.set(this.sessionKey, response.sessionId);
    this.emit("response", response);

    if (this.actionTrigger === "whenResponseReceived") {
      for (const message of response.messages) await this.runActions(message);
    }

    this.speaking = true;
    try {
      for (const message of response.messages) {
        if (signal.aborted) break;
        await this.playMessage(message, voice, signal);
      }
    } finally {
      this.speaking = false;
      this.emit("composing", false);
    }

    if (this.actionTrigger === "afterReplySpoken") {
      for (const message of response.messages) await this.runActions(message);
    }
    this.emit("replyFinished", response);
    return response;
  }

  private async playMessage(message: GroupMessage, voice: boolean, signal: AbortSignal): Promise<void> {
    const { characterId, name } = message;
    this.emit("speaker", { characterId, name });
    let lastEmotion: Emotion | null = null;
    let actionsRun = false;

    await this.speaker.speak({
      characterId,
      lines: message.lines,
      voice,
      pace: this.paceLines,
      language: this.language,
      signal,
      onLineStart: (index) => {
        const line = message.lines[index]!;
        // The server has answered, so stop showing "thinking" while a line is up.
        this.emit("composing", false);
        if (line.emotion !== lastEmotion) {
          lastEmotion = line.emotion;
          this.emit("emotionChanged", { characterId, emotion: line.emotion });
        }
        this.emit("lineStarted", { characterId, name, line, index });
        if (this.actionTrigger === "whenSpeechStarts" && !actionsRun) {
          actionsRun = true;
          void this.runActions(message);
        }
      },
      onSpeechError: (error) => this.emit("error", toNeocortexError(error)),
    });

    if (this.actionTrigger === "whenSpeechStarts" && !actionsRun) await this.runActions(message);
    this.emit("message", message);
  }

  private async runActions(message: GroupMessage): Promise<void> {
    for (const action of message.actions ?? []) {
      this.emit("action", { characterId: message.characterId, action, message });
      const handler = this.actions.get(action.name.toUpperCase());
      if (!handler) continue;
      try {
        await handler(action, message);
      } catch (error) {
        this.emit("error", toNeocortexError(error));
      }
    }
  }
}
