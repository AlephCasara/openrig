import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, appendFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createQueueNoProgressDetector,
  createRuntimeQueueNoProgressDetector,
  normalizePaneForNoProgress,
  readCodexTurnFailure,
  type NoProgressSample,
} from "../src/domain/queue-no-progress.js";

const BASE = Date.parse("2026-11-08T08:00:00.000Z");

function sample(overrides: Partial<NoProgressSample> = {}): NoProgressSample {
  return {
    runtime: "codex",
    rawPane: "• Working (23s • esc to interrupt)\n› Ask Codex to do anything",
    normalizedPane: normalizePaneForNoProgress("• Working (23s • esc to interrupt)\n› Ask Codex to do anything"),
    paneState: "agent_active",
    paneReason: "mid_work",
    transcriptPath: "/tmp/rollout.jsonl",
    transcriptSize: 100,
    transcriptMtimeMs: 1_000,
    hookEventAt: "2026-11-08T07:55:00.000Z",
    hookSourceSequence: 7,
    hookRawEvent: "UserPromptSubmit",
    hookRawSubtype: null,
    hookState: "running",
    codexWorkingElapsed: 23,
    ...overrides,
  };
}

function input(nowMs: number, extra: Record<string, unknown> = {}) {
  return {
    qitemId: "qitem-work",
    destinationSession: "dev-impl@rig",
    state: "in-progress" as const,
    lastMeaningfulAt: "2026-11-08T07:30:00.000Z",
    closureRequiredAt: null,
    now: new Date(nowMs),
    windowMinutes: 20,
    ...extra,
  };
}

