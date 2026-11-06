# Stage 3 — independent security, compatibility and low-RAM review

**Date:** 2026-11-06. **Review target:** `AlephCasara/openrig`,
`feat/vps-lean-openrig`, originally based on `f68d28e417239fd0173f1954241f266e84bf1c3c`.
Target contribution: **only** `KoscheiiB/openrig` PR #1; not the
original OpenRig upstream. This is a review of the isolated local branch,
**not** proof of an authorized VPS deployment or authenticated Slack traffic.

## Independent review, severity and dispositions

An independent, read-only worker who was not involved in implementing the
Stage 1 changes reviewed the EventBus, SSE route, UI consumer, browser
boundary and CI. It independently reproduced an extreme replay memory spike
and a stale EventSource cursor problem. Its separate EventBus/SSE regression
suite passed 45 tests before the additional fixes. Prime reproduced each
chosen issue as a **failing regression test before the fix**, then reran
the focused integration suites after correction.

| Severity / finding | Evidence and disposition |
| --- | --- |
| **High on low-RAM host: replay page counted rows, not bytes** | `EventBus.replayPage` used `statement.all()` and parsed up to 500 large JSON rows before the next SSE write. Independent 500 × ~98 KiB reproduction grew V8 heap by ~109 MiB and process RSS from ~149 to ~271 MiB. **Fixed:** optional byte-bounded SQLite `iterate()` page reader, SSE route sets ~4 MiB estimated payload budget. Always return at least one oversized row so cursors advance. |
| **Medium: slow SSE readers retain oversized payloads** | Existing 256-event cap still allowed 48 × 128 KiB pending events. Failing test left the subscriber registered. **Fixed:** cap replay-buffer and serialized-live-write pending bytes at ~4 MiB **per connection** (UTF-16 conservative estimate), in addition to event count; abort stalled connection and replay durable SQLite on reconnect. |
| **Medium: stale `Last-Event-ID` after DB replacement** | A client remembering an event seq beyond the new database maximum suppressed future live events. **Fixed:** reset from the available log; a supplied `?replay=N` instead retains its finite tail. Added two regressions. |
| **Medium: UI full-history replay on fresh page** | UI shared hub previously requested `/api/events` with implicit full historical replay even though the activity feed stores only 100 entries. **Fixed:** first connection requests `/api/events?replay=100`; standard EventSource reconnect still includes `Last-Event-ID` and the server prioritizes it. |
| **Medium, inherited startup work: unused network fetch** | Bootstrap always requested GitHub plugin release with a 5s timeout even when HTTP 200 could not install anything. **Fixed:** shipped local plugin seeding by default; `OPENRIG_PLUGIN_VENDOR_PROBE_ON_START=1` is an explicit diagnostic opt-in. Existing explicit `ensureLatest` retains its old contract. |
| **Medium, inherited startup work: Claude permission probe** | Daemon eagerly spawned `claude --help` on boot, producing a transient Nix `.claude-wrapped` process with variable RSS even with kernel disabled. **Fixed:** mode cache warms asynchronously on first actual permission diagnostic, returning UNKNOWN until ready. No actual Claude seat is started for this check. |
| **Conditional high if publicly reachable: unauthenticated SSE** | The API route is protected by host/origin browser-boundary checks, not by a mandatory bearer. Origin-less HTTP clients and IP-literal hosts can reach reads. **Not changed:** native EventSource needs cookies or URL/session-compatible authorization; adding a blind bearer requirement would break the existing UI. **Deployment gate:** ensure loopback-only or strictly authenticated reverse proxy/tailnet/firewall and explicitly validate reachable interfaces on the real VPS. |
| **Inherited dependency alerts** | Production lockfile is identical to baseline (SHA256 `806fd876c3854c1312fc973d54312befc08dda34948c3626bbbac88bc64a9067`). Previous online audit flagged 16 packages (2 critical, 9 high, 4 moderate, 1 low), including `tar`, `seroval`, `hono`, `ws` and `zod`. **Unresolved:** audit each advisory/entry path and upgrade separately with compatibility tests. No dependency changes were made here. |

