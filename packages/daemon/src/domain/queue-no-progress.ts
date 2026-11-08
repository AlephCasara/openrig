import type Database from "better-sqlite3";
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import {
  classifyPaneActivity,
  codexWorkingElapsed,
  type PaneActivityClassification,
} from "./session-transport.js";
import { SettingsStore } from "./user-settings/settings-store.js";
import {
  listNativeProcesses,
  observeClaudePaneProcess,
  observeCodexPaneProcess,
  type NativeProcessLister,
  type NativeProcessRow,
} from "./native-process-lineage.js";

export const STUCK_SWEEP_NO_PROGRESS_ORCHESTRATOR_KEY = "queue.stuck_sweep_no_progress_orchestrator_minutes";
export const STUCK_SWEEP_NO_PROGRESS_IMPLEMENTER_KEY = "queue.stuck_sweep_no_progress_implementer_minutes";
export const DEFAULT_STUCK_SWEEP_NO_PROGRESS_ORCHESTRATOR_MINUTES = 15;
export const DEFAULT_STUCK_SWEEP_NO_PROGRESS_IMPLEMENTER_MINUTES = 30;

export type NoProgressDiagnosis =
  | "needs-input"
  | "compacting"
  | "dead-turn"
  | "running-command"
  | "unknown";

export interface NoProgressSample {
  runtime: string;
  rawPane: string;
  normalizedPane: string;
  paneState: PaneActivityClassification["state"];
  paneReason: string;
  transcriptPath: string | null;
  transcriptSize: number | null;
  transcriptMtimeMs: number | null;
  hookEventAt: string | null;
  hookSourceSequence: number | null;
  hookRawEvent: string | null;
  hookRawSubtype: string | null;
  hookState: "running" | "idle" | "needs_input" | "unknown" | null;
  /** A stale hook may be retained for a *different* occupant generation. */
  hookStale?: boolean | null;
  hookReason?: string | null;
  /** PID and OS start time of a verified, foreground shell-command child. */
  runningCommandProcessId?: string | null;
  codexWorkingElapsed: number | null;
  /** Latest native Codex turn ended unsuccessfully after this row's progress anchor. */
  codexTurnFailure?: "failed" | "aborted" | null;
}

export interface NoProgressInspectInput {
  qitemId: string;
  destinationSession: string;
  state: string;
  lastMeaningfulAt: string | null;
  closureRequiredAt: string | null;
  now: Date;
  windowMinutes: number;
}

export type NoProgressDecision =
  | { state: "finding"; diagnosis: NoProgressDiagnosis; reason: string; sample: NoProgressSample }
  | { state: "healthy"; reason: "queue_progress" | "runtime_progress" | "not_in_progress" }
  | { state: "inconclusive"; reason: "missing_runtime_signal" | "first_sample" | "sample_interval" | "running_command_before_deadline" };

export interface QueueNoProgressDetector {
  inspect(input: NoProgressInspectInput): Promise<NoProgressDecision>;
  retainOnly(qitemIds: Iterable<string>): void;
  observationCount(): number;
}

interface Observation {
  atMs: number;
  lastMeaningfulAt: string | null;
  sample: NoProgressSample;
}

function statusLike(line: string): boolean {
  // Claude's live spinner can use arbitrary verbs (e.g. "Onioning…"). Match
  // the live glyph + ellipsis + timer shape instead of a fixed verb vocabulary.
  return /^[✶✢✳✻✽·*]\s+\S.*(?:…|\.{3})\s+\((?:running [^()·]+ hook · )?(?:\d+h\s+)?(?:\d+m\s+)?\d+s\b/.test(line)
    || /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|esc to interrupt|\bworking\b|\bthinking\b|\bcompacting\b|running [^()]+ hook/i.test(line);
}

/** Normalize volatile terminal chrome while retaining semantic pane content. */
export function normalizePaneForNoProgress(pane: string): string {
  return pane
    .split(/\r?\n/)
    .map((line) => {
      let next = line.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "⠿");
      if (statusLike(next)) {
        next = next
          // Claude rotates its live status glyph independently of actual work.
          // Normalize only the shaped status prefix, not symbols in output.
          .replace(/^[✶✢✳✻✽·*](?=\s+\S.*(?:…|\.{3})\s+\()/u, "<spinner>")
          .replace(/\b(?:\d+h\s*)?(?:\d+m\s*)?\d+s\b/g, "<elapsed>")
          .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "<clock>")
          // Claude redraws status token counters as it thinks. The counters
          // are terminal chrome; the native transcript is the progress signal.
          .replace(/[↑↓]\s*\d+(?:[.,]\d+)?[kKmM]?\s+tokens?\b/g, "<tokens>");
      } else {
        next = next.replace(/^\s*\d{1,2}:\d{2}(?::\d{2})?\b/, "<clock>");
      }
      return next.trimEnd();
    })
    .join("\n")
    .trim();
}

