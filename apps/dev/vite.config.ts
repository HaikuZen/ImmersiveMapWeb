import { resolve } from "node:path";
import { defaultClientConditions, defineConfig } from "vite";

const root = resolve(import.meta.dirname, "../..");

// The dev page of what is being worked on now. The library's TypeScript
// source, not its built dist: the package exports it under this condition
// for its own repository, so an edit of the library reloads the page.
export default defineConfig({
  resolve: { conditions: ["immersive-map-source", ...defaultClientConditions] },
  worker: { format: "es" },
  server: { port: 5180, strictPort: true, fs: { allow: [root] } },
});
