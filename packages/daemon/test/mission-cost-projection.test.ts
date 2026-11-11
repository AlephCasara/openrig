import { describe, expect, it } from "vitest";
import { attributeMissionUsage } from "../src/domain/mission-cost-projection.js";

const tokens = (freshInput: number, cacheWrite: number, cacheRead: number, output: number) => ({ freshInput, cacheWrite, cacheRead, output });

describe("mission usage attribution offline (#24)", () => {
  const custody = [
    { seat: "worker", atMs: 1, mission: "M1", role: "implementer" },
    { seat: "reviewer", atMs: 2, mission: "M1", role: "reviewer" },
    { seat: "worker", atMs: 8, mission: "M2", role: "implementer" },
    { seat: "reviewer", atMs: 9, mission: null, role: "reviewer" },
  ];
  it("joins two seats into one mission and preserves token-kind totals", () => {
    const calls = [
      { seat: "worker", atMs: 3, tokens: tokens(10, 2, 3, 4), estimatedUsd: 0.2 },
      { seat: "reviewer", atMs: 4, tokens: tokens(5, 1, 3, 2), estimatedUsd: 0.3 },
      { seat: "worker", atMs: 10, tokens: tokens(4, 0, 0, 1), estimatedUsd: 0.1 },
    ];
    const result = attributeMissionUsage(custody, calls);
    expect(result.missions.M1?.calls).toBe(2);
    expect(result.missions.M1?.tokens).toEqual(tokens(15, 3, 6, 6));
    expect(result.missions.M1?.totalTokens).toBe(30);
    expect(result.missions.M1?.byRole.implementer?.calls).toBe(1);
    expect(result.missions.M1?.byRole.reviewer?.calls).toBe(1);
    expect(result.missions.M1?.estimatedUsd).toBeCloseTo(0.5);
    expect(result.missions.M2?.calls).toBe(1);
  });
  it("classifies calls without an active row as overhead, not dropped", () => {
    const calls = [
      { seat: "worker", atMs: 0, tokens: tokens(1, 0, 0, 1), estimatedUsd: 0.01 },
      { seat: "reviewer", atMs: 10, tokens: tokens(2, 0, 0, 1), estimatedUsd: 0.02 },
    ];
    const result = attributeMissionUsage(custody, calls);
    expect(result.overhead.calls).toBe(2);
    expect(result.overhead.totalTokens).toBe(5);
    expect(result.overhead.estimatedUsd).toBeCloseTo(0.03);
  });
  it("keeps unknown cost unknown instead of silently zeroing it", () => {
    const r = attributeMissionUsage(custody, [{ seat: "worker", atMs: 3, tokens: tokens(1, 1, 1, 1), estimatedUsd: null }]);
    expect(r.missions.M1?.estimatedUsd).toBe(null);
    expect(r.missions.M1?.unpricedCalls).toBe(1);
  });
  it("rejects invalid token counts and duplicate seat timestamps rather than double-billing", () => {
    expect(() => attributeMissionUsage(custody, [{ seat: "worker", atMs: 3, tokens: tokens(-1, 0, 0, 0), estimatedUsd: 0 }])).toThrow();
    expect(() => attributeMissionUsage([...custody, { seat: "worker", atMs: 1, mission: "M3", role: "lead" }], [])).toThrow();
  });
});
