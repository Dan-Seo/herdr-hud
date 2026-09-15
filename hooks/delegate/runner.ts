// Runs a delegate job: the git snapshot, the task files, the plugin-owned Herdr pane, the poll tick
// that watches for the end marker, and the collect step. Nothing here touches `$`: the engine follows `$`
// only inside the hooks module, so register.tsx hands in a Host built from literal `$` calls.
import { buildPrompt, DIFF_MAX, endMarker, exitCodeOf, isSecretPath, isTerminal, OUTPUT_SCHEMA, toolResult, validateReview, type Job, type Snapshot } from './job.ts'

/** The slice of the engine the runner uses, built in register.tsx (`$` cannot cross an import). */
export type Host = {
  run: (argv: readonly string[], init?: { cwd?: string; timeoutMs?: number }) => Promise<Run>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  cwd: () => Promise<string>
  windows: boolean
  /** The temp directory the task files go under; never inside the repository. */
  tmp: string
}

export type DelegateConfig = {
  enabled: boolean
  /** Calls to herdr_delegate allowed per session. */
  maxCalls: number
  /** The whole job's deadline, from the call to a validated result. */
  timeoutMs: number
  /** Passed to `codex exec -m` when set; empty means Codex's own default. */
  model: string
}

/** The pane this plugin split for its worker; never a pane the user made. */
export type Worker = { paneId: string; createdAt: number; lastSeen: number }

export type Run = { exitCode: number; stdout: string; stderr: string }

export type DelegateState = {
  job?: Job
  calls: number
  worker?: Worker
  /** Bumped when a job starts, so a late tick for an earlier job changes nothing. */
  generation: number
  /** Set synchronously when startJob begins, so a second call admitted during its awaits is refused. */
  pending: boolean
}

export const newState = (): DelegateState => ({ calls: 0, generation: 0, pending: false })

// Timeouts, kept apart on purpose: the tool.call hook has a ~10 s budget (measured), so every
// call made inside one stays short; the tick runs from a timer and may take a little longer.
const GIT_TIMEOUT_MS = 4000
const HERDR_QUERY_TIMEOUT_MS = 3000
const HERDR_SPLIT_TIMEOUT_MS = 6000
const WAIT_OUTPUT_MS = 1500
const WAIT_OUTPUT_PROCESS_MS = WAIT_OUTPUT_MS + 3000
/** From `pane run` to a codex process in the pane's foreground (or the marker), else needs attention. */
export const STARTUP_TIMEOUT_MS = 30_000
export const TIMEOUT_MAX_MS = 1_800_000
export const TIMEOUT_MIN_MS = 60_000

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** One herdr command's `result`, or a thrown reason (server down, error JSON, bad shape). */
async function herdr(host: Host, argv: readonly string[], timeoutMs: number): Promise<Record<string, unknown>> {
  const run: Run = await host.run(['herdr', ...argv], { timeoutMs })
  if (run.exitCode !== 0) {
    let reason = run.stderr.trim().split('\n')[0] || `herdr exited ${run.exitCode}`
    try {
      const doc: unknown = JSON.parse(run.stderr)
      if (isRecord(doc) && isRecord(doc.error) && typeof doc.error.message === 'string') reason = `${doc.error.code ?? 'error'}: ${doc.error.message}`
    } catch {
      // plain text stderr
    }
    throw new Error(reason)
  }
  // `pane run` answers exit 0 with nothing on stdout; every query answers `{ result }`
  if (run.stdout.trim() === '') return {}
  const doc: unknown = JSON.parse(run.stdout)
  if (!isRecord(doc) || !isRecord(doc.result)) throw new Error('unexpected herdr response')
  return doc.result
}

