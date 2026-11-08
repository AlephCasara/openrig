import { fetchWithTimeout } from "../fetch-with-timeout.js";

/** All persisted queue row events, including routing and closure overdue signals. */
export const QUEUE_WATCH_TYPES = [
  "queue.created", "queue.claimed", "queue.unclaimed", "queue.updated", "queue.handed_off",
  "qitem.fallback_routed", "qitem.closure_overdue",
] as const;

interface QueueEvent {
  type: string;
  seq: number;
  createdAt: string;
  qitemId: string;
  [key: string]: unknown;
}

interface SseFrame { id: string | null; event: string; data: string }
class QueueWatchProtocolError extends Error {}

/** Streaming line parser: handles chunk boundaries, CRLF, SSE comments, and multiline data. */
async function* readSseFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const maxFrameChars = 1024 * 1024;
  let pending = "";
  let id: string | null = null;
  let event = "message";
  let data: string[] = [];
  let frameChars = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return; // an incomplete frame is replayed after reconnect
      // Decode bounded slices. A single malicious network chunk must not create an unbounded
      // pending line, frame, or repeated O(n^2) scan of accumulated data.
      for (let offset = 0; offset < value.length; offset += 32768) {
        const chunk = decoder.decode(value.subarray(offset, offset + 32768), { stream: true });
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf("\n", start);
          const end = newline < 0 ? chunk.length : newline;
          const part = chunk.slice(start, end);
          if (frameChars + pending.length + part.length + (newline >= 0 ? 1 : 0) > maxFrameChars) {
            throw new QueueWatchProtocolError("SSE frame exceeds 1 MiB");
          }
          pending += part;
          start = newline < 0 ? chunk.length : newline + 1;
          if (newline < 0) continue;
          const line = pending.replace(/\r$/, "");
          frameChars += pending.length + 1;
          pending = "";
          if (line === "") {
            if (data.length > 0 || event === "cursor") yield { id, event, data: data.join("\n") };
            id = null;
            event = "message";
            data = [];
            frameChars = 0;
            continue;
          }
          if (line.startsWith(":")) continue;
          const separator = line.indexOf(":");
          const name = separator < 0 ? line : line.slice(0, separator);
          const raw = separator < 0 ? "" : line.slice(separator + 1);
          const field = raw.startsWith(" ") ? raw.slice(1) : raw;
          if (name === "id" && !field.includes("\0")) id = field;
          if (name === "data") data.push(field);
          if (name === "event") event = field;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export interface QueueWatchIo {
  fetchImpl: typeof fetch;
  out: (line: string) => void;
  err: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Optional external cancellation, useful for supervised or test-driven watches. */
  signal?: AbortSignal;
  maxReconnects?: number;
  connectTimeoutMs?: number;
}

export interface QueueWatchOptions {
  destination?: string;
  sinceId?: number;
  json: boolean;
}

function renderQueueEvent(event: QueueEvent): Record<string, unknown> {
  const kind = event.type;
  const destination = kind === "queue.handed_off" ? event.toSession
    : kind === "qitem.fallback_routed" ? event.rerouteDestination
    : event.destinationSession;
  const toState = kind === "queue.created" || kind === "queue.unclaimed" ? "pending"
    : kind === "queue.claimed" ? "in-progress"
    : event.toState ?? null;
  return {
    seq: event.seq,
    resumeId: event.seq,
    timestamp: event.createdAt,
    qitemId: event.qitemId,
    kind,
    fromState: event.fromState ?? null,
    toState,
    actor: event.actorSession ?? event.sourceSession ?? event.fromSession ?? event.destinationSession ?? null,
    destination: destination ?? null,
    ...(kind === "queue.handed_off" ? { handoffFrom: event.fromSession, handoffTo: event.toSession } : {}),
    ...(kind === "qitem.fallback_routed" ? { originalDestination: event.originalDestination } : {}),
    ...(event.closureReason ? { closureReason: event.closureReason } : {}),
    ...(event.closureTarget ? { closureTarget: event.closureTarget } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.summary ? { summary: event.summary } : {}),
  };
}

function formatQueueEvent(event: QueueEvent, json: boolean): string {
  const row = renderQueueEvent(event);
  if (json) return JSON.stringify(row);
  return [
    `[${row.seq}] ${row.timestamp}`, String(row.kind), String(row.qitemId),
    `${row.fromState ?? "?"} -> ${row.toState ?? "?"}`,
    `actor=${row.actor ?? "?"}`, `destination=${row.destination ?? "?"}`,
    ...(row.handoffTo ? [`handoffTo=${row.handoffTo}`] : []),
  ].join("  ");
}

function parseSeq(value: string | null): number | null {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/** Returns 0 on signal cancellation, 1 on a failed/unrecoverable connection. */
export async function watchQueueEvents(baseUrl: string, opts: QueueWatchOptions, io: QueueWatchIo): Promise<0 | 1> {
  let lastSeq = opts.sinceId;
  let reconnects = 0;
  let connected = false;
  let firstStreamInterruptedBeforeCursor = false;
  let reportedGapThrough = 0;
  const maxReconnects = io.maxReconnects ?? 5;
  const url = new URL("/api/events", baseUrl);
  url.searchParams.set("type", QUEUE_WATCH_TYPES.join(","));
  if (opts.destination) url.searchParams.set("destination", opts.destination);
  // The daemon emits a cursor frame after establishing a live-only subscription, so even an idle
  // first connection can reconnect without losing events that arrived between connections.
  url.searchParams.set("cursor", "1");

  while (!io.signal?.aborted) {
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (lastSeq !== undefined) {
      headers["Last-Event-ID"] = String(lastSeq);
      url.searchParams.delete("replay");
    } else url.searchParams.set("replay", firstStreamInterruptedBeforeCursor ? "all" : "0");
    try {
      const res = await fetchWithTimeout(io.fetchImpl, url.toString(), { headers, signal: io.signal }, {
        timeoutMs: io.connectTimeoutMs ?? 10000,
        timeoutMessage: "queue watch: daemon did not open an event stream in time",
      });
      if (!res.ok) {
        const error = new Error(`daemon returned HTTP ${res.status}`);
        if (res.status < 500) throw new QueueWatchProtocolError(error.message);
        throw error;
      }
      if (!res.body || !res.headers.get("content-type")?.includes("text/event-stream")) {
        throw new QueueWatchProtocolError("daemon did not return an SSE stream");
      }
      connected = true;
      if (lastSeq !== undefined) {
        const deletedThrough = parseSeq(res.headers.get("X-OpenRig-Events-Pruned-Through")) ?? 0;
        const legacyThrough = parseSeq(res.headers.get("X-OpenRig-Events-Legacy-Unverified-Through")) ?? 0;
        if (deletedThrough > lastSeq! && deletedThrough > reportedGapThrough) {
          io.err(`warning: queue watch replay incomplete: retained events were deleted through seq ${deletedThrough}; resume id ${lastSeq} is too old.`);
          reportedGapThrough = deletedThrough;
        } else if (legacyThrough > lastSeq! && legacyThrough > reportedGapThrough) {
          io.err(`warning: queue watch replay may be incomplete: retention before gap tracking covered seq ${legacyThrough}; resume id ${lastSeq}.`);
          reportedGapThrough = legacyThrough;
        }
      }

      for await (const frame of readSseFrames(res.body)) {
        if (io.signal?.aborted) return 0;
        const id = parseSeq(frame.id);
        if (id === null) throw new QueueWatchProtocolError(`invalid SSE event id: ${frame.id ?? "missing"}`);
        if (frame.event === "cursor") {
          if (lastSeq === undefined || id > lastSeq) {
            lastSeq = id;
          }
          continue;
        }
        if (id <= (lastSeq ?? -1)) continue; // replay/live overlap or reconnect duplicate
        let parsed: QueueEvent;
        try { parsed = JSON.parse(frame.data) as QueueEvent; }
        catch { throw new QueueWatchProtocolError(`invalid JSON at seq ${id}`); }
        if (!QUEUE_WATCH_TYPES.some((kind) => kind === parsed.type) || parsed.seq !== id || typeof parsed.qitemId !== "string") {
          throw new QueueWatchProtocolError(`invalid queue event at seq ${id}`);
        }
        io.out(formatQueueEvent(parsed, opts.json));
        lastSeq = id;
        reconnects = 0;
      }
      if (io.signal?.aborted) return 0;
      if (lastSeq === undefined) firstStreamInterruptedBeforeCursor = true;
    } catch (error) {
      if (io.signal?.aborted) return 0;
      // HTTP errors, invalid payloads and cursor corruption must never be silently retried/skipped.
      const message = error instanceof Error ? error.message : String(error);
      if (!connected || error instanceof QueueWatchProtocolError) {
        io.err(`queue watch: ${message}`);
        return 1;
      }
      if (lastSeq === undefined) firstStreamInterruptedBeforeCursor = true;
      io.err(`queue watch: stream interrupted (${message}); resuming after seq ${lastSeq ?? "none"}`);
    }
    if (io.signal?.aborted) return 0;
    if (reconnects >= maxReconnects) {
      io.err(`queue watch: daemon unreachable after ${maxReconnects} reconnect attempts; last resume id ${lastSeq ?? "none"}`);
      return 1;
    }
    reconnects += 1;
    await io.sleep(Math.min(250 * 2 ** (reconnects - 1), 2000));
  }
  return 0;
}
