import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getPublicKey, verifyEvent } from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";

const home = mkdtempSync(join(tmpdir(), "buzz-daemon-startup-"));
const originalEnv = {
  openrigHome: process.env.OPENRIG_HOME,
  home: process.env.HOME,
  codexHome: process.env.CODEX_HOME,
  privateKey: process.env.BUZZ_PRIVATE_KEY,
  noKernel: process.env.OPENRIG_NO_KERNEL,
};
let database: { close(): void } | undefined;
let gateway: { stop(): void; startServices(): void; status(): { state: string; connector?: Record<string, unknown> } } | undefined;
let server: ReturnType<typeof createServer> | undefined;

afterEach(async () => {
  gateway?.stop();
  database?.close();
  if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
  if (originalEnv.openrigHome === undefined) delete process.env.OPENRIG_HOME;
  else process.env.OPENRIG_HOME = originalEnv.openrigHome;
  if (originalEnv.home === undefined) delete process.env.HOME;
  else process.env.HOME = originalEnv.home;
  if (originalEnv.codexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalEnv.codexHome;
  if (originalEnv.privateKey === undefined) delete process.env.BUZZ_PRIVATE_KEY;
  else process.env.BUZZ_PRIVATE_KEY = originalEnv.privateKey;
  if (originalEnv.noKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
  else process.env.OPENRIG_NO_KERNEL = originalEnv.noKernel;
});

describe("Buzz selection through daemon startup and post-bind services", () => {
  it("constructs Buzz without I/O, then starts authenticated recovery only after startServices", async () => {
    const marker = join(home, "cli-was-started");
    const fakeCli = join(home, "buzz-cli-fixture");
    writeFileSync(fakeCli, `#!/bin/sh\nprintf called > ${JSON.stringify(marker)}\nexit 99\n`, { mode: 0o700 });
    chmodSync(fakeCli, 0o700);

    let requests = 0;
    server = createServer(async (req, res) => {
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(Buffer.from(part));
      const raw = Buffer.concat(parts).toString("utf8");
      const authorization = req.headers.authorization ?? "";
      expect(authorization.startsWith("Nostr ")).toBe(true);
      const proof = JSON.parse(Buffer.from(authorization.slice(6), "base64").toString("utf8"));
      expect(verifyEvent(proof)).toBe(true);
      expect(proof.kind).toBe(27235);
      expect(proof.tags).toContainEqual(["u", `http://127.0.0.1:${server!.address() && typeof server!.address() === "object" ? server!.address()!.port : 0}/query`]);
      expect(proof.tags).toContainEqual(["method", "POST"]);
      expect(proof.tags).toContainEqual(["payload", createHash("sha256").update(raw).digest("hex")]);
      requests++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    expect(address && typeof address === "object").toBe(true);
    if (!address || typeof address === "string") throw new Error("loopback server did not bind");
    const relayUrl = `http://127.0.0.1:${address.port}`;

    process.env.OPENRIG_HOME = home;
    process.env.HOME = home;
    process.env.CODEX_HOME = join(home, ".codex");
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    process.env.OPENRIG_NO_KERNEL = "1";
    process.env.BUZZ_PRIVATE_KEY = "1".padStart(64, "0");
    const { addHumanFragment } = await import("../src/domain/gateway/human-registry.js");
    writeFileSync(join(home, "gateway-provider.json"), JSON.stringify({
      schemaVersion: 1,
      provider: "buzz",
      buzz: {
        enabled: true, binaryPath: fakeCli, relayUrl,
        channelId: "a69eea2f-f57c-425d-9e9e-d79970f3a248", credentialSource: "env",
      },
    }));
    const buzzPubkey = getPublicKey(Uint8Array.from(Buffer.from(process.env.BUZZ_PRIVATE_KEY, "hex")));
    const registered = addHumanFragment({
      entityId: "daemon-buzz-human", class: "human", displayName: "Daemon Buzz Human",
      address: "daemon-buzz-human@external",
      connectorBindings: [{
        kind: "buzz", connectorRef: "a69eea2f-f57c-425d-9e9e-d79970f3a248",
        secretsRef: "env:BUZZ_PRIVATE_KEY", role: "primary", handle: buzzPubkey,
      }],
      prefs: { deliveryClass: "B" },
    }, home);
    expect(registered.ok).toBe(true);

    const { createDaemon } = await import("../src/startup.js");
    const daemon = await createDaemon({ dbPath: ":memory:", tmuxExec: async () => "" });
    database = daemon.db;
    gateway = daemon.deps.gatewaySubsystem;
    expect(gateway.status().state).toBe("active");
    expect(gateway.status().connector).toMatchObject({
      platform: "buzz", mode: "optional-transport", inbound: { state: "not-started" },
    });
    expect(requests).toBe(0);
    expect(() => readFileSync(marker)).toThrow();

    gateway.startServices(); // this is the post-bind hook used by daemon/index.ts
    const deadline = Date.now() + 5_000;
    while (requests < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toBeGreaterThanOrEqual(2); // history page + head consistency check
    expect(gateway.status().connector).toMatchObject({ inbound: { state: "healthy" } });
    expect(() => readFileSync(marker)).toThrow();
  }, 30_000);
});