async function git(host: Host, cwd: string, args: string[]): Promise<string> {
  const run = await host.run(['git', '-c', 'core.quotepath=off', '--literal-pathspecs', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })
  if (run.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.trim().split('\n')[0] || run.exitCode}`)
  return run.stdout
}

const lines = (s: string) => s.split('\n').map(l => l.trim()).filter(l => l !== '')

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

/** The repository's top level: `--name-only` answers root-relative paths, so the diff runs from there. */
export const repoRoot = async (host: Host, cwd: string) => (await git(host, cwd, ['rev-parse', '--show-toplevel'])).trim()

/** The tracked changes against HEAD, staged and unstaged, secrets excluded; untracked by name only. `cwd` is the repo root. */
export async function takeSnapshot(host: Host, cwd: string): Promise<Snapshot> {
  const head = (await git(host, cwd, ['rev-parse', 'HEAD'])).trim()
  const changed = lines(await git(host, cwd, ['diff', 'HEAD', '--name-only']))
  const untracked = lines(await git(host, cwd, ['ls-files', '--others', '--exclude-standard'])).filter(p => !isSecretPath(p))
  const excluded = changed.filter(isSecretPath)
  const files = changed.filter(p => !isSecretPath(p))
  let diff = files.length === 0 ? '' : await git(host, cwd, ['diff', 'HEAD', '--no-color', '--', ...files])
  // the hash covers the whole diff, so an edit past the cut still reads as stale
  const hash = await sha256(`${head}\n${diff}`)
  const truncated = diff.length > DIFF_MAX
  if (truncated) diff = `${diff.slice(0, DIFF_MAX)}\n[diff truncated at ${DIFF_MAX} characters]\n`
  return { head, files, excluded, untracked, diff, truncated, hash }
}

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')

/**
 * A path safe to quote in the runner file. cmd: double quotes, so no quote, no newline, no percent
 * (cmd expands it). sh: single quotes, inside which only a single quote is special.
 */
const isQuotable = (p: string, windows: boolean) => p !== '' && !(windows ? /["\r\n%]/ : /['\r\n]/).test(p)

const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/

export type Admission = { kind: 'ok' } | { kind: 'existing'; job: Job } | { kind: 'deny'; reason: string }

/** Whether a herdr_delegate call may start a job now: the same call again answers the job it started. */
export function admit(state: DelegateState, cfg: DelegateConfig, toolUseId: string | undefined): Admission {
  const job = state.job
  if (job && toolUseId !== undefined && toolUseId !== '' && job.toolUseId === toolUseId) return { kind: 'existing', job }
  if (state.pending) return { kind: 'deny', reason: 'another herdr_delegate call is starting a review' }
  if (job && !isTerminal(job.status)) return { kind: 'deny', reason: `task ${job.taskId} is still ${job.status}; collect it or wait for it before starting another` }
  if (state.calls >= cfg.maxCalls) return { kind: 'deny', reason: `this session's limit of ${cfg.maxCalls} reviews is reached (delegateMaxCalls)` }
  return { kind: 'ok' }
}

/**
 * Writes the task's files outside the repository and returns the job, queued. Nothing in Herdr is
 * touched yet: the tick does that, so this stays well inside the tool.call budget.
 */
export async function startJob(host: Host, state: DelegateState, cfg: DelegateConfig, input: { task: string; toolUseId: string }, now: number): Promise<Job> {
  if (state.pending) throw new Error('another herdr_delegate call is starting a review')
  state.pending = true
  try {
    const { windows, tmp } = host
    const root = await repoRoot(host, await host.cwd())
    if (!isQuotable(tmp, windows) || !isQuotable(root, windows)) throw new Error('the temp or repository path holds a character the runner cannot quote')
    if (cfg.model !== '' && !MODEL_RE.test(cfg.model)) throw new Error('delegateCodexModel holds characters Codex model names never do')
    const snapshot = await takeSnapshot(host, root)
    const taskId = `rev-${randomId()}`
    const sep = windows ? '\\' : '/'
    const dir = `${tmp}${sep}herdr-hud${sep}${taskId}`
    const job: Job = { taskId, toolUseId: input.toolUseId, kind: 'codex', task: input.task, status: 'queued', startedAt: now, deadlineAt: now + cfg.timeoutMs, snapshot, dir }
    const model = cfg.model === '' ? '' : ` -m ${cfg.model}`
    const q = windows ? '"' : "'"
    const codex = `codex exec --sandbox read-only --color never -C ${q}${root}${q} --output-schema ${q}${dir}${sep}schema.json${q} -o ${q}${dir}${sep}out.json${q}${model} - < ${q}${dir}${sep}prompt.txt${q}`
    await host.write(`${dir}${sep}prompt.txt`, buildPrompt(job))
    await host.write(`${dir}${sep}schema.json`, JSON.stringify(OUTPUT_SCHEMA))
    // `call`: codex is a .cmd shim on Windows; without it the batch file never reaches the echo
    if (windows) await host.write(`${dir}${sep}run.cmd`, `@echo off\r\ncall ${codex}\r\necho ${endMarker(taskId)}%ERRORLEVEL%\r\n`)
    else await host.write(`${dir}${sep}run.sh`, `${codex}\necho "${endMarker(taskId)}$?"\n`)
    state.job = job
    state.generation++
    state.calls++
    return job
  } finally {
    state.pending = false
  }
}

