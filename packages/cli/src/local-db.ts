import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "./config-store.js";
import { getOpenRigHome } from "./openrig-compat.js";

/** Open the database selected by the same precedence as the local daemon. */
export function openConfiguredLocalDb(): Database.Database {
  const configured = new ConfigStore().resolveWithSource("db.path");
  let dbPath = configured.value as string;
  if (configured.source === "default") {
    try {
      const state = JSON.parse(readFileSync(join(getOpenRigHome(), "daemon.json"), "utf8"));
      if (typeof state.db === "string" && state.db.length > 0) dbPath = state.db;
    } catch { /* no daemon launch record: retain the configured default */ }
  }
  return new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 100 });
}
