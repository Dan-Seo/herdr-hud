// The runner against a fake Host: job admission, the worker pane, the tick transitions, the
// result validation, and what never happens (re-sends, key presses, touching another pane).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { admit, collect, newState, startJob, STARTUP_TIMEOUT_MS, tick, type DelegateConfig, type Host, type Run } from '../../hooks/delegate/runner.ts'
import { DIFF_MAX } from '../../hooks/delegate/job.ts'

const CFG: DelegateConfig = { enabled: true, maxCalls: 2, timeoutMs: 120_000, model: '' }
const ok = (result: unknown): Run => ({ exitCode: 0, stdout: JSON.stringify({ id: 'x', result }), stderr: '' })
const herdrError = (code: string, message: string): Run => ({ exitCode: 1, stdout: '', stderr: JSON.stringify({ error: { code, message } }) })
const text = (stdout: string): Run => ({ exitCode: 0, stdout, stderr: '' })

type Fake = Host & { argvs: string[][]; files: Map<string, string>; answers: Record<string, (argv: string[]) => Run | Promise<Run>> }

/** A host answering git from fixed text and herdr from `answers` keyed by `pane split`, `pane get`, ... */
function fakeHost(over: Partial<Fake['answers']> = {}, diff = '--- a/src/a.ts\n+++ b/src/a.ts\n+bug\n'): Fake {
  const files = new Map<string, string>()
  const argvs: string[][] = []
  const answers: Fake['answers'] = {
    'rev-parse': () => text('abc123\n'),
    toplevel: () => text('C:/work/repo\n'),
    'diff-names': () => text('src/a.ts\n.env\ncerts/server.pem\n'),
    'ls-files': () => text('notes.txt\n'),
    diff: () => text(diff),
    'pane split': () => ok({ pane: { pane_id: 'w1:p7', agent_status: 'unknown' }, type: 'pane_info' }),
    'pane run': () => text(''),
    'pane get': () => ok({ pane: { pane_id: 'w1:p7', agent: null } }),
    'pane process-info': () => ok({ process_info: { shell_pid: 1, foreground_processes: [{ pid: 1, name: 'powershell.exe' }] } }),
    'pane wait-output': () => herdrError('timeout', 'timed out waiting for output match'),
    ...over,
  }
  const host: Fake = {
    argvs,
    files,
    answers,
    windows: true,
    tmp: 'C:\\tmp',
    cwd: async () => 'C:\\work\\repo',
    read: async p => {
      const v = files.get(p)
      if (v === undefined) throw new Error('missing')
      return v
    },
    write: async (p, t) => void files.set(p, t),
    run: async argv => {
      const a = [...argv]
      argvs.push(a)
      if (a[0] === 'git') {
        const sub = a.includes('--show-toplevel') ? 'toplevel' : a.includes('rev-parse') ? 'rev-parse' : a.includes('ls-files') ? 'ls-files' : a.includes('--name-only') ? 'diff-names' : 'diff'
        return answers[sub]!(a)
      }
      const key = `${a[1]} ${a[2]}`
      const f = answers[key]
      if (!f) throw new Error(`unexpected herdr call ${key}`)
      return f(a)
    },
  }
  return host
}

const review = (taskId: string) => JSON.stringify({ taskId, summary: 'one bug', findings: [{ file: 'src/a.ts', line: 4, severity: 'high', title: 'off by one', evidence: '<= length', confidence: 'high' }], reviewed: ['src/a.ts'], notReviewed: [], limitations: '' })

const matched = (taskId: string, exit = 0) => () => ok({ matched_line: `HERDR-DELEGATE-END ${taskId} exit=${exit}` })

const outPath = (dir: string) => `${dir}\\out.json`

async function started(host: Fake, now = 1000) {
  const state = newState()
  const job = await startJob(host, state, CFG, { task: 'find bugs', toolUseId: 'toolu_1' }, now)
  return { state, job }
}

