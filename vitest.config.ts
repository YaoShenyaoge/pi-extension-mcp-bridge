import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The end-to-end tests spawn a real stdio MCP server.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
