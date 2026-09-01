import type { CheckpointSnapshot, ResidueDelta } from "./types.js";

export interface CompactorOptions {
  /** Turns kept verbatim in the checkpoint so the next turn has real detail. */
  carryTurns: number;
  /** Cap on extractive progress lines before the oldest are elided. */
  maxProgressLines: number;
  /** Hard cap on a rendered preamble, in characters. */
  maxPreambleChars: number;
  /** Per-field truncation for extractive progress lines. */
  promptExcerptChars: number;
  outputExcerptChars: number;
}

export const DEFAULT_COMPACTOR_OPTIONS: CompactorOptions = {
  carryTurns: 2,
  maxProgressLines: 40,
  maxPreambleChars: 12_000,
  promptExcerptChars: 160,
  outputExcerptChars: 320,
};

const ELISION = "- [older turns elided; full detail in the transcript artifact]";

const oneLine = (value: string, limit: number): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return flat.slice(0, Math.max(0, limit - 1)) + "…";
};

export interface CompactionInput {
  agentId: string;
  previous: CheckpointSnapshot | null;
  residue: readonly ResidueDelta[];
  triggerInputTokens: number;
  /**
   * In-container path where artifacts are mounted read-only, or null when no
   * artifact mount is configured. Never a host path: this string is handed to
   * the model, which only sees the container filesystem.
   */
  artifactMountPath: string | null;
  now: Date;
}

export interface CompactionResult {
  checkpoint: CheckpointSnapshot;
  /** Full pre-compaction transcript, to be written as an artifact. */
  transcript: string;
  transcriptName: string;
}

/**
 * Deterministic, extractive compaction.
 *
 * There is no model call here, on purpose. An abstractive summariser adds a
 * second inference dependency on the recovery path -- the path that has to
 * work when things are already going wrong -- and makes the output untestable.
 * Everything this produces is copied verbatim from the transcript, so the
 * failure mode is "too terse", never "confidently wrong".
 *
 * Precision that extraction cannot preserve is not thrown away: the full
 * transcript is written to the artifact mount and pointed at from the
 * preamble, so the agent can read exact earlier detail on demand.
 */
export function buildCheckpoint(
  input: CompactionInput,
  options: CompactorOptions = DEFAULT_COMPACTOR_OPTIONS,
): CompactionResult {
  const { previous, residue } = input;
  const version = (previous?.version ?? 0) + 1;

  const newTurns = residue.filter(
    (delta) => delta.turnNumber > (previous?.compactedThroughTurn ?? 0),
  );

  const objective =
    previous?.objective ??
    newTurns[0]?.userPrompt ??
    "(no objective recorded before first compaction)";

  const progress = [...(previous?.progress ?? [])];
  for (const delta of newTurns) {
    const marker =
      delta.status === "completed"
        ? ""
        : " [" + delta.status.toUpperCase() + "]";
    progress.push(
      "- Turn " +
        delta.turnNumber +
        marker +
        ": " +
        oneLine(delta.userPrompt, options.promptExcerptChars) +
        " -> " +
        oneLine(delta.assistantOutput, options.outputExcerptChars),
    );
  }

  const trimmedProgress =
    progress.length > options.maxProgressLines
      ? [ELISION, ...progress.slice(-options.maxProgressLines)]
      : progress;

  const carriedTurns = newTurns.slice(-options.carryTurns);

  const compactedThroughTurn = Math.max(
    previous?.compactedThroughTurn ?? 0,
    ...newTurns.map((delta) => delta.turnNumber),
    0,
  );

  const transcriptName = "transcript_v" + version + ".md";
  const transcript = renderTranscript(input, version, newTurns);

  const checkpoint: CheckpointSnapshot = {
    version,
    agentId: input.agentId,
    createdAt: input.now.toISOString(),
    compactedThroughTurn,
    objective,
    progress: trimmedProgress,
    carriedTurns,
    transcriptArtifact: input.artifactMountPath
      ? input.artifactMountPath.replace(/\/+$/, "") + "/" + transcriptName
      : null,
    sourceTurnCount: (previous?.sourceTurnCount ?? 0) + newTurns.length,
    triggerInputTokens: input.triggerInputTokens,
  };

  return { checkpoint, transcript, transcriptName };
}