describe('startJob', () => {
  it('writes prompt, schema and runner outside the repo, excludes secrets, names untracked only', async () => {
    const host = fakeHost()
    const { job } = await started(host)
    assert.equal(job.status, 'queued')
    assert.ok(job.dir.startsWith('C:\\tmp\\herdr-hud\\rev-'))
    assert.deepEqual(job.snapshot.files, ['src/a.ts'])
    assert.deepEqual(job.snapshot.excluded, ['.env', 'certs/server.pem'])
    assert.deepEqual(job.snapshot.untracked, ['notes.txt'])
    const diffCall = host.argvs.find(a => a[0] === 'git' && a.includes('--no-color'))!
    assert.ok(!diffCall.includes('.env'))
    const prompt = host.files.get(`${job.dir}\\prompt.txt`)!
    assert.ok(prompt.includes('find bugs') && prompt.includes(job.taskId) && prompt.includes('+bug'))
    const runner = host.files.get(`${job.dir}\\run.cmd`)!
    assert.ok(runner.includes('--sandbox read-only') && runner.includes('call codex exec') && runner.includes(`HERDR-DELEGATE-END ${job.taskId} exit=`))
    assert.ok(!runner.includes('dangerously'))
    assert.ok(host.argvs.every(a => a[0] === 'git'), 'nothing in Herdr is touched at start')
  })
  it('shell text in the task cannot escape: the task lives only in the prompt file', async () => {
    const host = fakeHost()
    const state = newState()
    const job = await startJob(host, state, CFG, { task: 'say "hi" & echo pwned \n `whoami`', toolUseId: 't' }, 1)
    assert.ok(!host.files.get(`${job.dir}\\run.cmd`)!.includes('whoami'))
    assert.ok(host.files.get(`${job.dir}\\prompt.txt`)!.includes('`whoami`'))
  })
  it('git runs with literal pathspecs from the repo root; codex is pointed at the root', async () => {
    const host = fakeHost({ 'diff-names': () => text('src/*\n') })
    const { job } = await started(host)
    const gits = host.argvs.filter(a => a[0] === 'git')
    assert.ok(gits.every(a => a.includes('--literal-pathspecs')), 'every git call is literal')
    const diffCall = gits.find(a => a.includes('--no-color'))!
    assert.deepEqual(diffCall.slice(-2), ['--', 'src/*'])
    assert.ok(host.files.get(`${job.dir}\\run.cmd`)!.includes('-C "C:/work/repo"'))
  })
  it('from a subdirectory, git runs in the top level, not the session cwd', async () => {
    const cwds: unknown[] = []
    const host = fakeHost()
    host.cwd = async () => 'C:\\work\\repo\\sub'
    const run = host.run
    host.run = (argv, init) => {
      if (argv[0] === 'git' && !argv.includes('--show-toplevel')) cwds.push(init?.cwd)
      return run(argv, init)
    }
    await started(host)
    assert.ok(cwds.length > 0 && cwds.every(c => c === 'C:/work/repo'), JSON.stringify(cwds))
  })
  it('posix: paths go in single quotes, so $() and backticks in them stay text', async () => {
    const host = fakeHost({ toplevel: () => text('/home/u/$(id)/repo\n') })
    host.windows = false
    host.tmp = '/tmp/`x`'
    const { job } = await started(host)
    const sh = host.files.get(`${job.dir}/run.sh`)!
    assert.ok(sh.includes("-C '/home/u/$(id)/repo'") && sh.includes("'/tmp/`x`/herdr-hud/"), sh)
    assert.ok(!/"[^"]*\$\(/.test(sh), 'nothing with $( sits in double quotes')
    host.tmp = "/tmp/it's"
    await assert.rejects(started(host), /cannot quote/)
  })
  it('the hash covers the whole diff: an edit past the cut is stale', async () => {
    const big = `+${'a'.repeat(DIFF_MAX)}\n+tail\n`
    const host = fakeHost({}, big)
    const { state, job } = await started(host)
    assert.equal(job.snapshot.truncated, true)
    job.status = 'completed'
    host.answers.diff = () => text(big.replace('+tail', '+edited'))
    assert.equal((await collect(host, state, job.taskId, 2))!.stale, true)
  })
  it('refuses when the tree is not a git repo', async () => {
    const host = fakeHost({ 'rev-parse': () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }) })
    await assert.rejects(started(host), /not a git repository/)
  })
})

