/**
 * Best-effort Claude JSONL tool census. Counts a tool once by tool_use.id and
 * its observed text result once by tool_use_id. No text leaves this function.
 * Does not claim that missing transcript lines are calls of zero duration.
 */
interface ToolStat { name: string; calls: number; returnedCharacters: number }
interface ServerStat { name: string; calls: number; returnedCharacters: number; unused: boolean }
interface ShellStat { group: string; calls: number; returnedCharacters: number }
interface CallInfo { name: string; server: string | null; shellGroup: string | null }

export interface TranscriptToolSummary {
  tools: ToolStat[];
  servers: ServerStat[];
  shell: ShellStat[];
  malformedLines: number;
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function shellCommandGroup(raw: string): string {
  const trimmed = raw.trimStart();
  if (/^sed\s+-n(?:\s|$)/.test(trimmed)) return "sed -n";
  if (/^(?:cat|head|tail)(?:\s|$)/.test(trimmed)) return "cat/head/tail";
  if (/^(?:rg|grep)(?:\s|$)/.test(trimmed)) return "rg/grep";
  return "other";
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("");
  const entry = asObject(value);
  if (!entry) return "";
  if (typeof entry["text"] === "string") return entry["text"];
  return textOf(entry["content"]);
}

function tally(map: Map<string, { calls: number; returnedCharacters: number }>, key: string, count: "calls" | "returnedCharacters", amount: number): void {
  const slot = map.get(key) ?? { calls: 0, returnedCharacters: 0 };
  slot[count] += amount;
  map.set(key, slot);
}

/** A deterministic pure projection for fixtures and persisted transcript bytes. */
export function summarizeToolTranscript(
  jsonl: string,
  configuredMcpServers: readonly string[],
  since?: string,
): TranscriptToolSummary {
  const used = new Map<string, { calls: number; returnedCharacters: number }>();
  const servers = new Map<string, { calls: number; returnedCharacters: number }>();
  const shell = new Map<string, { calls: number; returnedCharacters: number }>();
  const calls = new Map<string, CallInfo>();
  const results = new Set<string>();
  let malformedLines = 0;
  const sinceMs = since ? Date.parse(since) : NaN;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown> | null;
    try { entry = asObject(JSON.parse(line)); } catch { malformedLines++; continue; }
    if (!entry) { malformedLines++; continue; }
    const at = typeof entry["timestamp"] === "string" ? Date.parse(entry["timestamp"]) : NaN;
    if (Number.isFinite(sinceMs) && (!Number.isFinite(at) || at < sinceMs)) continue;
    const message = asObject(entry["message"]);
    const blocks = Array.isArray(message?.["content"]) ? message["content"] : [];
    for (const raw of blocks) {
      const block = asObject(raw);
      if (!block) continue;
      if (block["type"] === "tool_use" && typeof block["id"] === "string"
        && typeof block["name"] === "string") {
        if (calls.has(block["id"])) continue;
        const name = block["name"];
        const server = name.startsWith("mcp__") ? name.slice(5).split("__")[0] || null : null;
        const input = asObject(block["input"]);
        const shellGroup = name === "Bash" && typeof input?.["command"] === "string"
          ? shellCommandGroup(input["command"]) : null;
        calls.set(block["id"], { name, server, shellGroup });
        tally(used, name, "calls", 1);
        if (server) tally(servers, server, "calls", 1);
        if (shellGroup) tally(shell, shellGroup, "calls", 1);
      } else if (block["type"] === "tool_result" && typeof block["tool_use_id"] === "string") {
        const call = calls.get(block["tool_use_id"]);
        if (!call || results.has(block["tool_use_id"])) continue;
        results.add(block["tool_use_id"]);
        const chars = Array.from(textOf(block["content"])).length;
        tally(used, call.name, "returnedCharacters", chars);
        if (call.server) tally(servers, call.server, "returnedCharacters", chars);
        if (call.shellGroup) tally(shell, call.shellGroup, "returnedCharacters", chars);
      }
    }
  }
  const sorted = (map: Map<string, { calls: number; returnedCharacters: number }>) =>
    [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  const serverNames = [...new Set([...configuredMcpServers, ...servers.keys()])].sort();
  return {
    tools: sorted(used).map(([name, data]) => ({ name, ...data })),
    servers: serverNames.map(name => ({ name, ...(servers.get(name) ?? { calls: 0, returnedCharacters: 0 }),
      unused: !servers.get(name)?.calls })),
    shell: sorted(shell).map(([group, data]) => ({ group, ...data })),
    malformedLines,
  };
}

/** Aggregate multiple independent JSONL sessions. Tool-use IDs can repeat across files,
 * so parse/dedupe each session in isolation before adding counts. The caller is
 * responsible for obtaining transcripts only from the selected authorized seat. */
export function summarizeToolTranscriptFiles(
  sessionJsonl: readonly string[], configuredMcpServers: readonly string[], since?: string,
): TranscriptToolSummary {
  const tools = new Map<string, { calls: number; returnedCharacters: number }>();
  const servers = new Map<string, { calls: number; returnedCharacters: number }>();
  const shell = new Map<string, { calls: number; returnedCharacters: number }>();
  let malformedLines = 0;
  const merge = (target: Map<string, { calls: number; returnedCharacters: number }>,
    name: string, stats: { calls: number; returnedCharacters: number }) => {
    const current = target.get(name) ?? { calls: 0, returnedCharacters: 0 };
    current.calls += stats.calls;
    current.returnedCharacters += stats.returnedCharacters;
    target.set(name, current);
  };
  for (const jsonl of sessionJsonl) {
    const summary = summarizeToolTranscript(jsonl, configuredMcpServers, since);
    malformedLines += summary.malformedLines;
    for (const stat of summary.tools) merge(tools, stat.name, stat);
    for (const stat of summary.servers) merge(servers, stat.name, stat);
    for (const stat of summary.shell) merge(shell, stat.group, stat);
  }
  const byName = (a: string, b: string) => a.localeCompare(b);
  const serverNames = [...new Set([...configuredMcpServers, ...servers.keys()])].sort(byName);
  return {
    tools: [...tools.entries()].sort(([a], [b]) => byName(a, b)).map(([name, stats]) => ({ name, ...stats })),
    servers: serverNames.map(name => {
      const stats = servers.get(name) ?? { calls: 0, returnedCharacters: 0 };
      return { name, ...stats, unused: stats.calls === 0 };
    }),
    shell: [...shell.entries()].sort(([a], [b]) => byName(a, b)).map(([group, stats]) => ({ group, ...stats })),
    malformedLines,
  };
}
