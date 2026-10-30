import { NeocortexError, errorFromResponse } from "./errors";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type RequestOptions = {
  signal?: AbortSignal;
  /** Overrides the client's timeout for this one call, in milliseconds. */
  timeoutMs?: number;
};

/**
 * Sends one request and returns the response once headers have arrived.
 *
 * The timeout covers the wait for the response to start, not the body: a speech
 * stream can legitimately run longer than any sensible timeout.
 */
export async function send(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  options: RequestOptions = {},
): Promise<Response> {
  const controller = new AbortController();
  const outer = options.signal;
  let timedOut = false;

  if (outer?.aborted) throw abortedError(outer.reason);
  const onAbort = () => controller.abort(outer?.reason);
  outer?.addEventListener("abort", onAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? timeoutMs);

  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) throw await errorFromResponse(response);
    // The listener stays attached on success: the body may still be streaming,
    // and aborting the caller's signal should stop it too.
    return response;
  } catch (error) {
    outer?.removeEventListener("abort", onAbort);
    if (error instanceof NeocortexError) throw error;
    if (timedOut) {
      throw new NeocortexError("The request timed out.", { status: 0, code: "timeout", cause: error });
    }
    if (outer?.aborted) throw abortedError(outer.reason);
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
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortedError(signal.reason));
      },
      { once: true },
    );
  });
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}
