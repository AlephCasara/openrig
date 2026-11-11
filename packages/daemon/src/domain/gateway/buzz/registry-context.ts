// Canonical Buzz identity + confirmed queue-root resolution (experimental).
// Never trusts a caller-provided recipient, qitemId or sender display name.
// Reads the current human registry, not a cache made at daemon startup.
import { loadHumanRegistry, resolveBuzzHandle } from "../human-registry.js";
import { resolveConfirmedBuzzRoot } from "./outbound-delivery.js";
import { buildBuzzOutboundLabWire, type BuzzOutboundLabOpts, type BuzzOutboundLabWire } from "./outbound-wire-lab.js";
import { BuzzInboundLab, type BuzzInboundLabOpts } from "./inbound-lab.js";

/** The canonical, current list of humans whose PRIMARY delivery binding is
 *  Buzz on this channel; no Slack, relay, secondary Buzz, or unregistered handle.
 *  Registry drift fails closed and cannot silently re-authorize stale entries.
 */
export function registeredBuzzDestinations(home: string, channelId: string): ReadonlySet<string> {
  const registry = loadHumanRegistry(home, { readOnly: true });
  if (!registry.ok) throw new Error("Buzz human registry unavailable or drifted");
  const addresses = registry.entities.filter((entity) =>
    entity.connectorBindings.some((binding) =>
      binding.kind === "buzz" && binding.role === "primary" && binding.connectorRef === channelId
      && typeof binding.handle === "string")).map((entity) => entity.address);
  return new Set(addresses);
}

/** Isolated outbound lab with canonical registry admission, rechecked per send. */
export function buildRegisteredBuzzOutboundLabWire(
  opts: Omit<BuzzOutboundLabOpts, "authorizedDestinations" | "destinationAllowed">,
): BuzzOutboundLabWire {
  return buildBuzzOutboundLabWire({
    ...opts,
    authorizedDestinations: registeredBuzzDestinations(opts.home, opts.channelId),
    destinationAllowed: (address) => registeredBuzzDestinations(opts.home, opts.channelId).has(address),
  });
}

export type RegisteredBuzzInboundOpts = Omit<BuzzInboundLabOpts,
  "allowedHumans" | "resolveHumanPubkey" | "resolveConfirmedRoot">;

/** Scoped to the exact channel UUID. Registry read/validation errors are fatal,
 *  not treated as empty registration. The outbound qitem must still exist and
 *  have the same source/recipient as its confirmed delivery receipt.
 */
export function buildRegisteredBuzzInboundLab(opts: RegisteredBuzzInboundOpts): BuzzInboundLab {
  return new BuzzInboundLab({
    ...opts,
    resolveHumanPubkey: (pubkey) => {
      const current = loadHumanRegistry(opts.home, { readOnly: true });
      if (!current.ok) throw new Error("Buzz human registry unavailable or drifted");
      const sender = resolveBuzzHandle(opts.channelId, pubkey, current.entities);
      return sender.kind === "registered" ? sender.address : null;
    },
    resolveConfirmedRoot: (eventId) => {
      const root = resolveConfirmedBuzzRoot(opts.home, opts.channelId, eventId);
      if (!root) return null;
      const original = opts.queue.getQitem(root.qitemId);
      if (!original || original.sourceSession !== root.seat
        || original.destinationSession !== root.recipient) return null;
      return root;
    },
  });
}
