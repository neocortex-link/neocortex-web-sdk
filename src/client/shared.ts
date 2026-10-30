import { NeocortexClient } from "../core/client";
import { NeocortexError } from "../core/errors";

export type ClientSource = {
  /** A configured client. Takes precedence over `endpoint`. */
  client?: NeocortexClient;
  /** Your proxy route, e.g. `/api/neocortex`. Used when no `client` is given. */
  endpoint?: string;
};

export function resolveClient(source: ClientSource): NeocortexClient {
  return source.client ?? new NeocortexClient({ baseUrl: source.endpoint });
}

export function toNeocortexError(error: unknown): NeocortexError {
  if (error instanceof NeocortexError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new NeocortexError(message || "Something went wrong.", { status: 0, code: "client_error", cause: error });
}
