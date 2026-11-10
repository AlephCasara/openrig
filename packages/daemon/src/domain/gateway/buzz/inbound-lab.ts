// Standalone Buzz inbound proof, not wired into daemon or human-approval handlers.
// Accept ONLY a reply to a known, confirmed outbound event from a registered
// pubkey; persist the inbound identity before queue creation; never auto-approve.
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { BuzzMessage } from "../buzz-cli.js";
import type { InboundQueuePort, QueueItem } from "../slack/queue-access.js";

const EVENT_ID = /^[0-9a-f]{64}$/i;
const MAX_INBOUND_BODY = 64 * 1024;
const MAX_WINDOW = 200;

export interface BuzzReplyRoot {
  /** The original OpenRig ask that was sent as this Buzz root message. */
  qitemId: string;
  /** Only replies from the intended registered human can be admitted. */
  recipient: string;
  /** The agent who authored the original ask. */
  seat: string;
}

export interface BuzzInboundTransport {
  getMessages(input: { channelId: string; limit: number }): Promise<BuzzMessage[]>;
}

export interface BuzzInboundLabOpts {
  home: string;
  channelId: string;
  selfPubkey: string;
  /** Maps verified sender pubkey to registered OpenRig human address. */
  allowedHumans: ReadonlyMap<string, string>;
  /** Must resolve ONLY a confirmed outbound event for this channel. */
  resolveConfirmedRoot: (eventId: string) => BuzzReplyRoot | null;
  queue: Required<Pick<InboundQueuePort, "createQitem" | "getQitem">>;
  transport: BuzzInboundTransport;
  limit?: number;
}

interface InboundEntry {
  state: "received" | "landed";
  qitemId: string;
  fingerprint: string;
}
interface Ledger {
  schemaVersion: 1;
  entries: Record<string, InboundEntry>;
}

export function buzzInboundLedgerPath(home: string): string {
  return join(home, "gateway", "buzz-inbound-ledger.json");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function readLedger(file: string): Ledger {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, entries: {} };
    throw new Error("Buzz inbound ledger cannot be read");
  }
  try {
    const data = JSON.parse(text) as Ledger;
    if (data.schemaVersion !== 1 || !data.entries || typeof data.entries !== "object" || Array.isArray(data.entries)) throw new Error();
    for (const [id, entry] of Object.entries(data.entries)) {
      if (!EVENT_ID.test(id) || !entry || !["received", "landed"].includes(entry.state)
        || !entry.qitemId?.startsWith("qitem-buzz-") || !EVENT_ID.test(entry.fingerprint)) throw new Error();
    }
    return data;
  } catch {
    throw new Error("Buzz inbound ledger corrupt; retry prohibited");
  }
}

