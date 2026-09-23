import { execText } from "./opencode.ts";

const CACHE_MS = 5 * 60 * 1000;
let cache: { at: number; models: string[] } | undefined;

export async function listModels(refresh = false): Promise<string[]> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.models;
  // `opencode models` can print a truncated/empty list while its background service is cold-starting,
  // so repeat until two consecutive runs agree (max 4) and keep the longest list.
  let best: string[] = [];
  let prev: string[] | undefined;
  for (let i = 0; i < 4; i++) {
    const { code, stdout, stderr } = await execText(["models"]);
    if (code !== 0) throw new Error(`'opencode models' failed: ${stderr.trim() || `exit ${code}`}`);
    const models = parseModels(stdout);
    if (models.length > best.length) best = models;
    if (prev && models.length > 0 && models.length === prev.length) break;
    prev = models;
  }
  if (!best.length) throw new Error("'opencode models' returned no models — is a provider configured? Try `opencode auth`.");
  cache = { at: Date.now(), models: best };
  return best;
}

export function parseModels(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[\w.@-]+\/\S+$/.test(l));
}

// Words people naturally put around a model name ("use grok 4.7 from xAI in opencode").
const STOPWORDS = new Set(["use", "using", "with", "from", "in", "on", "via", "the", "a", "model", "opencode", "by"]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .split(" ")
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t && !STOPWORDS.has(t));
}

export type Resolution =
  | { ok: true; model: string; exact: boolean }
  | { ok: false; reason: string; candidates: string[] };

/**
 * Resolves a loose model name ("grok 4.7", "xAI grok-4.7", "kimi k3") to an opencode `provider/model` id.
 * - every version-like token (containing a digit) must appear in the model name, so "grok 4.7" never
 *   silently becomes grok-4.6;
 * - tokens score 3 for an exact token match and 1 for a substring match, doubled for version tokens;
 * - ties prefer the model name with the fewest tokens the query didn't mention ("glm 5.3" → glm-5.3, not
 *   glm-5.3-flash); a query without any version ("mimo") is ambiguous whenever several models tie.
 */
export function resolveModel(query: string, models: string[]): Resolution {
  const [base = "", variant] = query.trim().split("#", 2);
  const withVariant = (m: string) => (variant ? `${m}#${variant}` : m);

  const exact = models.find((m) => m.toLowerCase() === base.toLowerCase());
  if (exact) return { ok: true, model: withVariant(exact), exact: true };

  const tokens = tokenize(base);
  if (!tokens.length) return { ok: false, reason: `empty model name '${query}'`, candidates: [] };
  const isVersion = (t: string) => /\d/.test(t);

  type Scored = { id: string; score: number; extras: number };
  const scored = models
    .map((id): Scored | undefined => {
      const lower = id.toLowerCase();
      const name = lower.slice(lower.indexOf("/") + 1);
      const idTokens = new Set(tokenize(lower));
      const nameTokens = tokenize(name);
      if (!tokens.filter(isVersion).every((t) => name.includes(t))) return undefined;
      if (!tokens.some((t) => name.includes(t))) return undefined;
      let score = 0;
      for (const t of tokens) {
        const hit = idTokens.has(t) ? 3 : lower.includes(t) ? 1 : 0;
        score += isVersion(t) ? hit * 2 : hit;
      }
      const extras = nameTokens.filter((n) => !tokens.includes(n)).length;
      return { id, score, extras };
    })
    .filter((x): x is Scored => !!x)
    .sort((a, b) => b.score - a.score || a.extras - b.extras || a.id.localeCompare(b.id));

  const best = scored[0];
  if (!best) return { ok: false, reason: `no opencode model matches '${query}'`, candidates: [] };
  // Without a version in the query ("mimo", "grok"), don't guess between versions/sizes.
  const hasVersion = tokens.some(isVersion);
  const tied = scored.filter((s) => s.score === best.score && (!hasVersion || s.extras === best.extras));
  if (tied.length > 1) return { ok: false, reason: `'${query}' is ambiguous`, candidates: tied.map((t) => t.id) };
  return { ok: true, model: withVariant(best.id), exact: false };
}

export async function resolveModelOrThrow(query: string): Promise<string> {
  const models = await listModels();
  const r = resolveModel(query, models);
  if (r.ok) return r.model;
  const alts = r.candidates.length
    ? r.candidates
    : models.filter((m) => tokenize(query).some((t) => m.toLowerCase().includes(t)));
  throw new Error(
    `${r.reason}.${alts.length ? ` Did you mean one of: ${alts.slice(0, 20).join(", ")}?` : ""} Use list_models to see all models.`,
  );
}
