import type { Effort, LogKind } from '../types'

export const LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const LEVEL_LABEL: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
}

export const LEVEL_COLOR: Record<Effort, string> = {
  low: 'suggestion',
  medium: 'success',
  high: 'warning',
  xhigh: 'claude',
  max: 'error',
}

export const KIND_COLOR: Record<LogKind, string> = {
  prompt: 'claude',
  tool: 'suggestion',
  error: 'error',
  agent: 'merged',
  turn: 'success',
  notify: 'warning',
  system: 'subtle',
}

export const KIND_LABEL: Record<LogKind, string> = {
  prompt: 'PROMPT',
  tool: 'TOOL',
  error: 'ERROR',
  agent: 'AGENT',
  turn: 'TURN',
  notify: 'NOTIFY',
  system: 'SYSTEM',
}

export const PALETTE = ['claude', 'suggestion', 'merged', 'success', 'warning', 'autoAccept', 'planMode', 'ide'] as const

export const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const
const RISE = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value)
}

export function stepEffort(current: Effort, dir: 1 | -1): Effort {
  const at = LEVELS.indexOf(current)
  return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, at + dir))] ?? current
}

export function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function fmtClock(at: number): string {
  const d = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

export function fmtUsd(usd: number | null): string {
  if (usd === null) return '—'
  return usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

export function pad(text: string, width: number): string {
  const cut = clip(text, width)
  return cut + ' '.repeat(Math.max(0, width - cut.length))
}

/** A horizontal bar split in the filled part and the track, so each is colored apart. */
export function bar(frac: number, width: number): { fill: string; track: string } {
  const w = Math.max(1, width)
  const eighths = Math.round(Math.max(0, Math.min(1, frac)) * w * 8)
  const full = Math.floor(eighths / 8)
  const part = EIGHTHS[eighths % 8] ?? ''
  const fill = '█'.repeat(full) + part
  return { fill, track: '░'.repeat(Math.max(0, w - full - (part ? 1 : 0))) }
}

export function spark(values: readonly number[], width: number): string {
  const vals = values.slice(-width)
  const max = Math.max(1, ...vals)
  return vals.map(v => RISE[Math.max(v > 0 ? 1 : 0, Math.round((v / max) * 8))] ?? ' ').join('')
}

/** Column chart cells, top row first: each row a char per value. */
export function columns(values: readonly number[], height: number): string[][] {
  const max = Math.max(1, ...values)
  const rows: string[][] = []
  for (let r = 0; r < height; r += 1) {
    const floor = (height - 1 - r) * 8
    rows.push(
      values.map(v => {
        const level = Math.round((v / max) * height * 8) - floor
        if (v > 0 && r === height - 1 && level < 1) return '▁'
        return RISE[Math.max(0, Math.min(8, level))] ?? ' '
      }),
    )
  }
  return rows
}

const DETAIL_KEYS = [
  'command',
  'file_path',
  'notebook_path',
  'pattern',
  'url',
  'query',
  'description',
  'skill',
  'path',
  'prompt',
] as const

export function detailOf(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const record = input as Record<string, unknown>
  for (const key of DETAIL_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return clip(oneLine(value), 160)
  }
  return ''
}

export function colorFor(index: number): string {
  return PALETTE[index % PALETTE.length] ?? 'claude'
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '')
}
