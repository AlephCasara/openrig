import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { contextCommand } from "../src/commands/context.js";
import { createFullTestDb } from "../../daemon/test/helpers/test-app.js";

afterEach(() => vi.unstubAllEnvs());

async function fixture(): Promise<{ root: string; topologyRoot: string; recapPath: string }> {
  const root = mkdtempSync(join(tmpdir(), "issue11-recap-age-cli-"));
  const topologyRoot = join(root, "topology");
  const dbPath = join(root, "openrig.sqlite");
  const db = createFullTestDb();
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "r1");
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, ?, ?, ?)").run("node-1", "rig-1", "lead.dev-a", "codex");
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)").run("session-1", "node-1", "lead-dev-a@r1", "running");
  db.prepare(`INSERT INTO queue_items
    (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
    VALUES (?, ?, ?, ?, ?, 'in-progress', 'routine', 'fixture')`)
    .run("qitem-latest", "2026-11-08T06:00:00Z", "2026-11-08T06:00:00Z", "supervisor@external", "lead-dev-a@r1");
  await db.backup(dbPath);
  db.close();

  const seatDir = join(topologyRoot, "rigs", "r1", "seats", "lead.dev-a");
  mkdirSync(seatDir, { recursive: true });
  mkdirSync(join(topologyRoot, "rigs", "r1", "seats", "lead-dev-a"));
  const recapPath = join(seatDir, "RECAP.md");
  writeFileSync(recapPath, "## Recent Decisions\nregistry path\n");
  vi.stubEnv("OPENRIG_DB", dbPath);
  vi.stubEnv("OPENRIG_TOPOLOGY_ROOT", topologyRoot);
  return { root, topologyRoot, recapPath };
}

async function run(argv: string[]): Promise<{ logs: string[]; errLogs: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const errLogs: string[] = [];
  const oldLog = console.log;
  const oldErr = console.error;
  const oldExit = process.exitCode;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errLogs.push(args.map(String).join(" "));
  process.exitCode = undefined;
  try {
    const program = new Command();
    program.exitOverride();
    program.addCommand(contextCommand());
    await program.parseAsync(["node", "rig", "context", ...argv]);
  } catch { /* Commander exitOverride */ }
  const exitCode = process.exitCode;
  console.log = oldLog;
  console.error = oldErr;
  process.exitCode = oldExit;
  return { logs, errLogs, exitCode };
}

describe("rig context recap-age", () => {
  it("compares the registered seat recap with latest queue activity and reports duplicate orphan folders", async () => {
    const f = await fixture();
    try {
      utimesSync(f.recapPath, new Date("2026-11-08T05:00:00Z"), new Date("2026-11-08T05:00:00Z"));
      const stale = await run(["recap-age", "lead-dev-a", "--rig", "r1", "--json"]);
      expect(stale.exitCode ?? 0).toBe(0);
      const staleBody = JSON.parse(stale.logs.join("\n")) as {
        status: string;
        reference: { qitemId?: string } | null;
        seat: { logicalId: string; folderName: string };
        orphanSeatFolders: Array<{ name: string }>;
      };
      expect(staleBody).toMatchObject({
        status: "stale",
        reference: { qitemId: "qitem-latest" },
        seat: { logicalId: "lead.dev-a", folderName: "lead.dev-a" },
      });
      expect(staleBody.orphanSeatFolders.map((entry) => entry.name)).toContain("lead-dev-a");

      utimesSync(f.recapPath, new Date("2026-11-08T07:00:00Z"), new Date("2026-11-08T07:00:00Z"));
      const current = await run(["recap-age", "lead-dev-a@r1", "--rig", "r1", "--json"]);
      expect(current.exitCode ?? 0).toBe(0);
      expect(JSON.parse(current.logs.join("\n"))).toMatchObject({ status: "ok", stale: false });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rejects an unknown seat and names the valid logical ids", async () => {
    const f = await fixture();
    try {
      const result = await run(["recap-age", "nosuchseat", "--rig", "r1", "--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.errLogs.join("\n")).toMatch(/Valid logical seat ids: lead\.dev-a/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
