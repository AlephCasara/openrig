/** Offline approximation: attribute a call to the latest custody row on the same seat.
 * No active mission => overhead. Real telemetry integration must use stable request IDs,
 * real queue custody state, and explain attribution uncertainty to operators. */
export interface TokenKinds { freshInput: number; cacheWrite: number; cacheRead: number; output: number }
export interface MissionCustody { seat: string; atMs: number; mission: string | null; role: string }
export interface UsageCall { seat: string; atMs: number; tokens: TokenKinds; estimatedUsd: number | null }
export interface MissionTotal {
  calls: number; tokens: TokenKinds; totalTokens: number;
  estimatedUsd: number | null; unpricedCalls: number;
  byRole: Record<string, MissionTotal>;
}
export interface MissionProjection { missions: Record<string, MissionTotal>; overhead: MissionTotal }

const emptyTokens = (): TokenKinds => ({ freshInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
const emptyTotal = (): MissionTotal => ({ calls: 0, tokens: emptyTokens(), totalTokens: 0, estimatedUsd: 0, unpricedCalls: 0, byRole: {} });
const tokenKeys = ["freshInput", "cacheWrite", "cacheRead", "output"] as const;
function increment(total: MissionTotal, call: UsageCall): void {
  total.calls++;
  for (const key of tokenKeys) {
    total.tokens[key] += call.tokens[key];
    total.totalTokens += call.tokens[key];
  }
  if (call.estimatedUsd === null) {
    total.unpricedCalls++;
    total.estimatedUsd = null;
  } else if (total.estimatedUsd !== null) {
    total.estimatedUsd += call.estimatedUsd;
  }
}
export function attributeMissionUsage(rows: readonly MissionCustody[], calls: readonly UsageCall[]): MissionProjection {
  const ordered = [...rows].sort((a, b) => a.atMs - b.atMs);
  const lastBySeat = new Map<string, number>();
  for (const row of ordered) {
    if (!row.seat || !row.role || !Number.isFinite(row.atMs)) throw new Error("invalid mission custody row");
    if (row.mission === "" || (lastBySeat.get(row.seat) ?? -Infinity) >= row.atMs) throw new Error("ambiguous custody chronology");
    lastBySeat.set(row.seat, row.atMs);
  }
  const bySeat = new Map<string, MissionCustody[]>();
  for (const row of ordered) {
    const seatRows = bySeat.get(row.seat) ?? [];
    seatRows.push(row);
    bySeat.set(row.seat, seatRows);
  }
  const result: MissionProjection = { missions: {}, overhead: emptyTotal() };
  for (const call of calls) {
    if (!call.seat || !Number.isFinite(call.atMs) || (call.estimatedUsd !== null && (!Number.isFinite(call.estimatedUsd) || call.estimatedUsd < 0))
      || tokenKeys.some(key => !Number.isSafeInteger(call.tokens[key]) || call.tokens[key] < 0)) throw new Error("invalid usage call");
    const seatRows = bySeat.get(call.seat) ?? [];
    let active: MissionCustody | undefined;
    for (const row of seatRows) {
      if (row.atMs > call.atMs) break;
      active = row;
    }
    const total = active?.mission ? (result.missions[active.mission] ??= emptyTotal()) : result.overhead;
    increment(total, call);
    if (active?.mission) increment(total.byRole[active.role] ??= emptyTotal(), call);
  }
  return result;
}
