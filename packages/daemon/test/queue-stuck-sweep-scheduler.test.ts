// The stuck sweep yields the event loop, so the scheduler must not start a second pass while one is still running.
import { afterEach, describe, expect, it, vi } from "vitest";

const runStuckSweep = vi.fn();
const createRuntimeQueueNoProgressDetector = vi.fn(() => ({ inspect: vi.fn(), retainOnly: vi.fn(), observationCount: vi.fn(() => 0) }));
vi.mock("../src/domain/queue-stuck-sweep.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/domain/queue-stuck-sweep.js")>()),
  runStuckSweep: (...args: unknown[]) => runStuckSweep(...args),
  resolveStuckSweepIntervalSeconds: () => 1,
}));
vi.mock("../src/domain/queue-no-progress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/domain/queue-no-progress.js")>()),
  createRuntimeQueueNoProgressDetector: (...args: unknown[]) => createRuntimeQueueNoProgressDetector(...args),
  resolveQueueNoProgressWindowMinutes: () => 15,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  runStuckSweep.mockReset();
  createRuntimeQueueNoProgressDetector.mockClear();
});

describe("startStuckSweepScheduler", () => {
  it("skips the ticks that come while a pass is still running, and runs again once it ends", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    runStuckSweep.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { startStuckSweepScheduler } = await import("../src/index.js");
    const handle = startStuckSweepScheduler({ rigRepo: { db: {} as never }, queueRepo: {} as never });
    try {
      expect(runStuckSweep).toHaveBeenCalledTimes(1); // the boot pass
      await vi.advanceTimersByTimeAsync(3_000); // three ticks while the boot pass runs
      expect(runStuckSweep).toHaveBeenCalledTimes(1);
      // each skipped tick says so, with the running pass's start
      expect(errors.mock.calls.filter(([line]) => String(line).startsWith("[stuck-sweep] tick skipped"))).toHaveLength(3);
      finish();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runStuckSweep).toHaveBeenCalledTimes(2);
    } finally {
      if (handle) clearInterval(handle);
    }
  });

  it("shows the running pass and its skipped ticks on the status snapshot that /healthz serves", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T12:00:00.000Z"));
    let finish!: () => void;
    runStuckSweep.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { startStuckSweepScheduler } = await import("../src/index.js");
    const deps: Parameters<typeof startStuckSweepScheduler>[0] = { rigRepo: { db: {} as never }, queueRepo: {} as never };
    const handle = startStuckSweepScheduler(deps);
    try {
      const status = deps.stuckSweepStatus!;
      expect(status.snapshot()).toMatchObject({ runningSince: "2026-11-07T12:00:00.000Z", skippedTicks: 0 });
      await vi.advanceTimersByTimeAsync(2_000); // two ticks while the boot pass runs
      expect(status.snapshot()).toMatchObject({ runningSince: "2026-11-07T12:00:00.000Z", skippedTicks: 2 });
      finish();
      await vi.advanceTimersByTimeAsync(0);
      // the pass ended: nothing running; the count stays until the next pass starts (what the last pass cost)
      expect(status.snapshot()).toMatchObject({ runningSince: null, skippedTicks: 2 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(status.snapshot()).toMatchObject({ runningSince: "2026-11-07T12:00:03.000Z", skippedTicks: 0 });
    } finally {
      if (handle) clearInterval(handle);
    }
  });

  it("constructs one persistent runtime detector and passes it to every scheduled sweep", async () => {
    vi.useFakeTimers();
    runStuckSweep.mockResolvedValue({ outcome: "clean", findings: [] });
    const { startStuckSweepScheduler } = await import("../src/index.js");
    const deps: Parameters<typeof startStuckSweepScheduler>[0] = {
      rigRepo: { db: {} as never },
      queueRepo: {} as never,
      sessionRegistry: {
        findResumeContextByName: vi.fn(),
        getBindingForNode: vi.fn(),
      } as never,
      tmuxAdapter: { capturePaneScreen: vi.fn() } as never,
      contextUsageStore: {
        readSidecar: vi.fn(),
        readCodexTranscriptPath: vi.fn(),
      } as never,
    };
    const handle = startStuckSweepScheduler(deps);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(createRuntimeQueueNoProgressDetector).toHaveBeenCalledTimes(1);
      expect(runStuckSweep).toHaveBeenCalledTimes(2);
      const first = runStuckSweep.mock.calls[0]![0] as Record<string, unknown>;
      const second = runStuckSweep.mock.calls[1]![0] as Record<string, unknown>;
      expect(first.noProgressDetector).toBe(second.noProgressDetector);
      expect(first.resolveNoProgressWindowMinutes).toEqual(expect.any(Function));
    } finally {
      if (handle) clearInterval(handle);
    }
  });
});
