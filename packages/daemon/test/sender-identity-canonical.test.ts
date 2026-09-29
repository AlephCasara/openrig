// #131 — the ONE canonicalizer the transport identity passes through before any actor compare/record.
import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { canonicalSenderSession, requireSenderIdentity, resolveActorWithDeferral } from "../src/routes/require-sender-identity.js";
import { setSelfHostId, getSelfHostId } from "../src/domain/hosts/fanout-contract.js";

describe("canonicalSenderSession", () => {
  const SELF = "host-7fe0ae96";
  it("strips this daemon's own self-host suffix to the local canonical seat", () => {
    expect(canonicalSenderSession(`qa-codex-3@hc@${SELF}`, SELF)).toBe("qa-codex-3@hc");
  });
  it("preserves a foreign host qualifier verbatim", () => {
    expect(canonicalSenderSession("qa-codex-3@hc@host-remote1", SELF)).toBe("qa-codex-3@hc@host-remote1");
  });
  it("leaves an unqualified seat unchanged", () => {
    expect(canonicalSenderSession("qa-codex-3@hc", SELF)).toBe("qa-codex-3@hc");
    expect(canonicalSenderSession("operator", SELF)).toBe("operator");
  });
  it("is case-sensitive on the host id and inert before boot resolves a self id", () => {
    expect(canonicalSenderSession(`a@r@${SELF.toUpperCase()}`, SELF)).toBe(`a@r@${SELF.toUpperCase()}`);
    expect(canonicalSenderSession(`a@r@${SELF}`, null)).toBe(`a@r@${SELF}`);
  });
  it("never strips down to a non-seat (bare-member@host or empty parts)", () => {
    expect(canonicalSenderSession(`a@${SELF}`, SELF)).toBe(`a@${SELF}`);
    expect(canonicalSenderSession(`@r@${SELF}`, SELF)).toBe(`@r@${SELF}`);
  });
});

describe("sender identity helpers canonicalize the transport header", () => {
  let prior: string | null = getSelfHostId();
  afterEach(() => setSelfHostId(prior));
  async function derive(helper: typeof requireSenderIdentity | typeof resolveActorWithDeferral, header: string) {
    prior = getSelfHostId();
    setSelfHostId("host-self");
    const app = new Hono();
    app.get("/", c => {
      const r = helper(c, { bodyClaim: "ignored@r" });
      return c.json(r.ok ? { session: r.session, provenance: r.provenance } : { error: true });
    });
    return (await app.request("/", { headers: { "X-OpenRig-Session": header } })).json();
  }
  for (const helper of [requireSenderIdentity, resolveActorWithDeferral]) {
    it(`${helper.name}: self suffix → bare seat, still transport:v1; foreign preserved`, async () => {
      expect(await derive(helper, "b@r@host-self")).toEqual({ session: "b@r", provenance: "transport:v1" });
      expect(await derive(helper, "b@r@host-other")).toEqual({ session: "b@r@host-other", provenance: "transport:v1" });
      expect(await derive(helper, "b@r")).toEqual({ session: "b@r", provenance: "transport:v1" });
    });
  }
});
