import { isAbsolute, join, resolve, sep } from "node:path";

/** Offline plan only: daemon startup must additionally check symlink/canonical path overlap
 * and runtime ownership before touching any files. Never use this as a security boundary. */
export interface InstanceRequest { instanceDir: string; defaultHome: string; port: number }
export interface InstancePlan { home: string; database: string; port: number }

const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);

export function planIsolatedInstance(request: InstanceRequest): InstancePlan {
  if (!isAbsolute(request.instanceDir) || !isAbsolute(request.defaultHome)
    || !Number.isSafeInteger(request.port) || request.port < 1024 || request.port > 65535) {
    throw new Error("invalid isolated instance path or port");
  }
  const home = resolve(request.instanceDir);
  const defaultHome = resolve(request.defaultHome);
  if (overlaps(home, defaultHome)) throw new Error("instance directory overlaps the default home");
  return { home, database: join(home, "rig.db"), port: request.port };
}
