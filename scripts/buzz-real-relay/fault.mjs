// Fault injection at the CLI boundary: simulated HTTP faults, NOT a Buzz relay.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const channel = "486cc276-e45a-49be-9b24-12a14b492452";

async function simulate(cli, secret, scenario) {
  const server = createServer((req, res) => {
    if (scenario === "disconnect") {
      req.socket.destroy();
    } else if (scenario === "stall") {
      // Keep socket open until the CLI's own request timeout fires.
    } else {
      const code = scenario === "429" ? 429 : 503;
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "fault-injection", message: "rate-limited: simulation" }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const env = {
    ...process.env,
    BUZZ_PRIVATE_KEY: secret,
    BUZZ_RELAY_URL: `http://127.0.0.1:${addr.port}`,
    BUZZ_CONNECT_TIMEOUT_SECS: "1",
    BUZZ_TIMEOUT_SECS: "1",
  };
  for (const key of ["BUZZ_AUTH_TAG", "BUZZ_FEDERATED_IDENTITY_TOKEN", "BUZZ_FEDERATED_IDENTITY_ADAPTER"]) delete env[key];

  let child;
  try {
    const result = await new Promise((resolve, reject) => {
      child = spawn(cli, ["messages", "get", "--channel", channel], {
        env,
        stdio: ["ignore", "ignore", "pipe"],
        shell: false,
      });
      let stderr = "";
      let killedByHarness = false;
      const timer = setTimeout(() => { killedByHarness = true; child.kill("SIGKILL"); }, 20_000);
      child.stderr.on("data", (buf) => {
        if (stderr.length < 32_768) stderr += buf.toString("utf8").slice(0, 32_768 - stderr.length);
      });
      child.once("error", reject);
      child.once("close", (status) => {
        clearTimeout(timer);
        let category = "unclassified";
        try { category = JSON.parse(stderr)?.error || category; } catch {}
        resolve({ status, category, killedByHarness });
      });
    });
    assert.equal(result.killedByHarness, false, `Buzz CLI exceeded timeout for ${scenario}`);
    assert.notEqual(result.status, 0, `Buzz CLI incorrectly accepted ${scenario} fault`);
    console.log(`PASS: injected ${scenario} boundary failure (CLI error category=${result.category}).`);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function runCliFaultSmoke({ cli, secret }) {
  for (const scenario of ["429", "503", "stall", "disconnect"]) {
    await simulate(cli, secret, scenario);
  }
}
