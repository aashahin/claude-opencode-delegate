import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { config } from "./config.ts";
import { resolveModelOrThrow } from "./models.ts";
import { runOpencode, type RunResult } from "./opencode.ts";

export interface DelegateInput {
  prompt: string;
  model?: string;
  cwd?: string;
  agent?: string;
  files?: string[];
  session_id?: string;
  continue?: boolean;
  fork?: boolean;
  auto?: boolean;
  title?: string;
  timeout_s?: number;
}

export interface DelegateOutcome {
  model?: string;
  cwd: string;
  result: RunResult;
  changedFiles?: string[];
}

function gitStatus(cwd: string): Set<string> | undefined {
  const r = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return undefined;
  return new Set(r.stdout.split("\n").filter(Boolean));
}

export async function delegate(input: DelegateInput, signal?: AbortSignal): Promise<DelegateOutcome> {
  const cwd = resolve(config.defaultCwd, input.cwd ?? ".");
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  const auto = input.auto ?? config.auto;
  const query = input.model ?? (auto ? config.defaultModel : (config.readModel ?? config.defaultModel));
  const model = query ? await resolveModelOrThrow(query) : undefined;
  const files = input.files?.map((f) => (isAbsolute(f) ? f : resolve(cwd, f)));

  const before = gitStatus(cwd);
  const result = await runOpencode({
    prompt: input.prompt,
    model,
    cwd,
    agent: input.agent,
    files,
    sessionId: input.session_id,
    continueLast: input.continue,
    fork: input.fork,
    auto,
    title: input.title,
    timeoutMs: (input.timeout_s ?? config.timeoutSec) * 1000,
    signal,
  });
  const after = before && gitStatus(cwd);
  const changedFiles = after ? [...after].filter((l) => !before!.has(l)) : undefined;
  return { model, cwd, result, changedFiles };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…[truncated ${s.length - max} chars — continue the session to ask for the rest]`;
}

export function formatOutcome(o: DelegateOutcome): string {
  const r = o.result;
  const lines = [
    `status: ${r.ok ? "ok" : "error"}`,
    `model: ${o.model ?? "(opencode default)"}`,
    `session_id: ${r.sessionId ?? "(none)"}`,
    `cwd: ${o.cwd}`,
    `duration: ${(r.durationMs / 1000).toFixed(1)}s, steps: ${r.steps}, tokens in/out: ${r.tokens.input + r.tokens.cacheRead}/${r.tokens.output}${r.cost ? `, cost: $${r.cost.toFixed(4)}` : ""}`,
  ];
  if (r.error) lines.push(`error: ${r.error}`);
  if (r.toolCalls.length) {
    const counts = new Map<string, number>();
    for (const t of r.toolCalls) counts.set(t.tool, (counts.get(t.tool) ?? 0) + 1);
    lines.push(`tools used: ${[...counts].map(([k, v]) => `${k}×${v}`).join(", ")}`);
  }
  if (o.changedFiles) {
    lines.push(o.changedFiles.length ? `git changes:\n${o.changedFiles.map((f) => `  ${f}`).join("\n")}` : "git changes: none");
  }
  lines.push("", "--- response ---", truncate(r.text || "(no text output)", config.maxOutputChars));
  return lines.join("\n");
}
