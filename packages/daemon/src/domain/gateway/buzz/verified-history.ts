// Buzz HTTP bridge: NIP-98 signed queries + local NIP-01 event verification.
// Experimental. No daemon startup, user profiles, key storage or background polls.
import { createHash, randomUUID } from "node:crypto";
import { finalizeEvent, verifyEvent, type Event as NostrEvent } from "nostr-tools/pure";
import type { BuzzMessage } from "../buzz-cli.js";

const EVENT_ID = /^[0-9a-f]{64}$/;
const SIG = /^[0-9a-f]{128}$/;
const CHANNEL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_HTTP_RESPONSE_BYTES = 12 * 1024 * 1024;
const PAGE_LIMIT_MAX = 200;

export interface VerifiedBuzzMessage extends BuzzMessage {
  /** Complete raw event retained for re-verification at the inbound admission boundary. */
  signedEvent: NostrEvent;
}

export interface BuzzCompositeCursor {
  until: number;
  beforeId: string;
}

export interface BuzzVerifiedQueryOptions {
  relayUrl: string;
  /** Private key is only used to sign NIP-98 HTTP requests, never logged or persisted. */
  privateKeyHex: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function requireChannel(value: string): void {
  if (!CHANNEL.test(value)) throw new Error("Buzz channel must be canonical lowercase UUID");
}

function isObj(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input);
}

function toRawEvent(input: unknown): NostrEvent {
  if (!isObj(input) || !EVENT_ID.test(String(input.id)) || !EVENT_ID.test(String(input.pubkey))
    || !SIG.test(String(input.sig)) || input.kind !== 9
    || !Number.isSafeInteger(input.created_at) || (input.created_at as number) < 0
    || typeof input.content !== "string"
    || Buffer.byteLength(input.content, "utf8") > MAX_MESSAGE_BYTES
    || !Array.isArray(input.tags) || input.tags.length > 256) {
    throw new Error("Buzz event has malformed Nostr envelope");
  }
  const tags = input.tags;
  if (!tags.every((tag) => Array.isArray(tag)
    && tag.length >= 2 && tag.length <= 16
    && tag.every((part: unknown) => typeof part === "string" && part.length <= 2048))) {
    throw new Error("Buzz event has malformed Nostr tags");
  }
  // New object on every verification: nostr-tools caches verification on the
  // object itself; never trust a previously verified mutable caller-owned object.
  return {
    id: input.id as string,
    pubkey: input.pubkey as string,
    sig: input.sig as string,
    kind: 9,
    created_at: input.created_at as number,
    content: input.content,
    tags: (tags as string[][]).map((tag) => [...tag]),
  };
}

export function verifyBuzzSignedMessage(input: unknown, channelId: string): VerifiedBuzzMessage {
  requireChannel(channelId);
  const event = toRawEvent(input);
  if (!verifyEvent(event)) throw new Error("Buzz Nostr signature or event ID verification failed");
  const channelTags = event.tags.filter((tag) => tag[0] === "h");
  if (channelTags.length !== 1 || channelTags[0]![1] !== channelId) {
    throw new Error("Buzz event channel binding is missing or ambiguous");
  }
  const eTags = event.tags.filter((tag) => tag[0] === "e");
  const roots = eTags.filter((tag) => tag[3] === "root");
  const replies = eTags.filter((tag) => tag[3] === "reply");
  if (roots.length > 1 || replies.length > 1
    || eTags.some((tag) => !EVENT_ID.test(tag[1] ?? ""))) {
    throw new Error("Buzz event thread references malformed or ambiguous");
  }
  const root = roots[0]?.[1];
  const reply = replies[0]?.[1] ?? (eTags.length === 1 ? eTags[0]?.[1] : undefined);
  return {
    id: event.id, authorPubkey: event.pubkey,
    channelId, content: event.content, createdAt: event.created_at,
    ...(reply === undefined ? {} : { replyTo: reply }),
    ...(root === undefined ? {} : { threadRoot: root }),
    signedEvent: event,
  };
}

export function verifyBuzzNormalizedMessage(input: BuzzMessage, channelId: string): VerifiedBuzzMessage {
  const raw: unknown = (input as { signedEvent?: unknown }).signedEvent;
  const verified = verifyBuzzSignedMessage(raw, channelId);
  if (input.id !== verified.id || input.authorPubkey !== verified.authorPubkey
    || input.content !== verified.content || input.createdAt !== verified.createdAt
    || input.channelId !== verified.channelId || input.replyTo !== verified.replyTo
    || input.threadRoot !== verified.threadRoot) {
    throw new Error("Buzz normalized message differs from signed event");
  }
  return verified;
}

function safeRelayUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Buzz relay URL is malformed"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Buzz relay must be HTTPS or local loopback HTTP without credentials");
  }
  return url;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const headerSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(headerSize) && headerSize > MAX_HTTP_RESPONSE_BYTES) {
    throw new Error("Buzz HTTP query response exceeded maximum size");
  }
  if (!response.body) throw new Error("Buzz query returned no response body");
  const reader = response.body.getReader();
  const buffers: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_HTTP_RESPONSE_BYTES) throw new Error("Buzz HTTP query response exceeded maximum size");
      buffers.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(buffers.map((item) => Buffer.from(item)), length).toString("utf8");
}

