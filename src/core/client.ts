import { toAudioEmotion, toEmotion } from "./emotions";
import { NeocortexError } from "./errors";
import { type FetchLike, type RequestOptions, isBrowser, joinUrl, send, sleep } from "./http";
import type {
  AccountResponse,
  Character,
  ChatHistoryRequest,
  ChatHistoryResponse,
  ChatLine,
  ChatRequest,
  ChatResponse,
  GenerateAudioRequest,
  QuestionSet,
  QuizSessionResponse,
  QuizTurnRequest,
  QuizTurnResponse,
  TranscribeRequest,
  TranscribeResponse,
  UsageResponse,
} from "./types";
import { type PcmChunk, PcmStreamDecoder } from "./wav";

export const DEFAULT_API_URL = "https://api.neocortex.link/v3";
export const DEFAULT_PROXY_PATH = "/api/neocortex";

type HeaderSource = Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

export type NeocortexClientOptions = {
  /**
   * Where requests go. In the browser this is your own proxy route (default
   * `/api/neocortex`). With an `apiKey` it defaults to the Neocortex API itself.
   */
  baseUrl?: string;
  /**
   * The secret team key. Only for servers, or for local prototyping in a browser
   * together with `dangerouslyAllowBrowser`: anyone who opens the page can read it.
   */
  apiKey?: string;
  /** Allows an `apiKey` in browser code. Never ship a page with this set. */
  dangerouslyAllowBrowser?: boolean;
  /**
   * Extra headers for every request, typically your app's own auth for the proxy
   * (`{ authorization: "Bearer <session token>" }`). A function is called per request.
   */
  headers?: HeaderSource;
  /** Cookie policy for proxy requests. Defaults to `same-origin`. */
  credentials?: RequestCredentials;
  fetch?: FetchLike;
  /** Milliseconds to wait for a response to start. */
  timeouts?: { chat?: number; audio?: number; lookup?: number };
};

export type AudioStream = {
  /** PCM chunks in arrival order. Iterate once. */
  chunks: AsyncIterable<PcmChunk>;
  /** Stops the download. */
  cancel(): void;
};

/** How long Unity's SDK waits before retrying a quiz turn the server is still busy with. */
const QUIZ_BUSY_RETRY_MS = 1500;

/**
 * A thin, typed wrapper over every Neocortex v3 endpoint.
 *
 * Use it directly on a server, or let `SmartAgent`, `GroupDirector` and
 * `QuizAgent` drive it in the browser. It smooths over a few server quirks so
 * callers do not have to: transcription needs a filename the server can read the
 * format from, generated speech arrives without a content type, and streamed
 * speech has to be read from its WAV header.
 */
export class NeocortexClient {
  readonly baseUrl: string;
  readonly mode: "direct" | "proxy";

  private readonly apiKey?: string;
  private readonly headers?: HeaderSource;
  private readonly credentials: RequestCredentials;
  private readonly fetchImpl: FetchLike;
  private readonly timeouts: { chat: number; audio: number; lookup: number };

  constructor(options: NeocortexClientOptions = {}) {
    if (options.apiKey && isBrowser() && !options.dangerouslyAllowBrowser) {
      throw new NeocortexError(
        "An API key in browser code is public. Point the client at your server proxy (createNeocortexHandler) " +
          "instead, or pass dangerouslyAllowBrowser: true for local prototyping only.",
        { status: 0, code: "browser_api_key" },
      );
    }
    if (options.apiKey && isBrowser()) {
      console.warn("[neocortex] Using an API key in the browser. Anyone who opens this page can read and spend it.");
    }

    this.apiKey = options.apiKey;
    this.mode = options.apiKey ? "direct" : "proxy";
    this.baseUrl = options.baseUrl ?? (options.apiKey ? DEFAULT_API_URL : DEFAULT_PROXY_PATH);
    this.headers = options.headers;
    this.credentials = options.credentials ?? "same-origin";
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeouts = {
      chat: options.timeouts?.chat ?? 30_000,
      audio: options.timeouts?.audio ?? 20_000,
      lookup: options.timeouts?.lookup ?? 15_000,
    };
  }

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------

