import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultClientConditions, defineConfig, type Connect, type Plugin } from "vite";

const root = resolve(import.meta.dirname, "../..");

/** Serves the repository's fixtures/ (git-ignored real tiles) at /fixtures, for the benchmarks and the smoke tests. */
function fixtures(): Plugin {
  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    const url = request.url ?? "";
    if (!url.startsWith("/fixtures/")) return next();
    const file = join(root, decodeURIComponent(url.split("?")[0]!));
    if (!file.startsWith(join(root, "fixtures")) || !existsSync(file) || !statSync(file).isFile()) {
      response.statusCode = 404;
      response.end();
      return;
    }
    const size = statSync(file).size;
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Accept-Ranges", "bytes");
    // Range requests, as a static host serves them: the map reads its archive by ranges.
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      response.statusCode = 206;
      response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      response.setHeader("Content-Length", String(end - start + 1));
      createReadStream(file, { start, end }).pipe(response);
      return;
    }
    response.setHeader("Content-Length", String(size));
    createReadStream(file).pipe(response);
  };
  return {
    name: "fixtures",
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  };
}

/** Dev only: `POST /__trace` saves the playground's `trace=1` record to fixtures/trace.json (git-ignored). */
function traceSink(): Plugin {
  return {
    name: "trace-sink",
    configureServer: (server) =>
      void server.middlewares.use((request, response, next) => {
        if (request.url !== "/__trace" || request.method !== "POST") return next();
        mkdirSync(join(root, "fixtures"), { recursive: true });
        const file = createWriteStream(join(root, "fixtures/trace.json"));
        request.pipe(file);
        request.on("end", () => {
          response.statusCode = 204;
          response.end();
        });
      }),
  };
}

/** Dev only: `POST /__log` appends the playground's `remotelog=1` records to fixtures/remote-log.jsonl (git-ignored). */
function remoteLogSink(): Plugin {
  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    if (request.url !== "/__log" || request.method !== "POST") return next();
    mkdirSync(join(root, "fixtures"), { recursive: true });
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      appendFileSync(join(root, "fixtures/remote-log.jsonl"), `${Buffer.concat(chunks).toString("utf8").replace(/\n/g, " ")}\n`);
      response.statusCode = 204;
      response.end();
    });
  };
  // The preview server too: a phone loads a built page far faster through a tunnel than the dev server's modules.
  return {
    name: "remote-log-sink",
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  };
}

// Cross-origin isolation gives performance.now() microsecond resolution for
// the measurements. The library itself does not need it.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

const pages = ["index", "bench", "bench-prep", "bench-inflate", "bench-transfer", "bench-storage", "bench-atlas", "bench-encode", "bench-planner", "bench-labels", "bench-pins", "bench-lines", "bench-layer-lines", "bench-terrain", "bench-geojson", "bench-threads", "bench-offscreen", "bench-precision", "bench-antialias", "bench-occlusion", "bench-export", "bench-models", "bench-tile-grid"];

export default defineConfig({
  plugins: [fixtures(), traceSink(), remoteLogSink()],
  build: {
    target: "esnext",
    rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])) },
  },
  // The library's TypeScript source, not its built dist: the package exports
  // it under this condition for its own repository.
  resolve: { conditions: ["immersive-map-source", ...defaultClientConditions] },
  worker: { format: "es" },
  server: { port: 5173, headers: isolation, fs: { allow: [root] } },
  preview: { port: 4173, headers: isolation },
});
