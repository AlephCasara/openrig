import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeProviderCredential, readProviderCredential } from "../src/domain/provider-credential-file.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() { const dir = mkdtempSync(join(tmpdir(), "rig-credential-fixture-")); dirs.push(dir); return dir; }

describe("offline credentials file (#27)", () => {
  it("creates a new private 0600 file and reads it back, excluding content from errors", () => {
    const file = join(fixture(), "token");
    storeProviderCredential(file, "FAKE_TEST_SECRET");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe("FAKE_TEST_SECRET");
    expect(readProviderCredential(file)).toBe("FAKE_TEST_SECRET");
  });
  it("refuses to overwrite existing secrets or follow a symlink", () => {
    const dir = fixture(), file = join(dir, "token");
    writeFileSync(file, "old", { mode: 0o600 });
    expect(() => storeProviderCredential(file, "new")).toThrow();
    expect(readFileSync(file, "utf8")).toBe("old");
    const link = join(dir, "link"); symlinkSync(file, link);
    expect(() => storeProviderCredential(link, "new")).toThrow();
    expect(() => readProviderCredential(link)).toThrow();
  });
  it("rejects world-readable files and missing directories", () => {
    const dir = fixture(), file = join(dir, "token");
    writeFileSync(file, "old", { mode: 0o644 });
    expect(() => readProviderCredential(file)).toThrow();
    expect(() => storeProviderCredential(join(dir, "missing", "token"), "new")).toThrow();
    mkdirSync(join(dir, "empty"));
  });
});
