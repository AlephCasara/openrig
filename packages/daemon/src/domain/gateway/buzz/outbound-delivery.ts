// Experimental outbound-only Buzz transport. NOT connected to daemon startup.
// Durable attempt-before-side-effect: a CLI timeout is ambiguous and MUST NOT be
// blindly retried. Readback may positively reconcile; absence never proves failure.
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { OutboundDecision } from "../protocol.js";
import type { SubsystemDeliveryOutcome } from "../gateway-subsystem.js";
import type { BuzzMessage, BuzzPostReceipt } from "../buzz-cli.js";
import type { OutboundPostPayload } from "../slack/outbound-driver.js";

const MAX_MESSAGE_BYTES = 64 * 1024;
const EVENT_ID = /^[0-9a-f]{64}$/i;
const OWNER = /^[0-9a-f]{64}$/i;
const MAX_KEY_BYTES = 512;

export const BUZZ_OUTBOUND_OP = "post_message";

export interface BuzzOutboundTransport {
  sendMessage(input: { channelId: string; content: string; replyTo?: string }): Promise<BuzzPostReceipt>;
  getMessages(input: { channelId: string; limit?: number }): Promise<BuzzMessage[]>;
}

export interface BuzzOutboundOptions {
  home: string;
  channelId: string;
  expectedPubkey: string;
  authorizedDestinations: ReadonlySet<string>;
  /** Optional fresh registry check; errors deny delivery rather than using a stale snapshot. */
  destinationAllowed?: (address: string) => boolean;
  transport: BuzzOutboundTransport;
}

export interface BuzzDeliveryRecord {
  state: "attempting" | "confirmed";
  channelId: string;
  destination: string;
  contentHash: string;
  pubkey: string;
  /** Persisted only for new lab attempts; legacy entries without it are not reply roots. */
  qitemId?: string;
  sourceSeat?: string;
  eventId?: string;
}

interface Ledger {
  schemaVersion: 1;
  records: Record<string, BuzzDeliveryRecord>;
}

interface BuzzPayload extends OutboundPostPayload {
  buzzTransport?: { schemaVersion: 1; channelId: string };
  relayConnectorRef?: string;
  relayEnvelope?: unknown;
}

