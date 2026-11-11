import { it, expect } from "vitest";
import { parseAutoCompactWindow, addAutoCompactWindowToSettings } from "../src/domain/claude-auto-compact-window.js";

it("validates integer token windows and rejects env-shell shaped values", () => {
  expect(parseAutoCompactWindow(120_000)).toBe(120000);
  for (const invalid of [0, -1, 12.5, "120000", "1;echo", null, 20_000_000]) {
    expect(() => parseAutoCompactWindow(invalid)).toThrow();
  }
});
it("preserves unrelated managed permission settings, and keeps seats independent", () => {
  const base = { idleCompaction: false, permissions: { allow: ["Read"] } };
  const lead = addAutoCompactWindowToSettings(base, 130000);
  const worker = addAutoCompactWindowToSettings(base, 50000);
  expect(lead).toEqual({ ...base, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "130000" } });
  expect(worker).toEqual({ ...base, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "50000" } });
  expect(base).not.toHaveProperty("env");
});
it("does not overwrite a configured environment if no seat override was specified", () => {
  expect(addAutoCompactWindowToSettings({ env: { OTHER: "yes" } }, undefined)).toEqual({ env: { OTHER: "yes" } });
});
