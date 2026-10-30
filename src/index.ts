export {
  NeocortexClient,
  DEFAULT_API_URL,
  DEFAULT_PROXY_PATH,
  audioFilename,
  type NeocortexClientOptions,
  type AudioStream,
} from "./core/client";
export { NeocortexError, isNeocortexError } from "./core/errors";
export { EMOTIONS, toEmotion, toAudioEmotion, type Emotion } from "./core/emotions";
export type { RequestOptions, FetchLike } from "./core/http";
export { encodeWav, readWavHeader, PcmStreamDecoder, type PcmChunk } from "./core/wav";
export type * from "./core/types";

export const VERSION = "0.1.0";
