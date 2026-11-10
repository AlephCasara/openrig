import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GatewaySubsystem, type GatewayWire } from "../src/domain/gateway/gateway-subsystem.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import {
  buildSelectedGatewayWire, buzzGatewayPreflight, gatewayProviderPath,
  loadGatewayProviderSettings, parseGatewayProviderSettings,
  type BuzzGatewaySettings, type GatewayProviderSettings,
} from "../src/domain/gateway/provider-selection.js";

const validBuzz: BuzzGatewaySettings = {
  enabled: true,
  binaryPath: "/nix/store/test-buzz/bin/buzz",
  relayUrl: "https://relay.example.test/",
  channelId: "2e4ab450-4c57-4541-8e3b-7491e1dd535f",
  credentialSource: "env",
};

const buzzChoice = (): GatewayProviderSettings => ({
  schemaVersion: 1, provider: "buzz", buzz: validBuzz,
});

const fakeWire = (): GatewayWire => ({
  dispatcher: {} as GatewayWire["dispatcher"],
  stop: () => {},
});

describe("Experimental gateway provider selection: fail closed, opt-in, no rig", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "gateway-provider-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("defaults to Slack for homes without any provider config", () => {
    expect(loadGatewayProviderSettings(home)).toEqual({ schemaVersion: 1, provider: "slack" });
    let slack = 0;
    let buzz = 0;
    const out = buildSelectedGatewayWire({
      home,
      slack: () => { slack++; return fakeWire(); },
      buzz: () => { buzz++; return fakeWire(); },
    });
    expect(out).toHaveProperty("stop");
    expect([slack, buzz]).toEqual([1, 0]);
  });

  it("selecting Slack does not evaluate optional Buzz config or read Buzz credentials", () => {
    writeFileSync(gatewayProviderPath(home), JSON.stringify({
      schemaVersion: 1, provider: "slack",
      buzz: { ...validBuzz, enabled: false },
    }));
    let preflight = 0;
    let slack = 0;
    buildSelectedGatewayWire({
      home,
      slack: () => { slack++; return fakeWire(); },
      buzzPreflight: () => { preflight++; throw new Error("unexpected Buzz access"); },
    });
    expect([slack, preflight]).toEqual([1, 0]);
  });

  it("chooses only Buzz with explicit opt-in and passing preflight", () => {
    writeFileSync(gatewayProviderPath(home), JSON.stringify(buzzChoice()));
    let slack = 0;
    let buzz = 0;
    const out = buildSelectedGatewayWire({
      home,
      slack: () => { slack++; return fakeWire(); },
      buzz: (settings) => {
        buzz++;
        expect(settings.channelId).toBe(validBuzz.channelId);
        return fakeWire();
      },
      buzzPreflight: () => ({ ready: true, failures: [] }),
    });
    expect(out).toHaveProperty("stop");
    expect([slack, buzz]).toEqual([0, 1]);
  });

  it("explicit Buzz never silently falls back to Slack when not ready", () => {
    let slack = 0;
    let buzz = 0;
    expect(() => buildSelectedGatewayWire({
      home, settings: buzzChoice,
      slack: () => { slack++; return fakeWire(); },
      buzz: () => { buzz++; return fakeWire(); },
      buzzPreflight: () => ({ ready: false, failures: ["credential-unresolved"] }),
    })).toThrow(/Buzz gateway not ready: credential-unresolved/);
    expect([slack, buzz]).toEqual([0, 0]);
  });

  it("reports missing production Buzz wire instead of falsely activating an inert transport", () => {
    expect(() => buildSelectedGatewayWire({
      home, settings: buzzChoice,
      slack: fakeWire,
      buzzPreflight: () => ({ ready: true, failures: [] }),
    })).toThrow(/Buzz gateway is not yet implemented/);
  });

  it("an explicitly selected Buzz without an operational wire reports failed, never Slack-active", () => {
    let slackCalled = 0;
    writeFileSync(gatewayProviderPath(home), JSON.stringify(buzzChoice()));
    const subsystem = new GatewaySubsystem({
      home,
      wire: () => buildSelectedGatewayWire({
        home,
        slack: () => { slackCalled++; return fakeWire(); },
        buzzPreflight: () => ({ ready: true, failures: [] }),
      }),
    });
    expect(() => subsystem.start()).not.toThrow();
    expect(subsystem.status()).toMatchObject({
      state: "failed",
      reason: expect.stringContaining("Buzz gateway is not yet implemented"),
    });
    expect(subsystem.dispatch("post", "human@kernel", {})).toMatchObject({ ok: false });
    expect(slackCalled).toBe(0);
    subsystem.stop();
  });

  it("blocks Slack startup rather than replaying a pending Buzz delivery into Slack", () => {
    new DispatchBuffer(home).enqueue({
      kind: "outbound_decision",
      decisionId: "buzz-old",
      op: "post_message",
      entityBindingRef: "human@external",
      payload: {
        qitemId: "q-1", notificationKey: "q-1:e1",
        buzzTransport: { schemaVersion: 1, channelId: validBuzz.channelId },
      },
    });
    let slackCalled = 0;
    expect(() => buildSelectedGatewayWire({
      home,
      slack: () => { slackCalled++; return fakeWire(); },
    })).toThrow(/pending Buzz decisions require reconciliation/);
    expect(slackCalled).toBe(0);
  });

  it("refuses to adopt old Slack or relay pending work in a Buzz-only wire", () => {
    new DispatchBuffer(home).enqueue({
      kind: "outbound_decision",
      decisionId: "old-slack",
      op: "post_message",
      entityBindingRef: "human@external",
      payload: { qitemId: "q-1" },
    });
    let buzzCalled = 0;
    expect(() => buildSelectedGatewayWire({
      home,
      settings: buzzChoice,
      slack: fakeWire,
      buzz: () => { buzzCalled++; return fakeWire(); },
      buzzPreflight: () => ({ ready: true, failures: [] }),
    })).toThrow(/pending Slack\/relay\/foreign Buzz decisions/);
    expect(buzzCalled).toBe(0);
  });

  it("does not accept secrets or unexpected config fields", () => {
    expect(() => parseGatewayProviderSettings({
      ...buzzChoice(), buzz: { ...validBuzz, privateKey: "secret-must-not-be-stored-here" },
    })).toThrow(/unsupported field/);
    expect(() => parseGatewayProviderSettings({
      schemaVersion: 1, provider: "buzz", token: "secret",
    })).toThrow(/unsupported field/);
    expect(() => parseGatewayProviderSettings({
      schemaVersion: 1, provider: "buzz", buzz: { ...validBuzz, credentialSource: "inline" },
    })).toThrow(/invalid buzz gateway settings/);
  });

  it("rejects malformed schema, JSON, and invalid provider without silently selecting Slack", () => {
    const cases = [
      "{",
      JSON.stringify({ schemaVersion: 5, provider: "slack" }),
      JSON.stringify({ schemaVersion: 1, provider: "none" }),
      JSON.stringify({ schemaVersion: 1, provider: "buzz" }),
    ];
    for (const raw of cases) {
      writeFileSync(gatewayProviderPath(home), raw);
      expect(() => loadGatewayProviderSettings(home)).toThrow();
    }
  });

  it("preflight requires a real binary, valid channel, and credential in environment", () => {
    const binary = join(home, "buzz");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(binary, 0o700);
    const opts = { ...validBuzz, binaryPath: binary };
    expect(buzzGatewayPreflight(opts, { secretPresent: true })).toEqual({ ready: true, failures: [] });
    expect(buzzGatewayPreflight(opts, { secretPresent: false }).failures).toContain("env-credential-unresolved");
    expect(buzzGatewayPreflight({ ...opts, binaryPath: "/not-there/buzz" }, { secretPresent: true }).failures)
      .toContain("binary-missing-or-not-executable");
    expect(buzzGatewayPreflight({ ...opts, channelId: "not-a-uuid" }, { secretPresent: true }).failures)
      .toContain("channel-invalid");
    expect(buzzGatewayPreflight({ ...opts, enabled: false }, { secretPresent: true }).failures)
      .toContain("buzz-disabled");
  });

  it("rejects remote plaintext HTTP relay and URL-embedded passwords", () => {
    const check = (relayUrl: string) =>
      buzzGatewayPreflight({ ...validBuzz, relayUrl }, { secretPresent: true, executable: () => true }).failures;
    expect(check("http://not-local.example.test/")).toContain("relay-url-not-secure-or-loopback");
    expect(check("https://alice:password@relay.example.test/")).toContain("relay-url-not-secure-or-loopback");
    expect(check("http://127.0.0.1:31337/")).toEqual([]);
  });
});
