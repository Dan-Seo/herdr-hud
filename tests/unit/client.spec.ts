// Pure parsing of `herdr agent list`; runs under `node --test` (no Claude Code needed).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { keyOf, parseAgentList, stateOf } from '../../hooks/herdr/client.ts'

const listing = (agents: unknown[]) => JSON.stringify({ id: 'cli:agent:list', result: { agents, type: 'agent_list' } })

const claude = { agent: 'claude', agent_status: 'working', pane_id: 'w1:p1', focused: true, terminal_title_stripped: 'main' }
const codex = { agent: 'codex', agent_status: 'done', pane_id: 'w1:p7', focused: false, name: 'tests', terminal_title_stripped: 'emper' }

test('parses each agent: name from the live name, else the pane title, else the pane id', () => {
  const agents = parseAgentList(listing([claude, codex, { agent: 'gemini', agent_status: 'idle', pane_id: 'w2:p1', focused: false }]))
  assert.deepEqual(
    agents.map(a => [a.name, a.kind, a.status, a.paneId, a.focused]),
    [
      ['main', 'claude', 'working', 'w1:p1', true],
      ['tests', 'codex', 'done', 'w1:p7', false],
      ['w2:p1', 'gemini', 'idle', 'w2:p1', false],
    ],
  )
})

test('a status Herdr adds later reads as unknown; a row without a pane id is dropped', () => {
  const agents = parseAgentList(listing([{ ...claude, agent_status: 'sleeping' }, { agent: 'claude' }]))
  assert.equal(agents.length, 1)
  assert.equal(agents[0]?.status, 'unknown')
})

test('stateOf: exit 0 with agents connects; no agents connects empty', () => {
  assert.deepEqual(stateOf({ exitCode: 0, stdout: listing([]), stderr: '' }), { connected: true, agents: [] })
  const state = stateOf({ exitCode: 0, stdout: listing([claude]), stderr: '' })
  assert.equal(state.connected, true)
})

test('stateOf: a down server (exit 1, JSON error on stderr) is not connected, with its message', () => {
  const state = stateOf({ exitCode: 1, stdout: '', stderr: '{"error":{"code":"connect_failed","message":"no server socket"}}' })
  assert.deepEqual(state, { connected: false, reason: 'no server socket' })
})

test('stateOf: broken JSON or a wrong shape is not connected, never a throw', () => {
  assert.equal(stateOf({ exitCode: 0, stdout: '{"result":', stderr: '' }).connected, false)
  assert.equal(stateOf({ exitCode: 0, stdout: '{"result":{}}', stderr: '' }).connected, false)
  assert.equal(stateOf({ exitCode: 2, stdout: '', stderr: 'usage: herdr agent list' }).connected, false)
})

test('keyOf: equal for states that draw the same, different when a status changes', () => {
  const a = stateOf({ exitCode: 0, stdout: listing([claude, codex]), stderr: '' })
  const b = stateOf({ exitCode: 0, stdout: listing([claude, codex]), stderr: '' })
  const c = stateOf({ exitCode: 0, stdout: listing([{ ...claude, agent_status: 'blocked' }, codex]), stderr: '' })
  assert.equal(keyOf(a), keyOf(b))
  assert.notEqual(keyOf(a), keyOf(c))
})
