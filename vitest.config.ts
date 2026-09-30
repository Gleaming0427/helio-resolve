import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
    include: ["packages/**/tests/**/*.test.ts", "apps/**/tests/**/*.test.ts", "infra/**/tests/**/*.test.ts"],
  },
});
