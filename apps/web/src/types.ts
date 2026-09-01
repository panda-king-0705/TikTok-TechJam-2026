export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

/** One step inside a Run, derived from the Codex event stream. */
export interface StepEvent {
  agentId: string;
  runId: string;
  seq: number;
  at: string;
  type: string;
  itemId: string | null;
  status: "ok" | "error";
  durationMs: number;
  preview: string;
}

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

export interface MemoryEvent {
  timestamp: string;
  agentId: string;
  runId: string | null;
  turnNumber: number;
  type: MemoryEventType;
  detail: Record<string, unknown>;
}

export interface MemoryStats {
  agentId: string;
  turnsRecorded: number;
  lastInputTokens: number;
  contextLimit: number | null;
  contextUsagePct: number | null;
  compactionTrigger: number | null;
  compactionPending: boolean;
  floorInputTokens: number;
  compactionIneffective: boolean;
  compactionCount: number;
  recoveryCount: number;
  checkpointVersion: number;
  residueCount: number;
  compactionEnabled: boolean;
}

export interface MemoryTrace {
  enabled: boolean;
  stats: MemoryStats | null;
  events: MemoryEvent[];
  steps: StepEvent[];
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
