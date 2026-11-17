import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import {
  BuzzVerifiedHistoryClient, verifyBuzzSignedMessage, verifyBuzzNormalizedMessage,
} from "../src/domain/gateway/buzz/verified-history.js";

const channel = "2e4ab450-4c57-4541-8e3b-7491e1dd535f";
const otherChannel = "c60cb109-dc62-4ad4-9c90-3b72f97856b4";
const key = Uint8Array.from(Buffer.from("01".repeat(32), "hex"));
const authKey = "02".repeat(32);
const origin = "http://127.0.0.1:45125/";
const event = (content: string, second = 1762800000, ch = channel) =>
  finalizeEvent({ kind: 9, content, created_at: second, tags: [["h", ch]] }, key);

function fakeRelay(events: ReturnType<typeof event>[], onRequest?: (filter: Record<string, unknown>) => void) {
  const ordered = [...events].sort((a, b) =>
    b.created_at - a.created_at || a.id.localeCompare(b.id));
  const seenFilters: Record<string, unknown>[] = [];
  let requests = 0;
  const fetchImpl = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests++;
    const body = String(init?.body);
    const proof = JSON.parse(Buffer.from(
      String(new Headers(init?.headers).get("authorization")).slice(6), "base64",
    ).toString("utf8"));
    expect(verifyEvent(proof)).toBe(true);
    expect(proof.kind).toBe(27235);
    expect(proof.tags).toContainEqual(["method", "POST"]);
    expect(proof.tags).toContainEqual(["u", new URL("query", origin).toString()]);
    expect(proof.tags).toContainEqual(["payload", createHash("sha256").update(body).digest("hex")]);
    const filters = JSON.parse(body) as Record<string, unknown>[];
    expect(filters).toHaveLength(1);
    const f = filters[0]!;
    seenFilters.push(f);
    expect(f.kinds).toEqual([9]);
    expect(f["#h"]).toEqual([channel]);
    expect(f.consistency).toBe("strong");
    onRequest?.(f);
    const until = f.until as number | undefined;
    const beforeId = f.before_id as string | undefined;
    const matching = ordered.filter((e) => until === undefined ||
      e.created_at < until || (e.created_at === until && beforeId !== undefined && e.id > beforeId));
    const page = matching.slice(0, f.limit as number);
    return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    client: new BuzzVerifiedHistoryClient({ relayUrl: origin, privateKeyHex: authKey,
      fetchImpl: fetchImpl as typeof fetch }),
    seenFilters, getRequests: () => requests,
  };
}

