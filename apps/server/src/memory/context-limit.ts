/**
 * Context-window resolution for the compaction trigger.
 *
 * Deliberately fail-closed. The platform's model id comes from `ARK_MODEL`,
 * which is frequently an opaque endpoint id (`ep-2024...`). Guessing a limit
 * for an unknown id and defaulting to a large number is how you get the
 * context-overflow error the middleware exists to prevent, so an unknown model
 * disables compaction and says so in the trace instead.
 */
export type ContextLimitSource = "env" | "table" | "unknown";

export interface ContextLimitResolution {
  modelName: string;
  limit: number | null;
  source: ContextLimitSource;
}

/**
 * Exact-match convenience entries only. `MEMORY_CONTEXT_LIMIT` is the
 * authoritative, supported way to configure this.
 */
export const KNOWN_CONTEXT_LIMITS: Readonly<Record<string, number>> = {
  "gpt-5-codex": 400_000,
  "gpt-5": 400_000,
  "gpt-5.1": 400_000,
};

export function resolveContextLimit(
  modelName: string,
  envOverride?: string | undefined,
): ContextLimitResolution {
  const name = modelName.trim();

  const override = envOverride?.trim();
  if (override) {
    const parsed = Number.parseInt(override, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return { modelName: name, limit: parsed, source: "env" };
    }
  }

  const known = KNOWN_CONTEXT_LIMITS[name];
  if (typeof known === "number") {
    return { modelName: name, limit: known, source: "table" };
  }

  return { modelName: name, limit: null, source: "unknown" };
}

/**
 * The trigger sits below the hard ceiling because the decision is made from
 * the *previous* turn's measured usage. Between that measurement and the next
 * prefill the context can still grow by one full turn, so the gap between
 * `triggerPct` and 1.0 has to cover one turn plus generation headroom.
 */
export const DEFAULT_TRIGGER_PCT = 0.7;

export function compactionTrigger(
  limit: number,
  triggerPct: number = DEFAULT_TRIGGER_PCT,
): number {
  return Math.floor(limit * triggerPct);
}
