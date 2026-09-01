import {
  buildCheckpoint,
  renderInterruptionNotice,
  renderPreamble,
  DEFAULT_COMPACTOR_OPTIONS,
  type CompactorOptions,
} from "./compactor.js";
import { compactionTrigger, DEFAULT_TRIGGER_PCT } from "./context-limit.js";
import { MemoryStore } from "./memory-store.js";
import { StepTraceCollector, type StepTraceSummary } from "./step-trace.js";
import type {
  CheckpointSnapshot,
  MemoryEvent,
  MemoryEventType,
  MemoryState,
  PrepareReason,
  ResidueDelta,
  TurnOutcome,
  TurnPlan,
} from "./types.js";

export interface PrepareTurnInput {
  agentId: string;
  runId: string;
  prompt: string;
  threadId: string | null;
}

export interface MemoryInterceptorOptions {
  /**
   * Measured context limit for the configured model, or null when unknown.
   * Null disables compaction rather than guessing.
   */
  contextLimit: number | null;
  triggerPct?: number;
  /**
   * In-container path where `<root>/<agentId>/artifacts` is mounted read-only,
   * or null when no artifact mount is configured.
   */
  artifactMountPath?: string | null;
  maxResidueTurns?: number;
  maxResidueBytes?: number;
  compactor?: CompactorOptions;
  now?: () => Date;
}

export interface MemoryStats {
  agentId: string;
  turnsRecorded: number;
  lastInputTokens: number;
  contextLimit: number | null;
  contextUsagePct: number | null;
  compactionTrigger: number | null;
  compactionPending: boolean;
  /** Measured runtime overhead floor; 0 until a re-seed has been observed. */
  floorInputTokens: number;
  /** True once the trigger is proven to sit below the floor. */
  compactionIneffective: boolean;
  compactionCount: number;
  recoveryCount: number;
  checkpointVersion: number;
  residueCount: number;
  compactionEnabled: boolean;
}

const SECTION_SEPARATOR = "\n\n---\n\n";

/**
 * Sits either side of `AgentRunner.run`.
 *
 * The one design constraint that shapes everything else: this platform does
 * not own the conversation. Codex CLI owns it, keyed by `threadId`, and the
 * control plane never sees the message array. So the middleware does not try
 * to rewrite a prompt array it cannot access. It does the two things it can
 * actually do at this seam -- prepend text to the next prompt, and decide
 * whether that prompt starts a fresh thread -- and it measures context from
 * the provider's own reported `usage.inputTokens` rather than estimating it
 * from a partial history.
 */
export class MemoryInterceptor {
  private readonly triggerPct: number;
  private readonly artifactMountPath: string | null;
  private readonly maxResidueTurns: number;
  private readonly maxResidueBytes: number;
  private readonly compactorOptions: CompactorOptions;
  private readonly now: () => Date;

  constructor(
    private readonly store: MemoryStore,
    private readonly options: MemoryInterceptorOptions,
  ) {
    this.triggerPct = options.triggerPct ?? DEFAULT_TRIGGER_PCT;
    this.artifactMountPath = options.artifactMountPath ?? null;
    this.maxResidueTurns = options.maxResidueTurns ?? 24;
    this.maxResidueBytes = options.maxResidueBytes ?? 256_000;
    this.compactorOptions = options.compactor ?? DEFAULT_COMPACTOR_OPTIONS;
    this.now = options.now ?? (() => new Date());
  }

  get contextLimit(): number | null {
    return this.options.contextLimit;
  }

