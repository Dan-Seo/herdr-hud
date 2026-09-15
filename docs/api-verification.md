# API verification for herdr_delegate

What the delegate feature relies on, and how each point was verified. Legend:
**docs** = stated in the published docs/help, **types** = present in the `/plugin-types` output of
the installed build, **local** = observed by running it on this machine.

Environment: Windows 11 Pro 10.0.26200, PowerShell 5.1 (pane shell), Git Bash for the experiments,
Claude Code 2.1.272 (`.claude/types` written by that build), Herdr 0.8.2, codex-cli 0.154.0
(logged in with ChatGPT), Node v24.15.0.

## Claude Code function hooks

| Point | docs | types | local | Note |
| --- | --- | --- | --- | --- |
| `$.tool.register({ name, description, inputSchema })` returns `{ tool }`, the full `mcp__<plugin>__<name>` | yes | yes | yes | Full name taken from the result, never hardcoded |
| Registered tool served by an unmatched `tool.call` hook; only ONE unmatched hook per event is allowed | | yes | yes | Two unmatched hooks refuse the whole module ("registered twice without a matcher") |
| A hook answer for a plugin tool must be `{ result: McpContentBlock[] }` | | partly | yes | `{ result: {...} }` fails core validation ("expected array"); `[{ type: "text", text }]` works |
| `{ deny: reason }` reaches the model as an error result | yes | yes | yes | Used for input errors and limits |
| `tool.call` hook budget is about 10 s | | | yes | 8 s wait answered; 15 s, 45 s, 200 s were dropped ("no tool.call hook answered") |
| `session.start` can register tools; timers from `$.clock.every` outlive a dispatch | yes | yes | yes | The job tick runs from such a timer |
| `$.process.run(argv, { cwd, env, stdin, timeoutMs })`: no shell, default 30 s, 10 min max | | yes | yes | Only argv and timeoutMs/cwd are used |
| `$.fs.read / write` (absolute paths, directories created) | | yes | yes | Task files under `%TEMP%\herdr-hud\<taskId>` |
| `$.env.get("NAME")` needs a literal name | | yes | yes | `OS`, `TEMP`, `TMPDIR`, `HERDR_HUD_DELEGATE_WORKER` |
| `$` may not be passed across an import | | | yes | Loader refuses "$ is passed to tick, imported from ..."; runner.ts takes a `Host` of closures built in register.tsx |
| `$.clock.now()` is async | | yes | yes | |
| `userConfig` fields need `type`, `title`, `description`; defaults reach `register(on, options)` | yes | partly | yes | Probe tool returned the options; project `.claude/settings.json` is ignored, `--settings` works |
| No session-end event for a plugin; `session.detach` only | | yes | | Nothing to kill anyway: the worker is never stopped by the plugin |
| `claude plugin test` cannot set plugin options | | | yes | Inline plugins must be `register(on) {}` and self-contained; `config.set` has no implementation beneath the plugins; `--settings` is ignored there |

## Herdr CLI (0.8.2)

| Point | docs | local | Note |
| --- | --- | --- | --- |
| `herdr pane split --current --direction down --no-focus --cwd <dir> --env K=V` returns `.result.pane.pane_id` | yes | yes | Pane id read from the answer (`w1:pD`, `w1:pE` in the runs) |
| `herdr pane run <pane> <command>` sends the text plus Enter; exit 0 with EMPTY stdout | yes | yes | The first E2E failed on parsing that empty stdout |
| `herdr pane wait-output <pane> --match <text> --timeout <ms>` answers `.result.matched_line`; timeout is exit 1 with `{ error: { code: "timeout" } }` | yes | yes | Polled with a 1.5 s timeout per tick |
| `herdr pane process-info <pane>` lists `foreground_processes` | | yes | Empty for an idle shell; the running command otherwise |
| `herdr pane get <pane>` shows `agent` (null for a plain shell) | | yes | Reuse check |
| `herdr pane close <pane>` | yes | yes | Used only by hand to clean up experiment panes; the plugin never closes panes |
| `herdr agent prompt --wait` / `agent read`: interactive agents use the alternate screen; output may be unrecoverable; the documented fallback is asking the agent to write a file | yes (herdr --skill) | not exercised | Reason the interactive-agent route was not chosen |
| Server down: exit 1 with JSON on stderr | yes | yes (earlier HUD work) | |

## Codex CLI (0.154.0)

| Point | docs | local | Note |
| --- | --- | --- | --- |
| `codex exec --sandbox read-only` | yes | yes | Banner shows `sandbox: read-only`, `approval: never` |
| `--output-schema <file>` constrains the final message; `-o <file>` writes that message | yes | yes | Valid JSON with the taskId came back in both real runs |
| Prompt from stdin with `-` | yes | yes | `run.cmd` redirects the prompt file; the task never enters a shell string |
| `codex` is a `.cmd` shim on Windows: a batch file must `call` it | | yes | Without `call` the marker line never printed |
| The user config is applied (model, hooks) | yes | yes | `model: gpt-6-astra`, SessionStart hooks ran; `-m` only when `delegateCodexModel` is set |
| Not verified: that the read-only sandbox blocks every write on Windows | | no | Treated as defence in depth together with the prompt rules; the plugin also never asks the worker to write |