function writeLedger(file: string, ledger: Ledger): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + ".tmp-" + randomUUID();
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(ledger));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
    const d = openSync(dirname(file), "r");
    try { fsyncSync(d); } finally { closeSync(d); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function sameQitem(row: QueueItem, payload: {
  source: string; destination: string; body: string;
}): boolean {
  return row.sourceSession === payload.source
    && row.destinationSession === payload.destination
    && row.body === payload.body;
}

export class BuzzInboundLab {
  private readonly ledgerFile: string;
  private readonly lockFile: string;

  constructor(private readonly opts: BuzzInboundLabOpts) {
    if (!EVENT_ID.test(opts.selfPubkey)) throw new Error("invalid self pubkey");
    if (!Number.isSafeInteger(opts.limit ?? 100) || (opts.limit ?? 100) < 1
      || (opts.limit ?? 100) > MAX_WINDOW) throw new Error("invalid Buzz inbound read window");
    this.ledgerFile = buzzInboundLedgerPath(opts.home);
    this.lockFile = join(opts.home, "gateway", "buzz-inbound-ledger.lock");
  }

  async pollOnce(): Promise<{
    ok: boolean; reason?: string; accepted: number; ignored: number; scanned: number;
  }> {
    const limit = this.opts.limit ?? 100;
    // No pagination cursor exists yet. A full window cannot prove complete
    // coverage: refuse the batch instead of falsely claiming no event loss.
    const messages = await this.opts.transport.getMessages({ channelId: this.opts.channelId, limit });
    if (messages.length >= limit) {
      return { ok: false, reason: "buzz-window-saturated", accepted: 0, ignored: 0, scanned: messages.length };
    }
    mkdirSync(dirname(this.lockFile), { recursive: true, mode: 0o700 });
    let lock: number;
    try { lock = openSync(this.lockFile, "wx", 0o600); }
    catch { return { ok: false, reason: "buzz-inbound-ledger-locked", accepted: 0, ignored: 0, scanned: messages.length }; }
    let accepted = 0;
    let ignored = 0;
    try {
      const ledger = readLedger(this.ledgerFile);
      for (const ev of messages) {
        if (!EVENT_ID.test(ev.id) || !EVENT_ID.test(ev.authorPubkey)
          || ev.channelId.toLowerCase() !== this.opts.channelId.toLowerCase()
          || typeof ev.content !== "string" || Buffer.byteLength(ev.content, "utf8") > MAX_INBOUND_BODY) {
          throw new Error("invalid Buzz inbound message metadata");
        }
        if (ev.authorPubkey.toLowerCase() === this.opts.selfPubkey.toLowerCase()) { ignored++; continue; }
        const human = this.opts.allowedHumans.get(ev.authorPubkey.toLowerCase());
        if (!human || !ev.replyTo || !EVENT_ID.test(ev.replyTo)) { ignored++; continue; }
        const root = this.opts.resolveConfirmedRoot(ev.replyTo);
        if (!root || root.recipient !== human || !root.qitemId || !root.seat
          || !ev.content.trim()) { ignored++; continue; }
        // A reply becomes correspondence; humanAnswer=false explicitly forbids
        // treating a raw message as permission to resolve a pending decision.
        const request = {
          qitemId: "qitem-buzz-" + ev.id.slice(0, 32),
          source: human,
          destination: root.seat,
          body: ev.content,
          summary: "Buzz message from registered human",
          inReplyTo: root.qitemId,
          humanAnswer: false,
          tags: ["inbound", "buzz", "human-correspondence"],
        };
        const fingerprint = sha256(JSON.stringify([
          ev.id, ev.authorPubkey, ev.channelId, ev.content,
          request.source, request.destination, request.inReplyTo,
        ]));
        const receipt = ledger.entries[ev.id];
        if (receipt && (receipt.qitemId !== request.qitemId || receipt.fingerprint !== fingerprint)) {
          throw new Error("Buzz inbound message changed after receipt");
        }
        if (receipt?.state === "landed") { ignored++; continue; }
        if (!receipt) {
          ledger.entries[ev.id] = { state: "received", qitemId: request.qitemId, fingerprint };
          writeLedger(this.ledgerFile, ledger);
        }
        const exists = this.opts.queue.getQitem(request.qitemId);
        if (exists && !sameQitem(exists, request)) throw new Error("Buzz inbound queue ID collides with unrelated item");
        if (!exists) {
          try {
            const created = await this.opts.queue.createQitem(request);
            if (created !== request.qitemId) throw new Error("Buzz inbound queue did not honor deterministic ID");
          } catch (error) {
            // A queue insert can commit before its response is lost.
            const after = this.opts.queue.getQitem(request.qitemId);
            if (!after || !sameQitem(after, request)) throw error;
          }
        }
        ledger.entries[ev.id] = { state: "landed", qitemId: request.qitemId, fingerprint };
        writeLedger(this.ledgerFile, ledger);
        accepted++;
      }
      return { ok: true, accepted, ignored, scanned: messages.length };
    } finally {
      closeSync(lock);
      try { unlinkSync(this.lockFile); } catch { /* Remain fail-closed if lock could not be released. */ }
    }
  }
}