const launchOf = (job: Job) => (job.dir.includes('\\') ? `cmd /c "${job.dir}\\run.cmd"` : `sh '${job.dir}/run.sh'`)

/**
 * Whether something other than the pane's own shell runs in its foreground. `process-info` lists
 * the idle shell itself (PowerShell on Windows), so only a process with another pid counts.
 */
async function paneBusy(host: Host, paneId: string): Promise<boolean> {
  const info = await herdr(host, ['pane', 'process-info', '--pane', paneId], HERDR_QUERY_TIMEOUT_MS)
  const pi = isRecord(info.process_info) ? info.process_info : undefined
  if (!pi || !Array.isArray(pi.foreground_processes)) throw new Error('process-info answered without foreground_processes')
  return pi.foreground_processes.some(p => isRecord(p) && p.pid !== pi.shell_pid)
}

/** Whether the pane this plugin split is still a shell at its prompt hosting no agent. */
async function workerUsable(host: Host, worker: Worker): Promise<boolean> {
  try {
    const got = await herdr(host, ['pane', 'get', worker.paneId], HERDR_QUERY_TIMEOUT_MS)
    const pane = isRecord(got.pane) ? got.pane : undefined
    if (!pane || pane.pane_id !== worker.paneId || (pane.agent !== null && pane.agent !== undefined)) return false
    return !(await paneBusy(host, worker.paneId))
  } catch {
    return false
  }
}

async function ensureWorker(host: Host, state: DelegateState, cwd: string, now: number): Promise<Worker> {
  if (state.worker && (await workerUsable(host, state.worker))) {
    state.worker.lastSeen = now
    return state.worker
  }
  // a fresh sibling pane below the session's own, unfocused, marked so nothing in it delegates again
  const result = await herdr(host, ['pane', 'split', '--current', '--direction', 'down', '--no-focus', '--cwd', cwd, '--env', 'HERDR_HUD_DELEGATE_WORKER=1'], HERDR_SPLIT_TIMEOUT_MS)
  const paneId = isRecord(result.pane) && typeof result.pane.pane_id === 'string' ? result.pane.pane_id : undefined
  if (!paneId) throw new Error('pane split answered without a pane id')
  state.worker = { paneId, createdAt: now, lastSeen: now }
  return state.worker
}

/** The marker line for this job in the pane, or undefined within the short wait. Throws when the pane is gone. */
async function markerOf(host: Host, job: Job): Promise<string | undefined> {
  const run: Run = await host.run(['herdr', 'pane', 'wait-output', job.paneId!, '--match', endMarker(job.taskId), '--source', 'recent-unwrapped', '--lines', '400', '--timeout', String(WAIT_OUTPUT_MS)], { timeoutMs: WAIT_OUTPUT_PROCESS_MS })
  if (run.exitCode === 0) {
    const doc: unknown = JSON.parse(run.stdout)
    return isRecord(doc) && isRecord(doc.result) && typeof doc.result.matched_line === 'string' ? doc.result.matched_line : undefined
  }
  let code = ''
  try {
    const doc: unknown = JSON.parse(run.stderr)
    if (isRecord(doc) && isRecord(doc.error)) code = String(doc.error.code ?? '')
  } catch {
    // not JSON
  }
  if (code === 'timeout') return undefined
  throw new Error(run.stderr.trim().split('\n')[0] || `herdr exited ${run.exitCode}`)
}