  get trigger(): number | null {
    return this.options.contextLimit === null
      ? null
      : compactionTrigger(this.options.contextLimit, this.triggerPct);
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  /**
   * Called immediately before `AgentRunner.run`. Never throws into the run
   * path: a memory failure degrades to an unmodified turn.
   */
  async prepareTurn(input: PrepareTurnInput): Promise<TurnPlan> {
    return this.store.withLock(input.agentId, async () => {
      await this.store.ensureAgentDirs(input.agentId);
      const state = await this.store.readState(input.agentId);
      const turnNumber = state.lastPreparedTurn + 1;
      const timestamp = this.now();

      const interrupted = await this.detectInterruptedTurn(state, timestamp);
      if (interrupted) {
        await this.pushResidue(input.agentId, interrupted);
        state.recoveryCount += 1;
        await this.emit(input.agentId, input.runId, turnNumber, "crash_recovery_triggered", {
          interruptedTurn: interrupted.turnNumber,
          interruptedRunId: interrupted.runId,
          threadSurvived: input.threadId !== null,
          recoveryCount: state.recoveryCount,
        });
      }

      let checkpoint = await this.store.readCheckpoint(input.agentId);
      let reason: PrepareReason = "normal";

      if (state.compactionPending) {
        checkpoint = await this.runCompaction(input.agentId, state, checkpoint, timestamp);
        reason = "compaction";
      } else if (state.reseedPending || (checkpoint !== null && input.threadId === null)) {
        reason = "reseed_retry";
      } else if (interrupted) {
        reason = "recovery";
      }

      // A re-seed drops the Codex thread, so it is used only when the thread
      // is no longer trustworthy: after compaction, or when a previous re-seed
      // never landed. A plain crash keeps the thread, because Codex's own
      // rollout on disk is a better record than any summary this can build.
      const reseed = reason === "compaction" || reason === "reseed_retry";

      const preamble =
        reseed && checkpoint
          ? renderPreamble(checkpoint, interrupted, this.compactorOptions)
          : null;
      const notice =
        interrupted && !reseed ? renderInterruptionNotice(interrupted) : null;

      const prompt = [preamble, notice, input.prompt]
        .filter((part): part is string => part !== null && part.length > 0)
        .join(SECTION_SEPARATOR);

      state.lastPreparedTurn = turnNumber;
      state.reseedPending = reseed;
      state.pendingTurn = {
        turnNumber,
        runId: input.runId,
        prompt: input.prompt,
        startedAt: timestamp.toISOString(),
        reseeded: reseed,
      };
      await this.store.writeState(input.agentId, state);

      await this.emit(input.agentId, input.runId, turnNumber, "turn_prepared", {
        reason,
        reseeded: reseed,
        checkpointVersion: checkpoint?.version ?? 0,
        preambleChars: preamble?.length ?? 0,
        promptChars: prompt.length,
      });

      return {
        turnNumber,
        prompt,
        threadId: reseed ? null : input.threadId,
        reseeded: reseed,
        reason,
        checkpointVersion: checkpoint?.version ?? 0,
        preamble,
      };
    });
  }

  /**
   * Called after `AgentRunner.run` settles, on both the success and failure
   * paths. This is where the compaction decision is made, from the provider's
   * reported token usage rather than an estimate.
   */
  async recordTurn(outcome: TurnOutcome): Promise<void> {
    await this.store.withLock(outcome.agentId, async () => {
      const state = await this.store.readState(outcome.agentId);
      const completedAt = this.now();
      const startedAt = state.pendingTurn?.startedAt ?? completedAt.toISOString();

      // Redacted here, not at the serialisation boundary. Otherwise the
      // preamble built in memory and the checkpoint rehydrated from disk
      // after a restart would differ, and recovery would silently degrade.
      const redactor = this.store.redactor;
      const delta: ResidueDelta = {
        turnNumber: outcome.turnNumber,
        runId: outcome.runId,
        startedAt,
        completedAt: completedAt.toISOString(),
        durationMs: outcome.durationMs,
        userPrompt: redactor.redact(outcome.userPrompt),
        assistantOutput: redactor.redact(outcome.assistantOutput),
        status: outcome.status,
        usage: outcome.usage,
      };
      await this.pushResidue(outcome.agentId, delta);

      const wasReseeded = state.pendingTurn?.reseeded ?? false;
      state.lastCompletedTurn = outcome.turnNumber;
      state.pendingTurn = null;
      if (outcome.status === "completed") {
        // Only a completed turn confirms the re-seed actually landed. If it
        // failed, the preamble is re-sent next turn instead of being lost.
        state.reseedPending = false;
      }

      const inputTokens = outcome.usage?.inputTokens;
      const trigger = this.trigger;
      let tripped = false;
      let ineffective = false;
      if (typeof inputTokens === "number") {
        state.lastInputTokens = inputTokens;
        // The turn straight after a re-seed measures the floor: the runtime's
        // own fixed overhead, which no amount of compaction removes.
        if (wasReseeded) state.floorInputTokens = inputTokens;
        if (trigger !== null && inputTokens >= trigger) {
          if (state.floorInputTokens > 0 && state.floorInputTokens >= trigger) {
            // Compacting again would re-seed straight back above the trigger
            // and loop forever. Stop, and tell the operator why.
            ineffective = !state.compactionIneffective;
            state.compactionIneffective = true;
            state.compactionPending = false;
          } else {
            state.compactionPending = true;
            tripped = true;
          }
        }
      }
      await this.store.writeState(outcome.agentId, state);

      if (ineffective) {
        await this.emit(
          outcome.agentId,
          outcome.runId,
          outcome.turnNumber,
          "compaction_ineffective",
          {
            floorInputTokens: state.floorInputTokens,
            compactionTrigger: trigger,
            contextLimit: this.options.contextLimit,
            reason:
              "the runtime's own prompt overhead already exceeds the compaction " +
              "trigger, so compaction cannot reduce context; raise " +
              "MEMORY_CONTEXT_LIMIT above the floor or compaction stays off",
          },
        );
      }

      const cached = outcome.usage?.cachedInputTokens;
      await this.emit(
        outcome.agentId,
        outcome.runId,
        outcome.turnNumber,
        outcome.status === "completed" ? "turn_completed" : "turn_failed",
        {
          status: outcome.status,
          durationMs: outcome.durationMs,
          inputTokens: inputTokens ?? null,
          outputTokens: outcome.usage?.outputTokens ?? null,
          cachedInputTokens: cached ?? null,
          // Measured, not asserted. Null when the provider did not report it.
          cacheHitPct:
            typeof cached === "number" &&
            typeof inputTokens === "number" &&
            inputTokens > 0
              ? Math.round((cached / inputTokens) * 100)
              : null,
          contextLimit: this.options.contextLimit,
          contextUsagePct:
            typeof inputTokens === "number" && this.options.contextLimit
              ? Math.round((inputTokens / this.options.contextLimit) * 100)
              : null,
          compactionTrigger: trigger,
          compactionPending: state.compactionPending,
          triggeredCompaction: tripped,
        },
      );

      if (outcome.turnNumber === 1 && this.options.contextLimit === null) {
        await this.emit(
          outcome.agentId,
          outcome.runId,
          outcome.turnNumber,
          "compaction_disabled",
          {
            reason:
              "context limit unknown for the configured model; set MEMORY_CONTEXT_LIMIT to enable compaction",
          },
        );
      }
    });
  }

  /**
   * Builds a per-Run collector for the Codex event stream. Redaction is
   * shared with the store, so a secret cannot reach a step preview by a
   * different route than it reaches a checkpoint.
   */
  createStepCollector(agentId: string, runId: string): StepTraceCollector {
    return new StepTraceCollector(
      agentId,
      runId,
      this.store.redactor,
      this.now,
    );
  }

  /**
   * Appends whatever the collector has gathered since the last call.
   *
   * Called repeatedly while the Run is still in flight, so the trace endpoint
   * reports progress live rather than only after the Run settles. Appends are
   * serialised per collector by the caller; a drained step is never written
   * twice because `drain()` advances its own watermark.
   */
  async flushSteps(collector: StepTraceCollector): Promise<void> {
    const pending = collector.drain();
    if (pending.length === 0) return;
    await this.store.appendSteps(pending[0]!.agentId, pending);
  }

  /**
   * Records the summary row in the event trace so a reader can find the
   * failing step without scanning every step of every Run. The steps
   * themselves are persisted by `flushSteps`.
   */
  async recordSteps(
    summary: StepTraceSummary,
    turnNumber: number,
  ): Promise<void> {
    if (summary.steps.length === 0) return;
    const failing =
      summary.failingStepIndex === null
        ? null
        : (summary.steps[summary.failingStepIndex] ?? null);
    await this.emit(summary.agentId, summary.runId, turnNumber, "run_traced", {
      stepCount: summary.steps.length,
      totalDurationMs: summary.totalDurationMs,
      failingStepIndex: summary.failingStepIndex,
      failingStepType: failing?.type ?? null,
      failingStepPreview: failing?.preview ?? null,
      errors: summary.errors,
    });
  }

  async steps(agentId: string, limit?: number) {
    return this.store.readSteps(agentId, limit);
  }

  async stats(agentId: string): Promise<MemoryStats> {
    const [state, checkpoint, residue] = await Promise.all([
      this.store.readState(agentId),
      this.store.readCheckpoint(agentId),
      this.store.readResidue(agentId),
    ]);
    const limit = this.options.contextLimit;
    return {
      agentId,
      turnsRecorded: state.lastCompletedTurn,
      lastInputTokens: state.lastInputTokens,
      contextLimit: limit,
      contextUsagePct:
        limit && state.lastInputTokens > 0
          ? Math.round((state.lastInputTokens / limit) * 100)
          : null,
      compactionTrigger: this.trigger,
      compactionPending: state.compactionPending,
      floorInputTokens: state.floorInputTokens,
      compactionIneffective: state.compactionIneffective,
      compactionCount: state.compactionCount,
      recoveryCount: state.recoveryCount,
      checkpointVersion: checkpoint?.version ?? 0,
      residueCount: residue.length,
      compactionEnabled: limit !== null,
    };
  }

  async events(agentId: string, limit?: number): Promise<MemoryEvent[]> {
    return this.store.readEvents(agentId, limit);
  }

  private async detectInterruptedTurn(
    state: MemoryState,
    timestamp: Date,
  ): Promise<ResidueDelta | null> {
    const pending = state.pendingTurn;
    if (!pending) return null;
    const startedMs = Date.parse(pending.startedAt);
    return {
      turnNumber: pending.turnNumber,
      runId: pending.runId,
      startedAt: pending.startedAt,
      completedAt: timestamp.toISOString(),
      durationMs: Number.isFinite(startedMs)
        ? Math.max(0, timestamp.getTime() - startedMs)
        : 0,
      userPrompt: pending.prompt,
      assistantOutput:
        "(no result recorded: the process was terminated during this turn)",
      status: "interrupted",
      usage: null,
    };
  }

  private async runCompaction(
    agentId: string,
    state: MemoryState,
    previous: CheckpointSnapshot | null,
    timestamp: Date,
  ): Promise<CheckpointSnapshot> {
    const residue = await this.store.readResidue(agentId);
    const result = buildCheckpoint(
      {
        agentId,
        previous,
        residue,
        triggerInputTokens: state.lastInputTokens,
        artifactMountPath: this.artifactMountPath,
        now: timestamp,
      },
      this.compactorOptions,
    );

    if (this.artifactMountPath) {
      await this.store.writeArtifact(
        agentId,
        result.transcriptName,
        result.transcript,
      );
    }
    await this.store.writeCheckpoint(agentId, result.checkpoint);
    // Safe to clear: every residue turn has been folded into the checkpoint
    // and written verbatim into the transcript artifact first.
    await this.store.writeResidue(agentId, []);

    state.compactionPending = false;
    state.compactionCount += 1;

    await this.emit(agentId, null, state.lastPreparedTurn + 1, "compaction_epoch", {
      checkpointVersion: result.checkpoint.version,
      compactedThroughTurn: result.checkpoint.compactedThroughTurn,
      turnsCompacted: residue.length,
      triggerInputTokens: state.lastInputTokens,
      compactionTrigger: this.trigger,
      transcriptArtifact: result.checkpoint.transcriptArtifact,
    });

    return result.checkpoint;
  }

  private async pushResidue(
    agentId: string,
    delta: ResidueDelta,
  ): Promise<void> {
    const residue = await this.store.readResidue(agentId);
    residue.push(delta);
    await this.store.writeResidue(agentId, this.boundResidue(residue));
  }

  /** Bounded by both turn count and serialised bytes. */
  private boundResidue(residue: ResidueDelta[]): ResidueDelta[] {
    let bounded =
      residue.length > this.maxResidueTurns
        ? residue.slice(-this.maxResidueTurns)
        : residue;
    while (
      bounded.length > 1 &&
      JSON.stringify(bounded).length > this.maxResidueBytes
    ) {
      bounded = bounded.slice(1);
    }
    return bounded;
  }

  private async emit(
    agentId: string,
    runId: string | null,
    turnNumber: number,
    type: MemoryEventType,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.store.appendEvent({
      timestamp: this.now().toISOString(),
      agentId,
      runId,
      turnNumber,
      type,
      detail,
    });
  }
}
