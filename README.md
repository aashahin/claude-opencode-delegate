# claude-opencode-delegate

Give Claude **every model in your [OpenCode](https://opencode.ai) install** as a delegate: Grok,
Kimi, GLM, Qwen, DeepSeek, MiMo, MiniMax, and any other provider you've connected. Claude stays
the orchestrator. It plans the work, briefs the other model, reviews the diff, and runs the tests.

```
you ▸ use grok 4.7 from xAI in opencode to implement the CSV export, you review it

claude ▸ delegate(model: "grok 4.7 from xAI", prompt: "<self-contained brief>")
         ↳ xai/grok-4.7 edits src/export.ts, runs tests …
claude ▸ reviews git diff, runs `bun test`, and reports back
```

It works in:

- **Claude Code** (CLI, IDE, desktop): you can ask directly, use `/opencode`, use the `opencode-worker` subagent, or use it from dynamic workflows.
- **Claude Desktop** on Linux, macOS, or Windows, as a plain MCP server.

## How it works

```
Claude Code / Claude Desktop / subagent / workflow
        │  MCP (stdio)
        ▼
opencode-delegate MCP server (Bun)
        │  spawns
        ▼
opencode run --format json -m <provider/model> [--auto] [--session …]
```

The server shells out to the `opencode` CLI, so it uses your existing OpenCode auth, config, agents,
MCP servers, and permission rules. It does not use a separate API.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- [OpenCode](https://opencode.ai) v2+ with at least one provider set up. Check that `opencode models` lists something.

## Install

### Claude Code: plugin (recommended)

```text
/plugin marketplace add aashahin/claude-opencode-delegate
/plugin install opencode-delegate@claude-opencode-delegate
```

This gives you the MCP server, the **opencode-delegate** skill, the **opencode-worker** subagent, and
the **/opencode** command.

### Claude Code: MCP server only

```bash
git clone https://github.com/aashahin/claude-opencode-delegate ~/.local/share/claude-opencode-delegate
claude mcp add opencode -s user -- bun ~/.local/share/claude-opencode-delegate/dist/index.js
```

### Claude Desktop

Clone the repo as shown above. Then add the server to `~/.config/Claude/claude_desktop_config.json`
on Linux, or to `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "/home/YOU/.bun/bin/bun",
      "args": ["/home/YOU/.local/share/claude-opencode-delegate/dist/index.js"],
      "env": { "OPENCODE_DELEGATE_CWD": "/home/YOU/projects/my-app" }
    }
  }
}
```

Use absolute paths, because Desktop doesn't load your shell `PATH`. The server searches for
`opencode` in `~/.opencode/bin`, `~/.bun/bin`, `~/.local/bin`, and `/usr/local/bin`. If yours is
somewhere else, set `OPENCODE_BIN`. If your providers read API keys from environment variables (for
example `XAI_API_KEY`), add those to `env` too, or add the keys with `opencode auth login`.
Desktop has no project directory, so either set `OPENCODE_DELEGATE_CWD` or ask Claude to pass `cwd`.

## Usage

Talk to Claude normally:

- *"Use grok 4.7 from xAI in opencode to implement pagination for /api/users. You review it."*
- *"Ask kimi k3 via opencode for a second opinion on this diff, read-only."*
- *"Have glm 5.3 and qwen 3.8 max both implement the parser in separate worktrees, then pick the better one."*
- `/opencode deepseek v4 flash -- write unit tests for src/date.ts`
- *"Spawn opencode-worker subagents: minimax m3 does the docs, kimi k3 does the tests."*

### Model names

You can use exact ids (`opencode-go/grok-4.7`) or loose names (`grok 4.7`, `kimi k3`,
`deepseek v4 flash`).

- If the same model is offered by several providers, the model maker's own provider wins over
  resellers such as `opencode-go`, `opencode`, and `openrouter`. So `grok 4.7` resolves to
  `xai/grok-4.7`.
- A provider word in the name overrides that, so "opencode-go grok 4.7" resolves to
  `opencode-go/grok-4.7`. To set your own order, use `OPENCODE_DELEGATE_PREFERRED_PROVIDERS`.
- A version you name must match exactly, so `grok 4.7` never silently becomes 4.6.
- If a name matches several different models, you get a list of candidates instead of a guess. For
  example, `mimo` matches several MiMo models.
- Add `#variant` for a reasoning variant: `xai/grok-4.7#high`.

### Tools

| Tool | What it does |
|---|---|
| `list_models` | Lists the `opencode models` output. Takes an optional `filter`. |
| `delegate` | Runs a task and waits for it. Returns the response, `session_id`, token usage, tools used, and git changes. |
| `delegate_async` | Same as `delegate`, but returns a `task_id` right away. Use it for long jobs and parallel fan-out. |
| `task_result` / `task_list` / `task_cancel` | Collect results (with `wait_s`), list tasks, or stop a background task. |
| `list_sessions` | Lists recent opencode sessions, so you can find one to continue. |

`delegate` and `delegate_async` take these arguments:

- `prompt` and `model`
- `cwd` and `agent` (for example `build`, `plan`, or your own agents)
- `files` to attach
- `session_id`, `continue`, or `fork` to follow up in an earlier session
- `auto`, `title`, and `timeout_s`

### Permissions

By default the delegated model runs with `--auto`. It can edit files and run commands without
asking, but any rule you set to `deny` in your OpenCode config is still enforced. Pass
`auto: false`, or set `OPENCODE_DELEGATE_AUTO=false`, for read-only runs. Claude is told to review
every change it gets back.

### Using it from workflows

Workflow `agent()` calls and subagents can use the MCP tools directly or through the `opencode-worker`
agent. If you fan out tasks that edit files, give each one its own `git worktree` so they don't
conflict.

## Configuration (env vars)

| Variable | Default | |
|---|---|---|
| `OPENCODE_BIN` | auto-detected | Path to the `opencode` executable. |
| `OPENCODE_DELEGATE_DEFAULT_MODEL` | opencode's default | Model used when `model` is omitted. |
| `OPENCODE_DELEGATE_AUTO` | `true` | Default for `auto`. |
| `OPENCODE_DELEGATE_TIMEOUT` | `1800` | Seconds before a run is killed. |
| `OPENCODE_DELEGATE_MAX_OUTPUT` | `40000` | Maximum number of response characters returned to Claude. |
| `OPENCODE_DELEGATE_CWD` | the server's cwd | Base directory for `cwd`. |
| `OPENCODE_DELEGATE_PREFERRED_PROVIDERS` | *(none)* | Comma-separated provider order used when a model is offered by several providers, e.g. `xai,opencode-go`. Without it, the model maker's own provider beats resellers. |

## Development

```bash
bun install
bun test            # unit tests (fixtures captured from real `opencode run --format json`)
bun run typecheck
bun run build       # bundles to dist/index.js, which is committed so installs need no build step
bun run start       # run the server from source
```

To debug interactively, use `bunx @modelcontextprotocol/inspector bun dist/index.js`.

## License

MIT
