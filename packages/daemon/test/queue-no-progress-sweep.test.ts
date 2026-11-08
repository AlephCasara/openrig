import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { findQueueRecovery, recoveryTag } from "../src/domain/queue-recovery.js";
import {
  createQueueNoProgressDetector,
  normalizePaneForNoProgress,
  type NoProgressSample,
  type QueueNoProgressDetector,
} from "../src/domain/queue-no-progress.js";
import { findingDedupTag, runStuckSweep } from "../src/domain/queue-stuck-sweep.js";

const WINDOW_MINUTES = 20;

function frozenSample(overrides: Partial<NoProgressSample> = {}): NoProgressSample {
  const rawPane = overrides.rawPane ?? "⠋ Working (23s • esc to interrupt)\n› Ask Codex to do anything";
  return {
    runtime: "codex",
    rawPane,
    normalizedPane: normalizePaneForNoProgress(rawPane),
    paneState: "agent_active",
    paneReason: "mid_work",
    transcriptPath: "/tmp/frozen-rollout.jsonl",
    transcriptSize: 100,
    transcriptMtimeMs: 1_000,
    hookEventAt: "2026-11-08T08:00:00.000Z",
    hookSourceSequence: 7,
    hookRawEvent: "UserPromptSubmit",
    hookRawSubtype: null,
    hookState: "running",
    codexWorkingElapsed: 23,
    ...overrides,
  };
}

