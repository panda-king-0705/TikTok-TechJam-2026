import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildCheckpoint, renderPreamble } from "./compactor.js";
import { compactionTrigger, resolveContextLimit } from "./context-limit.js";
import { MemoryInterceptor } from "./interceptor.js";
import { MemoryStore, UnsafeAgentIdError } from "./memory-store.js";
import { createRedactor, nullRedactor } from "./redact.js";
import { StepTraceCollector } from "./step-trace.js";
import type { ResidueDelta } from "./types.js";

const AGENT = "11111111-2222-3333-4444-555555555555";
const MOUNT = "/workspace/.memory/artifacts";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "memory-test-"));
  roots.push(root);
  return root;
}

/** Deterministic clock so duration assertions are stable. */
function clock(startMs = 1_700_000_000_000, stepMs = 1_000) {
  let current = startMs;
  return () => {
    const at = new Date(current);
    current += stepMs;
    return at;
  };
}

async function harness(
  contextLimit: number | null,
  options: { artifactMountPath?: string | null } = {},
) {
  const root = await makeRoot();
  const store = new MemoryStore(root, createRedactor([]));
  const interceptor = new MemoryInterceptor(store, {
    contextLimit,
    artifactMountPath: options.artifactMountPath ?? MOUNT,
    now: clock(),
  });
  await interceptor.initialize();
  return { root, store, interceptor };
}

const delta = (turnNumber: number, over: Partial<ResidueDelta> = {}): ResidueDelta => ({
  turnNumber,
  runId: "run-" + turnNumber,
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:05.000Z",
  durationMs: 5_000,
  userPrompt: "prompt " + turnNumber,
  assistantOutput: "output " + turnNumber,
  status: "completed",
  usage: null,
  ...over,
});

afterEach(() => {
  roots.length = 0;
});

describe("redaction", () => {
  it("removes the configured literal secret anywhere it appears", () => {
    const redactor = createRedactor(["sk-live-abcdef1234567890"]);
    const output = redactor.redact("calling with sk-live-abcdef1234567890 now");
    expect(output).not.toContain("abcdef1234567890");
    expect(output).toContain("[REDACTED]");
  });

  it("removes credential shapes from machine content but keeps context", () => {
    const redactor = createRedactor([]);
    const output = redactor.redactMachine('ARK_API_KEY="pa55word-not-for-you"');
    expect(output).toContain("ARK_API_KEY");
    expect(output).not.toContain("pa55word-not-for-you");
  });

  // Regression: a live smoke test caught the heuristic tier destroying a task
  // objective. "token: <value>" is ordinary prose, not a credential shape.
  it("leaves user prose intact even when it says 'token'", () => {
    const redactor = createRedactor([]);
    const prose = "Remember this token: ORDER-4471-ZULU. Acknowledge it.";
    expect(redactor.redact(prose)).toBe(prose);
  });

  it("still removes a real provider key from user prose", () => {
    const redactor = createRedactor([]);
    expect(redactor.redact("use sk-proj-abcdefghijklmnop1234 now")).not.toContain(
      "abcdefghijklmnop",
    );
  });

  it("ignores literals too short to be secrets", () => {
    expect(createRedactor(["abc"]).redact("abc def")).toBe("abc def");
  });
});

describe("context limit resolution", () => {
  it("prefers an explicit override", () => {
    expect(resolveContextLimit("anything", "64000")).toEqual({
      modelName: "anything",
      limit: 64_000,
      source: "env",
    });
  });

  it("fails closed for an unknown model instead of guessing", () => {
    const resolved = resolveContextLimit("ep-20260101-opaque-endpoint");
    expect(resolved.limit).toBeNull();
    expect(resolved.source).toBe("unknown");
  });

  it("leaves headroom for the one-turn measurement lag", () => {
    expect(compactionTrigger(100_000)).toBe(70_000);
  });
});

