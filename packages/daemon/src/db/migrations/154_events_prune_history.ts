import type { Migration } from "../migrate.js";

/** Evidence of actual event deletion. The retention scan watermark (153) alone is not proof of a gap. */
export const eventsPruneHistorySchema: Migration = {
  name: "154_events_prune_history.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS events_prune_history (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      deleted_through_seq INTEGER NOT NULL DEFAULT 0,
      legacy_unverified_through_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO events_prune_history (id, deleted_through_seq, legacy_unverified_through_seq, updated_at)
      SELECT 1, 0, COALESCE((SELECT low_water_seq FROM events_retention_marks WHERE id = 1), 0), datetime('now');
  `,
};
