// Optional in-daemon Buzz GatewayWire. Construction is offline; its CLI and
// authenticated history poller start only from GatewayWire.startServices().
import { getPublicKey } from "nostr-tools/pure";
import type { QueueRepository } from "../../queue-repository.js";
import { humanAnswerText } from "../../human-questions.js";
import { loadHumanRegistry } from "../human-registry.js";
import { sharedChannelAddresses } from "../participants.js";
import { makeQueuePorts } from "../slack/queue-access.js";
import type { GatewayWire } from "../gateway-subsystem.js";
import type { BuzzGatewaySettings } from "../provider-selection.js";
import { BuzzCliClient } from "../buzz-cli.js";
import { BuzzVerifiedHistoryClient } from "./verified-history.js";
import { buildRegisteredBuzzOutboundLabWire, type RegisteredBuzzInboundOpts, recoverRegisteredBuzzInbox } from "./registry-context.js";

export interface BuzzReplyActionPort {
  act(input: { verb: "resolve"; qitemId: string; actorSession: string; decision: string; answerText?: string }): Promise<unknown>;
}

export interface BuzzGatewayWireOpts {
  home: string;
  settings: BuzzGatewaySettings;
  queueRepo: QueueRepository;
  humanReplyActions?: BuzzReplyActionPort;
  pollIntervalMs?: number;
  log?: (message: string) => void;
}

type PollState = "not-started" | "polling" | "healthy" | "degraded" | "stopped";

/** Resolve a verified Buzz reply using the same typed-answer and approval boundary as Slack. */
export function makeBuzzHumanReplyResolver(
  queueRepo: QueueRepository,
  contract: BuzzReplyActionPort | undefined,
): NonNullable<RegisteredBuzzInboundOpts["resolveHumanReply"]> {
  return async (input) => {
    const source = queueRepo.getById(input.qitemId);
    if (!contract || !source || source.humanIntent === "update") return "not-applicable";
    const humanPark = source.state === "blocked" && !!source.blockedOn
      && queueRepo.isPersonAddress(source.blockedOn);
    if (!humanPark) {
      return queueRepo.resolveDirectHumanReply(input)
        ? "resolved"
        : "not-applicable";
    }

    const episode = queueRepo.currentHumanRequiredEpisode(input.qitemId);
    if (!episode || !input.rootNotificationKey || episode.key !== input.rootNotificationKey) {
      return "not-applicable";
    }
    if (input.rootCreatedAt !== undefined && input.replyCreatedAt < input.rootCreatedAt) return "not-applicable";
    const uncertain = input.rootCreatedAt === undefined || input.replyCreatedAt === input.rootCreatedAt;
    const parkedOnAsked = queueRepo.isPersonAddress(source.destinationSession)
      && queueRepo.answersAsk(source, input.actorSession);
    const decision = uncertain
      ? `${input.decision}\n\n---\nOpenRig timing context (Buzz reply ${JSON.stringify([input.actorSession, input.replyEventId])}): This reply resumed the question, but its ordering against the posted question could not be confirmed. Resuming is not approval; read the person's words in context.`
      : input.decision;
    const winner = queueRepo.committedAnswerFromAnother(input.qitemId, input.actorSession, episode.key);
    try {
      if (winner) {
        const words = humanAnswerText(winner.body);
        await contract.act({
          verb: "resolve", qitemId: input.qitemId, actorSession: winner.sourceSession, decision: words,
          ...(queueRepo.isPersonAddress(source.destinationSession)
            && queueRepo.answersAsk(source, winner.sourceSession) && !uncertain ? { answerText: words } : {}),
        });
        return "not-applicable";
      }
      await contract.act({
        verb: "resolve", qitemId: input.qitemId, actorSession: input.actorSession, decision,
        ...(parkedOnAsked && !uncertain ? { answerText: input.decision } : {}),
      });
      return uncertain ? "resolved-uncertain" : "resolved";
    } catch (error) {
      if ((error as { code?: string }).code !== "qitem_not_leg1_parked") throw error;
      const alreadyResolved = queueRepo.transitionLog.listForQitem(input.qitemId)
        .some((transition) => transition.ownerNotificationKind === "human-decision-resolved");
      return alreadyResolved ? "already-resolved" : "not-applicable";
    }
  };
}

