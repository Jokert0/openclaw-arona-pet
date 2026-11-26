import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
export const project = dirname(fileURLToPath(import.meta.url));
export function electronBinary() {
  const local = fileURLToPath(new URL("./.runtime/electron/electron.exe", import.meta.url));
  return existsSync(local) ? local : createRequire(import.meta.url)("electron");
}
export function launch(env, detached = false) {
  const clean = { ...env };
  delete clean.ELECTRON_RUN_AS_NODE;
  return spawn(electronBinary(), [project], {
    env: clean,
    detached,
    windowsHide: true,
    stdio: detached ? "ignore" : "inherit",
  });
}