function completeRuntimeSignal(sample: NoProgressSample): boolean {
  return !!sample.transcriptPath
    && sample.transcriptSize !== null
    && sample.transcriptMtimeMs !== null
    && sample.normalizedPane.length > 0;
}

function hookSignature(sample: NoProgressSample): string {
  // Events from another occupant must not reset the stall clock when they churn.
  if (!hookBelongsToCurrentOccupant(sample)) return "unbound";
  return JSON.stringify([
    sample.hookEventAt,
    sample.hookSourceSequence,
    sample.hookRawEvent,
    sample.hookRawSubtype,
  ]);
}

function runtimeMoved(before: NoProgressSample, after: NoProgressSample): boolean {
  if (before.transcriptPath !== after.transcriptPath) return true;
  if (before.transcriptSize !== after.transcriptSize || before.transcriptMtimeMs !== after.transcriptMtimeMs) return true;
  if (hookSignature(before) !== hookSignature(after)) return true;
  return before.normalizedPane !== after.normalizedPane;
}

function hookBelongsToCurrentOccupant(sample: NoProgressSample): boolean {
  // An old, same-generation hook is historical evidence. A mismatched or unverifiable
  // generation is not evidence about this occupant at all.
  return sample.hookStale !== true || sample.hookReason === "stale_runtime_hook";
}

function isRunningCommand(sample: NoProgressSample): boolean {
  if (!hookBelongsToCurrentOccupant(sample)) return false;
  if (sample.hookRawEvent !== "PreToolUse") return false;
  return /^(?:bash|shell|sh|command|exec|terminal|powershell)$/i.test(sample.hookRawSubtype ?? "")
    && !!sample.runningCommandProcessId;
}

/**
 * A hook is historical until the OS also witnesses a foreground command. Require
 * the command's direct child of the bound runtime to have started at the hook,
 * in the runtime's foreground process group. This refuses long-lived MCP helpers,
 * unrelated descendants and background process groups. Ambiguity stays unknown.
 * The detector also requires the *same* PID/start time across its two samples.
 */
export function foregroundCommandWitness(
  rows: NativeProcessRow[], panePid: number, runtimePid: number, hookEventAt: string,
): string | null {
  const hookMs = Date.parse(hookEventAt);
  if (!Number.isFinite(hookMs)) return null;
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const pane = byPid.get(panePid);
  const runtime = byPid.get(runtimePid);
  const runtimeStartedMs = Date.parse(runtime?.startedAt ?? "");
  if (byPid.size !== rows.length || !pane?.startedAt || !runtime?.startedAt
    || !Number.isFinite(runtimeStartedMs) || runtimeStartedMs > hookMs + 1_000
    || !pane.tpgid || pane.tpgid <= 0 || runtime.pgid !== pane.tpgid || runtime.tpgid !== pane.tpgid) return null;

  const roots = new Map<number, NativeProcessRow>();
  for (const row of rows) {
    if (row.pid === runtimePid || row.pgid !== runtime.pgid || row.tpgid !== pane.tpgid || !row.startedAt) continue;
    const visited = new Set<number>([row.pid]);
    let current = row;
    let root: NativeProcessRow | null = null;
    while (!visited.has(current.ppid)) {
      visited.add(current.ppid);
      const parent = byPid.get(current.ppid);
      if (!parent?.startedAt) break;
      if (parent.pid === runtimePid) { root = current; break; }
      current = parent;
    }
    if (!root?.startedAt) continue;
    const startedMs = Date.parse(root.startedAt);
    // ps lstart has one-second precision. Allow only that rounding error.
    if (!Number.isFinite(startedMs) || startedMs < hookMs - 1_000) continue;
    if (/^(?:codex|claude|\.claude-(?:un)?wrapped)$/i.test(root.executableName ?? "")) continue;
    roots.set(root.pid, root);
  }
  if (roots.size !== 1) return null;
  const root = [...roots.values()][0]!;
  return `${root.pid}:${root.startedAt}`;
}

