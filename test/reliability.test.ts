import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { config } from "../src/config.ts";
import { delegate } from "../src/delegate.ts";
import { runOpencode, execText, buildArgs } from "../src/opencode.ts";
import { runProcess } from "../src/process.ts";
import { changedPaths, snapshot, statusPaths } from "../src/git.ts";
import { reviewEnvironment, REVIEW_AGENT } from "../src/permissions.ts";
import { TaskStore } from "../src/tasks.ts";
import { listModels } from "../src/models.ts";

const originalConfig = { ...config };
const originalEnv = { ...process.env };
const directories: string[] = [];
let cwd: string;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(test: () => boolean) {
  const end = Date.now() + 3000;
  while (!test()) {
    if (Date.now() > end) throw new Error("probe did not become ready");
    await delay(10);
  }
}
function git(...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0 || r.error) throw new Error(r.stderr || String(r.error));
  return r.stdout;
}
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "delegate-test-"));
  directories.push(cwd);
  config.bin = resolve(import.meta.dir, "fixtures/fake-opencode.cjs");
  chmodSync(config.bin, 0o755);
  config.defaultCwd = cwd;
  config.defaultModel = undefined;
  config.readModel = undefined;
  config.killGraceMs = 100;
  config.helperTimeoutSec = 2;
  config.maxTasks = 4;
  config.modelAliases = {};
  config.allowedModels = [];
});
afterEach(async () => {
  Object.assign(config, originalConfig);
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("delegation process boundaries", () => {
  test("cancellation during discovery never launches the run", async () => {
    process.env.PROBE_MODELS_DELAY = "1000";
    process.env.PROBE_DISCOVERY_MARKER = join(cwd, "discovery");
    const controller = new AbortController();
    const pending = delegate({ prompt: "write-marker", model: "test/model" }, controller.signal);
    await waitFor(() => existsSync(join(cwd, "discovery")));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  });
  test("an already aborted signal launches nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(delegate({ prompt: "write-marker" }, controller.signal)).rejects.toThrow();
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  });
  test("cwd and PWD agree for runs and helpers", async () => {
    const result = await runOpencode({ prompt: "capture", cwd, timeoutMs: 2000 });
    const value = JSON.parse(result.text);
    expect(result.ok).toBe(true);
    expect(value.cwd).toBe(cwd);
    expect(value.pwd).toBe(cwd);
    const helper = await execText(["session"], cwd);
    expect(JSON.parse(JSON.parse(helper.stdout).part.text).pwd).toBe(cwd);
  });
  test.each(["empty", "unknown-only", "plain", "null"])("rejects incompatible stdout: %s", async (prompt) => {
    const result = await runOpencode({ prompt, cwd, timeoutMs: 2000 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
  test("a bounded helper cannot wait forever", async () => {
    process.env.PROBE_MODELS_HANG = "1";
    config.helperTimeoutSec = 0.1;
    await expect(execText(["models"], cwd)).rejects.toThrow("timed out");
  });
  test("stdout collection is bounded before formatting", async () => {
    config.maxCaptureBytes = 1024;
    const result = await runOpencode({ prompt: "huge", cwd, timeoutMs: 2000 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exceeds");
  });
  test("cancel stops a POSIX child process group", async () => {
    if (process.platform === "win32") return;
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((r) => (ready = r));
    const pending = runProcess(config.bin, ["run", "tree"], {
      cwd,
      signal: controller.signal,
      timeoutMs: 3000,
      onLine: () => ready(),
    });
    await started;
    // Let the descendant install its own signal handler, then exercise forced cleanup.
    await delay(100);
    controller.abort();
    await pending;
    await delay(900);
    expect(existsSync(join(cwd, "descendant-marker"))).toBe(false);
  });
  test("one total deadline includes discovery", async () => {
    process.env.PROBE_MODELS_HANG = "1";
    const started = Date.now();
    await expect(delegate({ prompt: "write-marker", model: "test/model", timeout_s: 0.1 })).rejects.toThrow("deadline");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  });
  test("directory locks reject conflicting tasks without releasing another owner's lock", async () => {
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((r) => (ready = r));
    const first = delegate({ prompt: "hang" }, controller.signal, (p) => {
      if (p.sessionId) ready();
    });
    await started;
    await expect(delegate({ prompt: "write-marker" })).rejects.toThrow("owns");
    await expect(delegate({ prompt: "write-marker" })).rejects.toThrow("owns");
    controller.abort();
    await first;
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  });
  test("model aliases resolve to exact allowlisted routes", async () => {
    config.modelAliases = { cheap: "test/model" };
    config.allowedModels = ["test/model"];
    const outcome = await delegate({ prompt: "capture", model: "cheap" });
    expect(outcome.model).toBe("test/model");
    config.allowedModels = ["other/model"];
    await expect(delegate({ prompt: "write-marker", model: "cheap" })).rejects.toThrow("not in");
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  });
  test("discovery uses and caches the requested project", async () => {
    const first = join(cwd, "first"),
      second = join(cwd, "second");
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, "models.txt"), "test/first");
    writeFileSync(join(second, "models.txt"), "test/second");
    expect(await listModels(false, undefined, first)).toEqual(["test/first"]);
    expect(await listModels(false, undefined, second)).toEqual(["test/second"]);
  });
  test("unsupported versions fail before execution", async () => {
    const bin = join(cwd, "old-opencode.cjs");
    copyFileSync(config.bin, bin);
    chmodSync(bin, 0o755);
    config.bin = bin;
    process.env.PROBE_VERSION = "opencode v1.9.0";
    await expect(delegate({ prompt: "write-marker" })).rejects.toThrow("unsupported");
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  });
});

describe("enforced read-only configuration", () => {
  test("auto false chooses a restricted agent without auto-approval", async () => {
    const outcome = await delegate({ prompt: "capture", auto: false });
    const value = JSON.parse(outcome.result.text);
    expect(value.args).toContain("--standalone");
    expect(value.args).toContain(REVIEW_AGENT);
    expect(value.args).not.toContain("--auto");
    const config = JSON.parse(value.content);
    expect(config.agents[REVIEW_AGENT].permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    expect(config.policies).toContainEqual({ action: "tool.use", resource: "*", effect: "deny" });
    expect(outcome.mode).toBe("read-only");
  });
  test("existing inline settings and deny policies are retained", () => {
    const env = reviewEnvironment({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "a/b", policies: [{ action: "provider.use", resource: "x", effect: "deny" }] }),
    });
    const value = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    expect(value.model).toBe("a/b");
    expect(value.policies.at(-1).resource).toBe("x");
  });
  test("read-only cannot be weakened by a requested agent or auto", async () => {
    await expect(delegate({ prompt: "capture", mode: "read-only", agent: "build" })).rejects.toThrow("restricted agent");
    expect(buildArgs({ prompt: "x", mode: "read-only", auto: true })).not.toContain("--auto");
  });
});

describe("git content and history reporting", () => {
  beforeEach(() => {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    writeFileSync(join(cwd, "tracked.txt"), "initial");
    git("add", ".");
    git("commit", "-qm", "initial");
  });
  test("detects edits to an already dirty tracked file", async () => {
    writeFileSync(join(cwd, "tracked.txt"), "before");
    const outcome = await delegate({ prompt: "modify-existing" });
    expect(outcome.changedFiles).toEqual(["tracked.txt"]);
  });
  test("detects further edits to an already untracked file and ignores unchanged dirt", async () => {
    writeFileSync(join(cwd, "untracked.txt"), "before");
    writeFileSync(join(cwd, "tracked.txt"), "dirty");
    const before = await snapshot(cwd);
    writeFileSync(join(cwd, "untracked.txt"), "after");
    expect((await changedPaths(before)).files).toEqual(["untracked.txt"]);
  });
  test("detects index-only changes", async () => {
    writeFileSync(join(cwd, "tracked.txt"), "dirty");
    const before = await snapshot(cwd);
    git("add", "tracked.txt");
    expect((await changedPaths(before)).files).toEqual(["tracked.txt"]);
  });
  test("detects committed delegate changes even with a clean final tree", async () => {
    const outcome = await delegate({ prompt: "commit" });
    expect(outcome.changedFiles).toContain("committed.txt");
    expect(outcome.finalHead).not.toBe(outcome.baseHead);
    expect(git("status", "--porcelain")).toBe("");
  });
  test("handles spaces, newlines and rename sources", () => {
    expect(statusPaths(" M a b\0?? line\nname\0R  new\0old\0")).toEqual(["a b", "line\nname", "new", "old"]);
  });
  test("worktree option preserves source and retains the result for review", async () => {
    const outcome = await delegate({ prompt: "modify-existing", worktree: true });
    try {
      expect(outcome.cwd).not.toBe(cwd);
      expect(readFileSync(join(cwd, "tracked.txt"), "utf8")).toBe("initial");
      expect(readFileSync(join(outcome.cwd, "tracked.txt"), "utf8")).toBe("after");
      expect(outcome.changedFiles).toContain("tracked.txt");
    } finally {
      git("worktree", "remove", "--force", outcome.cwd);
      await rm(dirname(outcome.cwd), { recursive: true, force: true });
    }
  });
});

describe("background task recovery", () => {
  test("cancelling immediately does not run a deferred task", async () => {
    const store = new TaskStore();
    const task = store.start({ prompt: "write-marker" });
    task.controller.abort();
    await task.promise;
    expect(task.status).toBe("cancelled");
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  });
  test("limits active jobs", async () => {
    config.maxTasks = 1;
    const store = new TaskStore();
    const task = store.start({ prompt: "write-marker" });
    expect(() => store.start({ prompt: "another" })).toThrow("maximum");
    task.controller.abort();
    await task.promise;
  });
  test("journals private metadata and restores interrupted work without replay", async () => {
    const directory = join(cwd, "state");
    let release!: () => void;
    const store = new TaskStore(directory, async (_input, _signal, checkpoint) => {
      checkpoint?.({ cwd, sessionId: "ses_saved", model: "test/model" });
      await new Promise<void>((r) => (release = r));
      throw new Error("stopped");
    });
    const task = store.start({ prompt: "SECRET TASK" });
    await waitFor(() => !!task.checkpoint);
    const file = join(directory, task.id + ".json");
    expect(readFileSync(file, "utf8")).not.toContain("SECRET TASK");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const restored = new TaskStore(directory).get(task.id)!;
    expect(restored.status).toBe("error");
    expect(restored.error).toContain("state unknown");
    expect(restored.checkpoint?.sessionId).toBe("ses_saved");
    release();
    await task.promise;
  });
  test("finished results survive reconstruction of the task store", async () => {
    const directory = join(cwd, "state");
    const store = new TaskStore(directory);
    const task = store.start({ prompt: "capture" });
    await task.promise;
    expect(task.status).toBe("done");
    const restored = new TaskStore(directory).get(task.id)!;
    expect(restored.status).toBe("done");
    expect(restored.outcome?.result.sessionId).toBe("ses_test");
  });
});
