// Real Buzz: a registered human replies to our queue-driven event, queued
// as correspondence. No agent, rig, approval action, or user credential.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuzzCliClient } from "../../packages/daemon/src/domain/gateway/buzz-cli.ts";
import { BuzzInboundLab } from "../../packages/daemon/src/domain/gateway/buzz/inbound-lab.ts";
import { BuzzVerifiedHistoryClient, verifyBuzzNormalizedMessage } from "../../packages/daemon/src/domain/gateway/buzz/verified-history.ts";
import { authenticatedPost } from "./auth.mjs";

export async function ensureGuestChannelMember({ cli, baseUrl, channelId, owner, guest }) {
  // Fresh identity is admitted once at the relay and the channel. Keep the
  // earlier revocation test isolated: a revoked+readded identity may not be
  // able to resolve a fresh private-channel parent on this relay version.
  const invitation = await authenticatedPost(baseUrl, "/api/invites",
    { ttl_secs: 3600, max_uses: 1 }, owner.secret);
  assert.equal(invitation.ok, true, "Owner could not create NIP-43 invite for fresh inbound guest");
  const join = await authenticatedPost(baseUrl, "/api/invites/claim",
    { code: invitation.json.code }, guest.secret);
  assert.equal(join.ok, true, "Fresh inbound guest failed NIP-43 claim");
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
    // The CLI checks that its reply parent is visible to the guest. A real
    // private relay can return NOT_FOUND briefly after the owner's ACK,
    // especially across the writer/reader boundary. Only retry a READ here,
    // never an ambiguous send.
    let parentVisible = false;
    for (let probe = 0; probe < 15; probe++) {
      const found = spawnSync(cli, [
        "messages", "get", "--channel", channelId, "--limit", "100", "--kinds", "9",
      ], {
        env: { ...env, BUZZ_PRIVATE_KEY: guest.secret },
        encoding: "utf8", timeout: 12000, maxBuffer: 1024 * 1024,
      });
      if (found.status === 0) {
        try {
          parentVisible = JSON.parse(found.stdout).some((ev) => ev.id === root.eventId);
        } catch { /* Probe remains unconfirmed. */ }
      }
      if (parentVisible) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(parentVisible, true, "Guest cannot read the queue-driven parent after channel admission");
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
    // Backwards-history recovery is explicitly invoked, even for a small real
    // channel; the CLI --before boundary is also probed against the real relay.
    const first = await inbound.recoverHistory({ maxPages: 4 });
    assert.equal(first.ok, true);
    assert.equal(first.accepted, 1);
    assert.equal(inserts.length, 1);
    const seenEvents = await reader.getMessages({ channelId, limit: 100 });
    const newest = Math.max(...seenEvents.map((event) => event.createdAt));
    const earlier = await reader.getMessages({ channelId, limit: 100, before: newest + 1 });
    assert.ok(earlier.some((event) => event.id === reply.event_id),
      "Official Buzz CLI --before must include messages strictly older than the requested timestamp");

    // Unlike the CLI's normalized read, the HTTP bridge returns complete
    // signed Nostr events. The real relay's composite timestamp+ID keyset
    // is exercised here by forcing 2-event pages.
    const verifiedReader = new BuzzVerifiedHistoryClient({
      relayUrl: baseUrl, privateKeyHex: owner.secret,
    });
    const complete = await verifiedReader.recoverVerifiedHistory({
      channelId, pageSize: 2, maxPages: 24,
    });
    assert.equal(complete.complete, true,
      "Official relay composite-cursor history not exhaustive");
    assert.ok(complete.pages >= 2, "Real relay must exercise more than one composite cursor page");
    assert.ok(complete.events.some((ev) => ev.id === reply.event_id && ev.authorPubkey === guest.pubkey));
    assert.ok(complete.events.some((ev) => ev.id === root.eventId && ev.authorPubkey === owner.pubkey));
    for (const ev of complete.events) {
      assert.equal(verifyBuzzNormalizedMessage(ev, channelId).id, ev.id);
    }
    console.log("PASS: real relay NIP-98 HTTP composite pagination with locally verified Nostr event hashes and Schnorr signatures.");

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