function isFailedOrAbortedTurn(sample: NoProgressSample): boolean {
  if (!hookBelongsToCurrentOccupant(sample)) return false;
  const event = sample.hookRawEvent ?? "";
  const subtype = sample.hookRawSubtype ?? "";
  if (/^(?:StopFailure|Turn(?:Failed|Aborted)|Task(?:Failed|Aborted))$/i.test(event)) return true;
  return /(?:^|[_:-])(?:failed|aborted)(?:$|[_:-])/i.test(subtype);
}

/** Keep diagnostic text from older turns in the pane from masquerading as active compaction. */
function isActivelyCompacting(sample: NoProgressSample): boolean {
  if (sample.paneState !== "agent_active") return false;
  const statuses = sample.rawPane.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✻•]\s*)?(?:compacting|working|thinking)\b/i.test(line));
  return /^\s*(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✻•]\s*)?compacting\b/i.test(statuses.at(-1) ?? "");
}

export function classifyNoProgress(sample: NoProgressSample): NoProgressDiagnosis {
  if (sample.paneState === "attention" || (hookBelongsToCurrentOccupant(sample)
    && (sample.hookState === "needs_input" || sample.hookRawEvent === "PermissionRequest"))) {
    return "needs-input";
  }
  if (isActivelyCompacting(sample)) return "compacting";
  if (sample.codexTurnFailure) return "dead-turn";
  if (isRunningCommand(sample)) return "running-command";
  if (isFailedOrAbortedTurn(sample)) return "dead-turn";
  return "unknown";
}

/**
 * Read only a bounded rollout tail. The latest relevant native turn event wins:
 * a new start (including turn_context) or a successful completion supersedes an
 * earlier failure. The event must be newer than this row's last queue progress,
 * so a resumed conversation cannot inherit an old aborted turn.
 */
export function readCodexTurnFailure(transcriptPath: string, lastMeaningfulAt: string | null): "failed" | "aborted" | null {
  const anchorMs = Date.parse(lastMeaningfulAt ?? "");
  if (!Number.isFinite(anchorMs)) return null;
  const fd = openSync(transcriptPath, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, 512 * 1024);
    const bytes = Buffer.alloc(length);
    readSync(fd, bytes, 0, length, size - length);
    const tail = bytes.toString("utf8");
    const lines = tail.split("\n");
    if (size > length) lines.shift(); // May start in the middle of a JSONL record.
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]!.trim();
      if (!line.includes("task_started") && !line.includes("task_complete")
        && !line.includes("turn_aborted") && !line.includes("turn_context")) continue;
      let entry: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        entry = parsed as Record<string, unknown>;
      } catch { continue; }
      const payload = entry.payload as Record<string, unknown> | null | undefined;
      const event = entry.type === "turn_context" ? "turn_context"
        : entry.type === "event_msg" ? payload?.type : null;
      if (!["task_started", "turn_context", "task_complete", "turn_aborted"].includes(String(event))) continue;
      const atMs = Date.parse(typeof entry.timestamp === "string" ? entry.timestamp : "");
      if (!Number.isFinite(atMs)) return null;
      if (atMs < anchorMs) return null;
      if (event === "turn_aborted") return "aborted";
      if (event === "task_complete" && payload?.error != null) return "failed";
      return null;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

