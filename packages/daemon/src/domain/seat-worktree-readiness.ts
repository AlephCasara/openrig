/** Read-only filesystem readiness check for a prepared seat working directory.
 * Caller supplies *other* registered worktree roots (not the seat's own root).
 * This cannot prove credentials or MCP connectivity and does not launch anything. */
import { realpathSync, statSync } from "node:fs";
import { relative, isAbsolute } from "node:path";

export interface SeatWorktreeResult { ok: boolean; reason: "cwd_missing" | "foreign_worktree" | null }

export function checkSeatWorktree(cwd: string, otherRoots: readonly string[]): SeatWorktreeResult {
  if (!isAbsolute(cwd)) return { ok: false, reason: "cwd_missing" };
  let actual: string;
  try {
    actual = realpathSync(cwd);
    if (!statSync(actual).isDirectory()) return { ok: false, reason: "cwd_missing" };
  } catch {
    return { ok: false, reason: "cwd_missing" };
  }
  for (const root of otherRoots) {
    let canonical: string;
    try { canonical = realpathSync(root); }
    catch { continue; }
    const under = relative(canonical, actual);
    if (under === "" || (under !== ".." && !under.startsWith("../") && !isAbsolute(under))) {
      return { ok: false, reason: "foreign_worktree" };
    }
  }
  return { ok: true, reason: null };
}
