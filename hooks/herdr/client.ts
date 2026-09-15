// Reads `herdr agent list` (JSON over Herdr's socket API, via the CLI) into HerdrState.
// Pure: the hook hands in the process result; nothing here runs a command.

/** Herdr's agent lifecycle states (herdr api schema, AgentStatus). */
export type AgentStatus = 'working' | 'idle' | 'blocked' | 'done' | 'unknown'

export type HerdrAgent = {
  /** The live agent name, else the pane's stripped title, else the pane id. */
  name: string
  /** The agent kind as Herdr reports it: `claude`, `codex`, `gemini`, ... */
  kind: string
  status: AgentStatus
  paneId: string
  focused: boolean
}

export type HerdrState = { connected: true; agents: HerdrAgent[] } | { connected: false; reason: string }

/** The command the HUD polls. `agent list` prints JSON on stdout; a down server is exit 1 with JSON on stderr. */
export const AGENT_LIST_ARGV = ['herdr', 'agent', 'list'] as const

const STATUSES: readonly string[] = ['working', 'idle', 'blocked', 'done', 'unknown']

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

function agentOf(raw: unknown): HerdrAgent | undefined {
  if (!isRecord(raw)) return undefined
  const paneId = str(raw.pane_id)
  if (!paneId) return undefined
  const status = str(raw.agent_status) ?? 'unknown'
  return {
    name: str(raw.name) ?? str(raw.terminal_title_stripped) ?? paneId,
    kind: str(raw.display_agent) ?? str(raw.agent) ?? 'agent',
    status: (STATUSES.includes(status) ? status : 'unknown') as AgentStatus,
    paneId,
    focused: raw.focused === true,
  }
}

/** Parses the JSON `herdr agent list` prints. Throws on anything but `{ result: { agents: [...] } }`. */
export function parseAgentList(stdout: string): HerdrAgent[] {
  const doc: unknown = JSON.parse(stdout)
  if (!isRecord(doc) || !isRecord(doc.result) || !Array.isArray(doc.result.agents)) {
    throw new Error('unexpected shape: no result.agents')
  }
  return doc.result.agents.flatMap(a => agentOf(a) ?? [])
}

/** One-line reason from Herdr's stderr (JSON `{ error: { message } }` or plain text). */
function reasonOf(stderr: string, exitCode: number): string {
  try {
    const doc: unknown = JSON.parse(stderr)
    if (isRecord(doc) && isRecord(doc.error)) {
      const message = str(doc.error.message)
      if (message) return message
    }
  } catch {
    // not JSON: fall through to the raw text
  }
  const line = stderr.trim().split('\n')[0]
  return line || `herdr exited ${exitCode}`
}

/** The HUD's state from one run of AGENT_LIST_ARGV. Never throws. */
export function stateOf(run: { exitCode: number; stdout: string; stderr: string }): HerdrState {
  if (run.exitCode !== 0) return { connected: false, reason: reasonOf(run.stderr, run.exitCode) }
  try {
    return { connected: true, agents: parseAgentList(run.stdout) }
  } catch (err) {
    return { connected: false, reason: `bad response: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** A string equal for two states that draw the same, so an unchanged poll skips the redraw. */
export const keyOf = (state: HerdrState): string =>
  state.connected
    ? state.agents.map(a => `${a.paneId}|${a.name}|${a.kind}|${a.status}|${a.focused ? 1 : 0}`).join('\n')
    : `off|${state.reason}`
