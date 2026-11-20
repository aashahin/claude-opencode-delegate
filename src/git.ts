import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { runProcess, checkAbort } from "./process.ts";

async function git(cwd: string, args: string[], signal?: AbortSignal) {
  const r = await runProcess("git", ["-C", cwd, ...args], { cwd, signal });
  if (r.error) throw new Error(r.error);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git exited ${r.code}`);
  return r.stdout;
}

export async function gitRoot(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  const r = await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd, signal });
  if (r.error) throw new Error(r.error);
  if (r.code !== 0) {
    if (r.stderr.includes("not a git repository")) return undefined;
    throw new Error(r.stderr.trim() || "cannot determine git root");
  }
  return r.stdout.trim();
}

/** Porcelain -z keeps whitespace and unusual filenames intact; rename sources are separate fields. */
export function statusPaths(stdout: string): string[] {
  const records = stdout.split("\0");
  const paths = new Set<string>();
  for (let i = 0; i < records.length; i++) {
    const entry = records[i]!;
    if (!entry) continue;
    paths.add(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) {
      const source = records[++i];
      if (source) paths.add(source);
    }
  }
  return [...paths];
}

async function fingerprint(root: string, file: string, index: string, signal?: AbortSignal): Promise<string> {
  const path = resolve(root, file);
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) throw new Error("git path escapes root");
  checkAbort(signal);
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return `${index}:symlink:${await readlink(path)}`;
    if (!stat.isFile()) return `${index}:mode:${stat.mode}`;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
    return `${index}:${stat.mode}:${hash.digest("hex")}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return `${index}:missing`;
    throw e;
  }
}

export interface GitSnapshot {
  root: string;
  head: string;
  files: Map<string, string>;
}

export async function snapshot(root: string, signal?: AbortSignal, include: string[] = []): Promise<GitSnapshot> {
  const head = await git(root, ["rev-parse", "--verify", "HEAD"], signal).catch((e) => {
    checkAbort(signal);
    if (String(e).includes("Needed a single revision") || String(e).includes("unknown revision")) return "";
    throw e;
  });
  const paths = new Set([...statusPaths(await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal)), ...include]);
  const index = new Map<string, string>();
  if (paths.size) {
    const entries = await git(root, ["ls-files", "--stage", "-z"], signal);
    for (const entry of entries.split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab < 0) continue;
      const file = entry.slice(tab + 1);
      index.set(file, (index.get(file) ?? "") + entry.slice(0, tab) + "\n");
    }
  }
  const files = new Map<string, string>();
  for (const file of paths) files.set(file, await fingerprint(root, file, index.get(file) ?? "", signal));
  return { root, head: head.trim(), files };
}

export async function changedPaths(before: GitSnapshot, signal?: AbortSignal): Promise<{ files: string[]; head: string }> {
  const after = await snapshot(before.root, signal, [...before.files.keys()]);
  const changed = new Set<string>();
  for (const [file, hash] of after.files) {
    if (before.files.get(file) !== hash) changed.add(file);
  }
  if (before.head && after.head && before.head !== after.head) {
    const paths = await git(before.root, ["diff", "--name-only", "-z", before.head, after.head], signal);
    for (const file of paths.split("\0").filter(Boolean)) changed.add(file);
  } else if (!before.head && after.head) {
    for (const file of (await git(before.root, ["ls-tree", "-r", "--name-only", "-z", after.head], signal)).split("\0").filter(Boolean))
      changed.add(file);
  }
  return { files: [...changed].sort(), head: after.head };
}

export async function createWorktree(root: string, signal?: AbortSignal): Promise<string> {
  if ((await git(root, ["status", "--porcelain=v1"], signal)).trim()) {
    throw new Error("worktree isolation requires a clean source tree; commit/stash changes or provide an existing worktree cwd");
  }
  const directory = join(await mkdtemp(join(tmpdir(), "opencode-delegate-")), "worktree");
  await git(root, ["worktree", "add", "--detach", directory, "HEAD"], signal);
  return directory;
}
