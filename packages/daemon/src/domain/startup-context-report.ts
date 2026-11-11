/** Deterministic offline projection for context startup sources. Does not estimate tokens
 * from bytes; an unmeasured source makes the entire token total unknown. */
export interface StartupSource { name: string; bytes: number; tokens: number | null }
export interface StartupContextReport {
  firstTurnTokens: number | null;
  totalBytes: number;
  topSources: StartupSource[];
  overBudget: boolean | null;
}

export function summarizeStartupContext(sources: readonly StartupSource[], limitTokens: number): StartupContextReport {
  if (!Number.isSafeInteger(limitTokens) || limitTokens < 1) throw new Error("invalid startup token limit");
  if (sources.some(s => !s.name.trim() || !Number.isSafeInteger(s.bytes) || s.bytes < 0
    || (s.tokens !== null && (!Number.isSafeInteger(s.tokens) || s.tokens < 0)))) {
    throw new Error("invalid startup source");
  }
  if (new Set(sources.map(s => s.name)).size !== sources.length) throw new Error("duplicate startup source");
  const complete = sources.every(s => s.tokens !== null);
  const firstTurnTokens = complete ? sources.reduce((sum, s) => sum + (s.tokens ?? 0), 0) : null;
  const totalBytes = sources.reduce((sum, s) => sum + s.bytes, 0);
  const topSources = [...sources].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)).slice(0, 3);
  return {
    firstTurnTokens, totalBytes, topSources,
    overBudget: firstTurnTokens === null ? null : firstTurnTokens > limitTokens,
  };
}
