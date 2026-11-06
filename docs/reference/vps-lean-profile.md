# Lean VPS deployment and benchmark profile

This is an **opt-in operational profile** for OpenRig on a resource-limited
Linux VPS. It preserves existing agent, Slack, plugin, CLI, and HTTP behavior.
There is no second daemon, exporter, dashboard service, or additional npm
dependency. The daemon is still one Node.js process; each active Claude Code,
Codex or Pi seat adds its own harness process, typically through tmux.

## First establish the real memory budget

On the **actual target VPS**, capture total RAM, free RAM, swap and the memory
limit imposed on the daemon's service/cgroup. Include the resident harnesses
and any separate MCP servers in the process-tree budget; daemon-only RSS is not
a complete estimate of OpenRig's operating footprint. Then inspect:

```sh
rig ps --resources --json
rig status --json
```

`rig ps --resources` already reports capture operations and load. The
existing web UI and TUI already expose agent status, plugin discovery,
attention and project views; there is no requirement to run the web UI as a
separate service on a small VPS.

For a headless install, use a supported Node.js 22 or 24 runtime, tmux,
and **one** signed-in provider. When initializing a disposable installation,
`rig setup --providers codex --no-herdr` (or `--providers claude`) avoids
installing the optional Herdr terminal manager. Run `rig setup --dry-run` first
to inspect changes to the account's config.

## Low-overhead options supported by OpenRig

```sh
# On the intended VPS installation only, after inspecting current settings.
rig config set ui.enabled false
rig config set transcripts.poll_interval_seconds 3
rig config set transcripts.lines 1000
rig ps --resources
```

The UI switch takes effect after a daemon restart; transcript poll interval
and trailing line count update on running rotations. A longer transcript
interval can lower capture CPU and tmux pressure, but weakens capture
freshness and does **not** change the independent activity, identity or
readiness polling. Do not disable transcript capture if a workflow depends
on it. Avoid overcommitting RAM with more simultaneous agent seats than fit
the budget.

Slack's Socket Mode integration, channel mapping, durable delivery, and
human decisions are already shipped and remain off until configured. The
existing setup guide is [slack-app-setup.md](slack-app-setup.md); keep tokens
in a private environment file and never commit them. Similarly, third-party
Claude/MCP plugins should be enabled only for seats that use them: a separate
memory server increases the actual VPS process budget even when OpenRig's
plugin-discovery API is cheap.

For this branch, bootstrapping the built-in `openrig-core` plugin uses the
shipped local copy without contacting a release URL. A remote diagnostic
probe is opt-in with `OPENRIG_PLUGIN_VENDOR_PROBE_ON_START=1`. The current v0
remote probe **does not download and install an update even when it succeeds**;
this setting only restores the existing GitHub request and its possible
five-second network timeout. The CLI's explicit vendor checks are unchanged.
The daemon also defers the transient `claude --help` permission-vocabulary
probe until an actual permission-drift diagnostic requests it; the first
diagnostic can honestly return UNKNOWN while the background read completes.
This prevents a gratuitous runtime spawn at every headless daemon start
without disabling permission checks on active seats.

## Memory changes in this branch

* **EventBus notification drain:** a large committed transaction is consumed
  from SQLite in pages of 256 event rows. Its previous unrestricted
  `SELECT ... WHERE seq > ?` loaded the entire backlog into JS memory.
  Events still reach subscribers in sequence. Nested notifications and
  malformed-row poison receipts preserve existing behavior.
* **SSE event consumers:** replay remains paginated. A client that cannot
  keep up with live events has at most 256 pending events in its replay buffer
  or serialized live write queue. The daemon closes that connection on
  overflow; standard EventSource clients reconnect using `Last-Event-ID`
  and replay the durable database history. No events are deleted from SQLite.
  Clients using a non-reconnecting SSE library must handle reconnection
  explicitly.

These protections primarily affect **peak RSS during backlogs and slow
readers**, rather than an empty daemon's resident baseline. The existing UI,
Slack implementation, plugin system, agent scheduling and APIs have not been
replaced.

## Reproducible local benchmarks

Build the exact revisions to compare and use **the same Node version,
heap limit, inputs, hardware, and background load**. From the feature
branch's repository root:

