import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../src/config.ts";
import { runOpencode } from "../src/opencode.ts";

const binary = process.env.OPENCODE_TEST_BIN;
// Explicit opt-in: starts a real OpenCode private server and a localhost-only provider stub.
test.skipIf(!binary)(
  "OpenCode V2 enforces read-only even when the provider requests a forbidden write",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "delegate-real-test-"));
    const previous = { ...process.env };
    const originalBin = config.bin;
    const offered: string[][] = [];
    const requests: any[] = [];
    const marker = join(root, "forbidden.txt");
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      requests.push(body);
      const tools = body.tools?.map((t: any) => t.function?.name) ?? [];
      if (body.tools) offered.push(tools);
      const attempted = body.messages?.some((m: any) => m.role === "tool");
      // Force an unadvertised write to test enforcement beyond tool-list filtering.
      const toolCall = !!body.tools && !attempted;
      const message = toolCall
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_forbidden",
                type: "function",
                function: { name: "write", arguments: JSON.stringify({ path: marker, content: "bad" }) },
              },
            ],
          }
        : { role: "assistant", content: "local review complete" };
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const delta = toolCall ? { role: "assistant", tool_calls: [{ index: 0, ...message.tool_calls![0] }] } : message;
        res.write(
          "data: " +
            JSON.stringify({
              id: "local",
              object: "chat.completion.chunk",
              created: 1,
              model: "probe",
              choices: [{ index: 0, delta, finish_reason: null }],
            }) +
            "\n\n",
        );
        res.write(
          "data: " +
            JSON.stringify({
              id: "local",
              object: "chat.completion.chunk",
              created: 1,
              model: "probe",
              choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }) +
            "\n\n",
        );
        res.end("data: [DONE]\n\n");
      } else {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            id: "local",
            object: "chat.completion",
            created: 1,
            model: "probe",
            choices: [{ index: 0, message, finish_reason: toolCall ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address() as { port: number };
    try {
      config.bin = binary!;
      // Isolate global config, session state and auth; never read the developer's provider credentials.
      for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) process.env[key] = join(root, key);
      process.env.OPENCODE_CONFIG_DIR = join(root, "config");
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        model: "delegate-test/probe",
        providers: {
          "delegate-test": {
            package: "@opencode/ai/providers/openai-compatible",
            env: [],
            settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "synthetic-local-key" },
            models: { probe: { capabilities: { toolcall: true } } },
          },
        },
        policies: [
          { action: "provider.use", resource: "*", effect: "deny" },
          { action: "provider.use", resource: "delegate-test", effect: "allow" },
        ],
      });
      const result = await runOpencode({
        prompt: "Review without changes.",
        cwd: root,
        mode: "read-only",
        model: "delegate-test/probe",
        timeoutMs: 30000,
      });
      expect(result.ok).toBe(true);
      expect(result.text).toContain("local review complete");
      expect(offered.length).toBeGreaterThan(0);
      for (const tools of offered) expect(tools.sort()).toEqual(["glob", "grep", "read"]);
      expect(requests.some((body) => body.messages?.some((m: any) => m.role === "tool"))).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      config.bin = originalBin;
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      server.closeAllConnections();
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  45000,
);
