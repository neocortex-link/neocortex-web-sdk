import { audioFilename, DEFAULT_API_URL } from "../core/client";
import type { FetchLike } from "../core/http";
import { joinUrl } from "../core/http";
import type { ChatLine, EventLog, Interactable } from "../core/types";
import { errorResponse, jsonResponse, ProxyError, readBody, readJson } from "./http";
import { MemoryRateLimiter, type RateLimiter, type RateLimitOptions } from "./rateLimit";
import { Signer } from "./signing";

/** Whoever your app says is making the request. */
export type NeocortexUser = {
  /** A stable id. It becomes the Neocortex `playerId`, so per-player credit caps apply to it. */
  id: string;
};

export type ProxyRoute =
  | "chat"
  | "history"
  | "speech"
  | "speechStream"
  | "transcribe"
  | "quiz"
  | "quizSession"
  | "usage"
  | "characters"
  | "questionSets"
  | "account";

export type ProxyLimits = {
  /** Longest player message, in characters. */
  messageChars: number;
  /** Longest text for speech synthesis, in characters (the API's own cap is 2000). */
  speechChars: number;
  /** Largest JSON body, in bytes. */
  jsonBytes: number;
  /** Largest audio upload for transcription, in bytes (the API's own cap is 10 MB). */
  audioBytes: number;
  /** Most characters in one group turn. */
  charactersPerTurn: number;
  /** Most scene entities a turn may carry. */
  metadataItems: number;
  /** Most events a turn may carry. */
  eventItems: number;
};

type Allowlist = string[] | ((user: NeocortexUser) => string[] | Promise<string[]>);

export type TextFilterContext = { user: NeocortexUser; route: "chat" | "quiz" };

export type NeocortexHandlerOptions = {
  /** The secret team key. Read it from the environment; it never leaves the server. */
  apiKey: string;
  /** Defaults to https://api.neocortex.link/v3. */
  baseUrl?: string;
  /** Where the handler is mounted. Defaults to `/api/neocortex`. Use "" when it owns the whole host. */
  basePath?: string;
  /**
   * Identifies the visitor with your app's own auth (session cookie, JWT, ...).
   * Return null to refuse the request with 401.
   */
  authorize: (request: Request) => NeocortexUser | null | undefined | Promise<NeocortexUser | null | undefined>;
  /** The characters the browser may talk to. Anything else is refused with 403. */
  characters: Allowlist;
  /** Question sets the browser may start quizzes with. When left out, any of the team's sets. */
  questionSets?: Allowlist;
  /**
   * Turns individual routes on or off. `characters`, `questionSets` and `account`
   * are off by default: they list the whole team's content, and `account` includes
   * the team's email address.
   */
  routes?: Partial<Record<ProxyRoute, boolean>>;
  limits?: Partial<ProxyLimits>;
  /** Per-user request limit. Defaults to 30 requests a minute, held in memory. `false` turns it off. */
  rateLimit?: RateLimitOptions | RateLimiter | false;
  /**
   * By default, text-to-speech only voices lines a character actually said to this
   * user. Turn off to let the browser synthesize any text in a character's voice.
   */
  speechRepliesOnly?: boolean;
  /**
   * Whether the browser may send its own scene `metadata` and `events`. Off by
   * default: a visitor could otherwise tell a character anything about the world.
   * Build trusted context with `buildContext` instead.
   */
  allowClientContext?: boolean;
  /** Adds server-side scene context to every chat turn. */
  buildContext?: (
    user: NeocortexUser,
    turn: { characterIds: string[]; message?: string; request: Request },
  ) => { metadata?: Interactable[]; events?: EventLog[] } | Promise<{ metadata?: Interactable[]; events?: EventLog[] }>;
  /** Rewrites what characters say before it reaches the browser, e.g. for moderation. */
  filterText?: (text: string, context: TextFilterContext) => string | Promise<string>;
  /** Cross-origin browsers that may call the proxy. Same-origin pages need nothing here. */
  cors?: { origins: string[]; allowHeaders?: string[] };
  /** Signs session and speech tokens. Defaults to a key derived from `apiKey`. */
  secret?: string;
  /** Milliseconds to wait for Neocortex to start answering. Defaults to 60 s. */
  timeoutMs?: number;
  fetch?: FetchLike;
  /** Called for failures worth logging. Never receives the API key. */
  onError?: (error: unknown, context: { route?: ProxyRoute; userId?: string; status: number }) => void;
};

