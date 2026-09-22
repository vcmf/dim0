import path from "path"
import { defineConfig } from "vitest/config"


export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "mini-app-runtime/**/*.{test,spec}.{ts,tsx}",
    ],
    coverage: {
      // v8 provider (matches @vitest/coverage-v8). lcov feeds Codecov;
      // text prints a summary in the CI log.
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**", "mini-app-runtime/**"],
      exclude: [
        "**/*.{test,spec}.{ts,tsx}",
        "src/test/**",
        "**/*.d.ts",
      ],
    },
  },
})
