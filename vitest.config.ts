import { configDefaults, defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "test/live.*.test.ts"],
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
