// Pure layout of the HUD; runs under `node --test` (no Claude Code needed).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { HerdrAgent, HerdrState } from '../../hooks/herdr/client.ts'
import { hudView } from '../../hooks/ui/hud.ts'

const agent = (name: string, kind: string, status: HerdrAgent['status']): HerdrAgent => ({ name, kind, status, paneId: `p:${name}`, focused: false })

const connected = (...agents: HerdrAgent[]): HerdrState => ({ connected: true, agents })

const texts = (state: HerdrState, columns = 80, maxRows = 10) => hudView(state, { columns, maxRows }).lines.map(l => l.text)

test('not connected: a title and one quiet line', () => {
  assert.deepEqual(texts({ connected: false, reason: 'no server socket' }), ['HERDR', '○ not connected · no server socket'])
})

test('connected with no agents', () => {
  assert.deepEqual(texts(connected()), ['HERDR', '○ no agents'])
})

test('one row per agent: symbol, name, kind, status, aligned', () => {
  const lines = texts(connected(agent('main', 'claude', 'working'), agent('tests', 'codex', 'done'), agent('review', 'claude', 'blocked'), agent('x', 'claude', 'idle')))
  assert.deepEqual(lines, [
    'HERDR',
    '● main   Claude working',
    '✓ tests  Codex  done',
    '! review Claude blocked',
    '○ x      Claude idle',
  ])
})

test('the colour is never the only signal: each status has its own symbol', () => {
  const symbols = new Set(texts(connected(agent('a', 'claude', 'working'), agent('b', 'claude', 'idle'), agent('c', 'claude', 'done'), agent('d', 'claude', 'blocked'), agent('e', 'claude', 'unknown'))).slice(1).map(l => l[0]))
  assert.equal(symbols.size, 5)
})

test('more agents than rows: the budget is kept and the rest is counted', () => {
  const many = Array.from({ length: 12 }, (_, i) => agent(`agent${i}`, 'claude', 'working'))
  const lines = texts(connected(...many), 80, 8)
  assert.equal(lines.length, 8)
  assert.equal(lines.at(-1), '+ 6 more')
})

test('a tiny row budget still shows a few rows; the band scrolls the rest', () => {
  const many = Array.from({ length: 12 }, (_, i) => agent(`agent${i}`, 'claude', 'working'))
  const lines = texts(connected(...many), 80, 3)
  assert.equal(lines.length, 6)
  assert.equal(lines.at(-1), '+ 8 more')
})

test('a long name is cut and rows never exceed the width', () => {
  const lines = texts(connected(agent('a-very-long-agent-name-that-goes-on-and-on', 'claude', 'working')), 30)
  assert.ok(lines.every(l => l.length <= 30), lines.join('\n'))
  assert.match(lines[1] ?? '', /…/)
})

test('a narrow terminal drops the kind column rather than wrapping', () => {
  const lines = texts(connected(agent('main', 'claude', 'working')), 18)
  assert.deepEqual(lines, ['HERDR', '● main working'])
  assert.ok(lines.every(l => l.length <= 18))
})

test('a delegate job adds a DELEGATE title and one row that names the job, not an agent', () => {
  const view = hudView(connected(agent('main', 'claude', 'working')), { columns: 80, maxRows: 20 }, { status: 'running', text: 'review · running · 38s', paneId: 'w1:p9' })
  const lines = view.lines.map(l => l.text)
  assert.deepEqual(lines.slice(-2), ['DELEGATE', 'review · running · 38s'])
  assert.equal(view.lines.at(-1)?.paneId, 'w1:p9')
  const done = hudView(connected(), { columns: 80, maxRows: 20 }, { status: 'completed', text: 'review · completed · 2 findings' })
  assert.equal(done.lines.at(-1)?.text, 'review · completed · 2 findings')
  assert.equal(done.lines.at(-1)?.paneId, undefined)
})

test('the job row is marked as the worker pane even when its text is cut', () => {
  const view = hudView(connected(), { columns: 12, maxRows: 20 }, { status: 'running', text: 'review · running · 38s', paneId: 'w1:p9' })
  const row = view.lines.at(-1)!
  assert.ok(row.text.endsWith('…') && row.text !== 'review · running · 38s')
  assert.equal(row.worker, true)
  assert.ok(view.lines.slice(0, -1).every(l => !l.worker))
})

test('without a job the HUD is exactly as before', () => {
  assert.deepEqual(texts(connected(agent('main', 'claude', 'working')), 80), ['HERDR', '● main Claude working'])
})
