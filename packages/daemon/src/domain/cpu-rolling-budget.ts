/** Offline, side-effect-free CPU budget projection. Measurements are host CPU fractions in [0,100].
 * Each interval represents its average across [startMs,endMs); overlapping samples are invalid.
 * Callers must not treat missing samples as zero load or as a complete window. */
export interface CpuInterval { startMs: number; endMs: number; percent: number }
export interface CpuWindow { nowMs: number; windowMs: number; thresholdPercent: number }
export interface CpuProjection {
  status: "complete" | "insufficient-coverage" | "invalid-input";
  averagePercent: number | null;
  overThreshold: boolean | null;
}

export function rollingCpuPercent(intervals: readonly CpuInterval[], window: CpuWindow): CpuProjection {
  const invalid: CpuProjection = { status: "invalid-input", averagePercent: null, overThreshold: null };
  const incomplete: CpuProjection = { status: "insufficient-coverage", averagePercent: null, overThreshold: null };
  const { nowMs, windowMs, thresholdPercent } = window;
  if (![nowMs, windowMs, thresholdPercent].every(Number.isFinite)
      || windowMs <= 0 || thresholdPercent < 0 || thresholdPercent > 100) return invalid;
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  if (sorted.some(s => ![s.startMs, s.endMs, s.percent].every(Number.isFinite)
    || s.endMs <= s.startMs || s.percent < 0 || s.percent > 100)) return invalid;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.startMs < sorted[i - 1]!.endMs) return invalid;
  }
  const start = nowMs - windowMs;
  let covered = 0;
  let weighted = 0;
  for (const sample of sorted) {
    const duration = Math.max(0, Math.min(nowMs, sample.endMs) - Math.max(start, sample.startMs));
    covered += duration;
    weighted += duration * sample.percent;
  }
  if (Math.abs(covered - windowMs) > 0.000001) return incomplete;
  const averagePercent = weighted / windowMs;
  return { status: "complete", averagePercent, overThreshold: averagePercent >= thresholdPercent };
}

/** Persist the last alert state per rig and only emit a state-edge, not every repeated sample. */
export function cpuAlertTransition(previous: boolean, next: boolean | null): "over-budget" | "recovered" | null {
  if (next === null || next === previous) return null;
  return next ? "over-budget" : "recovered";
}
