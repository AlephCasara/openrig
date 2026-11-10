# Buzz transport evaluation (experimental)

Status: **evaluation only**. The Buzz CLI boundary is not connected to OpenRig's gateway and must not be represented as a replacement for Slack yet.

## Decision

Target UX: select **Slack OR Buzz** as the external transport for a human destination. This is not dual posting, and it must not create Buzz-managed agents or require the Buzz desktop app for existing Slack users. Slack remains the default until Buzz is proven to reach functional parity.

## Existing architecture

- `startup.ts` constructs `buildSlackGatewayWire` directly. `GatewaySubsystem` owns exactly one in-process `GatewayWire`.
- The Slack wire contains both a queue-driven outbound driver and a Socket Mode inbound receiver, in addition to notification policies, a durable decision buffer, delivery receipts, dead letters, channel and thread routing, and human authorization.
- `gateway-subsystem.ts` delays network activity until `startServices()`. Unconfigured connectors must report inactivity honestly and must not break daemon boot.
- Additional external relay bindings exist; any future provider selection must not silently disable or corrupt existing relay delivery.

## Buzz observations

- Buzz uses Nostr message/event IDs (64 hexadecimal characters), public-key identities, and UUID channel IDs rather than Slack's identifiers, API, and Socket Mode.
- `block/buzz` documents a CLI with JSON results and `messages send/get/thread`. `messages send --content -` accepts stdin; sending returns an `accepted` flag and `event_id`; `messages get` supports `--since`, `--limit`, and `--kinds`.
- Credentials may be passed by a paired desktop or `BUZZ_PRIVATE_KEY`/NIP-98; deployments must not put private keys in argv, JSON config, logs, or test fixtures.
- `block/buzz-app` Buzz 1.0 is beta and ships a CLI pinned to the underlying Buzz revision. Plugin APIs are preview and are not suitable as the only transport contract.

References: https://github.com/block/buzz/tree/main/crates/buzz-cli and https://github.com/block/buzz-app

## What this experimental branch implements

`packages/daemon/src/domain/gateway/buzz-cli.ts` provides a standalone, injected CLI runner with:
- no shell and no process before a method call;
- message body via stdin, explicit timeout and bounded stdout;
- bounded `messages get` batches and required channel/author/kind metadata;
- send receipt refusal unless the relay reports acceptance and a valid event ID;
- channel and thread parsing suitable for later inbox integration.

Tests are deterministic and use an injected runner. They do **not** establish authenticity of a message, network reachability, retry correctness, or live interoperability.

## Required before a production integration

1. Obtain review agreement on provider selection and support boundary. Decide whether Buzz requires an installed CLI or a direct relay client. No app/agent auto-start.
2. Introduce a versioned provider configuration with an explicit opt-in, readiness/status commands, safe key custody, and no change to existing Slack config semantics.
3. Refactor the gateway composition minimally, keeping the current durable queue/dispatcher, notification decisions, and relay paths. Never activate both Slack and Buzz for the same destination by accident.
4. Implement Buzz outbound idempotency and durable correlation: when a relay accepts a post but the CLI response is lost, a retry must not blindly post again. Persist post/event relationships and reconcile uncertain outcomes.
5. Implement inbound with authenticated sender mapping to registered humans, authorization at channel and conversation level, self-echo filtering, persistent event-ID deduplication, episode-aware thread attribution, typed answer handling, and no implicit approval.
6. Address polling limitations. `--since` is second resolution and `--limit` is capped: a busy channel may exceed one page in a second; define deterministic pagination/backfill or use a Nostr subscription with bounded buffering and recovery.
7. Test restart/replay, duplicate messages, collisions, out-of-order messages, transient network failures, invalid key, missing binary, relay 429/5xx, concurrency, and memory footprint. Carry out an isolated live relay + real daemon end-to-end demonstration, including human reply.
8. Add operator documentation, version compatibility matrix, NixOS/Linux deployment guidance, migration and rollback.

Until these gates pass, leave this module unconnected to startup, do not introduce a new default dependency, and do not claim feature parity.
