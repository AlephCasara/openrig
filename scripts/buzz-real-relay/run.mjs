#!/usr/bin/env node
// Disposable real-relay integration lab. Never starts OpenRig or Buzz Desktop.
import { createECDH, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const home = dirname(fileURLToPath(import.meta.url));
const composeFile = resolve(home, "compose.yml");
const project = "openrig-buzz-lab-" + randomBytes(5).toString("hex");
const cli = process.env.BUZZ_CLI_BIN;

if (!cli?.startsWith("/")) {
  console.error("Set BUZZ_CLI_BIN to the absolute path of the upstream Buzz CLI.");
  process.exit(2);
}

function nostrIdentity() {
  for (;;) {
    const key = randomBytes(32);
    try {
      const ecdh = createECDH("secp256k1");
      ecdh.setPrivateKey(key);
      return {
        secret: key.toString("hex"),
        pubkey: ecdh.getPublicKey(undefined, "uncompressed").subarray(1, 33).toString("hex"),
      };
    } catch {}
  }
}

async function choosePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const owner = nostrIdentity();
const guest = nostrIdentity();
const outsider = nostrIdentity();
const port = await choosePort();
const dbPass = randomBytes(16).toString("hex");
const s3Pass = randomBytes(16).toString("hex");
const env = {
  ...process.env,
  LAB_DATABASE_PASSWORD: dbPass,
  LAB_S3_USER: "lab" + randomBytes(4).toString("hex"),
  LAB_S3_PASSWORD: s3Pass,
  LAB_HTTP_PORT: String(port),
  LAB_RELAY_KEY: nostrIdentity().secret,
  LAB_OWNER_PUBKEY: owner.pubkey,
  LAB_REQUIRE_RELAY_MEMBERSHIP: process.env.LAB_REQUIRE_RELAY_MEMBERSHIP ?? "true",
  BUZZ_PRIVATE_KEY: owner.secret,
  BUZZ_RELAY_URL: `http://127.0.0.1:${port}`,
  BUZZ_CONNECT_TIMEOUT_SECS: "2",
  BUZZ_TIMEOUT_SECS: "5",
};
for (const name of ["BUZZ_AUTH_TAG", "BUZZ_FEDERATED_IDENTITY_TOKEN", "BUZZ_FEDERATED_IDENTITY_ADAPTER"]) delete env[name];
const prefix = ["compose", "-p", project, "-f", composeFile];
let child;
let interrupted = false;
process.once("SIGINT", () => { interrupted = true; child?.kill("SIGTERM"); });
process.once("SIGTERM", () => { interrupted = true; child?.kill("SIGTERM"); });

function docker(args, { quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    child = spawn("docker", [...prefix, ...args], {
      env,
      stdio: quiet ? ["ignore", "ignore", "ignore"] : "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      child = undefined;
      if (code === 0) resolve();
      else reject(new Error(`Docker Compose ${args[0]} failed (exit=${code}, signal=${signal}).`));
    });
  });
}

async function waitForRelay() {
  const url = env.BUZZ_RELAY_URL + "/_liveness";
  for (let i = 0; i < 70; i++) {
    if (interrupted) throw new Error("Interrupted");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Buzz relay did not report liveness within bounded startup window.");
}

async function main() {
  console.log("Starting disposable, resource-capped Buzz relay on 127.0.0.1 (no rig, no shared ports).");
  try {
    await docker(["config", "--quiet"], { quiet: true });
    await docker(["up", "-d", "--wait", "--wait-timeout", "120"]);
    await waitForRelay();
    const { runRealRelaySmoke } = await import("./check.mjs");
    await runRealRelaySmoke({
      cli,
      baseUrl: env.BUZZ_RELAY_URL,
      owner,
      guest,
      outsider,
      relayMembershipRequired: env.LAB_REQUIRE_RELAY_MEMBERSHIP === "true",
    });
    console.log("PASS: real upstream Buzz relay integration smoke.");
    const { runCliFaultSmoke } = await import("./fault.mjs");
    await runCliFaultSmoke({ cli, secret: owner.secret });
    console.log("PASS: bounded error handling against four synthetic network fault modes.");
  } finally {
    console.log("Cleaning up isolated Buzz lab containers and volumes.");
    try { await docker(["down", "-v", "--remove-orphans"], { quiet: true }); }
    catch { console.error("Cleanup failed; inspect only the Compose project:", project); }
  }
}

main().catch((error) => {
  console.error("FAIL:", error instanceof Error ? error.message : "unknown failure");
  process.exitCode = 1;
});
