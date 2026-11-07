import { readFile } from "node:fs/promises";
import { hostname, platform } from "node:os";
import { posix } from "node:path";
import { identityVerdictConfirmsExecutorStopped, type NodeInventoryEntry } from "./types.js";

export interface SeatResourceRow {
  sessionName: string;
  rigId: string;
  state: string;
  observed: { bytesCurrent: number; bytesLimit: number | null; swapBytesCurrent?: number; source: "cgroup-v2" } | null;
  availability: "available" | "unavailable" | "unsupported";
  reason: string | null;
}

export interface SeatResourcesResponse {
  schemaVersion: 1;
  sampledAt: string;
  host: string;
  seats: SeatResourceRow[];
}

type SeatInput = Pick<NodeInventoryEntry,
  "rigId" | "canonicalSessionName" | "attachmentType" | "sessionStatus" | "identityVerdict">;

export interface SeatResourceSamplerDependencies {
  seats: readonly SeatInput[];
  getPanePid: (pane: string) => Promise<number | null>;
  readText?: (path: string) => Promise<string>;
  operatingSystem?: string;
  host?: string;
  sampledAt?: string;
  cgroupRoot?: string;
  procRoot?: string;
}

function failed(row: SeatResourceRow, reason: string, availability: SeatResourceRow["availability"] = "unavailable"): SeatResourceRow {
  return { ...row, observed: null, availability, reason };
}

