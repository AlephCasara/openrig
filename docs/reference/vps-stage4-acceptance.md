# VPS-lean OpenRig — final local acceptance and deployment gate

**Review date:** 2026-11-06. **Scope:** feature branch
`feat/vps-lean-openrig` in `AlephCasara/openrig`, based on
`KoscheiiB/openrig:main` at `f68d28e417239fd0173f1954241f266e84bf1c3c`.
The existing contribution is
[KoscheiiB/openrig PR #1](https://github.com/KoscheiiB/openrig/pull/1).
**This report does not authorize merging or deploying to a production VPS.**

## Requirement-to-evidence acceptance matrix

| Goal | Verified implementation / evidence | Acceptance limit |
| --- | --- | --- |
| User-controlled isolated fork | `origin` is `AlephCasara/openrig`; feature branch tracks `origin`; PR base is **only** `KoscheiiB/openrig:main`. The other original upstream is not configured as a remote. | Review exact remotes before each push; a clean merge status is not a security review. |
| Understand architecture and compatibility | Compared daemon EventBus, SQLite replay, Hono SSE, startup/vendor service, CLI, TUI, UI, existing Slack gateway and plugin discovery against fixed baseline. Source and focused tests are in the same monorepo. | No independent production provider authentication or actual VPS inventory. |
| Quantifiable low-RAM changes | EventBus SQLite drain pages (256 rows); replay pages bounded by ~4 MiB estimated payload; live/replay SSE backlog capped at 256 events **and** ~4 MiB pending frame bytes per connection; slow readers disconnected and can recover from durable SQLite. | Single very large events and many concurrent SSE clients are not protected by a single process-wide memory ceiling. |
| Startup/disabled-feature overhead | Default local vendored plugin seed replaces an otherwise unused network probe; Claude permission help probing is lazy; initial UI event feed requests a 100-event tail. No new resident runtime dependency or service was added. | RSS idle differences were inconsistent across small repeated trials; do **not** claim a universal idle-memory reduction. |
| Modular plugins | Existing per-seat plugin discovery, inventory, vendor fallback and execution-policy tests passed; no third-party plugin process is enabled by the patch. | Separately measure external MCP servers and plugin hooks with the intended seat before enabling. |
| UI and observability | Existing web/TUI, `rig ps --resources`, cost telemetry, health, plugin and agent views retained; real disposable Chromium tested desktop and mobile core views. | No new dashboard service; one mobile plugin navigation timed out and remains inconclusive. |
| Slack communication | Existing in-process Socket Mode gateway retained; mocked scope/config, 429 handling, retry, connection and durable delivery tests passed. | **No** real workspace, token, grant audit, actual channel or live Slack delivery tested. |
| Dogfooding | Disposable real CLI/daemon/SQLite/tmux experiment exercised **two stub rigs** and safe stop/restore while the other rig continued; independent agent tests and real browser navigation exercised the modified branch. | Stub provider is **not** proof that authenticated Claude/Codex/Pi seats operated on the target VPS. |
| Reproducible measurements | Raw inputs, A/B scripts and results in [Stage 2](vps-stage2-validation.md) and [Stage 3](vps-stage3-security-review.md), including corrected matching context packs and independent review. | Local host shared a 12 GiB cgroup; V8 heap limits are **not** OS memory caps. |
| Installed E2E/rollback | Four workspaces build; `build-package.sh` assembles CLI+daemon+UI+TUI; `npm pack --dry-run --ignore-scripts --json` enumerates the assembled package and build identity. Disposable Docker scenario runner exists. | **Container run was blocked**: current user has no Docker socket access. Pack assembly does not prove clean-target native module installation or restore after rollback. |

Historical feature-commit identifiers in the raw benchmark JSON are
intentionally replaced by an explicit withdrawn-revision marker
because they referred to commits removed from the public branch
during a privacy-only history rewrite. These historical samples
are preserved without changing any measured value; the active
branch has equivalent application code. For fresh reproducibility,
rerun the supplied scripts on a reviewed local checkout.

External software integrations and separate product proposals are **out of
scope** for this minimal memory patch. Their compatibility and operating
costs must be independently validated; this PR does not claim their delivery.

## Repeated measurements — original versus modified

| Controlled local workload | Original | Feature | What it proves |
| --- | ---: | ---: | --- |
| 12,000 events × ~8 KiB, EventBus process peak RSS (three medians) | 433.3 MB | 276.4 MB | **36.2% lower** event-drain process peak; all notifications delivered |
| 500 events × ~98 KiB, first SSE replay page process peak RSS (three medians) | 231.5 MiB | 114.0 MiB | **50.8% lower** first-page peak; 500 versus 21 rows materialized |
| Daemon idle RSS; 256 MiB V8 heap, UI/kernel off, three runs per version | 217.2 MiB | 217.2 MiB | No measured idle-memory difference in this condition |
| Daemon idle RSS; 128 MiB V8 heap, UI/kernel off, three runs per version | 223.1 MiB | 208.8 MiB | Locally lower median, **not** a proven fleet-wide or production benefit |

For the startup matrix, **12/12** loopback smoke runs returned the expected
HTTP statuses. The replay and EventBus A/B matrices each completed **6/6**.
Elapsed startup is polled at ~150 ms resolution; do not treat one polling
interval or tiny HTTP sample differences as stable throughput gains.

The relevant source code contains no new runtime npm dependencies. The
`package-lock.json` is unchanged versus the baseline. Historical
production-dependency advisories remain unresolved.

## Stage 4 verification snapshot

- `npm run build`: **passed** for daemon, UI, CLI and TUI. The UI build
  reports a large JavaScript chunk warning, not a build failure.
- `bash scripts/build-package.sh`: **passed**, including staging the daemon,
  UI/TUI, policies, specs, reference docs and 57 context packs. Built package
  identity was `dirty=false` at the verified checkout. A local
  `npm pack --dry-run --ignore-scripts --json` enumerated **5,516 files**,
  ~**9.9 MB** package size. No npm publish/install occurred.
- `npm test`: **exited 1**. The repository test gate passed **333**, with 1
  skipped. The daemon suite: **24,903 passed, 5 failed, 27 skipped, 5 todo**.
  CLI: **6,262 passed, 2 failed, 7 skipped**. TUI: **1,202 passed**.
  UI's separate complete suite in Stage 3: **1,805 passed, 1 skipped**.
  These failures must remain visible. All **five** daemon failures were
  independently reproduced in the unmodified baseline by rerunning the same
  four affected test files (5 failed, 42 passed): three cases check executable
  modes but the checkout exposes `0700` instead of `0755`; one assumes
  a Bash-family shell while this host uses Fish; and one requires `lsof`,
  which is absent. The two CLI `chown` failures were previously reproduced
  against the original baseline on this restricted filesystem. **Baseline
  parity does not mean the whole suite is green** and does not prove behavior
  on the intended VPS.
- Previous focused SSE/EventBus, plugin and Slack suites passed after the
  security changes. Exact commands and limitations are recorded in the
  Stage 2 and Stage 3 reports.
- No GitHub Actions checks were reported for the PR at inspection time;
  **no remote CI pass is claimed**.

## Safe evaluation and constrained-VPS configuration

**Do not run these steps against an active production instance without an
approved maintenance window, state backup and rollback owner.**

For a disposable source/build checkout, verify the exact SHA and create an
artifact from the reviewed fork rather than using default installer links
that fetch a different upstream release:

```sh
git status --short
git rev-parse HEAD
npm ci --ignore-scripts --no-audit --no-fund  # safe only after reviewing native postinstall needs
npm run build
bash scripts/build-package.sh
( cd packages/cli && npm pack --dry-run --ignore-scripts --json )
```

`npm ci --ignore-scripts` does **not** build native addons such as
`better-sqlite3`. An install from the packaged tarball must be tested with
the intended Node ABI and native build toolchain in a **disposable** target.
Do not infer installation success from the dry-run. Existing
`scripts/build-testbed-image.sh` / `scripts/run-pr-scenarios.sh` exercise
packaged installation/rollback with disposable no-network containers and
2 GiB memory limits **when** a prepared Docker runner is available; they were
not executed on this host because of Docker socket permissions.

Before sizing an actual VPS, collect `free -m`, `swapon --show`, service
`memory.max`, `memory.current`, `memory.peak` and `memory.events`,
CPU/load, swap, and combined RSS/PSS for daemon **plus agent seats plus any
external MCP processes**. Test zero, one and concurrent authenticated seats,
and deliberately backpressured SSE consumers under service-level memory
limits. Observe OOM kills and process cleanup. This work requires access to
the authorized target host and is not complete.

Suggested low-footprint **operator-controlled** options (review each on an
isolated instance first):

```sh
rig config set ui.enabled false
rig config set transcripts.poll_interval_seconds 3
rig config set transcripts.lines 1000
rig ps --resources --json
rig status --json
```

- Bind to loopback using `OPENRIG_BIND_HOST=127.0.0.1` unless a trusted
  authenticated access layer and firewall have been verified. The SSE API
  alone does **not** require a bearer token in every network configuration;
  sensitive event metadata can be exposed on an untrusted interface.
- `OPENRIG_PLUGIN_VENDOR_PROBE_ON_START=1` explicitly restores an optional
  release-probe HTTP request; leave unset for local-only startup. The probe
  does not perform a plugin update in the current implementation.
- `OPENRIG_NO_KERNEL=1` disables automatic kernel bootstrap for an isolated
  test, not for a normal multi-seat production workflow. `BENCH_*` flags
  belong to disposable benchmarks, **not** production configuration.
- The package assembly reported that the optional internal-substance term
  scan had no supplied rules file, so that specific content gate was
  **skipped**. Review the built package manually for unintended source,
  credentials, private names and cross-repository references before any
  public artifact is published.
- Slack is off until configured. See
  [the existing Slack app setup](slack-app-setup.md), including the scope
  table and private `chmod 600` token file. `rig slack verify` covers
  baseline scopes only; feature scopes, channel membership, rotating tokens,
  inbound identity and delivery must be checked with the actual workspace
  before enabling. No tokens belong in Git or daemon logs.
- `rig setup` may add global provider tooling or perform optional remote
  installer steps; inspect `rig setup --dry-run` and explicit flags before
  running it on a real host.

## Rollback and contribution boundary

1. **Before production changes:** record the running binary's build commit,
   preserve an access-controlled backup of its config, SQLite state,
   provider/account settings, tmux inventory and externally retained secrets,
   and record a restore/restart procedure appropriate to that host. A Git
   revert alone does not restore database or agent state.
2. **Trial:** in a separate disposable installation, exercise
   start/status/shutdown, two stub seats, replay/reconnect, Slack-disabled
   behavior, plugin inventory, and native module load. Only then test real
   provider and Slack credentials under authorized limits.
3. **Restore:** stop the test instance, restore the pre-trial artifact
   matching its original build commit and validated state backup, start it
   under its original service manager, and check health, DB access, seat
   ownership and event continuation. Rollback has **not** been exercised on
   the actual target VPS.
4. **Git contribution:** publish only to `AlephCasara/openrig` via an
   explicit `git push origin feat/vps-lean-openrig`. The only review target
   is the existing [PR #1](https://github.com/KoscheiiB/openrig/pull/1)
   against `KoscheiiB/openrig:main`. Never merge without separate
   authorization. Public descriptions, review comments, generated documentation
   and *every commit in the proposed history* must exclude internal project
   names, internal issue identifiers and links to restricted workspaces.

**Remaining acceptance blockers:** accessible low-RAM VPS/cgroup; real
Claude/Codex/Pi and Slack end-to-end credentials; externally reachable API
authorization and safe event metadata; inherited dependency advisories;
installed package E2E under Docker or another clean machine; unresolved
full-suite fixtures; and a tested restoration procedure. A green merge
status does **not** override these gates.
