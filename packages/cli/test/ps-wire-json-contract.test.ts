import { describe, expect, it } from "vitest";
import { compactNodeProjection } from "../src/commands/ps.js";

const required = ["schemaVersion", "rigId", "rigName", "logicalId", "canonicalSessionName", "hostSelfId", "runtime", "model", "modelObservation", "sessionStatus", "startupStatus", "oriented", "lifecycleState", "agentActivity", "hasAssignedWork", "assignedWorkCount", "pendingWorkCount", "resumeType", "resumeTokenPresent", "lastActivity"];

describe("ps compact JSON wire required-key contract (#30)", () => {
  it("includes all required v1 keys on the serialized wire, even with unknown values", () => {
    const row = JSON.parse(JSON.stringify(compactNodeProjection([{} as never])[0]));
    for (const key of required) expect(row, `${key} must survive JSON serialization`).toHaveProperty(key);
    expect(row.schemaVersion).toBe(1);
  });
  it("keeps unknown as null, not a fabricated status, count, or identifier", () => {
    const row = JSON.parse(JSON.stringify(compactNodeProjection([{} as never])[0]));
    for (const key of ["rigId", "rigName", "logicalId", "canonicalSessionName", "sessionStatus", "startupStatus", "lifecycleState", "hasAssignedWork", "assignedWorkCount", "pendingWorkCount"]) {
      expect(row[key]).toBeNull();
    }
  });
});
