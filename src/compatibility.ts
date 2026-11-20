import { config } from "./config.ts";
import { execText } from "./opencode.ts";
import { checkAbort } from "./process.ts";

let cached: { bin: string; at: number } | undefined;
export async function checkCompatibility(signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  if (cached?.bin === config.bin && Date.now() - cached.at < 300000) return;
  const r = await execText(["--version"], undefined, signal);
  const version = /\b(?:v)?(\d+)\.(\d+)\.(\d+)\b/.exec(r.stdout);
  if (
    r.code !== 0 ||
    !version ||
    Number(version[1]) !== 2 ||
    Number(version[2]) < 1 ||
    (Number(version[2]) === 1 && Number(version[3]) < 4)
  ) {
    throw new Error("unsupported OpenCode version; delegation requires >=2.1.4 <3 (tested with 2.1.4)");
  }
  cached = { bin: config.bin, at: Date.now() };
}
