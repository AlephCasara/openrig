import { statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { RECAP_FILENAME } from "./context-packs/seat-recap-store.js";
import { resolveTopologySeat, type ResolvedTopologySeat } from "./topology-seat-resolution.js";

export interface RecapReference {
  kind: "qitem" | "time" | "latest-queue";
  at: string;
  qitemId?: string;
}

export interface SeatRecapAge {
  seat: Pick<ResolvedTopologySeat, "rigName" | "logicalId" | "canonicalSessionName" | "folderName" | "seatDir">;
  recapPath: string;
  recapWrittenAt: string | null;
  reference: RecapReference | null;
  stale: boolean | null;
  status: "missing" | "uncompared" | "ok" | "stale";
}

function qitemReference(db: Database.Database, qitemId: string): RecapReference | null {
  const row = db.prepare("SELECT qitem_id, ts_created FROM queue_items WHERE qitem_id = ?").get(qitemId) as
    { qitem_id: string; ts_created: string } | undefined;
  return row ? { kind: "qitem", qitemId: row.qitem_id, at: row.ts_created } : null;
}

function latestQueueReference(db: Database.Database, canonicalSessionName: string): RecapReference | null {
  try {
    const row = db.prepare(`
      WITH activity AS (
        SELECT qitem_id, ts FROM queue_transitions
        UNION ALL
        SELECT qitem_id, ts FROM queue_transitions_archive
      )
      SELECT q.qitem_id,
             CASE WHEN MAX(a.ts) IS NOT NULL AND MAX(a.ts) > q.ts_created THEN MAX(a.ts) ELSE q.ts_created END AS activity_at
      FROM queue_items q
      LEFT JOIN activity a ON a.qitem_id = q.qitem_id
      WHERE q.destination_session = ?
      GROUP BY q.qitem_id, q.ts_created
      ORDER BY activity_at DESC, q.qitem_id DESC
      LIMIT 1
    `).get(canonicalSessionName) as { qitem_id: string; activity_at: string } | undefined;
    return row ? { kind: "latest-queue", qitemId: row.qitem_id, at: row.activity_at } : null;
  } catch {
    const row = db.prepare(`
      SELECT qitem_id, ts_created FROM queue_items
      WHERE destination_session = ?
      ORDER BY ts_created DESC, qitem_id DESC LIMIT 1
    `).get(canonicalSessionName) as { qitem_id: string; ts_created: string } | undefined;
    return row ? { kind: "latest-queue", qitemId: row.qitem_id, at: row.ts_created } : null;
  }
}

function explicitReference(db: Database.Database, since: string): RecapReference {
  const trimmed = since.trim();
  const qitem = qitemReference(db, trimmed);
  if (qitem) return qitem;
  if (/^qitem-/.test(trimmed)) throw new Error(`Queue item '${trimmed}' was not found.`);
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) throw new Error(`--since must be an ISO/date-time value or an existing qitem id (got '${since}').`);
  return { kind: "time", at: new Date(ms).toISOString() };
}

/** Compare the authored recap's filesystem write time with an explicit or latest queue reference. */
export function readSeatRecapAge(
  db: Database.Database,
  input: { topologyRoot: string; seatRef: string; rigName?: string; since?: string; latestQueue?: boolean },
): SeatRecapAge {
  const resolved = resolveTopologySeat(db, {
    topologyRoot: input.topologyRoot,
    seatRef: input.seatRef,
    ...(input.rigName !== undefined ? { rigName: input.rigName } : {}),
  });
  const recapPath = join(resolved.seatDir, RECAP_FILENAME);
  let recapWrittenAt: string | null = null;
  try { recapWrittenAt = new Date(statSync(recapPath).mtimeMs).toISOString(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const reference = input.since !== undefined
    ? explicitReference(db, input.since)
    : input.latestQueue === false
      ? null
      : latestQueueReference(db, resolved.canonicalSessionName);
  if (recapWrittenAt === null) {
    return { seat: resolved, recapPath, recapWrittenAt, reference, stale: reference ? true : null, status: "missing" };
  }
  if (!reference) return { seat: resolved, recapPath, recapWrittenAt, reference: null, stale: null, status: "uncompared" };
  const stale = Date.parse(recapWrittenAt) < Date.parse(reference.at);
  return { seat: resolved, recapPath, recapWrittenAt, reference, stale, status: stale ? "stale" : "ok" };
}

export function staleRecapWarning(age: SeatRecapAge): string | null {
  if (!age.reference) return null;
  if (age.status === "missing") {
    return `No authored recap exists for ${age.seat.logicalId}; latest queue activity is ${age.reference.at}${age.reference.qitemId ? ` (${age.reference.qitemId})` : ""}.`;
  }
  if (!age.stale) return null;
  return `Authored recap for ${age.seat.logicalId} is stale: written ${age.recapWrittenAt}, latest queue activity ${age.reference.at}${age.reference.qitemId ? ` (${age.reference.qitemId})` : ""}. Run rig context recap-write before a fresh launch when continuity matters.`;
}
