---
name: opencode-delegate
description: Delegate coding or analysis work to another model through OpenCode (Grok, Kimi, GLM, Qwen, DeepSeek, MiMo, MiniMax, GPT… anything `opencode models` lists) while Claude stays the orchestrator. Use when the user says things like "use grok 4.7 in opencode to implement X", "ask kimi via opencode", "delegate this to glm", "get a second opinion from deepseek", "have opencode do it", or asks to run/compare several OpenCode models, including from subagents and workflows.
---

# Delegating to OpenCode models

The `opencode` MCP server runs tasks with `opencode run` in the user's project. The delegated model
has its own tools (read, edit, shell), so it can implement code, not just answer. **You stay the
orchestrator**: you plan, write the brief, and review what comes back.

## Tools

| Tool                                        | Use                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `list_models` (`filter?`)                   | Find the exact `provider/model` id.                                         |
| `delegate`                                  | Run a task and wait for the result.                                         |
| `delegate_async` → `task_result` (`wait_s`) | Long tasks, or several models in parallel. Also `task_list`, `task_cancel`. |
| `list_sessions`                             | Find a `session_id` to continue.                                            |

In a plugin install the tools are named like `mcp__plugin_opencode-delegate_opencode__delegate`. With
a manual install they are `mcp__opencode__delegate`.

## Picking the model

- Pass what the user said: `model: "grok 4.7"`, `"kimi k3"`, `"xai grok 4.7"`. The server matches loose
  names. If a model is offered by several providers, the model maker's own provider wins over resellers
  like `opencode-go`, so "grok 4.7" goes to `xai/grok-4.7`. A provider word constrains the match
  ("opencode-go grok 4.7" → `opencode-go/…`). Include the provider word only when the user names one.
- If you get an **ambiguous** error, the name matched several different models. Choose from the
  candidates it lists, and ask the user only if their intent is unclear.
- For a reasoning variant, add `#variant`, e.g. `"xai/grok-4.7#high"`.
- If the user names no model, omit `model`. Tasks that edit files get the default
  (`opencode-go/muse-spark-1.3-contributor`). Read-only tasks with `mode: "read-only"` get the free
  `opencode/muse-spark-1.3-contributor-free`. Use `mode: "read-only"` for reading or summarising files,
  answering questions about code, and reviews.

Exact provider/model IDs never fall back to another route. Prefer exact IDs or configured aliases
when billing or provider selection matters. If the requested route is unavailable, report the error.

## Writing the brief (`prompt`)

The delegated model **cannot see this conversation**. Write a self-contained brief:

1. **Goal**: what to build or fix, and why.
2. **Context**: the relevant files and paths, the existing patterns to follow, and the commands to build and test.
3. **Constraints**: what not to touch, and the style to follow. Tell it not to commit unless you want a commit.
4. **Done when**: the acceptance criteria, e.g. "`bun test` passes" or "prints X".
5. **Report**: ask for a short summary of the changes and anything left undone.

Use `files` to attach key files. Keep `cwd` at the project root unless the task is scoped to a subdirectory.

## Permissions

`auto` defaults to true. The model can edit files and run commands without asking, but opencode rules
set to "deny" are still enforced. Pass `mode: "read-only"` for read-only work, such as a review, a second
opinion or a question.

## After it returns: review, don't trust blindly

Read-only mode uses a dedicated agent with only read/glob/grep. Do not pass a custom agent.
The legacy auto:false also selects this mode; mode:write, auto:false keeps normal permissions.

The result reports status, `session_id`, token usage, the tools used, and **git changes**.

1. Read the diff (`git diff`) for the files it lists.
2. Run the tests or build yourself.
3. To fix something, either continue the **same session** with `delegate` and `session_id`, giving
   precise feedback, or fix it yourself if that's quicker.
4. Tell the user which model did what, and your verdict on it.

## Parallel and multi-model patterns

- **Fan out**: call `delegate_async` once per model or subtask, then `task_result` with `wait_s` for each.
  Parallel tasks that edit files must use **separate git worktrees** (`git worktree add`) or
  non-overlapping files, because they share the directory.
- **Compare**: give the same brief to 2–3 models in separate worktrees, then diff the results and pick
  or merge the best one.
- **Second opinion**: `mode: "read-only"` with a prompt like "review this diff for bugs: …".
- **Subagents / workflows**: the `opencode-worker` agent wraps this loop. Spawn it with the model and task
  in its prompt, e.g. "Use opencode model kimi k3 to add tests for src/foo.ts".

## Ownership and recovery

Each task runs with a private OpenCode server. Prefer explicit session_id and returned cwd for
follow-ups. Never use continue to guess which parallel session to resume. Same-worktree jobs are
rejected; create separate worktrees before fan-out. worktree:true can create a retained isolated
worktree for a new write job from a clean source tree; inspect that returned cwd before accepting.

Git results include already-dirty files and HEAD movement. If change reporting is unavailable,
inspect the complete repository yourself. Execution success does not mean task acceptance.
Poll task_result with wait_s <= 30. After cancellation, inspect partial changes before retrying.
If a journal restores a task as unknown/error, inspect its saved session instead of replaying it.

Briefing, reviewing and any Claude worker subagent still consume Claude usage. Prefer direct
delegation for simple tasks; request compact worker reports and measure retries.