  /** Sends one turn to one character, or to a group scene. */
  async chat(request: ChatRequest, options?: RequestOptions): Promise<ChatResponse> {
    const response = await this.json<ChatResponse>("chat", request, this.timeouts.chat, options);
    return {
      sessionId: response.sessionId,
      messages: (response.messages ?? []).map((message) => ({
        ...message,
        lines: normalizeLines(message.lines),
        actions: message.actions ?? [],
      })),
    };
  }

  /** One page of a session's history, newest page first. Pass `nextCursor` as `before` for the next. */
  async chatHistory(request: ChatHistoryRequest, options?: RequestOptions): Promise<ChatHistoryResponse> {
    const response = await this.json<ChatHistoryResponse>("chat/session", request, this.timeouts.lookup, options);
    return {
      ...response,
      messages: (response.messages ?? []).map((entry) =>
        entry.emotion ? { ...entry, emotion: toEmotion(entry.emotion) } : entry,
      ),
      nextCursor: response.nextCursor ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Audio
  // -------------------------------------------------------------------------

  /** Synthesizes a whole clip in the character's voice. */
  async generateAudio(request: GenerateAudioRequest, options?: RequestOptions): Promise<Blob> {
    const format = request.format ?? "mp3";
    const response = await this.post("audio/generate", this.audioBody({ ...request, format }), this.timeouts.audio, options);
    // The server sends no content type, so label the bytes with what was asked for.
    return new Blob([await response.arrayBuffer()], { type: format === "wav" ? "audio/wav" : "audio/mpeg" });
  }

  /**
   * Streams speech as it is synthesized, for first sound in about a tenth of a
   * second instead of a few seconds. Feed the chunks to `StreamingAudioPlayer`.
   */
  async streamAudio(request: Omit<GenerateAudioRequest, "format">, options?: RequestOptions): Promise<AudioStream> {
    const controller = new AbortController();
    const outer = options?.signal;
    outer?.addEventListener("abort", () => controller.abort(outer.reason), { once: true });

    const response = await this.post("audio/stream", this.audioBody(request), this.timeouts.audio, {
      ...options,
      signal: controller.signal,
    });
    const body = response.body;
    if (!body) throw new NeocortexError("The speech stream had no body.", { status: response.status });

    async function* chunks(): AsyncGenerator<PcmChunk> {
      const reader = body!.getReader();
      const decoder = new PcmStreamDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          if (!value?.length) continue;
          const chunk = decoder.push(value);
          if (chunk) yield chunk;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        throw error;
      } finally {
        reader.releaseLock();
      }
    }

    return { chunks: chunks(), cancel: () => controller.abort() };
  }

  /** Turns recorded speech into text. */
  async transcribe(request: TranscribeRequest, options?: RequestOptions): Promise<TranscribeResponse> {
    const form = new FormData();
    form.append("characterId", request.characterId);
    form.append("audio", request.audio, audioFilename(request.audio));
    if (request.language) form.append("language", request.language);
    if (request.prompt) form.append("prompt", request.prompt);

    const response = await send(
      this.fetchImpl,
      joinUrl(this.baseUrl, "audio/transcribe"),
      { method: "POST", body: form, headers: await this.requestHeaders(), credentials: this.credentials },
      this.timeouts.audio,
      options,
    );
    const body = (await response.json()) as TranscribeResponse & { text?: string };
    return { response: body.response ?? body.text ?? "", model: body.model };
  }

  // -------------------------------------------------------------------------
  // Quiz
  // -------------------------------------------------------------------------

  /**
   * Starts a quiz (with `characterId` and `questionSetId`) or plays the next
   * turn (with `sessionId`). Retries the server's "still busy" refusals the same
   * way the Unity SDK does.
   */
  async quizTurn(request: QuizTurnRequest, options?: RequestOptions): Promise<QuizTurnResponse> {
    let busyRetries = 2;
    let staleRetries = 1;

    while (true) {
      try {
        const turn = await this.json<QuizTurnResponse>("quiz", request, this.timeouts.chat, options);
        return { ...turn, lines: normalizeLines(turn.lines ?? []) as QuizTurnResponse["lines"] };
      } catch (error) {
        if (!(error instanceof NeocortexError)) throw error;
        if (error.code === "operation_in_progress" && busyRetries-- > 0) {
          await sleep((error.retryAfter ?? QUIZ_BUSY_RETRY_MS / 1000) * 1000, options?.signal);
          continue;
        }
        if (error.code === "state_changed" && staleRetries-- > 0) continue;
        throw error;
      }
    }
  }

  async quizSession(sessionId: string, options?: RequestOptions): Promise<QuizSessionResponse> {
    return this.get<QuizSessionResponse>(`quiz/session?sessionId=${encodeURIComponent(sessionId)}`, options);
  }

  // -------------------------------------------------------------------------
  // Account and catalogue
  // -------------------------------------------------------------------------

  async usage(query: { playerId?: string; characterId?: string } = {}, options?: RequestOptions): Promise<UsageResponse> {
    const params = new URLSearchParams();
    if (query.playerId) params.set("playerId", query.playerId);
    if (query.characterId) params.set("characterId", query.characterId);
    const qs = params.toString();
    const suffix = qs ? `?${qs}` : "";
    return this.get<UsageResponse>(`usage${suffix}`, options);
  }

  async account(options?: RequestOptions): Promise<AccountResponse> {
    return this.get<AccountResponse>("account", options);
  }

  async characters(options?: RequestOptions): Promise<Character[]> {
    return (await this.get<{ characters: Character[] }>("characters", options)).characters ?? [];
  }

  async questionSets(options?: RequestOptions): Promise<QuestionSet[]> {
    return (await this.get<{ questionSets: QuestionSet[] }>("question-sets", options)).questionSets ?? [];
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private audioBody(request: GenerateAudioRequest) {
    return {
      characterId: request.characterId,
      message: request.message,
      ...(request.emotion ? { emotion: toAudioEmotion(request.emotion) } : {}),
      ...(request.format ? { format: request.format } : {}),
      ...(request.language ? { language: request.language } : {}),
      // Only the proxy reads this; it strips it before calling Neocortex.
      ...(request.speechToken && this.mode === "proxy" ? { speechToken: request.speechToken } : {}),
    };
  }

  private async requestHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const custom = typeof this.headers === "function" ? await this.headers() : this.headers;
    return {
      accept: "application/json",
      ...custom,
      ...extra,
      // Browsers can only send the key as x-api-key: the API's CORS rules do not
      // allow an Authorization header.
      ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
    };
  }

  private async post(path: string, body: unknown, timeoutMs: number, options?: RequestOptions): Promise<Response> {
    return send(
      this.fetchImpl,
      joinUrl(this.baseUrl, path),
      {
        method: "POST",
        headers: await this.requestHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(body),
        credentials: this.credentials,
      },
      timeoutMs,
      options,
    );
  }

  private async json<T>(path: string, body: unknown, timeoutMs: number, options?: RequestOptions): Promise<T> {
    const response = await this.post(path, body, timeoutMs, options);
    return (await response.json()) as T;
  }

  private async get<T>(path: string, options?: RequestOptions): Promise<T> {
    const response = await send(
      this.fetchImpl,
      joinUrl(this.baseUrl, path),
      { method: "GET", headers: await this.requestHeaders(), credentials: this.credentials },
      this.timeouts.lookup,
      options,
    );
    return (await response.json()) as T;
  }
}

function normalizeLines(lines: ChatLine[] | undefined): ChatLine[] {
  return (lines ?? []).map((line) => ({ ...line, emotion: toEmotion(line.emotion) }));
}

const EXTENSIONS: Record<string, string> = {
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/vnd.wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "m4a",
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
};

const READABLE = new Set(Object.values(EXTENSIONS));

/**
 * The server picks the decoder from the uploaded file's extension and assumes
 * mp3 otherwise, so a recorded Blob (which has no name) must be given one that
 * matches its type.
 */
export function audioFilename(audio: Blob): string {
  const name = typeof File !== "undefined" && audio instanceof File ? audio.name : "";
  const existing = name.split(".").pop()?.toLowerCase();
  if (existing && READABLE.has(existing) && name.includes(".")) return name;

  const mime = audio.type.split(";")[0]!.trim().toLowerCase();
  return `speech.${EXTENSIONS[mime] ?? "wav"}`;
}
