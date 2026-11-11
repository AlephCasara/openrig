/** Pure estimate for provider quota windows. Values are percentage POINTS, not fractions.
 * Never mix samples from different provider accounts: callers partition by login/window first.
 * This does not infer unknown provider-side usage or guarantee account-wide coverage. */
export interface AllowanceProjectionInput {
  usedPercent: number;
  pointsPerDay: number | null;
  nowMs: number;
  resetAtMs: number;
}

export interface AllowanceProjection {
  status: "projected" | "unknown-slope" | "expired-window" | "invalid-input";
  dailyBudgetPoints: number | null;
  hoursToExhaustion: number | null;
  exhaustionAtMs: number | null;
  exhaustsBeforeReset: boolean;
}

export function forecastAllowance(input: AllowanceProjectionInput): AllowanceProjection {
  const { usedPercent, pointsPerDay, nowMs, resetAtMs } = input;
  const unavailable = (status: AllowanceProjection["status"]): AllowanceProjection => ({
    status, dailyBudgetPoints: null, hoursToExhaustion: null,
    exhaustionAtMs: null, exhaustsBeforeReset: false,
  });
  if (![usedPercent, nowMs, resetAtMs].every(Number.isFinite)
      || usedPercent < 0 || usedPercent > 100
      || (pointsPerDay !== null && !Number.isFinite(pointsPerDay))) {
    return unavailable("invalid-input");
  }
  if (resetAtMs <= nowMs) return unavailable("expired-window");
  if (pointsPerDay === null) return unavailable("unknown-slope");
  const remaining = 100 - usedPercent;
  const daysToReset = (resetAtMs - nowMs) / 86_400_000;
  const dailyBudgetPoints = remaining / daysToReset;
  const hoursToExhaustion = remaining === 0 ? 0 : pointsPerDay > 0 ? remaining / pointsPerDay * 24 : null;
  const exhaustionAtMs = hoursToExhaustion === null ? null : nowMs + hoursToExhaustion * 3_600_000;
  return {
    status: "projected", dailyBudgetPoints, hoursToExhaustion, exhaustionAtMs,
    exhaustsBeforeReset: exhaustionAtMs !== null && exhaustionAtMs < resetAtMs,
  };
}

/** One transition event per crossing. Persist the previous state per provider login/window. */
export function transitionAllowanceAlert(previousAtRisk: boolean, currentAtRisk: boolean): "exhaustion-risk" | "recovered" | null {
  if (previousAtRisk === currentAtRisk) return null;
  return currentAtRisk ? "exhaustion-risk" : "recovered";
}
