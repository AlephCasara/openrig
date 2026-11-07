import { wrapDetailLines, type ContentLine } from "../detail.js";

export type Stream = "events" | "queue-transitions" | "tenures";
export type TelemetryPageResult =
  | { status: "unavailable"; reason: string }
  | { status: "available"; rows: Array<Record<string, string | null>>;
      page: { hasMore: boolean; returned: number; filtered: number; withheld: number; capReason: string | null; nextCursor: string | null };
      coverage: { status: string; historyCompleteness: string; retainedMinimum: string | null;
        gaps: Array<{ code: string; from?: string; through?: string }>; gapCount: number; gapDetailsTruncated: boolean };
      source: { hostId: string | null; bootEpoch: string | null }; observedAt: string };

export interface TelemetryRead {
  events: TelemetryPageResult;
  transitions: TelemetryPageResult;
  tenures: TelemetryPageResult;
  runtime?: RuntimeRead;
}

export type RuntimeRead = { status: "unavailable"; reason: string } | {
  status: "available";
  coverage: { status: "available" | "partial" | "unavailable"; historyCompleteness: "unknown"; gaps: string[]; totalTokens: null; billingUsd: null };
  sources: Record<"claude-otlp" | "codex-usage", { status: "available" | "partial" | "unavailable"; reason: string | null; records: number }>;
  exporter: { status: "unavailable"; reason: string };
};

const obj = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";

export function parseRuntimeSummary(raw: unknown): RuntimeRead {
  if (!obj(raw) || raw.schemaVersion !== 1 || !text(raw.rigId) || !obj(raw.coverage) || !obj(raw.sources) || !obj(raw.exporter) ||
      !["available", "partial", "unavailable"].includes(String(raw.coverage.status)) ||
      raw.coverage.historyCompleteness !== "unknown" || raw.coverage.totalTokens !== null || raw.coverage.billingUsd !== null ||
      !Array.isArray(raw.coverage.gaps) || raw.coverage.gaps.length > 128 || !raw.coverage.gaps.every(text) ||
      raw.exporter.status !== "unavailable" || !text(raw.exporter.reason) || !Array.isArray(raw.records) || raw.records.length > 128 ||
      !["claude-otlp", "codex-usage"].every(source => {
        const item = (raw.sources as Record<string, unknown>)[source];
        return obj(item) && ["available", "partial", "unavailable"].includes(String(item.status)) &&
          (item.status === "available" ? item.reason === null || text(item.reason) : text(item.reason) && item.reason.length > 0) &&
          Number.isInteger(item.records) && Number(item.records) >= 0;
      })) return { status: "unavailable", reason: "invalid runtime summary" };
  return { status: "available", coverage: raw.coverage as Extract<RuntimeRead, { status: "available" }>["coverage"],
    sources: raw.sources as Extract<RuntimeRead, { status: "available" }>["sources"],
    exporter: raw.exporter as Extract<RuntimeRead, { status: "available" }>["exporter"] };
}

/** Malformed or incomplete envelopes are unavailable; never infer zero history from them. */
export function parseTelemetryPage(raw: unknown, stream: Stream): TelemetryPageResult {
  if (!obj(raw) || raw.schemaVersion !== 1 || raw.stream !== stream || !Array.isArray(raw.rows) || raw.rows.length > 128 ||
      !obj(raw.page) || !obj(raw.coverage) || !obj(raw.source) || !text(raw.observedAt) ||
      !Array.isArray(raw.coverage.gaps) || raw.coverage.gaps.length > 32 ||
      !raw.rows.every(row => obj(row) && Object.values(row).every(value => value === null || text(value))) ||
      !raw.coverage.gaps.every(g => obj(g) && text(g.code)) ||
      !["retained_window", "partial", "unavailable"].includes(String(raw.coverage.status)) ||
      raw.coverage.historyCompleteness !== "unknown" || !Number.isInteger(raw.coverage.gapCount) ||
      !Number.isInteger(raw.page.returned) || raw.page.returned !== raw.rows.length ||
      !Number.isInteger(raw.page.filtered) || !Number.isInteger(raw.page.withheld) ||
      typeof raw.page.hasMore !== "boolean" || typeof raw.coverage.gapDetailsTruncated !== "boolean" ||
      !(raw.page.nextCursor === null || text(raw.page.nextCursor))) {
    return { status: "unavailable", reason: "invalid finite telemetry response" };
  }
  return {
    status: "available", rows: raw.rows as Array<Record<string, string | null>>,
    page: { hasMore: raw.page.hasMore, returned: raw.page.returned as number,
      filtered: raw.page.filtered as number, withheld: raw.page.withheld as number,
      capReason: text(raw.page.capReason) ? raw.page.capReason : null,
      nextCursor: raw.page.nextCursor as string | null },
    coverage: { status: raw.coverage.status as string, historyCompleteness: "unknown",
      retainedMinimum: text(raw.coverage.retainedMinimum) ? raw.coverage.retainedMinimum : null,
      gaps: raw.coverage.gaps as Array<{ code: string; from?: string; through?: string }>,
      gapCount: raw.coverage.gapCount as number, gapDetailsTruncated: raw.coverage.gapDetailsTruncated },
    source: { hostId: text(raw.source.hostId) ? raw.source.hostId : null,
      bootEpoch: text(raw.source.bootEpoch) ? raw.source.bootEpoch : null }, observedAt: raw.observedAt,
  };
}

