import { describe, expect, it, vi } from "vitest";
import { sampleSeatResources, type SeatResourceSamplerDependencies } from "../src/domain/seat-resource-sampler.js";

const uuidA = "78caa9fa-3237-4dd2-89d8-d7c976a60c60";
const uuidB = "4678289c-4771-48dd-a734-45e9e28f014b";
const tmuxScope = (id: string) => `/user.slice/user-1001.slice/user@1001.service/tmux-spawn-${id}.scope`;
type Seat = SeatResourceSamplerDependencies["seats"][number];

function seat(session: string, nativePid: number, panePid: number, pane: string): Seat {
  return {
    rigId: "rig", canonicalSessionName: session, attachmentType: "tmux", sessionStatus: "running",
    identityVerdict: {
      nodeId: session, verdict: "verified", evidenceSource: "pane_process", reason: null,
      sessionName: session, observedAt: "2026-11-07T03:00:00Z",
      evidence: { registeredPane: pane, observedPid: nativePid, observedPanePid: panePid, observedCommand: "codex", matchedLayer: 1 },
    },
  };
}

function fixture(seats: Seat[] = [seat("dev@rig", 201, 200, "%1")], scopes = [tmuxScope(uuidA)]) {
  const files = new Map<string, string>([["/cg/cgroup.controllers", "memory cpu\n"]]);
  seats.forEach((s, index) => {
    const scope = scopes[index] ?? scopes[0]!;
    const verdict = s.identityVerdict!;
    files.set(`/proc/${verdict.evidence.observedPid}/cgroup`, `0::${scope}\n`);
    files.set(`/proc/${verdict.evidence.observedPanePid}/cgroup`, `0::${scope}\n`);
    files.set(`/cg${scope}/memory.current`, String(1000 + index));
    files.set(`/cg${scope}/memory.max`, "2147483648\n");
    files.set(`/cg${scope}/memory.swap.current`, "512\n");
  });
  const deps: SeatResourceSamplerDependencies = {
    seats, cgroupRoot: "/cg", procRoot: "/proc", operatingSystem: "linux", host: "testhost",
    sampledAt: "2026-11-07T03:00:00Z",
    getPanePid: vi.fn(async (pane: string) => seats.find((s) => s.identityVerdict?.evidence.registeredPane === pane)?.identityVerdict?.evidence.observedPanePid ?? null),
    readText: async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("ENOENT");
      return value;
    },
  };
  return { deps, files };
}

