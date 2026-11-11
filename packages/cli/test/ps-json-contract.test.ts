import { it, expect } from "vitest";
import { compactNodeProjection } from "../src/commands/ps.js";

it("ps --nodes compact JSON v1 has a versioned structural contract", () => {
  const [row] = compactNodeProjection([{} as never]);
  expect(Object.keys(row!).sort()).toEqual([
    "agentActivity", "assignedWorkCount", "canonicalSessionName", "hasAssignedWork",
    "hostSelfId", "lastActivity", "lifecycleState", "logicalId", "model",
    "modelObservation", "oriented", "pendingWorkCount", "resumeTokenPresent",
    "resumeType", "rigId", "rigName", "runtime", "schemaVersion",
    "sessionStatus", "startupStatus",
  ]);
  expect(row?.schemaVersion).toBe(1);
});
