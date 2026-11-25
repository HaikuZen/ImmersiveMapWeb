import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { defineConfig } from "@playwright/test";

// The machine routes HTTP through a proxy, and the dev server is local.
process.env.NO_PROXY = [process.env.NO_PROXY, "localhost", "127.0.0.1", "::1"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

// The system Chrome or Chromium, which has WebGPU: the one CHROME names,
// else Chrome's usual place on macOS, else the first of Google Chrome and
// Chromium in /usr/bin on Linux. On Linux WebGPU runs through Vulkan, and
// Chrome's GPU blocklist is ignored, so an older GPU it lists runs the tests.
const chrome = process.env.CHROME ||
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync));
const platformArgs = process.platform === "linux" ? ["--enable-features=Vulkan", "--ignore-gpu-blocklist"] : [];

/** A port no server listens on now, as the system hands one out. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

// The e2e app's own server on a free port, picked once: the test workers load
// this file again and read the port from the environment they inherit, so the
// server and every test agree on it. No server already running is reused, so
// the tests never land in another project's dev server.
process.env.E2E_PORT ??= String(await freePort());
const base = `http://localhost:${process.env.E2E_PORT}`;

// The e2e tests in the system Chrome (WebGPU), against the e2e app's dev
// server, reading the local fixture archive: no test touches the network.
export default defineConfig({
  testDir: "tests/e2e",
  // What a failed test leaves (screenshots, traces), beside the tests and git-ignored.
  outputDir: "tests/e2e/results",
  timeout: 60_000,
  use: {
    baseURL: base,
    launchOptions: {
      executablePath: chrome,
      args: ["--enable-gpu", "--enable-unsafe-webgpu", ...platformArgs],
    },
    viewport: { width: 1280, height: 800 },
  },
  webServer: { command: `npm run dev -w e2e-app -- --port ${process.env.E2E_PORT} --strictPort`, url: base, reuseExistingServer: false },
});
