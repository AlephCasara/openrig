// Real Buzz: a registered human replies to our queue-driven event, queued
// as correspondence. No agent, rig, approval action, or user credential.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuzzCliClient } from "../../packages/daemon/src/domain/gateway/buzz-cli.ts";
import { BuzzInboundLab } from "../../packages/daemon/src/domain/gateway/buzz/inbound-lab.ts";

export function ensureGuestChannelMember({ cli, baseUrl, channelId, owner, guest }) {
  const env = { ...process.env, BUZZ_RELAY_URL: baseUrl, BUZZ_PRIVATE_KEY: owner.secret };
  for (const name of ["BUZZ_AUTH_TAG", "BUZZ_FEDERATED_IDENTITY_TOKEN", "BUZZ_FEDERATED_IDENTITY_ADAPTER"])
    delete env[name];
  const add = spawnSync(cli, ["channels", "add-member", "--channel", channelId,
    "--pubkey", guest.pubkey, "--role", "member"], {
    env, encoding: "utf8", timeout: 12000, maxBuffer: 1024 * 1024,
  });
  assert.equal(add.status, 0, "Owner could not re-add test guest to private Buzz channel");
}

export async function runBuzzInboundSmoke({ cli, baseUrl, channelId, owner, guest, root }) {
  const env = { ...process.env, BUZZ_RELAY_URL: baseUrl, BUZZ_PRIVATE_KEY: owner.secret };
  const previousKey = process.env.BUZZ_PRIVATE_KEY;
  const previousRelay = process.env.BUZZ_RELAY_URL;
  const home = mkdtempSync(join(tmpdir(), "openrig-buzz-inbound-"));
  try {
    process.env.BUZZ_PRIVATE_KEY = guest.secret;
    process.env.BUZZ_RELAY_URL = baseUrl;
    const sent = spawnSync(cli, [
      "messages", "send", "--channel", channelId,
      "--content", "-", "--reply-to", root.eventId,
    ], {
      input: "Human reply to OpenRig queue-driven message",
      encoding: "utf8", env: { ...env, BUZZ_PRIVATE_KEY: guest.secret },
      timeout: 15000, maxBuffer: 1024 * 1024,
    });
    if (sent.status !== 0) {
      let failure = { error: "unknown", message: "" };
      try { failure = JSON.parse(sent.stderr); } catch {}
      // Local diagnostic only; no private credentials or raw stderr.
      throw new Error(`Guest reply rejected by real CLI: ${String(failure.error)} (${String(failure.message).slice(0, 150)})`);
    }
    const reply = JSON.parse(sent.stdout);
    assert.match(reply.event_id, /^[0-9a-f]{64}$/i);

    process.env.BUZZ_PRIVATE_KEY = owner.secret;
    const reader = new BuzzCliClient({ binary: cli, timeoutMs: 15000 });
    const rows = new Map();
    const inserts = [];
    const inbound = new BuzzInboundLab({
      home, channelId, selfPubkey: owner.pubkey,
      allowedHumans: new Map([[guest.pubkey, root.recipient]]),
      resolveConfirmedRoot: (id) => id === root.eventId ? {
        qitemId: root.qitemId, recipient: root.recipient, seat: root.seat,
      } : null,
      transport: reader,
      queue: {
        getQitem: (id) => rows.get(id) ?? null,
        createQitem: async (input) => {
          inserts.push(input);
          rows.set(input.qitemId, {
            qitemId: input.qitemId, sourceSession: input.source,
            destinationSession: input.destination, body: input.body,
          });
          return input.qitemId;
        },
      },
    });
    const first = await inbound.pollOnce();
    assert.equal(first.ok, true);
    assert.equal(first.accepted, 1);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].humanAnswer, false);
    assert.equal(inserts[0].inReplyTo, root.qitemId);
    assert.equal(inserts[0].destination, root.seat);
    assert.equal(inserts[0].source, root.recipient);
    const second = await inbound.pollOnce();
    assert.equal(second.accepted, 0);
    assert.equal(inserts.length, 1);
    console.log("PASS: real Buzz human thread reply admitted by pubkey + confirmed root, durably deduped into the OpenRig inbound queue port; no auto-approval.");
  } finally {
    if (previousKey === undefined) delete process.env.BUZZ_PRIVATE_KEY;
    else process.env.BUZZ_PRIVATE_KEY = previousKey;
    if (previousRelay === undefined) delete process.env.BUZZ_RELAY_URL;
    else process.env.BUZZ_RELAY_URL = previousRelay;
    rmSync(home, { recursive: true, force: true });
  }
}
