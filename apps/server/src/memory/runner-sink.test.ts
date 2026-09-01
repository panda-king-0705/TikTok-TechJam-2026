import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CodexRunner } from "../codex-runner.js";
import { loadConfig } from "../config.js";
import { StepTraceCollector } from "./step-trace.js";
import { nullRedactor } from "./redact.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * Stands in for the `codex` binary: ignores its arguments and writes a
 * scripted `--json` event stream to stdout. This exercises the real
 * CodexRunner -- spawn, chunked stdout, line splitting, trailing flush --
 * rather than a fake runner, so the trace sink is verified on the actual
 * code path a Run takes.
 */
const FAKE_CODEX = [
  "#!/bin/sh",
  `echo '{"type":"thread.started","thread_id":"t-real"}'`,
  `echo '{"type":"item.completed","item":{"type":"command_execution","command":"ls -la"}}'`,
  `echo '{"type":"item.completed","item":{"type":"agent_message","text":"all done"}}'`,
  // No trailing newline on the last line: exercises the trailing flush path.
  `printf '%s' '{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":10,"output_tokens":5}}'`,
  "",
].join("\n");

describe("runner trace sink (real CodexRunner)", () => {
  it("streams every Codex event line to the middleware sink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "runner-sink-"));
    roots.push(root);
    const binary = path.join(root, "fake-codex.sh");
    await writeFile(binary, FAKE_CODEX, "utf8");
    await chmod(binary, 0o755);

    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      CODEX_HOME: path.join(root, "codex"),
      CODEX_BIN: binary,
      ARK_API_KEY: "test-key-123456",
      ARK_MODEL: "ep-test",
    });

    const collector = new StepTraceCollector("agent-1", "run-1", nullRedactor);
    const result = await new CodexRunner(config).run({
      agentId: "agent-1",
      workspacePath: root,
      prompt: "do the thing",
      threadId: null,
      onEventLine: (line) => collector.ingestLine(line),
    });

    expect(result.output).toBe("all done");
    expect(result.threadId).toBe("t-real");
    expect(result.usage).toEqual({
      inputTokens: 50,
      cachedInputTokens: 10,
      outputTokens: 5,
    });

    const summary = collector.summary();
    expect(summary.steps.map((step) => step.type)).toEqual([
      "thread.started",
      "command_execution",
      "agent_message",
      "turn.completed",
    ]);
    expect(summary.threadId).toBe("t-real");
    expect(summary.failingStepIndex).toBeNull();
  });

  it("leaves the runner unaffected when no sink is supplied", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "runner-nosink-"));
    roots.push(root);
    const binary = path.join(root, "fake-codex.sh");
    await writeFile(binary, FAKE_CODEX, "utf8");
    await chmod(binary, 0o755);

    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      CODEX_HOME: path.join(root, "codex"),
      CODEX_BIN: binary,
      ARK_API_KEY: "test-key-123456",
      ARK_MODEL: "ep-test",
    });

    const result = await new CodexRunner(config).run({
      agentId: "agent-1",
      workspacePath: root,
      prompt: "do the thing",
      threadId: null,
    });
    expect(result.output).toBe("all done");
  });
});