export function createQueueNoProgressDetector(deps: {
  sample: (input: NoProgressInspectInput) => Promise<NoProgressSample | null>;
}): QueueNoProgressDetector {
  const observations = new Map<string, Observation>();

  return {
    async inspect(input) {
      if (input.state !== "in-progress") {
        observations.delete(input.qitemId);
        return { state: "healthy", reason: "not_in_progress" };
      }

      const anchorMs = Date.parse(input.lastMeaningfulAt ?? "");
      const windowMs = Math.max(1, input.windowMinutes) * 60_000;
      if (!Number.isFinite(anchorMs)) {
        observations.delete(input.qitemId);
        return { state: "inconclusive", reason: "missing_runtime_signal" };
      }
      if (input.now.getTime() - anchorMs < windowMs) {
        observations.delete(input.qitemId);
        return { state: "healthy", reason: "queue_progress" };
      }

      const current = await deps.sample(input);
      if (!current || !completeRuntimeSignal(current)) {
        return { state: "inconclusive", reason: "missing_runtime_signal" };
      }

      const previous = observations.get(input.qitemId);
      if (!previous || previous.lastMeaningfulAt !== input.lastMeaningfulAt) {
        observations.set(input.qitemId, {
          atMs: input.now.getTime(),
          lastMeaningfulAt: input.lastMeaningfulAt,
          sample: current,
        });
        return { state: "inconclusive", reason: "first_sample" };
      }

      if (runtimeMoved(previous.sample, current)) {
        observations.set(input.qitemId, {
          atMs: input.now.getTime(),
          lastMeaningfulAt: input.lastMeaningfulAt,
          sample: current,
        });
        return { state: "healthy", reason: "runtime_progress" };
      }

      if (input.now.getTime() - previous.atMs < windowMs / 2) {
        return { state: "inconclusive", reason: "sample_interval" };
      }

      let diagnosis = classifyNoProgress(current);
      if (diagnosis === "running-command"
        && previous.sample.runningCommandProcessId !== current.runningCommandProcessId) {
        diagnosis = "unknown";
      }
      if (diagnosis === "running-command") {
        const deadlineMs = Date.parse(input.closureRequiredAt ?? "");
        if (Number.isFinite(deadlineMs) && input.now.getTime() < deadlineMs) {
          return { state: "inconclusive", reason: "running_command_before_deadline" };
        }
        if (!Number.isFinite(deadlineMs)) {
          // A PreToolUse without a matching completion is not proof that the command
          // is still running indefinitely. With no row deadline, bound this grace
          // period to two role windows, then report the ambiguity as unknown.
          const startedAt = Date.parse(current.hookEventAt ?? "");
          if (Number.isFinite(startedAt) && input.now.getTime() - startedAt < 2 * windowMs) {
            return { state: "inconclusive", reason: "running_command_before_deadline" };
          }
          diagnosis = "unknown";
        }
      }

      return {
        state: "finding",
        diagnosis,
        reason: `no queue or runtime progress across ${Math.round((input.now.getTime() - previous.atMs) / 60_000)} min`,
        sample: current,
      };
    },
    retainOnly(qitemIds) {
      const retained = new Set(qitemIds);
      for (const qitemId of observations.keys()) {
        if (!retained.has(qitemId)) observations.delete(qitemId);
      }
    },
    observationCount: () => observations.size,
  };
}

