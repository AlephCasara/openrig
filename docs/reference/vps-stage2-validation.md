# Stage 2 — isolated A/B validation of the lean VPS branch

**Date:** 2026-11-06. **Scope:** `AlephCasara/openrig` branch
`feat/vps-lean-openrig` on the code-equivalent pre-sanitization tree,
compared with its original base `f68d28e417239fd0173f1954241f266e84bf1c3c`.
Only the feature branch may be pushed; the sole contribution target is
`KoscheiiB/openrig` PR #1. This report is **not** a production-VPS acceptance.

## Execution boundaries and methodology

- A/B trials executed sequentially on the **same local host** using Node.js
  v24.20.0, both prebuilt worktrees, temporary HOME/OPENRIG_HOME/provider
  homes, a private tmux directory, a loopback port and controlled shutdown.
  No existing rig, production daemon, credentials or Slack workspace was used.
- Host reported ~30.5 GiB physical RAM / 24 logical CPUs. The benchmark session
  ran in a **shared 12 GiB cgroup** (`/system.slice/coop.service`), not an
  isolated 12 GiB VPS. The user systemd scope bus is unavailable, and this
  environment did not grant a per-benchmark cgroup memory limit. The V8 flags
  `--max-old-space-size=128/192/256` limit old-space heap, **not** process RSS
  or child-process memory; do not advertise them as a 128 MB RAM VPS test.
- `scripts/bench-vps-matrix.mjs` alternates baseline/feature launch order and
  calls `scripts/bench-vps-lean.mjs`. It records daemon `VmHWM` RSS,
  sampled process-tree RSS, idle RSS, sampled CPU ticks, startup, HTTP
  concurrency/throughput and statuses. Procfs sampling may miss short-lived
  tmux helpers and independently detached agent processes. Summed per-process
  RSS can count shared physical pages multiple times and is **not** cgroup
  memory usage. Startup here means **time to a listening TCP port**, not
  completion of every background initialization step; polling
  occurs every ~150 ms. The small HTTP batches are smoke/relative measurements,
  **not** a statistically stable throughput benchmark.
- Both checkouts now have identical generated daemon `context-packs`: 57
  packs / 169 files (~1.8 MB), checked by recursive diff. **Before** that
  correction, the baseline checkout had no generated context packs. Thus
  the old 24-run matrix and longer idle data are retained as diagnostic
  artifacts, but **must not** be used as a causal idle-memory comparison.

## Event backlogs: material improvement with identical inputs

`scripts/bench-event-matrix.mjs` uses the corresponding compiled EventBus
from each checkout in an in-memory SQLite process, pushes committed events
through the real notification envelope, verifies the exact subscriber count
and records `process.resourceUsage().maxRSS`. Three repetitions per side
with 256 MiB V8 old-space heap:

| Committed event workload | Baseline median peak RSS | Lean median peak RSS | RSS difference | Median elapsed |
| --- | ---: | ---: | ---: | ---: |
| 2,000 × ~1 KiB | 83.2 MB | 77.8 MB | −6.5% | 30 → 27 ms |
| 12,000 × ~8 KiB | 434.2 MB | 274.3 MB | **−36.8%** | **364 → 296 ms** |
| 3,000 × ~32 KiB | 393.3 MB | 300.8 MB | −23.5% | 266 → 220 ms |

All **18/18 runs passed** and delivered the expected number of events. The
3,000 × 32 KiB feature samples vary (279.2, 350.1, 300.8 MB); the median
must not obscure that variance. An additional two-repetition comparison of
12,000 × ~8 KiB with the V8 heap flag set to 128 MiB produced baseline
402.4/402.4 MB versus feature 275.4/276.1 MB; all four delivered 12,000 events.
These results measure **the isolated SQLite/EventBus process**, not a complete
daemon or active provider seat.

Raw measurements: [vps-stage2-events.json](vps-stage2-events.json),
[vps-stage2-events-heap128.json](vps-stage2-events-heap128.json).

## Idle daemon and built-in HTTP/UI surfaces