/** Build the optional Buzz transport without starting a process or making a network request. */
export function buildBuzzGatewayWire(opts: BuzzGatewayWireOpts): GatewayWire {
  const privateKeyHex = process.env.BUZZ_PRIVATE_KEY?.trim() ?? "";
  if (!/^[0-9a-f]{64}$/.test(privateKeyHex)) throw new Error("BUZZ_PRIVATE_KEY must be 64 lowercase hex characters");
  const publicKey = getPublicKey(Uint8Array.from(Buffer.from(privateKeyHex, "hex")));
  const intervalMs = opts.pollIntervalMs ?? 30_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 120_000) {
    throw new Error("Buzz inbound poll interval must be between 1000 and 120000 ms");
  }

  const queue = makeQueuePorts(opts.queueRepo, {
    loadHumanRegistry: () => loadHumanRegistry(opts.home, { readOnly: true }),
    sharedChannels: () => sharedChannelAddresses(opts.home),
    provider: "buzz",
  });
  const client = new BuzzCliClient({ binary: opts.settings.binaryPath, relayUrl: opts.settings.relayUrl });
  const history = new BuzzVerifiedHistoryClient({ relayUrl: opts.settings.relayUrl, privateKeyHex });
  const outbound = buildRegisteredBuzzOutboundLabWire({
    home: opts.home,
    channelId: opts.settings.channelId,
    expectedPubkey: publicKey,
    queue,
    transport: client,
    log: opts.log,
  });
  const inboundOpts: Omit<RegisteredBuzzInboundOpts, "transport"> = {
    home: opts.home,
    channelId: opts.settings.channelId,
    selfPubkey: publicKey,
    queue: {
      createQitem: queue.createQitem,
      getQitem: (qitemId) => queue.getQitem?.(qitemId) ?? null,
    },
    ...(opts.humanReplyActions ? {
      resolveHumanReply: makeBuzzHumanReplyResolver(opts.queueRepo, opts.humanReplyActions),
    } : {}),
  };
  let state: PollState = "not-started";
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let lastPollAt: string | undefined;
  let lastError: string | undefined;
  let lastResult: { accepted: number; ignored: number; scanned: number; pages: number } | undefined;

  const poll = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      state = "polling";
      try {
        const result = await recoverRegisteredBuzzInbox(inboundOpts, history, { pageSize: 200, maxPages: 10 });
        if (stopped) return;
        lastPollAt = new Date().toISOString();
        lastResult = { accepted: result.accepted, ignored: result.ignored, scanned: result.scanned, pages: result.pages };
        if (result.ok) {
          state = "healthy";
          lastError = undefined;
        } else {
          state = "degraded";
          lastError = result.reason ?? "Buzz history recovery incomplete";
        }
      } catch (error) {
        if (stopped) return;
        state = "degraded";
        lastPollAt = new Date().toISOString();
        lastError = (error as Error).message;
        opts.log?.(`Buzz inbound poll failed: ${lastError}`);
      }
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  };

  return {
    dispatcher: outbound.dispatcher,
    startServices: () => {
      if (state !== "not-started" && state !== "stopped") return;
      stopped = false;
      state = "polling";
      outbound.startServices?.();
      void poll();
      timer = setInterval(() => { if (!stopped) void poll(); }, intervalMs);
      timer.unref?.();
    },
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      outbound.stop();
      state = "stopped";
    },
    status: () => ({
      ...outbound.status?.(),
      platform: "buzz",
      mode: "optional-transport",
      productionReady: false,
      inboundReady: true,
      inbound: { state, ...(lastPollAt ? { lastPollAt } : {}), ...(lastError ? { lastError } : {}), ...(lastResult ? lastResult : {}) },
    }),
  };
}
