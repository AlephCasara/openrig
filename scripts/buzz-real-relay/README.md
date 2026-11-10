# Real Buzz relay smoke lab (no OpenRig runtime)

This is a disposable **integration-test deployment of the official Buzz relay**, used to validate the experimental Buzz CLI transport in OpenRig. It does not run an OpenRig daemon, rig, agent, workspace, Buzz Desktop, or production service.

## Prerequisites

- Node.js with this repository's `tsx` dependency installed (`npm ci` in the isolated checkout).
- Docker Engine + Compose available to the current user.
- An **official upstream Buzz CLI executable**. The CLI is also shipped inside Buzz 1.0.0's official Linux `.deb` (file `usr/lib/Buzz Foundation/bin/buzz`); it can be extracted to a private scratch location without a system-wide install.
- Enough RAM/disk for four temporary backend services and one relay. Docker will cache the downloaded images even after the test containers are removed.

Run from the experimental OpenRig checkout:

```bash
BUZZ_CLI_BIN=/absolute/path/to/buzz node --import tsx scripts/buzz-real-relay/run.mjs
```

The launcher pulls a **pinned Buzz Linux/amd64 relay image** and pinned Silo/MC backing images, plus PostgreSQL 17 and Redis 7. It starts an independent, randomly named Compose project. PostgreSQL/Redis/S3 have **no host ports**. The relay publishes a randomly chosen host port on **127.0.0.1 only**. Memory limits: relay 1 GiB, PostgreSQL 384 MiB, Redis 96 MiB, S3 256 MiB, initializer 128 MiB. The CPU caps are in `compose.yml`.

### What is validated

- Official CLI creates an ephemeral **private** channel on a real Buzz relay.
- NIP-98-signed message is accepted, stored and read back; returned event has the expected signer pubkey and Schnorr signature field.
- Non-member cannot read another participant's private event (the relay may return an empty list rather than a 4xx) or write to that private channel.
- The owner adds a second temporary pubkey to the channel; that member replies in a thread. The experimental OpenRig adapter reads both messages with correct sender and thread metadata.
- The owner removes that member and the relay refuses subsequent messages.
- Unknown channel, malformed key, invalid thread reference, and unauthenticated raw HTTP mutation are refused.
- Separately, synthetic *local HTTP fault servers* exercise 429, 503, request timeout and early disconnect. These are fault injection, not real rate limits issued by the Buzz relay.

Every run generates three throwaway Nostr identity keys, one relay key, database/object-store credentials, and a random channel. **No personal credentials** should be used. Credentials are passed to child processes only through environment variables, never as CLI flags or committed test fixtures. The script redacts CLI error details and prints only bounded error categories.

Cleanup runs in `finally` using `docker compose -p <unique-project> down -v --remove-orphans`, deleting containers and test volumes without touching other Compose projects. Images remain in Docker's cache. If the host kills the process with SIGKILL, use the printed project name or `docker ps -a --filter name=openrig-buzz-lab-` to identify only this lab's leftovers, then clean that project explicitly.

## Important scope boundaries

1. **Relay membership is separate from channel membership.** With `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true` (NIP-43), merely adding a pubkey to a channel does not authorize it to use the relay. This lab deliberately disables relay-wide membership enforcement to validate private-channel membership and threaded cross-identity messaging. Production designs must account for both gates.
2. The raw unsigned, tampered event test returns 401. That confirms refusal, **not** that the relay independently detected a bad Nostr event signature after successful authentication. A dedicated authenticated tampering test remains necessary to certify signature rejection at ingest.
3. This does not establish durable queue semantics, replay after reboot, race-free pagination, receipt reconciliation, human approval, or a complete Slack replacement. Those belong to later gateway issues.
4. No third-party websites or remote production relays receive test messages. Docker still downloads upstream container images as needed.
5. The Buzz image is pinned to an **upstream platform-specific content digest**. To update it, review the upstream change and amend the pin deliberately. Other images should also be pinned before this harness is considered stable in CI.

See [the transport evaluation](../../docs/reference/buzz-transport-evaluation.md) and the tracking issue at [AlephCasara/openrig#1](https://github.com/AlephCasara/openrig/issues/1).
