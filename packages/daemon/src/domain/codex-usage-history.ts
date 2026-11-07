/** Bounded, pure Codex usage history decoder. Never reads transcripts or persists raw records. */
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : null;
const str = (v: unknown): string | null => typeof v === "string" && v.trim().length > 0 ? v : null;
const count = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const stamp = (v: unknown): string | null => {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

export type CodexTokenFields = {
  input: number | null;
  output: number | null;
  cachedInput: number | null;
  reasoningOutput: number | null;
};
export type CodexUsageHistoryRecord = {
  schemaVersion: 1;
  runtime: "codex";
  producer: "codex-native" | "codex-web-adapter";
  source: "token_count" | "token_usage_record";
  sourceRecordId: string | null;
  dedupeKey: string | null;
  observedAt: string | null;
  nativeSessionId: string | null;
  turnId: string | null;
  model: string | null;
  seatSession: string | null;
  /** Snapshot cumulative usage or turn-level measured usage, never interchangeable. */
  measurement: "cumulative-snapshot" | "turn";
  tokens: CodexTokenFields;
  contextWindow: number | null;
  cost: { amountUsd: null; kind: "unavailable" };
  availability: "complete" | "partial";
  invalidFields: string[];
  unavailableFields: string[];
};
export type CodexHistoryResult = {
  records: CodexUsageHistoryRecord[];
  /** Only turn records contribute to this non-overlapping total; null means unknown. */
  turnTotals: CodexTokenFields;
  /** Native snapshot history is retained for context, not added to turnTotals. */
  latestSnapshots: CodexUsageHistoryRecord[];
  coverage: {
    duplicateRecords: number;
    overlappingSnapshots: number;
    resets: number;
    gaps: string[];
  };
};

function tokenFields(raw: Obj | null, invalid: string[]): CodexTokenFields {
  const read = (name: keyof CodexTokenFields, key: string): number | null => {
    if (!raw) return null;
    const value = count(raw[key]);
    if (key in raw && value === null) invalid.push(`tokens.${name}`);
    return value;
  };
  return {
    input: read("input", "input_tokens"),
    output: read("output", "output_tokens"),
    cachedInput: read("cachedInput", "cached_input_tokens"),
    reasoningOutput: read("reasoningOutput", "reasoning_output_tokens"),
  };
}

/** Verified mapping must be supplied from outside this decoder, keyed by native thread/session ID. */
export function decodeCodexUsageRecord(raw: unknown, verifiedSeatBySession: ReadonlyMap<string, string> = new Map()): CodexUsageHistoryRecord | null {
  const envelope = obj(raw);
  if (!envelope) return null;
  const payload = obj(envelope.payload);
  const native = payload?.type === "token_count";
  const adapter = envelope.type === "token_usage_record" || payload?.type === "token_usage_record";
  if (!native && !adapter) return null;
  const body = adapter ? (payload?.type === "token_usage_record" ? payload : envelope) : payload!;
  const invalidFields: string[] = [];
  const readStr = (key: string, value: unknown): string | null => {
    const result = str(value);
    if (value !== undefined && result === null) invalidFields.push(key);
    return result;
  };
  const observedAt = stamp(envelope.timestamp ?? body.timestamp);
  if ((envelope.timestamp ?? body.timestamp) !== undefined && observedAt === null) invalidFields.push("timestamp");
  const nativeSessionId = readStr("nativeSessionId", body.session_id ?? envelope.session_id ?? body.thread_id ?? envelope.thread_id);
  const turnId = readStr("turnId", body.turn_id ?? envelope.turn_id);
  const model = readStr("model", body.model ?? envelope.model);
  const sourceRecordId = readStr("sourceRecordId", body.id ?? envelope.id);
  const info = obj(body.info);
  // Native total_token_usage is cumulative; last_token_usage is only one request/turn and
  // must never replace totals or be summed across snapshots. Rate-limit-only events are skipped.
  const tokensRaw = native ? obj(info?.total_token_usage) : obj(body.token_usage);
  if (native && !tokensRaw && !obj(info?.last_token_usage)) return null;
  if (adapter && "token_usage" in body && body.token_usage !== undefined && !tokensRaw) invalidFields.push("token_usage");
  if (native && info && "total_token_usage" in info && info.total_token_usage !== undefined && !tokensRaw) invalidFields.push("total_token_usage");
  const tokens = tokenFields(tokensRaw, invalidFields);
  const contextRaw = info?.model_context_window;
  const contextWindow = count(contextRaw);
  if (contextRaw !== undefined && (contextWindow === null || contextWindow === 0)) invalidFields.push("contextWindow");
  if (adapter && !turnId) invalidFields.push("turnId-required-for-turn-record");
  const unavailableFields = [
    ...(observedAt === null ? ["observedAt"] : []),
    ...(nativeSessionId === null ? ["nativeSessionId"] : []),
    ...(turnId === null && adapter ? ["turnId"] : []),
    ...(model === null ? ["model"] : []),
    ...Object.entries(tokens).filter(([, value]) => value === null).map(([key]) => `tokens.${key}`),
  ];
  const producer = native ? "codex-native" : "codex-web-adapter";
  const source = native ? "token_count" : "token_usage_record";
  // Native snapshots may repeat within a timestamp, but distinct observations remain distinct.
  const dedupeKey = nativeSessionId && adapter && turnId
    ? `${producer}:${nativeSessionId}:turn:${turnId}`
    : nativeSessionId && sourceRecordId
      ? `${producer}:${nativeSessionId}:id:${sourceRecordId}`
      : nativeSessionId && native && observedAt
        ? `${producer}:${nativeSessionId}:timestamp:${observedAt}:snapshot:${JSON.stringify([tokens.input, tokens.output, tokens.cachedInput, tokens.reasoningOutput, contextWindow, model])}` : null;
  const seatSession = nativeSessionId ? verifiedSeatBySession.get(nativeSessionId) ?? null : null;
  return {
    schemaVersion: 1, runtime: "codex", producer, source, sourceRecordId, dedupeKey,
    observedAt, nativeSessionId, turnId, model, seatSession,
    measurement: native ? "cumulative-snapshot" : "turn",
    tokens, contextWindow: native ? contextWindow : null,
    cost: { amountUsd: null, kind: "unavailable" },
    availability: invalidFields.length === 0 && unavailableFields.length === 0 ? "complete" : "partial",
    invalidFields, unavailableFields,
  };
}

/** Normalize a bounded batch in chronological order; detect resets and preserve provenance. */
export function collectCodexUsageHistory(rawRecords: readonly unknown[], verifiedSeatBySession: ReadonlyMap<string, string> = new Map()): CodexHistoryResult {
  const records: CodexUsageHistoryRecord[] = [];
  const seen = new Set<string>();
  let duplicateRecords = 0;
  for (const raw of rawRecords) {
    const record = decodeCodexUsageRecord(raw, verifiedSeatBySession);
    if (!record) continue;
    if (record.dedupeKey && seen.has(record.dedupeKey)) { duplicateRecords++; continue; }
    if (record.dedupeKey) seen.add(record.dedupeKey);
    records.push(record);
  }
  records.sort((a, b) => (a.observedAt ?? "").localeCompare(b.observedAt ?? "")
    || (a.measurement === "cumulative-snapshot" && b.measurement === "cumulative-snapshot"
      ? (a.tokens.input ?? -1) - (b.tokens.input ?? -1)
        || (a.tokens.output ?? -1) - (b.tokens.output ?? -1)
        || (a.dedupeKey ?? "").localeCompare(b.dedupeKey ?? "") : 0));
  const turns = records.filter(r => r.measurement === "turn" && r.nativeSessionId && r.turnId && !r.invalidFields.includes("turnId-required-for-turn-record"));
  const snapshots = records.filter(r => r.measurement === "cumulative-snapshot");
  const latest = new Map<string, CodexUsageHistoryRecord>();
  let resets = 0;
  const gaps = new Set<string>();
  for (const snap of snapshots) {
    const key = snap.nativeSessionId ?? "unknown-session";
    const prior = latest.get(key);
    if (prior && (["input", "output", "cachedInput", "reasoningOutput"] as const).some(field =>
      snap.tokens[field] !== null && prior.tokens[field] !== null && snap.tokens[field]! < prior.tokens[field]!)) {
      resets++;
      gaps.add(`counter-reset:${key}`);
    }
    if (prior?.observedAt && prior.observedAt === snap.observedAt && prior.dedupeKey !== snap.dedupeKey) {
      gaps.add(`same-timestamp-snapshots:${key}`);
    }
    if (!snap.observedAt || !snap.nativeSessionId) gaps.add("snapshot-missing-provenance");
    latest.set(key, snap);
  }
  if (records.some(r => r.invalidFields.length)) gaps.add("malformed-source-fields");
  if (records.some(r => r.observedAt === null)) gaps.add("unknown-timestamp-order");
  if (records.some(r => r.measurement === "turn" && !r.nativeSessionId)) gaps.add("unassigned-turn-session");
  if (records.some(r => r.dedupeKey === null)) gaps.add("record-without-dedupe-identity");
  if (records.some(r => r.measurement === "cumulative-snapshot" && r.tokens.input === null)) gaps.add("cumulative-usage-unavailable");
  const turnTotals = {} as CodexTokenFields;
  for (const key of ["input", "output", "cachedInput", "reasoningOutput"] as const) {
    const values = turns.map(r => r.tokens[key]);
    turnTotals[key] = values.length && values.every(v => v !== null)
      ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  }
  const overlap = snapshots.filter(s => turns.some(t => t.nativeSessionId !== null && t.nativeSessionId === s.nativeSessionId)).length;
  if (overlap) gaps.add("snapshot-turn-coverage-unverified");
  if (snapshots.length && !turns.length) gaps.add("turn-history-unavailable");
  return {
    records, turnTotals, latestSnapshots: [...latest.values()],
    coverage: { duplicateRecords, overlappingSnapshots: overlap, resets, gaps: [...gaps] },
  };
}
