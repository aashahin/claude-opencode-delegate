import { spawn, type ChildProcess } from "node:child_process";
import { config } from "./config.ts";

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  onLine?: (line: string) => void;
}
export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut: boolean;
}

const active = new Set<() => void>();

export function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("cancelled");
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

/** Own the process group on POSIX. Standalone OpenCode servers belong to this group too. */
function send(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
}

export function stopProcesses(): void {
  for (const stop of active) stop();
}

export function runProcess(bin: string, args: string[], o: ProcessOptions = {}): Promise<ProcessResult> {
  checkAbort(o.signal);
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: o.cwd,
      env: { ...process.env, ...o.env, ...(o.cwd ? { PWD: o.cwd } : {}) },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const maxBytes = o.maxBytes ?? config.maxCaptureBytes;
    let stdout = "",
      stderr = "",
      buffer = "";
    let bytes = 0,
      timedOut = false,
      error: string | undefined;
    let stopped = false,
      closed = false,
      reaped = false;
    let code: number | null = null;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (!closed || !reaped) return;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (closeTimer) clearTimeout(closeTimer);
      o.signal?.removeEventListener("abort", cancel);
      active.delete(stop);
      resolve({ code, stdout, stderr, error, timedOut });
    };
    const force = () => {
      try {
        send(child, "SIGKILL");
      } catch (e) {
        error ??= String(e);
      }
      reaped = true;
      // A detached descendant must not keep inherited pipes open indefinitely.
      closeTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        closed = true;
        finish();
      }, 1000);
      finish();
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        send(child, "SIGINT");
      } catch (e) {
        error ??= String(e);
      }
      forceTimer = setTimeout(force, config.killGraceMs);
    };
    const cancel = () => {
      error ??= abortError(o.signal).message;
      stop();
    };
    active.add(stop);
    o.signal?.addEventListener("abort", cancel, { once: true });
    // Abort may have arrived between the first check and listener registration.
    if (o.signal?.aborted) cancel();
    timer = setTimeout(
      () => {
        timedOut = true;
        error ??= "process timed out";
        stop();
      },
      o.timeoutMs ?? config.helperTimeoutSec * 1000,
    );

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stopped) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        error = `stdout exceeds ${maxBytes} bytes`;
        stop();
        return;
      }
      if (!o.onLine) {
        stdout += chunk;
        return;
      }
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        try {
          o.onLine(line);
        } catch (e) {
          error = String(e);
          stop();
          break;
        }
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on("error", (e) => {
      error = `failed to start '${bin}': ${e.message}`;
    });
    child.on("close", (exitCode) => {
      code = exitCode;
      closed = true;
      if (buffer && !error) {
        try {
          o.onLine?.(buffer);
        } catch (e) {
          error = String(e);
        }
      }
      if (!stopped) {
        // Also clean up child tools left behind by a normally exiting CLI.
        try {
          send(child, "SIGKILL");
        } catch {
          /* process group already gone */
        }
        reaped = true;
      }
      finish();
    });
  });
}
