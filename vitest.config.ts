import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // UI and browser-client tests opt in with `// @vitest-environment happy-dom`.
  },
});
