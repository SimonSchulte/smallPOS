import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(root, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Nur für Tests: eigene Dummy-Werte, nicht die echten Secrets.
          bindings: {
            TEST_MIGRATIONS: migrations,
            KASSE_PIN: "0000",
            SESSION_SECRET: "test-only-session-secret-0123456789abcdef",
          },
        },
      };
    }),
  ],
  test: {
    include: ["test/**/*.test.js"],
    setupFiles: ["./test/apply-migrations.js"],
  },
});