The initial 24-run, two-repetition matrix used V8 heaps 128/192/256 MiB,
web UI on/off, concurrency 8 and 120 HTTP requests per run. **24/24 exited
successfully**, with expected statuses at `/api/health`, `/api/plugins`,
`/api/telemetry/usage/cost`, `/api/gateway/slack/status`, `/`, and `/specs`.
When the UI was disabled, only the two UI routes returned intentional 404.
It is not valid evidence of idle regression/improvement because of unmatched
generated baseline files at the time. See
[vps-stage2-local-samples.json](vps-stage2-local-samples.json).

After matching the context packs, a controlled 256 MiB heap, UI-off run used
three repetitions per side, 8 seconds idle and 60 requests at concurrency 8:

| Median metric | Original | Lean | Delta |
| --- | ---: | ---: | ---: |
| Idle RSS | 217.2 MB | 218.4 MB | +1.2 MB |
| Daemon high-water RSS | 218.8 MB | 219.6 MB | +0.8 MB |
| Sampled process-tree peak RSS | 256.0 MB | 256.3 MB | +0.3 MB |
| Sampled CPU, % of one core | 9.2% | 9.0% | −0.2 percentage points |
| Startup | 922 ms | 920 ms | −2 ms |
| HTTP requests/sec (small batch) | 1000.0 | 1016.9 | +16.9 |

All **6/6** controlled runs passed with expected response codes. The
earlier apparent +13.2 MB idle-RSS difference shrank to +1.2 MB after equalizing
assets. Neither the residual difference nor short-batch throughput demonstrates
a significant idle regression or speed-up. The modified EventBus only needs
extra memory under backlog, so a large improvement at idle was not expected.
Raw data: [vps-stage2-controlled-idle.json](vps-stage2-controlled-idle.json);
the confounded prior comparison is
[vps-stage2-long-idle.json](vps-stage2-long-idle.json).

### Full controlled configuration matrix

With the context packs now identical, the **final** 3 × 3 × 2 matrix ran
**36/36 isolated trials successfully**, using V8 old-space heap settings
128/192/256 MiB, UI both off/on, 3 seconds idle, 120 requests, concurrency 8.
No unexpected HTTP statuses or request failures occurred.

| V8 heap / UI | Idle RSS, baseline → lean | Daemon high-water RSS | Sampled process-tree peak RSS | Startup, ms | HTTP req/s |
| --- | --- | --- | --- | --- | --- |
| 128 / off | 217.4 → 215.5 MB | 218.1 → 217.4 MB | 280.5 → 276.9 MB | 1227 → 925 | 1538.5 → 1318.7 |
| 128 / on | 213.9 → 217.8 MB | 217.5 → 218.5 MB | 259.8 → 317.3 MB | 925 → 1073 | 1176.5 → 1237.1 |
| 192 / off | 218.7 → 218.2 MB | 219.6 → 219.1 MB | 316.3 → 319.7 MB | 1076 → 1075 | 1212.1 → 1333.3 |
| 192 / on | 218.0 → 218.6 MB | 219.0 → 219.6 MB | 275.1 → 279.8 MB | 923 → 922 | 1600.0 → 1690.1 |
| 256 / off | 219.2 → 217.9 MB | 220.1 → 218.8 MB | 263.4 → 271.3 MB | 923 → 1072 | 1558.4 → 1363.6 |
| 256 / on | 218.9 → 218.0 MB | 219.8 → 218.8 MB | 279.1 → 299.0 MB | 921 → 1073 | 1578.9 → 1318.7 |

These six paired medians **do not establish** a stable startup or HTTP
throughput advantage. The largest absolute idle-RSS difference is +3.9 MB;
the high-water RSS difference is between −1.3 and +1.0 MB.

The process-tree peaks are much noisier. A follow-up **16-run** trace
(four repetitions per version at 128 and 256 MiB, UI on) captured process
names and RSS at each peak without recording process arguments or tokens.
Each observed tree peak occurred in **startup**, when a transient descendant
named `.claude-wrapped` (the Nix-packaged Claude executable; the exact
startup caller remains unresolved) was present in **both** revisions. Its sampled RSS
fluctuated from roughly 38 to 125 MB, while the daemon high-water RSS stayed
roughly 217–220 MB. At 128 MiB, traced tree medians were
285.5 → 298.0 MB; at 256 MiB, 266.1 → 292.1 MB. This repeated difference
is **not ignored**, but the trace shows the excess resides predominantly in
an existing, variable startup child rather than retained daemon memory.
Its cause and production significance cannot be proven from the local,
small-sample benchmark. No product change is justified solely from this.

