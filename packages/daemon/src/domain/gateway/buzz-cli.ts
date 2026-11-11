// Experimental Buzz CLI transport (not wired into the daemon yet).
// CLI protocol: https://github.com/block/buzz/tree/main/crates/buzz-cli
// No Buzz process runs until an operator selects/configures the transport.
import { spawn } from "node:child_process";

const CHANNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[0-9a-f]{64}$/i;
const PUBKEY = EVENT_ID;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BATCH_SIZE = 200;

export type BuzzRunner = (args: readonly string[], stdin?: string) => Promise<string>;

export interface BuzzCliOptions {
  /** Optional explicit executable path (never a shell command). */
  binary?: string;
  /** Injected for deterministic tests; no network/process in tests. */
  runner?: BuzzRunner;
  timeoutMs?: number;
}

export interface BuzzMessage {
  id: string;
  authorPubkey: string;
  channelId: string;
  content: string;
  createdAt: number;
  replyTo?: string;
  threadRoot?: string;
}

export interface BuzzPostReceipt {
  eventId: string;
}

function requireChannelId(value: string): void {
  if (!CHANNEL_ID.test(value)) throw new Error("invalid Buzz channel UUID");
}

function requireEventId(value: string): void {
  if (!EVENT_ID.test(value)) throw new Error("invalid Buzz Nostr event ID");
}

function parseCliJson(response: string): unknown {
  try {
    return JSON.parse(response) as unknown;
  } catch {
    // Raw CLI response may include credentials or relay details: never surface it.
    throw new Error("Buzz CLI returned invalid JSON");
  }
}

function tagsOf(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.filter((tag): tag is string[] =>
    Array.isArray(tag) && tag.length >= 2 && tag.every((part) => typeof part === "string"));
}

function eventFromUnknown(raw: unknown, expectedChannel: string): BuzzMessage {
  if (!raw || typeof raw !== "object") throw new Error("Buzz event is not an object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || !EVENT_ID.test(obj.id)) throw new Error("Buzz event has invalid ID");
  if (typeof obj.pubkey !== "string" || !PUBKEY.test(obj.pubkey)) throw new Error("Buzz event has invalid pubkey");
  if (obj.kind !== 9) throw new Error("Buzz event is not a regular chat message");
  if (typeof obj.content !== "string" || Buffer.byteLength(obj.content, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error("Buzz event has invalid content");
  }
  if (!Number.isSafeInteger(obj.created_at) || (obj.created_at as number) < 0) {
    throw new Error("Buzz event has invalid timestamp");
  }
  const tags = tagsOf(obj.tags);
  // The CLI filters by channel; assert that an event actually belongs to it.
  if (!tags.some((t) => t[0] === "h" && t[1]?.toLowerCase() === expectedChannel.toLowerCase())) {
    throw new Error("Buzz event has mismatched channel");
  }
  const refs = tags.filter((t) => t[0] === "e" && typeof t[1] === "string" && EVENT_ID.test(t[1]));
  const root = refs.find((t) => t[3] === "root")?.[1];
  const reply = refs.find((t) => t[3] === "reply")?.[1] ?? (refs.length === 1 ? refs[0]?.[1] : undefined);
  return {
    id: obj.id,
    authorPubkey: obj.pubkey,
    channelId: expectedChannel,
    content: obj.content,
    createdAt: obj.created_at as number,
    ...(reply ? { replyTo: reply } : {}),
    ...(root ? { threadRoot: root } : {}),
  };
}

export function makeBuzzCliRunner(binary = "buzz", timeoutMs = DEFAULT_TIMEOUT_MS): BuzzRunner {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("invalid Buzz CLI timeout");
  }
  return (args, stdin) => new Promise<string>((resolve, reject) => {
    // No shell, no user content in process arguments. Authentication is supplied
    // by the operator's Buzz desktop pairing or by environment, never via argv.
    const child = spawn(binary, [...args], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stdoutBytes = 0;
    let failed: Error | undefined;
    const timer = setTimeout(() => {
      failed ??= new Error("Buzz CLI timed out");
      child.kill();
    }, timeoutMs);
    const abort = (error: Error): void => {
      failed ??= error;
      child.kill();
    };
    child.stdout.on("data", (data: Buffer) => {
      stdoutBytes += data.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        abort(new Error("Buzz CLI output exceeds size limit"));
      } else {
        stdout += data.toString("utf8");
      }
    });
    // Do not copy stderr to errors: it may expose relay/credential material.
    child.stderr.on("data", () => {});
    child.on("error", (error) => { failed ??= error; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) return reject(failed);
      if (code !== 0) return reject(new Error(`Buzz CLI exited with code ${code ?? "unknown"}`));
      resolve(stdout);
    });
    child.stdin.on("error", () => {}); // EPIPE is reported by exit status.
    child.stdin.end(stdin ?? "");
  });
}

export class BuzzCliClient {
  private readonly runner: BuzzRunner;

  constructor(opts: BuzzCliOptions = {}) {
    this.runner = opts.runner ?? makeBuzzCliRunner(opts.binary, opts.timeoutMs);
  }

  async sendMessage(input: { channelId: string; content: string; replyTo?: string }): Promise<BuzzPostReceipt> {
    requireChannelId(input.channelId);
    if (!input.content.trim() || Buffer.byteLength(input.content, "utf8") > MAX_MESSAGE_BYTES) {
      throw new Error("Buzz message must contain 1–65536 bytes");
    }
    if (input.replyTo !== undefined) requireEventId(input.replyTo);
    const args = ["messages", "send", "--channel", input.channelId, "--content", "-"];
    if (input.replyTo) args.push("--reply-to", input.replyTo);
    // --content - reads stdin, so neither secrets nor message text appear in ps.
    const raw = parseCliJson(await this.runner(args, input.content));
    if (!raw || typeof raw !== "object") throw new Error("Buzz CLI returned invalid post receipt");
    const receipt = raw as Record<string, unknown>;
    if (receipt.accepted !== true || typeof receipt.event_id !== "string" || !EVENT_ID.test(receipt.event_id)) {
      throw new Error("Buzz relay did not confirm message acceptance");
    }
    return { eventId: receipt.event_id };
  }

  async getMessages(input: { channelId: string; since?: number; before?: number; limit?: number }): Promise<BuzzMessage[]> {
    requireChannelId(input.channelId);
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
      throw new Error("Buzz message batch limit must be 1–200");
    }
    if (input.since !== undefined && (!Number.isSafeInteger(input.since) || input.since < 0)) {
      throw new Error("Buzz message since must be a non-negative Unix timestamp");
    }
    const args = ["messages", "get", "--channel", input.channelId, "--limit", String(limit), "--kinds", "9"];
    if (input.since !== undefined) args.push("--since", String(input.since));
    if (input.before !== undefined) {
      if (!Number.isSafeInteger(input.before) || input.before < 1) {
        throw new Error("Buzz message before must be a positive Unix timestamp");
      }
      args.push("--before", String(input.before));
    }
    const raw = parseCliJson(await this.runner(args));
    if (!Array.isArray(raw)) throw new Error("Buzz CLI returned invalid message batch");
    if (raw.length > MAX_BATCH_SIZE) throw new Error("Buzz CLI returned an oversized message batch");
    return raw.map((item) => eventFromUnknown(item, input.channelId))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
}
