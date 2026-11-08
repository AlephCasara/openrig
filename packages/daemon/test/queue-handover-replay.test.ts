import { describe, expect, it } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { queueHandoverReplay } from "../src/domain/queue-handover-replay.js";

describe("queueHandoverReplay", () => {
  it("caps rows, notes, children and the length of queue-controlled text", async () => {
    const db = createFullTestDb();
    try {
      const repo = new QueueRepository(db, new EventBus(db));
      for (let n = 0; n < 10; n++) {
        const row = await repo.create({ sourceSession: "orch@rig", destinationSession: "worker@rig", body: `obligation-${n} ${"x".repeat(2000)}` });
        if (n === 9) {
          for (let note = 0; note < 5; note++) repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", transitionNote: `note-${note}` });
          for (let c = 0; c < 5; c++) await repo.create({ sourceSession: "worker@rig", destinationSession: "qa@rig", handedOffFrom: row.qitemId, body: `child-${c}` });
        }
      }
      const replay = queueHandoverReplay(repo, db, "worker@rig").join("\n");
      expect(replay).toContain("more exist; run rig queue list");
      expect((replay.match(/^- [^\n]+ \[(pending|in-progress|blocked)\]/gm) ?? [])).toHaveLength(8);
      expect((replay.match(/latest-note [^\n]+: "note-[0-9]"/g) ?? [])).toHaveLength(2);
      expect(replay).toContain("note-4");
      expect(replay).not.toContain("note-0");
      expect((replay.match(/  child /g) ?? [])).toHaveLength(3);
      expect(replay).toContain("additional children exist");
      expect(replay).not.toContain("x".repeat(400));
    } finally {
      db.close();
    }
  });
});
