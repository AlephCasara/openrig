import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { deriveCanonicalFromEntry, getNodeInventory } from "./node-inventory.js";
import { parseSessionName } from "./session-name.js";
import type { NodeInventoryEntry } from "./types.js";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class TopologySeatResolutionError extends Error {
  constructor(
    public readonly code: "seat_ref_required" | "seat_not_found" | "seat_ambiguous" | "unsafe_topology_path",
    message: string,
    public readonly validLogicalIds: string[] = [],
  ) {
    super(message);
    this.name = "TopologySeatResolutionError";
  }
}

export interface ResolvedTopologySeat {
  rigId: string;
  rigName: string;
  nodeId: string;
  logicalId: string;
  canonicalSessionName: string;
  sessionMember: string;
  folderName: string;
  seatDir: string;
}

function activeRigRows(db: Database.Database): Array<{ id: string; name: string }> {
  return db.prepare("SELECT id, name FROM rigs WHERE archived_at IS NULL ORDER BY name, id")
    .all() as Array<{ id: string; name: string }>;
}

function canonicalFor(entry: NodeInventoryEntry): string | null {
  return entry.canonicalSessionName ?? deriveCanonicalFromEntry(entry);
}

function sessionMember(entry: NodeInventoryEntry): string | null {
  const canonical = canonicalFor(entry);
  if (!canonical) return null;
  const parsed = parseSessionName(canonical);
  return parsed.kind === "canonical" ? parsed.member : null;
}

function matchesRef(entry: NodeInventoryEntry, ref: string): boolean {
  const canonical = canonicalFor(entry);
  const member = sessionMember(entry);
  const parsed = parseSessionName(ref);
  if (parsed.kind === "canonical") {
    if (entry.rigName !== parsed.rig) return false;
    return canonical === ref || entry.logicalId === parsed.member || member === parsed.member;
  }
  return entry.logicalId === ref || member === ref;
}

function assertSegment(kind: string, value: string): void {
  if (value === "." || value === ".." || !SEGMENT.test(value)) {
    throw new TopologySeatResolutionError(
      "unsafe_topology_path",
      `unsafe ${kind} segment '${value}' — topology addresses require one bounded path segment`,
    );
  }
}

