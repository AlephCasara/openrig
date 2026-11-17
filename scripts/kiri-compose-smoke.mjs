#!/usr/bin/env node
// End-to-end smoke for OpenRig's per-rig Docker context against a local Kiri engine.
// Start Kiri yourself, create a Docker context for its socket, then set
// KIRI_DOCKER_CONTEXT to that context name before running this script.
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { ComposeServicesAdapter } from "../packages/daemon/src/adapters/compose-services-adapter.ts";

const execFile = promisify(execFileCallback);
const context = process.env.KIRI_DOCKER_CONTEXT;
if (!context || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(context)) {
  throw new Error("Set KIRI_DOCKER_CONTEXT to the name of a configured Kiri Docker context.");
}

const { stdout: operatingSystem } = await execFile("docker", ["--context", context, "info", "--format", "{{.OperatingSystem}}"]);
if (operatingSystem.trim() !== "Kiri") {
  throw new Error(`Docker context ${context} reports ${JSON.stringify(operatingSystem.trim())}, expected Kiri.`);
}

const runId = randomUUID().replaceAll("-", "").slice(0, 12);
const projectName = `openrig-kiri-${runId}`;
const composeFile = join(tmpdir(), `${projectName}.compose.yaml`);
writeFileSync(composeFile, [
  "services:",
  "  smoke:",
  "    image: alpine:3.20",
  '    command: ["sh", "-c", "echo KIRI_SMOKE_READY; touch /tmp/kiri-ready; sleep 180"]',
  "    healthcheck:",
  '      test: ["CMD", "sh", "-c", "test -f /tmp/kiri-ready"]',
  "      interval: 2s",
  "      timeout: 1s",
  "      retries: 10",
  "",
].join("\n"));

const exec = async command => (await execFile("/bin/sh", ["-lc", command], { maxBuffer: 1024 * 1024 })).stdout;
const adapter = new ComposeServicesAdapter(exec);
let upAttempted = false;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const available = await adapter.composeAvailable(context);
  if (!available.ok) throw new Error(available.message);

  upAttempted = true;
  const up = await adapter.up({ composeFile, projectName, dockerContext: context });
  if (!up.ok) throw new Error(`OpenRig Compose up failed: ${up.message}`);

  const status = await adapter.status({ composeFile, projectName, dockerContext: context });
  if (!status.ok || !status.services.some(service => service.name === "smoke" && service.state === "running")) {
    throw new Error(`OpenRig Compose status did not find the running smoke service: ${JSON.stringify(status)}`);
  }

  const containerId = await execFile("docker", ["--context", context, "ps", "-q", "--filter", `label=com.docker.compose.project=${projectName}`]);
  if (!containerId.stdout.trim()) throw new Error("Kiri did not preserve the Compose project label");
  let health = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await execFile("docker", ["--context", context, "inspect", "--format", "{{.State.Health.Status}}", containerId.stdout.trim()]);
    health = result.stdout.trim();
    if (health === "healthy") break;
    await wait(500);
  }
  assert.equal(health, "healthy", `Compose health check ended in ${health || "no health state"}`);

  const execResult = await execFile("docker", [
    "--context", context, "compose", "-f", composeFile, "-p", projectName,
    "exec", "-T", "smoke", "sh", "-c", "printf KIRI_EXEC_OK",
  ]);
  assert.match(execResult.stdout, /KIRI_EXEC_OK/);

  const logs = await adapter.logs({ composeFile, projectName, dockerContext: context, tail: 5 });
  if (!logs.ok) throw new Error(`OpenRig Compose logs failed: ${logs.error}`);
  assert.match(logs.output, /KIRI_SMOKE_READY/);

  await execFile("docker", ["--context", context, "compose", "-f", composeFile, "-p", projectName, "stop", "smoke"]);
  const stoppedState = await execFile("docker", ["--context", context, "inspect", "--format", "{{.State.Status}}", containerId.stdout.trim()]);
  assert.equal(stoppedState.stdout.trim(), "exited", `Compose stop left the service in ${stoppedState.stdout.trim()}`);
  await execFile("docker", ["--context", context, "compose", "-f", composeFile, "-p", projectName, "start", "smoke"]);

  await execFile("docker", ["--context", context, "compose", "-f", composeFile, "-p", projectName, "restart", "smoke"]);
  let restartedHealth = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await execFile("docker", ["--context", context, "inspect", "--format", "{{.State.Health.Status}}", containerId.stdout.trim()]);
    restartedHealth = result.stdout.trim();
    if (restartedHealth === "healthy") break;
    await wait(500);
  }
  const restartedStatus = await adapter.status({ composeFile, projectName, dockerContext: context });
  assert.ok(restartedStatus.ok && restartedStatus.services.some(service => service.name === "smoke" && service.state === "running"));
  assert.equal(restartedHealth, "healthy", `Restarted Compose health check ended in ${restartedHealth || "no health state"}`);
  console.log(JSON.stringify({ runtime: "Kiri", context, composeAvailable: true, service: restartedStatus.services.find(service => service.name === "smoke"), health: restartedHealth, exec: true, logs: true, restart: true }));
} finally {
  try {
    if (upAttempted) {
      const down = await adapter.down({ composeFile, projectName, dockerContext: context, policy: "down" });
      if (!down.ok) throw new Error(`OpenRig Compose down failed: ${down.message}`);
      const remaining = await adapter.projectContainers(projectName, context);
      assert.deepEqual(remaining, [], `Kiri left project containers after Compose down: ${remaining?.join(", ") ?? "unreadable"}`);
    }
  } finally {
    unlinkSync(composeFile);
  }
}
