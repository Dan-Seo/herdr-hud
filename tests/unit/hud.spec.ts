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
  const lines = texts(connected(...many), 80, 5)
  assert.equal(lines.length, 5)
  assert.equal(lines.at(-1), '+ 9 more')
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