describe("queue no-progress detector", () => {
  it("normalizes spinner and clock churn without erasing semantic pane changes", () => {
    const a = normalizePaneForNoProgress("⠋ Working\n• Working (23s • esc to interrupt)\n08:12:03 waiting");
    const b = normalizePaneForNoProgress("⠙ Working\n• Working (24s • esc to interrupt)\n08:12:04 waiting");
    expect(a).toBe(b);
    expect(normalizePaneForNoProgress("• Reading file A")).not.toBe(normalizePaneForNoProgress("• Reading file B"));
  });

  it("arms on the first sample and requires T/2 before reporting", async () => {
    const read = vi.fn(async () => sample());
    const detector = createQueueNoProgressDetector({ sample: read });

    expect(await detector.inspect(input(BASE))).toMatchObject({ state: "inconclusive", reason: "first_sample" });
    expect(await detector.inspect(input(BASE + 9 * 60_000))).toMatchObject({ state: "inconclusive", reason: "sample_interval" });
    expect(await detector.inspect(input(BASE + 10 * 60_000))).toMatchObject({ state: "finding", diagnosis: "unknown" });
  });

  it("treats transcript, hook, or semantic pane movement as positive progress", async () => {
    for (const changed of [
      sample({ transcriptSize: 101 }),
      sample({ hookEventAt: "2026-11-08T08:01:00.000Z", hookSourceSequence: 8 }),
      sample({ rawPane: "• Edited file A\n› Ask Codex", normalizedPane: normalizePaneForNoProgress("• Edited file A\n› Ask Codex") }),
    ]) {
      const read = vi.fn()
        .mockResolvedValueOnce(sample())
        .mockResolvedValueOnce(changed);
      const detector = createQueueNoProgressDetector({ sample: read });
      await detector.inspect(input(BASE));
      expect(await detector.inspect(input(BASE + 10 * 60_000))).toMatchObject({ state: "healthy", reason: "runtime_progress" });
    }
  });

  it("does not treat a freshness-only hook state change as runtime progress", async () => {
    const first = sample({ hookState: "running", hookStale: false });
    const second = sample({ hookState: "unknown", hookStale: true, hookReason: "stale_runtime_hook" });
    const detector = createQueueNoProgressDetector({
      sample: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
    });
    await detector.inspect(input(BASE));
    expect(await detector.inspect(input(BASE + 10 * 60_000)))
      .toMatchObject({ state: "finding", diagnosis: "unknown" });
  });

  it("does not mistake an advancing Codex working clock for progress", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(sample({ codexWorkingElapsed: 23 }))
      .mockResolvedValueOnce(sample({ codexWorkingElapsed: 33 }));
    const detector = createQueueNoProgressDetector({ sample: read });
    await detector.inspect(input(BASE));
    expect(await detector.inspect(input(BASE + 10 * 60_000))).toMatchObject({ state: "finding" });
  });

  it("fails conservatively when runtime evidence is incomplete", async () => {
    const detector = createQueueNoProgressDetector({
      sample: async () => sample({ transcriptPath: null, transcriptSize: null, transcriptMtimeMs: null }),
    });
    expect(await detector.inspect(input(BASE))).toMatchObject({ state: "inconclusive", reason: "missing_runtime_signal" });
    expect(await detector.inspect(input(BASE + 20 * 60_000))).toMatchObject({ state: "inconclusive", reason: "missing_runtime_signal" });
  });

  it("fails conservatively when the queue has no meaningful progress anchor", async () => {
    const detector = createQueueNoProgressDetector({ sample: async () => sample() });
    expect(await detector.inspect(input(BASE, { lastMeaningfulAt: null })))
      .toMatchObject({ state: "inconclusive", reason: "missing_runtime_signal" });
    expect(detector.observationCount()).toBe(0);
  });

  it("classifies needs-input before other states", async () => {
    const read = vi.fn(async () => sample({
      rawPane: "Do you want to proceed?\n❯ 1. Yes\n  2. No",
      normalizedPane: normalizePaneForNoProgress("Do you want to proceed?\n❯ 1. Yes\n  2. No"),
      paneState: "attention",
      paneReason: "selection_prompt",
      hookState: "needs_input",
      hookRawEvent: "PermissionRequest",
      codexWorkingElapsed: null,
    }));
    const detector = createQueueNoProgressDetector({ sample: read });
    await detector.inspect(input(BASE));
    expect(await detector.inspect(input(BASE + 10 * 60_000))).toMatchObject({ state: "finding", diagnosis: "needs-input" });
  });

  it("classifies compaction and explicit failed/aborted turns", async () => {
    for (const [pane, paneState, diagnosis, hookRawEvent] of [
      ["✻ Compacting conversation…", "agent_active", "compacting", "UserPromptSubmit"],
      ["Turn failed\n› Ask Codex to do anything", "agent_idle", "dead-turn", "StopFailure"],
    ] as const) {
      const read = vi.fn(async () => sample({
        rawPane: pane,
        normalizedPane: normalizePaneForNoProgress(pane),
        paneState,
        hookState: diagnosis === "dead-turn" ? "idle" : "running",
        hookRawEvent,
        codexWorkingElapsed: null,
      }));
      const detector = createQueueNoProgressDetector({ sample: read });
      await detector.inspect(input(BASE));
      expect(await detector.inspect(input(BASE + 10 * 60_000))).toMatchObject({ state: "finding", diagnosis });
    }
  });

  it("ignores completed historical compaction text when current status is working", async () => {
    const pane = "✻ Compacting conversation…\nCompaction complete\n• Working (23s • esc to interrupt)";
    const detector = createQueueNoProgressDetector({ sample: async () => sample({
      rawPane: pane,
      normalizedPane: normalizePaneForNoProgress(pane),
    }) });
    await detector.inspect(input(BASE));
    expect(await detector.inspect(input(BASE + 10 * 60_000)))
      .toMatchObject({ state: "finding", diagnosis: "unknown" });
  });

  it("reads native Codex failures only from the latest relevant turn after the row anchor", () => {
    const directory = mkdtempSync(join(tmpdir(), "openrig-no-progress-events-"));
    const rollout = join(directory, "rollout.jsonl");
    const event = (at: string, type: string, error?: unknown) => JSON.stringify({
      timestamp: `2026-11-08T${at}:00.000Z`, type: "event_msg",
      payload: { type, ...(error === undefined ? {} : { error }) },
    }) + "\n";
    try {
      writeFileSync(rollout, event("07:25", "turn_aborted"));
      expect(readCodexTurnFailure(rollout, "2026-11-08T07:30:00.000Z")).toBeNull();

      appendFileSync(rollout, event("07:35", "task_started") + event("07:36", "turn_aborted"));
      expect(readCodexTurnFailure(rollout, "2026-11-08T07:30:00.000Z")).toBe("aborted");

      appendFileSync(rollout, event("07:37", "task_started"));
      expect(readCodexTurnFailure(rollout, "2026-11-08T07:30:00.000Z")).toBeNull();

      appendFileSync(rollout, event("07:38", "task_complete", { message: "service failed" }));
      expect(readCodexTurnFailure(rollout, "2026-11-08T07:30:00.000Z")).toBe("failed");

      appendFileSync(rollout, JSON.stringify({ timestamp: "2026-11-08T07:39:00.000Z", type: "turn_context", payload: {} }) + "\n");
      expect(readCodexTurnFailure(rollout, "2026-11-08T07:30:00.000Z")).toBeNull();

      appendFileSync(rollout, event("07:40", "task_complete", null));
      expect(readCodexTurnFailure(rollout, "2026-11-08T07:30:00.000Z")).toBeNull();
      expect(readCodexTurnFailure(rollout, "2026-11-08T07:41:00.000Z")).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not call a normally completed idle prompt a dead turn", async () => {
    const pane = "Task complete\n› Ask Codex to do anything";
    const detector = createQueueNoProgressDetector({
      sample: async () => sample({
        rawPane: pane,
        normalizedPane: normalizePaneForNoProgress(pane),
        paneState: "agent_idle",
        hookState: "idle",
        hookRawEvent: "Stop",
        codexWorkingElapsed: null,
      }),
    });
    await detector.inspect(input(BASE));
    expect(await detector.inspect(input(BASE + 10 * 60_000)))
      .toMatchObject({ state: "finding", diagnosis: "unknown" });
  });

  it("suppresses a long silent foreground command until the row deadline, then reports it", async () => {
    const read = vi.fn(async () => sample({
      hookRawEvent: "PreToolUse",
      hookRawSubtype: "Bash",
      hookState: "running",
      codexWorkingElapsed: null,
    }));
    const detector = createQueueNoProgressDetector({ sample: read });
    const deadline = "2026-11-08T08:15:00.000Z";
    await detector.inspect(input(BASE, { closureRequiredAt: deadline }));
    expect(await detector.inspect(input(BASE + 10 * 60_000, { closureRequiredAt: deadline })))
      .toMatchObject({ state: "inconclusive", reason: "running_command_before_deadline" });
    expect(await detector.inspect(input(BASE + 16 * 60_000, { closureRequiredAt: deadline })))
      .toMatchObject({ state: "finding", diagnosis: "running-command" });
  });

  it("does not suppress an ancient PreToolUse forever when no deadline exists", async () => {
    const detector = createQueueNoProgressDetector({ sample: async () => sample({
      hookRawEvent: "PreToolUse",
      hookRawSubtype: "Bash",
      hookState: "unknown",
      hookStale: true,
      hookReason: "stale_runtime_hook",
    }) });
    await detector.inspect(input(BASE));
    expect(await detector.inspect(input(BASE + 10 * 60_000)))
      .toMatchObject({ state: "inconclusive", reason: "running_command_before_deadline" });
    expect(await detector.inspect(input(BASE + 50 * 60_000)))
      .toMatchObject({ state: "finding", diagnosis: "unknown" });
  });

  it("never attributes mismatched-generation hook events to the current occupant", async () => {
    for (const [hookRawEvent, hookRawSubtype] of [
      ["PermissionRequest", null],
      ["StopFailure", null],
      ["PreToolUse", "Bash"],
    ] as const) {
      const detector = createQueueNoProgressDetector({ sample: async () => sample({
        hookRawEvent,
        hookRawSubtype,
        hookState: "unknown",
        hookStale: true,
        hookReason: "generation_mismatch",
      }) });
      await detector.inspect(input(BASE));
      expect(await detector.inspect(input(BASE + 10 * 60_000)))
        .toMatchObject({ state: "finding", diagnosis: "unknown" });
    }
  });

  it("does not count mismatched-generation hook churn as progress", async () => {
    const first = sample({ hookStale: true, hookReason: "generation_mismatch" });
    const second = sample({
      hookStale: true,
      hookReason: "generation_mismatch",
      hookSourceSequence: 9,
      hookEventAt: "2026-11-08T08:05:00.000Z",
    });
    const detector = createQueueNoProgressDetector({
      sample: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
    });
    await detector.inspect(input(BASE));
    expect(await detector.inspect(input(BASE + 10 * 60_000)))
      .toMatchObject({ state: "finding", diagnosis: "unknown" });
  });

  it("uses hook movement as the Claude activity signal when the transcript itself is unchanged", async () => {
    const first = sample({
      runtime: "claude-code",
      rawPane: "✻ Thinking… (1m 00s · esc to interrupt)",
      normalizedPane: normalizePaneForNoProgress("✻ Thinking… (1m 00s · esc to interrupt)"),
      codexWorkingElapsed: null,
      hookRawEvent: "PreToolUse",
      hookRawSubtype: "Read",
    });
    const second = { ...first, hookEventAt: "2026-11-08T08:03:00.000Z", hookSourceSequence: 8 };
    const read = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const detector = createQueueNoProgressDetector({ sample: read });
    await detector.inspect(input(BASE));
    expect(await detector.inspect(input(BASE + 10 * 60_000))).toMatchObject({ state: "healthy", reason: "runtime_progress" });
  });

  it("clears memory when queue progress is newer than the configured role window", async () => {
    const detector = createQueueNoProgressDetector({ sample: async () => sample() });
    expect(await detector.inspect(input(BASE, { lastMeaningfulAt: "2026-11-08T07:55:00.000Z" })))
      .toMatchObject({ state: "healthy", reason: "queue_progress" });
    expect(detector.observationCount()).toBe(0);
  });

  it("prunes observations for rows that are no longer in progress", async () => {
    const detector = createQueueNoProgressDetector({ sample: async () => sample() });
    await detector.inspect(input(BASE));
    expect(detector.observationCount()).toBe(1);
    detector.retainOnly([]);
    expect(detector.observationCount()).toBe(0);
  });

  it("samples the bound Codex pane and real rollout file, then recognizes resumed transcript growth", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openrig-no-progress-"));
    const rollout = join(directory, "rollout.jsonl");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, resume_token TEXT)");
    db.prepare("INSERT INTO sessions (id, resume_token) VALUES (?, ?)").run("session-1", "thread-1");
    writeFileSync(rollout, '{"type":"event_msg"}\n');
    const capturePaneScreen = vi.fn()
      .mockResolvedValueOnce("⠋ Working (23s • esc to interrupt)\n› Ask Codex to do anything")
      .mockResolvedValueOnce("⠙ Working (24s • esc to interrupt)\n› Ask Codex to do anything")
      .mockResolvedValueOnce("⠹ Working (25s • esc to interrupt)\n› Ask Codex to do anything");
    const readCodexTranscriptPath = vi.fn(() => rollout);
    try {
      const detector = createRuntimeQueueNoProgressDetector({
        db,
        sessionRegistry: {
          findResumeContextByName: () => ({ sessionId: "session-1", nodeId: "node-1", runtime: "codex" }),
          getBindingForNode: () => ({ tmuxPane: "%12" }),
        },
        tmuxAdapter: { capturePaneScreen },
        contextUsageStore: {
          readSidecar: () => ({ ok: false as const, reason: "not_claude" }),
          readCodexTranscriptPath,
        },
      });

      expect(await detector.inspect(input(BASE))).toMatchObject({ state: "inconclusive", reason: "first_sample" });
      expect(await detector.inspect(input(BASE + 10 * 60_000))).toMatchObject({
        state: "finding", diagnosis: "unknown",
      });
      expect(capturePaneScreen).toHaveBeenCalledWith("%12");
      expect(readCodexTranscriptPath).toHaveBeenCalledWith("thread-1");

      appendFileSync(rollout, '{"type":"response_item"}\n');
      expect(await detector.inspect(input(BASE + 11 * 60_000))).toMatchObject({
        state: "healthy", reason: "runtime_progress",
      });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("classifies the latest native rollout abort as dead-turn when pane and file remain frozen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openrig-no-progress-abort-"));
    const rollout = join(directory, "rollout.jsonl");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, resume_token TEXT)");
    db.prepare("INSERT INTO sessions (id, resume_token) VALUES (?, ?)").run("session-1", "thread-1");
    writeFileSync(rollout, JSON.stringify({
      timestamp: "2026-11-08T07:45:00.000Z", type: "event_msg", payload: { type: "turn_aborted" },
    }) + "\n");
    try {
      const detector = createRuntimeQueueNoProgressDetector({
        db,
        sessionRegistry: {
          findResumeContextByName: () => ({ sessionId: "session-1", nodeId: "node-1", runtime: "codex" }),
          getBindingForNode: () => ({ tmuxPane: "%12" }),
        },
        tmuxAdapter: { capturePaneScreen: async () => "• Working (23s • esc to interrupt)" },
        contextUsageStore: {
          readSidecar: () => ({ ok: false as const, reason: "not_claude" }),
          readCodexTranscriptPath: () => rollout,
        },
      });
      await detector.inspect(input(BASE));
      expect(await detector.inspect(input(BASE + 10 * 60_000)))
        .toMatchObject({ state: "finding", diagnosis: "dead-turn" });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("ignores an old permission hook from before the row's last meaningful transition", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openrig-no-progress-old-hook-"));
    const rollout = join(directory, "rollout.jsonl");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, resume_token TEXT)");
    db.prepare("INSERT INTO sessions (id, resume_token) VALUES (?, ?)").run("session-1", "thread-1");
    writeFileSync(rollout, '{"type":"event_msg"}\n');
    try {
      const detector = createRuntimeQueueNoProgressDetector({
        db,
        sessionRegistry: {
          findResumeContextByName: () => ({ sessionId: "session-1", nodeId: "node-1", runtime: "codex" }),
          getBindingForNode: () => ({ tmuxPane: "%12" }),
        },
        tmuxAdapter: { capturePaneScreen: async () => "• Working (23s • esc to interrupt)" },
        contextUsageStore: {
          readSidecar: () => ({ ok: false as const, reason: "not_claude" }),
          readCodexTranscriptPath: () => rollout,
        },
        agentActivityStore: { getLatestForNode: () => ({
          state: "needs_input", eventAt: "2026-11-08T07:20:00.000Z",
          rawEvent: "PermissionRequest", rawSubtype: null,
        }) },
      });
      await detector.inspect(input(BASE));
      expect(await detector.inspect(input(BASE + 10 * 60_000)))
        .toMatchObject({ state: "finding", diagnosis: "unknown" });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