function resolvePositiveMinutes(key: string, fallback: number): number {
  try {
    const value = new SettingsStore().resolveOne(key as never).value;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

export function resolveQueueNoProgressWindowMinutes(
  db: Database.Database,
  destinationSession: string,
): number {
  const row = db.prepare(
    `SELECT n.logical_id AS logical_id, n.role AS role
       FROM sessions s
       JOIN nodes n ON n.id = s.node_id
      WHERE s.session_name = ?
      ORDER BY s.id DESC LIMIT 1`,
  ).get(destinationSession) as { logical_id: string; role: string | null } | undefined;
  const orchestrator = row?.role?.toLowerCase() === "orchestrator" || row?.logical_id.startsWith("orch.") === true;
  return orchestrator
    ? resolvePositiveMinutes(STUCK_SWEEP_NO_PROGRESS_ORCHESTRATOR_KEY, DEFAULT_STUCK_SWEEP_NO_PROGRESS_ORCHESTRATOR_MINUTES)
    : resolvePositiveMinutes(STUCK_SWEEP_NO_PROGRESS_IMPLEMENTER_KEY, DEFAULT_STUCK_SWEEP_NO_PROGRESS_IMPLEMENTER_MINUTES);
}

export function createRuntimeQueueNoProgressDetector(deps: {
  db: Database.Database;
  sessionRegistry: {
    findResumeContextByName(sessionName: string): { sessionId: string; nodeId: string; runtime: string | null } | null;
    getBindingForNode(nodeId: string): {
      attachmentType?: string | null;
      tmuxSession?: string | null;
      tmuxPane?: string | null;
    } | null;
  };
  tmuxAdapter: {
    capturePaneScreen(target: string): Promise<string | null>;
    getPanePid?(target: string): Promise<number | null>;
  };
  listProcesses?: NativeProcessLister;
  contextUsageStore: {
    readSidecar(sessionName: string): { ok: true; data: { transcript_path?: string | null } } | { ok: false; reason: string };
    readCodexTranscriptPath(threadId: string): string | null;
  };
  agentActivityStore?: {
    getLatestForNode(input: { nodeId?: string | null; sessionName?: string | null; now?: Date; order?: "arrival" | "source" }): {
      state: "running" | "idle" | "needs_input" | "unknown";
      eventAt?: string | null;
      sourceSequence?: number | null;
      rawEvent?: string | null;
      rawSubtype?: string | null;
      stale?: boolean;
      reason?: string | null;
    } | null;
  };
}): QueueNoProgressDetector {
  return createQueueNoProgressDetector({
    sample: async (input) => {
      const context = deps.sessionRegistry.findResumeContextByName(input.destinationSession);
      if (!context || (context.runtime !== "codex" && context.runtime !== "claude-code")) return null;
      const binding = deps.sessionRegistry.getBindingForNode(context.nodeId);
      if (!binding || binding.attachmentType === "external_cli") return null;
      const target = binding.tmuxPane ?? binding.tmuxSession ?? input.destinationSession;
      const rawPane = await deps.tmuxAdapter.capturePaneScreen(target);
      if (!rawPane) return null;

      let transcriptPath: string | null = null;
      if (context.runtime === "codex") {
        const session = deps.db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(context.sessionId) as { resume_token: string | null } | undefined;
        transcriptPath = session?.resume_token ? deps.contextUsageStore.readCodexTranscriptPath(session.resume_token) : null;
      } else {
        const sidecar = deps.contextUsageStore.readSidecar(input.destinationSession);
        transcriptPath = sidecar.ok ? sidecar.data.transcript_path ?? null : null;
      }

      let transcriptSize: number | null = null;
      let transcriptMtimeMs: number | null = null;
      let codexTurnFailure: "failed" | "aborted" | null = null;
      if (transcriptPath) {
        try {
          const stat = statSync(transcriptPath, { throwIfNoEntry: false });
          if (stat?.isFile()) {
            transcriptSize = stat.size;
            transcriptMtimeMs = stat.mtimeMs;
            if (context.runtime === "codex") {
              codexTurnFailure = readCodexTurnFailure(transcriptPath, input.lastMeaningfulAt);
            }
          }
        } catch {
          // Missing/unreadable runtime evidence is inconclusive, never a finding.
        }
      }

      const activity = deps.agentActivityStore?.getLatestForNode({
        nodeId: context.nodeId,
        sessionName: input.destinationSession,
        now: input.now,
        order: "source",
      }) ?? null;
      // A previous turn's permission/failure hook cannot diagnose work claimed later.
      // The pane remains an independent source for a currently visible prompt.
      const activityAt = Date.parse(activity?.eventAt ?? "");
      const progressAt = Date.parse(input.lastMeaningfulAt ?? "");
      const rowActivity = Number.isFinite(activityAt) && Number.isFinite(progressAt)
        && activityAt >= progressAt ? activity : null;
      const pane = classifyPaneActivity(rawPane, {
        runtime: context.runtime,
        timerlessStatusIsLive: true,
        currentClaudeDialogueOnly: true,
      });

      let runningCommandProcessId: string | null = null;
      if (deps.tmuxAdapter.getPanePid && rowActivity?.rawEvent === "PreToolUse"
        && /^(?:bash|shell|sh|command|exec|terminal|powershell)$/i.test(rowActivity.rawSubtype ?? "")
        && (rowActivity.stale !== true || rowActivity.reason === "stale_runtime_hook")) {
        try {
          const panePid = await deps.tmuxAdapter.getPanePid(target);
          if (panePid) {
            const processes = await (deps.listProcesses ?? listNativeProcesses)();
            const tmux = { getPanePid: async () => panePid };
            const session = deps.db.prepare("SELECT resume_token FROM sessions WHERE id = ?")
              .get(context.sessionId) as { resume_token: string | null } | undefined;
            const native = context.runtime === "codex"
              ? await observeCodexPaneProcess({ target, tmux, listProcesses: () => processes,
                  expectedToken: session?.resume_token, requireArgv: true })
              : await observeClaudePaneProcess({ target, tmux, listProcesses: () => processes,
                  expectedToken: session?.resume_token });
            if (native && rowActivity.eventAt) {
              runningCommandProcessId = foregroundCommandWitness(processes, panePid, native.process.pid, rowActivity.eventAt);
            }
          }
        } catch {
          // OS evidence may be unavailable. A hook alone never proves a live command.
        }
      }

      return {
        runtime: context.runtime,
        rawPane,
        normalizedPane: normalizePaneForNoProgress(rawPane),
        paneState: pane.state,
        paneReason: pane.reason,
        transcriptPath,
        transcriptSize,
        transcriptMtimeMs,
        hookEventAt: rowActivity?.eventAt ?? null,
        hookSourceSequence: rowActivity?.sourceSequence ?? null,
        hookRawEvent: rowActivity?.rawEvent ?? null,
        hookRawSubtype: rowActivity?.rawSubtype ?? null,
        hookState: rowActivity?.state ?? null,
        hookStale: rowActivity?.stale ?? null,
        hookReason: rowActivity?.reason ?? null,
        runningCommandProcessId,
        codexWorkingElapsed: context.runtime === "codex" ? codexWorkingElapsed(rawPane) : null,
        codexTurnFailure,
      };
    },
  });
}