Raw data: [vps-stage2-final-controlled-matrix.json](vps-stage2-final-controlled-matrix.json),
[vps-stage2-tree-diagnostic.json](vps-stage2-tree-diagnostic.json).

An additional **6/6** trials with `BENCH_KERNEL_ENABLED=0` (the supported
`OPENRIG_NO_KERNEL=1` opt-out) still observed the same `.claude-wrapped`
descendant during some startup samples. Thus that opt-out alone **does not
eliminate** all Claude processes during daemon initialization; other
startup/provider checks must be examined before promising memory savings.
These samples also showed variable idle RSS, so no reliable improvement can
be inferred. Raw data: [vps-stage2-kernel-off.json](vps-stage2-kernel-off.json).

A separate single paired run (2/2 successes) exercised
`BENCH_TRANSCRIPTS_ENABLED=0` with UI off and V8 heap 128 MiB.
Both builds accepted the setting and returned all expected HTTP statuses;
one pair is **not** a reliable performance comparison. Raw data:
[vps-stage2-transcripts-off.json](vps-stage2-transcripts-off.json).

## Validation and compatibility evidence

- Independent, focused EventBus/SSE comparison: feature **58/58 passed**,
  baseline **54/54 passed** (four added regression cases). A stalled SSE reader
  under overflow was previously reproduced with `stream.close()`, then fixed
  with `stream.abort()`; the regression now asserts subscriber cleanup.
  Event sequence, nested events, durable replay and client reconnection
  remain covered by the focused tests.
- Independent Slack/plugin/gateway, CLI, UI and provider-adapter test groups:
  **507 tests passed, 1 skipped**. This includes an actual disposable
  CLI/daemon/SQLite/tmux dogfooding workflow with **two stub rigs**, stopping
  and restoring one without disrupting the other. Slack HTTP 429/retry,
  disabled/enabled gateway, socket failure/reconnect and plugin discovery
  used local fixtures, not a real Slack account or authenticated provider.
- Daemon, UI, CLI and TUI TypeScript typechecks passed. The additional
  `npm run lint` on 2026-11-06 exited **0**. Separately,
  `npm run test:ui` passed **1,805 tests**, 1 skipped, across **204 files**
  when invoked from the correct UI workspace.
- The broad `npm test` run exited **1**: the CLI Vitest summary was
  **6,261 passed, 3 failed, 7 skipped**, while the TUI suite was
  **1,202/1,202 passed**. Independent A/B investigation attributed two CLI
  failures to an unsupported `fs.chownSync` fixture on local Btrfs
  (`EINVAL` for gid `nogroup`, reproduced on baseline and feature).
  The third front-door PTY test embeds shell `$?` but the host uses Fish;
  it passed with `SHELL=/bin/bash`. After building the baseline CLI, the
  **same PTY test also failed with Fish and passed with Bash** in the baseline,
  proving runtime parity for this case. The test fixture needs a portable
  shell or environment gate. **Do not report the full suite as green** or
  quietly change production code to mask environmental failures.
- Separate parity checks found `umask 0077` versus expected executable
  `0755` fixture modes; `umask 022` passed the affected 21 tests. Three
  `codex-rebuild-permissions` assertions rely on UTC versus local `ps lstart`
  conversion; `TZ=UTC` passed 20/20. `lsof` is absent; DB-owner confirmation
  must be marked unknown rather than assumed safe.
- `package-lock.json` is byte-identical across baseline/feature; `npm ls
  --all` reported no unsatisfied dependencies. An online
  `npm audit --omit=dev` identified **16 flagged dependency packages**
  (2 critical, 9 high, 4 moderate, 1 low), inherited from the original lockfile,
  including `tar`, `seroval`, `hono`, `ws` and `zod`.
  This is an **unresolved inherited security exposure**, not evidence
  that every advisory is exploitable; dependency hardening needs a separate
  scoped review and upgrades.

