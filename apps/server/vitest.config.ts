import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The suite boots a real Fastify instance and exercises real filesystem
    // writes. On a WSL2 /mnt/c checkout (drvfs) module resolution alone can
    // take ~10s, which exceeds vitest's 5s default and produces a timeout
    // that has nothing to do with the code under test.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