function directoryState(candidate: string): "missing" | "directory" | "unsafe" {
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isDirectory() && !stat.isSymbolicLink() ? "directory" : "unsafe";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function assertSafeAncestors(topologyRoot: string, rigName: string): void {
  if (!path.isAbsolute(topologyRoot)) {
    throw new TopologySeatResolutionError("unsafe_topology_path", "topology root must be absolute");
  }
  let cursor = topologyRoot;
  for (const segment of ["rigs", rigName, "seats"]) {
    cursor = path.join(cursor, segment);
    const state = directoryState(cursor);
    if (state === "unsafe") {
      throw new TopologySeatResolutionError(
        "unsafe_topology_path",
        `unsafe topology seat address — '${cursor}' is a symlink or not a directory`,
      );
    }
    if (state === "missing") break;
  }
}

export function listRegisteredTopologySeats(
  db: Database.Database,
  rigName?: string,
): NodeInventoryEntry[] {
  const rigs = activeRigRows(db).filter((rig) => rigName === undefined || rig.name === rigName);
  return rigs.flatMap((rig) => getNodeInventory(db, rig.id));
}

/**
 * Resolve a user-facing seat reference to the one physical topology directory.
 * Logical ids are authoritative when their directory exists. The derived
 * canonical/session-member folder is accepted only as a compatibility layout
 * for an already-existing registered seat. If neither exists, new storage is
 * created under the logical id. No punctuation substitution is used.
 */
export function resolveTopologySeat(
  db: Database.Database,
  input: { topologyRoot: string; seatRef: string; rigName?: string },
): ResolvedTopologySeat {
  const ref = input.seatRef?.trim() ?? "";
  if (!ref) throw new TopologySeatResolutionError("seat_ref_required", "seat reference is required");
  if (ref.includes("/") || ref.includes("\\") || ref === "." || ref === "..") {
    throw new TopologySeatResolutionError(
      "unsafe_topology_path",
      `unsafe seat segment '${ref}' — topology seat references cannot contain path separators`,
    );
  }
  if (input.rigName !== undefined) assertSegment("rig", input.rigName);

  if (input.rigName !== undefined) {
    const rigs = activeRigRows(db);
    if (!rigs.some((rig) => rig.name === input.rigName)) {
      throw new TopologySeatResolutionError(
        "seat_not_found",
        `Rig '${input.rigName}' does not exist. Valid rig names: ${rigs.map((rig) => rig.name).join(", ") || "(none)"}.`,
      );
    }
  }

  const registered = listRegisteredTopologySeats(db, input.rigName);
  const validLogicalIds = [...new Set(registered.map((entry) => entry.logicalId))].sort();
  const parsed = parseSessionName(ref);
  const candidates = registered.filter((entry) => {
    if (input.rigName !== undefined && entry.rigName !== input.rigName) return false;
    if (parsed.kind === "canonical" && input.rigName !== undefined && parsed.rig !== input.rigName) return false;
    return matchesRef(entry, ref);
  });
  if (candidates.length === 0) {
    throw new TopologySeatResolutionError(
      "seat_not_found",
      `Seat '${ref}' is not registered${input.rigName ? ` in rig '${input.rigName}'` : ""}. Valid logical seat ids: ${validLogicalIds.join(", ") || "(none)"}.`,
      validLogicalIds,
    );
  }
  if (candidates.length > 1) {
    throw new TopologySeatResolutionError(
      "seat_ambiguous",
      `Seat '${ref}' matches multiple registered seats: ${candidates.map((entry) => `${entry.logicalId}@${entry.rigName}`).join(", ")}.`,
      validLogicalIds,
    );
  }

  const entry = candidates[0]!;
  const canonical = canonicalFor(entry);
  const member = sessionMember(entry);
  if (!canonical || !member) {
    throw new TopologySeatResolutionError(
      "seat_not_found",
      `Seat '${entry.logicalId}@${entry.rigName}' has no canonical session identity; topology storage cannot be resolved safely.`,
      validLogicalIds,
    );
  }
  for (const [kind, value] of [["rig", entry.rigName], ["logical seat", entry.logicalId], ["session member", member]] as const) {
    assertSegment(kind, value);
  }
  assertSafeAncestors(input.topologyRoot, entry.rigName);

  const seatsRoot = path.join(input.topologyRoot, "rigs", entry.rigName, "seats");
  const logicalDir = path.join(seatsRoot, entry.logicalId);
  const memberDir = path.join(seatsRoot, member);
  const logicalState = directoryState(logicalDir);
  if (logicalState === "unsafe") {
    throw new TopologySeatResolutionError("unsafe_topology_path", `unsafe seat directory '${logicalDir}' — it is a symlink or not a directory`, validLogicalIds);
  }
  let folderName = entry.logicalId;
  if (logicalState === "missing" && member !== entry.logicalId) {
    const memberState = directoryState(memberDir);
    if (memberState === "unsafe") {
      throw new TopologySeatResolutionError("unsafe_topology_path", `unsafe seat directory '${memberDir}' — it is a symlink or not a directory`, validLogicalIds);
    }
    if (memberState === "directory") folderName = member;
  }
  return {
    rigId: entry.rigId,
    rigName: entry.rigName,
    nodeId: entry.nodeId,
    logicalId: entry.logicalId,
    canonicalSessionName: canonical,
    sessionMember: member,
    folderName,
    seatDir: path.join(seatsRoot, folderName),
  };
}

export interface OrphanTopologySeatFolder {
  name: string;
  path: string;
  kind: "directory" | "symlink" | "other";
}

export function listOrphanTopologySeatFolders(
  db: Database.Database,
  input: { topologyRoot: string; rigName: string },
): OrphanTopologySeatFolder[] {
  const registered = listRegisteredTopologySeats(db, input.rigName);
  const claimed = new Set<string>();
  for (const entry of registered) {
    try {
      claimed.add(resolveTopologySeat(db, { topologyRoot: input.topologyRoot, rigName: input.rigName, seatRef: entry.logicalId }).folderName);
    } catch {
      // A malformed/unsafe registered mapping is not used to legitimize a filesystem entry.
    }
  }
  const seatsRoot = path.join(input.topologyRoot, "rigs", input.rigName, "seats");
  let names: string[];
  try { names = fs.readdirSync(seatsRoot); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.flatMap((name) => {
    if (claimed.has(name)) return [];
    const full = path.join(seatsRoot, name);
    const stat = fs.lstatSync(full);
    return [{ name, path: full, kind: stat.isSymbolicLink() ? "symlink" as const : stat.isDirectory() ? "directory" as const : "other" as const }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}
