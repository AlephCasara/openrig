import { describe, expect, it } from "vitest";
import { pageByStableKey } from "../src/domain/queue-pagination-pure.js";

describe("queue pagination on stable ordering (#25 offline)", () => {
  const rows = Array.from({ length: 5_000 }, (_, i) => ({ id: `row-${String(i).padStart(5, "0")}`, value: i }));
  it("pages a 5000-row list without loss, duplicate or full-size response", () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const p = pageByStableKey(rows, { cursor, limit: 250 }, row => row.id);
      expect(p.items.length).toBeLessThanOrEqual(250);
      seen.push(...p.items.map(x => x.id));
      cursor = p.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(rows.map(r => r.id));
  });
  it("refuses invalid limits and unrecognized cursors without silently restarting", () => {
    expect(() => pageByStableKey(rows, { cursor: null, limit: 0 }, row => row.id)).toThrow();
    expect(() => pageByStableKey(rows, { cursor: null, limit: 5001 }, row => row.id)).toThrow();
    expect(() => pageByStableKey(rows, { cursor: "missing", limit: 100 }, row => row.id)).toThrow();
  });
  it("refuses unstable input or duplicates", () => {
    expect(() => pageByStableKey([{ id: "b" }, { id: "a" }], { cursor: null, limit: 2 }, r => r.id)).toThrow();
    expect(() => pageByStableKey([{ id: "a" }, { id: "a" }], { cursor: null, limit: 2 }, r => r.id)).toThrow();
  });
  it("returns terminal cursor for a completed page and empty list", () => {
    expect(pageByStableKey(rows.slice(0, 2), { cursor: null, limit: 2 }, r => r.id).nextCursor).toBe(null);
    expect(pageByStableKey([], { cursor: null, limit: 20 }, (r: { id: string }) => r.id)).toEqual({ items: [], nextCursor: null });
  });
});
