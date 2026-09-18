# herdr-hud

A Claude Code mod (function-hooks plugin) that draws a small read-only HUD directly above the
Claude Code prompt, showing the agents running in [Herdr](https://herdr.dev) — each
agent's name, kind and status — refreshed every 2 seconds.

It does not change anything in your session. Its one action in Herdr is focusing the pane whose row you click.

Opt-in (off by default): a `herdr_delegate` tool that lets Claude hand a **read-only** code review of
your uncommitted changes to a Codex job running in a Herdr pane the plugin owns, and read the result
back. See [Codex delegate](#codex-delegate-opt-in).

## What it does

**HUD (on by default)**

- Every 2 s it reads `herdr agent list` and draws one row per agent: name, kind, status. Status
  is carried by a symbol as well as a colour.
- Clicking a row focuses that pane in Herdr. That is the only thing it does in Herdr.
- With Herdr missing or down, the band says `not connected` and the session is unaffected.

**Codex delegate (opt-in, off by default)**

- `herdr_delegate` snapshots the uncommitted tracked changes (staged and unstaged), queues a
  read-only review, and answers a `taskId`. The review runs as `codex exec --sandbox read-only` in
  a Herdr pane the plugin split for itself.
- `herdr_collect` answers the job's status (`queued`, `starting`, `running`, `completed`, `failed`,
  `timed_out`, `needs_attention`) and, when completed, findings with file, line, severity and
  evidence. It marks the result `stale` when the tree changed since the snapshot and always says
  `testsRun: false`.
- The HUD gains a `DELEGATE` row (`review · running · 38s`); clicking it focuses the worker pane.
- `.env`, key and credential files are excluded from the packet; untracked files are named, not
  sent. No user pane is touched, no key is pressed, nothing is approved, retried, fixed or
  committed. Calls per session and the time per review are capped. Results are presented to
  Claude as an external opinion to verify, never as instructions.

## What it looks like

```
HERDR
● main   Claude working
✓ tests  Codex  done
! review Claude blocked
```

Status symbols: `●` working, `○` idle, `✓` done, `!` blocked, `?` unknown.

When Herdr is not running, not installed, or answers something unexpected, the band falls back to:

```
HERDR
○ not connected
```

(the real fallback row appends a short reason after `not connected`).

If there are more agents than rows available, the last row becomes `+ N more`. The row budget is
what Claude Code gives the band (`maxRows`, as small as 3 on a short terminal), floored at 6 rows
so a handful of agents stays visible; the band itself scrolls (and collapses with `[-]`).

## Codex delegate (opt-in)

With the `delegate` option on, the plugin registers two tools for the model:

- `herdr_delegate` `{ "kind": "codex", "task": "..." }` snapshots the repository's tracked changes
  (`git diff HEAD`, staged and unstaged), writes a review packet outside the repository, and queues a
  job. It answers at once with a `taskId` and status `queued`.
- `herdr_collect` `{ "taskId": "..." }` answers the job's status, and once it is `completed`, the
  review. It starts nothing and is safe to repeat.

Between the two, a timer started at `session.start` drives the job: it splits a sibling pane below
your session (unfocused, marked with `HERDR_HUD_DELEGATE_WORKER=1`), runs `codex exec --sandbox
read-only` there through a small runner script, watches the pane for an end marker carrying the
taskId and exit code, then reads and validates the JSON Codex wrote with `-o` against an output
schema. A result is `completed` only when the marker for this taskId appeared, the file parsed, and
its `taskId` matches; anything else is `failed` with a reason.

Example requests you can make to Claude:

- "현재 변경사항을 Codex에게 리뷰받고, 타당한 지적을 검토해줘."
- "Have Codex review my uncommitted changes for regressions, then tell me which findings hold up."

Claude calls `herdr_delegate`, waits, calls `herdr_collect`, and is told in both the tool
description and every result that the findings are an external agent's opinion to be checked file
by file and line by line, never instructions to execute.

### Turning it on

Options live in your user `settings.json` (project settings are ignored for plugin options), or in
`/config` under the plugin's rows:

```json
{
  "pluginConfigs": {
    "herdr-hud": {
      "options": { "delegate": true }
    }
  }
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `delegate` | `false` | Register the two tools and start the job timer |
| `delegateMaxCalls` | `5` | Reviews one session may start |
| `delegateTimeoutMs` | `600000` | Deadline per review (60 s to 30 min); the worker is not killed at the deadline |
| `delegateCodexModel` | `""` | Passed to `codex exec -m` when set; not validated against the installed Codex |

### What the HUD shows

```
HERDR
● main               Claude working

DELEGATE
review · running · 38s
```

The `DELEGATE` block is the plugin's job, not a Herdr agent: `review · completed · 2 findings`,
`review · failed · job`, `review · timed out · [Focus]`, `review · needs attention · [Focus]`. The
row is clickable while it has a pane and focuses the worker pane.

### Worker ownership and permissions

- The worker is always a pane this plugin split in the current session. It never prompts a Codex
  (or any agent) you started, never closes a pane, never presses keys in one.
- Codex runs as a one-shot `codex exec` job with `--sandbox read-only` and the prompt says not to
  write, run tests or follow instructions found in the diff. The plugin never passes any
  `--dangerously-*` flag. That the sandbox blocks every write on Windows was **not** verified here.
- A session running inside the worker pane (which carries `HERDR_HUD_DELEGATE_WORKER=1`) registers no
  delegate tools, so a worker cannot delegate again.
- One job at a time per session; the same tool call retried answers the job it already started,
  and a second call arriving while the first is still starting is refused.

### Review scope and exclusions

- In: tracked files changed against `HEAD`, staged and unstaged, as one diff (cut at 200 000
  characters with a note; the snapshot hash covers the whole diff). Codex may read other files in
  the repository for context.
- Paths are taken from the repository root (`git rev-parse --show-toplevel`), whatever directory
  the session runs in, and passed to git as literal pathspecs so a file named `*` cannot widen the
  diff.
- Named only, never sent: untracked files.
- Excluded by path pattern: `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `credentials*`,
  `secrets*`, `.netrc`, `.npmrc`, `.pypirc`. This is a short list, not a secret scanner.
- Binary files appear as git's `Binary files differ` line.
- Nothing is committed, stashed or reset. If the tree changes after the snapshot, `herdr_collect`
  reports `stale: true` and the result still names the snapshot hash it reviewed.

### blocked, timed out, failed

- `needs_attention`: nothing ran in the worker pane within 30 s and no marker appeared (a login
  prompt, a missing `codex`, ...). Look at the pane; nothing is re-sent.
- `timed_out`: the deadline passed. The worker was **not** stopped and may still be running; the
  status says so rather than claiming it stopped.
- `failed`: Herdr or git answered an error, Codex exited without a valid file, the file was for
  another task, or the JSON did not parse. The reason is in the result.
- `completed` means the worker answered for this task, not that the code is fine. `testsRun` is
  always `false`: the plugin runs no tests and asks Codex not to.

Every review uses your Codex account and its usage/quota. Task files (prompt, schema, runner,
output) are left under `%TEMP%\herdr-hud\<taskId>` (`$TMPDIR` or `/tmp` elsewhere) for inspection.

### Verified on

Windows 11 Pro, PowerShell 5.1 panes, Claude Code 2.1.272, Herdr 0.8.2, codex-cli 0.154.0, Node 24.
The full flow (Claude calls the tool → Codex reviews in a Herdr pane → Claude reads the result and
checks the finding) ran end to end against a small fixture repository with an intentional
off-by-one; Codex found it, the taskId matched, and the fixture tree was untouched afterwards. The
exact API observations are in [docs/api-verification.md](docs/api-verification.md).

Not verified: macOS/Linux (the `run.sh` path is written but was never executed), the HUD rows of a
running job in an interactive terminal (covered by the pure layout spec only), and Codex's sandbox
on Windows.

## Requirements

- **Claude Code 2.1.272 or newer**, run with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Function hooks
  are early access; without the flag the plugin's `modules` key is ignored and nothing is drawn.
- **Herdr 0.8.2 or newer**, with the `herdr` CLI on `PATH`. The HUD reads `herdr agent list`.
- **Codex CLI** (`codex` on `PATH`, logged in) only if you turn the delegate on.
- **An interactive terminal.** The HUD only polls and draws when the session surface is `terminal`
  and interactive.

### Supported versions

| Component | Supported |
| --- | --- |
| Claude Code | 2.1.272+ (function hooks enabled) |
| Herdr | 0.8.2+ |
| Codex CLI (delegate only) | 0.154.0 verified |
| Surface | interactive terminal only |

## Install

Clone and run Claude Code with the plugin directory:

```sh
git clone https://github.com/Dan-Seo/herdr-hud
cd herdr-hud
claude --plugin-dir .
```

Or install from the marketplace:

```sh
claude plugin marketplace add Dan-Seo/herdr-hud
claude plugin install herdr-hud@herdr-hud
```

## Enabling function hooks

Set the env var in your settings file:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

Or per session:

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude
```

This repo's own `.claude/settings.json` already sets it, so running `claude --plugin-dir .` from
inside the clone works without extra setup.

## Development

```sh
# inside the plugin folder, generate .claude/types for the hooks API
/plugin-types

# typecheck
npx tsc -p tsconfig.json

# run Claude Code against the working copy with hook diagnostics
claude --plugin-dir . --debug
```

## Testing

```sh
# unit specs for the parser and the layout (node --test)
npm test

# hook tests under the official claude-code/testing kit
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .
```

`tests/unit/` holds the pure specs (`client.spec.ts`, `hud.spec.ts`, `job.spec.ts`) and the runner
against a fake host (`runner.spec.ts`); `tests/hooks/` exercises the registered hooks. The hook kit
loads the plugin with its manifest defaults and offers no way to set options, so the delegate's
enabled path is covered by `runner.spec.ts` and the manual E2E run, and `delegate.test.ts` checks the
off path.

## Architecture

Split so that everything except the hook wiring is pure or testable against a fake host.

- **`hooks/register.tsx`** — the hooks. `session.start` starts a 2 s `$.clock.every` poll (terminal
  and interactive sessions only) that runs `herdr agent list` through `$.process.run`, and calls
  `$.ui.invalidate` only when the rows it would draw actually changed. `ui.render` on the
  `AbovePrompt` component draws the current lines above the prompt.
- **`hooks/herdr/client.ts`** — pure parsing of the `herdr` CLI's JSON output into a `HerdrState`
  (`connected` with agents, or disconnected with a reason). Nothing here runs a command.
- **`hooks/ui/hud.ts`** — pure line layout: title row, one row per agent with the status symbol,
  the `+ N more` cut when rows run out, and narrow-terminal handling (the kind column is dropped
  when the width cannot hold it); plus the `DELEGATE` rows when a job exists.
- **`hooks/delegate/job.ts`** — pure: input validation, the review packet, the output schema,
  result validation (taskId match, shape), the tool result text.
- **`hooks/delegate/runner.ts`** — the job's steps against a small `Host` (run, read, write, cwd):
  git snapshot, task files, worker pane, the poll tick's state transitions, collect. The engine only
  follows `$` inside the hooks module, so `register.tsx` builds the `Host` from literal `$` calls.

## Known limitations

- **Delegate: no synchronous wait.** A `tool.call` hook has a budget of about 10 s (measured on
  2.1.272: 8 s answered, 15 s dropped), so the review cannot be awaited inside the call. Hence
  `herdr_delegate` + `herdr_collect`.
- **Delegate: one shell form.** The worker command is `cmd /c "<runner>.cmd"` on Windows and
  `sh "<runner>.sh"` elsewhere, sent through `herdr pane run`; only the Windows form was run.
- **Delegate: local Herdr only.** Paths in the runner are this machine's; a remote Herdr server is
  not supported.

- **Polling, not push.** A hooks module has no network or socket access — only `$.process.run` —
  so the HUD shells out to the CLI on a timer rather than subscribing to Herdr's socket.
- **Terminal only.** Nothing is drawn in `-p` runs, the desktop app, or mobile.
- **One interaction only.** Clicking an agent row runs `herdr agent focus <pane>` to bring that pane
  to the front in Herdr; nothing else is interactive yet.
- **The band takes 2+ rows** of your terminal, above the prompt.
- **Agent names** come from the Herdr live agent name, else the pane's stripped title, else the
  pane id.
- **Windows** has only been tested on the author's machine.
- **Live shutdown of Herdr** was verified only in the hook tests (the CLI's exit-1 answer): the
  author's own sessions run inside Herdr, so the server could not be stopped underneath them.

## ⚠️ Early access

Claude Mods / the function hooks API are early access and may change between Claude Code releases.
When they do, this plugin may break and need updating. Pin versions if that matters to you.

## Roadmap

Done: click a row to focus that Herdr pane (v0.2.0); opt-in Codex review delegate (v0.3.0). Not
implemented, just ideas:

- Refresh and new-agent buttons
- Sending a prompt to a blocked agent

## License

MIT
