// Optional Buzz GatewayWire -> real Buzz CLI -> authenticated localhost relay proof.
// Run: BUZZ_CLI_BIN=/absolute/path/to/buzz node --import tsx scripts/buzz-gateway-loopback-smoke.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPublicKey, generateSecretKey, verifyEvent } from "nostr-tools/pure";
import { buildBuzzGatewayWire } from "../packages/daemon/src/domain/gateway/buzz/buzz-gateway.ts";
import { BuzzCliClient } from "../packages/daemon/src/domain/gateway/buzz-cli.ts";
import { addHumanFragment } from "../packages/daemon/src/domain/gateway/human-registry.ts";

const binary = process.env.BUZZ_CLI_BIN;
if (!binary?.startsWith("/")) {
  process.stderr.write("BUZZ_CLI_BIN must be an absolute path to the Buzz CLI.\n");
  process.exit(2);
}

const channelId = "a69eea2f-f57c-425d-9e9e-d79970f3a248";
const ownerSecret = generateSecretKey();
const guestSecret = generateSecretKey();
const ownerPubkey = getPublicKey(ownerSecret);
const guestPubkey = getPublicKey(guestSecret);
const ownerHex = Buffer.from(ownerSecret).toString("hex");
const guestHex = Buffer.from(guestSecret).toString("hex");
const human = "loopback-human@external";
const seat = "loopback-agent@rig";
const events = [];
const paths = [];
let strongHistoryQueries = 0;
const home = mkdtempSync(join(tmpdir(), "openrig-buzz-wire-smoke-"));
const rows = new Map([["qitem-loopback-root", {
  qitemId: "qitem-loopback-root", sourceSession: seat, destinationSession: human,
  body: "Buzz GatewayWire loopback question", humanIntent: "ask", state: "pending",
}]]);
let protocolProblem;
let wire;

