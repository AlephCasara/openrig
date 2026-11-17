import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { verifyBuzzSignedMessage } from "../src/domain/gateway/buzz/verified-history.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addHumanFragment, loadHumanRegistry, resolveBuzzHandle, validateHumanFragment,
} from "../src/domain/gateway/human-registry.js";
import { buildRegisteredBuzzInboundLab, buildRegisteredBuzzOutboundLabWire, recoverRegisteredBuzzInbox, registeredBuzzDestinations } from "../src/domain/gateway/buzz/registry-context.js";
import type { BuzzVerifiedHistoryClient } from "../src/domain/gateway/buzz/verified-history.js";
import {
  BuzzOutboundDelivery, prepareBuzzDecision, resolveConfirmedBuzzRoot,
} from "../src/domain/gateway/buzz/outbound-delivery.js";
import type { QueueItem } from "../src/domain/gateway/slack/queue-access.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";

const channel = "2e4ab450-4c57-4541-8e3b-7491e1dd535f";
const other = "c60cb109-dc62-4ad4-9c90-3b72f97856b4";
const guestPrivate = Uint8Array.from(Buffer.from("01".repeat(32), "hex"));
const pubkey = getPublicKey(guestPrivate);
const self = "b".repeat(64);
const rootEvent = "c".repeat(64);
function signedReply(content: string, createdAt = 1762800001) {
  const signed = finalizeEvent({
    kind: 9, content, created_at: createdAt,
    tags: [["h", channel], ["e", rootEvent, "", "reply"]],
  }, guestPrivate);
  return verifyBuzzSignedMessage(signed, channel);
}
const replyEvent = signedReply("Review complete").id;

function human(id: string, ref = channel, key = pubkey) {
  return {
    entityId: id, class: "human", displayName: id, address: id + "@external",
    connectorBindings: [{
      kind: "buzz", connectorRef: ref, secretsRef: "env:BUZZ_PRIVATE_KEY",
      role: "primary", handle: key,
    }],
    prefs: { deliveryClass: "B" },
  };
}

