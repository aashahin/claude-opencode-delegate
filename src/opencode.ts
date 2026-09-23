import { spawn } from "node:child_process";
import { config } from "./config.ts";

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
}

export interface ToolCall {
  tool: string;
  status: string;
  title?: string;
  input?: unknown;
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
  const args = ["run", "--format", "json"];
  if (o.model) args.push("--model", o.model);
  if (o.agent) args.push("--agent", o.agent);
  if (o.sessionId) args.push("--session", o.sessionId);
  else if (o.continueLast) args.push("--continue");
  if (o.fork && (o.sessionId || o.continueLast)) args.push("--fork");
  if (o.auto) args.push("--auto");
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
    if (e.sessionID && !this.sessionId) this.sessionId = e.sessionID;
    const p = e.part ?? {};
    switch (e.type) {
      case "text":
        if (typeof p.text === "string") this.texts.push(p.text);
        break;
      case "tool_use":
        this.toolCalls.push({
          tool: p.tool,
          status: p.state?.status,
          title: p.state?.title,
          input: p.state?.input,
        });
        break;
      case "step_finish": {
        this.steps++;
        const t = p.tokens ?? {};
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

export function runOpencode(o: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const collector = new EventCollector();
  return new Promise((resolve) => {
    const child = spawn(config.bin, buildArgs(o), {
      cwd: o.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const kill = () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 3000).unref();
      }
    };
    const timer = o.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, o.timeoutMs)
      : undefined;
    o.signal?.addEventListener("abort", kill, { once: true });

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        collector.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      collector.push(buf);
      const errors = [...collector.errors];
      if (spawnError) errors.push(spawnError);
      if (timedOut) errors.push(`timed out after ${Math.round((o.timeoutMs ?? 0) / 1000)}s`);
      else if (o.signal?.aborted) errors.push("cancelled");
      if (exitCode && !errors.length) errors.push(stderr.trim().split("\n").slice(-5).join("\n") || `exit code ${exitCode}`);
      resolve({
        ok: exitCode === 0 && !errors.length,
        sessionId: collector.sessionId,
        text: collector.text,
        toolCalls: collector.toolCalls,
        tokens: collector.tokens,
        cost: collector.cost,
        steps: collector.steps,
        error: errors.join("; ") || undefined,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
      });
    };
    child.on("error", (err) => finish(null, `failed to start '${config.bin}': ${err.message}`));
    child.on("close", (code) => finish(code));
  });
}

export function execText(args: string[], cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(config.bin, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.on("error", (err) => resolve({ code: null, stdout, stderr: err.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
