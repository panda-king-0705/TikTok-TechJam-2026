import type { RunUsage } from "../types.js";

export type MemoryEventType =
  | "turn_prepared"
  | "turn_completed"
  | "turn_failed"
  | "compaction_epoch"
  | "crash_recovery_triggered"
  | "compaction_disabled"
  | "compaction_ineffective"
  | "run_traced"
  | "state_quarantined";

/** One line of `trace.jsonl`. Append-only, never rewritten. */
export interface MemoryEvent {
  timestamp: string;
  agentId: string;
  runId: string | null;
  turnNumber: number;
  type: MemoryEventType;
  detail: Record<string, unknown>;
}

export type TurnStatus = "completed" | "failed" | "interrupted";

/**
 * One completed (or interrupted) turn, captured *after* the runner returns.
 * This is the delta tier: high fidelity, bounded, flushed into a checkpoint
 * on compaction.
 */
export interface ResidueDelta {
  turnNumber: number;
  runId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  userPrompt: string;
  assistantOutput: string;
  status: TurnStatus;
  usage: RunUsage | null;
}

/**
 * The durable tier. `compactedThroughTurn` is the watermark that makes
 * compaction idempotent: everything at or below it is already folded in.
 */
export interface CheckpointSnapshot {
  version: number;
  agentId: string;
  createdAt: string;
  compactedThroughTurn: number;
  /** Verbatim first user prompt. Never summarised, never paraphrased. */
  objective: string;
  /** Extractive one-line-per-turn progress log. */
  progress: string[];
  /** Most recent turns kept verbatim so the next turn has real detail. */
  carriedTurns: ResidueDelta[];
  /**
   * In-container path of the full pre-compaction transcript, or null when no
   * artifact mount is configured. The agent reads this for exact recall.
   */
  transcriptArtifact: string | null;
  sourceTurnCount: number;
  /** The measured `usage.inputTokens` that tripped the trigger. */
  triggerInputTokens: number;
}

/** The turn that `prepareTurn` handed out but has not yet been recorded. */
export interface PendingTurn {
  turnNumber: number;
  runId: string;
  prompt: string;
  startedAt: string;
  reseeded: boolean;
}

export interface MemoryState {
  agentId: string;
  lastPreparedTurn: number;
  lastCompletedTurn: number;
  /** Set post-turn when measured input tokens cross the trigger. */
  compactionPending: boolean;
  /** Set when a re-seeded turn did not complete, so the preamble is re-sent. */
  reseedPending: boolean;
  lastInputTokens: number;
  /**
   * Input tokens measured on the turn immediately after a re-seed: the
   * irreducible floor for this agent (the runtime's own system prompt).
   * Compaction cannot get below it.
   */
  floorInputTokens: number;
  /** Latched when the trigger is proven to sit below that floor. */
  compactionIneffective: boolean;
  recoveryCount: number;
  compactionCount: number;
  pendingTurn: PendingTurn | null;
}

export type PrepareReason =
  | "normal"
  | "compaction"
  | "recovery"
  | "reseed_retry";

/** What `prepareTurn` tells `AgentService` to do with this turn. */
export interface TurnPlan {
  turnNumber: number;
  /** Prompt to send. On a re-seed this is `preamble + "\n\n" + userPrompt`. */
  prompt: string;
  /** `null` instructs the caller to start a fresh Codex thread. */
  threadId: string | null;
  reseeded: boolean;
  reason: PrepareReason;
  checkpointVersion: number;
  /** Present only on a re-seed, for tests and the trace UI. */
  preamble: string | null;
}

export interface TurnOutcome {
  agentId: string;
  runId: string;
  turnNumber: number;
  userPrompt: string;
  assistantOutput: string;
  status: TurnStatus;
  usage: RunUsage | null;
  durationMs: number;
}

export const emptyState = (agentId: string): MemoryState => ({
  agentId,
  lastPreparedTurn: 0,
  lastCompletedTurn: 0,
  compactionPending: false,
  reseedPending: false,
  lastInputTokens: 0,
  floorInputTokens: 0,
  compactionIneffective: false,
  recoveryCount: 0,
  compactionCount: 0,
  pendingTurn: null,
});
