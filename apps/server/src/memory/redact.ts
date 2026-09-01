const REDACTED = "[REDACTED]";

/** Minimum length for a configured literal to be worth redacting. */
const MIN_LITERAL_LENGTH = 8;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * High-precision patterns: the entire match is unambiguously a credential.
 * Safe to apply to user-authored text, because a false positive would have to
 * be a string that genuinely looks like a provider key.
 */
const WHOLE_MATCH_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * Low-precision heuristics: `<something>key: <value>` shapes. Capture group 1
 * is redacted and the surrounding context kept.
 *
 * These are NOT safe for user-authored prose. A live smoke test caught them
 * destroying a task objective -- "Remember this token: ORDER-4471-ZULU"
 * became "[REDACTED]" -- which is the one string the checkpoint is supposed
 * to preserve verbatim. They are therefore confined to machine-generated
 * content (shell commands, tool previews), where losing a value to caution
 * costs a trace detail rather than the agent's goal.
 */
const HEURISTIC_PATTERNS: RegExp[] = [
  /\b(?:authorization|bearer)\b["'\s:=]+([A-Za-z0-9._~+/-]{16,}={0,2})/gi,
  /\b[A-Za-z0-9_-]*(?:api[_-]?key|secret|passwd|password|credential)[A-Za-z0-9_-]*\b\s*[:=]\s*["']?([^\s"',;}]{8,})/gi,
];

export interface Redactor {
  /**
   * High precision. Applied to everything persisted, including user prompts,
   * assistant output, and the checkpoint objective.
   */
  redact(text: string): string;
  /**
   * High precision plus heuristics. For machine-generated content only:
   * shell commands, tool arguments, step previews.
   */
  redactMachine(text: string): string;
}

export function createRedactor(literals: readonly string[] = []): Redactor {
  const literalPatterns = literals
    .map((literal) => literal.trim())
    .filter((literal) => literal.length >= MIN_LITERAL_LENGTH)
    .sort((left, right) => right.length - left.length)
    .map((literal) => new RegExp(escapeRegExp(literal), "g"));

  const strict = (text: string): string => {
    if (!text) return text;
    let output = text;
    for (const pattern of literalPatterns) output = output.replace(pattern, REDACTED);
    for (const pattern of WHOLE_MATCH_PATTERNS) output = output.replace(pattern, REDACTED);
    return output;
  };

  return {
    redact: strict,
    redactMachine(text: string): string {
      if (!text) return text;
      let output = strict(text);
      for (const pattern of HEURISTIC_PATTERNS) {
        output = output.replace(pattern, (match, secret: string) => {
          const index = match.lastIndexOf(secret);
          return index < 0 ? REDACTED : match.slice(0, index) + REDACTED;
        });
      }
      return output;
    },
  };
}

/** A redactor that does nothing. Only for tests that assert raw passthrough. */
export const nullRedactor: Redactor = {
  redact: (text) => text,
  redactMachine: (text) => text,
};
