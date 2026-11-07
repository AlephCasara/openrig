/** Claude Code OTLP/HTTP JSON log export adapter, contract v1. No IO or attribution heuristics. */
export interface ClaudeOtlpRequestV1 {
  schemaVersion: 1;
  runtime: "claude-code";
  producer: "claude-code-otlp";
  source: "otlp-http-json-log";
  eventName: "api_request" | "claude_code.api_request";
  /** Stable only when Claude exports a request_id; null means no dedupe key is available. */
  sourceId: string | null;
  dedupeKey: string | null;
  /** Position within this envelope, retained so duplicates are independently observable. */
  recordIndex: number;
  eventTimestamp: string | null;
  eventTimestampSource: "event.timestamp" | "timeUnixNano" | "unavailable";
  observedTimestamp: string | null;
  sessionId: string | null;
  /** Supplied and verified by the caller; never inferred from OTLP resource hints. */
  seatId: string | null;
  model: string | null;
  modelSource: "attribute" | "unavailable";
  querySource: string | null;
  tokens: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheCreation: number | null;
  };
  /** Claude Code's reported/list-price estimate, not provider billing or an invoice. */
  reportedCostUsd: number | null;
  costBasis: "claude-code-reported-list-price-estimate";
  /** Invalid data remains unavailable and the affected field is identified here. */
  invalidFields: string[];
  availability: "partial" | "complete";
  unavailableFields: string[];
}

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : null;
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const nonempty = (v: unknown): string | null => typeof v === "string" && v.trim() ? v : null;

/** Decode scalar OTLP AnyValue fields only; arrays/maps and arbitrary fields never enter results. */
function scalar(v: unknown): unknown {
  const o = object(v);
  if (!o) return undefined;
  if (typeof o.stringValue === "string") return o.stringValue;
  if (typeof o.intValue === "string" || typeof o.intValue === "number") return o.intValue;
  if (typeof o.doubleValue === "number") return o.doubleValue;
  if (typeof o.boolValue === "boolean") return o.boolValue;
  return undefined;
}

function attributes(v: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const entry of array(v)) {
    const a = object(entry);
    if (a && nonempty(a.key) && !out.has(a.key as string)) out.set(a.key as string, scalar(a.value));
  }
  return out;
}

function nanosToIso(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try {
    const n = BigInt(value);
    if (n <= 0n) return null;
    const ms = n / 1_000_000n;
    if (ms > 8_640_000_000_000_000n) return null;
    const date = new Date(Number(ms));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch { return null; }
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function count(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function cost(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function first(map: Map<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (map.has(key)) return map.get(key);
  return undefined;
}

/** Explicit trusted attribution supplied separately from untrusted resource attributes. */
export function extractClaudeOtlpApiRequests(envelope: unknown, verifiedSeatId: string | null = null): ClaudeOtlpRequestV1[] {
  const result: ClaudeOtlpRequestV1[] = [];
  let recordIndex = 0;
  for (const resource of array(object(envelope)?.resourceLogs)) {
    const resourceObj = object(resource);
    const resourceAttrs = attributes(object(resourceObj?.resource)?.attributes);
    for (const scope of array(resourceObj?.scopeLogs)) {
      for (const rawRecord of array(object(scope)?.logRecords)) {
        const index = recordIndex++;
        const record = object(rawRecord);
        if (!record) continue;
        const attrs = attributes(record.attributes);
        const name = first(attrs, "event.name", "event_name");
        if (name !== "api_request" && name !== "claude_code.api_request") continue;
        const invalidFields: string[] = [];
        const readCount = (field: string, ...keys: string[]): number | null => {
          const raw = first(attrs, ...keys);
          const parsed = count(raw);
          if (raw !== undefined && parsed === null) invalidFields.push(field);
          return parsed;
        };
        const sourceId = nonempty(first(attrs, "request_id", "request.id"));
        const model = nonempty(first(attrs, "model", "model_name"));
        const querySource = nonempty(first(attrs, "query_source"));
        const rawCost = first(attrs, "cost_usd");
        const reportedCostUsd = cost(rawCost);
        if (rawCost !== undefined && reportedCostUsd === null) invalidFields.push("cost_usd");
        const tokens = {
          input: readCount("input_tokens", "input_tokens"),
          output: readCount("output_tokens", "output_tokens"),
          cacheRead: readCount("cache_read_tokens", "cache_read_tokens"),
          cacheCreation: readCount("cache_creation_tokens", "cache_creation_tokens"),
        };
        const explicitTimestamp = first(attrs, "event.timestamp");
        const parsedExplicitTimestamp = isoTimestamp(explicitTimestamp);
        const recordTimestamp = nanosToIso(record.timeUnixNano);
        const eventTimestamp = parsedExplicitTimestamp ?? recordTimestamp;
        const eventTimestampSource = parsedExplicitTimestamp !== null ? "event.timestamp" : recordTimestamp !== null ? "timeUnixNano" : "unavailable";
        const observedTimestamp = nanosToIso(record.observedTimeUnixNano);
        if (explicitTimestamp !== undefined && parsedExplicitTimestamp === null) invalidFields.push("event.timestamp");
        if (record.timeUnixNano !== undefined && recordTimestamp === null) invalidFields.push("timeUnixNano");
        if (record.observedTimeUnixNano !== undefined && observedTimestamp === null) invalidFields.push("observedTimeUnixNano");
        const sessionId = nonempty(first(attrs, "session.id", "session_id")) ?? nonempty(first(resourceAttrs, "session.id", "session_id"));
        result.push({
          schemaVersion: 1, runtime: "claude-code", producer: "claude-code-otlp", source: "otlp-http-json-log",
          eventName: name, sourceId, dedupeKey: sourceId === null ? null : `claude-code:api_request:${sourceId}`,
          recordIndex: index, eventTimestamp, eventTimestampSource, observedTimestamp, sessionId,
          seatId: nonempty(verifiedSeatId), model, modelSource: model === null ? "unavailable" : "attribute", querySource,
          tokens, reportedCostUsd, costBasis: "claude-code-reported-list-price-estimate", invalidFields,
          availability: invalidFields.length === 0 && sourceId !== null && model !== null && reportedCostUsd !== null &&
            eventTimestamp !== null && Object.values(tokens).every(v => v !== null) ? "complete" : "partial",
          unavailableFields: [
            ...((sourceId === null) ? ["request_id"] : []),
            ...((eventTimestamp === null) ? ["timeUnixNano"] : []),
            ...((observedTimestamp === null) ? ["observedTimeUnixNano"] : []),
            ...((sessionId === null) ? ["session_id"] : []),
            ...((model === null) ? ["model"] : []),
            ...((querySource === null) ? ["query_source"] : []),
            ...((reportedCostUsd === null) ? ["cost_usd"] : []),
            ...Object.entries(tokens).filter(([, value]) => value === null).map(([key]) => `tokens.${key}`),
          ],
        });
      }
    }
  }
  return result;
}
