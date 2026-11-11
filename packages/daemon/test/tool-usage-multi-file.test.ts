import { describe, expect, it } from "vitest";
import { summarizeToolTranscriptFiles } from "../src/domain/tool-usage-summary.js";
const line = (name: string, id: string) => JSON.stringify({
  type: "assistant", timestamp: "2026-01-10T00:00:00Z", message: { content: [{ type: "tool_use", id, name, input: {} }] },
});

describe("multi-session tool census (#10 offline)", () => {
  it("counts identical tool_use IDs separately in different session files", () => {
    const r = summarizeToolTranscriptFiles([line("mcp__index__search", "same"), line("mcp__index__search", "same")], ["index", "unused"]);
    expect(r.tools).toEqual([{ name: "mcp__index__search", calls: 2, returnedCharacters: 0 }]);
    expect(r.servers).toEqual([{ name: "index", calls: 2, returnedCharacters: 0, unused: false }, { name: "unused", calls: 0, returnedCharacters: 0, unused: true }]);
  });
  it("keeps configured-but-unused servers even with empty sessions", () => {
    expect(summarizeToolTranscriptFiles([], ["idle"]).servers).toEqual([{ name: "idle", calls: 0, returnedCharacters: 0, unused: true }]);
  });
  it("counts malformed lines and shell usage across sessions without mixing results", () => {
    const a = JSON.stringify({ type: "assistant", timestamp: "2026-01-10T00:00:00Z", message: { content: [{ type: "tool_use", id: "same", name: "Bash", input: { command: "cat a" } }] } });
    const b = a.replace("cat a", "rg a");
    const r = summarizeToolTranscriptFiles([`bad\n${a}`, b], []);
    expect(r.malformedLines).toBe(1);
    expect(r.shell.map(x => [x.group, x.calls])).toEqual([["cat/head/tail", 1], ["rg/grep", 1]]);
  });
});
