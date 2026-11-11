import { createHash } from "node:crypto";

export interface GuidanceSourceDigest {
  path: string;
  sha256: string;
}

export type GuidanceStatus =
  | { status: "current"; changedPaths: [] }
  | { status: "stale"; changedPaths: string[] }
  | { status: "unknown"; changedPaths: [] };

/** Record only source identity and a content digest, never guidance plaintext. */
export function guidanceSnapshot(
  sources: readonly { path: string; content: string }[],
): GuidanceSourceDigest[] {
  const files = new Map<string, string>();
  for (const source of sources) {
    if (!source.path || source.path.trim() !== source.path) throw new Error("invalid guidance source path");
    const sha256 = createHash("sha256").update(source.content).digest("hex");
    const prior = files.get(source.path);
    if (prior !== undefined && prior !== sha256) throw new Error(`conflicting guidance at ${source.path}`);
    files.set(source.path, sha256);
  }
  return [...files.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([path, sha256]) => ({ path, sha256 }));
}

/**
 * Compare what the occupant actually received with a fresh read of that same
 * guidance source set. Missing launch evidence must not be reported current.
 * This pure projection does not claim that the occupant read a file by path.
 */
export function compareGuidanceSnapshots(
  atLaunch: readonly GuidanceSourceDigest[] | null,
  now: readonly GuidanceSourceDigest[] | null,
): GuidanceStatus {
  if (atLaunch == null || now == null) return { status: "unknown", changedPaths: [] };
  const before = new Map(atLaunch.map(file => [file.path, file.sha256]));
  const current = new Map(now.map(file => [file.path, file.sha256]));
  const changedPaths = [...new Set([...before.keys(), ...current.keys()])]
    .filter(path => before.get(path) !== current.get(path))
    .sort();
  return changedPaths.length
    ? { status: "stale", changedPaths }
    : { status: "current", changedPaths: [] };
}