export function buzzLedgerPath(home: string): string {
  return join(home, "gateway", "buzz-delivery-ledger.json");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validRecord(v: unknown): v is BuzzDeliveryRecord {
  if (!isObject(v)) return false;
  return (v.state === "attempting" || v.state === "confirmed")
    && typeof v.channelId === "string"
    && typeof v.destination === "string"
    && typeof v.contentHash === "string" && EVENT_ID.test(v.contentHash)
    && typeof v.pubkey === "string" && OWNER.test(v.pubkey)
    && (v.qitemId === undefined || (typeof v.qitemId === "string" && v.qitemId.length > 0))
    && (v.sourceSeat === undefined || (typeof v.sourceSeat === "string" && v.sourceSeat.length > 0))
    && (v.state === "attempting" ? v.eventId === undefined
      : typeof v.eventId === "string" && EVENT_ID.test(v.eventId));
}

function loadLedger(file: string): Ledger {
  let source: string;
  try { source = readFileSync(file, "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, records: {} };
    throw new Error("Buzz delivery ledger cannot be read");
  }
  try {
    const decoded = JSON.parse(source) as unknown;
    if (!isObject(decoded) || decoded.schemaVersion !== 1 || !isObject(decoded.records)) throw new Error();
    const records: Record<string, BuzzDeliveryRecord> = {};
    for (const [key, value] of Object.entries(decoded.records)) {
      if (!validRecord(value)) throw new Error();
      records[key] = value;
    }
    return { schemaVersion: 1, records };
  } catch {
    throw new Error("Buzz delivery ledger is corrupt or incompatible; manual recovery required");
  }
}

function saveLedger(file: string, ledger: Ledger): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + ".tmp-" + randomUUID();
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(ledger), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
    const dir = openSync(dirname(file), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function frozenPayload(decision: OutboundDecision, opts: BuzzOutboundOptions): BuzzPayload {
  if (decision.op !== BUZZ_OUTBOUND_OP || !isObject(decision.payload)) {
    throw new Error("Buzz decision has unsupported operation or payload");
  }
  const p = decision.payload as unknown as BuzzPayload;
  if (p.buzzTransport?.schemaVersion !== 1 || p.buzzTransport.channelId !== opts.channelId) {
    throw new Error("Buzz decision provenance does not match configured channel");
  }
  if ("relayConnectorRef" in p || "relayEnvelope" in p || p.sharedChannel) {
    throw new Error("Buzz cannot adopt relay or shared-channel decisions");
  }
  if (!p.destinationSession || !opts.authorizedDestinations.has(p.destinationSession)
    || (opts.destinationAllowed && !opts.destinationAllowed(p.destinationSession))
    || decision.entityBindingRef !== p.destinationSession) {
    throw new Error("Buzz destination not explicitly authorized");
  }
  if (typeof p.sourceSession !== "string" || !p.sourceSession) throw new Error("Buzz decision missing original sending seat");
  if (typeof p.qitemId !== "string" || !p.qitemId || typeof p.notificationKey !== "string"
    || !p.notificationKey || Buffer.byteLength(p.notificationKey, "utf8") > MAX_KEY_BYTES) {
    throw new Error("Buzz notification episode is missing a stable key");
  }
  return p;
}

/** Resolve a reply parent from a durable, confirmed outbound event, never from
 *  an unconfirmed CLI attempt or an attacker-supplied qitem ID.
 *  Older journal entries missing the original queue metadata are safely ignored.
 */
export function resolveConfirmedBuzzRoot(
  home: string, channelId: string, eventId: string,
): { qitemId: string; recipient: string; seat: string } | null {
  if (!EVENT_ID.test(eventId)) return null;
  const records = Object.values(loadLedger(buzzLedgerPath(home)).records);
  const matches = records.filter((record) =>
    record.state === "confirmed"
    && record.eventId?.toLowerCase() === eventId.toLowerCase()
    && record.channelId.toLowerCase() === channelId.toLowerCase());
  if (matches.length !== 1 || !matches[0]?.qitemId || !matches[0]?.sourceSeat) return null;
  const record = matches[0];
  return { qitemId: record.qitemId!, recipient: record.destination, seat: record.sourceSeat! };
}

/** Mark provider + channel in durable decisions before enqueue; refuse relay/unknown humans. */
export function prepareBuzzDecision(decision: OutboundDecision, opts: Pick<BuzzOutboundOptions, "channelId" | "authorizedDestinations" | "destinationAllowed">): OutboundDecision {
  if (decision.op !== BUZZ_OUTBOUND_OP || !isObject(decision.payload)) {
    throw new Error("Buzz cannot prepare unsupported operation or payload");
  }
  const p = decision.payload as unknown as BuzzPayload;
  if ("relayConnectorRef" in p || "relayEnvelope" in p || p.sharedChannel) throw new Error("Buzz cannot prepare relay decision");
  if (p.buzzTransport && (p.buzzTransport.schemaVersion !== 1 || p.buzzTransport.channelId !== opts.channelId)) {
    throw new Error("Buzz cannot adopt a decision marked for another channel");
  }
  if (!p.destinationSession || decision.entityBindingRef !== p.destinationSession
    || !opts.authorizedDestinations.has(p.destinationSession)
    || (opts.destinationAllowed && !opts.destinationAllowed(p.destinationSession))) {
    throw new Error("Buzz destination not explicitly authorized");
  }
  if (typeof p.notificationKey !== "string" || !p.notificationKey) {
    throw new Error("Buzz decision missing stable notification episode");
  }
  return { ...decision, payload: {
    ...p,
    buzzTransport: { schemaVersion: 1, channelId: opts.channelId },
  } satisfies BuzzPayload };
}

function bodyFor(decision: OutboundDecision, p: BuzzPayload): string {
  // Marker links one stable queue episode to the relay; is visible intentionally.
  // A *different* decisionId for the same episode cannot cause a second send.
  const marker = sha256(JSON.stringify([p.destinationSession, p.notificationKey])).slice(0, 32);
  const summary = typeof p.summary === "string" ? p.summary : "";
  const body = typeof p.body === "string" ? p.body : "";
  const text = [summary, body].filter(Boolean).join("\n\n");
  if (!text.trim()) throw new Error("Buzz decision has no message content");
  const rendered = text + "\n\n[OpenRig delivery: " + marker + "]";
  if (Buffer.byteLength(rendered, "utf8") > MAX_MESSAGE_BYTES) throw new Error("Buzz message size limit exceeded");
  return rendered;
}

export class BuzzOutboundDelivery {
  private readonly ledgerFile: string;
  private readonly lockFile: string;

  constructor(private readonly opts: BuzzOutboundOptions) {
    if (!OWNER.test(opts.expectedPubkey)) throw new Error("invalid Buzz expected sender pubkey");
    this.ledgerFile = buzzLedgerPath(opts.home);
    this.lockFile = join(opts.home, "gateway", "buzz-delivery-ledger.lock");
  }

  async deliver(decision: OutboundDecision): Promise<SubsystemDeliveryOutcome> {
    let p: BuzzPayload;
    let content: string;
    try {
      p = frozenPayload(decision, this.opts);
      content = bodyFor(decision, p);
    } catch {
      return { ok: false, class: "buzz-decision-invalid" };
    }
    const key = p.notificationKey!;
    mkdirSync(dirname(this.lockFile), { recursive: true, mode: 0o700 });
    let lock: number;
    try { lock = openSync(this.lockFile, "wx", 0o600); }
    catch { return { ok: false, class: "buzz-ledger-busy-or-stale-lock" }; }

    try {
      const ledger = loadLedger(this.ledgerFile);
      const match: BuzzDeliveryRecord = {
        state: "attempting",
        channelId: this.opts.channelId,
        destination: p.destinationSession!,
        contentHash: sha256(content),
        pubkey: this.opts.expectedPubkey,
        qitemId: p.qitemId,
        sourceSeat: p.sourceSession!,
      };
      const prior = ledger.records[key];
      if (prior && (
        prior.channelId !== match.channelId || prior.destination !== match.destination
        || prior.contentHash !== match.contentHash || prior.pubkey !== match.pubkey
        || (prior.qitemId !== undefined && prior.qitemId !== match.qitemId)
        || (prior.sourceSeat !== undefined && prior.sourceSeat !== match.sourceSeat)
      )) return { ok: false, class: "buzz-notification-changed-after-attempt" };

      const complete = (eventId: string): SubsystemDeliveryOutcome => {
        ledger.records[key] = { ...match, state: "confirmed", eventId };
        saveLedger(this.ledgerFile, ledger);
        return { ok: true };
      };

      if (prior?.state === "confirmed") return { ok: true };
      if (prior?.state === "attempting") {
        // A previous attempt may have succeeded. Only positive proof is safe.
        // Negative 200-message window does NOT establish non-delivery.
        let events: BuzzMessage[];
        try { events = await this.opts.transport.getMessages({ channelId: this.opts.channelId, limit: 200 }); }
        catch { return { ok: false, class: "buzz-reconciliation-unavailable" }; }
        const matches = events.filter((e) =>
          e.channelId.toLowerCase() === this.opts.channelId.toLowerCase()
          && e.authorPubkey.toLowerCase() === this.opts.expectedPubkey.toLowerCase()
          && e.content === content && EVENT_ID.test(e.id));
        if (matches.length === 1) return complete(matches[0]!.id);
        return { ok: false, class: matches.length > 1 ? "buzz-duplicate-confirmations" : "buzz-delivery-outcome-unknown" };
      }

      // Once this write is durable, a restart MUST reconcile instead of re-post.
      ledger.records[key] = match;
      saveLedger(this.ledgerFile, ledger);
      let receipt: BuzzPostReceipt;
      try { receipt = await this.opts.transport.sendMessage({ channelId: this.opts.channelId, content }); }
      catch { return { ok: false, class: "buzz-delivery-outcome-unknown" }; }
      if (!EVENT_ID.test(receipt.eventId)) return { ok: false, class: "buzz-receipt-invalid" };
      return complete(receipt.eventId);
    } catch {
      return { ok: false, class: "buzz-ledger-unavailable" };
    } finally {
      closeSync(lock);
      try { unlinkSync(this.lockFile); } catch { /* Preserve fail-closed lock if cleanup fails. */ }
    }
  }

  /** Inspection-only, no network. Never returns bodies, private keys or relay URLs. */
  status(): { confirmed: number; uncertain: number } {
    const ledger = loadLedger(this.ledgerFile);
    const entries = Object.values(ledger.records);
    return {
      confirmed: entries.filter((r) => r.state === "confirmed").length,
      uncertain: entries.filter((r) => r.state === "attempting").length,
    };
  }
}