function streamLines(name: string, result: TelemetryPageResult): ContentLine[] {
  if (result.status === "unavailable") return [{ text: `${name}: UNAVAILABLE — ${result.reason}; history unknown` }];
  const { page, coverage } = result;
  const lines: ContentLine[] = [
    { text: `${name}: ${coverage.status} · ${page.returned} rows in bounded retained sample · history ${coverage.historyCompleteness}` },
    { text: `  Retained floor: ${coverage.retainedMinimum ?? "unknown"} · ${page.hasMore ? "additional pages exist" : "no further rows in this window"}${page.capReason ? ` · ${page.capReason}` : ""}` },
  ];
  if (coverage.gapCount) {
    lines.push({ text: `  Source gaps: ${coverage.gapCount}${coverage.gapDetailsTruncated ? " (details truncated)" : ""}` });
    for (const gap of coverage.gaps.slice(0, 5)) lines.push({ text: `    ${gap.code}${gap.from ? ` from ${gap.from}` : ""}${gap.through ? ` through ${gap.through}` : ""}` });
  } else lines.push({ text: "  Source gaps: none reported for this window; older history unverified" });
  if (!result.rows.length) lines.push({ text: "  No rows returned in this finite window (not proof of no history)." });
  for (const row of result.rows.slice(0, 16)) {
    const ordinal = row.seq ?? row.transitionId ?? row.generationOrdinal ?? "?";
    const type = row.type ?? row.state ?? row.kind ?? "unknown";
    const when = row.createdAt ?? row.bootAt ?? "time unknown";
    lines.push({ text: `  #${ordinal} ${type} · ${when}` });
  }
  return lines;
}

export function telemetryLines(read: TelemetryRead | undefined, width: number): ContentLine[] {
  const lines: ContentLine[] = [{ text: "System · Telemetry (passive, finite)" },
    { text: "Retained coordination records; bounded sample, no continuous stream or complete-history claim." },
    { text: "Usage: System → Usage · Cost: System → Cost (no queue-to-cost attribution)." }, { text: "" }];
  if (!read) return wrapDetailLines([...lines, { text: "Telemetry unavailable: no daemon read yet." }], width);
  if (read.runtime?.status === "available") {
    const runtime = read.runtime;
    lines.push({ text: `Runtime coverage: ${runtime.coverage.status} · historical completeness unknown · tokens across sources unknown · billing USD unavailable` });
    for (const [label, key] of [["Claude OTLP", "claude-otlp"], ["Codex native usage", "codex-usage"]] as const) {
      const source = runtime.sources[key];
      lines.push({ text: `  ${label}: ${source.status} · ${source.records} attributed records${source.reason ? ` · ${source.reason}` : ""}` });
    }
    lines.push({ text: `Exporter health: ${runtime.exporter.status} · ${runtime.exporter.reason}` });
    for (const gap of runtime.coverage.gaps.slice(0, 8)) lines.push({ text: `  Runtime gap: ${gap}` });
  } else lines.push({ text: `Runtime sources: unavailable · ${read.runtime?.reason ?? "no runtime projection read"}; exporter status unavailable` });
  lines.push({ text: "" });
  lines.push(...streamLines("Events", read.events), { text: "" },
    ...streamLines("Queue transitions", read.transitions), { text: "" },
    ...streamLines("Seat tenures (sampled node)", read.tenures));
  return wrapDetailLines(lines, width);
}
