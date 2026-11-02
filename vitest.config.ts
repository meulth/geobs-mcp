import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    // The HTTP documentation tests must serve the real local stylesheet.
    css: { include: [/swagger-ui-dist/] },
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
