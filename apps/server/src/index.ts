import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import {
  MemoryInterceptor,
  MemoryStore,
  createRedactor,
  resolveContextLimit,
} from "./memory/index.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();

/**
 * Startup touches three configured directories before the logger exists, so a
 * bad path surfaces as a bare unhandled rejection with no hint at the cause.
 * The common case is a .env carrying the container profile's /app/... paths
 * into a host-side run, which fails with EACCES on a directory the host user
 * cannot create. Name the variable rather than printing a stack.
 */
function explainStartupFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const failedPath = (error as NodeJS.ErrnoException | null)?.path;
  if (code !== "EACCES" && code !== "EROFS" && code !== "ENOENT") return "";
  const culprit = (
    [
      ["APP_DATA_DIR", config.dataDirectory],
      ["AGENT_WORKSPACE_ROOT", config.workspaceRoot],
      ["CODEX_HOME", config.codexHome],
    ] as const
  ).find(([, value]) => failedPath && value.startsWith(failedPath));
  return (
    "\nCannot create " +
    (failedPath ?? "a configured directory") +
    (culprit ? " (from " + culprit[0] + "=" + culprit[1] + ")" : "") +
    ".\nIf this is a host-side run, comment the /app/... runtime paths out of" +
    " .env:\nthey belong to the Docker profile, which sets them in" +
    " docker-compose.yml already.\n"
  );
}

/** Every step here creates or writes a configured directory. */
async function startupStep<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    process.stderr.write(
      "Startup failed: " +
        (error instanceof Error ? error.message : String(error)) +
        explainStartupFailure(error) +
        "\n",
    );
    process.exit(1);
  }
}

await startupStep(() => writeCodexConfig(config));

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);

// The configured API key is redacted out of every artifact the middleware
// writes, so a leaked key cannot reach a checkpoint, transcript, or trace.
const memoryStore = new MemoryStore(
  config.memoryRoot,
  createRedactor([config.arkApiKey]),
);
const contextLimit = resolveContextLimit(
  config.arkModel,
  config.memoryContextLimit,
);
const memory = config.memoryEnabled
  ? new MemoryInterceptor(memoryStore, {
      contextLimit: contextLimit.limit,
      triggerPct: config.memoryTriggerPct,
      artifactMountPath: config.memoryArtifactMount,
    })
  : null;
if (memory) await startupStep(() => memory.initialize());

const service = new AgentService(config, store, workspaces, runner, memory);
await startupStep(() => service.initialize());

const app = await createApp(config, service);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
