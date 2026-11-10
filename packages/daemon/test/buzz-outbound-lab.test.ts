import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import {
  BuzzOutboundDelivery, prepareBuzzDecision, buzzLedgerPath,
  type BuzzOutboundTransport, type BuzzOutboundOptions,
} from "../src/domain/gateway/buzz/outbound-delivery.js";
import { buildBuzzOutboundLabWire } from "../src/domain/gateway/buzz/outbound-wire-lab.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";
import type { QueueItem } from "../src/domain/gateway/slack/queue-access.js";
import type { BuzzMessage } from "../src/domain/gateway/buzz-cli.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";

const channelId = "7cbb1111-12d1-4c6e-8040-865f6368139b";
const pubkey = "a".repeat(64);
const recipient = "jane@external";
const eventId = "b".repeat(64);
const wait = async (check: () => boolean, duration = 1500) => {
  const end = Date.now() + duration;
  while (!check() && Date.now() < end) await new Promise((res) => setTimeout(res, 12));
  expect(check()).toBe(true);
};

function alert(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    qitemId: "q-1",
    notificationKey: "q-1:episode-1",
    summary: "Review design",
    body: "Check acceptance criteria",
    state: "blocked",
    destinationSession: recipient,
    sourceSession: "agent@rig",
    ownerNotificationLevel: "NOTICE",
    ownerNotificationKind: "human-required",
    ...overrides,
  };
}

function fakeTransport() {
  const sent: string[] = [];
  const events: BuzzMessage[] = [];
  const transport: BuzzOutboundTransport = {
    sendMessage: async ({ content, channelId: id }) => {
      expect(id).toBe(channelId);
      sent.push(content);
      events.push({
        id: eventId,
        channelId,
        authorPubkey: pubkey,
        content,
        createdAt: 1762800000,
      });
      return { eventId };
    },
    getMessages: async () => [...events],
  };
  return { transport, sent, events };
}

function frozen(p = alert(), decisionId = "decision-1"): OutboundDecision {
  return prepareBuzzDecision({
    kind: "outbound_decision",
    decisionId,
    op: "post_message",
    entityBindingRef: p.destinationSession ?? "",
    payload: p,
  }, { channelId, authorizedDestinations: new Set([recipient]) });
}

