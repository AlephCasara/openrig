# External gateway provider selection (experimental)

**Status:** independent provider-selection scaffold for [AlephCasara/openrig#2](https://github.com/AlephCasara/openrig/issues/2). The Buzz transport is **not yet connected to the OpenRig gateway**. This patch must not be described as an operational Slack replacement.

## Backward compatibility

A missing `gateway-provider.json` is equivalent to:

```json
{ "schemaVersion": 1, "provider": "slack" }
```

This selects the pre-existing, unchanged `buildSlackGatewayWire` factory. It does not read Buzz credentials or construct Buzz processes. The gateway still uses the same durable queue, inbound policies, human approvals and relay-only routing under its default settings.

The versioned config is stored in OpenRig's home directory, **separately** from the established `slack-connector.json` config. No automatic migration or configuration write occurs.

## Buzz selection — future opt-in only

A prospective Buzz configuration looks like this:

```json
{
  "schemaVersion": 1,
  "provider": "buzz",
  "buzz": {
    "enabled": true,
    "binaryPath": "/absolute/path/to/buzz",
    "relayUrl": "https://relay.example.invalid/",
    "channelId": "2e4ab450-4c57-4541-8e3b-7491e1dd535f",
    "credentialSource": "env"
  }
}
```

**Do not deploy this configuration for active OpenRig traffic.** There is no production Buzz wire yet. With Buzz selected, the subsystem deliberately reports **failed** and refuses dispatch; it never silently falls back to Slack (which could double-send or violate explicit operator intent). This is a safety-first phase of the migration, not user-facing provider availability.

The selector validates the schema and explicitly rejects unknown fields, including attempts to store credentials in JSON. Buzz preflight checks: enabled flag, absolute executable path and executable file, valid UUID channel, HTTPS relay (or HTTP restricted to loopback for labs), and presence of an environment-supplied private key. It does **not** print private-key material, start Buzz Desktop, run CLI commands, or initiate a relay connection. Pairing and NIP-FI assertion readiness require later dedicated support.

## Laboratory implementation since provider selection

`packages/daemon/src/domain/gateway/buzz/outbound-delivery.ts` adds a **lab-only**, credential-free on-disk receipt journal. Each episode is recorded in an atomic, restricted ledger **before** a CLI send is attempted. If the CLI times out after the relay may have accepted a message, the episode remains `attempting`. Restart/replay attempts only a **positive** lookup for a message with the exact content and expected sender pubkey; an empty bounded read never justifies re-sending. A confirmed journal receipt is written before the existing dispatcher ACK or the local episode's seen marker. Changed payloads, corrupt journals and concurrent writers fail closed. For unattended use, manual resolution of ambiguous outcomes and locked ledgers remains a known operational limitation.

`buzz/outbound-wire-lab.ts` reuses `buildInProcessWire`, the existing queue sweep and `DispatchBuffer`, but only for an explicitly supplied destination allow-list. It **refuses** to replay any pre-existing decision without Buzz provenance or with the wrong channel. The production gateway selector also refuses Slack startup if a pending Buzz-tagged decision exists; a Buzz selection similarly refuses foreign pending work. This prioritizes avoiding cross-provider misdelivery over silently completing the switch. Because a production router must preserve unrelated relay bindings, the lab wire is **not installed as the production Buzz factory**.

`buzz/inbound-lab.ts` independently demonstrates reading a reply from an allow-listed pubkey, matching it to a **confirmed outbound root**, recording a deterministic receipt ID before queue insertion, and safely deduplicating it across restarts. Incoming messages land as `humanAnswer: false` correspondence only, never as automatic approvals. A test runs through the actual in-memory SQLite `QueueRepository` and `makeQueuePorts` implementation. A real-relay smoke also sends a guest reply, with NIP-43 and private-channel membership enforced, and verifies that it becomes exactly one inbound queue-port item.

### Canonical identities, conversation roots and backfill (second phase)

The human registry now accepts **first-class `kind: buzz`** bindings with a **lowercase channel UUID as `connectorRef`**, a canonical **64-digit, lowercase x-only Nostr pubkey as `handle`**, and a non-secret `secretsRef` pointer (`env:BUZZ_PRIVATE_KEY` or `vault://buzz/<ref>`). It continues to require exactly one primary binding per human. Two humans cannot claim the same pubkey in the same channel; a pubkey may be registered on a different channel with a separate identity. Slack and relay binding rules remain unchanged.

Example human fragment under `<openrig-home>/gateway/humans/jane.yaml`:

```yaml
entityId: jane
class: human
displayName: Jane
address: jane@external
connectorBindings:
  - kind: buzz
    connectorRef: 2e4ab450-4c57-4541-8e3b-7491e1dd535f
    secretsRef: env:BUZZ_PRIVATE_KEY
    role: primary
    handle: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
prefs:
  deliveryClass: B
```

This is an **example of identity metadata**, not a working Buzz provider configuration. Do not place an actual private key in a human fragment. Use the registry's supported authoring mechanism; generated projections must never be hand-edited.

`buzz/registry-context.ts` now resolves inbound sender pubkeys by rereading the canonical human registry (read-only), scoped to the channel, rather than accepting caller-supplied names. It resolves parent message IDs from **confirmed** records in `buzz-delivery-ledger.json`, whose new records retain the original queue item, sending seat, recipient and event ID. The inbound resolver cross-checks that the original queue item still exists with the same sender and destination. Old journal records without correlation fields are ignored as reply roots. For outbound tests, a separate registry-backed allow-list includes only Buzz **primary** bindings and is rechecked on every send; revoked identities are not sent later notifications.

The existing Slack/relay notification projection now explicitly **excludes Buzz-primary humans**. Buzz destinations cannot be accidentally treated as Slack-owned just because they have a connector binding. Relay-primary bindings remain eligible to the existing relay pathway. This is a compatibility guard, not a new production routing feature.

`BuzzCliClient.getMessages` now accepts the official `--before` timestamp argument. `BuzzInboundLab.recoverHistory` scans bounded pages backwards with an overlapping second and event-ID deduplication; the batch is ingested only once the scan is complete. An undecidable same-second boundary, malformed/changed event, page-budget limit, or unreadable journal **fails closed without accepting a partial history**. A 225-message synthetic backfill test and an official-relay CLI `--before` smoke passed. No false claims of a gap-free cursor are made: a large burst within one second still cannot be paged safely by this API alone, and concurrent event arrival needs a stronger cursor/snapshot contract.

These laboratory paths remain **non-operational**: the CLI parser still does not independently verify a returned event's Schnorr signature, the production gateway's approval/attention engine is not integrated, replay after partially committed queue batches requires further fault injection, and the production switch from Slack to Buzz must preserve relay-only bindings and pending work. Buzz selection in daemon startup intentionally remains a named failure.

A real relay + isolated OpenRig queue demonstration is available with the documented CLI command in `scripts/buzz-real-relay/README.md`. Synthetic faults and focused restart tests cover response loss, retry ambiguity, provenance mismatch, SQLite commit result loss, unauthorized senders and replay deduplication. No second rig or agent is launched.

## Required next work before enabling Buzz

1. Build operational registry-driven admission and lifecycle management on the foundation of the new Buzz binding, including verified public-key ownership and a production transport readiness surface. Keep relay-only bindings active independently of Slack/Buzz selection.
2. Connect the outbound journal and inbox prototype to a production gateway **only after** adopting the existing delivery/attention policies and explicit human destinations, without changing Slack defaults.
3. Promote the lab's persisted outbound-root correlation and canonical registry validation to the production router, and add **local cryptographic verification** of raw Nostr event IDs/signatures, plus authorization checks at ingest.
4. Replace the fail-closed, capped timestamp backfill prototype with a proven gap-free cursor/snapshot strategy (including same-second bursts), persistent dead-letter recovery and explicit human-answer/approval semantics.
5. Prove crash recovery and operator reconciliation for uncertain post outcomes and stale locks. Switching from Slack to Buzz and back must account for open asks and pending decisions, never duplicate or silently reroute them.
6. Add a guarded production `buzz` factory, honest operator-visible status and rollback only after all these gates pass. Explicit Buzz selection currently remains a named failure.

No second gateway deployable, agent worker, socket server, daemon process or automatic desktop startup is introduced.

## Isolated regression tests

```bash
npx --no-install vitest run packages/daemon/test/gateway-provider-selection.test.ts
npx --no-install vitest run packages/daemon/test/gateway-subsystem-activation.test.ts
npx --no-install tsc --noEmit --project packages/daemon/tsconfig.json
```

Work is kept on the contributor branch `feat/issue-2-buzz-provider-selection`, stacked on the exploratory Buzz transport branch, with neither `main` nor the original project modified.
