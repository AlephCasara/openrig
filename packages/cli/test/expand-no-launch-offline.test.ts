import { it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { expandCommand } from "../src/commands/expand.js";
import type { StatusDeps } from "../src/commands/status.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";

vi.mock("../src/rig-handle.js", () => ({ resolveRigHandle: async () => ({ kind: "not_found" }) }));

it("expand --no-launch propagates the explicit materialize-only option without HTTP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "expand-offline-"));
  const fragmentPath = join(dir, "pod.yaml");
  writeFileSync(fragmentPath, "id: worker\nlabel: Worker\nmembers: []\nedges: []\n");
  let body: Record<string, unknown> | null = null;
  const deps: StatusDeps = {
    lifecycleDeps: {
      exists: (path: string) => path === STATE_FILE,
      readFile: (path: string) => path === STATE_FILE
        ? JSON.stringify({ pid: 3, port: 4321, db: "fixture", startedAt: "2026-01-01T00:00:00Z" }) : null,
      fetch: async () => ({ ok: true }),
      isProcessAlive: () => true,
    } as never,
    clientFactory: () => ({
      post: async (_path: string, posted: Record<string, unknown>) => {
        body = posted;
        return { status: 201, data: { ok: true, status: "ok", podNamespace: "worker", nodes: [], warnings: [], retryTargets: [] } };
      },
    }) as never,
  };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await new Command().addCommand(expandCommand(deps)).parseAsync([
      "node", "rig", "expand", "rig-id", fragmentPath, "--no-launch", "--json",
    ]);
    expect(body).toEqual(expect.objectContaining({ noLaunch: true }));
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
