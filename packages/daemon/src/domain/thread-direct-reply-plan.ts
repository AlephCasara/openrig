import type { ThreadOwner } from "./queue-thread-owner.js";

/** Pure opt-in route intent, never an authorization. The gateway must persist
 * dedupeKey atomically with its queue insert to guarantee exactly-once delivery. */
export type ThreadReplyPlan = {
  kind: "owned" | "front";
  destination: string;
  tags: string[];
  dedupeKey: string;
  reason?: "disabled" | "no_owner" | "ambiguous_owner";
};

export function planThreadDirectReply(
  owners: readonly ThreadOwner[], frontSeat: string, threadRoot: string,
  eventId: string, enabled: boolean,
): ThreadReplyPlan {
  if (![frontSeat, threadRoot, eventId].every(v => typeof v === "string" && v.trim().length > 0)) {
    throw new Error("missing Slack thread routing identity");
  }
  const dedupeKey = `slack:${eventId}`;
  if (!enabled || owners.length !== 1 || !owners[0]?.seat) {
    return { kind: "front", destination: frontSeat, tags: [`thread:${threadRoot}`], dedupeKey,
      reason: !enabled ? "disabled" : owners.length === 0 ? "no_owner" : "ambiguous_owner" };
  }
  const owner = owners[0];
  return { kind: "owned", destination: owner.seat, tags: [`thread:${threadRoot}`,
    ...(owner.mission ? [`mission:${owner.mission}`] : [])], dedupeKey };
}
