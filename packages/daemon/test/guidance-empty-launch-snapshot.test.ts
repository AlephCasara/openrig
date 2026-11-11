import { describe, expect, it } from "vitest";
import { guidanceSnapshot, compareGuidanceSnapshots } from "../src/domain/guidance-drift.js";

describe("guidance drift from empty-but-known launch snapshot (#9)", () => {
  it("marks a newly added culture file stale when launch evidence says zero sources", () => {
    const current = guidanceSnapshot([{ path: "culture.md", content: "new instructions" }]);
    expect(compareGuidanceSnapshots([], current)).toEqual({ status: "stale", changedPaths: ["culture.md"] });
  });
  it("distinguishes known-empty from absent evidence", () => {
    expect(compareGuidanceSnapshots([], [])).toEqual({ status: "current", changedPaths: [] });
    expect(compareGuidanceSnapshots(null, [])).toEqual({ status: "unknown", changedPaths: [] });
    expect(compareGuidanceSnapshots([], null)).toEqual({ status: "unknown", changedPaths: [] });
  });
});