const ROUTES: Record<ProxyRoute, { method: "GET" | "POST"; path: string }> = {
  chat: { method: "POST", path: "chat" },
  history: { method: "POST", path: "chat/session" },
  speech: { method: "POST", path: "audio/generate" },
  speechStream: { method: "POST", path: "audio/stream" },
  transcribe: { method: "POST", path: "audio/transcribe" },
  quiz: { method: "POST", path: "quiz" },
  quizSession: { method: "GET", path: "quiz/session" },
  usage: { method: "GET", path: "usage" },
  characters: { method: "GET", path: "characters" },
  questionSets: { method: "GET", path: "question-sets" },
  account: { method: "GET", path: "account" },
};

const ROUTE_BY_PATH = new Map(Object.entries(ROUTES).map(([name, route]) => [route.path, name as ProxyRoute]));

const DEFAULT_ROUTES: Record<ProxyRoute, boolean> = {
  chat: true,
  history: true,
  speech: true,
  speechStream: true,
  transcribe: true,
  quiz: true,
  quizSession: true,
  usage: true,
  characters: false,
  questionSets: false,
  account: false,
};

const DEFAULT_LIMITS: ProxyLimits = {
  messageChars: 500,
  speechChars: 2000,
  jsonBytes: 64 * 1024,
  audioBytes: 10 * 1024 * 1024,
  charactersPerTurn: 6,
  metadataItems: 40,
  eventItems: 20,
};

/** Upstream bodies are relayed for these statuses; anything else becomes a generic 502. */
const RELAYED_STATUSES = new Set([400, 402, 403, 404, 409, 413, 422, 429]);

type Context = {
  request: Request;
  url: URL;
  user: NeocortexUser;
  route: ProxyRoute;
};

class UpstreamError extends ProxyError {
  constructor(
    status: number,
    code: string,
    message: string,
    headers: Record<string, string>,
    readonly body: Record<string, unknown>,
  ) {
    super(status, code, message, headers);
  }
}

/**
 * Creates the server half of the SDK: a proxy that holds your API key and lets
 * browsers use Neocortex without ever seeing it.
 *
 * It is a standard `(Request) => Promise<Response>` handler, so it mounts as-is in
 * Next.js route handlers, Cloudflare Workers, Hono, Bun and Deno. Wrap it with
 * `toNodeHandler` for Express or `node:http`.
 *
 * Every request is checked before it costs anything: your `authorize` must accept
 * the visitor, the route must be on, the character must be on your allowlist, the
 * body must be within limits, and the visitor must be within their rate limit.
 * The proxy then rebuilds the request from known fields only, sets `playerId` to
 * the authorized user, and binds session ids to that user so nobody can read or
 * continue someone else's conversation.
 */
