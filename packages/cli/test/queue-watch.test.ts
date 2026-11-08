import { describe, expect, it, vi } from "vitest";
import { QUEUE_WATCH_TYPES, watchQueueEvents, type QueueWatchIo } from "../src/commands/queue-watch.js";

type Recorded = { seq: number; type: string; qitemId: string; createdAt: string; [key: string]: unknown };
const at = "2026-11-08T12:00:00Z";

function event(seq: number, type: string, fields: Record<string, unknown> = {}): Recorded {
  return { seq, type, qitemId: "qitem-" + seq, createdAt: at, ...fields };
}

function frame(row: Recorded): string {
  return "id: " + row.seq + "\ndata: " + JSON.stringify(row) + "\n\n";
}

function sse(chunks: string[], headers: Record<string, string> = {}): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
}

function harness(fetchImpl: typeof fetch, overrides: Partial<QueueWatchIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const controller = new AbortController();
  const io: QueueWatchIo = {
    fetchImpl,
    out: (value) => { out.push(value); },
    err: (value) => { err.push(value); },
    sleep: async () => {},
    signal: controller.signal,
    maxReconnects: 2,
    ...overrides,
  };
  return { out, err, io, controller };
}

describe("rig queue watch", () => {
  it("emits one JSONL record per persisted queue kind, with ownership and state fields", async () => {
    const rows = [
      event(1, "queue.created", { sourceSession: "alice@rig", destinationSession: "bob@rig" }),
      event(2, "queue.claimed", { destinationSession: "bob@rig" }),
      event(3, "queue.updated", { fromState: "in-progress", toState: "done", actorSession: "bob@rig", destinationSession: "bob@rig" }),
      event(4, "queue.handed_off", { fromSession: "bob@rig", toSession: "carol@rig" }),
      event(5, "queue.unclaimed", { destinationSession: "bob@rig", reason: "release" }),
      event(6, "qitem.fallback_routed", { originalDestination: "carol@rig", rerouteDestination: "dave@rig" }),
      event(7, "qitem.closure_overdue", { destinationSession: "dave@rig" }),
    ];
    const h = harness(vi.fn(async () => sse([rows.map(frame).join("")])));
    h.io.out = (line) => { h.out.push(line); if (h.out.length === rows.length) h.controller.abort(); };

    expect(await watchQueueEvents("http://127.0.0.1:7000", { json: true }, h.io)).toBe(0);
    const parsed = h.out.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(parsed.map((row) => row.kind)).toEqual(rows.map((row) => row.type));
    expect(parsed[0]).toMatchObject({ timestamp: at, qitemId: "qitem-1", actor: "alice@rig", destination: "bob@rig", toState: "pending" });
    expect(parsed[2]).toMatchObject({ fromState: "in-progress", toState: "done" });
    expect(parsed[3]).toMatchObject({ actor: "bob@rig", destination: "carol@rig", handoffFrom: "bob@rig", handoffTo: "carol@rig" });
    expect(parsed[5]).toMatchObject({ destination: "dave@rig", originalDestination: "carol@rig" });
    expect(h.err).toEqual([]);
  });

  it("resumes using Last-Event-ID, parses split CRLF frames, and deduplicates overlapping deliveries", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const rows = [event(10, "queue.created", { destinationSession: "bob@rig" }), event(11, "queue.claimed", { destinationSession: "bob@rig" })];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      if (calls.length === 1) {
        const value = ": heartbeat\r\n\r\n" + frame(rows[0]!).replace(/\n/g, "\r\n");
        return sse(value.match(/.{1,3}/gs) ?? []);
      }
      return sse([frame(rows[0]!), frame(rows[1]!)]);
    }) as typeof fetch;
    const h = harness(fetchImpl);
    h.io.out = (line) => { h.out.push(line); if (h.out.length === 2) h.controller.abort(); };

    expect(await watchQueueEvents("http://127.0.0.1:7000", { json: true, destination: "bob@rig" }, h.io)).toBe(0);
    expect(h.out.map((line) => JSON.parse(line).seq)).toEqual([10, 11]);
    expect(new URL(calls[0]!.url).searchParams.get("replay")).toBe("0");
    expect(new URL(calls[0]!.url).searchParams.get("type")).toBe(QUEUE_WATCH_TYPES.join(","));
    expect(new URL(calls[0]!.url).searchParams.get("destination")).toBe("bob@rig");
    expect(calls[1]!.headers.get("Last-Event-ID")).toBe("10");
    expect(new URL(calls[1]!.url).searchParams.has("replay")).toBe(false);
  });

  it("carries an idle cursor forward across a reconnect without inventing a queue event", async () => {
    const calls: Headers[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Headers(init?.headers));
      return calls.length === 1
        ? sse(["event: cursor\nid: 28\ndata: \n\n"])
        : sse([frame(event(29, "queue.created", { destinationSession: "bob@rig" }))]);
    }) as typeof fetch;
    const h = harness(fetchImpl);
    h.io.out = (line) => { h.out.push(line); h.controller.abort(); };
    expect(await watchQueueEvents("http://localhost:7000", { json: true }, h.io)).toBe(0);
    expect(calls[1]!.get("Last-Event-ID")).toBe("28");
    expect(h.out).toHaveLength(1);
  });

  it("exits nonzero when the daemon cannot be reached on first connect", async () => {
    const h = harness(vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch);
    expect(await watchQueueEvents("http://localhost:7000", { json: true }, h.io)).toBe(1);
    expect(h.err.join(" ")).toContain("ECONNREFUSED");
  });

  it("bounds reconnection when streams close repeatedly without queue progress, including after cursor frames", async () => {
    const fetchImpl = vi.fn(async () => sse(["event: cursor\nid: 1\ndata: \n\n"])) as typeof fetch;
    const h = harness(fetchImpl);
    expect(await watchQueueEvents("http://localhost:7000", { json: true }, h.io)).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(h.err.at(-1)).toContain("daemon unreachable");
  });

  it("rejects malformed SSE event IDs and payloads instead of silently skipping them", async () => {
    for (const body of [
      'id: 2garbage\ndata: {"type":"queue.created"}\n\n',
      'id: 2\ndata: invalid json\n\n',
      'id: 2\ndata: {"seq":2,"type":"queue.created","qitemId":3}\n\n',
    ]) {
      const fetchImpl = vi.fn(async () => sse([body])) as typeof fetch;
      const h = harness(fetchImpl);
      expect(await watchQueueEvents("http://localhost:7000", { json: true }, h.io)).toBe(1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(h.out).toEqual([]);
      expect(h.err).toHaveLength(1);
    }
  });

  it("warns about known pruned history, and distinguishes unverified legacy retention", async () => {
    for (const [headers, warning] of [
      [{ "X-OpenRig-Events-Pruned-Through": "20" }, "replay incomplete"],
      [{ "X-OpenRig-Events-Legacy-Unverified-Through": "20" }, "may be incomplete"],
    ] as const) {
      const h = harness(vi.fn(async () => sse([frame(event(21, "queue.created"))], headers)) as typeof fetch);
      h.io.out = (line) => { h.out.push(line); h.controller.abort(); };
      expect(await watchQueueEvents("http://localhost:7000", { json: true, sinceId: 5 }, h.io)).toBe(0);
      expect(h.err.join(" ")).toContain(warning);
    }
  });

  it("does not conflate a retention scan watermark with a proven deletion", async () => {
    const h = harness(vi.fn(async () => sse([frame(event(8, "queue.created"))], {
      "X-OpenRig-Events-Pruned-Through": "0",
      "X-OpenRig-Events-Legacy-Unverified-Through": "0",
    })) as typeof fetch);
    h.io.out = (line) => { h.out.push(line); h.controller.abort(); };
    expect(await watchQueueEvents("http://localhost:7000", { json: false, sinceId: 2 }, h.io)).toBe(0);
    expect(h.err).toEqual([]);
    expect(h.out[0]).toContain("queue.created");
  });

  it("rejects oversized frames even when the whole payload arrives in one network chunk", async () => {
    for (const body of [
      "data: " + "x".repeat(1024 * 1024 + 1),
      Array.from({ length: 65 }, () => "data: " + "y".repeat(20000) + "\n").join("") + "\n",
    ]) {
      const fetchImpl = vi.fn(async () => sse([body])) as typeof fetch;
      const h = harness(fetchImpl);
      expect(await watchQueueEvents("http://localhost:7000", { json: true }, h.io)).toBe(1);
      expect(h.out).toEqual([]);
      expect(h.err.join(" ")).toContain("SSE frame exceeds 1 MiB");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("replays the whole log after an initial stream closes before providing a cursor", async () => {
    const calls: URL[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(new URL(String(input)));
      return calls.length === 1 ? sse([]) : sse([frame(event(8, "queue.created"))]);
    }) as typeof fetch;
    const h = harness(fetchImpl);
    h.io.out = (line) => { h.out.push(line); h.controller.abort(); };
    expect(await watchQueueEvents("http://localhost:7000", { json: true }, h.io)).toBe(0);
    expect(calls.map((url) => url.searchParams.get("replay"))).toEqual(["0", "all"]);
    expect(h.out.map((line) => JSON.parse(line).seq)).toEqual([8]);
  });
});