describe("Buzz verified Nostr HTTP history: NIP-98 auth + composite keyset", () => {
  it("cryptographically verifies NIP-01 hash/signature and rejects forged events", () => {
    const raw = event("signed");
    expect(getPublicKey(key)).toBe(raw.pubkey);
    const verified = verifyBuzzSignedMessage(raw, channel);
    expect(verified).toMatchObject({ id: raw.id, content: "signed", authorPubkey: raw.pubkey });
    expect(verifyBuzzNormalizedMessage(verified, channel).id).toBe(raw.id);
    expect(() => verifyBuzzSignedMessage({ ...raw, content: "tampered" }, channel)).toThrow(/signature/);
    expect(() => verifyBuzzSignedMessage({ ...raw, id: "f".repeat(64) }, channel)).toThrow(/signature/);
    expect(() => verifyBuzzSignedMessage({ ...raw, sig: "0".repeat(128) }, channel)).toThrow(/signature/);
    expect(() => verifyBuzzSignedMessage(raw, otherChannel)).toThrow(/channel binding/);
    expect(() => verifyBuzzSignedMessage({ ...raw, tags: [...raw.tags, ["h", channel]] }, channel)).toThrow();
    expect(() => verifyBuzzNormalizedMessage({ ...verified, content: "forged" }, channel)).toThrow(/differs/);
    expect(() => verifyBuzzNormalizedMessage({ ...verified,
      signedEvent: { ...raw, content: "changed" } }, channel)).toThrow(/signature/);
  });

  it("recovers 265 messages created in ONE second without timestamp-based drops", async () => {
    const events = Array.from({ length: 265 }, (_, i) => event("dense-" + i));
    const { client, seenFilters } = fakeRelay(events);
    const result = await client.recoverVerifiedHistory({ channelId: channel, pageSize: 100, maxPages: 6 });
    expect(result).toMatchObject({ complete: true, pages: 3 });
    expect(result.events).toHaveLength(265);
    expect(new Set(result.events.map((e) => e.id)).size).toBe(265);
    expect(seenFilters[1]).toHaveProperty("before_id");
    expect(seenFilters[1]).toHaveProperty("until", 1762800000);
    for (const e of result.events) expect(verifyBuzzNormalizedMessage(e, channel).id).toBe(e.id);
  });

  it("refuses truncated histories instead of accepting a partial window", async () => {
    const events = Array.from({ length: 235 }, (_, i) => event("not-enough-pages-" + i));
    const { client } = fakeRelay(events);
    expect(await client.recoverVerifiedHistory({
      channelId: channel, pageSize: 100, maxPages: 2, checkHead: false,
    })).toMatchObject({ complete: false, reason: "buzz-history-page-limit", pages: 2, events: [] });
  });

  it("rejects cursor violations and repeated pages from a broken relay", async () => {
    const raw = event("repeated");
    const client = new BuzzVerifiedHistoryClient({
      relayUrl: origin, privateKeyHex: authKey,
      fetchImpl: async () => new Response(JSON.stringify([raw])) as unknown as Promise<Response>,
    });
    await expect(client.getVerifiedMessages({
      channelId: channel, cursor: { until: raw.created_at, beforeId: raw.id },
    })).rejects.toThrow(/outside the requested keyset/);
  });

  it("rejects an incorrect event signature in a late page before it enters the caller's inbox", async () => {
    const good = event("good");
    const corrupted = { ...event("bad", 1762799999), content: "changed-after-signing" };
    let calls = 0;
    const client = new BuzzVerifiedHistoryClient({
      relayUrl: origin, privateKeyHex: authKey,
      fetchImpl: async () => new Response(JSON.stringify((++calls === 1) ? [good] : [corrupted])) as unknown as Promise<Response>,
    });
    await expect(client.recoverVerifiedHistory({ channelId: channel, pageSize: 1, maxPages: 3 }))
      .rejects.toThrow(/signature/);
  });

  it("fails closed if the latest page changes while recovering", async () => {
    const original = event("original");
    const later = event("later", original.created_at + 1);
    let calls = 0;
    const client = new BuzzVerifiedHistoryClient({
      relayUrl: origin, privateKeyHex: authKey,
      fetchImpl: async () => new Response(JSON.stringify((++calls === 1) ? [original] : [later])) as unknown as Promise<Response>,
    });
    expect(await client.recoverVerifiedHistory({ channelId: channel, pageSize: 100 })).toMatchObject({
      complete: false, reason: "buzz-history-head-changed", events: [],
    });
  });

  it("rejects dangerous relay URLs, oversized cursor requests and malformed response", async () => {
    expect(() => new BuzzVerifiedHistoryClient({
      relayUrl: "http://example.com/", privateKeyHex: authKey,
    })).toThrow(/HTTPS/);
    expect(() => new BuzzVerifiedHistoryClient({
      relayUrl: "https://alice:token@example.com/", privateKeyHex: authKey,
    })).toThrow(/HTTPS/);
    const client = new BuzzVerifiedHistoryClient({
      relayUrl: origin, privateKeyHex: authKey,
      fetchImpl: async () => new Response("not-json") as unknown as Promise<Response>,
    });
    await expect(client.getVerifiedMessages({ channelId: channel })).rejects.toThrow(/malformed JSON/);
    await expect(client.getVerifiedMessages({ channelId: channel, limit: 201 })).rejects.toThrow(/1-200/);
    await expect(client.getVerifiedMessages({ channelId: channel, cursor: {
      until: 1, beforeId: "not-an-id",
    } })).rejects.toThrow(/cursor/);
    await expect(client.recoverVerifiedHistory({
      channelId: channel, pageSize: 200, maxPages: 20,
    })).rejects.toThrow(/memory budget/);
  });

  it("requires a signed non-redirecting HTTP query response and never follows auth redirects", async () => {
    const client = new BuzzVerifiedHistoryClient({
      relayUrl: origin, privateKeyHex: authKey,
      fetchImpl: async (_u, init) => {
        expect(init?.redirect).toBe("manual");
        return new Response("unauthorized", { status: 401 });
      },
    });
    await expect(client.getVerifiedMessages({ channelId: channel }))
      .rejects.toThrow(/HTTP 401/);
  });
});
