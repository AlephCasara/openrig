import { describe, expect, it, vi } from "vitest";
import type { QueueRepository } from "../src/domain/queue-repository.js";
import { makeBuzzHumanReplyResolver } from "../src/domain/gateway/buzz/buzz-gateway.js";

const root = {
  qitemId: "q-1", actorSession: "jane@external", decision: "Use option B",
  replyEventId: "a".repeat(64), replyCreatedAt: 200,
  rootNotificationKey: "q-1:episode-1", rootCreatedAt: 100,
};

function harness(overrides: Record<string, unknown> = {}) {
  const act = vi.fn(async () => ({}));
  const queueRepo = {
    getById: () => ({ qitemId: "q-1", state: "blocked", blockedOn: "jane@external", destinationSession: "jane@external", humanIntent: "ask" }),
    isPersonAddress: (address: string) => address.includes("@"),
    answersAsk: () => true,
    currentHumanRequiredEpisode: () => ({ key: "q-1:episode-1" }),
    committedAnswerFromAnother: () => null,
    resolveDirectHumanReply: () => false,
    transitionLog: { listForQitem: () => [] },
    ...overrides,
  } as unknown as QueueRepository;
  return { resolver: makeBuzzHumanReplyResolver(queueRepo, { act }), act };
}

describe("Buzz GatewayWire human reply resolution", () => {
  it("stores a later verified reply as typed answer while keeping approval separate", async () => {
    const { resolver, act } = harness();
    await expect(resolver(root)).resolves.toBe("resolved");
    expect(act).toHaveBeenCalledWith(expect.objectContaining({
      verb: "resolve", qitemId: "q-1", actorSession: "jane@external", answerText: "Use option B",
    }));
  });

  it("resumes without storing an answer when root and reply share a second", async () => {
    const { resolver, act } = harness();
    await expect(resolver({ ...root, rootCreatedAt: 200 })).resolves.toBe("resolved-uncertain");
    const call = act.mock.calls[0]?.[0];
    expect(call).not.toHaveProperty("answerText");
    expect(call?.decision).toContain("not approval");
  });

  it("refuses replies before the posted root or from a stale notification episode", async () => {
    const { resolver, act } = harness();
    await expect(resolver({ ...root, replyCreatedAt: 99 })).resolves.toBe("not-applicable");
    await expect(resolver({ ...root, rootNotificationKey: "q-1:episode-old" })).resolves.toBe("not-applicable");
    expect(act).not.toHaveBeenCalled();
  });

  it("routes direct human asks through the repository resolver", async () => {
    const resolveDirectHumanReply = vi.fn(() => true);
    const { resolver, act } = harness({
      getById: () => ({ qitemId: "q-1", state: "pending", destinationSession: "jane@external", humanIntent: "ask" }),
      resolveDirectHumanReply,
    });
    await expect(resolver(root)).resolves.toBe("resolved");
    expect(resolveDirectHumanReply).toHaveBeenCalledWith(expect.objectContaining({ qitemId: "q-1" }));
    expect(act).not.toHaveBeenCalled();
  });
});
