import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuzzCliClient, makeBuzzCliRunner } from "../src/domain/gateway/buzz-cli.js";

const channelId = "36c6fc48-43ca-4ec3-a850-27b145de9b1e";
const eventId = "a".repeat(64);
const pubkey = "b".repeat(64);
const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function makeExecutable(script: string): { binary: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "buzz-transport-test-"));
  tempDirs.push(dir);
  const binary = join(dir, "buzz-fixture.mjs");
  const log = join(dir, "calls.json");
  writeFileSync(binary, "#!/usr/bin/env node\n" + script);
  chmodSync(binary, 0o700);
  return { binary, log };
}

describe("Buzz executable subprocess boundary (no OpenRig daemon or real relay)", () => {
  it("starts a real CLI-shaped executable and sends content only through stdin", async () => {
    const fixture = makeExecutable(`
      import { readFileSync, writeFileSync } from "node:fs";
      const args = process.argv.slice(2);
      const stdin = readFileSync(0, "utf8");
      writeFileSync("__LOG_PATH__", JSON.stringify({ args, stdin }));
      process.stdout.write(JSON.stringify({accepted:true,event_id:"${eventId}"}));
    `);
    // Place test output only inside the isolated temporary directory.
    const script = readFileSync(fixture.binary, "utf8").replace("__LOG_PATH__", fixture.log);
    writeFileSync(fixture.binary, script);
    const client = new BuzzCliClient({ binary: fixture.binary, timeoutMs: 3000 });
    expect(await client.sendMessage({ channelId, content: "never-a-process-argument" }))
      .toEqual({ eventId });
    expect(JSON.parse(readFileSync(fixture.log, "utf8"))).toEqual({
      args: ["messages", "send", "--channel", channelId, "--content", "-"],
      stdin: "never-a-process-argument",
    });
  });

  it("parses a real spawned CLI process output with thread and identity metadata", async () => {
    const fixture = makeExecutable(`
      const args = process.argv.slice(2);
      const channel = args[args.indexOf("--channel") + 1];
      const out = [{id:"${eventId}",pubkey:"${pubkey}",kind:9,content:"hello",created_at:12,
        tags:[["h",channel],["e","${"c".repeat(64)}","","reply"]]}];
      process.stdout.write(JSON.stringify(out));
    `);
    const messages = await new BuzzCliClient({ binary: fixture.binary, timeoutMs: 3000 })
      .getMessages({ channelId, since: 10 });
    expect(messages).toEqual([{
      id: eventId, authorPubkey: pubkey, channelId, content: "hello", createdAt: 12,
      replyTo: "c".repeat(64),
    }]);
  });

  it("rejects nonzero exit without exposing private stderr text in the thrown error", async () => {
    const fixture = makeExecutable(`
      process.stderr.write("PRIVATE_KEY_MUST_NOT_LEAK");
      process.exit(3);
    `);
    await expect(new BuzzCliClient({ binary: fixture.binary, timeoutMs: 3000 })
      .sendMessage({ channelId, content: "test" }))
      .rejects.toThrow("Buzz CLI exited with code 3");
  });

  it("kills a stuck child process on timeout without starting a daemon", async () => {
    const fixture = makeExecutable("setInterval(() => {}, 1000);");
    await expect(makeBuzzCliRunner(fixture.binary, 200)(["messages", "get", "--channel", channelId]))
      .rejects.toThrow("Buzz CLI timed out");
  });
});
