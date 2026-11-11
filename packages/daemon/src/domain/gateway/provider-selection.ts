// Explicit external gateway provider choice (experimental, fail-closed for Buzz).
// No network/process/agent starts while reading this file. Existing Slack is default.
// Buzz is not a production transport until its outbound+inbound wire passes further gates.
import fs from "node:fs";
import path from "node:path";
import type { GatewayWire } from "./gateway-subsystem.js";
import { DispatchBuffer } from "./dispatch-buffer.js";

export type GatewayProviderName = "slack" | "buzz";

export interface BuzzGatewaySettings {
  enabled: boolean;
  binaryPath: string;
  relayUrl: string;
  channelId: string;
  credentialSource: "env";
}

export interface GatewayProviderSettings {
  schemaVersion: 1;
  provider: GatewayProviderName;
  buzz?: BuzzGatewaySettings;
}

export interface BuzzPreflight {
  ready: boolean;
  failures: string[];
}

export const DEFAULT_GATEWAY_PROVIDER: GatewayProviderSettings = {
  schemaVersion: 1,
  provider: "slack",
};

const CHANNEL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function gatewayProviderPath(home: string): string {
  return path.join(home, "gateway-provider.json");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extra = Object.keys(value).filter((name) => !allowed.includes(name));
  if (extra.length > 0) {
    // Report field names only: never expose raw config contents or secret values.
    throw new Error(`${where} contains unsupported field(s): ${extra.join(", ")}`);
  }
}

/** Strictly reject credentials in the config. Only credentialSource="env" is supported here. */
export function parseGatewayProviderSettings(input: unknown): GatewayProviderSettings {
  if (!record(input)) throw new Error("gateway-provider.json must be an object");
  rejectUnknown(input, ["schemaVersion", "provider", "buzz"], "gateway-provider.json");
  if (input.schemaVersion !== 1) throw new Error("unsupported gateway-provider.json schemaVersion");
  if (input.provider !== "slack" && input.provider !== "buzz") {
    throw new Error("gateway-provider.json provider must be slack or buzz");
  }
  if (input.buzz === undefined) {
    if (input.provider === "buzz") throw new Error("gateway-provider.json missing buzz settings");
    return { schemaVersion: 1, provider: "slack" };
  }
  if (!record(input.buzz)) throw new Error("gateway-provider.json buzz must be an object");
  const buzz = input.buzz;
  rejectUnknown(buzz, ["enabled", "binaryPath", "relayUrl", "channelId", "credentialSource"], "buzz");
  if (
    typeof buzz.enabled !== "boolean" ||
    typeof buzz.binaryPath !== "string" ||
    typeof buzz.relayUrl !== "string" ||
    typeof buzz.channelId !== "string" ||
    buzz.credentialSource !== "env"
  ) {
    throw new Error("invalid buzz gateway settings (requires enabled, binaryPath, relayUrl, channelId, credentialSource=env)");
  }
  return {
    schemaVersion: 1,
    provider: input.provider,
    buzz: {
      enabled: buzz.enabled,
      binaryPath: buzz.binaryPath,
      relayUrl: buzz.relayUrl,
      channelId: buzz.channelId,
      credentialSource: "env",
    },
  };
}

export function loadGatewayProviderSettings(home: string): GatewayProviderSettings {
  let content: string;
  try {
    content = fs.readFileSync(gatewayProviderPath(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_GATEWAY_PROVIDER };
    throw new Error("gateway-provider.json could not be read");
  }
  let input: unknown;
  try {
    input = JSON.parse(content) as unknown;
  } catch {
    throw new Error("gateway-provider.json is not valid JSON");
  }
  return parseGatewayProviderSettings(input);
}

function localHttp(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function buzzGatewayPreflight(
  settings: BuzzGatewaySettings,
  options: { secretPresent?: boolean; executable?: (filename: string) => boolean } = {},
): BuzzPreflight {
  const failures: string[] = [];
  if (!settings.enabled) failures.push("buzz-disabled");
  if (!CHANNEL_UUID.test(settings.channelId)) failures.push("channel-invalid");
  if (!path.isAbsolute(settings.binaryPath)) {
    failures.push("binary-path-not-absolute");
  } else {
    const executable = options.executable ?? ((filename: string): boolean => {
      try {
        const stat = fs.statSync(filename);
        return stat.isFile() && (stat.mode & 0o111) !== 0;
      } catch {
        return false;
      }
    });
    if (!executable(settings.binaryPath)) failures.push("binary-missing-or-not-executable");
  }
  try {
    const url = new URL(settings.relayUrl);
    if (
      !(url.protocol === "https:" || localHttp(url)) ||
      url.username || url.password || url.hash || url.search || url.pathname !== "/"
    ) {
      failures.push("relay-url-not-secure-or-loopback");
    }
  } catch {
    failures.push("relay-url-invalid");
  }
  if (settings.credentialSource !== "env") failures.push("unsupported-credential-source");
  if (!(options.secretPresent ?? Boolean(process.env.BUZZ_PRIVATE_KEY))) failures.push("env-credential-unresolved");
  return { ready: failures.length === 0, failures };
}

export interface GatewayProviderFactories {
  home: string;
  slack: () => GatewayWire;
  /** Buzz builder may be intentionally unavailable while integration is incomplete. */
  buzz?: (settings: BuzzGatewaySettings) => GatewayWire;
  /** For hermetic tests; defaults to the file on disk. */
  settings?: () => GatewayProviderSettings;
  /** For hermetic tests; preflight never launches an executable. */
  buzzPreflight?: (settings: BuzzGatewaySettings) => BuzzPreflight;
}

/** Refuse cross-provider replay before a destination is reached. */
export function assertProviderPendingCompatible(home: string, provider: GatewayProviderName, channelId?: string): void {
  for (const decision of new DispatchBuffer(home).pendingStrict()) {
    const payload: unknown = decision.payload;
    const buzz = record(payload) && record(payload.buzzTransport) ? payload.buzzTransport : null;
    if (provider === "slack") {
      if (buzz) throw new Error("pending Buzz decisions require reconciliation before switching to Slack");
    } else if (!buzz || buzz.schemaVersion !== 1 || buzz.channelId !== channelId) {
      throw new Error("pending Slack/relay/foreign Buzz decisions require reconciliation before selecting Buzz");
    }
  }
}

/** Compose exactly ONE provider; no fallback from explicit Buzz to Slack. */
export function buildSelectedGatewayWire(options: GatewayProviderFactories): GatewayWire {
  const chosen = options.settings?.() ?? loadGatewayProviderSettings(options.home);
  if (chosen.provider === "slack") {
    assertProviderPendingCompatible(options.home, "slack");
    return options.slack();
  }
  assertProviderPendingCompatible(options.home, "buzz", chosen.buzz?.channelId);
  if (!chosen.buzz) throw new Error("Buzz gateway selected without connector configuration");
  const readiness = (options.buzzPreflight ?? buzzGatewayPreflight)(chosen.buzz);
  if (!readiness.ready) {
    throw new Error(`Buzz gateway not ready: ${readiness.failures.join(", ")}`);
  }
  if (!options.buzz) {
    throw new Error("Buzz gateway is not yet implemented; no Slack fallback or Buzz process was started");
  }
  return options.buzz(chosen.buzz);
}