describe("Buzz outbound queue lab: durable confirmation, no cross-provider replay", () => {
  let home: string;
  let f: ReturnType<typeof fakeTransport>;
  let opts: BuzzOutboundOptions;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "buzz-outbound-"));
    f = fakeTransport();
    opts = {
      home, channelId,
      expectedPubkey: pubkey,
      authorizedDestinations: new Set([recipient]),
      transport: f.transport,
    };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("sweeps a queue and ACKs only the explicitly allowed human (never relay/shared channel)", async () => {
    const q: QueueItem[] = [
      alert(),
      alert({ qitemId: "q-relay", notificationKey: "q-relay:v1", destinationSession: "relay@external" }),
      alert({ qitemId: "q-shared", notificationKey: "q-shared:v1", sharedChannel: true }),
    ];
    const wire = buildBuzzOutboundLabWire({
      ...opts,
      queue: { listHumanAlerts: async () => q },
    });
    const result = await wire.sweepOnce();
    expect(result.dispatched).toEqual(["q-1"]);
    await wait(() => f.sent.length === 1 && new DispatchBuffer(home).pending().length === 0);
    expect(f.sent[0]).toContain("Check acceptance criteria");
    expect(f.sent[0]).toMatch(/\[OpenRig delivery: [a-f0-9]{32}\]/);
    expect(wire.status()).toMatchObject({
      productionReady: false, inboundReady: false, confirmed: 1, uncertain: 0,
    });
    const second = await wire.sweepOnce();
    expect(second.dispatched).toHaveLength(0);
    expect(f.sent).toHaveLength(1);
    wire.stop();
  });

  it("consumes actual SQLite QueueRepository owner notifications through makeQueuePorts", async () => {
    const db = createDb();
    try {
      migrate(db, ALL_MIGRATIONS);
      const registry = () => ({
        ok: true as const,
        entities: [{
          entityId: "jane",
          class: "human" as const,
          displayName: "Jane",
          address: recipient,
          connectorBindings: [{
            kind: "slack" as const, connectorRef: "lab",
            secretsRef: "test-pointer", role: "primary" as const,
          }],
          prefs: { deliveryClass: "B" as const },
        }],
      });
      const repo = new QueueRepository(db, new EventBus(db), {
        validateRig: () => true, loadHumanRegistry: registry,
      });
      const row = await repo.create({
        sourceSession: "agent@rig", destinationSession: recipient,
        body: "Please review the queue event", summary: "Owner required",
        nudge: false,
      });
      repo.update({
        qitemId: row.qitemId, actorSession: "agent@rig",
        state: "blocked", blockedOn: recipient,
        summary: "Owner required", transitionNote: "parked",
      });
      const queue = makeQueuePorts(repo, {
        loadHumanRegistry: registry, sharedChannels: () => [],
      });
      const eligible = await queue.listHumanAlerts({ minimumLevel: "NOTICE" });
      expect(eligible.some((i) => i.qitemId === row.qitemId)).toBe(true);
      const wire = buildBuzzOutboundLabWire({ ...opts, queue });
      const result = await wire.sweepOnce();
      expect(result.dispatched).toContain(row.qitemId);
      await wait(() => f.sent.length === 1 && new DispatchBuffer(home).pending().length === 0);
      expect(f.sent[0]).toContain("Please review the queue event");
      wire.stop();
    } finally {
      db.close();
    }
  });

  it("persisted attempt prevents a double post on CLI timeout, then reconciles by positive readback", async () => {
    let sends = 0;
    const transport: BuzzOutboundTransport = {
      sendMessage: async ({ content }) => {
        sends++;
        f.events.push({ id: eventId, content, authorPubkey: pubkey, channelId, createdAt: 1 });
        throw new Error("the relay accepted the post but the response was lost");
      },
      getMessages: async () => f.events,
    };
    const delivery = new BuzzOutboundDelivery({ ...opts, transport });
    const decision = frozen();
    const first = await delivery.deliver(decision);
    expect(first).toMatchObject({ ok: false, class: "buzz-delivery-outcome-unknown" });
    expect(delivery.status()).toEqual({ confirmed: 0, uncertain: 1 });
    const repeat = await delivery.deliver(decision);
    expect(repeat).toEqual({ ok: true });
    expect(sends).toBe(1);
    expect(delivery.status()).toEqual({ confirmed: 1, uncertain: 0 });
    expect((await delivery.deliver(frozen(alert(), "different-decision"))).ok).toBe(true);
    expect(sends).toBe(1); // Same episode, different decisionId, still one external message
  });

  it("does not blindly retry when the readback window is empty, even after a restart", async () => {
    let sends = 0;
    const transport: BuzzOutboundTransport = {
      sendMessage: async () => { sends++; throw new Error("network broke after possible submit"); },
      getMessages: async () => [],
    };
    const firstInstance = new BuzzOutboundDelivery({ ...opts, transport });
    expect((await firstInstance.deliver(frozen())).ok).toBe(false);
    const newInstance = new BuzzOutboundDelivery({ ...opts, transport });
    expect(await newInstance.deliver(frozen())).toMatchObject({
      ok: false, class: "buzz-delivery-outcome-unknown",
    });
    expect(sends).toBe(1);
    expect(newInstance.status().uncertain).toBe(1);
  });

  it("does not reconcile an event from a different pubkey or channel", async () => {
    let count = 0;
    const transport: BuzzOutboundTransport = {
      sendMessage: async ({ content }) => {
        count++;
        f.events.push({
          id: eventId, content, authorPubkey: "c".repeat(64),
          channelId, createdAt: 1,
        });
        throw new Error("ambiguous");
      },
      getMessages: async () => f.events,
    };
    const delivery = new BuzzOutboundDelivery({ ...opts, transport });
    expect((await delivery.deliver(frozen())).ok).toBe(false);
    expect(await delivery.deliver(frozen())).toMatchObject({
      ok: false, class: "buzz-delivery-outcome-unknown",
    });
    expect(count).toBe(1);
  });

  it("a notification's content cannot drift after an uncertain attempt", async () => {
    const transport: BuzzOutboundTransport = {
      sendMessage: async () => { throw new Error("unknown"); },
      getMessages: async () => [],
    };
    const delivery = new BuzzOutboundDelivery({ ...opts, transport });
    expect((await delivery.deliver(frozen())).ok).toBe(false);
    const changed = frozen(alert({ body: "different payload" }), "decision-2");
    expect(await delivery.deliver(changed)).toMatchObject({
      ok: false, class: "buzz-notification-changed-after-attempt",
    });
  });

  it("rejects a legacy Slack/relay buffer before constructing a Buzz wire", () => {
    new DispatchBuffer(home).enqueue({
      kind: "outbound_decision",
      decisionId: "legacy-slack",
      op: "post_message",
      entityBindingRef: recipient,
      payload: alert(),
    });
    expect(() => buildBuzzOutboundLabWire({
      ...opts, queue: { listHumanAlerts: async () => [alert()] },
    })).toThrow(/cannot adopt existing Slack, relay/);
    expect(f.sent).toEqual([]);
  });

  it("only frozen, explicitly allowed destinations can be submitted", async () => {
    const untagged: OutboundDecision = {
      kind: "outbound_decision", decisionId: "untagged", op: "post_message",
      entityBindingRef: recipient, payload: alert(),
    };
    expect(await new BuzzOutboundDelivery(opts).deliver(untagged)).toMatchObject({
      ok: false, class: "buzz-decision-invalid",
    });
    expect(() => prepareBuzzDecision({
      ...untagged, payload: { ...alert(), relayConnectorRef: "relay-main" },
    }, opts)).toThrow(/cannot prepare relay/);
    expect(() => prepareBuzzDecision({
      ...untagged, entityBindingRef: "other@external",
    }, opts)).toThrow(/not explicitly authorized/);
    expect(f.sent).toHaveLength(0);
  });

  it("fails closed when delivery ledger is corrupt (never discards evidence)", async () => {
    mkdirSync(join(home, "gateway"));
    writeFileSync(buzzLedgerPath(home), "{not valid json", { mode: 0o600 });
    const delivery = new BuzzOutboundDelivery(opts);
    expect(await delivery.deliver(frozen())).toMatchObject({
      ok: false, class: "buzz-ledger-unavailable",
    });
    expect(readFileSync(buzzLedgerPath(home), "utf8")).toBe("{not valid json");
    expect(f.sent).toHaveLength(0);
  });

  it("holds an existing lock without overwriting another worker's attempt", async () => {
    mkdirSync(join(home, "gateway"));
    writeFileSync(join(home, "gateway", "buzz-delivery-ledger.lock"), "", { mode: 0o600 });
    const delivery = new BuzzOutboundDelivery(opts);
    expect(await delivery.deliver(frozen())).toMatchObject({
      ok: false, class: "buzz-ledger-busy-or-stale-lock",
    });
    expect(f.sent).toHaveLength(0);
  });

  it("preserves a buffered decision after an ambiguous result; restart never makes a second send", async () => {
    let sends = 0;
    const transport: BuzzOutboundTransport = {
      sendMessage: async () => { sends++; throw new Error("timeout"); },
      getMessages: async () => [],
    };
    const q = { listHumanAlerts: async () => [alert()] };
    const wire = buildBuzzOutboundLabWire({ ...opts, transport, queue: q });
    await wire.sweepOnce();
    await wait(() => sends === 1 && new BuzzOutboundDelivery({ ...opts, transport }).status().uncertain === 1);
    expect(new DispatchBuffer(home).pending()).toHaveLength(1);
    wire.stop();
    const restarted = buildBuzzOutboundLabWire({ ...opts, transport, queue: q });
    restarted.startServices();
    await new Promise((r) => setTimeout(r, 75));
    expect(sends).toBe(1);
    expect(new DispatchBuffer(home).pending()).toHaveLength(1);
    restarted.stop();
  });

  it("replays a buffered accepted-but-unacknowledged event by reading a matching remote message", async () => {
    let sends = 0;
    const transport: BuzzOutboundTransport = {
      sendMessage: async ({ content }) => {
        sends++;
        f.events.push({ id: eventId, content, authorPubkey: pubkey, channelId, createdAt: 1 });
        throw new Error("lost receipt");
      },
      getMessages: async () => [...f.events],
    };
    const queue = { listHumanAlerts: async () => [alert()] };
    const wire = buildBuzzOutboundLabWire({ ...opts, transport, queue });
    await wire.sweepOnce();
    await wait(() => f.events.length === 1);
    await wait(() => new DispatchBuffer(home).pending().length === 1);
    wire.stop();
    const restarted = buildBuzzOutboundLabWire({ ...opts, transport, queue });
    restarted.startServices();
    await wait(() => new DispatchBuffer(home).pending().length === 0);
    expect(sends).toBe(1);
    expect(restarted.status()).toMatchObject({ confirmed: 1, uncertain: 0 });
    restarted.stop();
  });
});
