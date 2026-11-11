import { describe, expect, it } from "vitest";
import { forecastAllowance, transitionAllowanceAlert } from "../src/domain/weekly-allowance-forecast.js";

describe("weekly allowance projection (offline)", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  it("projects 74% with 33 points/day to exhaust in ~19 hours, with 7.65 points/day budget", () => {
    const result = forecastAllowance({ usedPercent: 74, pointsPerDay: 33, nowMs: now, resetAtMs: now + 3.4 * 86400000 });
    expect(result.status).toBe("projected");
    expect(result.hoursToExhaustion).toBeCloseTo(26 / 33 * 24, 4);
    expect(result.dailyBudgetPoints).toBeCloseTo(26 / 3.4, 4);
    expect(result.exhaustsBeforeReset).toBe(true);
  });
  it("keeps distinct provider logins isolated, with no blended series", () => {
    const a = forecastAllowance({ usedPercent: 74, pointsPerDay: 33, nowMs: now, resetAtMs: now + 3.4 * 86400000 });
    const b = forecastAllowance({ usedPercent: 20, pointsPerDay: 1, nowMs: now, resetAtMs: now + 3.4 * 86400000 });
    expect(a.exhaustsBeforeReset).toBe(true);
    expect(b.exhaustsBeforeReset).toBe(false);
  });
  it("does not pretend unknown slope or expired windows are forecasts", () => {
    expect(forecastAllowance({ usedPercent: 20, pointsPerDay: null, nowMs: now, resetAtMs: now + 1000 }).status).toBe("unknown-slope");
    expect(forecastAllowance({ usedPercent: 20, pointsPerDay: 2, nowMs: now, resetAtMs: now }).status).toBe("expired-window");
    expect(forecastAllowance({ usedPercent: 200, pointsPerDay: 2, nowMs: now, resetAtMs: now + 1000 }).status).toBe("invalid-input");
  });
  it("reports threshold state only on crossing and once on recovery", () => {
    expect(transitionAllowanceAlert(false, true)).toBe("exhaustion-risk");
    expect(transitionAllowanceAlert(true, true)).toBe(null);
    expect(transitionAllowanceAlert(true, false)).toBe("recovered");
    expect(transitionAllowanceAlert(false, false)).toBe(null);
  });
  it("handles exhausted, zero-slope and negative-slope windows without division by zero", () => {
    expect(forecastAllowance({ usedPercent: 100, pointsPerDay: 5, nowMs: now, resetAtMs: now + 100000 }).hoursToExhaustion).toBe(0);
    expect(forecastAllowance({ usedPercent: 50, pointsPerDay: 0, nowMs: now, resetAtMs: now + 100000 }).hoursToExhaustion).toBe(null);
    expect(forecastAllowance({ usedPercent: 50, pointsPerDay: -2, nowMs: now, resetAtMs: now + 100000 }).exhaustsBeforeReset).toBe(false);
  });
});
