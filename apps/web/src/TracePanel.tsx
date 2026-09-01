import { useMemo } from "react";
import type { MemoryEvent, MemoryTrace, StepEvent } from "./types";

const formatMs = (value: number): string =>
  value >= 1000 ? (value / 1000).toFixed(1) + "s" : value + "ms";

const formatTokens = (value: number | null | undefined): string =>
  typeof value === "number"
    ? value >= 1000
      ? (value / 1000).toFixed(1) + "k"
      : String(value)
    : "—";

/** Codex item types rendered with a friendlier label. */
const STEP_LABELS: Record<string, string> = {
  "thread.started": "session opened",
  "turn.completed": "turn finished",
  command_execution: "command",
  file_change: "file change",
  agent_message: "reply",
  reasoning: "reasoning",
  mcp_tool_call: "tool call",
  web_search: "web search",
  error: "error",
};

/** Events worth surfacing as a marker in the timeline. */
const MARKERS: Partial<Record<MemoryEvent["type"], { icon: string; label: string; tone: string }>> = {
  compaction_epoch: { icon: "⇩", label: "Context compacted", tone: "compaction" },
  crash_recovery_triggered: { icon: "⏻", label: "Crash recovery", tone: "recovery" },
  compaction_ineffective: { icon: "!", label: "Compaction ineffective", tone: "warn" },
  compaction_disabled: { icon: "!", label: "Compaction disabled", tone: "warn" },
  state_quarantined: { icon: "!", label: "Corrupt state quarantined", tone: "warn" },
};

interface RunGroup {
  runId: string;
  steps: StepEvent[];
  totalMs: number;
  failingSeq: number | null;
  /** Authoritative: from the turn event, not inferred from step status. */
  failed: boolean;
  turnNumber: number | null;
  inputTokens: number | null;
  cacheHitPct: number | null;
}

function groupByRun(trace: MemoryTrace): RunGroup[] {
  const byRun = new Map<string, StepEvent[]>();
  for (const step of trace.steps) {
    const bucket = byRun.get(step.runId);
    if (bucket) bucket.push(step);
    else byRun.set(step.runId, [step]);
  }
  const completions = new Map<string, MemoryEvent>();
  for (const event of trace.events) {
    if (event.runId && (event.type === "turn_completed" || event.type === "turn_failed")) {
      completions.set(event.runId, event);
    }
  }
  return [...byRun.entries()].map(([runId, steps]) => {
    const failing = steps.find((step) => step.status === "error");
    const completion = completions.get(runId);
    const detail = completion?.detail ?? {};
    return {
      runId,
      steps,
      totalMs: steps.reduce((sum, step) => sum + step.durationMs, 0),
      failingSeq: failing?.seq ?? null,
      // A Run terminated externally (timeout, cancellation) fails without any
      // step reporting an error, so step status alone under-reports failure.
      failed:
        completion?.type === "turn_failed" ||
        detail["status"] === "failed" ||
        failing !== undefined,
      turnNumber: completion?.turnNumber ?? null,
      inputTokens: typeof detail["inputTokens"] === "number" ? detail["inputTokens"] : null,
      cacheHitPct: typeof detail["cacheHitPct"] === "number" ? detail["cacheHitPct"] : null,
    };
  });
}

