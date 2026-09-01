import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import type {
  MemoryInterceptor,
  StepTraceCollector,
} from "./memory/index.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  RunUsage,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

/** How often an in-flight Run flushes its step timeline to disk. */
const STEP_FLUSH_INTERVAL_MS = 750;

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    /**
     * Optional so the platform runs unchanged without it, and so a memory
     * failure can never be a reason a Run does not execute.
     */
    private readonly memory: MemoryInterceptor | null = null,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  /** Glass Box trace for one Agent: measured counters plus recent events. */
  async memoryTrace(agentId: string): Promise<Record<string, unknown>> {
    this.getAgent(agentId);
    if (!this.memory) {
      return { enabled: false, stats: null, events: [], steps: [] };
    }
    const [stats, events, steps] = await Promise.all([
      this.memory.stats(agentId),
      this.memory.events(agentId),
      this.memory.steps(agentId),
    ]);
    return { enabled: true, stats, events, steps };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    const turn = await this.prepareTurn(agentAtStart, run);
    const collector =
      this.memory?.createStepCollector(agentAtStart.id, run.id) ?? null;
    // Guarded at construction: a tracing fault must never surface inside the
    // runner's stdout hot path.
    const onEventLine = collector
      ? (line: string) => {
          try {
            collector.ingestLine(line);
          } catch {
            // tracing is best-effort
          }
        }
      : undefined;
    const startedAtMs = Date.now();
    const stopFlushing = this.startStepFlush(collector);
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: turn.prompt,
        threadId: turn.threadId,
        onEventLine,
      });
      const completedAt = now();
      await stopFlushing();
      await this.recordTurn(agentAtStart.id, run, turn, {
        status: "completed",
        output: result.output,
        usage: result.usage,
        durationMs: Date.now() - startedAtMs,
      });
      await this.recordSteps(collector, turn.turnNumber);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      await stopFlushing();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      // Recorded on the failure path too. A cancelled or failed turn must
      // clear the pending marker, otherwise the next turn would misread it
      // as an unrecovered crash.
      await this.recordTurn(agentAtStart.id, run, turn, {
        status: "failed",
        output: message,
        usage: null,
        durationMs: Date.now() - startedAtMs,
      });
      await this.recordSteps(collector, turn.turnNumber);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    }
  }

  /**
   * Persists step events while the Run is still executing.
   *
   * Without this the timeline only reached disk once `AgentRunner.run`
   * returned, so the Glass Box panel stayed empty for the entire Run -- on a
   * seven-minute task that is indistinguishable from a hung platform, which is
   * exactly the diagnosis the trace exists to prevent. Returns a stop function
   * that clears the ticker and flushes whatever is left.
   */
  private startStepFlush(
    collector: StepTraceCollector | null,
  ): () => Promise<void> {
    if (!this.memory || !collector) return async () => {};
    const memory = this.memory;
    let inFlight = false;
    const flush = async () => {
      // Appends are not re-entrant safe, and a slow disk must not queue a
      // second writer behind the first.
      if (inFlight) return;
      inFlight = true;
      try {
        await memory.flushSteps(collector);
      } catch {
        // Telemetry must not fail a Run.
      } finally {
        inFlight = false;
      }
    };
    const ticker = setInterval(() => void flush(), STEP_FLUSH_INTERVAL_MS);
    // Never hold the process open for a telemetry timer.
    ticker.unref();
    return async () => {
      clearInterval(ticker);
      await flush();
    };
  }

  private async recordSteps(
    collector: StepTraceCollector | null,
    turnNumber: number,
  ): Promise<void> {
    if (!this.memory || !collector) return;
    try {
      await this.memory.recordSteps(collector.summary(), turnNumber);
    } catch {
      // Telemetry must not fail a Run.
    }
  }

  /**
   * Never throws: if the middleware is unavailable or fails, the turn runs
   * exactly as it would on the unmodified platform.
   */
  private async prepareTurn(
    agent: Agent,
    run: AgentRun,
  ): Promise<{ prompt: string; threadId: string | null; turnNumber: number }> {
    const fallback = {
      prompt: run.prompt,
      threadId: agent.codexThreadId,
      turnNumber: 0,
    };
    if (!this.memory) return fallback;
    try {
      const plan = await this.memory.prepareTurn({
        agentId: agent.id,
        runId: run.id,
        prompt: run.prompt,
        threadId: agent.codexThreadId,
      });
      return {
        prompt: plan.prompt,
        threadId: plan.threadId,
        turnNumber: plan.turnNumber,
      };
    } catch {
      return fallback;
    }
  }

  private async recordTurn(
    agentId: string,
    run: AgentRun,
    turn: { turnNumber: number },
    outcome: {
      status: "completed" | "failed";
      output: string;
      usage: RunUsage | null;
      durationMs: number;
    },
  ): Promise<void> {
    if (!this.memory || turn.turnNumber === 0) return;
    try {
      await this.memory.recordTurn({
        agentId,
        runId: run.id,
        turnNumber: turn.turnNumber,
        userPrompt: run.prompt,
        assistantOutput: outcome.output,
        status: outcome.status,
        usage: outcome.usage,
        durationMs: outcome.durationMs,
      });
    } catch {
      // Telemetry must not fail a Run.
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
