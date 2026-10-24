import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { config } from "./config.ts";
import { resolveModelOrThrow } from "./models.ts";
import { runOpencode, type RunResult } from "./opencode.ts";
import { checkAbort } from "./process.ts";
import { changedPaths, createWorktree, gitRoot, snapshot } from "./git.ts";
import type { DelegateMode } from "./permissions.ts";
import { checkCompatibility } from "./compatibility.ts";

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
  mode?: DelegateMode;
  worktree?: boolean;
  title?: string;
  timeout_s?: number;
}
export interface DelegateOutcome {
  model?: string;
  cwd: string;
  requestedCwd?: string;
  mode?: DelegateMode;
  result: RunResult;
  changedFiles?: string[];
  gitRoot?: string;
  baseHead?: string;
  finalHead?: string;
  changesError?: string;
}
export interface Checkpoint {
  cwd: string;
  model?: string;
  sessionId?: string;
}

const locks = new Set<string>();
const controllers = new Set<AbortController>();
export function stopDelegates(): void {
  for (const controller of controllers) controller.abort(new Error("server shutting down"));
}

export async function delegate(
  input: DelegateInput,
  signal?: AbortSignal,
  checkpoint?: (value: Checkpoint) => void,
): Promise<DelegateOutcome> {
  checkAbort(signal);
  if (controllers.size >= config.maxTasks) throw new Error(`maximum of ${config.maxTasks} active delegations reached`);
  const controller = new AbortController();
  controllers.add(controller);
  const duration = (input.timeout_s ?? config.timeoutSec) * 1000;
  const deadline = setTimeout(() => controller.abort(new Error("delegation deadline exceeded")), duration);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const owned = new Set<string>();
  try {
    const requestedCwd = await realpath(resolve(config.defaultCwd, input.cwd ?? "."));
    if (!(await stat(requestedCwd)).isDirectory()) throw new Error("cwd must be a directory");
    checkAbort(combined);
    const auto = input.auto ?? config.auto;
    const mode = input.mode ?? (auto ? "write" : "read-only");
    if (mode === "read-only" && input.agent) throw new Error("read-only mode uses its own restricted agent; omit agent");
    if (input.worktree && (mode === "read-only" || input.session_id || input.continue))
      throw new Error("worktree requires a new write session; follow up using the returned cwd and session_id");
    const root = await gitRoot(requestedCwd, combined);
    const claim = (key: string) => {
      if (locks.has(key)) throw new Error("another delegation owns this cwd/session; use separate worktrees");
      locks.add(key);
      owned.add(key);
    };
    if (input.session_id) claim(`session:${input.session_id}`);
    // Session ownership never substitutes for directory ownership.
    const dirLock = root ?? requestedCwd;
    claim(dirLock);
    let cwd = requestedCwd;
    let activeRoot = root;
    await checkCompatibility(combined);
    const query = input.model ?? (mode === "write" ? config.defaultModel : (config.readModel ?? config.defaultModel));
    if (!query && config.allowedModels.length) throw new Error("an explicit model is required when ALLOWED_MODELS is configured");
    const model = query ? await resolveModelOrThrow(query, combined, cwd) : undefined;
    if (
      model &&
      config.allowedModels.length &&
      !config.allowedModels.includes(model) &&
      !config.allowedModels.includes(model.split("#")[0]!)
    ) {
      throw new Error(`model '${model}' is not in OPENCODE_DELEGATE_ALLOWED_MODELS`);
    }
    checkAbort(combined);
    if (input.worktree) {
      if (!root) throw new Error("worktree requires a git repository");
      cwd = await createWorktree(root, combined);
      activeRoot = cwd;
      locks.delete(dirLock);
      owned.delete(dirLock);
      claim(cwd);
    }
    checkpoint?.({ cwd, model });
    const files = input.files?.map((f) => (isAbsolute(f) ? f : resolve(cwd, f)));
    const before = activeRoot ? await snapshot(activeRoot, combined) : undefined;
    checkAbort(combined);
    const result = await runOpencode({
      prompt: input.prompt,
      model,
      cwd,
      agent: input.agent,
      files,
      sessionId: input.session_id,
      continueLast: input.continue,
      fork: input.fork,
      auto: mode === "write" && auto,
      mode,
      title: input.title,
      timeoutMs: duration,
      signal: combined,
      onSession: (sessionId) => checkpoint?.({ cwd, model, sessionId }),
    });
    const outcome: DelegateOutcome = { model, cwd, requestedCwd, mode, result, gitRoot: activeRoot, baseHead: before?.head };
    if (before) {
      try {
        // Reporting is separately bounded after cancellation; never lose already-made changes.
        const changes = await changedPaths(before, AbortSignal.timeout(config.helperTimeoutSec * 1000));
        outcome.changedFiles = changes.files;
        outcome.finalHead = changes.head;
      } catch (e) {
        outcome.changesError = e instanceof Error ? e.message : String(e);
      }
    }
    return outcome;
  } finally {
    for (const key of owned) locks.delete(key);
    clearTimeout(deadline);
    controllers.delete(controller);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…[truncated ${s.length - max} chars — continue the session to ask for the rest]`;
}

export function formatOutcome(o: DelegateOutcome): string {
  const r = o.result;
  const lines = [
    `status: ${r.ok ? "ok" : "error"} (execution only; review/tests determine task acceptance)`,
    `model: ${o.model ?? "(opencode default)"}`,
    `session_id: ${r.sessionId ?? "(none)"}`,
    `cwd: ${o.cwd}`,
    `mode: ${o.mode ?? "write"}`,
    `duration: ${(r.durationMs / 1000).toFixed(1)}s, steps: ${r.steps}, tokens in/out: ${r.tokens.input + r.tokens.cacheRead}/${r.tokens.output}${r.cost ? `, cost: $${r.cost.toFixed(4)}` : ""}`,
  ];
  if (o.requestedCwd && o.requestedCwd !== o.cwd) lines.push(`source cwd: ${o.requestedCwd}; isolated worktree retained for review`);
  if (o.gitRoot) lines.push(`git root: ${o.gitRoot} (reported paths are relative to this root)`);
  if (o.baseHead !== o.finalHead && o.finalHead) lines.push(`HEAD moved: ${o.baseHead || "(unborn)"} → ${o.finalHead}`);
  if (r.error) lines.push(`error: ${r.error}`);
  if (r.toolCalls.length) {
    const counts = new Map<string, number>();
    for (const t of r.toolCalls) counts.set(t.tool, (counts.get(t.tool) ?? 0) + 1);
    lines.push(`tools used: ${[...counts].map(([k, v]) => `${k}×${v}`).join(", ")}`);
    for (const t of r.toolCalls.filter((t) => t.status === "error"))
      lines.push(`tool error: ${t.tool}: ${t.error ?? "(see session transcript)"}`);
  }
  if (o.changedFiles)
    lines.push(
      o.changedFiles.length ? `git changes:\n${o.changedFiles.map((f) => `  ${JSON.stringify(f)}`).join("\n")}` : "git changes: none",
    );
  else lines.push(`git changes: unavailable${o.changesError ? ` (${o.changesError})` : " (not a git repository)"}`);
  lines.push("", "--- response ---", truncate(r.text || "(no text output)", config.maxOutputChars));
  return lines.join("\n");
}
