import { describe, it, expect } from "vitest";
import { summarizeToolTranscript } from "../src/domain/tool-usage-summary.js";

const record = (timestamp: string, message: unknown) => JSON.stringify({ type: "assistant", timestamp, message });
const result = (timestamp: string, id: string, content: string) => JSON.stringify({
  type: "user", timestamp, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
});

describe("tool usage from Claude transcript records", () => {
  const lines = [
    record("2026-01-01T00:00:00Z", { content: [{ type: "tool_use", id: "old", name: "mcp__index__symbols", input: {} }] }),
    result("2026-01-01T00:01:00Z", "old", "older"),
    record("2026-01-02T00:00:00Z", { content: [{ type: "tool_use", id: "a", name: "mcp__index__symbols", input: {} },
      { type: "tool_use", id: "b", name: "Bash", input: { command: "sed -n '1,3p' example" } }] }),
    result("2026-01-02T00:01:00Z", "a", "abcd"),
    result("2026-01-02T00:02:00Z", "b", "hello"),
  ];
  it("deduplicates repeated tool calls and results and reports exact returned characters", () => {
    const summary = summarizeToolTranscript([...lines, lines[2]!, lines[3]!].join("\n"), ["index", "lsp"], "2026-01-02T00:00:00Z");
    expect(summary.tools).toEqual([
      { name: "Bash", calls: 1, returnedCharacters: 5 },
      { name: "mcp__index__symbols", calls: 1, returnedCharacters: 4 },
    ]);
    expect(summary.servers).toEqual([
      { name: "index", calls: 1, returnedCharacters: 4, unused: false },
      { name: "lsp", calls: 0, returnedCharacters: 0, unused: true },
    ]);
    expect(summary.shell).toEqual([{ group: "sed -n", calls: 1, returnedCharacters: 5 }]);
  });
  it("classifies shell reads separately from generic Bash calls", () => {
    const shell = ["cat note", "head -n 2 note", "rg term note", "grep term note", "echo hello"];
    const rows = shell.map((command, index) =>
      record("2026-01-02T00:00:00Z", { content: [{ type: "tool_use", id: String(index), name: "Bash", input: { command } }] }));
    const summary = summarizeToolTranscript(rows.join("\n"), []);
    expect(summary.shell.map(value => [value.group, value.calls])).toEqual([
      ["cat/head/tail", 2], ["other", 1], ["rg/grep", 2],
    ]);
  });
  it("ignores malformed lines and unresolved tool results instead of inventing usage", () => {
    const summary = summarizeToolTranscript("invalid\n" + result("2026-01-02T00:00:00Z", "not-seen", "secret"), ["index"]);
    expect(summary.tools).toEqual([]);
    expect(summary.servers[0]?.unused).toBe(true);
    expect(summary.malformedLines).toBe(1);
  });
});
