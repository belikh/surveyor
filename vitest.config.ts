import { configDefaults, defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "test/live.*.test.ts"],
  },
  resolve: {
    alias: {
      // Node has no workerd module registry: point the runtime-only import
      // at a local stub so the Worker entry stays importable under vitest.
      "cloudflare:workers": fileURLToPath(
        new URL("./test/helpers/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
  plugins: [
    {
      name: "sql-as-text",
      enforce: "pre",
      load(id) {
        if (id.endsWith(".sql") || id.endsWith(".txt")) {
          return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
        }
      },
    },
  ],
});
