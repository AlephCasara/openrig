/** Offline credential file primitives. Never include contents in logs or errors.
 * This module does NOT migrate Claude settings or inject a token into a seat wrapper. */
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

function assertPrivate(fd: number): void {
  const s = fstatSync(fd);
  if (!s.isFile() || (s.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && s.uid !== process.getuid())) {
    throw new Error("provider credential file must be a regular, current-user-owned 0600 file");
  }
}

export function storeProviderCredential(file: string, token: string): void {
  if (!file.startsWith("/") || !token || /[\r\n\0]/.test(token)) throw new Error("invalid credential file request");
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let success = false;
  try {
    fchmodSync(fd, 0o600);
    assertPrivate(fd);
    writeSync(fd, token, undefined, "utf8");
    fsyncSync(fd);
    success = true;
  } finally {
    closeSync(fd);
    if (!success) unlinkSync(file);
  }
}

export function readProviderCredential(file: string): string {
  if (!file.startsWith("/")) throw new Error("invalid credential path");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assertPrivate(fd);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