**Byte-budget limitations:** The limits count estimated UTF-16 payload bytes,
not resident memory itself. SQLite/JSON internals, a single event larger
than the budget, subscribers and simultaneous clients can still exceed it;
these are not hard process/cgroup memory caps. The general
`replayAll`/rig-scoped unbounded APIs remain for existing non-SSE callers.
Subscriber exceptions are caught; overrun drops only the SSE connection,
not the durable events. Existing slow-client cancellation tests and new
payload-sized tests cover cleanup, but a real reverse-proxy/network fault
injection test is still desirable.

## Independent numerical comparison

All benchmarks below run **sequentially** on a local test host with identical
compiled revisions, generated context packs, Node v24, temporary homes and
no production agent credentials. Their V8 heap flags are **not VPS RAM
limits**. Numbers are medians of three individual runs per revision.

| Isolated workload | Original | Stage 3 | Interpretation |
| --- | ---: | ---: | --- |
| One `replayPage` request over 500 × ~98 KiB events, peak process RSS | **231.5 MiB** | **114.0 MiB** | **50.8% lower** peak for the first page; original materializes 500 events, revised page materializes 21 under its 4 MiB budget |
| Same first page, heap allocation delta | 106.9 MiB | 3.5 MiB | Measures only that single-page operation, not time/memory required to stream *all* historical events |
| EventBus committed drain, 12,000 × ~8 KiB, peak RSS | **433.3 MB** | **276.4 MB** | **36.2% lower** peak, every notification delivered; Stage 1 performance benefit preserved |
| EventBus committed drain, elapsed | 353 ms | 294 ms | Median; tiny batch timings are not stable production latency guarantees |

Data: [vps-stage3-replay-ab.json](vps-stage3-replay-ab.json),
[vps-stage3-event-backlog.json](vps-stage3-event-backlog.json).

A separate 12-run local startup matrix with `OPENRIG_NO_KERNEL=1` and
non-loopback Node-fetch guard compared baseline and modified daemon at
128 and 256 MiB V8 heap, UI disabled. **12/12 returned expected HTTP statuses.**
At 128 MiB, idle RSS medians were 223.1 → 208.8 MB and startup 770 → 620 ms;
at 256 MiB, 217.2 → 217.2 MB and startup 620 → 620 ms. The startup
measurements use ~150 ms interval polling, so a one-interval difference
cannot prove a meaningful advantage. The original's
short-lived provider executable and ordinary host variance still affect
readings; **no stable idle-RSS or startup advantage is claimed**.
Raw data: [vps-stage3-startup-ab.json](vps-stage3-startup-ab.json).
The explicit remote probe was separately exercised with an HTTP fetch
guard: it attempted the configured request, failed closed, and used its
vendored fallback. With default settings, no plugin release fetch occurred.

## Slack, plugins, sessions and security boundaries

- Slack already ships as an **in-process, disabled-until-configured**
  gateway. No new Slack daemon, web UI service, MCP process, npm dependency
  or polling loop was introduced in this fork. Stage 2 independently tested
  disabled/inert status, channel mapping, 429/rate-limit retry, socket errors,
  durable resend and plugin inventory with fake transports. Stage 3 did
  **not** authenticate against Slack or access the target VPS.
- The connector's canonical manifest requests bot scopes
  `chat:write`, `channels:history`, `channels:read` plus feature scopes
  `files:read`, `files:write`, `app_mentions:read`,
  `reactions:read` and `users:read`. Features requiring these grants
  must be justified per intended deployment. `rig slack verify` checks
  only the baseline grant set, so it must not be treated as evidence that
  every optional feature is authorized. Slack manifest has
  `token_rotation_enabled: false`; operational rotation must be managed.
- The existing Slack secret resolver does not log a resolved secret and
  warns for group/world-readable env files, but **the mode check is a
  warning, not enforcement**. Secret-redaction functions are used in
  outbound content and file titles. Real-host checks still need to inspect
  log retention, masked telemetry, token storage, scoped app channels,
  process-argument exposure and upload permissions; mocks cannot prove
  the absence of secret exposure in every path.
- Third-party plugins may contribute per-seat MCP tools and settings but
  do not automatically gain the native bundled `openrig-core` hooks.
  External memory MCP servers count against actual VPS RAM. The daemon
  vendor-service remote request was disabled by default here to avoid
  an unused boot-time network dependency, not to disable locally vendored
  skills.
