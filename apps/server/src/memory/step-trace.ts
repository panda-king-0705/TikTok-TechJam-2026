import type { Redactor } from "./redact.js";
import type { RunUsage } from "../types.js";

/**
 * One step inside a Run, derived from the Codex `--json` event stream.
 *
 * The runner already parses this stream but keeps only `agent_message`,
 * `thread.started`, `turn.completed` and `error`. Every other
 * `item.completed` -- command executions, file changes, tool calls -- is
 * discarded. Those discarded items are exactly the per-step timeline the
 * Glass Box track asks for, so this collector keeps all of them, generically,
 * without assuming a fixed set of item types.
 */
export interface StepEvent {
  agentId: string;
  runId: string;
  seq: number;
  at: string;
  /** Codex `item.type`, or a lifecycle name such as `thread.started`. */
  type: string;
  itemId: string | null;
  status: "ok" | "error";
  /** Wall-clock milliseconds since the previous step in this run. */
  durationMs: number;
  /** Redacted, truncated, human-readable one-liner. */
  preview: string;
}

export interface StepTraceSummary {
  agentId: string;
  runId: string;
  threadId: string | null;
  steps: StepEvent[];
  usage: RunUsage | null;
  errors: string[];
  totalDurationMs: number;
  /** Index into `steps` of the first failing step, or null. */
  failingStepIndex: number | null;
}

const PREVIEW_CHARS = 240;

const truncate = (value: string): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= PREVIEW_CHARS
    ? flat
    : flat.slice(0, PREVIEW_CHARS - 1) + "…";
};

const readString = (
  source: Record<string, unknown>,
  key: string,
): string | null => {
  const value = source[key];
  return typeof value === "string" ? value : null;
};

const readNumber = (
  source: Record<string, unknown>,
  key: string,
): number | null => {
  const value = source[key];
  return typeof value === "number" ? value : null;
};

/**
 * Builds a preview without knowing the item schema. Prefers the fields Codex
 * is known to emit, then falls back to a compact JSON rendering, so a Codex
 * version that adds a new item type still produces a usable timeline row
 * instead of an empty one.
 */
function previewOf(item: Record<string, unknown>): string {
  for (const key of ["text", "command", "message", "summary", "path", "name"]) {
    const value = readString(item, key);
    if (value) return truncate(value);
  }
  const { type: _type, id: _id, ...rest } = item;
  const rendered = JSON.stringify(rest);
  return rendered && rendered !== "{}" ? truncate(rendered) : "(no detail)";
}

export class StepTraceCollector {
  private readonly steps: StepEvent[] = [];
  private drainedCount = 0;
  private readonly errors: string[] = [];
  private threadId: string | null = null;
  private usage: RunUsage | null = null;
  private lastAt: number;
  private readonly startedAt: number;

  constructor(
    private readonly agentId: string,
    private readonly runId: string,
    private readonly redactor: Redactor,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.startedAt = this.now().getTime();
    this.lastAt = this.startedAt;
  }

  /** Feed each stdout line from `codex exec --json`. Unparseable lines are ignored. */
  ingestLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = readString(event, "type");
    if (!type) return;

    if (type === "thread.started") {
      const threadId = readString(event, "thread_id");
      if (threadId) this.threadId = threadId;
      this.push("thread.started", null, "ok", threadId ?? "(no thread id)");
      return;
    }

    if (type === "item.completed") {
      const item = event.item;
      if (!item || typeof item !== "object") return;
      const record = item as Record<string, unknown>;
      const itemType = readString(record, "type") ?? "item";
      const itemStatus = readString(record, "status");
      const exitCode = readNumber(record, "exit_code");
      const failed =
        itemStatus === "failed" ||
        itemStatus === "error" ||
        (exitCode !== null && exitCode !== 0);
      this.push(
        itemType,
        readString(record, "id"),
        failed ? "error" : "ok",
        previewOf(record),
      );
      return;
    }

    if (type === "turn.completed") {
      const usage = event.usage;
      if (usage && typeof usage === "object") {
        const source = usage as Record<string, unknown>;
        const inputTokens = readNumber(source, "input_tokens");
        const cachedInputTokens = readNumber(source, "cached_input_tokens");
        const outputTokens = readNumber(source, "output_tokens");
        this.usage = {
          ...(inputTokens !== null ? { inputTokens } : {}),
          ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
          ...(outputTokens !== null ? { outputTokens } : {}),
        };
      }
      // Carry the reported usage as the preview: the label already says the
      // turn finished, so repeating it wastes the only informative column.
      const parts: string[] = [];
      if (this.usage?.inputTokens !== undefined) parts.push(this.usage.inputTokens + " in");
      if (this.usage?.cachedInputTokens !== undefined) parts.push(this.usage.cachedInputTokens + " cached");
      if (this.usage?.outputTokens !== undefined) parts.push(this.usage.outputTokens + " out");
      this.push("turn.completed", null, "ok", parts.join(" · ") || "no usage reported");
      return;
    }

    if (type === "error") {
      const message =
        readString(event, "message") ??
        readString(event, "error") ??
        "Codex reported an unknown error";
      this.errors.push(this.redactor.redactMachine(message));
      this.push("error", null, "error", message);
    }
  }

  /**
   * Steps recorded since the last drain.
   *
   * The timeline used to reach disk only after `AgentRunner.run` settled, so
   * `GET /api/agents/:id/memory` returned nothing new for the whole of a Run --
   * on a multi-minute task the operator watched a spinner with an empty Glass
   * Box beside it, which is the one moment the trace is worth having. Draining
   * lets the caller flush progressively; the drained steps stay in `steps` so
   * `summary()` still describes the whole Run.
   */
  drain(): StepEvent[] {
    const pending = this.steps.slice(this.drainedCount);
    this.drainedCount = this.steps.length;
    return pending;
  }

  summary(): StepTraceSummary {
    const failingStepIndex = this.steps.findIndex(
      (step) => step.status === "error",
    );
    return {
      agentId: this.agentId,
      runId: this.runId,
      threadId: this.threadId,
      steps: this.steps,
      usage: this.usage,
      errors: this.errors,
      totalDurationMs: Math.max(0, this.now().getTime() - this.startedAt),
      failingStepIndex: failingStepIndex === -1 ? null : failingStepIndex,
    };
  }

  private push(
    type: string,
    itemId: string | null,
    status: "ok" | "error",
    preview: string,
  ): void {
    const at = this.now();
    const millis = at.getTime();
    this.steps.push({
      agentId: this.agentId,
      runId: this.runId,
      seq: this.steps.length + 1,
      at: at.toISOString(),
      type,
      itemId,
      status,
      durationMs: Math.max(0, millis - this.lastAt),
      preview: this.redactor.redactMachine(preview),
    });
    this.lastAt = millis;
  }
}
