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
}

const obj = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";

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
    { text: "Sources: Claude OTLP — availability unverified; Codex native usage — availability unverified." },
    { text: "No exporter status or runtime token completeness is established by these records." },
    { text: "Usage: System → Usage · Cost: System → Cost (no queue-to-cost attribution)." }, { text: "" }];
  if (!read) return wrapDetailLines([...lines, { text: "Telemetry unavailable: no daemon read yet." }], width);
  lines.push(...streamLines("Events", read.events), { text: "" },
    ...streamLines("Queue transitions", read.transitions), { text: "" },
    ...streamLines("Seat tenures (sampled node)", read.tenures));
  return wrapDetailLines(lines, width);
}
