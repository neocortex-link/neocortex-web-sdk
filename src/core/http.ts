import { errorFromResponse, isNeocortexError, NeocortexError } from "./errors";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type RequestOptions = {
  signal?: AbortSignal;
  /** Overrides the client's timeout for this one call, in milliseconds. */
  timeoutMs?: number;
};

/**
 * A signal that aborts when any of `signals` does.
 *
 * Conversations hand the same long-lived signal to every request they make, so
 * a plain listener per request would pile up for as long as the conversation
 * lasts. `AbortSignal.any` holds its sources weakly; the listener fallback is
 * only for engines that lack it.
 */
export function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => !!s);
  if (present.length === 1) return present[0]!;
  if (typeof AbortSignal.any === "function") return AbortSignal.any(present);

  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * Sends one request and returns the response once headers have arrived.
 *
 * The timeout covers the wait for the response to start, not the body: a speech
 * stream can legitimately run longer than any sensible timeout. Aborting the
 * caller's signal still stops a body that is mid-stream.
 */
export async function send(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  options: RequestOptions = {},
): Promise<Response> {
  const outer = options.signal;
  if (outer?.aborted) throw abortedError(outer.reason);

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? timeoutMs);

  try {
    const response = await fetchImpl(url, { ...init, signal: anySignal([outer, timeout.signal]) });
    if (!response.ok) throw await errorFromResponse(response);
    return response;
  } catch (error) {
    if (isNeocortexError(error)) throw error;
    if (outer?.aborted) throw abortedError(outer.reason);
    if (timeout.signal.aborted) {
      throw new NeocortexError("The request timed out.", { status: 0, code: "timeout", cause: error });
    }
    throw new NeocortexError("Could not reach Neocortex. Check the network connection.", {
      status: 0,
      code: "network_error",
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

function abortedError(reason: unknown): NeocortexError {
  return new NeocortexError("The request was cancelled.", { status: 0, code: "aborted", cause: reason });
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError(signal.reason));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError(signal!.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}
