import { defineConfig } from "tsup";

export default defineConfig([
  // Every entry in one ESM build with shared chunks, so `NeocortexClient` and
  // `NeocortexError` exist once whichever entry they are imported from.
  {
    entry: {
      index: "src/index.ts",
      "server/index": "src/server/index.ts",
      "client/index": "src/client/index.ts",
      "ui/index": "src/ui/index.ts",
      "ui/auto": "src/ui/auto.ts",
    },
    format: ["esm"],
    dts: true,
    target: "es2022",
    platform: "neutral",
    sourcemap: true,
    splitting: true,
  },
  // CommonJS for servers that still `require`. The browser entries are ESM only.
  {
    entry: { index: "src/index.ts", "server/index": "src/server/index.ts" },
    format: ["cjs"],
    dts: true,
    target: "es2022",
    platform: "neutral",
    sourcemap: true,
    splitting: false,
  },
]);
