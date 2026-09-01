import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentService } from "../agent-service.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { WorkspaceManager } from "../workspace.js";
import { MemoryInterceptor } from "./interceptor.js";
import { MemoryStore } from "./memory-store.js";
import { createRedactor } from "./redact.js";
import type { MemoryEvent } from "./types.js";
import type { StepEvent } from "./step-trace.js";

const ARK_KEY = "sk-testsecret-0123456789";

/**
 * Emits a scripted Codex `--json` event stream through the runner's trace
 * sink, so the whole path -- runner stdout, collector, store, telemetry
 * endpoint -- is exercised rather than the collector in isolation.
 */
class ScriptedRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];

  constructor(
    private readonly script: (request: RunnerRequest) => {
      lines: unknown[];
      result?: Partial<RunnerResult>;
      throws?: string;
    },
  ) {}

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push({ ...request });
    const plan = this.script(request);
    for (const line of plan.lines) {
      request.onEventLine?.(JSON.stringify(line));
    }
    if (plan.throws) throw new Error(plan.throws);
    return {
      output: "ok",
      threadId: "thread-1",
      usage: { inputTokens: 10, outputTokens: 2 },
      ...plan.result,
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(
  runner: AgentRunner,
  environment: Record<string, string> = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-int-"));
  roots.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: ARK_KEY,
    ARK_MODEL: "ep-test",
    ...environment,
  });
  const memoryStore = new MemoryStore(
    config.memoryRoot,
    createRedactor([config.arkApiKey]),
  );
  const memory = config.memoryEnabled
    ? new MemoryInterceptor(memoryStore, {
        contextLimit: config.memoryContextLimit
          ? Number(config.memoryContextLimit)
          : null,
        triggerPct: config.memoryTriggerPct,
        artifactMountPath: config.memoryArtifactMount,
      })
    : null;
  if (memory) await memory.initialize();
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    memory,
  );
  await service.initialize();
  return { service, config, root };
}

async function runOnce(service: AgentService, prompt: string) {
  const agent = await service.createAgent({ name: "trace-agent" });
  const { run } = await service.sendMessage(agent.id, prompt);
  await expect
    .poll(() => service.getRun(run.id).status)
    .toMatch(/completed|failed|cancelled/);
  return agent;
}

const trace = (payload: Record<string, unknown>) =>
  payload as unknown as {
    enabled: boolean;
    steps: StepEvent[];
    events: MemoryEvent[];
    stats: { turnsRecorded: number; checkpointVersion: number } | null;
  };

