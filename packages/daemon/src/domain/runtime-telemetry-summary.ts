/** A6: bounded read projection over caller-supplied A4/A5 records. No collector or storage. */
import { extractClaudeOtlpApiRequests } from "./claude-otlp-api-request.js";
import { collectCodexUsageHistory, decodeCodexUsageRecord } from "./codex-usage-history.js";

export interface RuntimeTelemetryInputs {
  /** Inputs must come from a verified, explicitly configured source. */
  claude?: readonly { envelope: unknown; verifiedSeatId: string | null }[];
  codex?: readonly unknown[];
  /** Native Codex session to verified OpenRig seat; never inferred from event text. */
  verifiedCodexSeats?: ReadonlyMap<string, string>;
  /** Verified seat-to-rig registry mapping, including Claude seat IDs. */
  verifiedSeatRigs?: ReadonlyMap<string, string>;
}

type Status = "available" | "partial" | "unavailable";
type Tokens = { input: number | null; output: number | null; cachedInput: number | null; cacheWriteInput: number | null; reasoningOutput: number | null };
export interface RuntimeTelemetryRecord {
  runtime: "claude-code" | "codex";
  source: "api_request" | "token_count" | "token_usage_record";
  measurement: "call" | "cumulative-snapshot" | "turn";
  sourceRecordId: string | null;
  observedAt: string | null;
  seatSession: string | null;
  nativeSessionId: string | null;
  model: string | null;
  tokens: Tokens;
  cost: { amountUsd: number | null; kind: "client-estimate" | "unavailable" };
  availability: "complete" | "partial";
  gaps: string[];
}