export function createNeocortexHandler(options: NeocortexHandlerOptions): (request: Request) => Promise<Response> {
  if (!options.apiKey) throw new Error("createNeocortexHandler: apiKey is required.");
  if (typeof options.authorize !== "function") throw new Error("createNeocortexHandler: authorize is required.");
  if (!options.characters) throw new Error("createNeocortexHandler: a characters allowlist is required.");

  const baseUrl = options.baseUrl || DEFAULT_API_URL;
  const basePath = (options.basePath ?? "/api/neocortex").replace(/\/+$/, "");
  const routes = { ...DEFAULT_ROUTES, ...options.routes };
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 60_000;
  const signer = new Signer(options.secret ?? options.apiKey);
  const speechRepliesOnly = options.speechRepliesOnly ?? true;
  const limiter: RateLimiter | null =
    options.rateLimit === false
      ? null
      : options.rateLimit && "take" in options.rateLimit
        ? options.rateLimit
        : new MemoryRateLimiter(options.rateLimit ?? { limit: 30, windowSeconds: 60 });
  const inFlight = new Set<string>();
  const corsOrigins = new Set(options.cors?.origins ?? []);
  const onError =
    options.onError ??
    ((error: unknown, context: { route?: ProxyRoute; status: number }) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[neocortex proxy] ${context.route ?? "-"} ${context.status}: ${message}`);
    });

  // ---------------------------------------------------------------------------
  // Shared checks
  // ---------------------------------------------------------------------------

  async function allowed(list: Allowlist | undefined, user: NeocortexUser): Promise<Set<string> | null> {
    if (!list) return null;
    return new Set(typeof list === "function" ? await list(user) : list);
  }

  async function requireCharacter(user: NeocortexUser, id: unknown): Promise<string> {
    if (typeof id !== "string" || !id || id.length > 128) {
      throw new ProxyError(422, "invalid_character", "characterId must be a character id.");
    }
    const list = await allowed(options.characters, user);
    if (!list?.has(id)) throw new ProxyError(403, "character_not_allowed", "That character is not available here.");
    return id;
  }

  function requireText(value: unknown, field: string, max: number, required: boolean): string | undefined {
    if (value === undefined || value === null) {
      if (required) throw new ProxyError(422, "invalid_field", `${field} is required.`);
      return undefined;
    }
    if (typeof value !== "string") throw new ProxyError(422, "invalid_field", `${field} must be text.`);
    if (value.length > max) throw new ProxyError(422, "too_long", `${field} is longer than ${max} characters.`);
    if (required && !value.trim()) throw new ProxyError(422, "invalid_field", `${field} is empty.`);
    return value;
  }

  function optionalId(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || value.length > 128) throw new ProxyError(422, "invalid_field", `${field} is invalid.`);
    return value;
  }

  function clampInt(value: unknown, min: number, max: number): number | undefined {
    if (value === undefined || value === null) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new ProxyError(422, "invalid_field", "Expected a number.");
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  function checkOrigin(request: Request) {
    const origin = request.headers.get("origin");
    if (origin && corsOrigins.has(origin)) return;
    const site = request.headers.get("sec-fetch-site");
    if (site === "cross-site") {
      throw new ProxyError(403, "origin_not_allowed", "Requests from other sites are not allowed.");
    }
    if (!site && origin) {
      // Older browsers send no Sec-Fetch-Site; compare the Origin with the host instead.
      const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
        // An unparseable origin is treated as foreign.
      }
      if (host && originHost !== host.split(",")[0]!.trim()) {
        throw new ProxyError(403, "origin_not_allowed", "Requests from other sites are not allowed.");
      }
    }
  }

  function corsHeaders(request: Request): Record<string, string> {
    const origin = request.headers.get("origin");
    if (!origin || !corsOrigins.has(origin)) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-expose-headers": "retry-after, x-sample-rate, x-channels",
      vary: "Origin",
    };
  }

  async function lock<T>(key: string, run: () => Promise<T>): Promise<T> {
    if (inFlight.has(key)) {
      throw new ProxyError(409, "operation_in_progress", "The previous turn is still running.", { "retry-after": "2" });
    }
    inFlight.add(key);
    try {
      return await run();
    } finally {
      inFlight.delete(key);
    }
  }

  // ---------------------------------------------------------------------------
  // Upstream
  // ---------------------------------------------------------------------------

  async function upstream(ctx: Context, path: string, init: { method: string; body?: BodyInit; json?: boolean }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // The turn still runs and bills upstream if the visitor leaves, but there is no
    // point waiting for an answer nobody will read.
    const onClose = () => controller.abort();
    ctx.request.signal?.addEventListener("abort", onClose, { once: true });

    let response: Response;
    try {
      response = await fetchImpl(joinUrl(baseUrl, path), {
        method: init.method,
        body: init.body,
        signal: controller.signal,
        headers: {
          "x-api-key": options.apiKey,
          accept: "application/json",
          ...(init.json ? { "content-type": "application/json" } : {}),
        },
      });
    } catch (error) {
      onError(error, { route: ctx.route, userId: ctx.user.id, status: 502 });
      throw new ProxyError(502, "upstream_unreachable", "Neocortex could not be reached. Try again shortly.");
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) return response;

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const message = typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
    const code = typeof body.code === "string" ? body.code : typeof body.error === "string" && /^[a-z_]+$/.test(body.error) ? body.error : "upstream_error";

    if (response.status === 401) {
      // Our key was refused. The visitor did nothing wrong and should not learn why.
      onError(new Error(`Neocortex rejected the API key: ${message}`), { route: ctx.route, userId: ctx.user.id, status: 401 });
      throw new ProxyError(502, "proxy_misconfigured", "The Neocortex proxy is not configured correctly.");
    }
    if (!RELAYED_STATUSES.has(response.status)) {
      onError(new Error(`Neocortex returned ${response.status}: ${message}`), {
        route: ctx.route,
        userId: ctx.user.id,
        status: response.status,
      });
      throw new ProxyError(502, "upstream_error", "Neocortex is unavailable right now. Try again shortly.");
    }

    const headers: Record<string, string> = {};
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) headers["retry-after"] = retryAfter;
    throw new UpstreamError(response.status, code, message, headers, body);
  }

  async function upstreamJson<T>(ctx: Context, path: string, body?: unknown): Promise<T> {
    const response = await upstream(
      ctx,
      path,
      body === undefined ? { method: "GET" } : { method: "POST", body: JSON.stringify(body), json: true },
    );
    return (await response.json()) as T;
  }

  /** Filters each line and attaches the token that lets it be spoken later. */
  async function signLines(ctx: Context, lines: unknown, route: "chat" | "quiz"): Promise<ChatLine[]> {
    if (!Array.isArray(lines)) return [];
    return Promise.all(
      lines.map(async (raw: ChatLine) => {
        const line = { ...raw };
        if (options.filterText) {
          line.text = await options.filterText(line.text ?? "", { user: ctx.user, route });
          if (line.spokenText) line.spokenText = await options.filterText(line.spokenText, { user: ctx.user, route });
        }
        line.speechToken = await signer.speechToken(ctx.user.id, line.spokenText || line.text || "");
        return line;
      }),
    );
  }

  async function signQuizTurn(ctx: Context, turn: Record<string, unknown>): Promise<Record<string, unknown>> {
    return {
      ...turn,
      sessionId: typeof turn.sessionId === "string" ? await signer.wrapSession(turn.sessionId, ctx.user.id) : turn.sessionId,
      lines: await signLines(ctx, turn.lines, "quiz"),
    };
  }

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  const handlers: Record<ProxyRoute, (ctx: Context) => Promise<Response>> = {
    async chat(ctx) {
      const body = await readJson(ctx.request, limits.jsonBytes);
      const rawIds = Array.isArray(body.characterIds) ? body.characterIds : body.characterId ? [body.characterId] : [];
      if (rawIds.length === 0 || rawIds.length > limits.charactersPerTurn) {
        throw new ProxyError(422, "invalid_characters", `Send between 1 and ${limits.charactersPerTurn} characterIds.`);
      }
      const characterIds: string[] = [];
      for (const id of rawIds) characterIds.push(await requireCharacter(ctx.user, id));

      const message = requireText(body.message, "message", limits.messageChars, false);
      const speakerCharacterId = optionalId(body.speakerCharacterId, "speakerCharacterId");
      if (speakerCharacterId && !characterIds.includes(speakerCharacterId)) {
        throw new ProxyError(422, "invalid_field", "speakerCharacterId must be one of characterIds.");
      }
      const playAs = body.playAs === null ? null : body.playAs === undefined ? undefined : await requireCharacter(ctx.user, body.playAs);
      // A token from a rotated key or another user starts a fresh conversation rather than failing.
      const sessionId = body.sessionId ? ((await signer.unwrapSession(body.sessionId, ctx.user.id)) ?? undefined) : undefined;

      let metadata: Interactable[] = [];
      let events: EventLog[] = [];
      if (options.allowClientContext) {
        if (Array.isArray(body.metadata)) metadata = body.metadata as Interactable[];
        if (Array.isArray(body.events)) events = body.events as EventLog[];
      }
      if (options.buildContext) {
        const extra = await options.buildContext(ctx.user, { characterIds, message, request: ctx.request });
        metadata = [...metadata, ...(extra.metadata ?? [])];
        events = [...events, ...(extra.events ?? [])];
      }

      const upstreamBody = {
        characterIds,
        playerId: ctx.user.id,
        ...(message !== undefined ? { message } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(speakerCharacterId ? { speakerCharacterId } : {}),
        ...(playAs !== undefined ? { playAs } : {}),
        ...(body.maxTurns !== undefined ? { maxTurns: clampInt(body.maxTurns, 1, limits.charactersPerTurn) } : {}),
        ...(metadata.length ? { metadata: metadata.slice(0, limits.metadataItems) } : {}),
        ...(events.length ? { events: events.slice(-limits.eventItems) } : {}),
      };

      const reply = await lock(`chat:${ctx.user.id}:${sessionId ?? characterIds.join(",")}`, () =>
        upstreamJson<{ sessionId: string; messages?: Array<Record<string, unknown>> }>(ctx, "chat", upstreamBody),
      );

      return jsonResponse({
        sessionId: await signer.wrapSession(reply.sessionId, ctx.user.id),
        messages: await Promise.all(
          (reply.messages ?? []).map(async (message) => ({ ...message, lines: await signLines(ctx, message.lines, "chat") })),
        ),
      });
    },

    async history(ctx) {
      const body = await readJson(ctx.request, limits.jsonBytes);
      const sessionId = await signer.unwrapSession(body.sessionId, ctx.user.id);
      if (!sessionId) throw new ProxyError(404, "session_not_found", "That conversation was not found.");
      const before = optionalId(body.before, "before");

      const page = await upstreamJson<Record<string, unknown>>(ctx, "chat/session", {
        sessionId,
        limit: clampInt(body.limit, 1, 100) ?? 20,
        ...(before ? { before } : {}),
      });
      return jsonResponse({ ...page, sessionId: body.sessionId });
    },

    speech: (ctx) => speak(ctx, false),
    speechStream: (ctx) => speak(ctx, true),

    async transcribe(ctx) {
      const type = ctx.request.headers.get("content-type") ?? "";
      if (!/^multipart\/form-data\b/i.test(type)) {
        throw new ProxyError(415, "unsupported_media_type", "Send the audio as multipart/form-data.");
      }
      const bytes = await readBody(ctx.request, limits.audioBytes + 64 * 1024);
      let form: FormData;
      try {
        form = await new Response(bytes, { headers: { "content-type": type } }).formData();
      } catch {
        throw new ProxyError(400, "invalid_form", "The upload could not be read.");
      }

      const characterId = await requireCharacter(ctx.user, form.get("characterId"));
      const audio = form.get("audio");
      if (!audio || typeof audio === "string" || audio.size === 0) {
        throw new ProxyError(422, "invalid_field", "audio must be a recorded file.");
      }
      if (audio.size > limits.audioBytes) {
        throw new ProxyError(413, "payload_too_large", `The recording is larger than ${limits.audioBytes} bytes.`);
      }

      const upstreamForm = new FormData();
      upstreamForm.append("characterId", characterId);
      upstreamForm.append("audio", audio, audioFilename(audio));
      const language = requireText(form.get("language") ?? undefined, "language", 16, false);
      const prompt = requireText(form.get("prompt") ?? undefined, "prompt", 500, false);
      if (language) upstreamForm.append("language", language);
      if (prompt) upstreamForm.append("prompt", prompt);

      const response = await upstream(ctx, "audio/transcribe", { method: "POST", body: upstreamForm });
      const result = (await response.json()) as { response?: string; text?: string };
      return jsonResponse({ response: result.response ?? result.text ?? "" });
    },

    async quiz(ctx) {
      const body = await readJson(ctx.request, limits.jsonBytes);
      let upstreamBody: Record<string, unknown>;
      let lockKey: string;

      if (body.sessionId !== undefined) {
        const sessionId = await signer.unwrapSession(body.sessionId, ctx.user.id);
        if (!sessionId) throw new ProxyError(404, "session_not_found", "That quiz was not found.");
        const say = requireText(body.say, "say", limits.messageChars, false);
        const optionId = optionalId(body.optionId, "optionId");
        const participantId = optionalId(body.participantId, "participantId");
        upstreamBody = {
          sessionId,
          ...(say !== undefined ? { say } : {}),
          ...(optionId ? { optionId } : {}),
          ...(participantId ? { participantId } : {}),
          ...(typeof body.typed === "boolean" ? { typed: body.typed } : {}),
        };
        lockKey = `quiz:${ctx.user.id}:${sessionId}`;
      } else {
        const characterId = await requireCharacter(ctx.user, body.characterId);
        const questionSetId = optionalId(body.questionSetId, "questionSetId");
        if (!questionSetId) throw new ProxyError(422, "missing_ids", "questionSetId is required to start a quiz.");
        const sets = await allowed(options.questionSets, ctx.user);
        if (sets && !sets.has(questionSetId)) {
          throw new ProxyError(403, "question_set_not_allowed", "That question set is not available here.");
        }
        const participants = Array.isArray(body.participants) ? body.participants.slice(0, 10) : undefined;
        if (participants) {
          for (const p of participants as Array<Record<string, unknown>>) {
            optionalId(p?.id, "participants.id");
            requireText(p?.displayName, "participants.displayName", 64, true);
            if (p.type !== undefined && p.type !== "human" && p.type !== "ai") {
              throw new ProxyError(422, "invalid_field", "participants.type must be human or ai.");
            }
          }
        }
        const selectionMode = body.selectionMode === "random" || body.selectionMode === "sequential" ? body.selectionMode : undefined;
        upstreamBody = {
          characterId,
          questionSetId,
          playerId: ctx.user.id,
          ...(participants ? { participants: participants.map((p) => ({ id: p.id, displayName: p.displayName, type: p.type })) } : {}),
          ...(body.questionCount !== undefined ? { questionCount: clampInt(body.questionCount, 1, 100) } : {}),
          ...(selectionMode ? { selectionMode } : {}),
        };
        lockKey = `quiz:${ctx.user.id}:start`;
      }

      try {
        const turn = await lock(lockKey, () => upstreamJson<Record<string, unknown>>(ctx, "quiz", upstreamBody));
        return jsonResponse(await signQuizTurn(ctx, turn));
      } catch (error) {
        // A finished quiz replays its closing turn, which needs the same signing.
        if (error instanceof UpstreamError && error.body.turn && typeof error.body.turn === "object") {
          return errorResponse(error, { turn: await signQuizTurn(ctx, error.body.turn as Record<string, unknown>) });
        }
        throw error;
      }
    },

    async quizSession(ctx) {
      const token = ctx.url.searchParams.get("sessionId");
      const sessionId = await signer.unwrapSession(token, ctx.user.id);
      if (!sessionId) throw new ProxyError(404, "session_not_found", "That quiz was not found.");
      const state = await upstreamJson<Record<string, unknown>>(ctx, `quiz/session?sessionId=${encodeURIComponent(sessionId)}`);
      return jsonResponse(state);
    },

    async usage(ctx) {
      const params = new URLSearchParams({ playerId: ctx.user.id });
      const characterId = ctx.url.searchParams.get("characterId");
      if (characterId) params.set("characterId", await requireCharacter(ctx.user, characterId));
      return jsonResponse(await upstreamJson(ctx, `usage?${params}`));
    },

    async characters(ctx) {
      const list = await allowed(options.characters, ctx.user);
      const result = await upstreamJson<{ characters?: Array<{ id: string }> }>(ctx, "characters");
      return jsonResponse({ characters: (result.characters ?? []).filter((c) => list?.has(c.id)) });
    },

    async questionSets(ctx) {
      const list = await allowed(options.questionSets, ctx.user);
      const result = await upstreamJson<{ questionSets?: Array<{ id: string }> }>(ctx, "question-sets");
      return jsonResponse({ questionSets: (result.questionSets ?? []).filter((s) => !list || list.has(s.id)) });
    },

    async account(ctx) {
      return jsonResponse(await upstreamJson(ctx, "account"));
    },
  };

  async function speak(ctx: Context, stream: boolean): Promise<Response> {
    const body = await readJson(ctx.request, limits.jsonBytes);
    const characterId = await requireCharacter(ctx.user, body.characterId);
    const message = requireText(body.message, "message", limits.speechChars, true)!;
    if (speechRepliesOnly && !(await signer.verifySpeech(body.speechToken, ctx.user.id, message))) {
      throw new ProxyError(403, "speech_not_allowed", "Only lines a character said can be spoken.");
    }
    const emotion = typeof body.emotion === "string" && /^[A-Za-z]{1,20}$/.test(body.emotion) ? body.emotion : undefined;
    const format = body.format === "wav" ? "wav" : "mp3";
    const language = requireText(body.language, "language", 16, false);

    const response = await upstream(ctx, stream ? "audio/stream" : "audio/generate", {
      method: "POST",
      json: true,
      body: JSON.stringify({
        characterId,
        message,
        ...(emotion ? { emotion } : {}),
        ...(!stream ? { format } : {}),
        ...(language ? { language } : {}),
      }),
    });

    const headers: Record<string, string> = { "cache-control": "no-store" };
    if (stream) {
      headers["content-type"] = "audio/wav";
      for (const name of ["x-sample-rate", "x-channels"]) {
        const value = response.headers.get(name);
        if (value) headers[name] = value;
      }
    } else {
      headers["content-type"] = format === "wav" ? "audio/wav" : "audio/mpeg";
    }
    return new Response(response.body, { status: 200, headers });
  }

  // ---------------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------------

  return async function handleNeocortexRequest(request: Request): Promise<Response> {
    let route: ProxyRoute | undefined;
    let userId: string | undefined;
    const cors = corsHeaders(request);

    try {
      if (request.method === "OPTIONS") {
        const headers: Record<string, string> = { ...cors };
        if (cors["access-control-allow-origin"]) {
          headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
          headers["access-control-allow-headers"] = ["content-type", "authorization", ...(options.cors?.allowHeaders ?? [])].join(", ");
          headers["access-control-max-age"] = "600";
        }
        return new Response(null, { status: 204, headers });
      }

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "");
      const sub = path.startsWith(`${basePath}/`) ? path.slice(basePath.length + 1) : null;
      route = sub === null ? undefined : ROUTE_BY_PATH.get(sub);
      if (!route || !routes[route]) throw new ProxyError(404, "not_found", "Not found.");
      if (request.method !== ROUTES[route].method) {
        throw new ProxyError(405, "method_not_allowed", `Use ${ROUTES[route].method}.`, { allow: ROUTES[route].method });
      }

      checkOrigin(request);

      let user: NeocortexUser | null | undefined;
      try {
        user = await options.authorize(request);
      } catch (error) {
        onError(error, { route, status: 401 });
        user = null;
      }
      if (!user || typeof user.id !== "string" || !user.id) {
        throw new ProxyError(401, "unauthorized", "Sign in to talk to characters.");
      }
      userId = user.id;

      if (limiter) {
        const verdict = await limiter.take(user.id);
        if (!verdict.allowed) {
          throw new ProxyError(429, "rate_limited", "Too many requests. Slow down a little.", {
            "retry-after": String(verdict.retryAfter),
          });
        }
      }

      const response = await handlers[route]({ request, url, user, route });
      for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
      return response;
    } catch (error) {
      if (error instanceof ProxyError) {
        return withHeaders(errorResponse(error), cors);
      }
      onError(error, { route, userId, status: 500 });
      return withHeaders(jsonResponse({ error: "Something went wrong.", code: "internal_error" }, 500), cors);
    }
  };
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}
