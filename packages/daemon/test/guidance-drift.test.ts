import { describe, expect, it } from "vitest";
import { guidanceSnapshot, compareGuidanceSnapshots } from "../src/domain/guidance-drift.js";

describe("per-occupant guidance snapshot diff", () => {
  const original = guidanceSnapshot([{ path: "culture.md", content: "original rules" }, { path: "worker.md", content: "worker guidance" }]);
  const updated = guidanceSnapshot([{ path: "culture.md", content: "new rules" }, { path: "worker.md", content: "worker guidance" }]);

  it("marks an occupant launched before the edit stale and one launched after current", () => {
    expect(compareGuidanceSnapshots(original, updated)).toEqual({ status: "stale", changedPaths: ["culture.md"] });
    expect(compareGuidanceSnapshots(updated, updated)).toEqual({ status: "current", changedPaths: [] });
  });

  it("treats missing captured provenance as unknown, never current", () => {
    expect(compareGuidanceSnapshots(null, updated)).toEqual({ status: "unknown", changedPaths: [] });
    // An empty array is a captured, known-empty launch; null means missing capture.
    expect(compareGuidanceSnapshots([], updated)).toEqual({ status: "stale", changedPaths: ["culture.md", "worker.md"] });
  });

  it("flags added or removed guidance files without requiring a live seat", () => {
    expect(compareGuidanceSnapshots(original, guidanceSnapshot([{ path: "culture.md", content: "original rules" }]))).toEqual({
      status: "stale", changedPaths: ["worker.md"],
    });
    expect(compareGuidanceSnapshots(original, guidanceSnapshot([
      { path: "culture.md", content: "original rules" }, { path: "worker.md", content: "worker guidance" },
      { path: "reviewer.md", content: "new guidance" },
    ]))).toEqual({ status: "stale", changedPaths: ["reviewer.md"] });
  });

  it("deduplicates identical source bytes deterministically but refuses contradictory duplicate paths", () => {
    expect(guidanceSnapshot([{ path: "x.md", content: "x" }, { path: "x.md", content: "x" }])).toHaveLength(1);
    expect(() => guidanceSnapshot([{ path: "x.md", content: "x" }, { path: "x.md", content: "y" }])).toThrow(/conflicting guidance/);
  });
});
