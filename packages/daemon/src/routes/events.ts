import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type { PersistedEvent } from "../domain/types.js";

export const eventsRoute = new Hono();

/** A replay is read and written this many events at a time, never built whole. */
const REPLAY_PAGE = 500;
/** Hard per-connection cap: a slow SSE client must not grow the daemon heap indefinitely.
 * EventSource reconnects with Last-Event-ID and resumes from durable SQLite history. */
export const MAX_PENDING_SSE_EVENTS = 256;

function getEventBus(c: { get: (key: string) => unknown }): EventBus {
  return c.get("eventBus" as never) as EventBus;
}

eventsRoute.get("/", (c) => {
  const rigId = c.req.query("rigId"); // Optional — omit for global stream
  // `?replay=<n>` asks for the newest n events (0: none); `all`, no `replay` or any other value, the whole log, as before
  // the parameter existed.
  const replay = c.req.query("replay");
  const replayCount = replay !== undefined && /^\d+$/.test(replay) ? Number(replay) : null;

  // EventSource sends Last-Event-ID when it reconnects: the events after it are replayed, whatever `replay` says.
  const lastEventIdRaw = c.req.header("Last-Event-ID");
  const lastEventId = lastEventIdRaw === undefined ? null : parseInt(lastEventIdRaw, 10);

  const eventBus = getEventBus(c);

  return streamSSE(c, async (stream) => {
    // A bounded buffer for live events arriving during replay.
    const buffer: PersistedEvent[] = [];
    let replaying = true;
    let maxReplayedSeq = 0;
    let pendingWrites = 0;
    let liveWrites = Promise.resolve();
    let terminated = false;
    let terminate: () => void = () => {};
    const termination = new Promise<void>(resolve => { terminate = resolve; });
    const disconnectSlowClient = () => {
      if (terminated) return;
      terminated = true;
      // No events are discarded from the database. The client can reconnect
      // using its last received SSE id. Avoid holding more messages in RAM.
      // Hono's close() waits for an outstanding writer.write(), which never
      // resolves when a client stops reading. abort() cancels the internal
      // readable side and releases that blocked write, allowing finally to
      // unsubscribe even with a permanently stalled client.
      stream.abort();
      terminate();
    };

    // 1. Subscribe to live bus BEFORE replay query (no gap)
    const unsubscribe = eventBus.subscribe((event) => {
      // Rig-scoped: filter by rigId. Global: accept all events.
      if (rigId) {
        const eventRigId = "rigId" in event ? (event as { rigId: string }).rigId : null;
        if (eventRigId !== rigId) return;
      }
      if (terminated || stream.aborted) return;
      if (replaying) {
        if (buffer.length >= MAX_PENDING_SSE_EVENTS) {
          disconnectSlowClient();
          return;
        }
        buffer.push(event);
      } else {
        // Serialize live writes: fire-and-forget writes without backpressure
        // otherwise accumulate an unbounded number of pending promises.
        if (event.seq <= maxReplayedSeq) return;
        if (pendingWrites >= MAX_PENDING_SSE_EVENTS) {
          disconnectSlowClient();
          return;
        }
        pendingWrites++;
        maxReplayedSeq = event.seq;
        liveWrites = liveWrites.then(async () => {
          if (!terminated && !stream.aborted) {
            await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
          }
        }).catch(() => {
          disconnectSlowClient();
        }).finally(() => { pendingWrites--; });
      }
    });

    const aborted = new Promise<void>((resolve) => {
      stream.onAbort(() => resolve());
    });

    try {
      // Where the replay starts, read once subscribed: an event stored after it is either replayed or buffered. Without
      // Last-Event-ID, `?replay=<n>` replays the newest n (0: from now on), the whole log when it holds no more.
      const lastSeq = lastEventId !== null ? (isNaN(lastEventId) ? 0 : lastEventId)
        : replayCount === null ? 0
        : eventBus.seqBeforeNewest(replayCount, rigId);
      maxReplayedSeq = lastSeq;
      // Where it ends, read once subscribed too: an event stored after it is buffered, so events arriving while the
      // pages are written can neither keep the replay going nor be sent twice.
      const upTo = eventBus.maxSeq();

      // 2. Replay missed events from DB, a page at a time
      for (let page = eventBus.replayPage(lastSeq, upTo, REPLAY_PAGE, rigId); page.length > 0 && !stream.aborted && !terminated;
        page = eventBus.replayPage(maxReplayedSeq, upTo, REPLAY_PAGE, rigId)) {
        for (const event of page) {
          if (terminated || stream.aborted) break;
          await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
          if (event.seq > maxReplayedSeq) maxReplayedSeq = event.seq;
        }
      }

      // 3. Drain buffer while still in replaying mode (new live events
      //    continue to buffer, preserving monotonic ordering)
      //    Drain in a loop since new events may arrive during drain.
      while (buffer.length > 0 && !stream.aborted && !terminated) {
        // shift() is cheap for a maximum of 256 entries and avoids holding a
        // second full snapshot while new events arrive during an await.
        const event = buffer.shift()!;
        if (event.seq <= maxReplayedSeq) continue;
        await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
        if (event.seq > maxReplayedSeq) maxReplayedSeq = event.seq;
      }

      // 4. Switch to live mode — new events go directly to stream
      if (terminated || stream.aborted) return;
      replaying = false;

      // Keep the stream alive until client disconnects or the bounded queue
      // overflows and this connection closes for resume.
      await Promise.race([aborted, termination]);
    } finally {
      unsubscribe();
    }
  });
});
