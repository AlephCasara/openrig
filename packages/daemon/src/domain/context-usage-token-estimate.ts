/** Derive live window tokens from observed per-turn payloads, never session totals for Claude. */
export interface TokenSample {
  source: string | null;
  currentUsage: string | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  usedPercentage: number | null;
  contextWindowSize: number | null;
}
const valid = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
export function estimateContextTokens(sample: TokenSample): number | null {
  if (sample.source === "claude_statusline_json") {
    try {
      const raw = JSON.parse(sample.currentUsage ?? "null") as Record<string, unknown> | null;
      if (raw && valid(raw.input_tokens) && valid(raw.cache_read_input_tokens) && valid(raw.cache_creation_input_tokens)) {
        return raw.input_tokens + raw.cache_read_input_tokens + raw.cache_creation_input_tokens;
      }
    } catch { /* An unreadable current_usage is not evidence of session tokens. */ }
    return valid(sample.usedPercentage) && valid(sample.contextWindowSize) && sample.contextWindowSize > 0
      ? Math.round(sample.usedPercentage / 100 * sample.contextWindowSize) : null;
  }
  if (valid(sample.totalInputTokens) && valid(sample.totalOutputTokens))
    return sample.totalInputTokens + sample.totalOutputTokens;
  return valid(sample.usedPercentage) && valid(sample.contextWindowSize) && sample.contextWindowSize > 0
    ? Math.round(sample.usedPercentage / 100 * sample.contextWindowSize) : null;
}
