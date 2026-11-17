// Opt-in real Buzz CLI ↔ loopback relay protocol smoke test.
// No OpenRig daemon, public relay, Buzz desktop or credentials are required.
// Run: BUZZ_CLI_BIN=/absolute/path/to/buzz node --import tsx scripts/buzz-cli-loopback-smoke.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPublicKey, generateSecretKey } from "nostr-tools/pure";
import { BuzzCliClient } from "../packages/daemon/src/domain/gateway/buzz-cli.ts";
import { BuzzInboundLab } from "../packages/daemon/src/domain/gateway/buzz/inbound-lab.ts";
import { BuzzOutboundDelivery, prepareBuzzDecision, resolveConfirmedBuzzRoot } from "../packages/daemon/src/domain/gateway/buzz/outbound-delivery.ts";
import { resolveBuzzHandle, validateHumanFragment } from "../packages/daemon/src/domain/gateway/human-registry.ts";

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
let protocolProblem;
const home = mkdtempSync(join(tmpdir(), "openrig-buzz-cli-smoke-"));

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
      assert.ok(
        body.content === "buzz-cli-loopback-reply"
        || (body.pubkey === ownerPubkey
          && body.content.startsWith("Buzz loopback root\n\nbuzz-cli-loopback-smoke\n\n[OpenRig delivery: ")),
      );
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
  process.env.BUZZ_PRIVATE_KEY = ownerHex;
  process.env.BUZZ_RELAY_URL = `http://127.0.0.1:${address.port}`;
  delete process.env.BUZZ_AUTH_TAG;
  delete process.env.BUZZ_FEDERATED_IDENTITY_TOKEN;
  delete process.env.BUZZ_FEDERATED_IDENTITY_ADAPTER;
  process.env.BUZZ_TIMEOUT_SECS = "5";
  process.env.BUZZ_CONNECT_TIMEOUT_SECS = "2";

  const client = new BuzzCliClient({ binary, timeoutMs: 10_000 });
  const authorizedDestinations = new Set([human]);
  const outbound = new BuzzOutboundDelivery({
    home, channelId, expectedPubkey: ownerPubkey, authorizedDestinations, transport: client,
  });
  const rootDecision = prepareBuzzDecision({
    kind: "outbound_decision", decisionId: "loopback-root-decision", op: "post_message",
    entityBindingRef: human,
    payload: {
      qitemId: "qitem-loopback-root", notificationKey: "qitem-loopback-root:episode-1",
      summary: "Buzz loopback root", body: "buzz-cli-loopback-smoke",
      destinationSession: human, sourceSession: seat,
    },
  }, { channelId, authorizedDestinations });
  assert.deepEqual(await outbound.deliver(rootDecision), { ok: true });
  const rootEvent = events.find((event) => event.pubkey === ownerPubkey && event.content.includes("[OpenRig delivery:"));
  assert.ok(rootEvent);
  if (!rootEvent) throw new Error("OpenRig Buzz outbound did not produce a confirmed root event");
  process.env.BUZZ_PRIVATE_KEY = guestHex;
  const guestClient = new BuzzCliClient({ binary, timeoutMs: 10_000 });
  const reply = await guestClient.sendMessage({
    channelId,
    content: "buzz-cli-loopback-reply",
    replyTo: rootEvent.id,
  });
  process.env.BUZZ_PRIVATE_KEY = ownerHex;
  const messages = await client.getMessages({
    channelId,
    since: 0,
    limit: 10,
  });
  if (protocolProblem) throw protocolProblem;
  assert.equal(events.length, 2);
  assert.equal(messages.length, 2);
  assert.ok(messages.find((message) => message.id === rootEvent.id)?.content.includes("buzz-cli-loopback-smoke"));
  assert.equal(messages.find((message) => message.id === reply.eventId)?.replyTo, rootEvent.id);
  const registration = validateHumanFragment({
    entityId: "loopback-human",
    class: "human",
    displayName: "Loopback Human",
    address: human,
    connectorBindings: [{
      kind: "buzz", connectorRef: channelId,
      secretsRef: "env:BUZZ_PRIVATE_KEY", role: "primary", handle: guestPubkey,
    }],
    prefs: { deliveryClass: "B" },
  });
  assert.equal(registration.ok, true);
  if (!registration.ok) throw new Error(`Loopback Buzz human registration failed: ${registration.error}`);
  const resolvedHuman = resolveBuzzHandle(channelId, guestPubkey, [registration.fragment]);
  assert.equal(resolvedHuman.kind, "registered");
  if (resolvedHuman.kind !== "registered") throw new Error(resolvedHuman.error);
  const rows = new Map();
  const inserted = [];
  const inbound = new BuzzInboundLab({
    home, channelId, selfPubkey: ownerPubkey,
    allowedHumans: new Map([[resolvedHuman.pubkey, resolvedHuman.address]]),
    resolveConfirmedRoot: (eventId) => resolveConfirmedBuzzRoot(home, channelId, eventId),
    transport: client,
    queue: {
      getQitem: (id) => rows.get(id) ?? null,
      createQitem: async (input) => {
        inserted.push(input);
        rows.set(input.qitemId, {
          qitemId: input.qitemId,
          sourceSession: input.source,
          destinationSession: input.destination,
          body: input.body,
        });
        return input.qitemId;
      },
    },
  });
  assert.deepEqual(await inbound.pollOnce(), { ok: true, accepted: 1, ignored: 1, scanned: 2 });
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].source, human);
  assert.equal(inserted[0].destination, seat);
  assert.equal(inserted[0].inReplyTo, "qitem-loopback-root");
  assert.equal(inserted[0].humanAnswer, false);
  assert.equal((await inbound.pollOnce()).accepted, 0);
  assert.equal(inserted.length, 1);
  assert.equal(paths.filter((path) => path === "/events").length, 2);
  assert.ok(paths.filter((path) => path === "/query").length >= 3);
  assert.ok(paths.every((path) => path === "/events" || path === "/query"));
  process.stdout.write("PASS: real Buzz CLI -> signed Nostr message + registered human reply -> loopback relay -> OpenRig signature verification, inbound routing and durable dedupe (no daemon).\n");
} finally {
  delete process.env.BUZZ_PRIVATE_KEY;
  rmSync(home, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
}
