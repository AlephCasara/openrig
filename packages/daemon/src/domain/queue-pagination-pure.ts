/** Pure keyset pagination over an already sorted immutable snapshot.
 * This is a fixture-friendly projection, not the daemon endpoint or DB query.
 * Real endpoints must bind cursors to snapshot identity to avoid live-list drift. */
export interface StablePage<T> { items: T[]; nextCursor: string | null }
export interface StablePageRequest { cursor: string | null; limit: number }

export function pageByStableKey<T>(
  rows: readonly T[], request: StablePageRequest, key: (row: T) => string,
): StablePage<T> {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1000) {
    throw new Error("pagination limit must be an integer between 1 and 1000");
  }
  if (request.cursor !== null && (!request.cursor || typeof request.cursor !== "string")) {
    throw new Error("invalid pagination cursor");
  }
  const keys = rows.map(key);
  for (let i = 0; i < keys.length; i++) {
    if (!keys[i] || (i > 0 && keys[i]! <= keys[i - 1]!)) throw new Error("non-unique or unordered page snapshot");
  }
  const cursorPos = request.cursor === null ? -1 : keys.indexOf(request.cursor);
  if (request.cursor !== null && cursorPos < 0) throw new Error("pagination cursor does not exist in snapshot");
  const start = cursorPos + 1;
  const items = rows.slice(start, start + request.limit);
  const more = start + items.length < rows.length;
  return { items, nextCursor: more ? keys[start + items.length - 1]! : null };
}
