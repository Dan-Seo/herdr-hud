// Lays the HUD out as plain lines for a given width and row budget. Pure; the hook turns it into JSX.
import type { AgentStatus, HerdrState } from '../herdr/client.ts'

export const SYMBOL: Record<AgentStatus, string> = {
  working: '●',
  idle: '○',
  done: '✓',
  blocked: '!',
  unknown: '?',
}

/** Colour names the terminal surface takes; the symbol carries the meaning, the colour only helps. */
export const COLOR: Record<AgentStatus, string> = {
  working: 'green',
  idle: 'gray',
  done: 'cyan',
  blocked: 'yellow',
  unknown: 'gray',
}

export type HudLine = { text: string; color?: string; dim?: boolean; bold?: boolean }

export type HudView = { lines: HudLine[] }

const TITLE = 'HERDR'
const NAME_MAX = 20
const KIND_MAX = 8

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const fit = (s: string, width: number) => (s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s)

/**
 * The HUD as lines: a title row, then one row per agent, cut to `maxRows` with a `+ N more` row.
 * Rows never exceed `columns` cells; when too narrow for it, the kind column is dropped.
 */
export function hudView(state: HerdrState, size: { columns: number; maxRows: number }): HudView {
  const columns = Math.max(8, size.columns)
  const rows = Math.max(2, size.maxRows)
  const title: HudLine = { text: TITLE, bold: true, dim: true }

  if (!state.connected) {
    return { lines: [title, { text: fit(`○ not connected · ${state.reason}`, columns), dim: true }] }
  }
  if (state.agents.length === 0) {
    return { lines: [title, { text: '○ no agents', dim: true }] }
  }

  const budget = rows - 1
  const shown = state.agents.length > budget ? state.agents.slice(0, Math.max(1, budget - 1)) : state.agents
  const hidden = state.agents.length - shown.length

  const nameW = Math.min(NAME_MAX, Math.max(4, ...shown.map(a => a.name.length)))
  const kindW = Math.min(KIND_MAX, Math.max(5, ...shown.map(a => a.kind.length)))
  const withKind = columns >= 2 + nameW + 1 + kindW + 1 + 7

  const lines: HudLine[] = [title]
  for (const a of shown) {
    const name = fit(a.name, nameW).padEnd(nameW)
    const cells = withKind
      ? `${SYMBOL[a.status]} ${name} ${fit(capitalize(a.kind), kindW).padEnd(kindW)} ${a.status}`
      : `${SYMBOL[a.status]} ${name} ${a.status}`
    lines.push({ text: fit(cells, columns), color: COLOR[a.status], bold: a.status === 'blocked' })
  }
  if (hidden > 0) lines.push({ text: `+ ${hidden} more`, dim: true })
  return { lines }
}