export class BuzzVerifiedHistoryClient {
  private readonly url: string;
  private readonly key: Uint8Array;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: BuzzVerifiedQueryOptions) {
    this.url = new URL("query", safeRelayUrl(opts.relayUrl)).toString();
    if (!EVENT_ID.test(opts.privateKeyHex)) throw new Error("Buzz NIP-98 private key must be 64 lowercase hex characters");
    this.key = Uint8Array.from(Buffer.from(opts.privateKeyHex, "hex"));
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) {
      throw new Error("invalid Buzz query timeout");
    }
  }

  async getVerifiedMessages(input: {
    channelId: string; limit?: number; cursor?: BuzzCompositeCursor;
  }): Promise<VerifiedBuzzMessage[]> {
    requireChannel(input.channelId);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) {
      throw new Error("Buzz query limit must be 1-200");
    }
    if (input.cursor && (
      !Number.isSafeInteger(input.cursor.until) || input.cursor.until < 0
      || !EVENT_ID.test(input.cursor.beforeId)
    )) {
      throw new Error("Buzz composite cursor is invalid");
    }
    const filter = {
      kinds: [9], "#h": [input.channelId], limit,
      // Require writer-pool read instead of a possibly stale replica.
      consistency: "strong",
      ...(input.cursor ? { until: input.cursor.until, before_id: input.cursor.beforeId } : {}),
    };
    const body = JSON.stringify([filter]);
    const proof = finalizeEvent({
      kind: 27235, content: "", created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", this.url], ["method", "POST"],
        ["payload", createHash("sha256").update(body).digest("hex")],
        ["nonce", randomUUID()],
      ],
    }, this.key);
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: "Nostr " + Buffer.from(JSON.stringify(proof)).toString("base64"),
        "content-type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      // Do not leak upstream response body, which may include identifiers.
      throw new Error("Buzz authenticated history query failed (HTTP " + response.status + ")");
    }
    let data: unknown;
    try { data = JSON.parse(await readBoundedResponse(response)) as unknown; }
    catch { throw new Error("Buzz history query returned malformed JSON"); }
    if (!Array.isArray(data) || data.length > limit) throw new Error("Buzz history query has invalid batch size");
    const verified = data.map((raw) => verifyBuzzSignedMessage(raw, input.channelId));
    for (let i = 1; i < verified.length; i++) {
      const prev = verified[i - 1]!;
      const current = verified[i]!;
      if (current.createdAt > prev.createdAt
        || (current.createdAt === prev.createdAt && current.id <= prev.id)) {
        throw new Error("Buzz history query did not preserve strict (created_at DESC, id ASC) ordering");
      }
    }
    if (input.cursor && verified.some((event) =>
      event.createdAt > input.cursor!.until
      || (event.createdAt === input.cursor!.until && event.id <= input.cursor!.beforeId))) {
      throw new Error("Buzz relay returned an event outside the requested keyset cursor");
    }
    return verified;
  }

  /** Never return a partial list as complete. Dense same-second bursts are
   *  handled with the official composite cursor. This proves bounded keyset
   *  exhaustion for the queried view, not a stable snapshot under mutations.
   */
  async recoverVerifiedHistory(input: {
    channelId: string; pageSize?: number; maxPages?: number; checkHead?: boolean;
  }): Promise<{
    complete: boolean; reason?: string; pages: number; events: VerifiedBuzzMessage[];
  }> {
    const pageSize = input.pageSize ?? 100;
    const maxPages = input.maxPages ?? 20;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 256) {
      throw new Error("Buzz maxPages must be 1-256");
    }
    // Bound process RSS in low-memory installations, even if the caller
    // supplies otherwise-valid individually bounded page parameters.
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_LIMIT_MAX
      || pageSize * maxPages > 2_000) {
      throw new Error("Buzz history read exceeds its 2000-event memory budget");
    }
    let cursor: BuzzCompositeCursor | undefined;
    let headPage: VerifiedBuzzMessage[] = [];
    const found = new Map<string, VerifiedBuzzMessage>();
    for (let page = 1; page <= maxPages; page++) {
      const events = await this.getVerifiedMessages({ channelId: input.channelId,
        limit: pageSize, ...(cursor ? { cursor } : {}) });
      if (page === 1) headPage = events;
      for (const event of events) {
        if (found.has(event.id)) throw new Error("Buzz composite history returned a duplicate event ID");
        found.set(event.id, event);
      }
      if (events.length < pageSize) {
        if (input.checkHead !== false) {
          const recheck = await this.getVerifiedMessages({
            channelId: input.channelId, limit: pageSize,
          });
          if (recheck.map((ev) => ev.id).join(",") !== headPage.map((ev) => ev.id).join(",")) {
            return { complete: false, reason: "buzz-history-head-changed",
              pages: page, events: [] };
          }
        }
        const ordered = [...found.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        return { complete: true, pages: page, events: ordered };
      }
      const last = events.at(-1);
      if (!last) throw new Error("Buzz full history page was empty");
      if (cursor && (
        last.createdAt > cursor.until
        || (last.createdAt === cursor.until && last.id <= cursor.beforeId)
      )) throw new Error("Buzz composite cursor did not advance");
      cursor = { until: last.createdAt, beforeId: last.id };
    }
    return { complete: false, reason: "buzz-history-page-limit",
      pages: maxPages, events: [] };
  }
}
