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
must name their own context if they invoke Docker. Example:

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

Not measured yet: idle/peak memory for a representative Compose stack. The
same-VM Docker/Kiri comparison is still needed before recommending Kiri for the
VPS workload; VM memory overhead is excluded from runtime-process RSS and must
be reported separately from guest-visible memory.