describe("Glass Box end to end", () => {
  it("persists the step trace before the Run reports a terminal status", async () => {
    // Ordering guarantee: a client that polls for a terminal status and then
    // fetches the trace must never observe a Run with no steps.
    const runner = new ScriptedRunner(() => ({
      lines: [
        { type: "item.completed", item: { type: "command_execution", command: "ls" } },
        { type: "turn.completed", usage: { input_tokens: 90 } },
      ],
    }));
    const { service } = await makeService(runner);
    const agent = await service.createAgent({ name: "ordering" });
    const { run } = await service.sendMessage(agent.id, "go");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    // No settling delay: read immediately, exactly as the UI does.
    const result = trace(await service.memoryTrace(agent.id));
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.events.some((e) => e.type === "run_traced")).toBe(true);
  });

  it("exposes steps while the Run is still executing", async () => {
    // The regression this pins: the timeline used to be written only after
    // `AgentRunner.run` returned, so `GET /api/agents/:id/memory` reported
    // nothing for the whole of a Run. On a multi-minute task the operator saw
    // a spinner beside an empty Glass Box and concluded the platform had hung.
    let releaseRunner!: () => void;
    const runnerReachedMiddle = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let held!: () => void;
    const runnerHeld = new Promise<void>((resolve) => {
      held = resolve;
    });

    const runner: AgentRunner = {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        request.onEventLine?.(
          JSON.stringify({
            type: "item.completed",
            item: { type: "command_execution", command: "npm install" },
          }),
        );
        // Codex is still working at this point; the Run has not settled.
        releaseRunner();
        await runnerHeld;
        request.onEventLine?.(
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 90 } }),
        );
        return { output: "done", threadId: "thread-1", usage: null };
      },
      async cancel() {
        return false;
      },
      async isAvailable() {
        return true;
      },
    };

    const { service } = await makeService(runner);
    const agent = await service.createAgent({ name: "live" });
    const { run } = await service.sendMessage(agent.id, "install things");
    await runnerReachedMiddle;

    expect(service.getRun(run.id).status).toBe("running");
    await expect
      .poll(async () => trace(await service.memoryTrace(agent.id)).steps.length, {
        timeout: 5_000,
      })
      .toBeGreaterThan(0);
    const midRun = trace(await service.memoryTrace(agent.id));
    expect(midRun.steps[0]?.preview).toContain("npm install");

    held();
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    // The tail still lands, and nothing is written twice.
    const final = trace(await service.memoryTrace(agent.id));
    expect(final.steps.map((step) => step.seq)).toEqual([1, 2]);
    expect(final.events.some((event) => event.type === "run_traced")).toBe(true);
  });

  it("records a correlated step timeline for a successful Run", async () => {
    const runner = new ScriptedRunner(() => ({
      lines: [
        { type: "thread.started", thread_id: "thread-1" },
        {
          type: "item.completed",
          item: { type: "command_execution", id: "s1", command: "npm test" },
        },
        {
          type: "item.completed",
          item: { type: "file_change", id: "s2", path: "src/app.ts" },
        },
        {
          type: "item.completed",
          item: { type: "agent_message", id: "s3", text: "all green" },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 120, cached_input_tokens: 90, output_tokens: 8 },
        },
      ],
    }));
    const { service } = await makeService(runner);
    const agent = await runOnce(service, "run the tests");

    const result = trace(await service.memoryTrace(agent.id));
    expect(result.enabled).toBe(true);
    expect(result.steps.map((step) => step.type)).toEqual([
      "thread.started",
      "command_execution",
      "file_change",
      "agent_message",
      "turn.completed",
    ]);
    // Every step is correlated to the Run that produced it.
    expect(new Set(result.steps.map((step) => step.runId)).size).toBe(1);
    expect(result.steps.every((step) => typeof step.durationMs === "number")).toBe(true);
    expect(result.stats?.turnsRecorded).toBe(1);
  });

  it("identifies the failing step of a failed Run", async () => {
    const runner = new ScriptedRunner(() => ({
      lines: [
        {
          type: "item.completed",
          item: { type: "command_execution", id: "s1", command: "npm ci" },
        },
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            id: "s2",
            command: "npm run migrate",
            exit_code: 1,
          },
        },
      ],
      throws: "Codex exited with code 1",
    }));
    const { service } = await makeService(runner);
    const agent = await runOnce(service, "migrate the database");

    const result = trace(await service.memoryTrace(agent.id));
    const traced = result.events.find((event) => event.type === "run_traced");
    expect(traced).toBeDefined();
    expect(traced?.detail["failingStepIndex"]).toBe(1);
    expect(traced?.detail["failingStepType"]).toBe("command_execution");
    expect(String(traced?.detail["failingStepPreview"])).toContain("npm run migrate");
    // The timeline survives the failure rather than collapsing to one string.
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1]?.status).toBe("error");
  });

  it("keeps secrets out of the persisted step timeline", async () => {
    const runner = new ScriptedRunner(() => ({
      lines: [
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "curl -H 'Authorization: Bearer " + ARK_KEY + "' https://x",
          },
        },
      ],
    }));
    const { service } = await makeService(runner);
    const agent = await runOnce(service, "call the api");

    const result = trace(await service.memoryTrace(agent.id));
    expect(JSON.stringify(result.steps)).not.toContain("testsecret");
  });

  it("compacts and re-seeds the thread through the real runner seam", async () => {
    const runner = new ScriptedRunner((request) => ({
      lines: [],
      result: {
        output: "done",
        threadId: request.threadId ?? "thread-new",
        // First turn reports usage above the trigger (1000 * 0.7 = 700).
        usage: { inputTokens: request.threadId === null ? 900 : 40 },
      },
    }));
    const { service } = await makeService(runner, {
      MEMORY_CONTEXT_LIMIT: "1000",
    });

    const agent = await service.createAgent({ name: "compacting" });
    const first = await service.sendMessage(
      agent.id,
      "Ship the release and keep ORDER-4471-ZULU intact",
    );
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");

    const second = await service.sendMessage(agent.id, "continue please");
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");

    // Second call to the runner must be a fresh thread carrying the preamble.
    const sent = runner.requests[1];
    expect(sent?.threadId).toBeNull();
    expect(sent?.prompt).toContain("Restored session context");
    expect(sent?.prompt).toContain("ORDER-4471-ZULU");
    // The user's own message is still last.
    expect(sent?.prompt.endsWith("continue please")).toBe(true);

    const result = trace(await service.memoryTrace(agent.id));
    expect(result.stats?.checkpointVersion).toBe(1);
    expect(result.events.some((event) => event.type === "compaction_epoch")).toBe(true);
  });

  it("runs unchanged when the middleware is disabled", async () => {
    const runner = new ScriptedRunner(() => ({ lines: [] }));
    const { service } = await makeService(runner, { MEMORY_ENABLED: "false" });
    const agent = await runOnce(service, "hello");

    const result = trace(await service.memoryTrace(agent.id));
    expect(result.enabled).toBe(false);
    expect(result.steps).toEqual([]);
    // The prompt reaches the runner untouched.
    expect(runner.requests[0]?.prompt).toBe("hello");
    expect(runner.requests[0]?.onEventLine).toBeUndefined();
  });

  it("does not fail a Run when the middleware throws", async () => {
    const runner = new ScriptedRunner(() => ({ lines: [] }));
    const { service } = await makeService(runner);
    const agent = await service.createAgent({ name: "resilient" });
    // Force every memory operation to reject.
    const memory = (service as unknown as { memory: MemoryInterceptor }).memory;
    memory.prepareTurn = async () => {
      throw new Error("memory is down");
    };
    memory.recordTurn = async () => {
      throw new Error("memory is down");
    };

    const { run } = await service.sendMessage(agent.id, "still works");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(runner.requests[0]?.prompt).toBe("still works");
  });
});
