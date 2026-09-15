// The mod under the engine's own $: runs with `claude plugin test tests/hooks`
// (needs CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1). `process.run` is answered from memory.
import type { On, ProcessRunResult, RenderInput, SessionStartInput } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

import { POLL_MS } from '../../hooks/register.tsx'

tier('user')

const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }

const BAND: RenderInput<'AbovePrompt'> = {
  component: 'AbovePrompt',
  surface: 'terminal',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 19 }, view: {} },
}

const listing = (agents: unknown[]): ProcessRunResult => ({
  exitCode: 0,
  stdout: JSON.stringify({ id: 'cli:agent:list', result: { agents, type: 'agent_list' } }),
  stderr: '',
})

const DOWN: ProcessRunResult = { exitCode: 1, stdout: '', stderr: '{"error":{"code":"connect_failed","message":"no server socket"}}' }

const claude = (pane: string, title: string, status: string) => ({ agent: 'claude', agent_status: status, pane_id: pane, focused: false, terminal_title_stripped: title })
const codex = (pane: string, title: string, status: string) => ({ agent: 'codex', agent_status: status, pane_id: pane, focused: false, terminal_title_stripped: title })

/** The text of a rendered tree, in drawing order. */
function textOf(tree: unknown): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(textOf).join('')
  if (typeof tree !== 'object' || !tree) return ''
  return textOf(Reflect.get(tree, 'children') ?? [])
}

/** Answers session.start and the band beneath the mod, and process.run from `answers`, in order (the last repeats). */
function world(on: On, answers: (ProcessRunResult | { deny: string })[]) {
  const argvs: (readonly string[])[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  // beneath the mod the engine draws nothing in the band: an empty Box stands for that
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  const counts = { invalidations: 0 }
  on('ui.invalidate', () => {
    counts.invalidations++
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    argvs.push(e.argv)
    const answer = answers[Math.min(argvs.length, answers.length) - 1]!
    return 'deny' in answer ? { deny: answer.deny } : { value: answer }
  })
  return { argvs, counts, clock: mock.clock(on) }
}

describe('register', () => {
  test('no herdr on PATH: the band says not connected, the session is fine', async ($, on) => {
    const { clock } = world(on, [{ deny: 'spawn herdr ENOENT' }])
    await $.session.start(SESSION)
    await clock.settle()
    const drawn = textOf(await $.ui.render(BAND))
    expect(drawn).toContain('HERDR')
    expect(drawn).toContain('not connected')
  })

  test('herdr running, no agents', async ($, on) => {
    const { argvs, clock } = world(on, [listing([])])
    await $.session.start(SESSION)
    await clock.settle()
    expect(argvs[0]).toEqual(['herdr', 'agent', 'list'])
    expect(textOf(await $.ui.render(BAND))).toContain('no agents')
  })

  test('two Claude agents and a Codex, each with its symbol and status', async ($, on) => {
    const { clock } = world(on, [listing([claude('w1:p1', 'main', 'working'), claude('w1:p2', 'backend', 'working'), codex('w1:p3', 'tests', 'done'), claude('w1:p4', 'reviewer', 'blocked')])])
    await $.session.start(SESSION)
    await clock.settle()
    const drawn = textOf(await $.ui.render(BAND))
    expect(drawn).toContain('● main')
    expect(drawn).toContain('Claude')
    expect(drawn).toContain('working')
    expect(drawn).toContain('✓ tests')
    expect(drawn).toContain('Codex')
    expect(drawn).toContain('! reviewer')
    expect(drawn).toContain('blocked')
  })

  test('a status change on the next poll redraws the band', async ($, on) => {
    const { clock } = world(on, [listing([claude('w1:p1', 'main', 'working')]), listing([claude('w1:p1', 'main', 'idle')])])
    await $.session.start(SESSION)
    await clock.settle()
    expect(textOf(await $.ui.render(BAND))).toContain('● main')
    await clock.advance(POLL_MS)
    expect(textOf(await $.ui.render(BAND))).toContain('○ main')
  })

  test('herdr going away mid-session turns the band quiet, not broken', async ($, on) => {
    const { clock } = world(on, [listing([claude('w1:p1', 'main', 'working')]), DOWN])
    await $.session.start(SESSION)
    await clock.settle()
    await clock.advance(POLL_MS)
    const drawn = textOf(await $.ui.render(BAND))
    expect(drawn).toContain('not connected')
    expect(drawn).toContain('no server socket')
  })

  test('a broken answer is not connected either', async ($, on) => {
    const { clock } = world(on, [{ exitCode: 0, stdout: '{"result":', stderr: '' }])
    await $.session.start(SESSION)
    await clock.settle()
    expect(textOf(await $.ui.render(BAND))).toContain('not connected')
  })

  test('an unchanged poll asks for no redraw', async ($, on) => {
    const { clock, counts } = world(on, [listing([claude('w1:p1', 'main', 'working')])])
    await $.session.start(SESSION)
    await clock.settle()
    await clock.advance(POLL_MS * 3)
    expect(counts.invalidations).toBe(1)
  })

  test('a survey in the band wins; the mod passes', async ($, on) => {
    const { clock } = world(on, [listing([claude('w1:p1', 'main', 'working')])])
    await $.session.start(SESSION)
    await clock.settle()
    expect(textOf(await $.ui.render({ ...BAND, props: { ...BAND.props, hasSurvey: true } }))).not.toContain('HERDR')
  })
})
