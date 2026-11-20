import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { delegate, type Checkpoint, type DelegateInput, type DelegateOutcome } from "./delegate.ts";
import { config } from "./config.ts";

export type TaskStatus = "running" | "done" | "error" | "cancelled";
export interface Task {
  id: string;
  input: DelegateInput;
  status: TaskStatus;
  startedAt: number;
  finishedAt?: number;
  outcome?: DelegateOutcome;
  error?: string;
  checkpoint?: Checkpoint;
  promise: Promise<void>;
  controller: AbortController;
}
const MAX_FINISHED = 100;
type Runner = typeof delegate;

/** Optional local journal: recover results/session IDs, never replay an interrupted task. */
export class TaskStore {
  private tasks = new Map<string, Task>();
  constructor(
    private directory?: string,
    private runner: Runner = delegate,
  ) {
    if (!directory) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(directory).filter((f) => /^task_[a-f0-9-]+\.json$/.test(f))) {
      try {
        const saved = JSON.parse(readFileSync(join(directory, file), "utf8"));
        if (file !== `${saved.id}.json` || !["running", "done", "error", "cancelled"].includes(saved.status) || !saved.input) continue;
        const task: Task = { ...saved, controller: new AbortController(), promise: Promise.resolve() };
        if (task.status === "running") {
          task.status = "error";
          task.finishedAt = Date.now();
          task.error = "server restarted; execution state unknown — inspect the saved cwd/session before retrying";
        }
        this.tasks.set(task.id, task);
      } catch (e) {
        process.stderr.write(`ignoring invalid task journal '${file}': ${String(e)}\n`);
      }
    }
    this.prune();
  }

  private save(task: Task) {
    if (!this.directory) return;
    const { prompt: _, ...input } = task.input;
    const record = {
      id: task.id,
      input: { ...input, prompt: "(prompt not persisted)" },
      status: task.status,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      outcome: task.outcome
        ? {
            ...task.outcome,
            result: { ...task.outcome.result, toolCalls: task.outcome.result.toolCalls.map(({ input: _, ...tool }) => tool) },
          }
        : undefined,
      error: task.error,
      checkpoint: task.checkpoint,
    };
    const file = join(this.directory, `${task.id}.json`);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    renameSync(temp, file);
  }
  private prune() {
    const finished = [...this.tasks.values()].filter((t) => t.status !== "running").sort((a, b) => a.startedAt - b.startedAt);
    for (const task of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) {
      this.tasks.delete(task.id);
      if (this.directory) {
        try {
          unlinkSync(join(this.directory, `${task.id}.json`));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
    }
  }
  start(input: DelegateInput): Task {
    if ([...this.tasks.values()].filter((t) => t.status === "running").length >= config.maxTasks) {
      throw new Error(`maximum of ${config.maxTasks} background tasks reached`);
    }
    const task: Task = {
      id: `task_${randomUUID()}`,
      input,
      status: "running",
      startedAt: Date.now(),
      controller: new AbortController(),
      promise: Promise.resolve(),
    };
    this.save(task);
    this.tasks.set(task.id, task);
    task.promise = Promise.resolve()
      .then(() =>
        this.runner(input, task.controller.signal, (checkpoint) => {
          task.checkpoint = checkpoint;
          this.save(task);
        }),
      )
      .then(
        (outcome) => {
          task.outcome = outcome;
          task.status = task.controller.signal.aborted ? "cancelled" : outcome.result.ok ? "done" : "error";
        },
        (e: unknown) => {
          task.error = e instanceof Error ? e.message : String(e);
          task.status = task.controller.signal.aborted ? "cancelled" : "error";
        },
      )
      .finally(() => {
        task.finishedAt = Date.now();
        try {
          this.save(task);
          this.prune();
        } catch (e) {
          task.error = `task journal failed: ${String(e)}`;
          task.status = "error";
        }
      });
    return task;
  }
  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }
  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  }
}
const store = new TaskStore(config.stateDir);
export const startTask = (input: DelegateInput) => store.start(input);
export const getTask = (id: string) => store.get(id);
export const listTasks = () => store.list();

export async function waitTask(task: Task, waitSec: number): Promise<void> {
  if (task.status !== "running" || waitSec <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([task.promise, new Promise((r) => (timer = setTimeout(r, Math.min(waitSec, 30) * 1000)))]);
  clearTimeout(timer);
}
