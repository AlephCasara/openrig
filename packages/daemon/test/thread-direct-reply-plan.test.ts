import { describe, expect, it } from "vitest";
import { planThreadDirectReply } from "../src/domain/thread-direct-reply-plan.js";
import type { ThreadOwner } from "../src/domain/queue-thread-owner.js";
const owner = (seat: string, mission: string | null): ThreadOwner => ({ seat, mission, qitemId: "source-row", tsCreated: "2026-01-01T00:00:00Z" });

describe("opt-in Slack thread direct reply plan (#12 offline)", () => {
  it("routes one open owner once with mission tag and deduplication reference", () => {
    const result = planThreadDirectReply([owner("worker@rig", "design")], "front@rig", "T.123", "171.55", true);
    expect(result).toEqual({ kind: "owned", destination: "worker@rig", tags: ["thread:T.123", "mission:design"], dedupeKey: "slack:171.55" });
  });
  it("falls back to front with no owner or when disabled, never treating closed history as an owner", () => {
    expect(planThreadDirectReply([], "front@rig", "T.123", "171.55", true)).toMatchObject({ kind: "front", destination: "front@rig" });
    expect(planThreadDirectReply([owner("worker@rig", "design")], "front@rig", "T.123", "171.55", false)).toMatchObject({ kind: "front", destination: "front@rig" });
  });
  it("refuses to guess when multiple seats own the thread", () => {
    expect(planThreadDirectReply([owner("a@rig", "x"), owner("b@rig", "y")], "front@rig", "T.123", "171.55", true)).toMatchObject({ kind: "front", destination: "front@rig", reason: "ambiguous_owner" });
  });
  it("rejects an empty Slack event ID before minting a dedupe key", () => {
    expect(() => planThreadDirectReply([], "front@rig", "T.123", "", true)).toThrow();
  });
});
