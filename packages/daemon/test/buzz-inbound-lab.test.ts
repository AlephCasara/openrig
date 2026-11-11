import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BuzzInboundLab, buzzInboundLedgerPath, type BuzzInboundLabOpts } from "../src/domain/gateway/buzz/inbound-lab.js";
import type { BuzzMessage } from "../src/domain/gateway/buzz-cli.js";
import type { QueueItem } from "../src/domain/gateway/slack/queue-access.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";

const channelId = "ab6a5141-6aad-44c8-9d6d-cdadba48f999";
const owner = "a".repeat(64);
const guest = "b".repeat(64);
const outsider = "c".repeat(64);
const rootId = "d".repeat(64);
const replyId = "e".repeat(64);
const human = "demo-human@external";
const seat = "agent@rig";

function msg(overrides: Partial<BuzzMessage> = {}): BuzzMessage {
  return {
    id: replyId, authorPubkey: guest, channelId,
    content: "Human feedback for review",
    createdAt: 1762800000, replyTo: rootId, ...overrides,
  };
}

describe("Buzz inbound proof: authenticated sender mapping and durable custody", () => {
  let home: string;
  let events: BuzzMessage[];
  let rows: Map<string, QueueItem>;
  let creates: Array<Record<string, unknown>>;
  let opts: BuzzInboundLabOpts;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "buzz-inbound-"));
    events = [msg()];
    rows = new Map();
    creates = [];
    opts = {
      home, channelId, selfPubkey: owner,
      allowedHumans: new Map([[guest, human]]),
      resolveConfirmedRoot: (id) => id === rootId ? { qitemId: "qitem-root-1", recipient: human, seat } : null,
      transport: { getMessages: async () => events },
      queue: {
        getQitem: (id) => rows.get(id) ?? null,
        createQitem: async (input) => {
          creates.push(input);
          rows.set(input.qitemId!, {
            qitemId: input.qitemId!,
            sourceSession: input.source, destinationSession: input.destination, body: input.body,
          });
          return input.qitemId!;
        },
      },
    };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("admits a registered person's thread reply as correspondence only, once across restarts", async () => {
    const first = await new BuzzInboundLab(opts).pollOnce();
    expect(first).toMatchObject({ ok: true, accepted: 1, scanned: 1 });
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      qitemId: "qitem-buzz-" + replyId.slice(0, 32),
      source: human, destination: seat, humanAnswer: false,
      inReplyTo: "qitem-root-1",
      tags: ["inbound", "buzz", "human-correspondence"],
    });
    const replay = await new BuzzInboundLab(opts).pollOnce();
    expect(replay).toMatchObject({ ok: true, accepted: 0 });
    expect(creates).toHaveLength(1);
  });

  it("drops unauthorized authors, owner echoes and messages without a confirmed thread", async () => {
    events = [
      msg({ id: "1".repeat(64), authorPubkey: outsider }),
      msg({ id: "2".repeat(64), authorPubkey: owner }),
      msg({ id: "3".repeat(64), replyTo: "0".repeat(64) }),
      msg({ id: "4".repeat(64), replyTo: undefined }),
      msg({ id: "5".repeat(64), authorPubkey: guest, content: "   " }),
    ];
    expect(await new BuzzInboundLab(opts).pollOnce()).toMatchObject({
      ok: true, accepted: 0, ignored: 5,
    });
    expect(creates).toHaveLength(0);
  });

  it("refuses messages from a valid pubkey for a different recipient", async () => {
    opts.resolveConfirmedRoot = () => ({ qitemId: "qitem-root-2", recipient: "another-human@external", seat });
    expect(await new BuzzInboundLab(opts).pollOnce()).toMatchObject({
      ok: true, accepted: 0, ignored: 1,
    });
    expect(creates).toHaveLength(0);
  });

  it("fails closed on saturated readback; no pretend complete cursor", async () => {
    opts.limit = 2;
    events = [msg(), msg({ id: "1".repeat(64) })];
    expect(await new BuzzInboundLab(opts).pollOnce()).toMatchObject({
      ok: false, reason: "buzz-window-saturated", accepted: 0,
    });
    expect(creates).toHaveLength(0);
  });

  it("recovers a queue commit whose insertion result was lost", async () => {
    const realCreate = opts.queue.createQitem;
    opts.queue.createQitem = async (input) => {
      await realCreate(input);
      throw new Error("simulated response loss after SQLite commit");
    };
    expect(await new BuzzInboundLab(opts).pollOnce()).toMatchObject({ ok: true, accepted: 1 });
    expect(creates).toHaveLength(1);
    expect(await new BuzzInboundLab(opts).pollOnce()).toMatchObject({ ok: true, accepted: 0 });
  });

  it("leaves a durable pending receipt when queue insertion failed, then recovers", async () => {
    opts.queue.createQitem = async () => { throw new Error("SQLite not ready"); };
    await expect(new BuzzInboundLab(opts).pollOnce()).rejects.toThrow(/SQLite not ready/);
    const state = JSON.parse(readFileSync(buzzInboundLedgerPath(home), "utf8")) as {
      entries: Record<string, { state: string }>;
    };
    expect(state.entries[replyId]?.state).toBe("received");
    let count = 0;
    opts.queue.createQitem = async (input) => {
      count++;
      rows.set(input.qitemId!, { qitemId: input.qitemId!, sourceSession: input.source,
        destinationSession: input.destination, body: input.body });
      return input.qitemId!;
    };
    expect(await new BuzzInboundLab(opts).pollOnce()).toMatchObject({ ok: true, accepted: 1 });
    expect(count).toBe(1);
  });

  it("does not overwrite a recorded event that changes content", async () => {
    await new BuzzInboundLab(opts).pollOnce();
    events = [msg({ content: "tampered history" })];
    await expect(new BuzzInboundLab(opts).pollOnce()).rejects.toThrow(/changed after receipt/);
    expect(creates).toHaveLength(1);
  });

  it("blocks on ledger corruption without generating an inbound qitem", async () => {
    mkdirSync(join(home, "gateway"));
    writeFileSync(buzzInboundLedgerPath(home), "{wrong");
    await expect(new BuzzInboundLab(opts).pollOnce()).rejects.toThrow(/ledger corrupt/);
    expect(creates).toHaveLength(0);
  });

  it("writes a real, SQLite-backed OpenRig QueueRepository row through makeQueuePorts", async () => {
    const db = createDb();
    try {
      migrate(db, ALL_MIGRATIONS);
      const registry = () => ({
        ok: true as const,
        entities: [{
          entityId: "demo-human",
          class: "human" as const,
          displayName: "Demo Human",
          address: human,
          connectorBindings: [{
            kind: "slack" as const,
            connectorRef: "test",
            secretsRef: "test-only-pointer",
            role: "primary" as const,
          }],
          prefs: { deliveryClass: "B" as const },
        }],
      });
      const repo = new QueueRepository(db, new EventBus(db), {
        validateRig: () => true, loadHumanRegistry: registry,
      });
      const root = await repo.create({
        sourceSession: seat,
        destinationSession: human,
        summary: "Review request",
        body: "Please review.",
        nudge: false,
      });
      opts.resolveConfirmedRoot = (id) => id === rootId
        ? { qitemId: root.qitemId, recipient: human, seat }
        : null;
      const ports = makeQueuePorts(repo, {
        loadHumanRegistry: registry,
        sharedChannels: () => [],
      });
      opts.queue = {
        createQitem: ports.createQitem,
        getQitem: (id) => ports.getQitem!(id),
      };
      expect(await new BuzzInboundLab(opts).pollOnce()).toMatchObject({
        ok: true, accepted: 1,
      });
      const id = "qitem-buzz-" + replyId.slice(0, 32);
      expect(repo.getById(id)).toMatchObject({
        sourceSession: human, destinationSession: seat,
        body: "Human feedback for review",
        replyTo: root.qitemId,
      });
      expect(await new BuzzInboundLab(opts).pollOnce()).toMatchObject({
        ok: true, accepted: 0,
      });
    } finally {
      db.close();
    }
  });

  it("backfills a long history in timestamp-overlapping pages and commits every event once", async () => {
    opts.limit = 80;
    const all = Array.from({ length: 225 }, (_, i) => msg({
      id: createHash("sha256").update("history-" + i).digest("hex"),
      createdAt: 1_750_000_000 + i,
      content: "Human reply " + i,
    }));
    let pages = 0;
    opts.transport = {
      getMessages: async ({ limit, before }) => {
        pages++;
        return all.filter((ev) => before === undefined || ev.createdAt < before)
          .sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
      },
    };
    const first = await new BuzzInboundLab(opts).recoverHistory({ maxPages: 12 });
    expect(first).toMatchObject({ ok: true, accepted: 225 });
    expect(first.pages).toBeGreaterThanOrEqual(3);
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(creates).toHaveLength(225);
    const again = await new BuzzInboundLab(opts).recoverHistory({ maxPages: 12 });
    expect(again).toMatchObject({ ok: true, accepted: 0 });
    expect(creates).toHaveLength(225);
  });

  it("does not partially ingest an ambiguous same-second timestamp boundary", async () => {
    opts.limit = 20;
    const all = Array.from({ length: 32 }, (_, i) => msg({
      id: createHash("sha256").update("tie-" + i).digest("hex"),
      createdAt: 1_760_000_000,
      content: "Same second " + i,
    }));
    opts.transport = {
      getMessages: async ({ limit, before }) => all
        .filter((ev) => before === undefined || ev.createdAt < before)
        .slice(0, limit),
    };
    expect(await new BuzzInboundLab(opts).recoverHistory()).toMatchObject({
      ok: false, reason: "buzz-ambiguous-timestamp-boundary", accepted: 0,
    });
    expect(creates).toHaveLength(0);
  });

  it("returns incomplete without queue side effects when recovery page budget is exhausted", async () => {
    opts.limit = 2;
    const all = Array.from({ length: 15 }, (_, i) => msg({
      id: createHash("sha256").update("cap-" + i).digest("hex"),
      createdAt: i + 1,
    }));
    opts.transport = {
      getMessages: async ({ limit, before }) => all
        .filter((ev) => before === undefined || ev.createdAt < before)
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, limit),
    };
    expect(await new BuzzInboundLab(opts).recoverHistory({ maxPages: 2 })).toMatchObject({
      ok: false, reason: "buzz-recovery-page-limit", accepted: 0, pages: 2,
    });
    expect(creates).toHaveLength(0);
  });

  it("refuses simultaneous consumers using an exclusive lock", async () => {
    mkdirSync(join(home, "gateway"));
    writeFileSync(join(home, "gateway", "buzz-inbound-ledger.lock"), "");
    expect(await new BuzzInboundLab(opts).pollOnce()).toMatchObject({
      ok: false, reason: "buzz-inbound-ledger-locked",
    });
    expect(creates).toHaveLength(0);
  });
});
