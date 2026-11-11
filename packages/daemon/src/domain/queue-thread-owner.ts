import { isHumanSeatSessionRef } from "./session-name.js";

const OPEN_STATES = new Set(["pending", "in-progress", "blocked"]);

export interface ThreadOwnershipRow {
  qitemId: string;
  sourceSession: string;
  state: string;
  tsCreated: string;
  tags: readonly string[] | null;
}

export interface ThreadOwner {
  seat: string;
  mission: string | null;
  qitemId: string;
  tsCreated: string;
}

/**
 * A thread is owned by seats with currently open, explicitly tagged queue rows.
 * Closed rows never imply ownership, even when they created the thread.
 * The newest authored row per seat determines the mission; ties use qitem id.
 * This is advisory, not an authorization to route a human reply.
 */
export function threadOwners(rows: readonly ThreadOwnershipRow[], root: string): ThreadOwner[] {
  if (!root || root.trim() !== root) return [];
  const tag = `thread:${root}`;
  const owners = new Map<string, ThreadOwner>();
  for (const row of rows) {
    if (!OPEN_STATES.has(row.state) || !row.tags?.includes(tag)
      || !row.sourceSession || isHumanSeatSessionRef(row.sourceSession)) continue;
    const candidate: ThreadOwner = {
      seat: row.sourceSession,
      mission: row.tags.find(value => value.startsWith("mission:"))?.slice("mission:".length) || null,
      qitemId: row.qitemId,
      tsCreated: row.tsCreated,
    };
    const prior = owners.get(row.sourceSession);
    if (!prior || compareOwner(candidate, prior) < 0) owners.set(row.sourceSession, candidate);
  }
  return [...owners.values()].sort(compareOwner);
}

function compareOwner(a: ThreadOwner, b: ThreadOwner): number {
  return b.tsCreated.localeCompare(a.tsCreated) || b.qitemId.localeCompare(a.qitemId);
}