const server = createServer(async (req, res) => {
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 128 * 1024) throw new Error("oversized request");
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = JSON.parse(rawBody);
    paths.push(req.url);
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/events") {
      assert.equal(body.kind, 9);
      assert.equal(typeof body.pubkey, "string");
      assert.match(body.id, /^[0-9a-f]{64}$/);
      assert.match(body.sig, /^[0-9a-f]{128}$/);
      assert.ok(verifyEvent(body));
      assert.ok(body.tags.some((tag) => tag[0] === "h" && tag[1] === channelId));
      events.push(body);
      res.end(JSON.stringify({ accepted: true, event_id: body.id, message: "accepted" }));
    } else if (req.method === "POST" && req.url === "/query") {
      const authorization = req.headers.authorization ?? "";
      assert.ok(authorization.startsWith("Nostr "));
      const proof = JSON.parse(Buffer.from(authorization.slice(6), "base64").toString("utf8"));
      assert.ok(verifyEvent(proof));
      assert.equal(proof.kind, 27235);
      assert.ok(proof.tags.some((tag) => tag[0] === "u" && tag[1] === `http://127.0.0.1:${server.address().port}/query`));
      assert.ok(proof.tags.some((tag) => tag[0] === "method" && tag[1] === "POST"));
      assert.ok(proof.tags.some((tag) => tag[0] === "payload"
        && tag[1] === createHash("sha256").update(rawBody).digest("hex")));
      const filter = body[0];
      assert.ok(body.some((item) => item["#h"]?.includes(channelId) || Array.isArray(item.ids)));
      if (filter.consistency !== undefined) {
        assert.equal(filter.consistency, "strong");
        strongHistoryQueries++;
      }
      let selected = events.filter((event) => event.tags.some((tag) => tag[0] === "h" && tag[1] === channelId));
      if (filter.until !== undefined) selected = selected.filter((event) =>
        event.created_at < filter.until || (event.created_at === filter.until && event.id > filter.before_id));
      selected.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
      res.end(JSON.stringify(selected.slice(0, filter.limit)));
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
  const registration = addHumanFragment({
    entityId: "loopback-human", class: "human", displayName: "Loopback Human", address: human,
    connectorBindings: [{ kind: "buzz", connectorRef: channelId, secretsRef: "env:BUZZ_PRIVATE_KEY", role: "primary", handle: guestPubkey }],
    prefs: { deliveryClass: "B" },
  }, home);
  assert.equal(registration.ok, true);
  if (!registration.ok) throw new Error(registration.error);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const relayUrl = `http://127.0.0.1:${address.port}`;
  process.env.BUZZ_PRIVATE_KEY = ownerHex;
  process.env.BUZZ_RELAY_URL = relayUrl;
  delete process.env.BUZZ_AUTH_TAG;
  delete process.env.BUZZ_FEDERATED_IDENTITY_TOKEN;
  delete process.env.BUZZ_FEDERATED_IDENTITY_ADAPTER;
  process.env.BUZZ_TIMEOUT_SECS = "5";
  process.env.BUZZ_CONNECT_TIMEOUT_SECS = "2";

  const queueRepo = {
    getById: (id) => rows.get(id) ?? null,
    isPersonAddress: (value) => typeof value === "string" && value.endsWith("@external"),
    answersAsk: () => false,
    create: async (input) => {
      const qitemId = input.qitemId ?? `qitem-loopback-inbound-${rows.size}`;
      const row = { qitemId, sourceSession: input.sourceSession, destinationSession: input.destinationSession, body: input.body };
      rows.set(qitemId, row);
      return row;
    },
    transitionLog: { activeOwnerNotificationEpisodes: () => [] },
  };
  wire = buildBuzzGatewayWire({
    home,
    settings: { enabled: true, binaryPath: binary, relayUrl, channelId, credentialSource: "env" },
    queueRepo,
    pollIntervalMs: 1_000,
  });
  const dispatched = wire.dispatcher.dispatch("post_message", human, {
    qitemId: "qitem-loopback-root", notificationKey: "qitem-loopback-root:episode-1",
    summary: "Buzz GatewayWire loopback question", body: "Buzz GatewayWire loopback question",
    destinationSession: human, sourceSession: seat, humanIntent: "ask",
  });
  assert.equal(dispatched.ok, true);
  const sendDeadline = Date.now() + 5_000;
  while (!events.some((event) => event.pubkey === ownerPubkey) && Date.now() < sendDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const rootEvent = events.find((event) => event.pubkey === ownerPubkey);
  assert.ok(rootEvent);
  if (!rootEvent) throw new Error("GatewayWire did not send its root event");

  process.env.BUZZ_PRIVATE_KEY = guestHex;
  const guest = new BuzzCliClient({ binary, relayUrl, timeoutMs: 10_000 });
  const reply = await guest.sendMessage({ channelId, content: "Buzz GatewayWire loopback reply", replyTo: rootEvent.id });
  process.env.BUZZ_PRIVATE_KEY = ownerHex;
  wire.startServices();
  const deadline = Date.now() + 10_000;
  while (rows.size < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(rows.size, 2);
  const firstPollQueries = strongHistoryQueries;
  wire.stop();
  wire.startServices();
  const replayDeadline = Date.now() + 5_000;
  while (strongHistoryQueries === firstPollQueries && Date.now() < replayDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
  wire.stop();
  if (protocolProblem) throw protocolProblem;
  assert.equal(rows.size, 2);
  const inbound = [...rows.values()].find((row) => row.qitemId !== "qitem-loopback-root");
  assert.ok(inbound);
  assert.equal(inbound.sourceSession, human);
  assert.equal(inbound.destinationSession, seat);
  assert.match(inbound.body, /Buzz GatewayWire loopback reply/);
  assert.ok(events.some((event) => event.id === reply.eventId));
  assert.ok(strongHistoryQueries >= firstPollQueries + 2);
  assert.ok(paths.filter((path) => path === "/query").length >= 3);
  assert.ok(paths.every((path) => path === "/events" || path === "/query"));
  process.stdout.write("PASS: opt-in Buzz GatewayWire -> real Buzz CLI -> NIP-98-authenticated localhost history -> registered reply routing and restart dedupe.\n");
} finally {
  wire?.stop();
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
}
