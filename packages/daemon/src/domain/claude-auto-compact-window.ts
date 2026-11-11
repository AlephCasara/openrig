/** Validate a proposed per-seat Claude compaction window without invoking a seat.
 * Claude's precedence between settings.env and the process environment requires live verification. */
export function parseAutoCompactWindow(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > 1_000_000) {
    throw new Error("auto-compact window must be a positive integer token count <= 1000000");
  }
  return raw;
}

/** Side-effect-free settings projection: preserves caller settings and existing env keys. */
export function addAutoCompactWindowToSettings<T extends Record<string, unknown>>(
  settings: T, windowTokens: number | undefined,
): T & { env?: Record<string, string> } {
  if (windowTokens === undefined) return { ...settings };
  const count = parseAutoCompactWindow(windowTokens);
  const env = settings.env;
  if (env !== undefined && (env === null || typeof env !== "object" || Array.isArray(env))) {
    throw new Error("Claude settings.env must be a mapping");
  }
  return { ...settings, env: { ...(env as Record<string, string> | undefined), CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(count) } };
}
