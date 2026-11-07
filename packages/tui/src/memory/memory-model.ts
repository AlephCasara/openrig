import { sectionRule, wrapDetailLines, type ContentLine } from "../detail.js";

export interface MemorySeat {
  sessionName: string;
  rigId: string;
  state: string;
  availability: "available" | "unavailable" | "unsupported";
  reason: string | null;
  observed: { bytesCurrent: number; bytesLimit: number | null; swapBytesCurrent?: number; source: "cgroup-v2" } | null;
}
export interface MemoryBody { schemaVersion: 1; sampledAt: string; host: string; seats: MemorySeat[] }
export interface MemoryRead { status: { body: MemoryBody } | { status: number | null; error: string } }

const bytes = (n: number) => `${(n / 1048576).toFixed(1)} MiB`;
export const memorySeatKey = (seat: MemorySeat) => `${seat.rigId}/${seat.sessionName}`;
export function memoryLines(read: MemoryRead | undefined, width: number, selected: string | null): ContentLine[] {
  const lines: ContentLine[] = [{ text: "System · Memory (per-seat cgroup)" }, { text: "  Passive daemon sample · no collector or cap changes" }];
  if (!read) return wrapDetailLines([...lines, { text: "  Not read yet." }], width);
  if (!("body" in read.status)) return wrapDetailLines([...lines, { text: `  Memory unavailable: ${read.status.error} (HTTP ${read.status.status ?? "no response"}); no metrics inferred.` }], width);
  const { host, sampledAt, seats } = read.status.body;
  lines.push({ text: `  Host: ${host} · sampled at ${sampledAt}` }, sectionRule(`Seats · ${seats.length}`, width));
  if (!seats.length) lines.push({ text: "  No seats in this sample." });
  const ordered = [...seats].sort((a, b) => memorySeatKey(a).localeCompare(memorySeatKey(b)));
  for (const seat of ordered) {
    const key = memorySeatKey(seat);
    const observed = seat.observed;
    const summary = observed
      ? `current ${bytes(observed.bytesCurrent)} · limit ${observed.bytesLimit === null ? "unlimited" : bytes(observed.bytesLimit)}`
      : `${seat.availability}: ${seat.reason}`;
    lines.push({ text: `  ${selected === key ? "▸" : "›"} ${seat.sessionName} (${seat.rigId}) · ${summary}`, action: { type: "memory-select", key } });
    if (selected !== key) continue;
    lines.push({ text: `    Seat state: ${seat.state} · availability: ${seat.availability}` });
    if (observed) {
      lines.push({ text: `    Memory: ${bytes(observed.bytesCurrent)} (${observed.bytesCurrent} bytes)` });
      lines.push({ text: `    Limit: ${observed.bytesLimit === null ? "unlimited" : `${bytes(observed.bytesLimit)} (${observed.bytesLimit} bytes)`}` });
      lines.push({ text: `    Swap: ${observed.swapBytesCurrent === undefined ? "not reported" : `${bytes(observed.swapBytesCurrent)} (${observed.swapBytesCurrent} bytes)`}` });
      lines.push({ text: `    Source: ${observed.source} · sample: ${sampledAt}` });
    } else lines.push({ text: `    Reason: ${seat.reason} · sample: ${sampledAt}` });
  }
  return wrapDetailLines(lines, width);
}
