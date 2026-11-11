import { describe, expect, it } from "vitest";
import { rollingCpuPercent, cpuAlertTransition } from "../src/domain/cpu-rolling-budget.js";

const minute = 60_000;
describe("offline host CPU rolling-average budget (#20)", () => {
  it("weights interval overlap rather than averaging sample counts", () => {
    const intervals = [
      { startMs: 0, endMs: 20 * minute, percent: 60 },
      { startMs: 20 * minute, endMs: 30 * minute, percent: 90 },
    ];
    const r = rollingCpuPercent(intervals, { nowMs: 30 * minute, windowMs: 30 * minute, thresholdPercent: 75 });
    expect(r.status).toBe("complete");
    expect(r.averagePercent).toBeCloseTo(70);
    expect(r.overThreshold).toBe(false);
  });
  it("raises on threshold crossing, only once, and reports recovery", () => {
    const intervals = [{ startMs: 0, endMs: 30 * minute, percent: 85.78 }];
    const r = rollingCpuPercent(intervals, { nowMs: 30 * minute, windowMs: 30 * minute, thresholdPercent: 75 });
    expect(r.overThreshold).toBe(true);
    expect(cpuAlertTransition(false, r.overThreshold)).toBe("over-budget");
    expect(cpuAlertTransition(true, r.overThreshold)).toBe(null);
    expect(cpuAlertTransition(true, false)).toBe("recovered");
  });
  it("does not treat sparse or gapped samples as a complete 30 minute window", () => {
    const r = rollingCpuPercent([{ startMs: 15 * minute, endMs: 30 * minute, percent: 100 }], { nowMs: 30 * minute, windowMs: 30 * minute, thresholdPercent: 75 });
    expect(r.status).toBe("insufficient-coverage");
    expect(r.averagePercent).toBe(null);
    expect(r.overThreshold).toBe(null);
  });
  it("rejects invalid and overlapping intervals to avoid double counting", () => {
    expect(rollingCpuPercent([{ startMs: 0, endMs: 10, percent: -1 }], { nowMs: 10, windowMs: 10, thresholdPercent: 75 }).status).toBe("invalid-input");
    expect(rollingCpuPercent([{ startMs: 0, endMs: 10, percent: 60 }, { startMs: 5, endMs: 20, percent: 70 }], { nowMs: 20, windowMs: 20, thresholdPercent: 75 }).status).toBe("invalid-input");
    expect(rollingCpuPercent([], { nowMs: 10, windowMs: 0, thresholdPercent: 75 }).status).toBe("invalid-input");
  });
  it("clips intervals to the requested horizon", () => {
    const r = rollingCpuPercent([{ startMs: 0, endMs: 40 * minute, percent: 80 }], { nowMs: 40 * minute, windowMs: 30 * minute, thresholdPercent: 75 });
    expect(r.status).toBe("complete");
    expect(r.averagePercent).toBe(80);
  });
});
