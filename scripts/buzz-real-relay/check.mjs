// CLI ↔ real Buzz relay integration contract. Invoked only by run.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { BuzzCliClient } from "../../packages/daemon/src/domain/gateway/buzz-cli.ts";
import { authenticatedPost } from "./auth.mjs";

export async function runRealRelaySmoke({ cli, baseUrl, owner, guest, outsider, relayMembershipRequired = false }) {
  const original = {
    key: process.env.BUZZ_PRIVATE_KEY,
    relay: process.env.BUZZ_RELAY_URL,
    authTag: process.env.BUZZ_AUTH_TAG,
    fidToken: process.env.BUZZ_FEDERATED_IDENTITY_TOKEN,
    fidAdapter: process.env.BUZZ_FEDERATED_IDENTITY_ADAPTER,
  };
  function invoke(args, { secret = owner.secret, stdin = "" } = {}) {
    const env = {
      ...process.env,
      BUZZ_PRIVATE_KEY: secret,
      BUZZ_RELAY_URL: baseUrl,
      BUZZ_CONNECT_TIMEOUT_SECS: "2",
      BUZZ_TIMEOUT_SECS: "5",
    };
    for (const v of ["BUZZ_AUTH_TAG", "BUZZ_FEDERATED_IDENTITY_TOKEN", "BUZZ_FEDERATED_IDENTITY_ADAPTER"])
      delete env[v];
    const result = spawnSync(cli, args, {
      input: stdin,
      env,
      encoding: "utf8",
      timeout: 13_000,
      maxBuffer: 256 * 1024,
      shell: false,
    });
    let category = "unknown";
    try { category = JSON.parse(result.stderr)?.error ?? "unknown"; } catch {}
    let json;
    try { json = JSON.parse(result.stdout); } catch {}
    return { status: result.status, category, json, timedOut: result.error?.code === "ETIMEDOUT" };
  }
  function succeeded(args, opts) {
    const result = invoke(args, opts);
    assert.equal(result.status, 0, `Expected Buzz CLI success for ${args.slice(0, 2).join(" ")}; error category=${result.category}; exit=${result.status}`);
    assert.ok(result.json !== undefined, "Expected valid JSON response from real Buzz CLI");
    return result.json;
  }
  function denied(args, opts) {
    const result = invoke(args, opts);
    assert.notEqual(result.status, 0, `Expected Buzz CLI refusal for ${args.slice(0, 2).join(" ")}`);
    return result.category;
  }
  try {
    process.env.BUZZ_PRIVATE_KEY = owner.secret;
    process.env.BUZZ_RELAY_URL = baseUrl;
    process.env.BUZZ_CONNECT_TIMEOUT_SECS = "2";
    process.env.BUZZ_TIMEOUT_SECS = "5";
    delete process.env.BUZZ_AUTH_TAG;
    delete process.env.BUZZ_FEDERATED_IDENTITY_TOKEN;
    delete process.env.BUZZ_FEDERATED_IDENTITY_ADAPTER;

    const channel = succeeded([
      "channels", "create", "--name", "openrig-buzz-smoke-" + randomUUID().slice(0, 8),
      "--type", "stream", "--visibility", "private",
    ]);
    const channelId = channel.channel_id;
    assert.match(channelId, /^[0-9a-f-]{36}$/i);
    console.log("PASS: ephemeral private channel created on real relay.");

    const client = new BuzzCliClient({ binary: cli, timeoutMs: 12_000 });
    const sent = await client.sendMessage({ channelId, content: "real-relay-integration-smoke" });
    assert.match(sent.eventId, /^[0-9a-f]{64}$/);
    console.log("PASS: real NIP-98 signed outbound message acknowledged.");

    const rawRead = succeeded(["messages", "get", "--channel", channelId, "--limit", "30", "--kinds", "9"]);
    const rawEvent = rawRead.find((event) => event.id === sent.eventId);
    assert.equal(rawEvent.pubkey, owner.pubkey);
    assert.match(rawEvent.sig, /^[0-9a-f]{128}$/i);
    assert.equal(rawEvent.content, "real-relay-integration-smoke");
    console.log("PASS: relay persisted signed event with matching sender pubkey and signature.");

    const outsiderRead = invoke(["messages", "get", "--channel", channelId], { secret: outsider.secret });
    if (outsiderRead.status === 0) {
      assert.ok(Array.isArray(outsiderRead.json), "Unexpected non-member read response");
      assert.ok(!outsiderRead.json.some((message) => message.id === sent.eventId),
        "Private channel content leaked to a non-member");
    }
    const outsiderPost = denied([
      "messages", "send", "--channel", channelId, "--content", "-",
    ], { secret: outsider.secret, stdin: "forbidden-message" });
    console.log(`PASS: non-member private channel access blocked (read=${outsiderRead.status === 0 ? "filtered" : outsiderRead.category}; write=${outsiderPost}).`);

    succeeded([
      "channels", "add-member", "--channel", channelId,
      "--pubkey", guest.pubkey, "--role", "member",
    ]);
    console.log("PASS: channel owner granted membership to a disposable second identity.");

    if (relayMembershipRequired) {
      const beforeInvitation = denied([
        "messages", "send", "--channel", channelId, "--content", "-",
      ], { secret: guest.secret, stdin: "guest-before-nip43-admission" });
      console.log(`PASS: channel membership alone does not bypass NIP-43 (${beforeInvitation}).`);
      const mint = await authenticatedPost(baseUrl, "/api/invites",
        { ttl_secs: 3600, max_uses: 1 }, owner.secret);
      assert.equal(mint.ok, true, `NIP-43 owner invite mint failed: HTTP ${mint.status} (${mint.json?.error ?? "unknown"})`);
      assert.equal(typeof mint.json?.code, "string", "Missing relay invite code");
      const claim = await authenticatedPost(baseUrl, "/api/invites/claim",
        { code: mint.json.code }, guest.secret);
      assert.equal(claim.ok, true, `NIP-43 guest invite claim failed: HTTP ${claim.status} (${claim.json?.error ?? "unknown"})`);
      assert.ok(["joined", "already_member"].includes(claim.json?.status));
      console.log("PASS: NIP-43 invite minted by owner and claimed by a second identity.");
    }

    const guestReply = succeeded([
      "messages", "send", "--channel", channelId,
      "--content", "-", "--reply-to", sent.eventId,
    ], { secret: guest.secret, stdin: "real-relay-thread-reply" });
    assert.equal(guestReply.accepted, true);
    assert.match(guestReply.event_id, /^[0-9a-f]{64}$/);
    const parsed = await client.getMessages({ channelId, limit: 30 });
    const parent = parsed.find((e) => e.id === sent.eventId);
    const child = parsed.find((e) => e.id === guestReply.event_id);
    assert.equal(parent?.authorPubkey, owner.pubkey);
    assert.equal(child?.authorPubkey, guest.pubkey);
    assert.equal(child?.replyTo, sent.eventId);
    assert.equal(child?.content, "real-relay-thread-reply");
    console.log("PASS: real authorized cross-identity reply and thread attribution in OpenRig adapter.");

    succeeded(["channels", "remove-member", "--channel", channelId, "--pubkey", guest.pubkey]);
    const revokedWrite = denied(["messages", "send", "--channel", channelId, "--content", "-"],
      { secret: guest.secret, stdin: "revoked-guest-must-not-post" });
    console.log(`PASS: revoked channel membership blocks new posts (${revokedWrite}).`);

    const missingChannel = denied([
      "messages", "send", "--channel", randomUUID(), "--content", "-",
    ], { stdin: "should-not-be-sent" });
    console.log(`PASS: relay refuses nonexistent channel (${missingChannel}).`);

    const malformedKey = denied(["messages", "get", "--channel", channelId], { secret: "not-a-nostr-key" });
    console.log(`PASS: malformed identity key refused by the CLI (${malformedKey}).`);

    await assert.rejects(
      client.sendMessage({ channelId, content: "bad", replyTo: "invalid-id" }),
      /invalid Buzz Nostr event ID/,
    );
    console.log("PASS: invalid event reference blocked before network transport.");

    const validReplay = await authenticatedPost(baseUrl, "/events", rawEvent, owner.secret);
    assert.notEqual(validReplay.status, 401,
      "Authenticated control request failed; cannot attribute tamper rejection to event signature");
    const tamperedSignedRequest = await authenticatedPost(
      baseUrl, "/events",
      { ...rawEvent, content: "tampered-nostr-content-with-old-signature" }, owner.secret,
    );
    assert.ok(tamperedSignedRequest.status >= 400,
      "Relay accepted a Nostr event with an invalid event signature");
    assert.notEqual(tamperedSignedRequest.json?.accepted, true);
    console.log(`PASS: real relay refused event with invalid Schnorr signature under separately valid NIP-98 auth (HTTP ${tamperedSignedRequest.status}; authenticated control HTTP ${validReplay.status}).`);

    const rawUnsigned = await fetch(baseUrl + "/events", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...rawEvent, content: "tampered" }),
      signal: AbortSignal.timeout(3000),
    });
    assert.ok(rawUnsigned.status >= 400, "Unauthenticated/tampered event must be refused");
    console.log(`PASS: unsigned direct HTTP mutation refused (HTTP ${rawUnsigned.status}; cannot isolate signature vs auth).`);
    return { channelId };
  } finally {
    const restore = (name, old) => old === undefined ? delete process.env[name] : process.env[name] = old;
    restore("BUZZ_PRIVATE_KEY", original.key);
    restore("BUZZ_RELAY_URL", original.relay);
    restore("BUZZ_AUTH_TAG", original.authTag);
    restore("BUZZ_FEDERATED_IDENTITY_TOKEN", original.fidToken);
    restore("BUZZ_FEDERATED_IDENTITY_ADAPTER", original.fidAdapter);
  }
}
