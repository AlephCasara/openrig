// Real Buzz CLI + real relay + OpenRig durable queue sweep, without daemon/rig.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuzzCliClient } from "../../packages/daemon/src/domain/gateway/buzz-cli.ts";
import { buildBuzzOutboundLabWire } from "../../packages/daemon/src/domain/gateway/buzz/outbound-wire-lab.ts";
import { DispatchBuffer } from "../../packages/daemon/src/domain/gateway/dispatch-buffer.ts";

export async function runBuzzQueueSmoke({ cli, baseUrl, channelId, owner }) {
  const home = mkdtempSync(join(tmpdir(), "openrig-buzz-outbound-lab-"));
  const originalKey = process.env.BUZZ_PRIVATE_KEY;
  const originalRelay = process.env.BUZZ_RELAY_URL;
  let wire;
  try {
    process.env.BUZZ_PRIVATE_KEY = owner.secret;
    process.env.BUZZ_RELAY_URL = baseUrl;
    const sender = new BuzzCliClient({ binary: cli, timeoutMs: 15_000 });
    const allowed = "demo-human@external";
    const queue = {
      async listHumanAlerts() {
        return [
          {
            qitemId: "buzz-e2e-1",
            notificationKey: "buzz-e2e-1:episode-1",
            state: "blocked",
            ownerNotificationKind: "human-required",
            ownerNotificationLevel: "NOTICE",
            summary: "OpenRig queue-to-Buzz test",
            body: "Signed delivery from persistent OpenRig dispatch buffer",
            destinationSession: allowed,
            sourceSession: "lab-agent@rig",
          },
          {
            qitemId: "relay-only-1",
            notificationKey: "relay-only-1:episode-1",
            state: "blocked",
            ownerNotificationKind: "human-required",
            ownerNotificationLevel: "NOTICE",
            summary: "Must not send",
            destinationSession: "foreign-relay@external",
            sourceSession: "lab-agent@rig",
          },
        ];
      },
    };
    wire = buildBuzzOutboundLabWire({
      home,
      channelId,
      expectedPubkey: owner.pubkey,
      authorizedDestinations: new Set([allowed]),
      transport: sender,
      queue,
    });
    assert.equal(new DispatchBuffer(home).pending().length, 0);
    const first = await wire.sweepOnce();
    assert.deepEqual(first.dispatched, ["buzz-e2e-1"]);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (wire.status().confirmed === 1 && new DispatchBuffer(home).pending().length === 0) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    assert.equal(wire.status().confirmed, 1, "Real relay did not ACK the queued Buzz decision");
    assert.equal(new DispatchBuffer(home).pending().length, 0, "Queued decision was not drained after success");
    const messages = await sender.getMessages({ channelId, limit: 100 });
    const matches = messages.filter((m) =>
      m.authorPubkey === owner.pubkey &&
      m.content.includes("Signed delivery from persistent OpenRig dispatch buffer"));
    assert.equal(matches.length, 1, "OpenRig queue alert should appear exactly once in real Buzz relay");
    assert.match(matches[0].content, /\[OpenRig delivery: [a-f0-9]{32}\]/);
    assert.ok(!messages.some((m) => m.content.includes("Must not send")));
    const second = await wire.sweepOnce();
    assert.deepEqual(second.dispatched, []);
    console.log("PASS: real Buzz relay received one queue-driven, journaled message; foreign destination excluded, no duplicate sweep.");
    return { eventId: matches[0].id, qitemId: "buzz-e2e-1", recipient: allowed, seat: "lab-agent@rig" };
  } finally {
    wire?.stop();
    if (originalKey === undefined) delete process.env.BUZZ_PRIVATE_KEY;
    else process.env.BUZZ_PRIVATE_KEY = originalKey;
    if (originalRelay === undefined) delete process.env.BUZZ_RELAY_URL;
    else process.env.BUZZ_RELAY_URL = originalRelay;
    rmSync(home, { recursive: true, force: true });
  }
}