async function finish(host: Host, job: Job, marker: string) {
  job.exitCode = exitCodeOf(marker, job.taskId)
  let text: string
  try {
    text = await host.read(`${job.dir}${job.dir.includes('\\') ? '\\' : '/'}out.json`)
  } catch {
    job.status = 'failed'
    job.reason = `codex exited ${job.exitCode ?? '?'} and wrote no output file`
    return
  }
  const v = validateReview(text, job.taskId)
  if (v.ok) {
    job.status = 'completed'
    job.review = v.review
  } else {
    job.status = 'failed'
    job.reason = `result_unavailable: ${v.reason}`
  }
}

/**
 * One step of the running job, from the timer. Each call makes at most a couple of short Herdr
 * calls. A step that throws marks the job failed with the reason; nothing is ever re-sent.
 */
export async function tick(host: Host, state: DelegateState, now: number): Promise<boolean> {
  const job = state.job
  if (!job || isTerminal(job.status)) return false
  const gen = state.generation
  const before = `${job.status}|${job.reason ?? ''}`
  try {
    if (job.status === 'queued') {
      const worker = await ensureWorker(host, state, await host.cwd(), now)
      if (state.generation !== gen) return false
      job.paneId = worker.paneId
      await herdr(host, ['pane', 'run', worker.paneId, launchOf(job)], HERDR_QUERY_TIMEOUT_MS)
      job.status = 'starting'
      job.startedAt = now
    } else if (job.status === 'starting') {
      const marker = await markerOf(host, job)
      if (state.generation !== gen) return false
      if (marker) await finish(host, job, marker)
      else {
        if (await paneBusy(host, job.paneId!)) job.status = 'running'
        else if (now - job.startedAt > STARTUP_TIMEOUT_MS) {
          job.status = 'needs_attention'
          job.reason = 'the worker pane shows no running process and no result; look at the pane'
        }
      }
    } else if (job.status === 'running') {
      const marker = await markerOf(host, job)
      if (state.generation !== gen) return false
      if (marker) await finish(host, job, marker)
      else if (now > job.deadlineAt) {
        job.status = 'timed_out'
        job.reason = 'the review deadline passed without a result; the worker was not stopped and may still be running'
      }
    }
  } catch (err) {
    if (state.generation !== gen) return false
    job.status = 'failed'
    job.reason = messageOf(err)
  }
  return `${job.status}|${job.reason ?? ''}` !== before
}

/** The job's state for the model; a completed review is checked against the tree as it is now. */
export async function collect(host: Host, state: DelegateState, taskId: string, now: number): Promise<Record<string, unknown> | undefined> {
  const job = state.job
  if (!job || job.taskId !== taskId) return undefined
  if (job.status === 'completed') {
    try {
      job.stale = (await takeSnapshot(host, await repoRoot(host, await host.cwd()))).hash !== job.snapshot.hash
    } catch {
      job.stale = true
    }
  }
  return toolResult(job, now)
}

/** Job as the HUD draws it. */
export function hudJob(state: DelegateState, now: number): { status: Job['status']; text: string; paneId?: string } | undefined {
  const job = state.job
  if (!job) return undefined
  const elapsed = `${Math.max(0, Math.round((now - job.startedAt) / 1000))}s`
  const text =
    job.status === 'completed'
      ? `review · completed · ${job.review?.findings.length ?? 0} findings`
      : job.status === 'failed'
        ? 'review · failed · job'
        : job.status === 'timed_out'
          ? 'review · timed out · [Focus]'
          : job.status === 'needs_attention'
            ? 'review · needs attention · [Focus]'
            : `review · ${job.status} · ${elapsed}`
  return { status: job.status, text, paneId: job.paneId }
}