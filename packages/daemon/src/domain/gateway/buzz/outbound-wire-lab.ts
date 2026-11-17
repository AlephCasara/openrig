// Standalone, outbound-only Buzz queue laboratory. NEVER wired into daemon startup.
// This reuses OpenRig's durable dispatcher and queue sweep, with an explicit
// allow-list and provider provenance. No authenticated human inbound exists yet.
import { join } from "node:path";
import { DispatchBuffer } from "../dispatch-buffer.js";
import { buildInProcessWire, type GatewayWire } from "../gateway-subsystem.js";
import { SlackOutboundDriver, type OutboundPostPayload } from "../slack/outbound-driver.js";
import { SeenStore } from "../slack/state-store.js";
import type { OutboundQueuePort, QueueItem, AlertFilterOpts } from "../slack/queue-access.js";
import {
  BuzzOutboundDelivery, prepareBuzzDecision, BUZZ_OUTBOUND_OP,
  type BuzzOutboundOptions,
} from "./outbound-delivery.js";

export interface BuzzOutboundLabOpts extends BuzzOutboundOptions {
  queue: OutboundQueuePort;
  minimumLevel?: AlertFilterOpts["minimumLevel"];
  intervalMs?: number;
  log?: (message: string) => void;
}

export interface BuzzOutboundLabWire extends GatewayWire {
  /** Explicit local test hook; does not require starting daemon or polling services. */
  sweepOnce(): ReturnType<SlackOutboundDriver["sweepOnce"]>;
}

/**
 * A lab-only queue path. An existing untagged Slack/relay decision blocks
 * construction rather than being replayed to the wrong transport.
 *
 * This intentionally does not satisfy an operational Buzz GatewayWire contract:
 * the caller MUST NOT register it as the production provider while inbound
 * authentication, human routing, provider switch drain and replay are pending.
 */
export function buildBuzzOutboundLabWire(opts: BuzzOutboundLabOpts): BuzzOutboundLabWire {
  if (opts.authorizedDestinations.size === 0) throw new Error("Buzz lab requires explicit destination allow-list");
  const pending = new DispatchBuffer(opts.home).pendingStrict();
  for (const decision of pending) {
    const payload = decision.payload as OutboundPostPayload & {
      buzzTransport?: { schemaVersion: number; channelId: string };
    } | undefined;
    if (decision.op !== BUZZ_OUTBOUND_OP || payload?.buzzTransport?.schemaVersion !== 1
      || payload.buzzTransport.channelId !== opts.channelId
      || !payload.destinationSession || !opts.authorizedDestinations.has(payload.destinationSession)) {
      throw new Error("Buzz lab cannot adopt existing Slack, relay or foreign-channel pending decisions");
    }
  }

  const delivery = new BuzzOutboundDelivery(opts);
  const seen = new SeenStore(join(opts.home, "gateway", "buzz-outbound-seen.jsonl"));
  const filteredQueue: OutboundQueuePort = {
    listHumanAlerts: async (filter) => {
      const alerts = await opts.queue.listHumanAlerts(filter);
      return alerts.filter((p: QueueItem) =>
        !!p.destinationSession && opts.authorizedDestinations.has(p.destinationSession)
        && (!opts.destinationAllowed || opts.destinationAllowed(p.destinationSession))
        && !p.sharedChannel && typeof p.notificationKey === "string" && p.notificationKey.length > 0);
    },
  };

  const wire = buildInProcessWire({
    home: opts.home,
    platform: "buzz",
    connectorId: "buzz-outbound-lab",
    ops: [BUZZ_OUTBOUND_OP],
    prepare: (decision) => prepareBuzzDecision(decision, opts),
    deliver: async (decision) => {
      const outcome = await delivery.deliver(decision);
      if (outcome.ok) {
        const payload = decision.payload as OutboundPostPayload;
        // Confirmed in the durable Buzz ledger BEFORE marking the episode seen
        // or ACKing the dispatch-buffer decision.
        seen.mark(payload.notificationKey!, "buzz-confirmed");
      }
      return outcome;
    },
    log: opts.log,
  });

  const driver = new SlackOutboundDriver({
    home: opts.home,
    queue: filteredQueue,
    seen,
    filter: { minimumLevel: opts.minimumLevel ?? "NOTICE" },
    dispatch: (op, binding, payload) => wire.dispatcher.dispatch(op, binding, payload),
    intervalMs: opts.intervalMs ?? 30_000,
    log: opts.log,
  });
  let started = false;
  return {
    dispatcher: wire.dispatcher,
    sweepOnce: () => driver.sweepOnce(),
    startServices: () => {
      if (started) return;
      started = true;
      wire.startServices?.();
      driver.start();
    },
    stop: () => { driver.stop(); wire.stop(); },
    status: () => ({
      platform: "buzz",
      mode: "outbound-lab-only",
      productionReady: false,
      inboundReady: false,
      ...delivery.status(),
    }),
  };
}
