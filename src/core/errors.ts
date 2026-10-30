import type { ApiErrorBody, QuizTurnResponse } from "./types";

/**
 * Every failure the SDK reports, whether the server refused a request, the
 * network dropped, or a timeout fired.
 *
 * `status` is the HTTP status, or 0 when no response arrived at all. `code` is the
 * server's machine-readable reason when it gave one (`insufficient_credits`,
 * `quiz_finished`, ...), and is what callers should branch on.
 */
export class NeocortexError extends Error {
  override readonly name = "NeocortexError";
  readonly status: number;
  readonly code?: string;
  /** Seconds to wait before retrying, when the server said so. */
  readonly retryAfter?: number;
  /** For `quiz_finished`: the closing turn the quiz already played. */
  readonly turn?: QuizTurnResponse;

  constructor(
    message: string,
    init: { status: number; code?: string; retryAfter?: number; turn?: QuizTurnResponse; cause?: unknown },
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.status = init.status;
    this.code = init.code;
    this.retryAfter = init.retryAfter;
    this.turn = init.turn;
  }

  /** True when the team has run out of credits, so retrying will not help. */
  get isOutOfCredits(): boolean {
    return this.code === "insufficient_credits" || (this.status === 400 && /credit/i.test(this.message));
  }

  /** True when the request was cancelled through its `AbortSignal`. */
  get isAborted(): boolean {
    return this.code === "aborted";
  }
}

/** Builds the error for a refused response, reading its JSON body when there is one. */
export async function errorFromResponse(response: Response): Promise<NeocortexError> {
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  let body: Partial<ApiErrorBody> = {};
  try {
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text) as ApiErrorBody;
      } catch {
        // An HTML error page from a proxy or the platform says nothing useful.
        body = /^\s*</.test(text) ? {} : { error: text.length > 200 ? `${text.slice(0, 200)}…` : text };
      }
    }
  } catch {
    // The body was unreadable; the status alone has to do.
  }

  return new NeocortexError(body.error || `Request failed (${response.status})`, {
    status: response.status,
    code: body.code,
    retryAfter,
    turn: body.turn,
  });
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}
