import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSeatWorktree } from "../src/domain/seat-worktree-readiness.js";

const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const base = () => { const root = mkdtempSync(join(tmpdir(), "seat-ready-")); fixtures.push(root); return root; };

describe("offline seat cwd readiness for expand (#13)", () => {
  it("requires an existing directory and refuses missing cwd", () => {
    const root = base(), workspace = join(root, "workspace"); mkdirSync(workspace);
    expect(checkSeatWorktree(workspace, [])).toEqual({ ok: true, reason: null });
    expect(checkSeatWorktree(join(root, "missing"), [])).toEqual({ ok: false, reason: "cwd_missing" });
  });
  it("refuses a seat cwd inside a different worktree, including symlink alias", () => {
    const root = base(), other = join(root, "other"); mkdirSync(other);
    const nested = join(other, "nested"); mkdirSync(nested);
    const alias = join(root, "alias"); symlinkSync(other, alias);
    expect(checkSeatWorktree(nested, [other])).toEqual({ ok: false, reason: "foreign_worktree" });
    expect(checkSeatWorktree(alias, [other])).toEqual({ ok: false, reason: "foreign_worktree" });
  });
  it("does not mistake sibling prefix for containment", () => {
    const root = base(), other = join(root, "work"); mkdirSync(other);
    const sibling = join(root, "workspace"); mkdirSync(sibling);
    expect(checkSeatWorktree(sibling, [other])).toEqual({ ok: true, reason: null });
  });
});
