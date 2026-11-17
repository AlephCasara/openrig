# Kiri runtime evaluation (draft)

This is an evaluation plan for issue #70. It does not change OpenRig's container
backend. Docker remains the only supported/default backend until a comparison
on a disposable Linux host shows that Kiri is useful for the workloads OpenRig
actually runs.

## What the upstream project claims

Kiri describes itself as a Docker Engine API implementation. Its README reports
about 15 MB idle daemon memory and Linux operation directly on the host kernel
(without dockerd, runc or a shim). Those are upstream measurements, not
measurements of OpenRig's workload. The VM sleep claim applies to its VM-based
platforms; it should not be used to infer Linux VPS memory use. See the [Kiri
README](https://github.com/libracoder/kiri#readme) and its
[`bench/results.json`](https://github.com/libracoder/kiri/blob/main/bench/results.json).
The [feature and known-issues list](https://github.com/libracoder/kiri/blob/main/docs/features.md)
covers Linux socket permissions and the BuildKit `host-gateway` limitation.

## Safety boundary

- Run on a disposable Linux machine with enough RAM and disk for the test
  images. Do not point this evaluation at a production host or its Docker
  context.
- Record the host OS/kernel, CPU, RAM, swap, Docker/Kiri versions, cgroup mode,
  and whether either runtime is rootless. Keep those properties fixed between
  runs.
- Use a fresh, uniquely named Compose project and fresh volumes for each run.
  Do not import, migrate, or delete existing Docker/Kiri data.
- Stop if Kiri requires privileges or changes host services in a way the
  operator has not explicitly approved. Record the socket owner and access
  model; do not weaken socket permissions to make the test pass.
- Capture the active Docker context before and after each run. Restore the
  original context explicitly. Do not change OpenRig's context or daemon
  configuration as part of this evaluation.

## Comparison protocol

Run the same experiment on the same host, first against Docker and then Kiri,
with no other workloads running. Repeat each phase three times and report the
median and range. Pin image tags (and preferably digests) before comparing.

1. **Idle baseline:** after each runtime has settled for five minutes, record
   the runtime's resident memory, host `MemAvailable`, and swap usage. For Kiri,
   report every process it starts, not just the UI/CLI process. For Docker,
   report dockerd and any containerd/shim processes.
2. **OpenRig-like stack:** start PostgreSQL, Redis and an S3-compatible service
   (MinIO) with the same pinned images, resource limits and health checks under
   each runtime. Record startup time, readiness time, per-container RSS, total
   runtime process RSS, host `MemAvailable`, and swap at 0, 1, 5 and 15 minutes.
3. **Restart and teardown:** restart the stack once, verify persistent data
   within that run, then stop and remove only the uniquely named test project
   and its volumes. Record time and any orphaned processes/resources.
4. **Compatibility:** exercise the Compose features OpenRig uses (health
   checks, project labels, `compose ps --format json`, `logs`, `exec`, stop and
   remove). Separately check the known BuildKit `docker-container` builder
   `host-gateway` limitation; do not count that as a core stack failure unless
   the selected OpenRig workflow uses it.
5. **Recovery:** demonstrate returning to the original Docker context with one
   command and confirm existing Docker containers and volumes remain intact.

The primary result is the change in host memory available at idle and at peak
for the whole stack. Runtime-process RSS alone is insufficient: on a VM-backed
platform it can omit guest memory, and in either runtime the workload containers
may dominate total use. Report absolute values as well as percentage changes.

## Decision gate

Do not add a runtime selector based on startup latency or Kiri's published
numbers alone. A follow-up implementation proposal needs the measured results,
an explicit answer about root/rootless operation and socket ownership, passing
Compose checks, and a tested one-command way back. If the VPS-like Linux result
does not reduce total host memory or introduces unacceptable operational
constraints, close the evaluation without adding Kiri support.

## Current status

### OpenRig integration prototype

OpenRig now accepts a per-rig `services.docker_context` and prefixes each
managed Compose lifecycle call with `docker --context <name>`. The default is
unchanged, and OpenRig never switches the user's global Docker context. The
setting covers service preflight, start, status, logs, teardown and project
container lookup. Checkpoint hooks remain user-authored shell commands and
must name their own context if they invoke Docker. Compose project names are
scoped to their Docker context during rig replacement and teardown, so equal
names on separate engines do not cause OpenRig to preserve or remove the wrong
stack. Example:

```yaml
services:
  kind: compose
  compose_file: compose.yaml
  docker_context: kiri
```

This is a selector prototype; it does not install, start or configure Kiri.

### Local engine check (NixOS x86_64)

The official `kiri-lite` 0.2.1 RPM was downloaded and its SHA-256 matched the
digest published by the Kiri GitHub release. The RPM payload was extracted into
`/tmp` without installing system files. Running `kiri daemon` as the current
user worked and exposed the Engine API on a private socket. A temporary Docker
context reached it and `docker info` reported `OS=Kiri`. Creating a container
failed with Kiri's message that Linux host containers need root (`sudo kiri
daemon`). Retrying in an unprivileged user namespace reached the daemon but
container creation still failed with `Permission denied`. No container was
created, no system service or global Docker socket was changed, and the
temporary context was removed.

Kiri documents Linux packages as tested on Ubuntu and Fedora, not NixOS. The
local check proves API reachability on this machine but not a working service
stack. OpenRig's actual `ComposeServicesAdapter` was also run against that
temporary context: its context-specific Compose preflight succeeded and its
status call returned `ok: true` with no containers. Running containers directly
on the host was refused because Kiri requires root. No system service or global
Docker socket was changed. Kiri's Linux group membership is root-equivalent,
so the test moved into a disposable local VM instead of changing host
privileges.

### OpenRig Compose smoke in a local KVM guest

A Debian 12 VM was created under local KVM with 3 GiB RAM and 2 vCPUs. Kiri
0.2.1 ran as its root-managed system service. Its Docker API was forwarded from
the guest to a host-only port bound to `127.0.0.1`; OpenRig used a temporary
Docker context pointed at that forwarded endpoint. Through the actual
`ComposeServicesAdapter`, OpenRig successfully:

- checked Compose availability;
- brought up an Alpine service with a unique Compose project;
- read status and confirmed the service was running;
- read service logs; and
- brought the project down.

The Compose project was removed and the temporary Docker context was deleted.
The KVM guest is stopped between runs. This proves the Kiri selector and
OpenRig's managed Compose lifecycle against a real Kiri engine without granting
the host daemon root or touching the production VPS. The repeatable
[`kiri-compose-smoke.mjs`](../../scripts/kiri-compose-smoke.mjs) script accepts
the name of a preconfigured context through `KIRI_DOCKER_CONTEXT`.

### Same-VM memory and compatibility comparison

Three five-minute runs per engine were collected in the same disposable Debian
12 KVM guest (1 GiB RAM, 2 vCPUs, no swap). The guest had Docker 20.10.24 and
Kiri 0.2.1 installed; only one engine was active during a run. Kiri's Linux
service ran as root. Every run used the same PostgreSQL 16.4, Redis 7.4 and
SeaweedFS 3.80 images, with identical 192 MiB, 64 MiB and 256 MiB limits. The
image digests were checked and matched between the two engines. The PostgreSQL
and Redis health checks passed, and SeaweedFS answered its cluster status API.

| Five-minute guest `MemAvailable` | Docker | Kiri |
| --- | ---: | ---: |
| Run 1 | 563.0 MiB | 666.1 MiB |
| Run 2 | 551.9 MiB | 675.7 MiB |
| Run 3 | 558.5 MiB | 674.7 MiB |
| Median (range) | **558.5 MiB** (552–563) | **674.7 MiB** (666–676) |

Kiri left a median **116 MiB more guest memory available** after five minutes.
The measured runtime-plus-workload process RSS was about 312 MiB for Docker and
118 MiB for Kiri at the median (about 62% lower with Kiri). Workload process RSS
itself was similar: about 109 MiB for Docker and 108 MiB for Kiri. The engine
process set was about 203 MiB for Docker (`dockerd`, `containerd` and three
shims) and 10 MiB for Kiri (`kiri`, with no shims). This points to the engine
and shim processes as the source of the available-memory difference.

One paired run was kept up for fifteen minutes. At that point Docker had
537.5 MiB available and Kiri had 661.4 MiB, a 124 MiB difference. The fifteen-
minute point was collected once per engine; the repeated median/range above is
for the five-minute point. These are guest measurements; the QEMU host process
and the rest of the workstation are outside guest `MemAvailable`. They are a
repeatable result for this Linux workload, not a measurement of the production
VPS.

Process RSS was read from the guest's `/proc`, summing the runtime processes
and the SeaweedFS, PostgreSQL and Redis processes; common guest services and
the test-only socket forwarder were excluded. This avoids comparing the two
engines' differently reported cgroup totals. The protocol called for MinIO,
but its public Docker Hub and Quay images were not pullable, so SeaweedFS 3.80
was used as the S3-compatible service. This is not a MinIO result.

The OpenRig adapter smoke in
[`kiri-compose-smoke.mjs`](../../scripts/kiri-compose-smoke.mjs) passed against
the Kiri context. It exercised Compose preflight, health checks, project
labels, `ps --format json`, `exec`, logs, stop/start, restart, status and
teardown. It verified that no project container remained. A PostgreSQL row
survived `compose restart` under both engines; each unique project and its
volumes were removed.

The BuildKit caveat was reproduced with buildx 0.35.0: a `docker-container`
builder booted, but a build using `--add-host host.docker.internal=host-gateway`
failed with “host-gateway is not supported by the docker-container driver.”
The same Dockerfile succeeded through `DOCKER_BUILDKIT=0 docker build`, where
Kiri's own builder mapped the host gateway. OpenRig has no `host-gateway` or
buildx call sites, so this limitation does not affect its current Compose
service lifecycle; user-authored builds that use the docker-container builder
need the documented workaround.

Kiri 0.2.1 was released on 15 November 2026; the repository was created on
2 November ([release](https://github.com/libracoder/kiri/releases/tag/v0.2.1)).
Its Linux package runs a root-managed engine, and its `kiri` socket group is
root-equivalent. The release asset digest was verified. OpenRig neither
installs nor updates Kiri: the operator owns package updates and the context.
This is a young project, so the results support an explicit experimental
per-rig option, not making Kiri the default or recommending it for the
production VPS without a separate host-specific run.
