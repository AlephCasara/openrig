import { isDeepStrictEqual } from "node:util";

export interface ExistingSeatShape {
  seat: string;
  fields: Readonly<Record<string, unknown>>;
  running: boolean;
}

export interface DesiredSeatShape {
  seat: string;
  fields: Readonly<Record<string, unknown>>;
}

export interface SeatApplyChange { field: string; mode: "relaunch" }
export interface SeatApplyPlan { seat: string; wasRunning: boolean; changes: SeatApplyChange[] }

/**
 * Offline, intentionally conservative plan. It does not claim that a saved
 * set-* option takes effect in the occupant until launch/restart. Never return
 * field values: even an authored env field may contain sensitive material.
 */
export function planSeatSpecChanges(
  existing: readonly ExistingSeatShape[],
  desired: readonly DesiredSeatShape[],
): SeatApplyPlan[] {
  const unique = <T extends { seat: string }>(rows: readonly T[]) => {
    const ids = new Set<string>();
    for (const row of rows) {
      if (!row.seat || ids.has(row.seat)) throw new Error("duplicate seat or empty seat identifier");
      ids.add(row.seat);
    }
  };
  unique(existing);
  unique(desired);
  const old = new Map(existing.map(row => [row.seat, row]));
  const next = new Map(desired.map(row => [row.seat, row]));
  const plans: SeatApplyPlan[] = [];
  for (const seat of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const before = old.get(seat);
    const after = next.get(seat);
    const fields = before && after
      ? [...new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])]
        .filter(field => !isDeepStrictEqual(before.fields[field], after.fields[field]))
        .sort()
      : ["member"];
    if (fields.length) {
      plans.push({ seat, wasRunning: before?.running === true,
        changes: fields.map(field => ({ field, mode: "relaunch" })) });
    }
  }
  return plans;
}

export interface SeatWorkRow { seat: string; state: string; claimedAt?: string | null }
export type ApplyGate = {
  status: "ready" | "refused" | "waiting-idle";
  busySeats: string[];
  relaunchSeats: string[];
};

/**
 * Pure guard only; NO launch, kill or file mutation. A caller must re-check
 * the queue atomically before applying the plan and preserve stopped seats.
 */
export function assessSpecApplyGate(
  plan: readonly SeatApplyPlan[],
  work: readonly SeatWorkRow[],
  whenIdle: boolean,
): ApplyGate {
  const affectedRunning = new Set(plan.filter(row => row.wasRunning && row.changes.length > 0)
    .map(row => row.seat));
  const busySeats = [...new Set(work.filter(row => affectedRunning.has(row.seat) &&
    (row.state === "in-progress" ||
      (typeof row.claimedAt === "string" && row.claimedAt.length > 0)))
    .map(row => row.seat))].sort();
  if (busySeats.length) return {
    status: whenIdle ? "waiting-idle" : "refused",
    busySeats,
    relaunchSeats: [],
  };
  return {
    status: "ready", busySeats: [],
    relaunchSeats: plan.filter(row => row.wasRunning && row.changes.length > 0).map(row => row.seat).sort(),
  };
}