describe("bounded per-seat cgroup-v2 memory sampler", () => {
  it("observes a verified tmux-spawn scope with real numeric metrics", async () => {
    const { deps } = fixture();
    expect(await sampleSeatResources(deps)).toEqual({
      schemaVersion: 1, sampledAt: "2026-11-07T03:00:00Z", host: "testhost",
      seats: [{ sessionName: "dev@rig", rigId: "rig", state: "running", availability: "available", reason: null,
        observed: { bytesCurrent: 1000, bytesLimit: 2147483648, swapBytesCurrent: 512, source: "cgroup-v2" } }],
    });
  });

  it("keeps two different seats in two different scopes", async () => {
    const { deps } = fixture([seat("dev@rig", 201, 200, "%1"), seat("orch@rig", 301, 300, "%2")], [tmuxScope(uuidA), tmuxScope(uuidB)]);
    const rows = (await sampleSeatResources(deps)).seats;
    expect(rows.map((s) => s.availability)).toEqual(["available", "available"]);
    expect(rows.map((s) => s.observed?.bytesCurrent)).toEqual([1000, 1001]);
  });

  it("accepts the explicitly named rig-seats slice scope", async () => {
    const { deps } = fixture([seat("dev@rig", 201, 200, "%1")], ["/rig-seats.slice/seat-dev-rig-201.scope"]);
    expect((await sampleSeatResources(deps)).seats[0]?.availability).toBe("available");
  });

  it("rejects different native and pane cgroups", async () => {
    const { deps, files } = fixture();
    files.set("/proc/200/cgroup", `0::${tmuxScope(uuidB)}\n`);
    expect((await sampleSeatResources(deps)).seats[0]?.reason).toBe("pane_native_cgroup_mismatch");
  });

  it.each([
    "/user.slice/user-1001.slice/user@1001.service/tmux-spawn-not-a-uuid.scope",
    `/user.slice/user-1002.slice/user@1001.service/tmux-spawn-${uuidA}.scope`,
    `/user.slice/user-1001.slice/user@1001.service/subpath/tmux-spawn-${uuidA}.scope`,
    `/user.slice/user-1001.slice/user@1001.service/tmux-spawn-${uuidA}.scope/child`,
    "/user.slice/user-1001.slice/user@1001.service/other.scope",
    `/user.slice/user-1001.slice/user@1001.service/../tmux-spawn-${uuidA}.scope`,
  ])("rejects non-dedicated or malformed scope %s", async (scope) => {
    const { deps } = fixture(undefined, [scope]);
    expect((await sampleSeatResources(deps)).seats[0]?.reason).toBe("dedicated_scope_unverified");
  });

  it("does not assign one shared scope to two seats", async () => {
    const { deps } = fixture([seat("dev@rig", 201, 200, "%1"), seat("orch@rig", 301, 300, "%2")], [tmuxScope(uuidA), tmuxScope(uuidA)]);
    const rows = (await sampleSeatResources(deps)).seats;
    expect(rows.map((r) => r.reason)).toEqual(["scope_shared_by_seats", "scope_shared_by_seats"]);
    expect(rows.every((r) => r.observed === null)).toBe(true);
  });

  it("rejects a shared scope even when the first seat's memory read fails", async () => {
    const { deps } = fixture([seat("dev@rig", 201, 200, "%1"), seat("orch@rig", 301, 300, "%2")], [tmuxScope(uuidA), tmuxScope(uuidA)]);
    const readText = deps.readText!;
    const memoryPath = `/cg${tmuxScope(uuidA)}/memory.current`;
    let memoryReads = 0;
    deps.readText = async (path) => {
      if (path === memoryPath && ++memoryReads === 1) {
        throw Object.assign(new Error("EIO"), { code: "EIO" });
      }
      return readText(path);
    };
    const rows = (await sampleSeatResources(deps)).seats;
    expect(rows.map((r) => r.reason)).toEqual(["scope_shared_by_seats", "scope_shared_by_seats"]);
    expect(rows.every((r) => r.availability === "unavailable" && r.observed === null)).toBe(true);
    expect(memoryReads).toBe(0); // Never sample ambiguous scopes.
  });

  it("rejects stopped seats, stale pane PID and unverifiable replacements", async () => {
    const { deps } = fixture();
    expect((await sampleSeatResources({ ...deps, seats: [{ ...deps.seats[0]!, sessionStatus: "exited" }] })).seats[0]?.reason).toBe("seat_not_running");
    expect((await sampleSeatResources({ ...deps, getPanePid: async () => 999 })).seats[0]?.reason).toBe("pane_identity_changed");
    const replaced = { ...deps.seats[0]!, identityVerdict: null };
    expect((await sampleSeatResources({ ...deps, seats: [replaced] })).seats[0]?.reason).toBe("identity_unverified");
  });

  it("reports unsupported non-linux and cgroup-v1 host explicitly", async () => {
    const { deps, files } = fixture();
    expect((await sampleSeatResources({ ...deps, operatingSystem: "darwin" })).seats[0]).toMatchObject({ availability: "unsupported", reason: "non_linux" });
    files.delete("/cg/cgroup.controllers");
    expect((await sampleSeatResources(deps)).seats[0]).toMatchObject({ availability: "unsupported", reason: "cgroup_v2_unavailable" });
  });

  it("returns explicit unavailable for missing process and inaccessible scope metrics", async () => {
    const { deps, files } = fixture();
    files.delete("/proc/201/cgroup");
    expect((await sampleSeatResources(deps)).seats[0]?.reason).toBe("process_cgroup_unavailable");
    files.set("/proc/201/cgroup", `0::${tmuxScope(uuidA)}\n`);
    files.delete(`/cg${tmuxScope(uuidA)}/memory.current`);
    expect((await sampleSeatResources(deps)).seats[0]?.reason).toBe("scope_metrics_unavailable");
  });

  it("does not fabricate zero for unlimited max, absent swap or malformed numbers", async () => {
    const { deps, files } = fixture();
    const path = `/cg${tmuxScope(uuidA)}`;
    files.set(`${path}/memory.max`, "max\n");
    files.delete(`${path}/memory.swap.current`);
    expect((await sampleSeatResources(deps)).seats[0]?.observed).toEqual({ bytesCurrent: 1000, bytesLimit: null, source: "cgroup-v2" });
    for (const broken of ["NaN", "-1", "1.5", "9007199254740993", "max"]) {
      files.set(`${path}/memory.current`, broken);
      expect((await sampleSeatResources(deps)).seats[0]?.reason).toBe("malformed_metrics");
    }
    files.set(`${path}/memory.current`, "1000");
    files.set(`${path}/memory.swap.current`, "oops");
    expect((await sampleSeatResources(deps)).seats[0]?.reason).toBe("malformed_metrics");
  });
});
