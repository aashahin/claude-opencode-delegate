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
opencode run --standalone --format json -m <provider/model> [--auto] [--session …]
```

The server shells out to the `opencode` CLI, so it uses your existing OpenCode auth, config, agents,
MCP servers, and permission rules. Each delegation owns a private OpenCode server instead of attaching
to the shared background service. It does not use a separate model API.

## Requirements

- [Bun](https://bun.sh) ≥ 1.4.4
- [OpenCode](https://opencode.ai) ≥ 2.1.4 and < 3, with at least one provider set up. The bridge checks this version range before delegation.
- The regression and real-CLI integration checks run on Linux with Bun 1.4.4 and OpenCode 2.1.4. POSIX process-group cleanup is tested; Windows descendant cleanup is not guaranteed.

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

- _"Use grok 4.7 from xAI in opencode to implement pagination for /api/users. You review it."_
- _"Ask kimi k3 via opencode for a second opinion on this diff, read-only."_
- _"Have glm 5.3 and qwen 3.8 max both implement the parser in separate worktrees, then pick the better one."_
- `/opencode deepseek v4 flash -- write unit tests for src/date.ts`
- _"Spawn opencode-worker subagents: minimax m3 does the docs, kimi k3 does the tests."_

### Model names

You can use exact ids (`opencode-go/grok-4.7`) or loose names (`grok 4.7`, `kimi k3`,
`deepseek v4 flash`).

- If the same model is offered by several providers, the model maker's own provider wins over
  resellers such as `opencode-go`, `opencode`, and `openrouter`. So `grok 4.7` resolves to
  `xai/grok-4.7`.
- A provider word in the name overrides that, so "opencode-go grok 4.7" resolves to
  `opencode-go/grok-4.7`. To set your own order, use `OPENCODE_DELEGATE_PREFERRED_PROVIDERS`.
- Exact `provider/model` IDs fail when unavailable; they never fall back to a different route.
- Loose names must match every family/version token. A named provider is a constraint, and `v4` does not match `v4.1`.
- For predictable billing, use exact IDs or configure aliases and an allowlist, rather than relying on provider preference.
- If a name matches several different models, you get a list of candidates instead of a guess. For
  example, `mimo` matches several MiMo models.
- Add `#variant` for a reasoning variant: `xai/grok-4.7#high`.
- If you don't name a model, tasks that edit files use `opencode-go/muse-spark-1.3-contributor`.
  Read-only tasks (`mode: "read-only"`, or legacy `auto: false`) use the free `opencode/muse-spark-1.3-contributor-free`. You can
  change both with the env vars below.

### Tools

