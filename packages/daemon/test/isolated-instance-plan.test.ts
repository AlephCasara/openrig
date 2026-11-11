import { describe, expect, it } from "vitest";
import { planIsolatedInstance } from "../src/domain/isolated-instance-plan.js";

describe("offline instance path plan (#29)", () => {
  it("binds home, DB and explicit port beneath one isolated directory", () => {
    expect(planIsolatedInstance({ instanceDir: "/tmp/isolated-rehearsal", defaultHome: "/tmp/user-home/.openrig", port: 32123 })).toEqual({
      home: "/tmp/isolated-rehearsal", database: "/tmp/isolated-rehearsal/rig.db", port: 32123,
    });
  });
  it("refuses overlapping default home (including ancestors and descendants)", () => {
    for (const instanceDir of ["/tmp/user-home", "/tmp/user-home/.openrig", "/tmp/user-home/.openrig/copy"]) {
      expect(() => planIsolatedInstance({ instanceDir, defaultHome: "/tmp/user-home/.openrig", port: 32123 })).toThrow();
    }
  });
  it("refuses relative paths and privileged or invalid ports", () => {
    expect(() => planIsolatedInstance({ instanceDir: "relative", defaultHome: "/tmp/default", port: 32123 })).toThrow();
    expect(() => planIsolatedInstance({ instanceDir: "/tmp/isolated", defaultHome: "/tmp/default", port: 0 })).toThrow();
    expect(() => planIsolatedInstance({ instanceDir: "/tmp/isolated", defaultHome: "/tmp/default", port: 65536 })).toThrow();
  });
});
