import { it, expect } from "vitest";
import { estimateContextTokens } from "../src/domain/context-usage-token-estimate.js";

it("Claude current usage, not cumulative session totals, controls token watchdog", () => {
  expect(estimateContextTokens({ source: "claude_statusline_json", currentUsage: JSON.stringify({
    input_tokens: 1200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 800,
  }), totalInputTokens: 500000, totalOutputTokens: 100000, usedPercentage: 10, contextWindowSize: 50000 })).toBe(5000);
});
it("Claude falls back to percentage if current-usage absent; never uses cumulative total", () => {
  expect(estimateContextTokens({ source: "claude_statusline_json", currentUsage: null, totalInputTokens: 500000,
    totalOutputTokens: 100000, usedPercentage: 10, contextWindowSize: 50000 })).toBe(5000);
});
it("Codex retains per-turn total as it was", () => {
  expect(estimateContextTokens({ source: "codex_token_count_jsonl", currentUsage: null, totalInputTokens: 200,
    totalOutputTokens: 100, usedPercentage: 5, contextWindowSize: 10000 })).toBe(300);
});
it("unknown usage does not become zero", () => {
  expect(estimateContextTokens({ source: "claude_statusline_json", currentUsage: "{}", totalInputTokens: null,
    totalOutputTokens: null, usedPercentage: null, contextWindowSize: null })).toBeNull();
});