describe('admit', () => {
  it('one job at a time, the same call again is the same job, and a session cap', async () => {
    const host = fakeHost()
    const { state, job } = await started(host)
    assert.deepEqual(admit(state, CFG, 'toolu_1'), { kind: 'existing', job })
    assert.equal(admit(state, CFG, 'toolu_2').kind, 'deny')
    job.status = 'completed'
    assert.equal(admit(state, CFG, 'toolu_2').kind, 'ok')
    state.calls = 2
    assert.match((admit(state, CFG, 'toolu_3') as { reason: string }).reason, /limit/)
  })
  it('a second call admitted while the first is still starting is refused', async () => {
    const host = fakeHost()
    const state = newState()
    const first = startJob(host, state, CFG, { task: 'a', toolUseId: 'toolu_1' }, 1)
    assert.equal(admit(state, CFG, 'toolu_2').kind, 'deny')
    await assert.rejects(startJob(host, state, CFG, { task: 'b', toolUseId: 'toolu_2' }, 2), /starting a review/)
    await first
    assert.equal(state.calls, 1)
    assert.equal(state.pending, false)
  })
})

describe('tick', () => {
  it('queued: splits an unfocused marked pane, takes the pane id from the answer, runs the launcher', async () => {
    const host = fakeHost()
    const { state, job } = await started(host)
    assert.equal(await tick(host, state, 2000), true)
    assert.equal(job.status, 'starting')
    assert.equal(job.paneId, 'w1:p7')
    const split = host.argvs.find(a => a[1] === 'pane' && a[2] === 'split')!
    assert.ok(split.includes('--no-focus') && split.includes('HERDR_HUD_DELEGATE_WORKER=1') && split.includes('--current'))
    const info = host.argvs.find(a => a[2] === 'process-info')
    assert.ok(!info || info[3] === '--pane', 'process-info takes --pane')
    const run = host.argvs.find(a => a[1] === 'pane' && a[2] === 'run')!
    assert.equal(run[3], 'w1:p7')
    assert.ok(run[4]!.startsWith('cmd /c "C:\\tmp\\herdr-hud\\'))
  })
  it('reuses its own idle pane, never one that hosts an agent or a foreground process', async () => {
    const host = fakeHost()
    const { state } = await started(host)
    await tick(host, state, 2000)
    state.job!.status = 'completed'
    await startJob(host, state, CFG, { task: 'again', toolUseId: 'toolu_2' }, 3000)
    await tick(host, state, 4000)
    assert.equal(host.argvs.filter(a => a[2] === 'split').length, 1, 'idle own pane reused')
    state.job!.status = 'completed'
    host.answers['pane get'] = () => ok({ pane: { pane_id: 'w1:p7', agent: 'claude' } })
    state.calls = 0
    await startJob(host, state, CFG, { task: 'third', toolUseId: 'toolu_3' }, 5000)
    await tick(host, state, 6000)
    assert.equal(host.argvs.filter(a => a[2] === 'split').length, 2, 'a pane with an agent is not reused')
  })
  it('herdr down while queued: failed with the reason, nothing re-sent', async () => {
    const host = fakeHost({ 'pane split': () => herdrError('connect_failed', 'no server socket') })
    const { state, job } = await started(host)
    await tick(host, state, 2000)
    assert.equal(job.status, 'failed')
    assert.match(job.reason!, /no server socket/)
    await tick(host, state, 4000)
    assert.equal(host.argvs.filter(a => a[2] === 'split').length, 1)
  })
  it('starting: a foreground process means running; nothing for 30 s means needs attention', async () => {
    const host = fakeHost()
    const { state, job } = await started(host)
    await tick(host, state, 2000)
    await tick(host, state, 4000)
    assert.equal(job.status, 'starting')
    await tick(host, state, 2000 + STARTUP_TIMEOUT_MS + 1)
    assert.equal(job.status, 'needs_attention')
    assert.ok(host.argvs.every(a => a[2] !== 'send-keys'), 'no keys are ever pressed')
    const host2 = fakeHost({ 'pane process-info': () => ok({ process_info: { shell_pid: 1, foreground_processes: [{ pid: 1, name: 'powershell.exe' }, { pid: 2, name: 'codex.exe' }] } }) })
    const s2 = await started(host2)
    await tick(host2, s2.state, 2000)
    await tick(host2, s2.state, 4000)
    assert.equal(s2.job.status, 'running')
  })
  it('running: the marker plus a valid file for this task completes with findings', async () => {
    const host = fakeHost()
    const { state, job } = await started(host)
    await tick(host, state, 2000)
    job.status = 'running'
    host.files.set(outPath(job.dir), review(job.taskId))
    host.answers['pane wait-output'] = matched(job.taskId)
    await tick(host, state, 5000)
    assert.equal(job.status, 'completed')
    assert.equal(job.exitCode, 0)
    assert.equal(job.review!.findings.length, 1)
  })
  it('marker but a file for another task, or truncated JSON, or no file: failed, never completed', async () => {
    for (const body of [review('rev-00000000'), review('x').slice(0, 30), undefined]) {
      const host = fakeHost()
      const { state, job } = await started(host)
      await tick(host, state, 2000)
      job.status = 'running'
      if (body !== undefined) host.files.set(outPath(job.dir), body)
      host.answers['pane wait-output'] = matched(job.taskId, 1)
      await tick(host, state, 5000)
      assert.equal(job.status, 'failed', String(body))
      assert.equal(job.review, undefined)
    }
  })
  it('deadline passed: timed_out, the worker untouched, later ticks change nothing', async () => {
    const host = fakeHost()
    const { state, job } = await started(host, 1000)
    await tick(host, state, 2000)
    job.status = 'running'
    await tick(host, state, 1000 + CFG.timeoutMs + 1)
    assert.equal(job.status, 'timed_out')
    const runs = host.argvs.length
    await tick(host, state, 1000 + CFG.timeoutMs + 5000)
    assert.equal(host.argvs.length, runs)
    assert.ok(host.argvs.every(a => a[2] !== 'close' && a[2] !== 'send-keys'))
  })
  it('a late answer for an earlier job does not touch the new one', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const host = fakeHost({ 'pane split': async () => (await gate, ok({ pane: { pane_id: 'w1:p7' } })) })
    const { state } = await started(host)
    const slow = tick(host, state, 2000)
    state.job!.status = 'failed'
    const second = await startJob(host, state, CFG, { task: 'new', toolUseId: 'toolu_2' }, 3000)
    release()
    assert.equal(await slow, false)
    assert.equal(second.status, 'queued')
    assert.equal(second.paneId, undefined)
  })
})

describe('collect', () => {
  it('unknown task is undefined; a completed review is stale once the tree changes', async () => {
    const host = fakeHost()
    const { state, job } = await started(host)
    assert.equal(await collect(host, state, 'rev-ffffffff', 1), undefined)
    job.status = 'completed'
    job.review = { taskId: job.taskId, summary: 's', findings: [], reviewed: [], notReviewed: [], limitations: '' }
    const fresh = await collect(host, state, job.taskId, 2)
    assert.equal(fresh!.stale, false)
    assert.equal(fresh!.testsRun, false)
    host.answers.diff = () => text('--- a\n+++ b\n+edited again\n')
    assert.equal((await collect(host, state, job.taskId, 3))!.stale, true)
  })
})