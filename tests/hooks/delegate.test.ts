// The delegate under the engine's own $: `claude plugin test .` (needs CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1).
// The kit loads the plugin with its manifest defaults (delegate off) and offers no way to set
// options, so the enabled path is covered by tests/unit/runner.spec.ts (fake Host) and the E2E run.
import type { On, ProcessRunResult, SessionStartInput, ToolCallArgs } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

tier('user')

const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: 'C:\work\repo' }

const listing: ProcessRunResult = { exitCode: 0, stdout: JSON.stringify({ result: { agents: [], type: 'agent_list' } }), stderr: '' }

function world(on: On) {
  const argvs: (readonly string[])[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => {
    argvs.push(e.argv)
    return { value: listing }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  mock.env(on, { OS: 'Windows_NT', TEMP: 'C:\tmp' })
  return { argvs, clock: mock.clock(on) }
}

describe('delegate off (the default)', () => {
  test('answers no herdr_delegate call, splits no pane, runs nothing but the agent list', async ($, on) => {
    const { argvs, clock } = world(on)
    await $.session.start(SESSION)
    await clock.settle()
    await clock.advance(6000)
    await expect($.tool.call({ tool: 'mcp__herdr-hud__herdr_delegate', kind: 'codex', task: 'x' } as unknown as ToolCallArgs)).rejects.toThrow()
    await expect($.tool.call({ tool: 'mcp__herdr-hud__herdr_collect', taskId: 'rev-00000000' } as unknown as ToolCallArgs)).rejects.toThrow()
    expect(argvs.every(a => a[0] === 'herdr' && a[1] === 'agent' && a[2] === 'list')).toBe(true)
  })
})
