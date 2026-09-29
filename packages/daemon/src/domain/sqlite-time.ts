/** Epoch ms for a SQLite `datetime('now')` stamp ("YYYY-MM-DD HH:MM:SS", UTC, no zone marker).
 * A bare Date.parse reads that form as LOCAL time, skewing it by the host's UTC offset.
 * Values that already carry a zone (ISO with Z or ±HH:MM) parse unchanged. NaN when unparseable. */
export function parseSqliteUtcMs(value: string): number {
  return Date.parse(/Z$|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
}
