import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["immersive-map-source"] },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    setupFiles: ["tests/vitest-setup/frame-wasm.ts", "tests/vitest-setup/layer-wasm.ts"],
  },
});
