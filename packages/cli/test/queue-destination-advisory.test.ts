import { describe, it, expect, vi } from "vitest";
import { createDaemon } from "../../daemon/src/startup.js";
import { queueCommand, type QueueDeps } from "../src/commands/queue.js";

describe("queue destination advisory through CLI and route", () => {
  it("warns for unmatched seats, preserves committed writes, and applies --strict to every write verb", async () => {
    const saved = { noKernel: process.env.OPENRIG_NO_KERNEL, session: process.env.OPENRIG_SESSION_NAME, exitCode: process.exitCode };
    process.env.OPENRIG_NO_KERNEL = "1";
    process.env.OPENRIG_SESSION_NAME = "sender-ba@advisory-source";
    const daemon = await createDaemon({ cmuxFactory: async () => {
      throw Object.assign(new Error("no fixture socket"), { code: "ENOENT" });
    }, tmuxExec: async () => "" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let includeOtherCreateWarnings = false;
      const source = daemon.deps.rigRepo.createRig("advisory-source");
      daemon.deps.rigRepo.addNode(source.id, "sender.ba", { runtime: null });
      const target = daemon.deps.rigRepo.createRig("advisory-target");
      daemon.deps.rigRepo.addNode(target.id, "product.ba", { runtime: null });
      const client = { post: async (url: string, body: unknown) => {
        const response = await daemon.app.request(url, { method: "POST", headers: {
          "Content-Type": "application/json", "X-OpenRig-Session": "sender-ba@advisory-source",
        }, body: JSON.stringify(body) });
        const data = await response.json() as Record<string, unknown>;
        // Exercise the CLI's rendering of the two existing create warning types
        // alongside the new advisory without altering the committed fixture.
        return { status: response.status, data: includeOtherCreateWarnings && url === "/api/queue/create"
          ? { ...data, createWarning: { code: "qitem_body_not_saved", message: "body was not saved" },
            advisories: [{ code: "shared_channel_correspondence", message: "shared channel needs a reply" }] }
          : data };
      } };
      const deps: QueueDeps = {
        lifecycleDeps: { readFile: () => null, exists: () => false,
          fetch: async () => ({ ok: true }) } as QueueDeps["lifecycleDeps"],
        clientFactory: () => client as unknown as ReturnType<QueueDeps["clientFactory"]>,
      };
      for (const json of [false, true]) {
        for (const verb of ["create", "handoff", "handoff-and-complete"]) {
          for (const strict of [false, true]) {
            for (const knownSeat of [false, true]) {
              const destination = knownSeat ? "product-ba@advisory-target" : "prodcut-ba@advisory-target";
              const original = await daemon.deps.queueRepo.create({ sourceSession: "sender-ba@advisory-source",
                destinationSession: "sender-ba@advisory-source", body: "fixture source", nudge: false });
              const args = verb === "create"
                ? [verb, "--destination", destination, "--body", "fixture", "--summary", "fixture"]
                : [verb, original.qitemId, "--to", destination, "--summary", "fixture"];
              log.mockClear();
              error.mockClear();
              process.exitCode = undefined;
              await queueCommand(deps).parseAsync([...args, "--no-nudge", ...(json ? ["--json"] : []), ...(strict ? ["--strict"] : [])], { from: "user" });
              const result = JSON.parse(log.mock.calls.map(call => call.join(" ")).join("\n"));
              const row = result.created ?? result;
              expect(row.destinationSession).toBe(destination);
              expect(daemon.deps.queueRepo.getById(row.qitemId)?.destinationSession).toBe(destination);
              if (knownSeat) {
                expect(result.advisories ?? []).not.toContainEqual(expect.objectContaining({ code: "unmatched_destination_seat" }));
                expect(error.mock.calls.some(call => String(call[0]).startsWith("Warning:"))).toBe(false);
                expect(process.exitCode).toBeUndefined();
              } else {
                expect(result.advisories[0].code).toBe("unmatched_destination_seat");
                expect(result.advisories[0].availableDestinations).toEqual(["product-ba@advisory-target"]);
                expect(result.advisories[0].message).toContain("does not guarantee pickup or delivery");
                expect(error.mock.calls).toContainEqual([`Warning: ${result.advisories[0].message}`]);
                expect(error.mock.calls.some(call => String(call[0]).startsWith("Warning:")
                  && String(call[0]).includes("Available destinations: product-ba@advisory-target"))).toBe(true);
                expect(process.exitCode).toBe(strict ? 1 : undefined);
              }
            }
          }
        }
      }
      includeOtherCreateWarnings = true;
      log.mockClear();
      error.mockClear();
      process.exitCode = undefined;
      await queueCommand(deps).parseAsync(["create", "--destination", "product-ba@advisory-target",
        "--body", "fixture", "--summary", "fixture", "--strict", "--no-nudge", "--json"], { from: "user" });
      expect(JSON.parse(log.mock.calls.map(call => call.join(" ")).join("\n")).destinationSession)
        .toBe("product-ba@advisory-target");
      expect(error.mock.calls).toContainEqual(["Warning: body was not saved"]);
      expect(error.mock.calls).toContainEqual(["Warning: shared channel needs a reply"]);
      expect(process.exitCode).toBeUndefined();
    } finally {
      log.mockRestore();
      error.mockRestore();
      process.exitCode = saved.exitCode;
      daemon.eventLoopMonitor.stop(); daemon.contextMonitor.stop(); daemon.deps.seatActivityService?.stop();
      daemon.db.close();
      if (saved.noKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
      else process.env.OPENRIG_NO_KERNEL = saved.noKernel;
      if (saved.session === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = saved.session;
    }
  }, 30_000);
});
