import { describe, expect, test } from "bun:test";
import { parseModels, resolveModel } from "../src/models.ts";

const MODELS = [
  "opencode-go/deepseek-v4-flash",
  "opencode-go/deepseek-v4-flash-vision-exp",
  "opencode-go/deepseek-v4.1-flash",
  "opencode-go/glm-5.3",
  "opencode-go/glm-5.3-flash",
  "opencode-go/grok-4.6",
  "opencode-go/grok-4.7",
  "opencode-go/kimi-k2.7-code",
  "opencode-go/kimi-k3",
  "opencode-go/mimo-v2.6-flash",
  "opencode-go/mimo-v2.6-pro",
  "opencode-go/qwen3.7-max",
  "opencode/mimo-v2.6-flash-free",
  "xai/grok-4.20-0309-non-reasoning",
  "xai/grok-4.20-0309-reasoning",
  "xai/grok-4.7",
];

const pick = (q: string) => {
  const r = resolveModel(q, MODELS);
  return r.ok ? r.model : `ERR:${r.reason}|${r.candidates.join(",")}`;
};

describe("resolveModel", () => {
  test("exact ids", () => {
    expect(pick("opencode-go/grok-4.7")).toBe("opencode-go/grok-4.7");
    expect(pick("OpenCode-Go/Kimi-K3")).toBe("opencode-go/kimi-k3");
  });
  test("loose names", () => {
    expect(pick("grok 4.6")).toBe("opencode-go/grok-4.6");
    expect(pick("kimi k3")).toBe("opencode-go/kimi-k3");
    expect(pick("glm 5.3")).toBe("opencode-go/glm-5.3");
    expect(pick("deepseek v4 flash")).toBe("opencode-go/deepseek-v4-flash");
    expect(pick("mimo v2.6 flash")).toBe("opencode-go/mimo-v2.6-flash");
  });
  test("provider words and filler are soft", () => {
    expect(pick("use grok 4.7 from xAI in opencode")).toBe("xai/grok-4.7");
    expect(pick("opencode-go grok 4.7")).toBe("opencode-go/grok-4.7");
    expect(pick("xai grok 4.20 reasoning")).toBe("xai/grok-4.20-0309-reasoning");
  });
  test("variant suffix is preserved", () => {
    expect(pick("xai grok 4.7#high")).toBe("xai/grok-4.7#high");
    expect(pick("opencode-go/kimi-k3#max")).toBe("opencode-go/kimi-k3#max");
  });
  test("version must match", () => {
    expect(pick("grok 9.9")).toStartWith("ERR:no opencode model");
  });
  test("ambiguous", () => {
    expect(pick("mimo")).toStartWith("ERR:");
    expect(pick("mimo")).toContain("ambiguous");
  });
});

test("parseModels ignores non-id lines", () => {
  expect(parseModels("opencode-go/grok-4.7\nsome warning\n\nxai/grok-4.20-0309-reasoning\n")).toEqual([
    "opencode-go/grok-4.7",
    "xai/grok-4.20-0309-reasoning",
  ]);
});

test("family name without version lists candidates", () => {
  const r = resolveModel("grok", MODELS);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.candidates).toContain("opencode-go/grok-4.6");
  expect(pick("mimo")).toContain("ambiguous");
});

describe("same model from several providers", () => {
  test("direct provider beats aggregators", () => {
    expect(pick("grok 4.7")).toBe("xai/grok-4.7");
    expect(pick("grok-4.7#high")).toBe("xai/grok-4.7#high");
  });
  test("a provider hint in the query still wins", () => {
    expect(pick("opencode-go grok 4.7")).toBe("opencode-go/grok-4.7");
  });
  test("OPENCODE_DELEGATE_PREFERRED_PROVIDERS order wins", () => {
    const r = resolveModel("grok 4.7", MODELS, ["opencode-go"]);
    expect(r.ok && r.model).toBe("opencode-go/grok-4.7");
  });
  test("two aggregators with no preference stay ambiguous", () => {
    const r = resolveModel("foo 1", ["opencode/foo-1", "openrouter/foo-1"], []);
    expect(r.ok).toBe(false);
  });
  test("different models are never auto-picked by provider", () => {
    expect(pick("mimo")).toContain("ambiguous");
  });
});
