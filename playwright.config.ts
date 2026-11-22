import { defineConfig } from "@playwright/test";

// The machine routes HTTP through a proxy, and the dev server is local.
process.env.NO_PROXY = [process.env.NO_PROXY, "localhost", "127.0.0.1", "::1"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

// Smoke tests in the system Chrome (WebGPU), against the playground's dev
// server, reading the local fixture archive: no test touches the network.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:5173",
    launchOptions: {
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      args: ["--enable-gpu", "--enable-unsafe-webgpu"],
    },
    viewport: { width: 1280, height: 800 },
  },
  webServer: { command: "npm run dev -w playground", url: "http://localhost:5173", reuseExistingServer: true },
});
