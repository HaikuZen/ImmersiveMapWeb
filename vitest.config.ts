import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    setupFiles: ["tests/setup/frame-wasm.ts", "tests/setup/layer-wasm.ts"],
  },
});
