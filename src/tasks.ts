import { randomUUID } from "node:crypto";
import { delegate, type DelegateInput, type DelegateOutcome } from "./delegate.ts";

export type TaskStatus = "running" | "done" | "error" | "cancelled";

export interface Task {
  id: string;
  input: DelegateInput;
  status: TaskStatus;
  startedAt: number;
  finishedAt?: number;
  outcome?: DelegateOutcome;
  error?: string;
  promise: Promise<void>;
  controller: AbortController;
}

const MAX_FINISHED = 100;
const tasks = new Map<string, Task>();

function prune() {
  const finished = [...tasks.values()].filter((t) => t.status !== "running").sort((a, b) => a.startedAt - b.startedAt);
  for (const t of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) tasks.delete(t.id);
}

export function startTask(input: DelegateInput): Task {
  const controller = new AbortController();
  const task = { id: `task_${randomUUID().slice(0, 8)}`, input, status: "running", startedAt: Date.now(), controller } as Task;
  task.promise = delegate(input, controller.signal).then(
    (outcome) => {
      task.outcome = outcome;
      task.status = controller.signal.aborted ? "cancelled" : outcome.result.ok ? "done" : "error";
    },
    (err: unknown) => {
      task.error = err instanceof Error ? err.message : String(err);
      task.status = "error";
    },
  ).finally(() => {
    task.finishedAt = Date.now();
    prune();
  });
  tasks.set(task.id, task);
  return task;
}

export function getTask(id: string): Task | undefined {
  return tasks.get(id);
}

export function listTasks(): Task[] {
  return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export async function waitTask(task: Task, waitSec: number): Promise<void> {
  if (task.status !== "running" || waitSec <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([task.promise, new Promise((r) => (timer = setTimeout(r, waitSec * 1000)))]);
  clearTimeout(timer);
}
