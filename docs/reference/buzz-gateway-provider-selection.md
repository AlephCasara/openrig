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

## Required next work before enabling Buzz

1. Separate the existing Slack-specific queue/relay delivery composition from the provider selection point, without disabling independently configured relay bindings.
2. Provide a Buzz outbound driver over the durable queue with reconciliation on uncertain CLI receipts; do not acknowledge a decision until delivery is confirmed.
3. Provide authenticated inbound sender mapping, thread correlation, replay/backfill and human approval parity.
4. Add a real `buzz` factory only after correctness and restart tests; then add honest operator-visible status/rollback documentation. Until then, an explicitly selected Buzz state is a named failure.
5. Validate switching providers with pending deliveries and open human questions before claiming Slack/Buzz interchangeability.

No second gateway deployable, agent worker, socket server, daemon process or automatic desktop startup is introduced.

## Isolated regression tests

```bash
npx --no-install vitest run packages/daemon/test/gateway-provider-selection.test.ts
npx --no-install vitest run packages/daemon/test/gateway-subsystem-activation.test.ts
npx --no-install tsc --noEmit --project packages/daemon/tsconfig.json
```

Work is kept on the contributor branch `feat/issue-2-buzz-provider-selection`, stacked on the exploratory Buzz transport branch, with neither `main` nor the original project modified.