## Unverified requirements and acceptance gates

1. **Real constrained VPS:** capture authorized host RAM/swap, daemon and
   provider-seat `VmRSS`, service/cgroup `memory.max/current/peak`, OOM
   events, sustained CPU, concurrent agent count and restart behavior under
   comparable workloads before asserting a production RAM budget or savings.
   No authorized VPS host was available in this validation.
2. **Real provider and Slack:** live Claude/Codex/Pi authentication, actual
   agent execution, Slack workspace scopes, delivery and reconnection remain
   untested; fixtures cannot establish remote service behavior.
3. **Actual isolated Chromium rendering:** an independent worker used one
   disposable feature daemon and **one real Chromium 154 headless/CDP session**.
   It rendered the desktop dashboard at 1440 × 900 and the mobile dashboard at
   390 × 664, both with scroll width equal to viewport width. It clicked
   dashboard → `/specs`, navigated to `/specs/plugins` (1 vendored plugin,
   19 skills), `/agents` (honest empty state), `/for-you` (all caught up),
   and a nonexistent plugin (explicit not-found state). Screenshots and a
   result JSON were actually generated in a private temporary directory;
   they are **not** published or attached to this report. One later CDP
   navigation to mobile `/specs/plugins` timed out; no root cause was
   established, so that specific view remains **unverified**, not a proven
   regression. Browser logs included blocked Google Fonts requests and
   uncategorized 404s. The built UI references Google's Material Symbols
   stylesheet, so offline rendering uses its fallback and should be reviewed.
   The worker shut down the browser and daemon and did not access user profiles.
   Separate UI unit tests still have cwd-relative paths and a dashboard
   QueryClientProvider fixture gap that should be improved.
4. **Startup network:** `PluginVendorService.ensureLatest` attempts GitHub
   access on daemon startup even though v0 discards a successful fetch and
   uses vendored assets. This was observed in isolated integration tests,
   is not introduced by this branch and warrants separately scoped
   lazy/opt-in vendor-update review before production adoption.
5. **Stage 3:** perform independent security/compatibility hardening, validate
   dependency advisories and rerun relevant gates. The 256-event SSE limit
   and 256-row notification page bound **counts**, not total payload bytes;
   very large individual events require separate stress/size-bound review
   before treating the controls as a hard memory ceiling. **Do not merge**
   PR #1 without explicit authorization and the deployment-specific acceptance.

Reproduce safely with:

```sh
BENCH_EVENT_HEAP_MB=256 BENCH_EVENT_REPEATS=3 node scripts/bench-event-matrix.mjs
BENCH_REPEATS=3 BENCH_HEAPS=256 BENCH_UI_STATES=0 \
  BENCH_IDLE_MS=8000 BENCH_REQUESTS=60 \
  BENCH_MATRIX_OUTPUT=docs/reference/vps-stage2-controlled-idle.json \
  node scripts/bench-vps-matrix.mjs
BENCH_REPEATS=3 BENCH_HEAPS=128,192,256 BENCH_UI_STATES=0,1 \
  BENCH_IDLE_MS=3000 BENCH_REQUESTS=120 BENCH_CONCURRENCY=8 \
  BENCH_MATRIX_OUTPUT=docs/reference/vps-stage2-final-controlled-matrix.json \
  node scripts/bench-vps-matrix.mjs
BENCH_REPEATS=4 BENCH_HEAPS=128,256 BENCH_UI_STATES=1 \
  BENCH_IDLE_MS=3500 BENCH_REQUESTS=120 BENCH_CONCURRENCY=8 \
  BENCH_MATRIX_OUTPUT=docs/reference/vps-stage2-tree-diagnostic.json \
  node scripts/bench-vps-matrix.mjs
npm run lint
npm run test:ui
```

All benchmark harnesses write only local measurements; they are not a
deployment procedure. Use an authorized, monitored, separate environment to
validate real low-memory cgroups and active agent processes.
