/* @jsx h */
import type { EngineInterface, Register, Timer } from 'claude-code'
import { AGENT_LIST_ARGV, keyOf, stateOf, type HerdrState } from './herdr/client.ts'
import { hudView } from './ui/hud.ts'

// Read-only HUD: every POLL_MS the mod runs `herdr agent list` through $.process.run, and when the
// rows it would draw changed, asks for a redraw of the AbovePrompt band. Herdr missing, down, or
// answering nonsense draws "not connected"; nothing here can fail the session.

export const POLL_MS = 2000
const RUN_TIMEOUT_MS = 5000

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

type Hud = { state: HerdrState; key: string; inflight: boolean }

// Declared at the top of the file: the engine reads `$` only at `$.noun.event(...)` call sites and
// in a top-level function it is passed to, so the poll cannot live inside register's closure.
/** A row's click: bring that pane to the front in Herdr. Every HUD row hosts an agent, so `agent focus` resolves its pane id. */
async function focusPane($: EngineInterface, paneId: string) {
  try {
    const run = await $.process.run(['herdr', 'agent', 'focus', paneId], { timeoutMs: RUN_TIMEOUT_MS })
    if (run.exitCode !== 0) $.ui.toast(`herdr-hud: could not focus ${paneId}`)
  } catch (err) {
    $.ui.toast(`herdr-hud: could not focus ${paneId}: ${messageOf(err)}`)
  }
}

async function poll($: EngineInterface, hud: Hud) {
  if (hud.inflight) return
  hud.inflight = true
  let next: HerdrState
  try {
    next = stateOf(await $.process.run(AGENT_LIST_ARGV, { timeoutMs: RUN_TIMEOUT_MS }))
  } catch (err) {
    // the command could not start (no herdr on PATH), or overran: treat as disconnected
    next = { connected: false, reason: messageOf(err) }
  } finally {
    hud.inflight = false
  }
  const key = keyOf(next)
  if (key === hud.key) return
  hud.key = key
  hud.state = next
  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  const hud: Hud = { state: { connected: false, reason: 'starting' }, key: '', inflight: false }
  hud.key = keyOf(hud.state)
  let timer: Timer | undefined

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // the band is terminal-only; a -p run or the SDK has nowhere to draw, so don't poll there
    if (e.surface === 'terminal' && e.isInteractive) {
      timer?.cancel()
      void poll($, hud)
      timer = $.clock.every(POLL_MS, () => void poll($, hud))
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const { lines } = hudView(hud.state, { columns: e.props.bodyColumns, maxRows: e.props.maxRows })
    // an agent row is a plain Button (no chrome, no hotkey: a band hotkey would fire on a digit typed
    // as the first character of a prompt); a click brings that pane to the front in Herdr
    return (
      <Box flexDirection="column">
        {lines.map((line, i) =>
          line.paneId ? (
            <Button key={`row:${line.paneId}`} label={line.text} plain dimColor={line.dim} onPress={() => void focusPane($, line.paneId!)} />
          ) : (
            <Text key={`hud:${i}`} color={line.color} dimColor={line.dim} bold={line.bold} wrap="truncate-end">
              {line.text}
            </Text>
          ),
        )}
        {await next(e)}
      </Box>
    )
  })
}
