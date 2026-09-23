---
description: Delegate a task to an OpenCode model (e.g. /opencode grok 4.7 -- add input validation to the signup form)
argument-hint: <model> -- <task>
---

Delegate this to an OpenCode model, following the opencode-delegate skill: $ARGUMENTS

The text before `--` is the model name. Pass it to the tool unchanged, and the server will resolve
it. If there is no `--`, work out the model name from the text, or leave the model out.

The text after `--` is the task. Before you call `delegate`, expand it into a self-contained brief
using what you know about this project.

When it returns, review its git changes, run the relevant tests, and give me a summary. The summary
should say which model did the work, what it changed, and your verdict.
