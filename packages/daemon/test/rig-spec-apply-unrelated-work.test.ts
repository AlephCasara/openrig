import { describe, expect, it } from "vitest";
import { assessSpecApplyGate, type SeatApplyPlan } from "../src/domain/rig-spec-apply-plan.js";
const changed = (seat: string, running: boolean): SeatApplyPlan => ({ seat, wasRunning: running, changes: [{ field: "model", mode: "relaunch" }] });

describe("apply busy guard considers affected seats only (#8)", () => {
  it("does not block an apply to changed seat A on unrelated seat B's claimed work", () => {
    const gate = assessSpecApplyGate([changed("a@rig", true)], [{ seat: "b@rig", state: "in-progress", claimedAt: "2026-01-01" }], false);
    expect(gate).toEqual({ status: "ready", busySeats: [], relaunchSeats: ["a@rig"] });
  });
  it("does block changed seat A's claimed work without disturbing deliberately stopped seats", () => {
    const plan = [changed("a@rig", true), changed("stopped@rig", false)];
    const work = [{ seat: "a@rig", state: "in-progress", claimedAt: "2026-01-01" }, { seat: "stopped@rig", state: "in-progress", claimedAt: "2026-01-01" }];
    expect(assessSpecApplyGate(plan, work, false)).toEqual({ status: "refused", busySeats: ["a@rig"], relaunchSeats: [] });
    expect(assessSpecApplyGate(plan, work, true)).toEqual({ status: "waiting-idle", busySeats: ["a@rig"], relaunchSeats: [] });
  });
  it("no affected running seats means no relaunch and no unrelated busy gate", () => {
    expect(assessSpecApplyGate([changed("stopped@rig", false)], [{ seat: "stopped@rig", state: "in-progress" }], false)).toEqual({ status: "ready", busySeats: [], relaunchSeats: [] });
  });
});
