// Test-only NIP-98 HTTP signer: used for authenticated invite and invalid-event tests.
// Scoped to this directory's pinned nostr-tools dependency. No credentials are logged.
import { createHash, randomUUID } from "node:crypto";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";

function sha256Hex(body) {
  return createHash("sha256").update(body).digest("hex");
}

export function createNip98PostAuth(url, body, secret) {
  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [
      ["u", url],
      ["method", "POST"],
      ["payload", sha256Hex(body)],
      ["nonce", randomUUID()],
    ],
  }, Uint8Array.from(Buffer.from(secret, "hex")));
  if (!verifyEvent(event)) throw new Error("Invalid local NIP-98 test authorization event");
  return "Nostr " + Buffer.from(JSON.stringify(event)).toString("base64");
}

export async function authenticatedPost(baseUrl, path, payload, secret) {
  const url = new URL(path, baseUrl).toString();
  const body = JSON.stringify(payload);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: createNip98PostAuth(url, body, secret),
      "content-type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(5_000),
    redirect: "manual",
  });
  const raw = await response.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = null; }
  return { status: response.status, ok: response.ok, json };
}
