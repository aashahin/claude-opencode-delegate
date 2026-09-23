import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// GUI apps like Claude Desktop often don't inherit the shell PATH, so also check common install dirs.
const FALLBACK_DIRS = [
  join(homedir(), ".opencode", "bin"),
  join(homedir(), ".bun", "bin"),
  join(homedir(), ".local", "bin"),
  join(homedir(), ".npm-global", "bin"),
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
];

export function resolveBin(env = process.env): string {
  if (env.OPENCODE_BIN) return env.OPENCODE_BIN;
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...FALLBACK_DIRS];
  for (const dir of dirs) {
    const candidate = join(dir, "opencode");
    if (existsSync(candidate)) return candidate;
  }
  return "opencode";
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === "") return dflt;
  return !/^(0|false|no|off)$/i.test(v);
}

function int(v: string | undefined, dflt: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export const config = {
  bin: resolveBin(),
  defaultModel: process.env.OPENCODE_DELEGATE_DEFAULT_MODEL || undefined,
  auto: bool(process.env.OPENCODE_DELEGATE_AUTO, true),
  timeoutSec: int(process.env.OPENCODE_DELEGATE_TIMEOUT, 1800),
  maxOutputChars: int(process.env.OPENCODE_DELEGATE_MAX_OUTPUT, 40000),
  defaultCwd: process.env.OPENCODE_DELEGATE_CWD || process.cwd(),
};