describe("compactor", () => {
  it("carries the objective verbatim rather than paraphrasing it", () => {
    const objective = "Migrate the billing schema and keep ORDER-4471-ZULU intact";
    const result = buildCheckpoint({
      agentId: AGENT,
      previous: null,
      residue: [delta(1, { userPrompt: objective }), delta(2)],
      triggerInputTokens: 900,
      artifactMountPath: MOUNT,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(result.checkpoint.objective).toBe(objective);
    expect(result.checkpoint.compactedThroughTurn).toBe(2);
    expect(result.checkpoint.version).toBe(1);
    expect(result.checkpoint.transcriptArtifact).toBe(MOUNT + "/transcript_v1.md");
  });

  it("advances the watermark across epochs without re-folding old turns", () => {
    const first = buildCheckpoint({
      agentId: AGENT,
      previous: null,
      residue: [delta(1), delta(2)],
      triggerInputTokens: 900,
      artifactMountPath: MOUNT,
      now: new Date(),
    });
    const second = buildCheckpoint({
      agentId: AGENT,
      previous: first.checkpoint,
      residue: [delta(3), delta(4)],
      triggerInputTokens: 900,
      artifactMountPath: MOUNT,
      now: new Date(),
    });
    expect(second.checkpoint.version).toBe(2);
    expect(second.checkpoint.compactedThroughTurn).toBe(4);
    expect(second.checkpoint.sourceTurnCount).toBe(4);
    // Progress accumulates once per turn, never duplicated per epoch.
    expect(second.checkpoint.progress.filter((line) => line.includes("Turn 1:"))).toHaveLength(1);
  });

  it("bounds the progress log and the rendered preamble", () => {
    const residue = Array.from({ length: 200 }, (_unused, index) => delta(index + 1));
    const result = buildCheckpoint({
      agentId: AGENT,
      previous: null,
      residue,
      triggerInputTokens: 900,
      artifactMountPath: MOUNT,
      now: new Date(),
    });
    expect(result.checkpoint.progress.length).toBeLessThanOrEqual(41);
    expect(renderPreamble(result.checkpoint, null).length).toBeLessThanOrEqual(12_200);
  });

  it("writes every compacted turn into the transcript verbatim", () => {
    const result = buildCheckpoint({
      agentId: AGENT,
      previous: null,
      residue: [delta(1, { userPrompt: "keep ORDER-4471-ZULU" }), delta(2)],
      triggerInputTokens: 900,
      artifactMountPath: MOUNT,
      now: new Date(),
    });
    expect(result.transcript).toContain("ORDER-4471-ZULU");
    expect(result.transcript).toContain("## Turn 2");
  });
});

describe("interceptor: normal turns", () => {
  it("passes the first turn through untouched", async () => {
    const { interceptor } = await harness(100_000);
    const plan = await interceptor.prepareTurn({
      agentId: AGENT,
      runId: "run-1",
      prompt: "hello",
      threadId: null,
    });
    expect(plan.turnNumber).toBe(1);
    expect(plan.prompt).toBe("hello");
    expect(plan.reseeded).toBe(false);
    expect(plan.reason).toBe("normal");
  });

  it("preserves the caller's threadId when nothing is pending", async () => {
    const { interceptor } = await harness(100_000);
    await interceptor.prepareTurn({ agentId: AGENT, runId: "r1", prompt: "a", threadId: null });
    await interceptor.recordTurn({
      agentId: AGENT,
      runId: "r1",
      turnNumber: 1,
      userPrompt: "a",
      assistantOutput: "b",
      status: "completed",
      usage: { inputTokens: 10 },
      durationMs: 5,
    });
    const plan = await interceptor.prepareTurn({
      agentId: AGENT,
      runId: "r2",
      prompt: "c",
      threadId: "thread-1",
    });
    expect(plan.threadId).toBe("thread-1");
    expect(plan.prompt).toBe("c");
  });

  it("never enables compaction when the context limit is unknown", async () => {
    const { interceptor } = await harness(null);
    await interceptor.prepareTurn({ agentId: AGENT, runId: "r1", prompt: "a", threadId: null });
    await interceptor.recordTurn({
      agentId: AGENT,
      runId: "r1",
      turnNumber: 1,
      userPrompt: "a",
      assistantOutput: "b",
      status: "completed",
      usage: { inputTokens: 5_000_000 },
      durationMs: 5,
    });
    const plan = await interceptor.prepareTurn({
      agentId: AGENT,
      runId: "r2",
      prompt: "c",
      threadId: "t",
    });
    expect(plan.reseeded).toBe(false);
    const events = await interceptor.events(AGENT);
    expect(events.some((event) => event.type === "compaction_disabled")).toBe(true);
  });
});

describe("interceptor: compaction", () => {
  async function runToCompaction() {
    const context = await harness(1_000);
    const { interceptor } = context;
    await interceptor.prepareTurn({
      agentId: AGENT,
      runId: "r1",
      prompt: "Ship the release and keep ORDER-4471-ZULU intact",
      threadId: null,
    });
    await interceptor.recordTurn({
      agentId: AGENT,
      runId: "r1",
      turnNumber: 1,
      userPrompt: "Ship the release and keep ORDER-4471-ZULU intact",
      assistantOutput: "acknowledged",
      status: "completed",
      usage: { inputTokens: 800, cachedInputTokens: 400 },
      durationMs: 10,
    });
    const plan = await interceptor.prepareTurn({
      agentId: AGENT,
      runId: "r2",
      prompt: "continue please",
      threadId: "thread-1",
    });
    return { ...context, plan };
  }

  it("re-seeds the thread and injects a preamble carrying real content", async () => {
    const { plan } = await runToCompaction();
    expect(plan.reason).toBe("compaction");
    expect(plan.reseeded).toBe(true);
    expect(plan.threadId).toBeNull();
    expect(plan.checkpointVersion).toBe(1);
    expect(plan.preamble).toContain("ORDER-4471-ZULU");
  });

  it("keeps the user's message on the compaction turn", async () => {
    const { plan } = await runToCompaction();
    // The v1/v2 reference implementations dropped this, leaving the model with
    // a summary and no request.
    expect(plan.prompt.endsWith("continue please")).toBe(true);
  });

  it("writes the checkpoint, versioned copy, and transcript artifact", async () => {
    const { root } = await runToCompaction();
    const entries = await readdir(path.join(root, AGENT));
    expect(entries).toContain("checkpoint.json");
    expect(entries).toContain("checkpoint_v1.json");
    const transcript = await readFile(
      path.join(root, AGENT, "artifacts", "transcript_v1.md"),
      "utf8",
    );
    expect(transcript).toContain("ORDER-4471-ZULU");
  });

  it("supports exact recall after compaction via the artifact pointer", async () => {
    const { root, plan } = await runToCompaction();
    // The preamble must point at a path the agent can actually read, i.e. the
    // in-container mount path, not a host path.
    expect(plan.preamble).toContain(MOUNT + "/transcript_v1.md");
    const hostCopy = await readFile(
      path.join(root, AGENT, "artifacts", "transcript_v1.md"),
      "utf8",
    );
    expect(hostCopy).toContain("ORDER-4471-ZULU");
  });

  it("flushes residue and does not compact again on the next turn", async () => {
    const { interceptor, store } = await runToCompaction();
    expect(await store.readResidue(AGENT)).toHaveLength(0);
    await interceptor.recordTurn({
      agentId: AGENT,
      runId: "r2",
      turnNumber: 2,
      userPrompt: "continue please",
      assistantOutput: "done",
      status: "completed",
      usage: { inputTokens: 120 },
      durationMs: 10,
    });
    const next = await interceptor.prepareTurn({
      agentId: AGENT,
      runId: "r3",
      prompt: "next",
      threadId: "thread-2",
    });
    // Regression guard: v1/v2 compared raw history to the threshold with no
    // watermark, so every subsequent turn re-compacted forever.
    expect(next.reason).toBe("normal");
    expect(next.reseeded).toBe(false);
    expect(next.checkpointVersion).toBe(1);
  });

  it("emits a compaction_epoch event with measured numbers", async () => {
    const { interceptor } = await runToCompaction();
    const events = await interceptor.events(AGENT);
    const epoch = events.find((event) => event.type === "compaction_epoch");
    expect(epoch).toBeDefined();
    expect(epoch?.detail["checkpointVersion"]).toBe(1);
    expect(epoch?.detail["triggerInputTokens"]).toBe(800);
  });

  it("reports the measured cache hit rate instead of asserting one", async () => {
    const { interceptor } = await runToCompaction();
    const events = await interceptor.events(AGENT);
    const completed = events.find((event) => event.type === "turn_completed");
    expect(completed?.detail["cacheHitPct"]).toBe(50);
  });
});

describe("interceptor: hardening found by live smoke test", () => {
  it("preserves an objective that contains the word 'token'", async () => {
    const root = await makeRoot();
    const store = new MemoryStore(root, createRedactor(["sk-live-abcdef1234567890"]));
    const interceptor = new MemoryInterceptor(store, {
      contextLimit: 1_000,
      artifactMountPath: MOUNT,
      now: clock(),
    });
    await interceptor.initialize();
    const objective = "Remember this token: ORDER-4471-ZULU. Acknowledge it.";
    await interceptor.prepareTurn({ agentId: AGENT, runId: "r1", prompt: objective, threadId: null });
    await interceptor.recordTurn({
      agentId: AGENT, runId: "r1", turnNumber: 1,
      userPrompt: objective, assistantOutput: "ok",
      status: "completed", usage: { inputTokens: 800 }, durationMs: 5,
    });
    const plan = await interceptor.prepareTurn({
      agentId: AGENT, runId: "r2", prompt: "what was it?", threadId: "t1",
    });
    expect(plan.preamble).toContain("ORDER-4471-ZULU");
    // And the persisted copy must match the injected one, or a restart
    // would rehydrate a different objective than the live run used.
    const persisted = await store.readCheckpoint(AGENT);
    expect(persisted?.objective).toContain("ORDER-4471-ZULU");
  });

  it("stops compacting when the runtime floor sits above the trigger", async () => {
    // Mirrors the live finding: Codex's own prompt overhead (~11.7k) exceeded
    // a 11.2k trigger, so every re-seed landed straight back over the line.
    const root = await makeRoot();
    const store = new MemoryStore(root, createRedactor([]));
    const interceptor = new MemoryInterceptor(store, {
      contextLimit: 16_000, // trigger = 11_200
      artifactMountPath: MOUNT,
      now: clock(),
    });
    await interceptor.initialize();

    const turn = async (runId: string, threadId: string | null, inputTokens: number) => {
      const plan = await interceptor.prepareTurn({ agentId: AGENT, runId, prompt: "go", threadId });
      await interceptor.recordTurn({
        agentId: AGENT, runId, turnNumber: plan.turnNumber,
        userPrompt: "go", assistantOutput: "done",
        status: "completed", usage: { inputTokens }, durationMs: 5,
      });
      return plan;
    };

    await turn("r1", null, 11_765);          // over trigger -> arms
    const compacted = await turn("r2", "t1", 12_059); // re-seed, still over
    expect(compacted.reason).toBe("compaction");

    const next = await turn("r3", "t2", 12_100);
    // Without the guard this would compact forever.
    expect(next.reason).not.toBe("compaction");

    const stats = await interceptor.stats(AGENT);
    expect(stats.compactionIneffective).toBe(true);
    expect(stats.floorInputTokens).toBe(12_059);
    expect(stats.compactionCount).toBe(1);

    const events = await interceptor.events(AGENT);
    expect(events.filter((e) => e.type === "compaction_epoch")).toHaveLength(1);
    expect(events.some((e) => e.type === "compaction_ineffective")).toBe(true);
  });

  it("keeps compacting normally when the floor is well below the trigger", async () => {
    const { interceptor } = await harness(1_000); // trigger = 700
    const turn = async (runId: string, threadId: string | null, inputTokens: number) => {
      const plan = await interceptor.prepareTurn({ agentId: AGENT, runId, prompt: "go", threadId });
      await interceptor.recordTurn({
        agentId: AGENT, runId, turnNumber: plan.turnNumber,
        userPrompt: "go", assistantOutput: "done",
        status: "completed", usage: { inputTokens }, durationMs: 5,
      });
      return plan;
    };
    await turn("r1", null, 800);
    expect((await turn("r2", "t1", 50)).reason).toBe("compaction"); // floor = 50
    await turn("r3", "t2", 900);
    const again = await interceptor.prepareTurn({
      agentId: AGENT, runId: "r4", prompt: "go", threadId: "t2",
    });
    expect(again.reason).toBe("compaction");
    expect((await interceptor.stats(AGENT)).compactionIneffective).toBe(false);
  });
});

describe("interceptor: crash recovery", () => {
  it("detects a turn that was prepared but never recorded", async () => {
    const { interceptor } = await harness(100_000);
    await interceptor.prepareTurn({
      agentId: AGENT,
      runId: "r1",
      prompt: "delete the staging bucket",
      threadId: "thread-1",
    });
    // No recordTurn: the process died here.
    const plan = await interceptor.prepareTurn({
      agentId: AGENT,
      runId: "r2",
      prompt: "are we done?",
      threadId: "thread-1",
    });
    expect(plan.reason).toBe("recovery");
    const events = await interceptor.events(AGENT);
    expect(events.some((event) => event.type === "crash_recovery_triggered")).toBe(true);
  });

  it("keeps the surviving Codex thread rather than discarding it", async () => {
    const { interceptor } = await harness(100_000);
    await interceptor.prepareTurn({
      agentId: AGENT,
      runId: "r1",
      prompt: "step one",
      threadId: "thread-1",
    });
    const plan = await interceptor.prepareTurn({
      agentId: AGENT,
      runId: "r2",
      prompt: "step two",
      threadId: "thread-1",
    });
    expect(plan.threadId).toBe("thread-1");
    expect(plan.reseeded).toBe(false);
  });

  it("describes the interrupted work without re-issuing it as an instruction", async () => {
    const { interceptor } = await harness(100_000);
    await interceptor.prepareTurn({
      agentId: AGENT,
      runId: "r1",
      prompt: "charge the customer card",
      threadId: "thread-1",
    });
    const plan = await interceptor.prepareTurn({
      agentId: AGENT,
      runId: "r2",
      prompt: "status?",
      threadId: "thread-1",
    });
    expect(plan.prompt).toContain("do not");
    expect(plan.prompt).toContain("blindly repeat");
    // The live instruction is still the user's, and it comes last.
    expect(plan.prompt.endsWith("status?")).toBe(true);
  });

  it("records the interrupted turn in residue as interrupted", async () => {
    const { interceptor, store } = await harness(100_000);
    await interceptor.prepareTurn({
      agentId: AGENT,
      runId: "r1",
      prompt: "step one",
      threadId: "thread-1",
    });
    await interceptor.prepareTurn({
      agentId: AGENT,
      runId: "r2",
      prompt: "step two",
      threadId: "thread-1",
    });
    const residue = await store.readResidue(AGENT);
    expect(residue).toHaveLength(1);
    expect(residue[0]?.status).toBe("interrupted");
  });

  it("re-sends the preamble when a re-seeded turn fails", async () => {
    const { interceptor } = await harness(1_000);
    await interceptor.prepareTurn({ agentId: AGENT, runId: "r1", prompt: "start", threadId: null });
    await interceptor.recordTurn({
      agentId: AGENT,
      runId: "r1",
      turnNumber: 1,
      userPrompt: "start",
      assistantOutput: "ok",
      status: "completed",
      usage: { inputTokens: 800 },
      durationMs: 5,
    });
    const reseed = await interceptor.prepareTurn({
      agentId: AGENT,
      runId: "r2",
      prompt: "go",
      threadId: "thread-1",
    });
    expect(reseed.reseeded).toBe(true);
    await interceptor.recordTurn({
      agentId: AGENT,
      runId: "r2",
      turnNumber: 2,
      userPrompt: "go",
      assistantOutput: "boom",
      status: "failed",
      usage: null,
      durationMs: 5,
    });
    const retry = await interceptor.prepareTurn({
      agentId: AGENT,
      runId: "r3",
      prompt: "go again",
      threadId: null,
    });
    expect(retry.reason).toBe("reseed_retry");
    expect(retry.reseeded).toBe(true);
    expect(retry.preamble).not.toBeNull();
    // No second checkpoint: the epoch already happened.
    expect(retry.checkpointVersion).toBe(1);
  });
});

describe("store retention", () => {
  it("keeps only the newest checkpoint versions", async () => {
    const root = await makeRoot();
    const store = new MemoryStore(root, nullRedactor, { maxCheckpointVersions: 3 });
    for (let version = 1; version <= 7; version += 1) {
      await store.writeCheckpoint(AGENT, {
        version, agentId: AGENT, createdAt: new Date().toISOString(),
        compactedThroughTurn: version, objective: "o", progress: [],
        carriedTurns: [], transcriptArtifact: null,
        sourceTurnCount: version, triggerInputTokens: 1,
      });
    }
    const entries = await readdir(path.join(root, AGENT));
    const versions = entries
      .map((name) => /^checkpoint_v(\d+)\.json$/.exec(name)?.[1])
      .filter((v): v is string => Boolean(v))
      .map(Number)
      .sort((a, b) => a - b);
    expect(versions).toEqual([5, 6, 7]);
    // The live pointer always survives pruning.
    expect(entries).toContain("checkpoint.json");
    expect((await store.readCheckpoint(AGENT))?.version).toBe(7);
  });

  it("keeps only the newest transcript artifacts", async () => {
    const root = await makeRoot();
    const store = new MemoryStore(root, nullRedactor, { maxArtifacts: 2 });
    for (let version = 1; version <= 5; version += 1) {
      await store.writeArtifact(AGENT, "transcript_v" + version + ".md", "body");
    }
    const entries = await readdir(path.join(root, AGENT, "artifacts"));
    expect(entries.sort()).toEqual(["transcript_v4.md", "transcript_v5.md"]);
  });

  it("rolls the trace once it passes the size cap", async () => {
    const root = await makeRoot();
    const store = new MemoryStore(root, nullRedactor, { maxJsonlBytes: 2_000 });
    for (let i = 0; i < 40; i += 1) {
      await store.appendEvent({
        timestamp: new Date().toISOString(), agentId: AGENT, runId: "r",
        turnNumber: i, type: "turn_completed",
        detail: { filler: "x".repeat(120) },
      });
    }
    const entries = await readdir(path.join(root, AGENT));
    expect(entries).toContain("trace.jsonl");
    expect(entries).toContain("trace.jsonl.1");
    // Reads still work and stay bounded after a roll.
    const events = await store.readEvents(AGENT);
    expect(events.length).toBeGreaterThan(0);
  });

  it("does not roll a file that is under the cap", async () => {
    const root = await makeRoot();
    const store = new MemoryStore(root, nullRedactor, { maxJsonlBytes: 1_000_000 });
    await store.appendEvent({
      timestamp: new Date().toISOString(), agentId: AGENT, runId: "r",
      turnNumber: 1, type: "turn_completed", detail: {},
    });
    const entries = await readdir(path.join(root, AGENT));
    expect(entries).not.toContain("trace.jsonl.1");
  });
});

describe("store concurrency", () => {
  it("serialises overlapping operations for the same agent", async () => {
    const root = await makeRoot();
    const store = new MemoryStore(root, nullRedactor);
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;

    const job = (label: string, delayMs: number) =>
      store.withLock(AGENT, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        order.push(label);
        active -= 1;
      });

    await Promise.all([job("a", 30), job("b", 5), job("c", 1)]);
    // Never two at once, and FIFO despite descending durations.
    expect(maxActive).toBe(1);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("does not serialise across different agents", async () => {
    const root = await makeRoot();
    const store = new MemoryStore(root, nullRedactor);
    let active = 0;
    let maxActive = 0;
    const job = (agentId: string) =>
      store.withLock(agentId, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      });
    await Promise.all([job("agent-one"), job("agent-two")]);
    expect(maxActive).toBe(2);
  });

  it("releases the lock when the operation throws", async () => {
    const root = await makeRoot();
    const store = new MemoryStore(root, nullRedactor);
    await expect(
      store.withLock(AGENT, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(store.withLock(AGENT, async () => "recovered")).resolves.toBe(
      "recovered",
    );
  });

  it("frees the lock entry once the queue drains", async () => {
    const root = await makeRoot();
    const store = new MemoryStore(root, nullRedactor);
    const locks = (store as unknown as { locks: Map<string, unknown> }).locks;
    await store.withLock(AGENT, async () => undefined);
    // Regression: the cleanup compared against the wrong promise, so this
    // entry was retained for the lifetime of the process.
    expect(locks.size).toBe(0);
  });
});

describe("store durability and safety", () => {
  it("quarantines a corrupt state file instead of wedging the agent", async () => {
    const { root, store, interceptor } = await harness(100_000);
    await interceptor.prepareTurn({ agentId: AGENT, runId: "r1", prompt: "a", threadId: null });
    await writeFile(path.join(root, AGENT, "residue.json"), "{ not json", "utf8");

    await expect(store.readResidue(AGENT)).resolves.toEqual([]);
    const entries = await readdir(path.join(root, AGENT));
    expect(entries.some((name) => name.startsWith("residue.json.corrupt."))).toBe(true);
    const events = await store.readEvents(AGENT);
    expect(events.some((event) => event.type === "state_quarantined")).toBe(true);
  });

  it("leaves no temp files behind after an atomic write", async () => {
    const { root, interceptor } = await harness(1_000);
    await interceptor.prepareTurn({ agentId: AGENT, runId: "r1", prompt: "a", threadId: null });
    await interceptor.recordTurn({
      agentId: AGENT,
      runId: "r1",
      turnNumber: 1,
      userPrompt: "a",
      assistantOutput: "b",
      status: "completed",
      usage: { inputTokens: 800 },
      durationMs: 5,
    });
    await interceptor.prepareTurn({ agentId: AGENT, runId: "r2", prompt: "b", threadId: "t" });
    const entries = await readdir(path.join(root, AGENT));
    expect(entries.filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  it("rejects an agent id that would escape the memory root", async () => {
    const root = await makeRoot();
    const store = new MemoryStore(root, nullRedactor);
    expect(() => store.agentDir("../escape")).toThrow(UnsafeAgentIdError);
    expect(() => store.agentDir("..")).toThrow(UnsafeAgentIdError);
    expect(() => store.agentDir("a/b")).toThrow(UnsafeAgentIdError);
  });

  it("appends the trace instead of rewriting it", async () => {
    const { root, interceptor } = await harness(100_000);
    for (let index = 1; index <= 3; index += 1) {
      await interceptor.prepareTurn({
        agentId: AGENT,
        runId: "r" + index,
        prompt: "p" + index,
        threadId: "t",
      });
      await interceptor.recordTurn({
        agentId: AGENT,
        runId: "r" + index,
        turnNumber: index,
        userPrompt: "p" + index,
        assistantOutput: "o" + index,
        status: "completed",
        usage: { inputTokens: 10 },
        durationMs: 1,
      });
    }
    const raw = await readFile(path.join(root, AGENT, "trace.jsonl"), "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    expect(lines.length).toBe(6);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("bounds the residue buffer", async () => {
    const root = await makeRoot();
    const store = new MemoryStore(root, createRedactor([]));
    const interceptor = new MemoryInterceptor(store, {
      contextLimit: null,
      maxResidueTurns: 3,
      now: clock(),
    });
    await interceptor.initialize();
    for (let index = 1; index <= 6; index += 1) {
      await interceptor.recordTurn({
        agentId: AGENT,
        runId: "r" + index,
        turnNumber: index,
        userPrompt: "p" + index,
        assistantOutput: "o" + index,
        status: "completed",
        usage: null,
        durationMs: 1,
      });
    }
    const residue = await store.readResidue(AGENT);
    expect(residue).toHaveLength(3);
    expect(residue[0]?.turnNumber).toBe(4);
  });

  it("redacts secrets before they reach disk", async () => {
    const root = await makeRoot();
    const store = new MemoryStore(root, createRedactor(["sk-live-abcdef1234567890"]));
    const interceptor = new MemoryInterceptor(store, { contextLimit: null, now: clock() });
    await interceptor.initialize();
    await interceptor.recordTurn({
      agentId: AGENT,
      runId: "r1",
      turnNumber: 1,
      userPrompt: "use sk-live-abcdef1234567890",
      assistantOutput: "ok",
      status: "completed",
      usage: null,
      durationMs: 1,
    });
    const residue = await readFile(path.join(root, AGENT, "residue.json"), "utf8");
    expect(residue).not.toContain("abcdef1234567890");
  });
});

describe("step trace collector", () => {
  const line = (value: unknown) => JSON.stringify(value);

  it("keeps every item type, not just agent messages", () => {
    const collector = new StepTraceCollector(AGENT, "run-1", nullRedactor, clock());
    collector.ingestLine(line({ type: "thread.started", thread_id: "t-1" }));
    collector.ingestLine(
      line({ type: "item.completed", item: { type: "command_execution", id: "i1", command: "npm test" } }),
    );
    collector.ingestLine(
      line({ type: "item.completed", item: { type: "file_change", id: "i2", path: "src/app.ts" } }),
    );
    collector.ingestLine(
      line({ type: "item.completed", item: { type: "agent_message", id: "i3", text: "done" } }),
    );
    const summary = collector.summary();
    expect(summary.threadId).toBe("t-1");
    expect(summary.steps.map((step) => step.type)).toEqual([
      "thread.started",
      "command_execution",
      "file_change",
      "agent_message",
    ]);
  });

  it("identifies the failing step in a failed run", () => {
    const collector = new StepTraceCollector(AGENT, "run-1", nullRedactor, clock());
    collector.ingestLine(
      line({ type: "item.completed", item: { type: "command_execution", command: "ls" } }),
    );
    collector.ingestLine(
      line({ type: "item.completed", item: { type: "command_execution", command: "npm test", exit_code: 1 } }),
    );
    const summary = collector.summary();
    expect(summary.failingStepIndex).toBe(1);
    expect(summary.steps[1]?.status).toBe("error");
    expect(summary.steps[1]?.preview).toContain("npm test");
  });

  it("records per-step durations and total run duration", () => {
    const collector = new StepTraceCollector(AGENT, "run-1", nullRedactor, clock());
    collector.ingestLine(line({ type: "item.completed", item: { type: "a", text: "one" } }));
    collector.ingestLine(line({ type: "item.completed", item: { type: "b", text: "two" } }));
    const summary = collector.summary();
    expect(summary.steps[1]?.durationMs).toBe(1_000);
    expect(summary.totalDurationMs).toBeGreaterThan(0);
  });

  it("captures reported usage and redacts previews", () => {
    const collector = new StepTraceCollector(
      AGENT,
      "run-1",
      createRedactor(["sk-live-abcdef1234567890"]),
      clock(),
    );
    collector.ingestLine(
      line({ type: "item.completed", item: { type: "command_execution", command: "curl -H sk-live-abcdef1234567890" } }),
    );
    collector.ingestLine(
      line({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } }),
    );
    const summary = collector.summary();
    expect(summary.usage).toEqual({ inputTokens: 100, cachedInputTokens: 80, outputTokens: 10 });
    expect(summary.steps[0]?.preview).not.toContain("abcdef1234567890");
  });

  it("renders a usable row for an item type it has never seen", () => {
    const collector = new StepTraceCollector(AGENT, "run-1", nullRedactor, clock());
    collector.ingestLine(
      line({ type: "item.completed", item: { type: "future_tool", payload: { hello: "world" } } }),
    );
    const step = collector.summary().steps[0];
    expect(step?.type).toBe("future_tool");
    expect(step?.preview).toContain("hello");
  });

  it("ignores malformed lines", () => {
    const collector = new StepTraceCollector(AGENT, "run-1", nullRedactor, clock());
    collector.ingestLine("not json");
    collector.ingestLine("");
    expect(collector.summary().steps).toHaveLength(0);
  });
});