const MAX_INPUT = 128;
/** Bound attribution inspection separately so unrelated rigs do not consume this rig's record budget. */
const MAX_CODEX_SCOPE_SCAN = 8192;
const MAX_RECORDS = 128;
const sources = ["claude-otlp", "codex-usage"] as const;
/** Limit traversal before invoking the A4 decoder; preserve A4's unrestricted public contract. */
function boundedClaudeEnvelope(raw: unknown, budget: number): { envelope: unknown; scanned: number; truncated: boolean } {
  const root = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const resources = Array.isArray(root.resourceLogs) ? root.resourceLogs : [];
  let scanned = 0;
  let truncated = false;
  const projected: unknown[] = [];
  let visited = 0;
  for (const resource of resources) {
    if (++visited > 128) { truncated = true; break; }
    const r = resource && typeof resource === "object" && !Array.isArray(resource) ? resource as Record<string, unknown> : {};
    const scopes = Array.isArray(r.scopeLogs) ? r.scopeLogs : [];
    const projectedScopes: unknown[] = [];
    for (const scope of scopes) {
      if (++visited > 128) { truncated = true; break; }
      const s = scope && typeof scope === "object" && !Array.isArray(scope) ? scope as Record<string, unknown> : {};
      const logs = Array.isArray(s.logRecords) ? s.logRecords : [];
      const take = Math.max(0, Math.min(logs.length, budget - scanned));
      projectedScopes.push({ logRecords: logs.slice(0, take) });
      scanned += take;
      if (take < logs.length) truncated = true;
      if (scanned >= budget) break;
    }
    projected.push({ resource: r.resource, scopeLogs: projectedScopes });
    if (scanned >= budget || visited > 128) break;
  }
  if (projected.length < resources.length) truncated = true;
  return { envelope: { resourceLogs: projected }, scanned, truncated };
}
export function runtimeTelemetrySummary(rigId: string, supplied: RuntimeTelemetryInputs | null, observedAt: string) {
  const records: RuntimeTelemetryRecord[] = [];
  const gaps: string[] = [];
  const status: Record<(typeof sources)[number], { status: Status; reason: string | null; records: number }> = {
    "claude-otlp": { status: "unavailable", reason: "source-not-configured", records: 0 },
    "codex-usage": { status: "unavailable", reason: "source-not-configured", records: 0 },
  };
  const rigOf = supplied?.verifiedSeatRigs ?? new Map<string, string>();
  const seatScope = (seat: string | null): "included" | "other-rig" | "unknown" =>
    seat === null || !rigOf.has(seat) ? "unknown" : rigOf.get(seat) === rigId ? "included" : "other-rig";
  if (supplied?.claude !== undefined) {
    const input = supplied.claude.slice(0, MAX_INPUT);
    if (supplied.claude.length > MAX_INPUT) gaps.push("claude-input-limit");
    const seen = new Set<string>();
    let partial = false;
    let scanned = 0;
    for (const [index, entry] of input.entries()) {
      const bounded = boundedClaudeEnvelope(entry.envelope, MAX_INPUT - scanned);
      scanned += bounded.scanned;
      if (bounded.truncated) { gaps.push("claude-record-limit"); partial = true; }
      for (const item of extractClaudeOtlpApiRequests(bounded.envelope, entry.verifiedSeatId)) {
        const scope = seatScope(item.seatId);
        if (scope === "unknown") { partial = true; gaps.push("claude-unverified-rig-attribution"); continue; }
        if (scope === "other-rig") continue;
        if (item.dedupeKey && seen.has(item.dedupeKey)) { gaps.push("claude-duplicate-record"); continue; }
        if (item.dedupeKey) seen.add(item.dedupeKey);
        if (item.availability === "partial") partial = true;
        records.push({ runtime: "claude-code", source: "api_request", measurement: "call", sourceRecordId: item.sourceId,
          observedAt: item.eventTimestamp ?? item.observedTimestamp, seatSession: item.seatId, nativeSessionId: item.sessionId,
          model: item.model, tokens: { input: item.tokens.input, output: item.tokens.output, cachedInput: item.tokens.cacheRead,
            cacheWriteInput: item.tokens.cacheCreation, reasoningOutput: null },
          cost: { amountUsd: item.reportedCostUsd, kind: item.reportedCostUsd === null ? "unavailable" : "client-estimate" },
          availability: item.availability, gaps: [...item.invalidFields, ...item.unavailableFields], });
      }
      if (scanned >= MAX_INPUT) { if (index < input.length - 1) { gaps.push("claude-record-limit"); partial = true; } break; }
    }
    const count = records.length;
    const claudePartial = partial || supplied.claude.length > MAX_INPUT || gaps.includes("claude-duplicate-record");
    status["claude-otlp"] = { status: claudePartial ? "partial" : "available", reason: claudePartial ? "record-coverage-incomplete" : null, records: count };
  }
  if (supplied?.codex !== undefined) {
    const scoped: unknown[] = [];
    let inputLimited = supplied.codex.length > MAX_CODEX_SCOPE_SCAN;
    let unknownAttribution = false;
    for (const raw of supplied.codex.slice(0, MAX_CODEX_SCOPE_SCAN)) {
      const decoded = decodeCodexUsageRecord(raw, supplied.verifiedCodexSeats);
      if (!decoded) continue;
      const scope = seatScope(decoded.seatSession);
      if (scope === "other-rig") continue;
      if (scope === "unknown") unknownAttribution = true;
      if (scoped.length >= MAX_INPUT) { inputLimited = true; break; }
      scoped.push(raw);
    }
    const history = collectCodexUsageHistory(scoped, supplied.verifiedCodexSeats);
    if (inputLimited) gaps.push("codex-input-limit");
    gaps.push(...history.coverage.gaps);
    if (history.coverage.duplicateRecords) gaps.push("codex-duplicate-record");
    if (history.coverage.resets) gaps.push("codex-counter-reset");
    let missing = unknownAttribution;
    let count = 0;
    for (const item of history.records) {
      const scope = seatScope(item.seatSession);
      if (scope === "unknown") { missing = true; gaps.push("codex-unverified-rig-attribution"); continue; }
      if (scope === "other-rig") continue;
      count++;
      records.push({ runtime: "codex", source: item.source, measurement: item.measurement,
        sourceRecordId: item.sourceRecordId, observedAt: item.observedAt, seatSession: item.seatSession,
        nativeSessionId: item.nativeSessionId, model: item.model,
        tokens: { ...item.tokens, cacheWriteInput: null }, cost: item.cost,
        availability: item.availability, gaps: [...item.invalidFields, ...item.unavailableFields] });
    }
    const partial = missing || inputLimited || history.coverage.gaps.length > 0 || history.coverage.duplicateRecords > 0 || history.records.some(r => r.availability === "partial");
    status["codex-usage"] = { status: partial ? "partial" : "available", reason: partial ? "coverage-gaps-or-unknown-attribution" : null, records: count };
  }
  records.sort((a, b) => (a.observedAt ?? "").localeCompare(b.observedAt ?? "") || a.runtime.localeCompare(b.runtime));
  if (records.length > MAX_RECORDS) { records.length = MAX_RECORDS; gaps.push("output-record-limit"); }
  const coverageStatus: Status = sources.every(s => status[s].status === "unavailable") ? "unavailable"
    : sources.every(s => status[s].status === "available") && gaps.length === 0 ? "available" : "partial";
  return { schemaVersion: 1 as const, rigId, observedAt, records, coverage: {
    status: coverageStatus, historyCompleteness: "unknown" as const, gaps: [...new Set(gaps)],
    /** No overlap-safe cross-source total exists, including for native Codex snapshots. */
    totalTokens: null, billingUsd: null }, sources: status,
    exporter: { status: "unavailable" as const, reason: "no-external-health-contract" } };
}
