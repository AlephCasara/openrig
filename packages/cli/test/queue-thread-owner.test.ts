import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { queueCommand, type QueueDeps } from "../src/commands/queue.js";

vi.mock("../src/daemon-lifecycle.js", () => ({
  getDaemonStatus: async () => ({ state: "running", healthy: true, port: 12345 }),
  getDaemonUrl: () => "http://queue.invalid",
  daemonStatusGuard: () => true,
}));

afterEach(() => { vi.restoreAllMocks(); });

it("thread-owner prints the daemon's sorted open-row evidence without routing or writing", async () => {
  const calls: string[] = [];
  const body = {
    root: "q-root", complete: true,
    owners: [{ seat: "lead-b@rig", mission: "migration", qitemId: "b", tsCreated: "2026-01-02T00:00:00Z" }],
  };
  const deps: QueueDeps = {
    lifecycleDeps: {} as never,
    clientFactory: () => ({
      get: async (path: string) => {
        calls.push(path);
        return { status: 200, data: body };
      },
    }) as never,
  };
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(line); });
  await new Command().addCommand(queueCommand(deps)).parseAsync([
    "node", "rig", "queue", "thread-owner", "q-root", "--json",
  ]);
  expect(calls).toEqual(["/api/queue/thread-owner/q-root"]);
  expect(JSON.parse(lines.join("\n"))).toEqual(body);
});
