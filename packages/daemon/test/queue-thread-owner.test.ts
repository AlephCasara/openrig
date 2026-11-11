import { describe, expect, it } from "vitest";
import { threadOwners } from "../src/domain/queue-thread-owner.js";

const row = (sourceSession: string, state: string, at: string, mission: string | null, id: string) => ({
  qitemId: id, sourceSession, destinationSession: "person@host", state, tsCreated: at,
  tags: mission ? ["thread:root-row", `mission:${mission}`] : ["thread:root-row"],
});

describe("Slack thread owner inference from active queue rows", () => {
  it("ignores older, closed ownership even when its mission names the thread's original purpose", () => {
    const rows = [
      row("lead-b@rig", "in-progress", "2026-01-02T00:00:00Z", "migration", "b"),
      row("lead-a@rig", "done", "2026-01-01T00:00:00Z", "review", "a"),
    ];
    expect(threadOwners(rows, "root-row")).toEqual([{
      seat: "lead-b@rig", mission: "migration", qitemId: "b", tsCreated: "2026-01-02T00:00:00Z",
    }]);
  });
  it("returns empty for a thread with no open row and does not infer from closed history", () => {
    expect(threadOwners([row("lead-a@rig", "done", "2026-01-01T00:00:00Z", "review", "a")], "root-row")).toEqual([]);
  });
  it("returns each owning seat once, ordered by its latest row, with the latest mission", () => {
    expect(threadOwners([
      row("lead-a@rig", "pending", "2026-01-01T00:00:00Z", "old", "a1"),
      row("lead-b@rig", "blocked", "2026-01-04T00:00:00Z", "new", "b1"),
      row("lead-a@rig", "in-progress", "2026-01-03T00:00:00Z", "current", "a2"),
    ], "root-row")).toEqual([
      { seat: "lead-b@rig", mission: "new", qitemId: "b1", tsCreated: "2026-01-04T00:00:00Z" },
      { seat: "lead-a@rig", mission: "current", qitemId: "a2", tsCreated: "2026-01-03T00:00:00Z" },
    ]);
  });
  it("requires the exact thread tag and excludes external/human sources", () => {
    expect(threadOwners([
      { ...row("lead-a@rig", "pending", "2026-01-02T00:00:00Z", "x", "a"), tags: ["thread:root-row-extra"] },
      row("human@external", "pending", "2026-01-02T00:00:00Z", "x", "b"),
    ], "root-row")).toEqual([]);
  });
});