```sh
npm ci --no-audit --no-fund
npm run build -w packages/daemon

# Creates its own temporary HOME, OPENRIG_HOME and local listener.
# Never launches an existing rig or contacts production Slack.
BENCH_HEAP_MB=256 node scripts/bench-vps-lean.mjs

# Measures process high-water RSS during a committed event backlog.
BENCH_EVENTS=12000 BENCH_EVENT_BYTES=8192 \
  node --max-old-space-size=256 scripts/bench-event-backlog.mjs
```

For a comparison checkout built at the unmodified commit:

```sh
BENCH_DAEMON_PATH="$(realpath ../openrig-baseline-vps/packages/daemon/dist/index.js)" \
  BENCH_HEAP_MB=256 node scripts/bench-vps-lean.mjs

BENCH_EVENT_BUS_MODULE="$(realpath ../openrig-baseline-vps/packages/daemon/dist/domain/event-bus.js)" \
  BENCH_EVENTS=12000 BENCH_EVENT_BYTES=8192 \
  node --max-old-space-size=256 scripts/bench-event-backlog.mjs
```

The daemon benchmark reports wall-clock startup, idle RSS, sampled process-tree
RSS and CPU, 80 concurrent-request samples (8 workers), throughput, and response
codes, plus disabled Slack and plugin inventory endpoints. Its 256 MB heap
cap applies only to the benchmark daemon. Setting `NODE_OPTIONS` globally on
a production host would also affect Node-based *agent* runtimes and should
not be inferred from this benchmark.
The process-tree sampler runs every 200 ms and can miss short-lived tmux
helpers; it does not include independent tmux agent processes. Compare
container/cgroup memory and active agent RSS separately on the actual VPS.

The event backlog benchmark measures the peak RSS of a single process that
commits and drains 12,000 roughly 8 KB events. In one local test on 2026-11-06,
Node v24.20.0 and a 256 MB V8 heap:

| Workload | Original `f68d28e` | Feature branch (uncommitted at measurement) |
| --- | ---: | ---: |
| Events delivered | 12,000 | 12,000 |
| Peak RSS | 432.3 MB | 274.0 MB |
| Drain including insertion | 363 ms | 288 ms |

This is **one local run** on an approximately 30 GiB RAM workstation, not a
verified deployment on the users' actual VPS, and not a claim that OpenRig
uses 158 MB less RAM while idle. Repeat runs and inspect variance on the
target before assigning a VPS size. Real Claude/Codex/Pi seats and Slack
delivery require separate integration checks with authorized credentials.

## Optional integrations and scope

OpenRig already provides an in-process Slack connector, per-seat plugin
discovery, an HTTP UI/TUI and basic resource/usage observations. No
additional resident dashboard, memory server or Slack process is introduced
by this patch. Operators should measure optional external MCP integrations
separately and keep them disabled when unnecessary on constrained hosts.

## Validation, limitations and rollback

The independent follow-up, including the corrected baseline artifact comparison,
three-repeat event-backlog measurements, full-suite environmental failures and
unverified real-VPS gates, is recorded in
[vps-stage2-validation.md](vps-stage2-validation.md). Prefer that controlled
multi-run evidence to the illustrative one-off numbers above.

The separate adversarial review, including replay/SSE byte budgets, stale
cursor recovery, boot-time dependency cost, inherited security risks,
optional integration boundaries and new A/B evidence, is documented in
[vps-stage3-security-review.md](vps-stage3-security-review.md).

```sh
npm run lint
npx vitest run packages/daemon/test/event-bus.test.ts \
  packages/daemon/test/event-notify-envelope.test.ts \
  packages/daemon/test/events-route.test.ts
npm test
```

Run a production-like test with actual provider seats only on an authorized,
disposable environment. Compare 0, 1 and several stub/real seats, terminal
capture and status, SSE reconnect after a slow consumer, plugins and Slack
with their own configurations. The local benchmark does not prove remote
Slack delivery, token scopes, or agent dogfooding; do not treat HTTP status
checks as those proofs.

Rolling back source changes is a normal Git checkout/revert of the feature
commits followed by the same install/build/test steps. Restoring a deployed
service requires its own maintenance procedure and state backup. These
benchmarks do not stop, replace or reconfigure any existing service.
