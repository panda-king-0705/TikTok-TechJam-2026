import {
  open,
  mkdir,
  readFile,
  readdir,
  rename,
  appendFile,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import type { Redactor } from "./redact.js";
import type { StepEvent } from "./step-trace.js";
import {
  emptyState,
  type CheckpointSnapshot,
  type MemoryEvent,
  type MemoryState,
  type ResidueDelta,
} from "./types.js";

/**
 * Agent ids are `randomUUID()` today, but this middleware is meant to be
 * reusable, so the id is validated before it is ever used as a path segment.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isSafeAgentId(agentId: string): boolean {
  return SAFE_ID.test(agentId) && agentId !== "." && agentId !== "..";
}

export class UnsafeAgentIdError extends Error {
  constructor(agentId: string) {
    super("Unsafe agent id for memory storage: " + JSON.stringify(agentId));
    this.name = "UnsafeAgentIdError";
  }
}

/**
 * Durability contract:
 *
 * `writeJsonAtomic` writes a temp file, fsyncs it, renames over the target,
 * then best-effort fsyncs the parent directory. Against the threat model this
 * middleware actually claims -- `SIGKILL` of the Node process, container OOM --
 * the rename alone is sufficient, because the page cache survives. The fsyncs
 * additionally cover host power loss on filesystems that honour them, and the
 * directory fsync is wrapped in a catch because it is not portable.
 *
 * A reader therefore never observes a partially written file: it sees the old
 * complete file or the new complete file.
 */
/** Retention limits. Nothing here grows without bound. */
export interface RetentionOptions {
  /** Versioned checkpoint copies to keep, newest first. */
  maxCheckpointVersions: number;
  /** Roll a .jsonl to `<name>.1` past this size, keeping one generation. */
  maxJsonlBytes: number;
  /** Transcript artifacts to keep, newest first. */
  maxArtifacts: number;
}

export const DEFAULT_RETENTION: RetentionOptions = {
  maxCheckpointVersions: 5,
  maxJsonlBytes: 8 * 1024 * 1024,
  maxArtifacts: 5,
};

export class MemoryStore {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly retention: RetentionOptions;

  constructor(
    private readonly root: string,
    /** Public so the interceptor can build collectors that redact identically. */
    readonly redactor: Redactor,
    retention: Partial<RetentionOptions> = {},
  ) {
    this.retention = { ...DEFAULT_RETENTION, ...retention };
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /**
   * The artifacts directory is bind-mounted into the Runtime, and a bind
   * mount fails if the source does not exist, so it is created eagerly rather
   * than on first write.
   */
  async ensureAgentDirs(agentId: string): Promise<void> {
    await mkdir(this.artifactDir(agentId), { recursive: true });
  }

  agentDir(agentId: string): string {
    if (!SAFE_ID.test(agentId) || agentId === "." || agentId === "..") {
      throw new UnsafeAgentIdError(agentId);
    }
    const resolved = path.resolve(this.root, agentId);
    const bounded = path.resolve(this.root) + path.sep;
    if (!resolved.startsWith(bounded)) {
      throw new UnsafeAgentIdError(agentId);
    }
    return resolved;
  }

  artifactDir(agentId: string): string {
    return path.join(this.agentDir(agentId), "artifacts");
  }

  /**
   * Serialises all state mutations for one agent. `AgentService` already
   * refuses concurrent runs per agent, but recovery and compaction both
   * read-modify-write the same files, so ordering is made explicit here
   * rather than assumed.
   */
  async withLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Keep a reference to the promise actually stored, so the cleanup below
    // can tell "I am still the tail of the queue" from "someone queued behind
    // me". Comparing against `gate` never matched, leaving a dead entry per
    // agent for the lifetime of the process.
    const chained = previous.then(() => gate);
    this.locks.set(agentId, chained);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(agentId) === chained) this.locks.delete(agentId);
    }
  }

  async readState(agentId: string): Promise<MemoryState> {
    const parsed = await this.readJson<MemoryState>(
      path.join(this.agentDir(agentId), "state.json"),
      agentId,
    );
    if (!parsed || typeof parsed.lastPreparedTurn !== "number") {
      return emptyState(agentId);
    }
    return { ...emptyState(agentId), ...parsed, agentId };
  }

  async writeState(agentId: string, state: MemoryState): Promise<void> {
    await this.writeJsonAtomic(
      path.join(this.agentDir(agentId), "state.json"),
      state,
    );
  }

  async readCheckpoint(agentId: string): Promise<CheckpointSnapshot | null> {
    const parsed = await this.readJson<CheckpointSnapshot>(
      path.join(this.agentDir(agentId), "checkpoint.json"),
      agentId,
    );
    if (!parsed || typeof parsed.version !== "number") return null;
    return parsed;
  }

  /** Writes `checkpoint.json` plus an immutable `checkpoint_v<N>.json` copy. */
  async writeCheckpoint(
    agentId: string,
    checkpoint: CheckpointSnapshot,
  ): Promise<void> {
    const directory = this.agentDir(agentId);
    await this.writeJsonAtomic(
      path.join(directory, "checkpoint_v" + checkpoint.version + ".json"),
      checkpoint,
    );
    await this.writeJsonAtomic(
      path.join(directory, "checkpoint.json"),
      checkpoint,
    );
    // `checkpoint.json` is always the live one; the versioned copies are an
    // audit convenience, so only the most recent few are worth keeping.
    await this.pruneNewestFirst(
      directory,
      /^checkpoint_v(\d+)\.json$/,
      this.retention.maxCheckpointVersions,
    );
  }

  /**
   * Rolls `<file>` to `<file>.1` once it passes the size cap, keeping exactly
   * one previous generation. Readers only ever look at the live file, so a
   * roll costs history beyond the cap and nothing else.
   */
  private async rollIfLarge(filePath: string): Promise<void> {
    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (size < this.retention.maxJsonlBytes) return;
    await rename(filePath, filePath + ".1").catch(() => undefined);
  }

  /** Keeps the `keep` highest-numbered matches and deletes the rest. */
  private async pruneNewestFirst(
    directory: string,
    pattern: RegExp,
    keep: number,
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return;
    }
    const numbered = entries
      .map((name) => {
        const match = pattern.exec(name);
        return match?.[1] ? { name, version: Number.parseInt(match[1], 10) } : null;
      })
      .filter((item): item is { name: string; version: number } => item !== null)
      .sort((left, right) => right.version - left.version);
    for (const stale of numbered.slice(keep)) {
      await unlink(path.join(directory, stale.name)).catch(() => undefined);
    }
  }

  async readResidue(agentId: string): Promise<ResidueDelta[]> {
    const parsed = await this.readJson<ResidueDelta[]>(
      path.join(this.agentDir(agentId), "residue.json"),
      agentId,
    );
    return Array.isArray(parsed) ? parsed : [];
  }

  async writeResidue(agentId: string, residue: ResidueDelta[]): Promise<void> {
    await this.writeJsonAtomic(
      path.join(this.agentDir(agentId), "residue.json"),
      residue,
    );
  }

  /**
   * Append-only. No read-modify-write, so trace cost is O(1) per turn instead
   * of O(n) and the control plane's event loop does not grow a tail.
   */
  async appendEvent(event: MemoryEvent): Promise<void> {
    const directory = this.agentDir(event.agentId);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, "trace.jsonl");
    await this.rollIfLarge(target);
    const line = this.redactor.redact(JSON.stringify(event)) + "\n";
    await appendFile(target, line, { encoding: "utf8", mode: 0o600 });
  }

  /** Append-only, same rationale as the event trace. */
  async appendSteps(agentId: string, steps: readonly StepEvent[]): Promise<void> {
    if (steps.length === 0) return;
    const directory = this.agentDir(agentId);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, "steps.jsonl");
    await this.rollIfLarge(target);
    const payload =
      steps
        .map((step) => this.redactor.redact(JSON.stringify(step)))
        .join("\n") + "\n";
    await appendFile(target, payload, { encoding: "utf8", mode: 0o600 });
  }

  async readSteps(agentId: string, limit = 200): Promise<StepEvent[]> {
    return this.readJsonl<StepEvent>(agentId, "steps.jsonl", limit);
  }

  async readEvents(agentId: string, limit = 200): Promise<MemoryEvent[]> {
    return this.readJsonl<MemoryEvent>(agentId, "trace.jsonl", limit);
  }

  private async readJsonl<T>(
    agentId: string,
    fileName: string,
    limit: number,
  ): Promise<T[]> {
    let raw: string;
    try {
      raw = await readFile(path.join(this.agentDir(agentId), fileName), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const rows: T[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as T);
      } catch {
        // A torn final line is expected if the process died mid-append.
        // Skipping it is correct; every earlier line is still intact.
      }
    }
    return rows.slice(-limit);
  }

  /** Returns the host path of the written artifact. */
  async writeArtifact(
    agentId: string,
    name: string,
    content: string,
  ): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
      throw new Error("Unsafe artifact name: " + JSON.stringify(name));
    }
    const directory = this.artifactDir(agentId);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, name);
    await this.writeAtomic(target, this.redactor.redact(content));
    await this.pruneNewestFirst(
      directory,
      /^transcript_v(\d+)\.md$/,
      this.retention.maxArtifacts,
    );
    return target;
  }

  private async readJson<T>(
    filePath: string,
    agentId: string,
  ): Promise<T | null> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Never let one bad file wedge every future turn for this agent.
      // Quarantine it, record it in the trace, continue degraded.
      const quarantine = filePath + ".corrupt." + Date.now();
      await rename(filePath, quarantine).catch(() => undefined);
      await this.appendEvent({
        timestamp: new Date().toISOString(),
        agentId,
        runId: null,
        turnNumber: 0,
        type: "state_quarantined",
        detail: { file: path.basename(filePath), quarantine },
      }).catch(() => undefined);
      return null;
    }
  }

  private async writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    await this.writeAtomic(
      filePath,
      this.redactor.redact(JSON.stringify(data, null, 2)) + "\n",
    );
  }

  private async writeAtomic(filePath: string, content: string): Promise<void> {
    const directory = path.dirname(filePath);
    await mkdir(directory, { recursive: true });
    const temporary =
      filePath + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2);
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
    // Not portable (EISDIR / EPERM on some platforms); durability of the
    // rename itself is best-effort by design.
    try {
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // ignored on platforms that do not support directory fsync
    }
  }
}
