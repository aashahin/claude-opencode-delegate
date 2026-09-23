#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { z } from "zod";
import { config } from "./config.ts";
import { delegate, formatOutcome } from "./delegate.ts";
import { listModels } from "./models.ts";
import { execText } from "./opencode.ts";
import { getTask, listTasks, startTask, waitTask, type Task } from "./tasks.ts";
import pkg from "../package.json" with { type: "json" };

const server = new McpServer({ name: "opencode-delegate", version: pkg.version });

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

const delegateShape = {
  prompt: z
    .string()
    .min(1)
    .describe(
      "Complete, self-contained task for the opencode model. It cannot see this conversation: include goal, relevant files/paths, constraints, and acceptance criteria.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      `opencode model: exact 'provider/model' id (e.g. 'xai/grok-4.7') or a loose name ('grok 4.7', 'kimi k3'). Append '#variant' for a reasoning variant. Omit to use the default: ${config.defaultModel ?? "opencode's default"} for normal tasks, ${config.readModel ?? config.defaultModel ?? "opencode's default"} (free) when auto is false.`,
    ),
  cwd: z.string().optional().describe("Working directory for the task (absolute, or relative to the server's cwd). Defaults to the current project."),
  agent: z.string().optional().describe("opencode agent to use (e.g. 'build', 'plan', or a custom agent)."),
  files: z.array(z.string()).optional().describe("Files to attach to the message."),
  session_id: z.string().optional().describe("Continue an existing opencode session (returned by a previous call) for follow-ups."),
  continue: z.boolean().optional().describe("Continue the most recent opencode session in cwd."),
  fork: z.boolean().optional().describe("Fork the session given by session_id/continue instead of appending to it."),
  auto: z
    .boolean()
    .optional()
    .describe(`Auto-approve tool permissions (edits, shell) that are not explicitly denied. Default: ${config.auto}. Set false for read-only work (reading files, reviews, questions); without a model that also selects the free read model.`),
  title: z.string().optional().describe("Session title shown in opencode."),
  timeout_s: z.number().int().positive().optional().describe(`Kill the run after this many seconds. Default: ${config.timeoutSec}.`),
};

server.registerTool(
  "list_models",
  {
    title: "List opencode models",
    description: "List the models available in the local opencode install, as 'provider/model' ids.",
    inputSchema: {
      filter: z.string().optional().describe("Case-insensitive substring filter, e.g. 'grok' or 'opencode-go/'."),
      refresh: z.boolean().optional().describe("Bypass the 5 minute cache."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ filter, refresh }) => {
    try {
      let models = await listModels(refresh);
      if (filter) models = models.filter((m) => m.toLowerCase().includes(filter.toLowerCase()));
      return text(models.length ? models.join("\n") : "(no models match)");
    } catch (e) {
      return text(String(e instanceof Error ? e.message : e), true);
    }
  },
);

server.registerTool(
  "delegate",
  {
    title: "Delegate a task to an opencode model",
    description:
      "Run a task with another model through opencode (`opencode run`) and wait for it to finish. The model works in `cwd` with opencode's own tools (read/edit/shell), so it can implement code, not just answer. Returns its final response, session_id (for follow-ups), token usage and git changes. You remain the orchestrator: review its changes afterwards. For long tasks or running several models in parallel, use delegate_async.",
    inputSchema: delegateShape,
  },
  async (input, extra) => {
    const progressToken = extra._meta?.progressToken;
    let tick = 0;
    // Keep-alive progress so clients that reset timeouts on progress don't give up on long runs.
    const heartbeat = progressToken
      ? setInterval(() => {
          tick++;
          extra
            .sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: tick, message: `opencode running (${tick * 15}s)` },
            })
            .catch(() => {});
        }, 15000)
      : undefined;
    try {
      const outcome = await delegate(input, extra.signal);
      return text(formatOutcome(outcome), !outcome.result.ok);
    } catch (e) {
      return text(String(e instanceof Error ? e.message : e), true);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  },
);

function taskSummary(t: Task): string {
  const secs = (((t.finishedAt ?? Date.now()) - t.startedAt) / 1000).toFixed(0);
  const model = t.outcome?.model ?? t.input.model ?? "(default)";
  return `${t.id}  ${t.status.padEnd(9)} ${secs}s  ${model}  ${t.input.title ?? t.input.prompt.slice(0, 60).replace(/\s+/g, " ")}`;
}

server.registerTool(
  "delegate_async",
  {
    title: "Start an opencode task in the background",
    description:
      "Same as delegate, but returns a task_id immediately while the opencode model works in the background. Use for long tasks or to run several models in parallel; then call task_result to collect output. Parallel tasks editing the same directory can conflict — give each its own cwd/worktree or non-overlapping files.",
    inputSchema: delegateShape,
  },
  async (input) => {
    const t = startTask(input);
    return text(`started ${t.id}\nCall task_result with task_id="${t.id}" (optionally wait_s) to get the output.`);
  },
);

server.registerTool(
  "task_result",
  {
    title: "Get a background opencode task's result",
    description: "Return the status/result of a delegate_async task, optionally waiting up to wait_s seconds for it to finish.",
    inputSchema: {
      task_id: z.string(),
      wait_s: z.number().int().min(0).max(3600).optional().describe("Seconds to wait for completion before returning (default 0)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ task_id, wait_s }) => {
    const t = getTask(task_id);
    if (!t) return text(`unknown task_id '${task_id}'`, true);
    await waitTask(t, wait_s ?? 0);
    if (t.status === "running") return text(`${taskSummary(t)}\nstill running — call again later or with a larger wait_s.`);
    if (t.outcome) return text(`task: ${t.id} (${t.status})\n${formatOutcome(t.outcome)}`, t.status !== "done");
    return text(`task: ${t.id} (${t.status})\nerror: ${t.error}`, true);
  },
);

server.registerTool(
  "task_list",
  {
    title: "List background opencode tasks",
    description: "List delegate_async tasks started by this server with their status.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const all = listTasks();
    return text(all.length ? all.map(taskSummary).join("\n") : "(no tasks)");
  },
);

server.registerTool(
  "task_cancel",
  {
    title: "Cancel a background opencode task",
    description: "Stop a running delegate_async task.",
    inputSchema: { task_id: z.string() },
  },
  async ({ task_id }) => {
    const t = getTask(task_id);
    if (!t) return text(`unknown task_id '${task_id}'`, true);
    if (t.status !== "running") return text(`${t.id} already ${t.status}`);
    t.controller.abort();
    await waitTask(t, 5);
    return text(`${t.id} ${t.status === "running" ? "cancelling" : t.status}`);
  },
);

server.registerTool(
  "list_sessions",
  {
    title: "List opencode sessions",
    description: "List recent opencode sessions for a project directory (to find a session_id to continue).",
    inputSchema: {
      cwd: z.string().optional().describe("Project directory. Defaults to the current project."),
      limit: z.number().int().positive().max(100).optional().describe("Max sessions (default 20)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ cwd, limit }) => {
    const dir = resolve(config.defaultCwd, cwd ?? ".");
    const r = await execText(["session", "list", "-n", String(limit ?? 20)], dir);
    if (r.code !== 0) return text(r.stderr.trim() || `exit ${r.code}`, true);
    return text(r.stdout.trim() || "(no sessions)");
  },
);

await server.connect(new StdioServerTransport());