export function TracePanel({ trace }: { trace: MemoryTrace | null }) {
  const groups = useMemo(() => (trace ? groupByRun(trace) : []), [trace]);
  const markers = useMemo(
    () => (trace ? trace.events.filter((event) => MARKERS[event.type]) : []),
    [trace],
  );

  if (!trace) {
    return <div className="trace-empty">Loading trace…</div>;
  }
  if (!trace.enabled) {
    return (
      <div className="trace-empty">
        Memory middleware is disabled. Set <code>MEMORY_ENABLED=true</code> to
        record a trace.
      </div>
    );
  }

  const stats = trace.stats;

  return (
    <div className="trace-panel">
      <div className="trace-badges">
        <Badge
          label="Context"
          value={
            stats?.contextUsagePct != null
              ? stats.contextUsagePct + "%"
              : formatTokens(stats?.lastInputTokens)
          }
          hint={
            stats?.contextLimit
              ? formatTokens(stats.lastInputTokens) + " / " + formatTokens(stats.contextLimit)
              : "no limit configured"
          }
          tone={
            stats?.contextUsagePct != null && stats.contextUsagePct >= 70 ? "warn" : "ok"
          }
        />
        <Badge
          label="Cache hit"
          value={
            groups.length > 0 && groups[groups.length - 1]?.cacheHitPct != null
              ? groups[groups.length - 1]!.cacheHitPct + "%"
              : "—"
          }
          hint="measured, last turn"
          tone="ok"
        />
        <Badge
          label="Compactions"
          value={String(stats?.compactionCount ?? 0)}
          hint={
            stats?.compactionIneffective
              ? "disarmed: runtime floor above trigger"
              : stats?.compactionPending
                ? "armed for next turn"
                : "checkpoint v" + (stats?.checkpointVersion ?? 0)
          }
          tone={stats?.compactionIneffective ? "warn" : "ok"}
        />
        <Badge
          label="Recoveries"
          value={String(stats?.recoveryCount ?? 0)}
          hint={"turns recorded: " + (stats?.turnsRecorded ?? 0)}
          tone={(stats?.recoveryCount ?? 0) > 0 ? "recovery" : "ok"}
        />
      </div>

      {markers.length > 0 && (
        <div className="trace-markers">
          {markers.map((event, index) => {
            const marker = MARKERS[event.type]!;
            return (
              <div className={"trace-marker tone-" + marker.tone} key={event.type + index}>
                <span className="marker-icon">{marker.icon}</span>
                <span className="marker-label">{marker.label}</span>
                <span className="marker-turn">turn {event.turnNumber}</span>
                <span className="marker-detail">{describe(event)}</span>
              </div>
            );
          })}
        </div>
      )}

      {groups.length === 0 ? (
        <div className="trace-empty">
          No steps recorded yet. Send a message to populate the timeline.
        </div>
      ) : (
        <ol className="trace-runs">
          {groups.map((group) => (
            <li className="trace-run" key={group.runId}>
              <div className="trace-run-head">
                <span className="run-turn">
                  {group.turnNumber != null ? "Turn " + group.turnNumber : "Run"}
                </span>
                <code className="run-id">{group.runId.slice(0, 8)}</code>
                <span className="run-meta">{group.steps.length} steps</span>
                <span className="run-meta">{formatMs(group.totalMs)}</span>
                {group.inputTokens != null && (
                  <span className="run-meta">{formatTokens(group.inputTokens)} in</span>
                )}
                {group.failed && <span className="run-failed">failed</span>}
              </div>
              <ol className="trace-steps">
                {group.steps.map((step) => (
                  <li
                    className={
                      "trace-step" +
                      (step.status === "error" ? " step-error" : "") +
                      (step.seq === group.failingSeq ? " step-culprit" : "")
                    }
                    key={step.runId + ":" + step.seq}
                  >
                    <span className="step-rail" aria-hidden="true" />
                    <span className="step-type">
                      {STEP_LABELS[step.type] ?? step.type}
                    </span>
                    <span className="step-duration">{formatMs(step.durationMs)}</span>
                    <span className="step-preview">{step.preview}</span>
                    {step.seq === group.failingSeq && (
                      <span className="step-flag">failing step</span>
                    )}
                  </li>
                ))}
                {group.failed && group.failingSeq == null && (
                  <li className="trace-step step-error">
                    <span className="step-rail" aria-hidden="true" />
                    <span className="step-type">run terminated</span>
                    <span className="step-duration">—</span>
                    <span className="step-preview">
                      No step reported an error: the Run was terminated
                      externally, so the step in flight never completed.
                    </span>
                  </li>
                )}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Badge({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: string;
}) {
  return (
    <div className={"trace-badge tone-" + tone}>
      <span className="badge-label">{label}</span>
      <strong className="badge-value">{value}</strong>
      <span className="badge-hint">{hint}</span>
    </div>
  );
}

function describe(event: MemoryEvent): string {
  const detail = event.detail;
  switch (event.type) {
    case "compaction_epoch":
      return (
        "v" +
        String(detail["checkpointVersion"] ?? "?") +
        " · " +
        String(detail["turnsCompacted"] ?? "?") +
        " turns folded"
      );
    case "crash_recovery_triggered":
      return (
        "interrupted turn " +
        String(detail["interruptedTurn"] ?? "?") +
        (detail["threadSurvived"] ? " · session preserved" : " · session re-seeded")
      );
    case "compaction_ineffective":
      return (
        "floor " +
        formatTokens(detail["floorInputTokens"] as number) +
        " ≥ trigger " +
        formatTokens(detail["compactionTrigger"] as number)
      );
    default:
      return typeof detail["reason"] === "string" ? detail["reason"] : "";
  }
}
