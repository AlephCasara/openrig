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

Not measured here: this workspace's Docker client cannot access its configured
socket, and the production VPS is explicitly out of scope. The results table
must be filled from a disposable, authorized Linux host before this evaluation
can make a recommendation.