- Agent session lifetime, cancellation and tmux boundaries were exercised
  with isolated stub seats in Stage 2; provider-authenticated agent lifecycles
  and sustained multi-seat memory use on the actual VPS remain unverified.
  Browser UI was rendered in real isolated Chromium in Stage 2, but no
  authenticated browser session or arbitrary external-host exposure was tested.

## Compatibility and feature boundaries

The changes retain OpenRig's existing gateway, Slack transport, provider
adapters and plugin-discovery interfaces. Third-party integrations and
additional background services are deliberately outside the scope of this
low-memory patch; enable them only after separately testing permissions,
resource usage, lifecycle cleanup and compatibility with the deployed build.
No other project's work or issue status is asserted by this PR.

## Git, CI, artifact hygiene and rollback

- `origin` = `AlephCasara/openrig`; `koscheiib` =
  `KoscheiiB/openrig`. Original upstream is absent from configured remotes.
  The feature branch tracks `origin`; this checkout explicitly sets
  `remote.pushDefault=origin` and branch-local `pushRemote=origin`
  (local config only; not shipped to collaborators). Publish with explicit
  `git push origin feat/vps-lean-openrig`; review the target before push.
- `.github/workflows/tests.yml` and `portability-report.yml` use
  `contents: read` and no PR auto-merge/push; `persist-credentials: false`
  on the test workflow. They do not publish to the original upstream.
- Benchmark scripts build ephemeral local configurations, use loopback-only
  listeners and clean up process groups. The **Node fetch** guard refuses
  non-loopback HTTP for the benchmark daemon; it does not confine every
  external process or every transport. Do not infer complete network isolation.
  Raw JSON data must be reviewed for home paths, tokens, environment and
  private topology before committing.
- Revert the Stage 3 commits on the personal fork if a regression is
  demonstrated, rebuild in an isolated worktree and rerun focused tests.
  Do not reset the user's working tree, restart production or remove
  source-level protection without separate approval.

## Test gates, gaps and next acceptance

Focused daemon EventBus/SSE/vendor/permission tests and UI event-hub tests
passed after the patches; a further **140/140** mocked gateway, Slack,
plugin discovery/configuration and rate-limit/inbound tests also passed
across 11 files. Broad UI suite passed **1,805 tests, 1 skipped**
in **204 files**. Repository integrity gate `npm run test:repo`
passed **333 tests, 1 skipped**; `npm run lint` passed.
The complete daemon suite previously yielded **24,895
passed, 9 failed, 27 skipped, 5 todo** in 1,328 files; it must **not** be
represented as green. The stale assertions in three instrumentation tests
expected the old boot-time GitHub fetch; their fixtures were corrected to
expect no fetch by default. A native tmux transcript stress test also fails
on the unmodified original checkout, indicating baseline parity for that
failure, but not proving every environmental flake is harmless. The host
has `fish`, restrictive checkout file modes and no `lsof`; previous
CLI tests show the same inherited host-specific shortcomings.

To reproduce:

```sh
npm run lint
npm run test:ui
npm exec --no -- vitest run packages/daemon/test/events-route.test.ts \
  packages/daemon/test/event-notify-envelope.test.ts \
  packages/daemon/test/event-nested-fanout.test.ts \
  packages/daemon/test/plugin-vendor-service.test.ts \
  packages/daemon/test/permission-drift-observer.test.ts
BENCH_REPLAY_REPEATS=3 node scripts/bench-sse-replay-matrix.mjs
BENCH_EVENT_HEAP_MB=256 BENCH_EVENT_REPEATS=3 \
  BENCH_EVENT_CASES='12000:8192' \
  BENCH_EVENT_MATRIX_OUTPUT=docs/reference/vps-stage3-event-backlog.json \
  node scripts/bench-event-matrix.mjs
```

**Acceptance still blocked:** no authorized real VPS host, no controlled
production-like RAM cgroup, no authenticated provider seats or Slack
workspace; no real network-facing penetration test. Before merge, verify
external exposure and route authorization, concurrent active-seat memory,
swap/OOM/restart, long-duration plugin and Slack recovery, dependency
advisories, and observed resource overhead when integrations are disabled.
**No merge or production deployment is approved by this report.**
