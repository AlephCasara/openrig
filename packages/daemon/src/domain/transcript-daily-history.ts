/** Offline, idempotent transcript usage projection. Not a persistent database or provider ledger.
 * Dollar figures are estimates only when all model rates are configured. */
export interface TranscriptUsageRow {
  seat: string; sessionId: string; messageId: string; model: string; atMs: number;
  inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number;
}
export interface ModelTokenRates { input: number; output: number; cacheWrite: number; cacheRead: number }
export interface DailyHistory {
  seat: string; dayUtc: string; model: string; messages: number;
  inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number;
  estimatedUsd: number | null;
}
const tokenFields = ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens"] as const;

export function aggregateTranscriptDailyHistory(
  rows: readonly TranscriptUsageRow[], prices: Readonly<Record<string, ModelTokenRates>>,
): DailyHistory[] {
  const messages = new Map<string, TranscriptUsageRow>();
  for (const row of rows) {
    if (![row.seat, row.sessionId, row.messageId, row.model].every(x => typeof x === "string" && x.length > 0)
      || !Number.isFinite(row.atMs) || Math.abs(row.atMs) > 8.64e15
      || tokenFields.some(key => !Number.isSafeInteger(row[key]) || row[key] < 0)) throw new Error("invalid transcript usage row");
    const id = `${row.sessionId}\0${row.messageId}`;
    const previous = messages.get(id);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error("contradictory transcript message duplicate");
    messages.set(id, row);
  }
  const grouped = new Map<string, DailyHistory>();
  for (const row of messages.values()) {
    const dayUtc = new Date(row.atMs).toISOString().slice(0, 10);
    const id = JSON.stringify([row.seat, dayUtc, row.model]);
    const current = grouped.get(id) ?? {
      seat: row.seat, dayUtc, model: row.model, messages: 0,
      inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, estimatedUsd: 0,
    };
    current.messages++;
    for (const field of tokenFields) current[field] += row[field];
    const price = prices[row.model];
    if (!price || [price.input, price.output, price.cacheWrite, price.cacheRead].some(x => !Number.isFinite(x) || x < 0)) {
      current.estimatedUsd = null;
    } else if (current.estimatedUsd !== null) {
      current.estimatedUsd += (row.inputTokens * price.input + row.outputTokens * price.output
        + row.cacheWriteTokens * price.cacheWrite + row.cacheReadTokens * price.cacheRead) / 1_000_000;
    }
    grouped.set(id, current);
  }
  return [...grouped.values()].sort((a, b) => a.dayUtc.localeCompare(b.dayUtc)
    || a.seat.localeCompare(b.seat) || a.model.localeCompare(b.model));
}