describe("issue #4 standing stuck sweep no-progress integration", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      loadHumanRegistry: () => ({ ok: true, entities: [] }),
    });
  });

  afterEach(() => db.close());

  async function claimedRow(destinationSession = "worker@rig"): Promise<QueueItem> {
    const row = await repo.create({ sourceSession: "lead@rig", destinationSession, body: "work" });
    repo.claim({ qitemId: row.qitemId, destinationSession });
    return repo.getById(row.qitemId)!;
  }

  function ageQueueProgress(qitemId: string, now: Date, minutes = 40): void {
    const claimedAt = new Date(now.getTime() - minutes * 60_000).toISOString();
    const createdAt = new Date(now.getTime() - (minutes + 1) * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET claimed_at = ?, ts_created = ? WHERE qitem_id = ?")
      .run(claimedAt, createdAt, qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND transition_note = 'claimed'")
      .run(claimedAt, qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND transition_note = 'created'")
      .run(createdAt, qitemId);
  }

  function findings(qitemId: string, kind: string): QueueItem[] {
    const tag = findingDedupTag(kind as never, qitemId);
    return repo.list({ limit: 500 }).filter((row) => (row.tags ?? []).includes(tag));
  }

  async function sweep(now: Date, detector: QueueNoProgressDetector, overrides: Record<string, unknown> = {}) {
    return runStuckSweep({
      db,
      queueRepo: repo,
      now,
      noProgressDetector: detector,
      resolveNoProgressWindowMinutes: () => WINDOW_MINUTES,
      resolveOrchestrator: () => null,
      resolveOperatorSeat: () => null,
      resolveRecoveryAgentSeat: () => null,
      isRegisteredHost: () => false,
      unclaimedAgeMinutes: 60,
      log: () => {},
      ...overrides,
    });
  }

  it("reports one frozen Codex turn despite fresh spinner/clock churn and deduplicates later sweeps", async () => {
    const row = await claimedRow();
    const firstNow = new Date();
    ageQueueProgress(row.qitemId, firstNow);
    let reads = 0;
    const detector = createQueueNoProgressDetector({ sample: async () => {
      reads++;
      const rawPane = reads === 1
        ? "⠋ Compacting conversation… (23s • esc to interrupt)\n› Ask Codex to do anything"
        : "⠙ Compacting conversation… (33s • esc to interrupt)\n› Ask Codex to do anything";
      return frozenSample({ rawPane, normalizedPane: normalizePaneForNoProgress(rawPane), codexWorkingElapsed: reads === 1 ? 23 : 33 });
    } });

    await sweep(firstNow, detector);
    expect(findings(row.qitemId, "no-progress")).toHaveLength(0);

    const second = await sweep(new Date(firstNow.getTime() + 10 * 60_000), detector);
    expect(second.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "no-progress", qitemId: row.qitemId, action: "created" }),
    ]));
    const [finding] = findings(row.qitemId, "no-progress");
    expect(finding).toBeDefined();
    expect(finding!.body).toContain("STUCK SWEEP FINDING (no-progress)");
    expect(finding!.body).toContain("diagnosis: compacting");

    await sweep(new Date(firstNow.getTime() + 20 * 60_000), detector);
    expect(findings(row.qitemId, "no-progress")).toHaveLength(1);
  });

  it("does not sample or report a row that is not in progress", async () => {
    const row = await repo.create({ sourceSession: "lead@rig", destinationSession: "worker@rig", body: "work" });
    const sample = vi.fn(async () => frozenSample());
    const detector = createQueueNoProgressDetector({ sample });
    await sweep(new Date(), detector);
    expect(sample).not.toHaveBeenCalled();
    expect(findings(row.qitemId, "no-progress")).toEqual([]);
  });

  it("requires both the first observation and T/2, and fails conservatively on missing runtime evidence", async () => {
    const row = await claimedRow();
    const firstNow = new Date();
    ageQueueProgress(row.qitemId, firstNow);
    const detector = createQueueNoProgressDetector({ sample: async () => frozenSample() });
    await sweep(firstNow, detector);
    await sweep(new Date(firstNow.getTime() + 9 * 60_000), detector);
    expect(findings(row.qitemId, "no-progress")).toHaveLength(0);

    const missing = createQueueNoProgressDetector({ sample: async () => frozenSample({
      transcriptPath: null, transcriptSize: null, transcriptMtimeMs: null,
    }) });
    await sweep(new Date(firstNow.getTime() + 20 * 60_000), missing);
    await sweep(new Date(firstNow.getTime() + 40 * 60_000), missing);
    expect(findings(row.qitemId, "no-progress")).toHaveLength(0);
  });

  it("routes needs-input to the operator even when a prior stalled recovery already owns source custody", async () => {
    const row = await claimedRow();
    const firstNow = new Date();
    ageQueueProgress(row.qitemId, firstNow);
    const rawPane = "Do you want to proceed?\n❯ 1. Yes\n  2. No";
    const detector = createQueueNoProgressDetector({ sample: async () => frozenSample({
      rawPane,
      normalizedPane: normalizePaneForNoProgress(rawPane),
      paneState: "attention",
      paneReason: "selection_prompt",
      hookState: "needs_input",
      hookRawEvent: "PermissionRequest",
      codexWorkingElapsed: null,
    }) });

    // First pass arms no-progress and independently creates the legacy pickup-stall recovery.
    await sweep(firstNow, detector, { resolveOperatorSeat: () => "person@external" });
    expect(findings(row.qitemId, "stalled-after-claim")).toHaveLength(1);

    await sweep(new Date(firstNow.getTime() + 10 * 60_000), detector, { resolveOperatorSeat: () => "person@external" });
    const [noProgress] = findings(row.qitemId, "no-progress");
    expect(noProgress).toBeDefined();
    expect(noProgress!.destinationSession).toBe("person@external");
    expect(noProgress!.body).toContain("diagnosis: needs-input");
    expect(findings(row.qitemId, "stalled-after-claim")).toHaveLength(1);
    expect(noProgress!.tags).not.toContain(recoveryTag(row.qitemId));
    expect(findQueueRecovery(db, row.qitemId)?.qitemId)
      .toBe(findings(row.qitemId, "stalled-after-claim")[0]!.qitemId);

    await sweep(new Date(firstNow.getTime() + 20 * 60_000), detector, { resolveOperatorSeat: () => "person@external" });
    expect(findings(row.qitemId, "no-progress")).toHaveLength(1);
  });

  it("applies longer implementer windows than orchestrator windows", async () => {
    const orch = await claimedRow("orch-lead@rig");
    const impl = await claimedRow("dev-impl@rig");
    const firstNow = new Date();
    ageQueueProgress(orch.qitemId, firstNow, 60);
    ageQueueProgress(impl.qitemId, firstNow, 60);
    const detector = createQueueNoProgressDetector({ sample: async () => frozenSample() });
    const roleWindow = (session: string) => session.startsWith("orch-") ? 10 : 30;

    await sweep(firstNow, detector, { resolveNoProgressWindowMinutes: roleWindow });
    await sweep(new Date(firstNow.getTime() + 5 * 60_000), detector, { resolveNoProgressWindowMinutes: roleWindow });

    expect(findings(orch.qitemId, "no-progress")).toHaveLength(1);
    expect(findings(impl.qitemId, "no-progress")).toHaveLength(0);
  });

  it("suppresses a long silent foreground command before its deadline", async () => {
    const row = await claimedRow();
    const firstNow = new Date();
    ageQueueProgress(row.qitemId, firstNow);
    const deadline = new Date(firstNow.getTime() + 30 * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET closure_required_at = ? WHERE qitem_id = ?").run(deadline, row.qitemId);
    const detector = createQueueNoProgressDetector({ sample: async () => frozenSample({
      hookRawEvent: "PreToolUse",
      hookRawSubtype: "Bash",
      hookState: "running",
      runningCommandProcessId: "102:Sun Nov  8 07:55:01 2026",
      codexWorkingElapsed: null,
    }) });
    await sweep(firstNow, detector);
    await sweep(new Date(firstNow.getTime() + 10 * 60_000), detector);
    expect(findings(row.qitemId, "no-progress")).toHaveLength(0);
  });

  it("auto-closes an open no-progress finding when runtime progress resumes", async () => {
    const row = await claimedRow();
    const firstNow = new Date();
    ageQueueProgress(row.qitemId, firstNow);
    let size = 100;
    const detector = createQueueNoProgressDetector({ sample: async () => frozenSample({ transcriptSize: size }) });

    await sweep(firstNow, detector);
    await sweep(new Date(firstNow.getTime() + 10 * 60_000), detector);
    const [finding] = findings(row.qitemId, "no-progress");
    expect(finding?.state).toBe("pending");

    size = 101;
    await sweep(new Date(firstNow.getTime() + 20 * 60_000), detector);
    expect(repo.getById(finding!.qitemId)?.state).toBe("done");
    expect(repo.listTransitions(finding!.qitemId).at(-1)?.transitionNote).toContain("runtime progress resumed");
  });
});