function renderTranscript(
  input: CompactionInput,
  version: number,
  turns: readonly ResidueDelta[],
): string {
  const lines: string[] = [
    "# Transcript before checkpoint v" + version,
    "",
    "Agent: " + input.agentId,
    "Written: " + input.now.toISOString(),
    "Turns: " + turns.length,
    "",
  ];
  if (input.previous?.transcriptArtifact) {
    lines.push(
      "Earlier turns are in the previous transcript: " +
        input.previous.transcriptArtifact,
      "",
    );
  }
  for (const delta of turns) {
    lines.push(
      "## Turn " + delta.turnNumber + " (" + delta.status + ")",
      "",
      "- run: " + delta.runId,
      "- started: " + delta.startedAt,
      "- duration: " + delta.durationMs + "ms",
      ...(delta.usage?.inputTokens !== undefined
        ? ["- input tokens: " + delta.usage.inputTokens]
        : []),
      "",
      "### User",
      "",
      delta.userPrompt,
      "",
      "### Assistant",
      "",
      delta.assistantOutput,
      "",
    );
  }
  return lines.join("\n");
}

/**
 * Renders the checkpoint into the text prepended to the first prompt of a
 * fresh Codex thread.
 *
 * This is the only thing the re-seeded thread knows, so it carries the
 * objective verbatim, the extractive progress log, the most recent turns in
 * full, and a pointer to the exact transcript.
 */
export function renderPreamble(
  checkpoint: CheckpointSnapshot,
  interrupted: ResidueDelta | null,
  options: CompactorOptions = DEFAULT_COMPACTOR_OPTIONS,
): string {
  const sections: string[] = [
    "# Restored session context",
    "",
    "This conversation was restored by the platform's memory middleware. The",
    "earlier turns are not in your context window; the summary below and the",
    "transcript artifact are the record of them.",
    "",
    "## Objective (verbatim, from the first turn)",
    "",
    checkpoint.objective,
    "",
    "## Progress so far (" +
      checkpoint.sourceTurnCount +
      " turns, compacted through turn " +
      checkpoint.compactedThroughTurn +
      ")",
    "",
    ...(checkpoint.progress.length > 0
      ? checkpoint.progress
      : ["- (no turns recorded)"]),
    "",
  ];

  if (checkpoint.carriedTurns.length > 0) {
    sections.push("## Most recent turns (verbatim)", "");
    for (const delta of checkpoint.carriedTurns) {
      sections.push(
        "### Turn " + delta.turnNumber + " user",
        "",
        delta.userPrompt,
        "",
        "### Turn " + delta.turnNumber + " assistant",
        "",
        delta.assistantOutput,
        "",
      );
    }
  }

  if (interrupted) {
    sections.push(
      "## Interrupted turn " + interrupted.turnNumber,
      "",
      "The previous turn was terminated before it reported a result. Its",
      "side effects may be fully applied, partially applied, or absent. Do",
      "not assume it failed and do not blindly repeat it: inspect the",
      "workspace to establish the real state first. The request was:",
      "",
      interrupted.userPrompt,
      "",
    );
  }

  if (checkpoint.transcriptArtifact) {
    sections.push(
      "## Exact recall",
      "",
      "The full pre-compaction transcript is readable at " +
        checkpoint.transcriptArtifact +
        " (read-only). Read it whenever you need an exact earlier value,",
      "file path, or constraint rather than relying on the summary above.",
      "",
    );
  }

  const rendered = sections.join("\n");
  if (rendered.length <= options.maxPreambleChars) return rendered;
  return (
    rendered.slice(0, options.maxPreambleChars) +
    "\n\n[preamble truncated to " +
    options.maxPreambleChars +
    " characters]\n"
  );
}

/**
 * The short form used when a crash is detected but the Codex thread survived.
 *
 * Nothing here re-issues the interrupted request. Replaying a prompt is the
 * one thing that can duplicate a non-idempotent side effect, so recovery only
 * ever describes state and tells the agent to verify it.
 */
export function renderInterruptionNotice(interrupted: ResidueDelta): string {
  return [
    "# Recovered from an interrupted turn",
    "",
    "Turn " +
      interrupted.turnNumber +
      " was terminated before it reported a result, so its side effects may",
    "be fully applied, partially applied, or absent. Establish the real state",
    "from the workspace before acting; do not assume it failed and do not",
    "blindly repeat it. The interrupted request was:",
    "",
    interrupted.userPrompt,
    "",
  ].join("\n");
}