function bytes(value: string, allowUnlimited = false): number | null | undefined {
  const trimmed = value.trim();
  if (allowUnlimited && trimmed === "max") return null;
  if (!/^(0|[1-9]\d*)$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Only one exact, explicitly named seat unit, never a shared slice or a substring match. */
function seatScopePath(cgroup: string, session: string): string | null {
  const lines = cgroup.trimEnd().split("\n");
  if (lines.length !== 1 || !lines[0]?.startsWith("0::/")) return null;
  const cgPath = lines[0].slice(3);
  const components = cgPath.split("/").slice(1);
  if (components.some((p) => !p || p === "." || p === ".." || p.includes("\\"))) return null;
  const suffix = components.at(-1);
  const parent = components.at(-2);
  // Each supported scope is dedicated to one native executor. The pane PID and
  // verified executor PID must independently resolve to the same exact cgroup.
  const escapedSession = session.replace(/[^A-Za-z0-9_-]/g, "-");
  const rigSeatScope = parent === "rig-seats.slice"
    && new RegExp(`^seat-${escapedSession}-[1-9][0-9]*\\.scope$`).test(suffix ?? "");
  const tmuxSpawnScope = /^tmux-spawn-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.scope$/i.test(suffix ?? "")
    && components.length >= 4
    && /^user@\d+\.service$/.test(parent ?? "")
    && /^user-\d+\.slice$/.test(components.at(-3) ?? "")
    && components.at(-4) === "user.slice"
    && parent!.slice(5, -8) === components.at(-3)!.slice(5, -6);
  if (!rigSeatScope && !tmuxSpawnScope) return null;
  return cgPath;
}

/** Single request-only sample: current managed inventory + bounded proc/cgroup reads. */
export async function sampleSeatResources(deps: SeatResourceSamplerDependencies): Promise<SeatResourcesResponse> {
  const readText = deps.readText ?? ((path: string) => readFile(path, "utf8"));
  const cgroupRoot = deps.cgroupRoot ?? "/sys/fs/cgroup";
  const procRoot = deps.procRoot ?? "/proc";
  const selectedSeats = deps.seats.filter((s) => s.canonicalSessionName);
  const rows: SeatResourceRow[] = selectedSeats.map((seat) => ({
    sessionName: seat.canonicalSessionName!, rigId: seat.rigId,
    state: seat.sessionStatus ?? "unknown", observed: null, availability: "unavailable", reason: "not_sampled",
  }));
  const result: SeatResourcesResponse = {
    schemaVersion: 1, sampledAt: deps.sampledAt ?? new Date().toISOString(),
    host: deps.host ?? hostname(), seats: rows,
  };
  if ((deps.operatingSystem ?? platform()) !== "linux") {
    result.seats = rows.map((row) => failed(row, "non_linux", "unsupported"));
    return result;
  }
  try {
    await readText(posix.join(cgroupRoot, "cgroup.controllers"));
  } catch {
    result.seats = rows.map((row) => failed(row, "cgroup_v2_unavailable", "unsupported"));
    return result;
  }

  // Attribute all verified seat scopes before reading metrics. A failed metrics
  // read must never hide another seat sharing the same cgroup.
  // Serial probing avoids unbounded parallel tmux/process reads on large rigs.
  const scopes: Array<{ path: string; pane: string; panePid: number } | null> = Array(rows.length).fill(null);
  const scopeCounts = new Map<string, number>();
  for (let index = 0; index < rows.length; index++) {
    const seat = selectedSeats[index]!;
    const row = rows[index]!;
    if (seat.sessionStatus !== "running" || identityVerdictConfirmsExecutorStopped(seat.identityVerdict)) {
      rows[index] = failed(row, "seat_not_running");
      continue;
    }
    const verdict = seat.identityVerdict;
    const pane = verdict?.evidence.registeredPane;
    const panePid = verdict?.evidence.observedPanePid;
    const nativePid = verdict?.evidence.observedPid;
    if (seat.attachmentType !== "tmux" || verdict?.verdict !== "verified"
      || verdict.sessionName !== row.sessionName || !pane || !/^%\d+$/.test(pane)
      || !Number.isSafeInteger(panePid) || (panePid ?? 0) <= 0
      || !Number.isSafeInteger(nativePid) || (nativePid ?? 0) <= 0) {
      rows[index] = failed(row, "identity_unverified");
      continue;
    }
    const currentPanePid = await deps.getPanePid(pane).catch(() => null);
    if (currentPanePid !== panePid) {
      rows[index] = failed(row, "pane_identity_changed");
      continue;
    }
    let cgPath: string;
    try {
      const [nativeCgroup, paneCgroup] = await Promise.all([
        readText(posix.join(procRoot, String(nativePid), "cgroup")),
        readText(posix.join(procRoot, String(panePid), "cgroup")),
      ]);
      if (nativeCgroup !== paneCgroup) {
        rows[index] = failed(row, "pane_native_cgroup_mismatch");
        continue;
      }
      const parsed = seatScopePath(nativeCgroup, row.sessionName);
      if (!parsed) {
        rows[index] = failed(row, "dedicated_scope_unverified");
        continue;
      }
      cgPath = parsed;
    } catch {
      rows[index] = failed(row, "process_cgroup_unavailable");
      continue;
    }
    const root = posix.resolve(cgroupRoot);
    const path = posix.resolve(root, `.${cgPath}`);
    if (!path.startsWith(`${root}/`)) {
      rows[index] = failed(row, "invalid_cgroup_path");
      continue;
    }
    scopes[index] = { path, pane, panePid: panePid! };
    scopeCounts.set(path, (scopeCounts.get(path) ?? 0) + 1);
  }

  // Only uniquely attributed scopes can expose per-seat resource measurements.
  for (let index = 0; index < rows.length; index++) {
    const scope = scopes[index];
    if (!scope) continue;
    const { path, pane, panePid } = scope;
    const row = rows[index]!;
    if (scopeCounts.get(path)! > 1) {
      rows[index] = failed(row, "scope_shared_by_seats");
      continue;
    }
    try {
      const [current, max] = await Promise.all([
        readText(posix.join(path, "memory.current")),
        readText(posix.join(path, "memory.max")),
      ]);
      const bytesCurrent = bytes(current);
      const bytesLimit = bytes(max, true);
      if (bytesCurrent === undefined || bytesCurrent === null || bytesLimit === undefined) {
        rows[index] = failed(row, "malformed_metrics");
        continue;
      }
      let swapBytesCurrent: number | undefined;
      try {
        const rawSwap = await readText(posix.join(path, "memory.swap.current"));
        const parsedSwap = bytes(rawSwap);
        if (parsedSwap === undefined || parsedSwap === null) {
          rows[index] = failed(row, "malformed_metrics");
          continue;
        }
        swapBytesCurrent = parsedSwap;
      } catch { /* Optional controller/metric. Never invent swap = 0. */ }
      if (await deps.getPanePid(pane).catch(() => null) !== panePid) {
        rows[index] = failed(row, "pane_identity_changed");
        continue;
      }
      rows[index] = { ...row, availability: "available", reason: null,
        observed: { bytesCurrent, bytesLimit, ...(swapBytesCurrent === undefined ? {} : { swapBytesCurrent }), source: "cgroup-v2" } };
    } catch {
      rows[index] = failed(row, "scope_metrics_unavailable");
    }
  }
  return result;
}
