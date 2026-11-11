import { describe, expect, it } from "vitest";
import { summarizeStartupContext } from "../src/domain/startup-context-report.js";

describe("offline startup source report (#26)", () => {
  it("sorts three largest sources and flags over-limit seats without guessing tokens", () => {
    const r = summarizeStartupContext([
      { name: "common", bytes: 9000, tokens: 2100 },
      { name: "worker", bytes: 2000, tokens: 500 },
      { name: "hook", bytes: 12000, tokens: 3100 },
      { name: "tools", bytes: 1000, tokens: null },
    ], 5000);
    expect(r.topSources.map(s => s.name)).toEqual(["hook", "common", "worker"]);
    expect(r.firstTurnTokens).toBe(null);
    expect(r.overBudget).toBe(null);
    expect(r.totalBytes).toBe(24000);
  });
  it("compares fully measured tokens to a configurable ceiling", () => {
    const r = summarizeStartupContext([{ name: "hook", bytes: 100, tokens: 70 }, { name: "shared", bytes: 200, tokens: 50 }], 100);
    expect(r.firstTurnTokens).toBe(120);
    expect(r.overBudget).toBe(true);
    expect(summarizeStartupContext([{ name: "hook", bytes: 100, tokens: 70 }], 100).overBudget).toBe(false);
  });
  it("rejects empty source names, negative sizes, and invalid ceilings", () => {
    expect(() => summarizeStartupContext([{ name: "", bytes: 1, tokens: 1 }], 100)).toThrow();
    expect(() => summarizeStartupContext([{ name: "a", bytes: -1, tokens: 1 }], 100)).toThrow();
    expect(() => summarizeStartupContext([], 0)).toThrow();
  });
});
