// Opt-in real Buzz CLI ↔ loopback relay protocol smoke test.
// No OpenRig daemon, public relay, Buzz desktop or credentials are required.
// Run: BUZZ_CLI_BIN=/absolute/path/to/buzz node --import tsx scripts/buzz-cli-loopback-smoke.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { BuzzCliClient } from "../packages/daemon/src/domain/gateway/buzz-cli.ts";

const binary = process.env.BUZZ_CLI_BIN;
if (!binary?.startsWith("/")) {
  process.stderr.write("BUZZ_CLI_BIN must be an absolute path to the Buzz CLI.\n");
  process.exit(2);
}

const channelId = "a69eea2f-f57c-425d-9e9e-d79970f3a248";
const events = [];
const paths = [];
let protocolProblem;

const server = createServer(async (req, res) => {
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 128 * 1024) throw new Error("oversized request");
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    paths.push(req.url);
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/events") {
      assert.equal(body.kind, 9);
      assert.equal(typeof body.pubkey, "string");
      assert.match(body.pubkey, /^[0-9a-f]{64}$/);
      assert.match(body.id, /^[0-9a-f]{64}$/);
      assert.match(body.sig, /^[0-9a-f]{128}$/);
      assert.ok(["buzz-cli-loopback-smoke", "buzz-cli-loopback-reply"].includes(body.content));
      assert.ok(body.tags.some((tag) => tag[0] === "h" && tag[1] === channelId));
      events.push(body);
      res.end(JSON.stringify({ accepted: true, event_id: body.id, message: "accepted" }));
    } else if (req.method === "POST" && req.url === "/query") {
      assert.ok(Array.isArray(body));
      assert.ok(body.some((filter) => filter["#h"]?.includes(channelId) || Array.isArray(filter.ids)));
      const selected = events.filter((event) => body.some((filter) =>
        filter["#h"]?.includes(channelId) || filter.ids?.includes(event.id)));
      res.end(JSON.stringify(selected));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "unsupported endpoint" }));
    }
  } catch (error) {
    protocolProblem = error;
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "invalid test request" }));
  }
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  // The key exists only in this smoke-test process and its CLI child.
  // Override any operator configuration to guarantee exclusive loopback use.
  process.env.BUZZ_PRIVATE_KEY = randomBytes(32).toString("hex");
  process.env.BUZZ_RELAY_URL = `http://127.0.0.1:${address.port}`;
  delete process.env.BUZZ_AUTH_TAG;
  delete process.env.BUZZ_FEDERATED_IDENTITY_TOKEN;
  delete process.env.BUZZ_FEDERATED_IDENTITY_ADAPTER;
  process.env.BUZZ_TIMEOUT_SECS = "5";
  process.env.BUZZ_CONNECT_TIMEOUT_SECS = "2";

  const client = new BuzzCliClient({ binary, timeoutMs: 10_000 });
  const post = await client.sendMessage({
    channelId,
    content: "buzz-cli-loopback-smoke",
  });
  const reply = await client.sendMessage({
    channelId,
    content: "buzz-cli-loopback-reply",
    replyTo: post.eventId,
  });
  const messages = await client.getMessages({
    channelId,
    since: 0,
    limit: 10,
  });
  if (protocolProblem) throw protocolProblem;
  assert.equal(events.length, 2);
  assert.equal(messages.length, 2);
  assert.equal(messages.find((message) => message.id === post.eventId)?.content, "buzz-cli-loopback-smoke");
  assert.equal(messages.find((message) => message.id === reply.eventId)?.replyTo, post.eventId);
  assert.deepEqual(paths, ["/events", "/query", "/events", "/query"]);
  process.stdout.write("PASS: real Buzz CLI -> signed Nostr message + thread reply -> loopback relay -> OpenRig adapter read (no daemon).\n");
} finally {
  delete process.env.BUZZ_PRIVATE_KEY;
  await new Promise((resolve) => server.close(resolve));
}
