# herdr-hud

A Claude Code mod (function-hooks plugin) that draws a small read-only HUD directly above the
Claude Code prompt, showing the agents running in [Herdr](https://herdr.dev) — each
agent's name, kind and status — refreshed every 2 seconds.

It does not change anything in Herdr or in your session. It only looks.

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

## Requirements

- **Claude Code 2.1.272 or newer**, run with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Function hooks
  are early access; without the flag the plugin's `modules` key is ignored and nothing is drawn.
- **Herdr 0.8.2 or newer**, with the `herdr` CLI on `PATH`. The HUD reads `herdr agent list`.
- **An interactive terminal.** The HUD only polls and draws when the session surface is `terminal`
  and interactive.

### Supported versions

| Component | Supported |
| --- | --- |
| Claude Code | 2.1.272+ (function hooks enabled) |
| Herdr | 0.8.2+ |
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

`tests/unit/` holds the pure specs (`client.spec.ts`, `hud.spec.ts`); `tests/hooks/register.test.ts`
exercises the registered hooks.

## Architecture

Three files, split so that everything except the hook wiring is pure and directly testable.

- **`hooks/register.tsx`** — the hooks. `session.start` starts a 2 s `$.clock.every` poll (terminal
  and interactive sessions only) that runs `herdr agent list` through `$.process.run`, and calls
  `$.ui.invalidate` only when the rows it would draw actually changed. `ui.render` on the
  `AbovePrompt` component draws the current lines above the prompt.
- **`hooks/herdr/client.ts`** — pure parsing of the `herdr` CLI's JSON output into a `HerdrState`
  (`connected` with agents, or disconnected with a reason). Nothing here runs a command.
- **`hooks/ui/hud.ts`** — pure line layout: title row, one row per agent with the status symbol,
  the `+ N more` cut when rows run out, and narrow-terminal handling (the kind column is dropped
  when the width cannot hold it).

## Known limitations

- **Polling, not push.** A hooks module has no network or socket access — only `$.process.run` —
  so the HUD shells out to the CLI on a timer rather than subscribing to Herdr's socket.
- **Terminal only.** Nothing is drawn in `-p` runs, the desktop app, or mobile.
- **Read-only.** No click-to-focus, no interaction of any kind yet.
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

Not implemented, just ideas:

- Click a row to focus that Herdr pane
- Refresh and new-agent buttons
- Sending a prompt to a blocked agent

## License

MIT