| Tool                                        | What it does                                                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_models`                               | Lists the `opencode models` output. Takes optional `filter`, `cwd`, and `refresh`. Catalogs are cached per executable/project/inline config. |
| `delegate`                                  | Runs a task and waits for it. Returns the response, `session_id`, token usage, tools used, and git changes.                                  |
| `delegate_async`                            | Same as `delegate`, but returns a `task_id` right away. Use it for long jobs and parallel fan-out.                                           |
| `task_result` / `task_list` / `task_cancel` | Collect results (with `wait_s`), list tasks, or stop a background task.                                                                      |
| `list_sessions`                             | Lists recent opencode sessions, so you can find one to continue.                                                                             |

`delegate` and `delegate_async` take these arguments:

- `prompt` and `model`
- `cwd` and `agent` (for example `build`, `plan`, or your own agents)
- `files` to attach
- `session_id`, `continue`, or `fork` to follow up in an earlier session
- `mode` (`write` or `read-only`), `auto`, `title`, and `timeout_s`
- `worktree: true` for a new isolated write task from a clean Git repository

### Permissions and execution modes

Write mode retains the existing default `auto: true`: OpenCode can edit files and run commands,
with explicit OpenCode denies still enforced. Claude's command hooks and permission rules are
not translated into OpenCode policy.

Use `mode: "read-only"` for a review. The bridge supplies a dedicated agent plus inline V2 policy
allowing only `read`, `glob`, and `grep`. Shell, file edits, subagents, MCP tools, and Code Mode
are unavailable. Do not pass a custom `agent` in this mode. No project configuration is modified.

For compatibility, `auto: false` selects read-only mode when `mode` is omitted. To keep normal
OpenCode tools without auto-approving asks, explicitly use `mode: "write", auto: false`.
Noninteractive OpenCode rejects asks rather than forwarding approval prompts to Claude.

This constrains model tool use, not arbitrary plugin code or the host operating system.
Use trusted OpenCode config/plugins and an OS sandbox or container for untrusted repositories.
Explicit `files` attachments are read by the CLI; attach only files you intend to share.

### Isolation, cancellation and results

A cwd-sensitive subprocess receives matching `cwd` and `PWD`. Each run uses `--standalone`.
On POSIX, cancellation interrupts its process group, allows a short graceful exit, then kills
remaining group members. This also runs on MCP shutdown/disconnect. Cancellation does not undo
edits already made, and cannot contain deliberately detached processes.

The total deadline includes model discovery and Git preparation. Helpers have separate bounded
deadlines; post-run change reporting gets its own bounded window after cancellation.
Output collection is bounded before formatting. Empty or incompatible JSON stdout is an error.
An execution status of `ok` is not a claim that tests passed or the requested task is correct.

Git reporting compares content, index state and HEAD movement, including changes to already-dirty
and untracked files and files committed by the delegate. Paths are relative to the reported Git
root; reporting failures are shown as unavailable, never as no changes. Other processes can still
change the repository, so isolated worktrees are preferable.

Use `worktree: true` to create a detached worktree for a new write task. The source must be clean.
The returned `cwd` is where the result lives; follow up with that directory and `session_id`.
Worktrees are retained for review, never auto-merged or auto-deleted. Afterwards, remove them with
`git worktree remove <returned-cwd>`. For parallel fan-out, create worktrees first and pass their
different directories. Conflicting jobs in one worktree/session are rejected by this MCP process;
these locks do not coordinate separate MCP instances. Prefer explicit `session_id` to `continue`.

Background polling waits at most 30 seconds per `task_result` call. Set
`OPENCODE_DELEGATE_STATE_DIR` to a private directory to journal results and session checkpoints
with mode 0600 files. Prompt fields and tool inputs are omitted, but returned text can contain
sensitive code. Up to 100 finished tasks are retained. Without this option, tasks are in memory.
After restart, a previously running task has unknown execution state and is never automatically
replayed; inspect its saved cwd/session before retrying. Use a separate journal directory per
server instance.

### Using it from workflows

Workflow `agent()` calls and subagents can use the MCP tools directly or through the `opencode-worker`
agent. If you fan out tasks that edit files, give each one its own `git worktree` so they don't
conflict.

## Configuration (env vars)

| Variable                                | Default                                    |                                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCODE_BIN`                          | auto-detected                              | Path to the `opencode` executable.                                                                                                                                    |
| `OPENCODE_DELEGATE_DEFAULT_MODEL`       | `opencode-go/muse-spark-1.3-contributor`   | Model used when `model` is omitted. Set it to `""` to use opencode's own default.                                                                                     |
| `OPENCODE_DELEGATE_READ_MODEL`          | `opencode/muse-spark-1.3-contributor-free` | Model used when `model` is omitted in read-only mode, including legacy `auto: false`.                                                                                 |
| `OPENCODE_DELEGATE_AUTO`                | `true`                                     | Default for `auto`.                                                                                                                                                   |
| `OPENCODE_DELEGATE_TIMEOUT`             | `1800`                                     | Total preparation/execution deadline in seconds, capped at 86400.                                                                                                     |
| `OPENCODE_DELEGATE_MAX_OUTPUT`          | `40000`                                    | Maximum number of response characters returned to Claude.                                                                                                             |
| `OPENCODE_DELEGATE_MAX_CAPTURE`         | `1048576`                                  | Maximum stdout bytes collected per subprocess, including streamed JSON.                                                                                               |
| `OPENCODE_DELEGATE_HELPER_TIMEOUT`      | `30`                                       | Deadline in seconds for discovery, session listing and Git helpers.                                                                                                   |
| `OPENCODE_DELEGATE_MAX_TASKS`           | `4`                                        | Maximum concurrent delegations/background jobs per server.                                                                                                            |
| `OPENCODE_DELEGATE_STATE_DIR`           | _(unset)_                                  | Optional private task journal; unset keeps tasks in memory.                                                                                                           |
| `OPENCODE_DELEGATE_MODEL_ALIASES`       | `{}`                                       | JSON map of alias to exact ID, e.g. `{"cheap":"your-provider/your-model"}`.                                                                                           |
| `OPENCODE_DELEGATE_ALLOWED_MODELS`      | _(unset)_                                  | Comma-separated allowed exact IDs. When set, an explicit resolved model is required. A base ID permits its variants.                                                  |
| `OPENCODE_DELEGATE_CWD`                 | the server's cwd                           | Base directory for `cwd`.                                                                                                                                             |
| `OPENCODE_DELEGATE_PREFERRED_PROVIDERS` | _(none)_                                   | Comma-separated provider order used when a model is offered by several providers, e.g. `xai,opencode-go`. Without it, the model maker's own provider beats resellers. |

### Controlling model spend

Set both default models to exact IDs in your own configured providers. Aliases can make those IDs
easy to request; an allowlist prevents accidental use of a different route. No provider is
silently substituted if an exact ID is unavailable. The allowlist constrains the delegated primary model; OpenCode maintenance/subagent model settings
remain separate. These controls are routing restrictions, not a monetary budget or a guarantee of savings.

Claude still spends usage briefing, reviewing and retrying work. The optional worker subagent
also consumes Claude usage. Start with direct MCP delegation and measure accepted results,
Claude usage, worker API charges and retries against a Claude-only baseline.

## Development

```bash
bun install
bun test            # unit + subprocess/Git regressions; uses fake OpenCode, no API keys
bun run typecheck
bun run build       # bundles to dist/index.js, which is committed so installs need no build step
bun run start       # run the server from source
```

The opt-in real OpenCode test uses an isolated config and localhost OpenAI-compatible stub.
It verifies that only read/glob/grep are advertised and a forced write cannot execute:

```bash
OPENCODE_TEST_BIN="$(command -v opencode)" bun test test/opencode.integration.test.ts
```

CI pins Bun/OpenCode, runs these checks and verifies the committed bundle matches the source.

To debug interactively, use `bunx @modelcontextprotocol/inspector bun dist/index.js`.

## License

MIT
