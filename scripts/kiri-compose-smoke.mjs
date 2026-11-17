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
  '    command: ["sh", "-c", "sleep 90"]',
  "",
].join("\n"));

const exec = async command => (await execFile("/bin/sh", ["-lc", command], { maxBuffer: 1024 * 1024 })).stdout;
const adapter = new ComposeServicesAdapter(exec);
let upAttempted = false;
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

  const logs = await adapter.logs({ composeFile, projectName, dockerContext: context, tail: 5 });
  if (!logs.ok) throw new Error(`OpenRig Compose logs failed: ${logs.error}`);
  console.log(JSON.stringify({ runtime: "Kiri", context, composeAvailable: true, service: status.services[0], logsRead: true }));
} finally {
  if (upAttempted) {
    const down = await adapter.down({ composeFile, projectName, dockerContext: context, policy: "down" });
    if (!down.ok) throw new Error(`OpenRig Compose down failed: ${down.message}`);
  }
  unlinkSync(composeFile);
}
