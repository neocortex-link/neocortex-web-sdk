import { defineConfig } from "tsup";

export default defineConfig([
  // Runs anywhere, and is the one entry a CommonJS server is likely to require.
  {
    entry: { index: "src/index.ts", "server/index": "src/server/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    target: "es2022",
    platform: "neutral",
    sourcemap: true,
    clean: false,
    splitting: false,
  },
  // Browser-only entries. ESM is the only format a page or bundler needs.
  {
    entry: {
      "client/index": "src/client/index.ts",
      "ui/index": "src/ui/index.ts",
      "ui/auto": "src/ui/auto.ts",
    },
    format: ["esm"],
    dts: true,
    target: "es2022",
    platform: "browser",
    sourcemap: true,
    splitting: true,
  },
]);