describe("Buzz first-class registered identity and durable reply root", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "buzz-registry-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("validates canonical Nostr pubkeys, channel scope and a secret pointer only", () => {
    expect(validateHumanFragment(human("jane")).ok).toBe(true);
    for (const modified of [
      human("jane", "not-a-uuid"),
      human("jane", channel, "npub1not-hex"),
      human("jane", channel, pubkey.toUpperCase()),
      { ...human("jane"), connectorBindings: [{ ...human("jane").connectorBindings[0], secretsRef: "privkey-inline" }] },
      { ...human("jane"), connectorBindings: [{ ...human("jane").connectorBindings[0], handle: undefined }] },
    ]) {
      expect(validateHumanFragment(modified).ok).toBe(false);
    }
    expect(addHumanFragment(human("jane"), home).ok).toBe(true);
    const loaded = loadHumanRegistry(home, { readOnly: true });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(resolveBuzzHandle(channel, pubkey, loaded.entities)).toMatchObject({
      kind: "registered", address: "jane@external",
    });
    expect(resolveBuzzHandle(other, pubkey, loaded.entities)).toMatchObject({ kind: "unregistered" });
  });

  it("refuses the same pubkey for two people on one channel, but permits other channels", () => {
    expect(addHumanFragment(human("jane"), home).ok).toBe(true);
    expect(addHumanFragment(human("mark"), home).ok).toBe(false);
    expect(addHumanFragment(human("mark", other), home).ok).toBe(true);
  });

  it("resolves a root ONLY from a confirmed outbound journal and routes a reply via canonical registry", async () => {
    expect(addHumanFragment(human("jane"), home).ok).toBe(true);
    const rows = new Map<string, QueueItem>([["ask-1", {
      qitemId: "ask-1", sourceSession: "agent@rig", destinationSession: "jane@external",
      body: "Original ask",
    }]]);
    const delivery = new BuzzOutboundDelivery({
      home, channelId: channel, expectedPubkey: self,
      authorizedDestinations: new Set(["jane@external"]),
      transport: {
        sendMessage: async () => ({ eventId: rootEvent }),
        getMessages: async () => [],
      },
    });
    const decision = prepareBuzzDecision({
      kind: "outbound_decision", decisionId: "d1", op: "post_message",
      entityBindingRef: "jane@external",
      payload: {
        qitemId: "ask-1", notificationKey: "ask-1:episode-1",
        sourceSession: "agent@rig", destinationSession: "jane@external",
        summary: "Question", body: "Original ask",
      },
    }, { channelId: channel, authorizedDestinations: new Set(["jane@external"]) });
    expect(resolveConfirmedBuzzRoot(home, channel, rootEvent)).toBeNull();
    expect(await delivery.deliver(decision)).toEqual({ ok: true });
    expect(resolveConfirmedBuzzRoot(home, other, rootEvent)).toBeNull();
    expect(resolveConfirmedBuzzRoot(home, channel, rootEvent)).toEqual({
      qitemId: "ask-1", recipient: "jane@external", seat: "agent@rig",
    });
    const created: unknown[] = [];
    const lab = () => buildRegisteredBuzzInboundLab({
      home, channelId: channel, selfPubkey: self,
      queue: {
        getQitem: (id) => rows.get(id) ?? null,
        createQitem: async (input) => {
          created.push(input);
          rows.set(input.qitemId!, {
            qitemId: input.qitemId!, sourceSession: input.source,
            destinationSession: input.destination, body: input.body,
          });
          return input.qitemId!;
        },
      },
      transport: { getMessages: async () => [signedReply("Review complete")] },
    });
    expect(await lab().pollOnce()).toMatchObject({ ok: true, accepted: 1 });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      source: "jane@external", destination: "agent@rig", humanAnswer: false,
      inReplyTo: "ask-1",
    });
    expect(await lab().pollOnce()).toMatchObject({ ok: true, accepted: 0 });
    await expect(lab().recoverHistory()).rejects.toThrow(/composite-cursor recovery/);
    const secondSigned = signedReply("Another signed response", 1762800002);
    const verifiedClient = {
      recoverVerifiedHistory: async () => ({
        complete: true, pages: 1, events: [signedReply("Review complete"), secondSigned],
      }),
      getVerifiedMessages: async () => [signedReply("Review complete"), secondSigned],
    } as unknown as BuzzVerifiedHistoryClient;
    const complete = await recoverRegisteredBuzzInbox({
      home, channelId: channel, selfPubkey: self,
      queue: {
        getQitem: (id) => rows.get(id) ?? null,
        createQitem: async (input) => {
          created.push(input);
          rows.set(input.qitemId!, {
            qitemId: input.qitemId!, sourceSession: input.source,
            destinationSession: input.destination, body: input.body,
          });
          return input.qitemId!;
        },
      },
    }, verifiedClient);
    expect(complete).toMatchObject({ ok: true, accepted: 1, pages: 1 });
    expect(created).toHaveLength(2);
    // Registration changes are observed on every poll; a caller cannot supply
    // a fabricated display name or arbitrary pubkey to bypass the registry.
  });

  it("refuses inbound mapping when confirmed root no longer matches original queue row", async () => {
    expect(addHumanFragment(human("jane"), home).ok).toBe(true);
    const root = new BuzzOutboundDelivery({
      home, channelId: channel, expectedPubkey: self,
      authorizedDestinations: new Set(["jane@external"]),
      transport: { sendMessage: async () => ({ eventId: rootEvent }), getMessages: async () => [] },
    });
    const d = prepareBuzzDecision({
      kind: "outbound_decision", decisionId: "d1", op: "post_message",
      entityBindingRef: "jane@external",
      payload: { qitemId: "ask", notificationKey: "ask:1",
        sourceSession: "agent@rig", destinationSession: "jane@external", body: "Ask" },
    }, { channelId: channel, authorizedDestinations: new Set(["jane@external"]) });
    expect(await root.deliver(d)).toEqual({ ok: true });
    const lab = buildRegisteredBuzzInboundLab({
      home, channelId: channel, selfPubkey: self,
      queue: {
        getQitem: () => ({ qitemId: "ask", sourceSession: "another@rig", destinationSession: "jane@external" }),
        createQitem: async () => { throw new Error("unexpected create"); },
      },
      transport: { getMessages: async () => [signedReply("No impersonation", 1)] },
    });
    expect(await lab.pollOnce()).toMatchObject({ ok: true, accepted: 0, ignored: 1 });
  });

  it("never processes an incomplete composite history even when registry and queue are present", async () => {
    expect(addHumanFragment(human("jane"), home).ok).toBe(true);
    let creates = 0;
    const client = {
      recoverVerifiedHistory: async () => ({
        complete: false, reason: "buzz-history-page-limit", pages: 2, events: [],
      }),
      getVerifiedMessages: async () => { throw new Error("must not query or ingest incomplete history"); },
    } as unknown as BuzzVerifiedHistoryClient;
    const response = await recoverRegisteredBuzzInbox({
      home, channelId: channel, selfPubkey: self,
      queue: {
        getQitem: () => null,
        createQitem: async () => { creates++; throw new Error("unexpected"); },
      },
    }, client, { pageSize: 100, maxPages: 2 });
    expect(response).toMatchObject({
      ok: false, reason: "buzz-history-page-limit", accepted: 0, scanned: 0, pages: 2,
    });
    expect(creates).toBe(0);
  });

  it("scopes outbound recipients to current canonical Buzz PRIMARY bindings and honors revocation", async () => {
    expect(addHumanFragment(human("jane"), home).ok).toBe(true);
    expect(addHumanFragment(human("tess", other, "f".repeat(64)), home).ok).toBe(true);
    expect([...registeredBuzzDestinations(home, channel)]).toEqual(["jane@external"]);
    let outboundPosts = 0;
    let items: QueueItem[] = [{
      qitemId: "q-1", notificationKey: "q-1:1", state: "blocked",
      destinationSession: "jane@external", sourceSession: "agent@rig",
      body: "Before revocation", ownerNotificationKind: "human-required",
      ownerNotificationLevel: "NOTICE",
    }];
    const wire = buildRegisteredBuzzOutboundLabWire({
      home, channelId: channel, expectedPubkey: self,
      queue: { listHumanAlerts: async () => items },
      transport: {
        sendMessage: async () => {
          outboundPosts++;
          return { eventId: rootEvent };
        },
        getMessages: async () => [],
      },
    });
    await wire.sweepOnce();
    const deadline = Date.now() + 1000;
    while (outboundPosts < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(outboundPosts).toBe(1);

    // Revoking the primary Buzz binding while the lab wire is still alive
    // must prevent any newer alert from reaching the old transport.
    expect(addHumanFragment({
      ...human("jane"),
      connectorBindings: [{
        kind: "slack", connectorRef: "slack-main",
        secretsRef: "vault://slack/test", role: "primary", handle: "S01",
      }],
    }, home, { replace: true }).ok).toBe(true);
    expect([...registeredBuzzDestinations(home, channel)]).toEqual([]);
    items = [{
      qitemId: "q-2", notificationKey: "q-2:1", state: "blocked",
      destinationSession: "jane@external", sourceSession: "agent@rig",
      body: "After revocation", ownerNotificationKind: "human-required",
      ownerNotificationLevel: "NOTICE",
    }];
    const next = await wire.sweepOnce();
    expect(next.dispatched).toEqual([]);
    expect(outboundPosts).toBe(1);
    wire.stop();
  });

  it("excludes Buzz-primary people from the legacy Slack/relay notification projection", async () => {
    expect(addHumanFragment(human("jane"), home).ok).toBe(true);
    const db = createDb();
    try {
      migrate(db, ALL_MIGRATIONS);
      const registry = () => loadHumanRegistry(home, { readOnly: true });
      const repo = new QueueRepository(db, new EventBus(db), {
        validateRig: () => true, loadHumanRegistry: registry,
      });
      const created = await repo.create({
        sourceSession: "agent@rig", destinationSession: "jane@external",
        summary: "Do not route via Slack",
        body: "Buzz only", nudge: false,
      });
      repo.update({ qitemId: created.qitemId, actorSession: "agent@rig",
        state: "blocked", blockedOn: "jane@external", summary: "Buzz only" });
      const queue = makeQueuePorts(repo, { loadHumanRegistry: registry, sharedChannels: () => [] });
      const alerts = await queue.listHumanAlerts({ minimumLevel: "NOTICE" });
      expect(alerts.some((a) => a.qitemId === created.qitemId)).toBe(false);
    } finally {
      db.close();
    }
  });
});
