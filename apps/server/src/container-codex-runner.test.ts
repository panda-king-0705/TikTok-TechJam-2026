import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildContainerRunArgs,
  containerName,
} from "./container-codex-runner.js";

describe("Container Codex runner", () => {
  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent/unsafe",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
      },
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    expect(args).toContain("type=bind,src=/tmp/codex-home,dst=/codex-home");
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
  });

  it("resumes a thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
      },
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
  });
});

describe("memory artifact mount", () => {
  const base = {
    NODE_ENV: "test" as const,
    CODEX_HOME: "/tmp/codex-home",
    RUNTIME_PROVIDER: "container" as const,
    APP_DATA_DIR: "/tmp/launchpad-data",
  };

  it("mounts the Agent's artifacts read-only so pointers resolve", () => {
    const config = loadConfig(base);
    const args = buildContainerRunArgs(
      {
        agentId: "agent-1",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: null,
      },
      config,
    );
    expect(args).toContain(
      "type=bind,src=/tmp/launchpad-data/memory/agent-1/artifacts," +
        "dst=/workspace/.memory/artifacts,readonly",
    );
    // Durable state itself never crosses the boundary.
    expect(args.join(" ")).not.toContain("checkpoint");
    expect(args.join(" ")).not.toContain(
      "src=/tmp/launchpad-data/memory/agent-1,",
    );
  });

  it("omits the mount when the middleware is disabled", () => {
    const args = buildContainerRunArgs(
      {
        agentId: "agent-1",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: null,
      },
      loadConfig({ ...base, MEMORY_ENABLED: "false" }),
    );
    expect(args.join(" ")).not.toContain(".memory/artifacts");
  });

  it("omits the mount for an agent id that is unsafe as a path segment", () => {
    const args = buildContainerRunArgs(
      {
        agentId: "../escape",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: null,
      },
      loadConfig(base),
    );
    expect(args.join(" ")).not.toContain(".memory/artifacts");
  });
});
