import { describe, expect, it } from "vitest";
import { planSeatSpecChanges, assessSpecApplyGate } from "../src/domain/rig-spec-apply-plan.js";

const existing = [
  { seat: "worker@rig", fields: { model: "old", env: { MODE: "safe" } }, running: true },
  { seat: "reviewer@rig", fields: { model: "same" }, running: true },
  { seat: "idle@rig", fields: { model: "old" }, running: false },
];
const desired = [
  { seat: "worker@rig", fields: { model: "new", env: { MODE: "new" } } },
  { seat: "reviewer@rig", fields: { model: "same" } },
  { seat: "idle@rig", fields: { model: "new" } },
];

describe("conservative per-seat spec apply plan", () => {
  it("names changed fields and the relaunch boundary without echoing their values", () => {
    const plan = planSeatSpecChanges(existing, desired);
    expect(plan).toEqual([
      { seat: "idle@rig", wasRunning: false, changes: [{ field: "model", mode: "relaunch" }] },
      { seat: "worker@rig", wasRunning: true, changes: [
        { field: "env", mode: "relaunch" }, { field: "model", mode: "relaunch" },
      ] },
    ]);
    expect(JSON.stringify(plan)).not.toContain("safe");
    expect(JSON.stringify(plan)).not.toContain("new");
  });
  it("refuses busy/claimed seats and waits only when explicitly asked", () => {
    const plan = planSeatSpecChanges(existing, desired);
    const held = [{ seat: "worker@rig", state: "pending", claimedAt: "2026-01-01" }];
    expect(assessSpecApplyGate(plan, held, false)).toEqual({ status: "refused", busySeats: ["worker@rig"], relaunchSeats: [] });
    expect(assessSpecApplyGate(plan, held, true)).toEqual({ status: "waiting-idle", busySeats: ["worker@rig"], relaunchSeats: [] });
  });
  it("preserves intentionally stopped seats and never relaunches unchanged seats", () => {
    const plan = planSeatSpecChanges(existing, desired);
    expect(assessSpecApplyGate(plan, [], false)).toEqual({ status: "ready", busySeats: [], relaunchSeats: ["worker@rig"] });
  });
  it("rejects duplicate identifiers rather than silently losing seats", () => {
    expect(() => planSeatSpecChanges([existing[0]!, existing[0]!], desired)).toThrow(/duplicate seat/);
  });
});
