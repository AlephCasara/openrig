import { describe, expect, it } from "vitest";
import {
  BuzzCliClient,
  makeBuzzCliRunner,
  type BuzzRunner,
} from "../src/domain/gateway/buzz-cli.js";

const channel = "36c6fc48-43ca-4ec3-a850-27b145de9b1e";
const eventId = "a".repeat(64);
const author = "b".repeat(64);
const rootId = "c".repeat(64);
const post = { accepted: true, event_id: eventId, message: "accepted" };

const event = (overrides: Record<string, unknown> = {}) => ({
  id: eventId,
  pubkey: author,
  kind: 9,
  content: "Reply",
  created_at: 1_783_800_000,
  tags: [["h", channel], ["e", rootId, "", "reply"]],
  ...overrides,
});

describe("Buzz experimental CLI transport boundary", () => {
  it("posts over stdin, not via process argument, and checks relay acceptance", async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const runner: BuzzRunner = async (args, stdin) => {
      calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
      return JSON.stringify(post);
    };
    const client = new BuzzCliClient({ runner });
    expect(await client.sendMessage({ channelId: channel, content: "hello\nworld" }))
      .toEqual({ eventId });
    expect(calls).toEqual([
      { args: ["messages", "send", "--channel", channel, "--content", "-"], stdin: "hello\nworld" },
    ]);
    expect(JSON.stringify(calls[0]?.args)).not.toContain("hello");
  });

  it("supports replies while validating Nostr parent ID", async () => {
    const runner: BuzzRunner = async (args, stdin) => {
      expect(args).toEqual([
        "messages", "send", "--channel", channel, "--content", "-", "--reply-to", rootId,
      ]);
      expect(stdin).toBe("reply");
      return JSON.stringify(post);
    };
    const client = new BuzzCliClient({ runner });
    await expect(client.sendMessage({ channelId: channel, content: "reply", replyTo: rootId }))
      .resolves.toEqual({ eventId });
    await expect(client.sendMessage({ channelId: channel, content: "reply", replyTo: "not-a-nostr-id" }))
      .rejects.toThrow(/event ID/);
  });

  it("does not accept rejection, malformed response or arbitrary stdout as delivery", async () => {
    for (const body of [
      JSON.stringify({ accepted: false, event_id: eventId }),
      JSON.stringify({ accepted: true, event_id: "bad" }),
      "accepted",
      JSON.stringify({ ok: true }),
    ]) {
      const client = new BuzzCliClient({ runner: async () => body });
      await expect(client.sendMessage({ channelId: channel, content: "safe" })).rejects.toThrow();
    }
  });

  it("validates channels, payload size and empty messages before invoking runner", async () => {
    let called = 0;
    const client = new BuzzCliClient({ runner: async () => { called++; return ""; } });
    await expect(client.sendMessage({ channelId: "not-uuid", content: "x" })).rejects.toThrow(/UUID/);
    await expect(client.sendMessage({ channelId: channel, content: " " })).rejects.toThrow(/bytes/);
    await expect(client.sendMessage({ channelId: channel, content: "x".repeat(65537) })).rejects.toThrow(/bytes/);
    expect(called).toBe(0);
  });

  it("reads bounded JSON messages, preserving author, channel and thread correlation", async () => {
    const calls: readonly string[][] = [];
    const runner: BuzzRunner = async (args) => {
      (calls as string[][]).push([...args]);
      return JSON.stringify([
        event({ id: rootId, created_at: 1_783_799_999, tags: [["h", channel]] }),
        event(),
      ]);
    };
    const messages = await new BuzzCliClient({ runner }).getMessages({
      channelId: channel, since: 1_783_799_900, limit: 3,
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]?.id).toBe(rootId);
    expect(messages[1]).toMatchObject({
      id: eventId, authorPubkey: author, channelId: channel, replyTo: rootId, content: "Reply",
    });
    expect(calls).toEqual([[
      "messages", "get", "--channel", channel, "--limit", "3", "--kinds", "9",
      "--since", "1783799900",
    ]]);
  });

  it("exposes the official CLI before cursor for bounded backwards recovery", async () => {
    const argsSeen: string[][] = [];
    const client = new BuzzCliClient({
      runner: async (args) => { argsSeen.push([...args]); return "[]"; },
    });
    expect(await client.getMessages({ channelId: channel, before: 1783799999, limit: 80 })).toEqual([]);
    expect(argsSeen[0]).toEqual([
      "messages", "get", "--channel", channel, "--limit", "80", "--kinds", "9",
      "--before", "1783799999",
    ]);
    await expect(client.getMessages({ channelId: channel, before: 0 })).rejects.toThrow(/positive/);
  });

  it("refuses channel spoofing, missing author, unexpected event kind and oversized batch", async () => {
    const failures = [
      [event({ tags: [["h", "11111111-1111-1111-1111-111111111111"]] })],
      [event({ pubkey: "somebody" })],
      [event({ kind: 45001 })],
      [event({ created_at: -1 })],
      Array.from({ length: 201 }, () => event()),
    ];
    for (const payload of failures) {
      const client = new BuzzCliClient({ runner: async () => JSON.stringify(payload) });
      await expect(client.getMessages({ channelId: channel })).rejects.toThrow();
    }
  });

  it("validates pagination and output types", async () => {
    const client = new BuzzCliClient({ runner: async () => JSON.stringify({ wrong: true }) });
    await expect(client.getMessages({ channelId: channel })).rejects.toThrow(/batch/);
    await expect(client.getMessages({ channelId: channel, limit: 201 })).rejects.toThrow(/1–200/);
    await expect(client.getMessages({ channelId: channel, since: -1 })).rejects.toThrow(/timestamp/);
  });

  it("has timeout limits before starting any Buzz process", () => {
    expect(() => makeBuzzCliRunner("buzz", -1)).toThrow(/timeout/);
    expect(() => makeBuzzCliRunner("buzz", 120001)).toThrow(/timeout/);
  });

  it("returns process errors without leaking stderr", async () => {
    const runner = makeBuzzCliRunner("/this-path-is-deliberately-not-a-buzz-binary");
    await expect(runner(["messages", "get", "--channel", channel])).rejects.toThrow();
  });
});
