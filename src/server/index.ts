export {
  createNeocortexHandler,
  type NeocortexHandlerOptions,
  type NeocortexUser,
  type ProxyLimits,
  type ProxyRoute,
  type TextFilterContext,
} from "./handler";
export { toNodeHandler } from "./adapters/node";
export { MemoryRateLimiter, type RateLimiter, type RateLimitOptions, type RateLimitResult } from "./rateLimit";

// For backends that call Neocortex directly with their key.
export { NeocortexClient, NeocortexClient as NeocortexServerClient, type NeocortexClientOptions } from "../core/client";
export { NeocortexError } from "../core/errors";
export type * from "../core/types";
