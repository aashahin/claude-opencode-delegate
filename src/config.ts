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

/** Unset → fallback; set to "" → undefined (use opencode's own default). */
function model(v: string | undefined, fallback: string): string | undefined {
  if (v === undefined) return fallback;
  return v.trim() || undefined;
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
  defaultModel: model(process.env.OPENCODE_DELEGATE_DEFAULT_MODEL, "opencode-go/muse-spark-1.3-contributor"),
  // Used when no model is given and the run is read-only (auto: false): reading, reviews, questions.
  readModel: model(process.env.OPENCODE_DELEGATE_READ_MODEL, "opencode/muse-spark-1.3-contributor-free"),
  auto: bool(process.env.OPENCODE_DELEGATE_AUTO, true),
  timeoutSec: int(process.env.OPENCODE_DELEGATE_TIMEOUT, 1800),
  maxOutputChars: int(process.env.OPENCODE_DELEGATE_MAX_OUTPUT, 40000),
  defaultCwd: process.env.OPENCODE_DELEGATE_CWD || process.cwd(),
  // Providers to prefer when the same model is offered by several, highest priority first.
  preferredProviders: (process.env.OPENCODE_DELEGATE_PREFERRED_PROVIDERS ?? "")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean),
};
