# Materializing a new pod without launching its seats

`rig expand <rig-id> <pod-fragment.yaml> --no-launch` persists the new pod, nodes and edges through the same validated topology materialization as regular `rig expand`, but it does **not** invoke the occupant launcher. The response marks each node `materialized`, has no retry targets, and includes a normal `rig.expanded` event recording the topology change. Later seat launch remains an explicit operator action after workspace files, policy and runtime readiness are verified.

Without `--no-launch`, `rig expand` preserves the existing behavior and launches the new pod members. For scripted consumers, `--json` includes node statuses (`materialized` versus `launched` or `failed`). This option does not create additional members inside an existing pod: the daemon already supports the separate `add_member` converge operation for that topology, and its CLI/no-launch integration remains to be completed and validated.

The no-launch path has unit coverage with an isolated in-memory rig repository and a spy proving `launchValidatedSpec` is not called, plus a CLI mock that checks the `noLaunch: true` request flag without opening any network listener. No real seat, daemon or tmux was started in those tests.
