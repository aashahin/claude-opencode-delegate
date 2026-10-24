import { config } from "./config.ts";
import { runProcess } from "./process.ts";
import { REVIEW_AGENT, reviewEnvironment, type DelegateMode } from "./permissions.ts";

export interface RunOptions {
  prompt: string;
  model?: string;
  cwd?: string;
  agent?: string;
  files?: string[];
  sessionId?: string;
  continueLast?: boolean;
  fork?: boolean;
  auto?: boolean;
  title?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  mode?: DelegateMode;
  onSession?: (sessionId: string) => void;
}

export interface ToolCall {
  tool: string;
  status: string;
  title?: string;
  input?: unknown;
  error?: string;
}

export interface RunResult {
  ok: boolean;
  sessionId?: string;
  text: string;
  toolCalls: ToolCall[];
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  cost: number;
  steps: number;
  error?: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export function buildArgs(o: RunOptions): string[] {
  const args = ["run", "--standalone", "--format", "json"];
  if (o.model) args.push("--model", o.model);
  if (o.mode === "read-only") args.push("--agent", REVIEW_AGENT);
  else if (o.agent) args.push("--agent", o.agent);
  if (o.sessionId) args.push("--session", o.sessionId);
  else if (o.continueLast) args.push("--continue");
  if (o.fork && (o.sessionId || o.continueLast)) args.push("--fork");
  if (o.auto && o.mode !== "read-only") args.push("--auto");
  if (o.title) args.push("--title", o.title);
  for (const f of o.files ?? []) args.push("--file", f);
  // "--" so prompts starting with "-" are not parsed as flags
  args.push("--", o.prompt);
  return args;
}

/** Folds opencode `--format json` event lines into a result. Unknown events are ignored. */
export class EventCollector {
  sessionId?: string;
  texts: string[] = [];
  toolCalls: ToolCall[] = [];
  tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  cost = 0;
  steps = 0;
  errors: string[] = [];
  raw: string[] = [];

  push(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let e: any;
    try {
      e = JSON.parse(trimmed);
    } catch {
      this.raw.push(trimmed);
      return;
    }
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new Error("invalid OpenCode event object");
    if (e.sessionID !== undefined && typeof e.sessionID !== "string") throw new Error("invalid OpenCode session ID");
    if (e.sessionID && this.sessionId && this.sessionId !== e.sessionID) throw new Error("mixed OpenCode session IDs");
    if (e.sessionID && !this.sessionId) this.sessionId = e.sessionID;
    const p = e.part ?? {};
    switch (e.type) {
      case "text":
        if (typeof p.text !== "string") throw new Error("invalid OpenCode text event");
        if (p.text.trim()) this.texts.push(p.text);
        break;
      case "tool_use":
        if (typeof p.tool !== "string" || typeof p.state?.status !== "string") throw new Error("invalid OpenCode tool event");
        this.toolCalls.push({
          tool: p.tool,
          status: p.state?.status,
          title: p.state?.title,
          input: p.state?.input,
          error: p.state?.error,
        });
        break;
      case "step_finish": {
        this.steps++;
        const t = p.tokens ?? {};
        for (const value of [t.input, t.output, t.reasoning, t.cache?.read, t.cache?.write, p.cost]) {
          if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
            throw new Error("invalid OpenCode usage event");
          }
        }
        this.tokens.input += t.input ?? 0;
        this.tokens.output += t.output ?? 0;
        this.tokens.reasoning += t.reasoning ?? 0;
        this.tokens.cacheRead += t.cache?.read ?? 0;
        this.tokens.cacheWrite += t.cache?.write ?? 0;
        this.cost += Number(p.cost ?? 0) || 0;
        break;
      }
      case "error":
        this.errors.push(errorMessage(e.error ?? e));
        break;
    }
  }

  /** All assistant text parts, falling back to non-JSON stdout. */
  get text(): string {
    return this.texts.join("\n\n").trim() || this.raw.join("\n").trim();
  }
}

function errorMessage(err: any): string {
  const msg = err?.data?.message ?? err?.message ?? err?.name ?? err?.type;
  const ref = err?.data?.ref ? ` (ref ${err.data.ref})` : "";
  return typeof msg === "string" ? msg + ref : JSON.stringify(err);
}

export async function runOpencode(o: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const collector = new EventCollector();
  const r = await runProcess(config.bin, buildArgs(o), {
    cwd: o.cwd,
    env: o.mode === "read-only" ? reviewEnvironment() : undefined,
    signal: o.signal,
    timeoutMs: o.timeoutMs,
    onLine: (line) => {
      const previous = collector.sessionId;
      collector.push(line);
      if (collector.sessionId && !previous) o.onSession?.(collector.sessionId);
    },
  });
  const errors = [...collector.errors];
  if (r.error) errors.push(r.error);
  if (r.timedOut) errors.push(`timed out after ${Math.round((o.timeoutMs ?? 0) / 1000)}s`);
  if (o.signal?.aborted && !r.error) errors.push("cancelled");
  if (r.code !== 0 && !errors.length) errors.push(r.stderr.trim().split("\n").slice(-5).join("\n") || `exit code ${r.code}`);
  if (
    !errors.length &&
    (!collector.sessionId || (!collector.texts.length && !collector.steps && !collector.toolCalls.length) || collector.raw.length)
  ) {
    errors.push("invalid OpenCode JSON output: no recognized session result or non-JSON stdout");
  }
  return {
    ok: r.code === 0 && !errors.length,
    sessionId: collector.sessionId,
    text: collector.text,
    toolCalls: collector.toolCalls,
    tokens: collector.tokens,
    cost: collector.cost,
    steps: collector.steps,
    error: errors.join("; ") || undefined,
    exitCode: r.code,
    timedOut: r.timedOut,
    durationMs: Date.now() - started,
  };
}

export async function execText(
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await runProcess(config.bin, args, { cwd, signal });
  if (r.error) throw new Error(r.error);
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}
