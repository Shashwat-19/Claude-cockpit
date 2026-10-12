import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderChildren } from 'claude-code'

import type {
  AgentRec,
  AgentStatusKind,
  Effort,
  EffortState,
  GitSnap,
  LogEntry,
  LogFilter,
  LogKind,
  MainStatus,
  NotifyMode,
  CockpitSettings,
  Tab,
  TermLine,
  TermState,
  TurnRec,
  UsageSnap,
  ViewState,
} from '../types'
import {
  KIND_COLOR,
  KIND_LABEL,
  LEVELS,
  LEVEL_COLOR,
  LEVEL_LABEL,
  SPIN,
  bar,
  clip,
  colorFor,
  columns,
  detailOf,
  fmtClock,
  fmtDur,
  fmtTok,
  fmtUsd,
  isEffort,
  pad,
  spark,
  stepEffort,
  stripAnsi,
} from './lib'

type $ = EngineInterface

// ══ state ══

const PANE = 'cockpit'

const DEFAULT_SETTINGS: CockpitSettings = {
  notifyMain: 'both',
  notifySub: 'toast',
  notifyErrors: true,
  minSeconds: 10,
  subModel: 'inherit',
  subEffort: 'inherit',
  subBackground: false,
  presets: { reviewer: true, tester: true, scout: true },
  showBand: true,
  showStatus: true,
}

const MAIN: MainStatus = {
  phase: 'idle',
  startedAt: 0,
  endedAt: 0,
  tools: 0,
  errors: 0,
  turns: 0,
  activity: null,
  model: '',
  hits: [],
}

const USAGE: UsageSnap = {
  startedAt: 0,
  contextPct: null,
  contextTokens: null,
  window: 0,
  costUsd: null,
  limits: [],
}

const EFFORT: EffortState = { override: null, base: null, configKey: null }

const GIT: GitSnap = { at: 0, branch: '', ahead: 0, behind: 0, changed: 0, graph: [], error: null }

const TERM: TermState = { cwd: '', running: false, lines: [] }

const VIEW: ViewState = { tab: 'overview', logFilter: 'all', expanded: null, logPage: 0, agentSel: null }

const mainA = atom({ plugin: 'cockpit', key: 'main' } as const, MAIN)
const agentsA = atom({ plugin: 'cockpit', key: 'agents' } as const, [])
const turnsA = atom({ plugin: 'cockpit', key: 'turns' } as const, [])
const usageA = atom({ plugin: 'cockpit', key: 'usage' } as const, USAGE)
const logsA = atom({ plugin: 'cockpit', key: 'logs' } as const, [])
const effortA = atom({ plugin: 'cockpit', key: 'effort' } as const, EFFORT)
const settingsA = atom({ plugin: 'cockpit', key: 'settings' } as const, DEFAULT_SETTINGS)
const gitA = atom({ plugin: 'cockpit', key: 'git' } as const, GIT)
const termA = atom({ plugin: 'cockpit', key: 'term' } as const, TERM)
const viewA = atom({ plugin: 'cockpit', key: 'view' } as const, VIEW)
const nowA = atom({ plugin: 'cockpit', key: 'now' } as const, 0)

// ══ actions ══

// ── session log ──────────────────────────────────────────────────────────────

async function log(
  $: $,
  kind: LogKind,
  agent: string | null,
  title: string,
  detail = '',
): Promise<void> {
  const at = await $.clock.now()
  let who = 'main'
  if (agent !== null) {
    const rec = (await read($, agentsA)).find(one => one.id === agent)
    who = rec?.type ?? 'agent'
  }
  await update($, logsA, list => {
    const id = (list.at(-1)?.id ?? 0) + 1
    const entry = { id, at, kind, agent, who, title: clip(title, 160), detail: clip(detail, 800) }
    return [...list, entry].slice(-600)
  })
}

// ── notifications ────────────────────────────────────────────────────────────

async function notify($: $, mode: NotifyMode, title: string, body: string): Promise<void> {
  if (mode === 'off') return
  let isShown = false
  if (mode === 'native' || mode === 'both') {
    try {
      isShown = (await $.ui.notify(body, { title })).isSent
    } catch {
      isShown = false
    }
  }
  if (mode === 'toast' || mode === 'both' || !isShown) {
    $.ui.toast(`${title} · ${body}`, { timeoutMs: 6000 })
  }
  await log($, 'notify', null, title, body)
}

// ── settings ─────────────────────────────────────────────────────────────────

async function patchSettings($: $, patch: Partial<CockpitSettings>): Promise<void> {
  await update($, settingsA, cur => ({ ...cur, ...patch }))
  await $.store.set('settings', await read($, settingsA))
}

async function loadSettings($: $): Promise<void> {
  const saved = await $.store.get('settings')
  if (typeof saved === 'object' && saved !== null) {
    await update($, settingsA, cur => ({ ...cur, ...(saved as Partial<CockpitSettings>) }) as CockpitSettings)
  }
}

// ── pane ─────────────────────────────────────────────────────────────────────

async function openPane($: $, tab?: Tab): Promise<boolean> {
  if (tab !== undefined) await setTab($, tab)
  const opened = await $.ui.open({ id: PANE, title: '✈ Cockpit' })
  return opened.isPlaced
}

async function setTab($: $, tab: Tab): Promise<void> {
  await update($, viewA, v => ({ ...v, tab }))
  if (tab === 'git') void refreshGit($)
}

// ── effort ───────────────────────────────────────────────────────────────────

/** The level in force now: the mod's choice, else what the engine last asked for. */
async function currentEffort($: $): Promise<Effort | null> {
  const eff = await read($, effortA)
  return eff.override ?? eff.base
}

/** Finds a /config row for effort, so changes go through the engine's own setting. */
async function findEffortRow($: $): Promise<void> {
  try {
    const row = (await $.config.list()).find(r => /effort/i.test(r.key) && !r.isLocked)
    if (row === undefined) return
    await update($, effortA, cur => ({
      ...cur,
      configKey: row.key,
      base: isEffort(row.value) ? row.value : cur.base,
    }))
  } catch {
    // no config rows on this host: the mod applies the level per request instead
  }
}

async function setEffort($: $, level: Effort | null, source: string): Promise<Effort | null> {
  const eff = await read($, effortA)
  let isNative = false
  if (eff.configKey !== null && level !== null) {
    try {
      const done = await $.config.set({ key: eff.configKey, value: level })
      isNative = done.deny === undefined
    } catch {
      isNative = false
    }
  }
  await update($, effortA, cur =>
    isNative && level !== null ? { ...cur, base: level, override: null } : { ...cur, override: level },
  )
  const now = await currentEffort($)
  const label = now === null ? 'model default' : LEVEL_LABEL[now]
  $.ui.toast(`⚡ Effort → ${label}`, { timeoutMs: 1800 })
  await log($, 'system', null, `Effort set to ${label}`, source)
  return now
}

async function nudgeEffort($: $, dir: 1 | -1, source: string): Promise<Effort | null> {
  const now = (await currentEffort($)) ?? 'high'
  return setEffort($, stepEffort(now, dir), source)
}

// ── git ──────────────────────────────────────────────────────────────────────

async function refreshGit($: $): Promise<void> {
  const at = await $.clock.now()
  try {
    const status = await $.process.run(['git', 'status', '--porcelain=v2', '--branch'], { timeoutMs: 8000 })
    if (status.exitCode !== 0) {
      await update($, gitA, g => ({ ...g, at, error: clip(status.stderr.trim() || 'Not a git repository', 200), graph: [] }))
      return
    }
    let branch = ''
    let ahead = 0
    let behind = 0
    let changed = 0
    for (const line of status.stdout.split('\n')) {
      if (line.startsWith('# branch.head ')) branch = line.slice(14)
      else if (line.startsWith('# branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(line)
        ahead = Number(m?.[1] ?? 0)
        behind = Number(m?.[2] ?? 0)
      } else if (line !== '' && !line.startsWith('#')) changed += 1
    }
    const graph = await $.process.run(
      [
        'git',
        'log',
        '--graph',
        '--all',
        '--decorate=short',
        '--color=never',
        '--format=%h%x1f%D%x1f%s%x1f%an%x1f%ar',
        '-n',
        '80',
      ],
      { timeoutMs: 8000 },
    )
    await update($, gitA, () => ({
      at,
      branch,
      ahead,
      behind,
      changed,
      graph: graph.stdout.split('\n').filter(l => l !== ''),
      error: graph.exitCode === 0 ? null : clip(graph.stderr.trim(), 200),
    }))
  } catch (err) {
    await update($, gitA, g => ({ ...g, at, error: clip(String(err), 200) }))
  }
}

// ── terminal ─────────────────────────────────────────────────────────────────

let stopRunning: (() => void) | null = null

function pushLines(lines: TermLine[], add: TermLine[]): TermLine[] {
  return [...lines, ...add].slice(-500)
}

async function stopTerminal($: $): Promise<void> {
  stopRunning?.()
  stopRunning = null
  await update($, termA, t => ({ ...t, running: false, lines: pushLines(t.lines, [{ kind: 'info', text: '■ stopped' }]) }))
}

async function runTerminal($: $, raw: string): Promise<void> {
  const cmd = raw.trim()
  if (cmd === '') return
  const term = await read($, termA)
  if (term.running) {
    $.ui.toast('A command is still running: stop it first', { timeoutMs: 2500 })
    return
  }
  if (cmd === 'clear' || cmd === 'cls') {
    await update($, termA, t => ({ ...t, lines: [] }))
    return
  }
  const cwd = term.cwd || (await $.session.cwd())
  await update($, termA, t => ({
    ...t,
    cwd,
    running: true,
    lines: pushLines(t.lines, [{ kind: 'cmd', text: cmd }]),
  }))
  await log($, 'system', null, 'Terminal', cmd)

  const script = `${cmd}\n__cockpit_rc=$?\nprintf '\\n\\037%s' "$PWD"\nexit $__cockpit_rc`
  const stream = $.process.spawn({ argv: ['/bin/zsh', '-c', script], cwd })
  const it = stream[Symbol.asyncIterator]()
  stopRunning = () => void it.return?.(undefined as never)

  void (async () => {
    const carry = { stdout: '', stderr: '' }
    let nextCwd = cwd
    let code: number | null = null
    const flush = async (kind: 'stdout' | 'stderr', isEnd: boolean) => {
      const parts = carry[kind].split('\n')
      carry[kind] = isEnd ? '' : (parts.pop() ?? '')
      const add: TermLine[] = []
      for (const part of parts) {
        const at = part.indexOf('\u001f')
        if (at >= 0) {
          nextCwd = part.slice(at + 1) || nextCwd
          const before = part.slice(0, at)
          if (before !== '') add.push({ kind: kind === 'stdout' ? 'out' : 'err', text: stripAnsi(before) })
          continue
        }
        add.push({ kind: kind === 'stdout' ? 'out' : 'err', text: stripAnsi(part) })
      }
      if (add.length > 0) await update($, termA, t => ({ ...t, lines: pushLines(t.lines, add) }))
    }
    try {
      for (;;) {
        const step = await it.next()
        if (step.done === true) {
          code = step.value.code
          break
        }
        carry[step.value.stream] += step.value.text
        await flush(step.value.stream, false)
      }
    } catch (err) {
      await update($, termA, t => ({ ...t, lines: pushLines(t.lines, [{ kind: 'err', text: String(err) }]) }))
    }
    // Drop the trailing newline printf put before the cwd marker.
    if (carry.stdout.startsWith('\u001f')) {
      nextCwd = carry.stdout.slice(1) || nextCwd
      carry.stdout = ''
    }
    await flush('stdout', true)
    await flush('stderr', true)
    stopRunning = null
    await update($, termA, t => {
      const lines = t.lines.at(-1)?.kind === 'out' && t.lines.at(-1)?.text === '' ? t.lines.slice(0, -1) : t.lines
      const tail: TermLine[] = code !== null && code !== 0 ? [{ kind: 'info', text: `exit ${code}` }] : []
      return { cwd: nextCwd, running: false, lines: pushLines(lines, tail) }
    })
  })()
}

// ── export ───────────────────────────────────────────────────────────────────

async function exportLogs($: $): Promise<string> {
  const home = (await $.env.get('HOME')) ?? '.'
  const id = await $.session.id()
  const path = `${home}/.claude/cockpit-logs/${id}.jsonl`
  const list = await read($, logsA)
  await $.fs.write(path, list.map(entry => JSON.stringify(entry)).join('\n') + '\n')
  return path
}

// ══ views ══

type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'> & {
  Input?: Elements['terminal']['Input']
}

type Data = {
  main: MainStatus
  agents: AgentRec[]
  turns: TurnRec[]
  usage: UsageSnap
  logs: LogEntry[]
  effort: EffortState
  settings: CockpitSettings
  git: GitSnap
  term: TermState
  view: ViewState
  now: number
  width: number
  rows: number
}

const TABS: readonly { tab: Tab; label: string; hotkey: string }[] = [
  { tab: 'overview', label: 'Overview', hotkey: '1' },
  { tab: 'agents', label: 'Agents', hotkey: '2' },
  { tab: 'usage', label: 'Usage', hotkey: '3' },
  { tab: 'git', label: 'Git', hotkey: '4' },
  { tab: 'logs', label: 'Logs', hotkey: '5' },
  { tab: 'terminal', label: 'Terminal', hotkey: '6' },
  { tab: 'settings', label: 'Settings', hotkey: '7' },
]

// ── shared bits ──────────────────────────────────────────────────────────────

function sel(on: boolean): { variant: 'primary' } | { dimColor: true } {
  return on ? { variant: 'primary' } : { dimColor: true }
}

function effortOf(d: Pick<Data, 'effort'>): Effort | null {
  return d.effort.override ?? d.effort.base
}

function tokensOf(turns: readonly TurnRec[]) {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  for (const t of turns) {
    input += t.input
    output += t.output
    cacheRead += t.cacheRead
    cacheWrite += t.cacheWrite
  }
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite }
}

function turnTotal(t: TurnRec): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

function meter(K: Kit, frac: number, width: number, color: string): RenderChildren {
  const { Text } = K
  const b = bar(frac, width)
  return [
    <Text color={color}>{b.fill}</Text>,
    <Text dimColor>{b.track}</Text>,
  ]
}

function mainChip(K: Kit, main: MainStatus, now: number): RenderChildren {
  const { Text } = K
  if (main.phase === 'working') {
    const spin = SPIN[Math.floor(now / 100) % SPIN.length] ?? '•'
    return (
      <Text color="warning" bold>
        {spin} working {fmtDur(now - main.startedAt)}
      </Text>
    )
  }
  if (main.phase === 'done') return <Text color="success" bold>✓ done {fmtDur(main.endedAt - main.startedAt)}</Text>
  if (main.phase === 'aborted') return <Text color="warning" bold>■ interrupted</Text>
  if (main.phase === 'error') return <Text color="error" bold>✗ error</Text>
  return <Text dimColor>◌ idle</Text>
}

function agentGlyph(K: Kit, a: AgentRec, now: number): RenderChildren {
  const { Text } = K
  if (a.status === 'running') return <Text color="warning">{SPIN[Math.floor(now / 100) % SPIN.length] ?? '•'}</Text>
  if (a.status === 'done') return <Text color="success">✓</Text>
  if (a.status === 'aborted') return <Text color="warning">■</Text>
  return <Text color="error">✗</Text>
}

function section(K: Kit, title: string, right?: RenderChildren): RenderChildren {
  const { Box, Text } = K
  return (
    <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
      <Text bold color="claude">
        {title.toUpperCase()}
      </Text>
      {right ?? null}
    </Box>
  )
}

function card(K: Kit, title: string, color: string, width: number, body: RenderChildren): RenderChildren {
  const { Box, Text } = K
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={width}>
      <Text bold color={color}>
        {title}
      </Text>
      {body}
    </Box>
  )
}

function segmented<T extends string>(
  K: Kit,
  key: string,
  options: readonly { value: T; label: string }[],
  current: T,
  onPick: (value: T) => void,
): RenderChildren {
  const { Box, Button } = K
  return (
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      {options.map(o => (
        <Button key={`${key}:${o.value}`} label={o.label} {...sel(o.value === current)} onPress={() => onPick(o.value)} />
      ))}
    </Box>
  )
}

function settingRow(K: Kit, label: string, hint: string, control: RenderChildren): RenderChildren {
  const { Box, Text } = K
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" gap={1}>
        <Text bold>{label}</Text>
        <Text dimColor>{hint}</Text>
      </Box>
      {control}
    </Box>
  )
}

// ── effort control (band, pane, settings) ────────────────────────────────────

function effortControl($: $, K: Kit, d: Pick<Data, 'effort'>, isCompact: boolean): RenderChildren {
  const { Box, Text, Button } = K
  const level = effortOf(d)
  const at = level === null ? -1 : LEVELS.indexOf(level)
  const color = level === null ? 'subtle' : LEVEL_COLOR[level]
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={color} bold>
        ⚡
      </Text>
      <Button key="effort-down" plain action="chat:decreaseEffort" onPress={() => void nudge($, d, -1)}>
        <Text dimColor>◀</Text>
      </Button>
      <Box flexDirection="row">
        {LEVELS.map((lv, i) => (
          <Button key={`effort-${lv}`} plain onPress={() => void setEffort($, lv, 'clicked')}>
            <Text color={i <= at ? LEVEL_COLOR[lv] : 'subtle'} dimColor={i > at}>
              {i <= at ? '▰' : '▱'}
            </Text>
          </Button>
        ))}
      </Box>
      <Button key="effort-up" plain action="chat:increaseEffort" onPress={() => void nudge($, d, 1)}>
        <Text dimColor>▶</Text>
      </Button>
      <Text color={color} bold>
        {level === null ? 'Default' : LEVEL_LABEL[level]}
      </Text>
      {d.effort.override !== null ? <Text dimColor>(this session)</Text> : null}
      {isCompact ? null : <Text dimColor>⌥E up · ⌥⇧E down</Text>}
    </Box>
  )
}

function nudge($: $, d: Pick<Data, 'effort'>, dir: 1 | -1): Promise<unknown> {
  const now = effortOf(d) ?? 'high'
  const at = LEVELS.indexOf(now)
  const next = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, at + dir))] ?? now
  return setEffort($, next, dir > 0 ? '⌥E' : '⌥⇧E')
}

// ── band above the prompt ────────────────────────────────────────────────────

function drawBand($: $, K: Kit, d: Data): RenderChildren {
  const { Box, Text, Button } = K
  const running = d.agents.filter(a => a.status === 'running')
  const done = d.agents.filter(a => a.status === 'done').length
  const tok = tokensOf(d.turns)
  const isWide = d.width >= 110
  const activity = d.main.phase === 'working' ? d.main.activity : null
  return (
    <Box flexDirection="row" justifyContent="space-between" width={d.width}>
      <Box flexDirection="row" gap={1}>
        <Button key="band-open" plain onPress={() => void openFromBand($)}>
          <Text color="claude" bold>
            ✈ Cockpit
          </Text>
        </Button>
        <Text dimColor>│</Text>
        <Text dimColor>main</Text>
        {mainChip(K, d.main, d.now)}
        {activity !== null && isWide ? <Text dimColor>{clip(`${activity.tool} ${activity.detail}`, 28)}</Text> : null}
        <Text dimColor>│</Text>
        <Text dimColor>⑂</Text>
        {running.length > 0 ? (
          <Text color="warning" bold>
            {running.length} running
          </Text>
        ) : (
          <Text dimColor>0 running</Text>
        )}
        <Text color="success">{done} done</Text>
        {isWide ? <Text dimColor>│</Text> : null}
        {isWide ? <Text color="suggestion">Σ {fmtTok(tok.total)}</Text> : null}
        {isWide && d.usage.contextPct !== null ? <Text dimColor>ctx {d.usage.contextPct}%</Text> : null}
      </Box>
      {effortControl($, K, d, !isWide)}
    </Box>
  )
}

async function openFromBand($: $): Promise<void> {
  await $.ui.open({ id: 'cockpit', title: '✈ Cockpit' })
}

// ── the pane ─────────────────────────────────────────────────────────────────

function drawPane($: $, K: Kit, d: Data, surface: string): RenderChildren {
  const { Box, Text, Button } = K
  const tok = tokensOf(d.turns)
  const level = effortOf(d)
  const body = (() => {
    switch (d.view.tab) {
      case 'overview':
        return overview($, K, d)
      case 'agents':
        return agentsTab($, K, d)
      case 'usage':
        return usageTab(K, d)
      case 'git':
        return gitTab($, K, d)
      case 'logs':
        return logsTab($, K, d)
      case 'terminal':
        return terminalTab($, K, d, surface)
      case 'settings':
        return settingsTab($, K, d)
    }
  })()
  return (
    <Box flexDirection="column" width={d.width}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
          <Text color="claude" bold>
            ✈ COCKPIT
          </Text>
          <Text dimColor>{d.main.model || 'model —'}</Text>
          <Text dimColor>·</Text>
          <Text color={level === null ? 'subtle' : LEVEL_COLOR[level]}>⚡ {level === null ? 'default' : LEVEL_LABEL[level]}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Text color="suggestion">Σ {fmtTok(tok.total)}</Text>
          <Text dimColor>·</Text>
          <Text color="success">{fmtUsd(d.usage.costUsd)}</Text>
        </Box>
      </Box>
      <Box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
        {TABS.map(t => (
          <Button
            key={`tab-${t.tab}`}
            label={d.width < 70 ? t.label.slice(0, 4) : t.label}
            hotkey={t.hotkey}
            {...sel(t.tab === d.view.tab)}
            onPress={() => void setTab($, t.tab)}
          />
        ))}
      </Box>
      {body}
    </Box>
  )
}

// ── overview ─────────────────────────────────────────────────────────────────

function overview($: $, K: Kit, d: Data): RenderChildren {
  const { Box, Text } = K
  const perRow = d.width >= 112 ? 4 : d.width >= 56 ? 2 : 1
  const cw = Math.floor((d.width - (perRow - 1)) / perRow)
  const inner = Math.max(8, cw - 4)
  const running = d.agents.filter(a => a.status === 'running')
  const done = d.agents.filter(a => a.status === 'done').length
  const failed = d.agents.filter(a => a.status === 'failed' || a.status === 'aborted').length
  const all = Math.max(1, d.agents.length)
  const tok = tokensOf(d.turns)
  const main = d.main
  const recent = d.logs.slice(-Math.max(4, Math.min(10, d.rows - 22))).reverse()

  const mainCard = card(
    K,
    'MAIN AGENT',
    main.phase === 'working' ? 'warning' : main.phase === 'error' ? 'error' : 'success',
    cw,
    [
      mainChip(K, main, d.now),
      <Text dimColor>
        {main.tools} tools · {main.errors} errors · {main.turns} turns
      </Text>,
      main.activity !== null ? (
        <Text wrap="truncate-end">
          <Text color="suggestion">→ {main.activity.tool}</Text> <Text dimColor>{main.activity.detail}</Text>
        </Text>
      ) : (
        <Text dimColor>{main.phase === 'working' ? 'thinking…' : 'waiting for you'}</Text>
      ),
    ],
  )

  const subCard = card(K, 'SUBAGENTS', running.length > 0 ? 'warning' : 'merged', cw, [
    <Text>
      <Text color="warning" bold>
        {running.length}
      </Text>
      <Text dimColor> running · </Text>
      <Text color="success">{done}</Text>
      <Text dimColor> done · </Text>
      <Text color="error">{failed}</Text>
      <Text dimColor> failed</Text>
    </Text>,
    <Text>
      <Text color="success">{'█'.repeat(Math.round((done / all) * inner))}</Text>
      <Text color="warning">{'█'.repeat(Math.round((running.length / all) * inner))}</Text>
      <Text color="error">{'█'.repeat(Math.round((failed / all) * inner))}</Text>
      <Text dimColor>{d.agents.length === 0 ? '░'.repeat(inner) : ''}</Text>
    </Text>,
    running.length > 0 ? (
      <Text wrap="truncate-end">
        <Text color="merged">{running[0]?.type}</Text>{' '}
        <Text dimColor>{running[0]?.activity ? `${running[0].activity.tool} ${running[0].activity.detail}` : running[0]?.description}</Text>
      </Text>
    ) : (
      <Text dimColor>{d.agents.length === 0 ? 'none spawned yet' : 'all finished'}</Text>
    ),
  ])

  const tokCard = card(K, 'TOKENS', 'suggestion', cw, [
    <Text>
      <Text color="suggestion" bold>
        {fmtTok(tok.total)}
      </Text>
      <Text dimColor> total · </Text>
      <Text color="success">{fmtUsd(d.usage.costUsd)}</Text>
    </Text>,
    <Text dimColor>
      in {fmtTok(tok.input)} · out {fmtTok(tok.output)} · cache {fmtTok(tok.cacheRead + tok.cacheWrite)}
    </Text>,
    <Text color="suggestion">{spark(d.turns.map(turnTotal), inner) || '·'}</Text>,
  ])

  const pct = d.usage.contextPct ?? 0
  const ctxColor = pct >= 85 ? 'error' : pct >= 60 ? 'warning' : 'success'
  const ctxCard = card(K, 'CONTEXT', ctxColor, cw, [
    <Text>
      <Text color={ctxColor} bold>
        {d.usage.contextPct === null ? '—' : `${pct}%`}
      </Text>
      <Text dimColor>
        {' '}
        {d.usage.contextTokens !== null ? `${fmtTok(d.usage.contextTokens)} / ${fmtTok(d.usage.window)}` : 'no reading yet'}
      </Text>
    </Text>,
    <Text>{meter(K, pct / 100, inner, ctxColor)}</Text>,
    d.usage.limits[0] !== undefined ? (
      <Text dimColor>
        {d.usage.limits[0].kind.replace('_', ' ')} limit {d.usage.limits[0].pct}%
      </Text>
    ) : (
      <Text dimColor>rate limits: —</Text>
    ),
  ])

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
        {mainCard}
        {subCard}
        {tokCard}
        {ctxCard}
      </Box>
      {section(K, 'Effort')}
      {effortControl($, K, d, false)}
      {section(K, 'Live activity')}
      {recent.length === 0 ? <Text dimColor>Nothing yet. Send a prompt and watch this fill up.</Text> : null}
      {recent.map(entry => logLine(K, entry, d.width, false))}
    </Box>
  )
}

// ── agents (fleet view) ──────────────────────────────────────────────────────

function ordered(agents: readonly AgentRec[]): { a: AgentRec; depth: number; isLast: boolean }[] {
  const out: { a: AgentRec; depth: number; isLast: boolean }[] = []
  const known = new Set(agents.map(a => a.id))
  const walk = (parent: string | null, depth: number) => {
    const kids = agents.filter(a => (a.parentId !== null && known.has(a.parentId) ? a.parentId : null) === parent)
    kids.forEach((a, i) => {
      out.push({ a, depth, isLast: i === kids.length - 1 })
      walk(a.id, depth + 1)
    })
  }
  walk(null, 0)
  return out
}

function agentsTab($: $, K: Kit, d: Data): RenderChildren {
  const { Box, Text, Button } = K
  const W = d.width
  const rows = ordered(d.agents).slice(-30)
  const colTools = 6
  const colTok = 8
  const colTime = 8
  const colName = Math.max(14, Math.min(26, Math.floor(W * 0.22)))
  const colNow = Math.max(10, W - colName - colTools - colTok - colTime - 8)
  const mainTok = tokensOf(d.turns.filter(t => t.agentId === null))
  const selected = d.agents.find(a => a.id === d.view.agentSel) ?? null

  const header = (
    <Text dimColor>
      {'  '}
      {pad('AGENT', colName)} {pad('NOW', colNow)} {pad('TOOLS', colTools)}
      {pad('TOKENS', colTok)}
      {pad('TIME', colTime)}
    </Text>
  )

  const mainRow = (
    <Text wrap="truncate-end">
      {mainChip(K, d.main, d.now)} <Text bold>main</Text>{' '}
      <Text dimColor>{d.main.activity ? clip(`${d.main.activity.tool} ${d.main.activity.detail}`, colNow + colName - 16) : ''}</Text>
      <Text dimColor>
        {' '}
        · {d.main.tools} tools · {fmtTok(mainTok.input + mainTok.output)} tok
      </Text>
    </Text>
  )

  const fleet = rows.map(({ a, depth, isLast }, i) => {
    const color = colorFor(d.agents.indexOf(a))
    const branch = `${'  '.repeat(depth)}${isLast ? '└─' : '├─'} `
    const now = a.activity ? `${a.activity.tool} ${a.activity.detail}` : a.status === 'running' ? 'thinking…' : a.description
    const time = fmtDur((a.endedAt || d.now) - a.startedAt)
    return (
      <Button key={`agent-${a.id}`} plain onPress={() => void selectAgent($, a.id)}>
        <Text dimColor>{branch}</Text>
        {agentGlyph(K, a, d.now)}
        <Text color={color} bold={a.id === d.view.agentSel}>
          {' '}
          {pad(a.type, Math.max(4, colName - branch.length - 2))}
        </Text>{' '}
        <Text dimColor={a.status !== 'running'}>{pad(now, colNow)}</Text> <Text>{pad(String(a.tools), colTools)}</Text>
        <Text color="suggestion">{pad(fmtTok(a.tokensIn + a.tokensOut), colTok)}</Text>
        <Text dimColor>{pad(time, colTime)}</Text>
        {i < 0 ? null : null}
      </Button>
    )
  })

  return (
    <Box flexDirection="column">
      {section(K, `Fleet · ${d.agents.length} subagents`, <Text dimColor>click a row for details</Text>)}
      {header}
      {mainRow}
      {fleet.length === 0 ? <Text dimColor>  No subagents yet. They appear here, live, as soon as one is spawned.</Text> : fleet}
      {section(K, 'Timeline')}
      {timeline(K, d)}
      {d.agents.length > 0 ? section(K, 'Work by subagent') : null}
      {d.agents.length > 0 ? workCharts(K, d) : null}
      {selected !== null ? agentDetail($, K, d, selected) : null}
    </Box>
  )
}

async function selectAgent($: $, id: string): Promise<void> {
  await update($, viewA, v => ({ ...v, agentSel: v.agentSel === id ? null : id }))
}

function lane(hits: readonly number[], from: number, to: number, start: number, end: number, width: number): string {
  const span = Math.max(1, to - from)
  let out = ''
  for (let i = 0; i < width; i += 1) {
    const a = from + (span * i) / width
    const b = from + (span * (i + 1)) / width
    const isAlive = start <= b && (end === 0 || end >= a)
    const n = hits.filter(t => t >= a && t < b).length
    out += n === 0 ? (isAlive ? '─' : ' ') : n === 1 ? '▪' : n < 4 ? '■' : '█'
  }
  return out
}

function timeline(K: Kit, d: Data): RenderChildren {
  const { Box, Text } = K
  const labelW = 14
  const W = Math.max(10, d.width - labelW - 2)
  const starts = [d.main.startedAt, ...d.agents.map(a => a.startedAt)].filter(t => t > 0)
  const to = d.now
  const from = starts.length === 0 ? to - 60_000 : Math.max(Math.min(...starts) - 1000, to - 30 * 60_000)
  const lanes = [
    {
      label: 'main',
      color: 'claude',
      text: lane(d.main.hits, from, to, d.main.startedAt || to, d.main.phase === 'working' ? 0 : d.main.endedAt || to, W),
    },
    ...d.agents.slice(-8).map(a => ({
      label: a.type,
      color: colorFor(d.agents.indexOf(a)),
      text: lane(a.hits, from, to, a.startedAt, a.endedAt, W),
    })),
  ]
  return (
    <Box flexDirection="column">
      {lanes.map(l => (
        <Text>
          <Text color={l.color}>{pad(l.label, labelW)}</Text> <Text color={l.color}>{l.text}</Text>
        </Text>
      ))}
      <Text dimColor>
        {' '.repeat(labelW + 1)}
        {pad(`◂ ${fmtDur(to - from)} ago`, W - 4)}now ▸
      </Text>
      <Text dimColor>
        {' '.repeat(labelW + 1)}─ alive ▪ 1 tool ■ 2-3 █ 4+ per slot
      </Text>
    </Box>
  )
}

function hbars(K: Kit, title: string, items: { label: string; value: number; color: string; text: string }[], width: number): RenderChildren {
  const { Box, Text } = K
  const labelW = Math.min(14, Math.max(6, ...items.map(i => i.label.length)))
  const barW = Math.max(4, width - labelW - 10)
  const max = Math.max(1, ...items.map(i => i.value))
  return (
    <Box flexDirection="column" width={width}>
      <Text bold>{title}</Text>
      {items.map(i => (
        <Text>
          <Text color={i.color}>{pad(i.label, labelW)}</Text> {meter(K, i.value / max, barW, i.color)} <Text dimColor>{i.text}</Text>
        </Text>
      ))}
    </Box>
  )
}

function workCharts(K: Kit, d: Data): RenderChildren {
  const { Box } = K
  const list = d.agents.slice(-8)
  const perRow = d.width >= 120 ? 3 : d.width >= 80 ? 2 : 1
  const w = Math.floor((d.width - (perRow - 1) * 2) / perRow)
  const item = (a: AgentRec, value: number, text: string) => ({
    label: a.type,
    value,
    color: colorFor(d.agents.indexOf(a)),
    text,
  })
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {hbars(K, 'Tool calls', list.map(a => item(a, a.tools, String(a.tools))), w)}
      {hbars(K, 'Tokens', list.map(a => item(a, a.tokensIn + a.tokensOut, fmtTok(a.tokensIn + a.tokensOut))), w)}
      {hbars(
        K,
        'Duration',
        list.map(a => item(a, (a.endedAt || d.now) - a.startedAt, fmtDur((a.endedAt || d.now) - a.startedAt))),
        w,
      )}
    </Box>
  )
}

function agentDetail($: $, K: Kit, d: Data, a: AgentRec): RenderChildren {
  const { Box, Text, Button } = K
  const color = colorFor(d.agents.indexOf(a))
  const mix = Object.entries(a.toolMix)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 6)
  const recent = d.logs.filter(l => l.agent === a.id).slice(-8).reverse()
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginTop={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text color={color} bold>
            {a.type}
          </Text>
          <Text dimColor> · {a.model || 'model —'} · {a.status} · {a.id.slice(0, 12)}</Text>
        </Text>
        <Button key="agent-close" label="Close" dimColor onPress={() => void selectAgent($, a.id)} />
      </Box>
      <Text wrap="wrap">{a.description}</Text>
      <Text dimColor>
        {a.tools} tools · {a.errors} errors · in {fmtTok(a.tokensIn)} · out {fmtTok(a.tokensOut)} · {fmtDur((a.endedAt || d.now) - a.startedAt)}
      </Text>
      {mix.length > 0
        ? hbars(
            K,
            'Tool mix',
            mix.map(([tool, n]) => ({ label: tool, value: n, color, text: String(n) })),
            Math.min(60, d.width - 4),
          )
        : null}
      {recent.length > 0 ? <Text bold>Recent</Text> : null}
      {recent.map(entry => logLine(K, entry, d.width - 4, false))}
    </Box>
  )
}

// ── usage ────────────────────────────────────────────────────────────────────

function drawUsageChart(K: Kit, d: Pick<Data, 'turns' | 'usage' | 'agents' | 'width'>, height: number): RenderChildren {
  const { Box, Text } = K
  const axisW = 7
  const n = Math.max(1, Math.min(d.turns.length, d.width - axisW - 2))
  const shown = d.turns.slice(-n)
  const values = shown.map(turnTotal)
  const grid = columns(values, height)
  const max = Math.max(0, ...values)
  return (
    <Box flexDirection="column">
      {grid.map((row, r) => (
        <Text>
          <Text dimColor>{pad(r === 0 ? fmtTok(max) : r === height - 1 ? '0' : '', axisW - 1)}┤</Text>
          {row.map((ch, i) => (
            <Text color={shown[i]?.agentId === null ? 'claude' : 'merged'}>{ch}</Text>
          ))}
        </Text>
      ))}
      <Text dimColor>
        {' '.repeat(axisW - 1)}└{'─'.repeat(Math.max(0, shown.length))}
      </Text>
      <Text>
        {' '.repeat(axisW)}
        <Text color="claude">█ main</Text> <Text color="merged">█ subagents</Text>
        <Text dimColor> · last {shown.length} turns</Text>
      </Text>
    </Box>
  )
}

function usageTab(K: Kit, d: Data): RenderChildren {
  const { Box, Text } = K
  const tok = tokensOf(d.turns)
  const mainTok = tokensOf(d.turns.filter(t => t.agentId === null))
  const subTok = tokensOf(d.turns.filter(t => t.agentId !== null))
  const barW = Math.max(10, d.width - 32)
  const byModel = new Map<string, number>()
  for (const t of d.turns) byModel.set(t.model || 'unknown', (byModel.get(t.model || 'unknown') ?? 0) + turnTotal(t))
  const kpi = (label: string, value: string, color: string) => (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} minWidth={14}>
      <Text dimColor>{label}</Text>
      <Text color={color} bold>
        {value}
      </Text>
    </Box>
  )
  const pct = d.usage.contextPct ?? 0
  const ctxColor = pct >= 85 ? 'error' : pct >= 60 ? 'warning' : 'success'
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
        {kpi('Total tokens', fmtTok(tok.total), 'suggestion')}
        {kpi('Input', fmtTok(tok.input), 'claude')}
        {kpi('Output', fmtTok(tok.output), 'merged')}
        {kpi('Cache read', fmtTok(tok.cacheRead), 'success')}
        {kpi('Cache write', fmtTok(tok.cacheWrite), 'warning')}
        {kpi('Cost', fmtUsd(d.usage.costUsd), 'success')}
      </Box>
      {section(K, 'Context window')}
      <Text>
        {meter(K, pct / 100, barW, ctxColor)}{' '}
        <Text color={ctxColor} bold>
          {d.usage.contextPct === null ? '—' : `${pct}%`}
        </Text>
        <Text dimColor>
          {' '}
          {d.usage.contextTokens !== null ? `${fmtTok(d.usage.contextTokens)} of ${fmtTok(d.usage.window)}` : ''}
        </Text>
      </Text>
      {section(K, 'Plan limits')}
      {d.usage.limits.length === 0 ? <Text dimColor>No rate-limit reading yet (shown on subscription plans after the first reply).</Text> : null}
      {d.usage.limits.map(l => {
        const c = l.pct >= 90 ? 'error' : l.pct >= 70 ? 'warning' : 'suggestion'
        return (
          <Text>
            <Text>{pad(l.kind.replace('_', ' '), 12)}</Text> {meter(K, l.pct / 100, barW - 6, c)}{' '}
            <Text color={c} bold>
              {l.pct}%
            </Text>
            <Text dimColor>{l.resetsAt !== null ? ` resets ${l.resetsAt.replace('T', ' ').slice(5, 16)}` : ''}</Text>
          </Text>
        )
      })}
      {section(K, 'Tokens per turn')}
      {d.turns.length === 0 ? <Text dimColor>No finished turns yet.</Text> : drawUsageChart(K, d, 7)}
      {section(K, 'Split')}
      <Text>
        <Text>{pad('main', 12)}</Text> {meter(K, mainTok.total / Math.max(1, tok.total), barW - 6, 'claude')}{' '}
        <Text dimColor>{fmtTok(mainTok.total)}</Text>
      </Text>
      <Text>
        <Text>{pad('subagents', 12)}</Text> {meter(K, subTok.total / Math.max(1, tok.total), barW - 6, 'merged')}{' '}
        <Text dimColor>{fmtTok(subTok.total)}</Text>
      </Text>
      {[...byModel.entries()].map(([model, n], i) => (
        <Text>
          <Text>{pad(model.replace(/^claude-/, ''), 12)}</Text> {meter(K, n / Math.max(1, tok.total), barW - 6, colorFor(i + 1))}{' '}
          <Text dimColor>{fmtTok(n)}</Text>
        </Text>
      ))}
    </Box>
  )
}

// ── git graph ────────────────────────────────────────────────────────────────

function graphLine(K: Kit, line: string, width: number): RenderChildren {
  const { Text } = K
  const at = line.indexOf('\u001f')
  const head = at < 0 ? line : line.slice(0, at)
  const m = /^([*|\\/ _.\-]*?)([0-9a-f]{6,})?$/.exec(head)
  const graph = m?.[1] ?? head
  const hash = m?.[2] ?? ''
  const glyphs = [...graph].map((ch, i) => (
    <Text color={ch === '*' ? 'claude' : colorFor(Math.floor(i / 2) + 1)} bold={ch === '*'}>
      {ch === '*' ? '●' : ch}
    </Text>
  ))
  if (at < 0) return <Text>{glyphs}</Text>
  const [, refs = '', subject = '', author = '', when = ''] = line.split('\u001f')
  const room = Math.max(10, width - graph.length - hash.length - refs.length - author.length - when.length - 10)
  return (
    <Text wrap="truncate-end">
      {glyphs}
      <Text color="warning">{hash}</Text>
      {refs !== '' ? (
        <Text color="success" bold>
          {' '}
          ({refs})
        </Text>
      ) : null}{' '}
      <Text>{clip(subject, room)}</Text>
      <Text dimColor>
        {' '}
        · {author} · {when}
      </Text>
    </Text>
  )
}

function gitTab($: $, K: Kit, d: Data): RenderChildren {
  const { Box, Text, Button } = K
  const g = d.git
  const room = Math.max(8, d.rows - 12)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
        <Box flexDirection="row" gap={1}>
          <Text color="success" bold>
            ⎇ {g.branch || '—'}
          </Text>
          <Text color={g.ahead > 0 ? 'suggestion' : 'subtle'}>↑{g.ahead}</Text>
          <Text color={g.behind > 0 ? 'warning' : 'subtle'}>↓{g.behind}</Text>
          <Text color={g.changed > 0 ? 'warning' : 'success'}>
            {g.changed > 0 ? `● ${g.changed} changed` : '✓ clean'}
          </Text>
          <Text dimColor>{g.at > 0 ? `refreshed ${fmtClock(g.at)}` : ''}</Text>
        </Box>
        <Button key="git-refresh" label="Refresh" hotkey="r" onPress={() => void refreshGit($)} />
      </Box>
      {g.error !== null ? <Text color="error">{g.error}</Text> : null}
      {g.at === 0 && g.error === null ? <Text dimColor>Loading the graph…</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {g.graph.slice(0, room).map(line => graphLine(K, line, d.width))}
      </Box>
      {g.graph.length > room ? <Text dimColor>… {g.graph.length - room} more lines (make the pane taller to see them)</Text> : null}
    </Box>
  )
}

// ── session logs ─────────────────────────────────────────────────────────────

function logLine(K: Kit, entry: LogEntry, width: number, isExpanded: boolean): RenderChildren {
  const { Text } = K
  const room = Math.max(10, width - 30 - entry.title.length)
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{fmtClock(entry.at)} </Text>
      <Text color={KIND_COLOR[entry.kind]} bold>
        {pad(KIND_LABEL[entry.kind], 6)}
      </Text>{' '}
      <Text color={entry.agent === null ? 'claude' : 'merged'}>{pad(entry.who, 10)}</Text> <Text>{entry.title}</Text>
      {entry.detail !== '' && !isExpanded ? <Text dimColor> {clip(entry.detail.replace(/\s+/g, ' '), room)}</Text> : null}
    </Text>
  )
}

const FILTERS: readonly { value: LogFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'prompt', label: 'Prompts' },
  { value: 'tool', label: 'Tools' },
  { value: 'agent', label: 'Agents' },
  { value: 'turn', label: 'Turns' },
  { value: 'error', label: 'Errors' },
  { value: 'notify', label: 'Alerts' },
]

function logsTab($: $, K: Kit, d: Data): RenderChildren {
  const { Box, Text, Button } = K
  const f = d.view.logFilter
  const matches = d.logs.filter(l => f === 'all' || l.kind === f).reverse()
  const pageSize = Math.max(6, d.rows - 12)
  const pages = Math.max(1, Math.ceil(matches.length / pageSize))
  const page = Math.min(d.view.logPage, pages - 1)
  const shown = matches.slice(page * pageSize, (page + 1) * pageSize)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
        {FILTERS.map(o => {
          const n = o.value === 'all' ? d.logs.length : d.logs.filter(l => l.kind === o.value).length
          return (
            <Button
              key={`filter-${o.value}`}
              label={`${o.label} ${n}`}
              {...sel(o.value === f)}
              onPress={() => void update($, viewA, v => ({ ...v, logFilter: o.value, logPage: 0, expanded: null }))}
            />
          )
        })}
      </Box>
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor>
          {matches.length} events · page {page + 1}/{pages} · newest first · click a row to inspect
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="log-newer" label="◀ Newer" dimColor onPress={() => void update($, viewA, v => ({ ...v, logPage: Math.max(0, v.logPage - 1) }))} />
          <Button key="log-older" label="Older ▶" dimColor onPress={() => void update($, viewA, v => ({ ...v, logPage: Math.min(pages - 1, v.logPage + 1) }))} />
          <Button key="log-export" label="Export" dimColor onPress={() => void doExport($)} />
          <Button key="log-clear" label="Clear" dimColor onPress={() => void update($, logsA, () => [])} />
        </Box>
      </Box>
      {shown.length === 0 ? <Text dimColor>No events for this filter yet.</Text> : null}
      {shown.map(entry => {
        const isOpen = d.view.expanded === entry.id
        return (
          <Box flexDirection="column">
            <Button key={`log-${entry.id}`} plain onPress={() => void toggleLog($, entry.id)}>
              {logLine(K, entry, d.width - 2, isOpen) as never}
            </Button>
            {isOpen ? (
              <Box flexDirection="column" borderStyle="round" borderColor={KIND_COLOR[entry.kind]} paddingX={1}>
                <Text dimColor>
                  #{entry.id} · {new Date(entry.at).toISOString()} · {entry.who}
                  {entry.agent !== null ? ` · ${entry.agent}` : ''}
                </Text>
                <Text bold>{entry.title}</Text>
                <Text wrap="wrap">{entry.detail || '(no detail)'}</Text>
              </Box>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}

async function toggleLog($: $, id: number): Promise<void> {
  await update($, viewA, v => ({ ...v, expanded: v.expanded === id ? null : id }))
}

async function doExport($: $): Promise<void> {
  try {
    const path = await exportLogs($)
    $.ui.toast(`Session log saved to ${path}`, { timeoutMs: 6000 })
  } catch (err) {
    $.ui.toast(`Export failed: ${String(err)}`)
  }
}

// ── terminal ─────────────────────────────────────────────────────────────────

const QUICK = ['git status -sb', 'git log --oneline -5', 'ls -la', 'pwd'] as const

function terminalTab($: $, K: Kit, d: Data, surface: string): RenderChildren {
  const { Box, Text, Button, Input } = K
  const t = d.term
  const room = Math.max(6, d.rows - 14)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
        <Box flexDirection="row" gap={1}>
          <Text color="success" bold>
            zsh
          </Text>
          <Text dimColor>{clip(t.cwd || '(session folder)', Math.max(10, d.width - 40))}</Text>
          {t.running ? (
            <Text color="warning" bold>
              {SPIN[Math.floor(d.now / 100) % SPIN.length]} running
            </Text>
          ) : null}
        </Box>
        <Box flexDirection="row" gap={1}>
          {t.running ? <Button key="term-stop" label="Stop" variant="primary" onPress={() => void stopTerminal($)} /> : null}
          <Button key="term-clear" label="Clear" dimColor onPress={() => void update($, termA, s => ({ ...s, lines: [] }))} />
        </Box>
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor="bashBorder" paddingX={1} minHeight={room + 2}>
        {t.lines.length === 0 ? <Text dimColor>Run any shell command here. It runs in the session folder, apart from Claude's turn.</Text> : null}
        {t.lines.slice(-room).map(line =>
          line.kind === 'cmd' ? (
            <Text>
              <Text color="bashBorder" bold>
                ❯{' '}
              </Text>
              <Text bold>{line.text}</Text>
            </Text>
          ) : (
            <Text color={line.kind === 'err' ? 'error' : line.kind === 'info' ? 'warning' : 'text'} dimColor={line.kind === 'info'} wrap="truncate-end">
              {line.text === '' ? ' ' : line.text}
            </Text>
          ),
        )}
      </Box>
      {Input !== undefined && surface !== 'mobile' ? (
        <Input key="term-input" label="❯" placeholder="type a command and press Enter" submitLabel="Run" onSubmit={value => void runTerminal($, value)} />
      ) : (
        <Text dimColor>This surface has no text field: use the quick commands below.</Text>
      )}
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {QUICK.map(cmd => (
          <Button key={`quick-${cmd}`} label={cmd} dimColor onPress={() => void runTerminal($, cmd)} />
        ))}
      </Box>
    </Box>
  )
}

// ── settings ─────────────────────────────────────────────────────────────────

const NOTIFY = [
  { value: 'off', label: 'Off' },
  { value: 'toast', label: 'Pop-up' },
  { value: 'native', label: 'System' },
  { value: 'both', label: 'Both' },
] as const

const SECONDS = [
  { value: '0', label: 'Always' },
  { value: '10', label: '≥10s' },
  { value: '30', label: '≥30s' },
  { value: '60', label: '≥1m' },
  { value: '120', label: '≥2m' },
] as const

const PRESETS = [
  { name: 'reviewer', label: 'Reviewer', hint: 'reviews diffs for bugs, read-only' },
  { name: 'tester', label: 'Tester', hint: 'runs the test suite and explains failures' },
  { name: 'scout', label: 'Scout', hint: 'fast read-only code search on Haiku' },
] as const

function settingsTab($: $, K: Kit, d: Data): RenderChildren {
  const { Box, Text, Button } = K
  const s = d.settings
  const level = d.effort.override
  return (
    <Box flexDirection="column">
      {section(K, 'Notifications')}
      {settingRow(
        K,
        'Main agent finished',
        'pop-up in Claude, system notification, or both',
        segmented(K, 'n-main', NOTIFY, s.notifyMain, v => void patchSettings($, { notifyMain: v })),
      )}
      {settingRow(K, 'Subagent finished', '', segmented(K, 'n-sub', NOTIFY, s.notifySub, v => void patchSettings($, { notifySub: v })))}
      {settingRow(
        K,
        'Only for turns that took',
        'skip quick replies',
        segmented(K, 'n-min', SECONDS, String(s.minSeconds) as (typeof SECONDS)[number]['value'], v =>
          void patchSettings($, { minSeconds: Number(v) }),
        ),
      )}
      {settingRow(
        K,
        'Errors and failed subagents',
        '',
        segmented(
          K,
          'n-err',
          [
            { value: 'on', label: 'Notify' },
            { value: 'off', label: 'Quiet' },
          ] as const,
          s.notifyErrors ? 'on' : 'off',
          v => void patchSettings($, { notifyErrors: v === 'on' }),
        ),
      )}
      <Box marginTop={1}>
        <Button key="n-test" label="Send a test notification" onPress={() => void notify($, s.notifyMain === 'off' ? 'both' : s.notifyMain, 'Cockpit', 'Notifications are working ✓')} />
      </Box>

      {section(K, 'Effort')}
      {settingRow(
        K,
        'Main agent effort',
        '⌥E raises it, ⌥⇧E lowers it',
        segmented(
          K,
          'eff',
          [{ value: 'default', label: 'Model default' }, ...LEVELS.map(lv => ({ value: lv, label: LEVEL_LABEL[lv] }))] as const,
          level ?? 'default',
          v => void setEffort($, v === 'default' ? null : (v as Effort), 'settings'),
        ),
      )}

      {section(K, 'Subagents')}
      {settingRow(
        K,
        'Model',
        'which model every subagent runs on',
        segmented(
          K,
          'sub-model',
          [
            { value: 'inherit', label: 'As asked' },
            { value: 'haiku', label: 'Haiku' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'opus', label: 'Opus' },
          ] as const,
          s.subModel,
          v => void patchSettings($, { subModel: v }),
        ),
      )}
      {settingRow(
        K,
        'Effort',
        'applied to every subagent request',
        segmented(
          K,
          'sub-effort',
          [{ value: 'inherit', label: 'Inherit' }, ...LEVELS.map(lv => ({ value: lv, label: LEVEL_LABEL[lv] }))] as const,
          s.subEffort,
          v => void patchSettings($, { subEffort: v as CockpitSettings['subEffort'] }),
        ),
      )}
      {settingRow(
        K,
        'Run mode',
        'background keeps you chatting while they work',
        segmented(
          K,
          'sub-bg',
          [
            { value: 'auto', label: 'As asked' },
            { value: 'bg', label: 'Always background' },
          ] as const,
          s.subBackground ? 'bg' : 'auto',
          v => void patchSettings($, { subBackground: v === 'bg' }),
        ),
      )}
      {settingRow(
        K,
        'Preset agent types',
        'offered to Claude as cockpit:<name>',
        <Box flexDirection="column">
          {PRESETS.map(p => {
            const isOn = s.presets[p.name] !== false
            return (
              <Box flexDirection="row" gap={1}>
                <Button
                  key={`preset-${p.name}`}
                  label={`${isOn ? '●' : '○'} ${p.label}`}
                  {...sel(isOn)}
                  onPress={() => void patchSettings($, { presets: { ...s.presets, [p.name]: !isOn } })}
                />
                <Text dimColor>{p.hint}</Text>
              </Box>
            )
          })}
        </Box>,
      )}

      {section(K, 'Display')}
      {settingRow(
        K,
        'Band above the prompt',
        '',
        segmented(
          K,
          'band',
          [
            { value: 'on', label: 'Show' },
            { value: 'off', label: 'Hide' },
          ] as const,
          s.showBand ? 'on' : 'off',
          v => void patchSettings($, { showBand: v === 'on' }),
        ),
      )}
      {settingRow(
        K,
        'Status line',
        '',
        segmented(
          K,
          'status',
          [
            { value: 'on', label: 'Show' },
            { value: 'off', label: 'Hide' },
          ] as const,
          s.showStatus ? 'on' : 'off',
          v => void patchSettings($, { showStatus: v === 'on' }),
        ),
      )}
    </Box>
  )
}

// ══ hooks ══

const TAB_NAMES: readonly Tab[] = ['overview', 'agents', 'usage', 'git', 'logs', 'terminal', 'settings']

const PRESET_SPECS = [
  {
    name: 'reviewer',
    description: 'Reviews the current diff or named files for bugs, risky changes and missing tests. Read-only. Use after making changes.',
    prompt:
      'You are a meticulous senior code reviewer. Inspect the change you are pointed at (run `git diff` when no files are named). Report concrete bugs, regressions, security issues and missing tests, most severe first, each with file:line and a one-line fix. Do not edit files. Be brief.',
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
  },
  {
    name: 'tester',
    description: "Runs the project's test suite (or the tests you name) and explains each failure with its likely cause.",
    prompt:
      "You run tests. Find how this project runs its tests (package.json, Makefile, pyproject, etc.), run them, and report: the command used, pass/fail counts, and for each failure the test name, the assertion, and the most likely cause in the code. Do not edit files.",
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
  },
  {
    name: 'scout',
    description: 'Fast, cheap read-only search: finds where something lives in the codebase and returns paths with a one-line note each.',
    prompt:
      'You are a fast code scout. Locate what you are asked for with searches and quick reads, then answer with a short list of file:line locations and a one-line note each. Never edit. Stop as soon as you can answer.',
    model: 'haiku',
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
  },
] as const

// ── helpers ──────────────────────────────────────────────────────────────────

async function gather($: $, width: number, rows: number): Promise<Data> {
  return {
    main: await read($, mainA),
    agents: await read($, agentsA),
    turns: await read($, turnsA),
    usage: await read($, usageA),
    logs: await read($, logsA),
    effort: await read($, effortA),
    settings: await read($, settingsA),
    git: await read($, gitA),
    term: await read($, termA),
    view: await read($, viewA),
    now: (await read($, nowA)) || (await $.clock.now()),
    width,
    rows,
  }
}

async function patchAgent($: $, id: string, fn: (a: AgentRec) => AgentRec): Promise<void> {
  await update($, agentsA, list => list.map(a => (a.id === id ? fn(a) : a)))
}

const ignored = new Set<string>()

/** Makes sure an agent seen only through its loop's events has a row. */
async function ensureAgent($: $, id: string): Promise<boolean> {
  if (ignored.has(id)) return false
  if ((await read($, agentsA)).some(a => a.id === id)) return true
  const info = (await $.agent.list()).find(a => a.id === id)
  if (info === undefined) {
    ignored.add(id)
    return false
  }
  const at = await $.clock.now()
  const rec: AgentRec = {
    id,
    type: info.type,
    description: info.description,
    model: '',
    parentId: info.parentId ?? null,
    status: 'running',
    startedAt: at,
    endedAt: 0,
    tools: 0,
    errors: 0,
    activity: null,
    tokensIn: 0,
    tokensOut: 0,
    toolMix: {},
    hits: [],
  }
  await update($, agentsA, list => (list.some(a => a.id === id) ? list : [...list, rec].slice(-60)))
  return true
}

let lastStatus: string | undefined

async function refreshStatus($: $): Promise<void> {
  const settings: CockpitSettings = await read($, settingsA)
  if (!settings.showStatus) {
    if (lastStatus !== undefined) $.ui.status(undefined)
    lastStatus = undefined
    return
  }
  const now = await $.clock.now()
  const main = await read($, mainA)
  const agents = await read($, agentsA)
  const turns = await read($, turnsA)
  const usage = await read($, usageA)
  const effort = await currentEffort($)
  const spin = SPIN[Math.floor(now / 1000) % SPIN.length] ?? '•'
  const mainText =
    main.phase === 'working'
      ? `${spin} main working ${fmtDur(now - main.startedAt)}${main.activity ? ` · ${clip(`${main.activity.tool} ${main.activity.detail}`, 36)}` : ''}`
      : main.phase === 'done'
        ? `✓ main done in ${fmtDur(main.endedAt - main.startedAt)} · ${main.tools} tools`
        : main.phase === 'aborted'
          ? '■ main interrupted'
          : main.phase === 'error'
            ? '✗ main stopped on an error'
            : '◌ main idle'
  const running = agents.filter(a => a.status === 'running').length
  const done = agents.filter(a => a.status === 'done').length
  const failed = agents.filter(a => a.status === 'failed' || a.status === 'aborted').length
  const subText =
    agents.length === 0
      ? '⑂ no subagents'
      : `⑂ subagents ${running > 0 ? `${running} running · ` : ''}${done}/${agents.length} done${failed > 0 ? ` · ${failed} failed` : ''}`
  const total = turns.reduce((n, t) => n + t.input + t.output + t.cacheRead + t.cacheWrite, 0)
  const parts = [
    mainText,
    subText,
    `⚡ ${effort === null ? 'default' : LEVEL_LABEL[effort]}`,
    `Σ ${fmtTok(total)} tok · ${fmtUsd(usage.costUsd)}${usage.contextPct !== null ? ` · ctx ${usage.contextPct}%` : ''}`,
  ]
  const text = parts.join('  │  ')
  if (text !== lastStatus) {
    lastStatus = text
    $.ui.status(text)
  }
}

async function readUsage($: $): Promise<void> {
  try {
    const u = await $.session.usage()
    await update($, usageA, cur => ({
      startedAt: u.startedAt ?? cur.startedAt,
      contextPct: u.context.percent ?? cur.contextPct,
      contextTokens: u.context.tokens ?? cur.contextTokens,
      window: u.context.window,
      costUsd: u.cost?.usd ?? cur.costUsd,
      limits: u.rateLimits.map(r => ({ kind: r.kind, pct: r.percentUsed, resetsAt: r.resetsAt ?? null })),
    }))
  } catch {
    // no usage reading on this host yet
  }
}

function endStatus(reason: string): AgentStatusKind {
  if (reason === 'answer') return 'done'
  if (reason === 'aborted') return 'aborted'
  return 'failed'
}

// ── the mod ──────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await loadSettings($)
    for (const [name, description] of [
      ['cockpit', 'Open the Cockpit: agents, usage, git graph, logs, terminal, settings'],
      ['usage-chart', 'Chart of token usage per turn, context window and plan limits'],
      ['fleet', 'Cockpit: what the main agent and every subagent is doing now'],
      ['session-log', 'Cockpit: the live session log, filterable and inspectable'],
      ['git-graph', 'Cockpit: the repository graph, branches and status'],
      ['effort-up', 'Raise the reasoning effort one level (⌥E)'],
      ['effort-down', 'Lower the reasoning effort one level (⌥⇧E)'],
    ] as const) {
      await $.command.register({
        name,
        description,
        ...(name === 'cockpit' ? { argumentHint: '[overview|agents|usage|git|logs|terminal|settings]' } : {}),
        ...(name.startsWith('effort-') ? { immediate: true as const } : {}),
      })
    }
    for (const spec of PRESET_SPECS) {
      try {
        await $.agent.register({ ...spec, disallowedTools: [...spec.disallowedTools] })
      } catch (err) {
        $.ui.log(`cockpit: could not register ${spec.name}: ${String(err)}`, { to: 'debug' })
      }
    }
    const model = await $.session.model()
    await update($, mainA, m => ({ ...m, model }))
    await update($, termA, t => (t.cwd !== '' ? t : { ...t, cwd: '' }))
    await findEffortRow($)
    await readUsage($)
    await refreshStatus($)

    $.clock.every(1000, () => {
      void (async () => {
        const main = await read($, mainA)
        const agents = await read($, agentsA)
        const term = await read($, termA)
        if (main.phase === 'working' || term.running || agents.some(a => a.status === 'running')) {
          const now = await $.clock.now()
          await update($, nowA, () => now)
        }
        await refreshStatus($)
      })()
    })
    return started
  })

  // ── commands ───────────────────────────────────────────────────────────────

  on('command.run', { command: 'cockpit' }, async ($, e) => {
    const asked = e.args.trim().toLowerCase()
    const tab = TAB_NAMES.find(t => t === asked)
    const isPlaced = await openPane($, tab)
    return { text: isPlaced ? `Cockpit opened${tab ? ` on ${tab}` : ''}.` : 'Cockpit is open; widen the window to see it.' }
  })

  on('command.run', { command: 'fleet' }, async $ => {
    await openPane($, 'agents')
    return { text: 'Cockpit opened on Agents.' }
  })

  on('command.run', { command: 'session-log' }, async $ => {
    await openPane($, 'logs')
    return { text: 'Cockpit opened on the session log.' }
  })

  on('command.run', { command: 'git-graph' }, async $ => {
    await openPane($, 'git')
    return { text: 'Cockpit opened on the git graph.' }
  })

  on('command.run', { command: 'usage-chart' }, async $ => {
    await readUsage($)
    const turns = await read($, turnsA)
    const usage = await read($, usageA)
    const total = turns.reduce((n, t) => n + t.input + t.output + t.cacheRead + t.cacheWrite, 0)
    return {
      text: `Usage: ${fmtTok(total)} tokens over ${turns.length} turns · ${fmtUsd(usage.costUsd)} · context ${usage.contextPct ?? '—'}%`,
    }
  })

  on('command.run', { command: 'effort-up' }, async $ => {
    const now = await nudgeEffort($, 1, '/effort-up')
    return { text: `Effort: ${now === null ? 'model default' : LEVEL_LABEL[now]}` }
  })

  on('command.run', { command: 'effort-down' }, async $ => {
    const now = await nudgeEffort($, -1, '/effort-down')
    return { text: `Effort: ${now === null ? 'model default' : LEVEL_LABEL[now]}` }
  })

  // ── the main agent ─────────────────────────────────────────────────────────

  on('turn.start', async ($, e, next) => {
    const at = await $.clock.now()
    await update($, mainA, m => ({ ...m, phase: 'working' as const, startedAt: at, endedAt: 0, tools: 0, errors: 0, activity: null }))
    await update($, nowA, () => at)
    if (e.text.trim() !== '') await log($, 'prompt', null, clip(e.text.replace(/\s+/g, ' '), 90), e.text)
    void refreshStatus($)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const eff = await read($, effortA)
    const asked = isEffort(e.effort) ? e.effort : null
    let want: Effort | null = null
    if (e.agentId === undefined) {
      if (asked !== eff.base) {
        // The engine's own level moved (the /effort command, the model picker): it wins.
        await update($, effortA, cur => ({ ...cur, base: asked, override: cur.base === null ? cur.override : null }))
      }
      want = (await read($, effortA)).override
    } else {
      const s: CockpitSettings = await read($, settingsA)
      want = s.subEffort === 'inherit' ? null : s.subEffort
    }
    const input = want !== null && e.effort !== undefined && want !== asked ? { ...e, effort: want } : e
    return yield* next(input)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const at = await $.clock.now()
    const u = e.usage
    if (u !== undefined) {
      await update($, turnsA, list =>
        [
          ...list,
          {
            at,
            durationMs: e.durationMs,
            agentId: e.agentId ?? null,
            model: u.model,
            input: u.input_tokens,
            output: u.output_tokens,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
          },
        ].slice(-300),
      )
    }
    const settings: CockpitSettings = await read($, settingsA)

    if (e.agentId !== undefined) {
      if (!(await ensureAgent($, e.agentId))) return result
      const status = endStatus(e.reason)
      await patchAgent($, e.agentId, a => ({
        ...a,
        status,
        endedAt: at,
        activity: null,
        model: u?.model ?? a.model,
        tokensIn: a.tokensIn + (u ? u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0),
        tokensOut: a.tokensOut + (u?.output_tokens ?? 0),
      }))
      const rec = (await read($, agentsA)).find(a => a.id === e.agentId)
      const label = rec?.type ?? 'subagent'
      await log($, status === 'done' ? 'agent' : 'error', e.agentId, `${label} ${status} in ${fmtDur(e.durationMs)}`, e.answer)
      const mode = status === 'done' ? settings.notifySub : settings.notifyErrors ? 'both' : 'off'
      if (mode !== 'off') {
        await notify($, mode, status === 'done' ? `✓ ${label} finished` : `✗ ${label} ${status}`, clip(rec?.description ?? e.answer, 120))
      }
      void refreshStatus($)
      return result
    }

    const phase: MainStatus['phase'] = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'aborted' : 'error'
    const main = await read($, mainA)
    await update($, mainA, m => ({
      ...m,
      phase,
      endedAt: at,
      activity: null,
      turns: m.turns + 1,
      model: u?.model ?? m.model,
    }))
    await log(
      $,
      phase === 'error' ? 'error' : 'turn',
      null,
      `Turn ${phase} in ${fmtDur(e.durationMs)} · ${main.tools} tools${u ? ` · ${fmtTok(u.input_tokens + u.output_tokens)} tok` : ''}`,
      e.answer,
    )
    await readUsage($)
    if ((await read($, viewA)).tab === 'git') void refreshGit($)

    const isLong = e.durationMs >= settings.minSeconds * 1000
    if (phase === 'error' && settings.notifyErrors) {
      await notify($, 'both', '✗ Claude stopped on an error', clip(e.answer || 'The turn ended with an API error.', 140))
    } else if (phase === 'done' && isLong) {
      await notify(
        $,
        settings.notifyMain,
        '✓ Claude is done',
        `${fmtDur(e.durationMs)} · ${main.tools} tools · ${clip(e.answer.replace(/\s+/g, ' '), 90) || 'ready for you'}`,
      )
    }
    await update($, nowA, () => at)
    void refreshStatus($)
    return result
  })

  // ── tools: who is running what ─────────────────────────────────────────────

  on('tool.call', async ($, e, next) => {
    const at = await $.clock.now()
    const tool = String(e.tool)
    const detail = detailOf(e)
    const agentId = e.agentId ?? null
    const isAgent = agentId !== null && (await ensureAgent($, agentId))
    if (agentId === null) {
      await update($, mainA, m => ({
        ...m,
        tools: m.tools + 1,
        activity: { tool, detail, since: at },
        hits: [...m.hits, at].slice(-400),
      }))
    } else if (isAgent) {
      await patchAgent($, agentId, a => ({
        ...a,
        status: 'running',
        endedAt: 0,
        tools: a.tools + 1,
        activity: { tool, detail, since: at },
        toolMix: { ...a.toolMix, [tool]: (a.toolMix[tool] ?? 0) + 1 },
        hits: [...a.hits, at].slice(-400),
      }))
    }
    if (agentId === null || isAgent) await log($, 'tool', agentId, tool, detail)

    const ran = await next(e)

    const hasFailed = ran.deny !== undefined || ran.isError === true
    if (agentId === null) {
      await update($, mainA, m => ({
        ...m,
        errors: m.errors + (hasFailed ? 1 : 0),
        activity: m.activity?.since === at ? null : m.activity,
      }))
    } else if (isAgent) {
      await patchAgent($, agentId, a => ({
        ...a,
        errors: a.errors + (hasFailed ? 1 : 0),
        activity: a.activity?.since === at ? null : a.activity,
      }))
    }
    if (hasFailed && (agentId === null || isAgent)) {
      const why = ran.deny ?? (typeof ran.text === 'string' ? ran.text : '')
      await log($, 'error', agentId, `${tool} failed`, `${detail}\n${clip(String(why), 600)}`)
    }
    return ran
  }).catch(($, e, next) => next(e))

  // ── subagents: spawn, customise ────────────────────────────────────────────

  on('agent.spawn', async ($, e, next) => {
    const s: CockpitSettings = await read($, settingsA)
    const isCustomisable = !e.fork && e.isTeammate !== true
    const input = isCustomisable
      ? {
          ...e,
          ...(s.subModel !== 'inherit' ? { model: s.subModel } : {}),
          ...(s.subBackground ? { background: true } : {}),
        }
      : e
    const res = await next(input)
    if (res.deny !== undefined || res.agentId === undefined) return res
    const at = await $.clock.now()
    const id = res.agentId
    const rec: AgentRec = {
      id,
      type: e.subagentType,
      description: e.description,
      model: res.model,
      parentId: e.parentAgentId ?? null,
      status: 'running',
      startedAt: at,
      endedAt: 0,
      tools: 0,
      errors: 0,
      activity: null,
      tokensIn: 0,
      tokensOut: 0,
      toolMix: {},
      hits: [],
    }
    ignored.delete(id)
    await update($, agentsA, list => [...list.filter(a => a.id !== id), rec].slice(-60))
    await log(
      $,
      'agent',
      id,
      `spawned ${e.subagentType}: ${clip(e.description, 60)}`,
      `model ${res.model}${input.background ? ' · background' : ''}\n\n${e.prompt}`,
    )
    void refreshStatus($)
    return res
  }).catch(($, e, next) => next(e))

  on('agent.offer', ($, e, next) => {
    if (!e.agent.startsWith('cockpit:')) return next(e)
    return read($, settingsA).then(s => (s.presets[e.agent.slice(8)] === false ? { isOffered: false } : next(e)))
  }).catch(($, e, next) => next(e))

  // ── usage readings ─────────────────────────────────────────────────────────

  on('session.measure', async ($, e, next) => {
    await update($, usageA, cur => ({
      ...cur,
      contextPct: e.context.percent ?? cur.contextPct,
      contextTokens: e.context.tokens ?? cur.contextTokens,
      window: e.context.window,
      costUsd: e.cost?.usd ?? cur.costUsd,
      limits:
        e.rateLimits.length > 0
          ? e.rateLimits.map(r => ({ kind: r.kind, pct: r.percentUsed, resetsAt: r.resetsAt ?? null }))
          : cur.limits,
    }))
    return next(e)
  })

  // ── drawing ────────────────────────────────────────────────────────────────

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const kit = $.ui.resolve(e) as unknown as Kit
    const rows = e.viewport?.rows ?? 40
    const d = await gather($, Math.max(30, e.props.bodyColumns), rows)
    return drawPane($, kit, d, e.surface) as never
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const settings: CockpitSettings = await read($, settingsA)
    if (e.props.hasSurvey || !settings.showBand) return next(e)
    const kit = $.ui.resolve(e) as unknown as Kit
    const d = await gather($, Math.max(30, e.props.bodyColumns), e.viewport?.rows ?? 40)
    return drawBand($, kit, d) as never
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'usage-chart' } }, async ($, e) => {
    const kit = $.ui.resolve(e) as unknown as Kit
    const width = Math.max(30, (e.viewport?.columns ?? 100) - 4)
    const d = await gather($, width, 20)
    const { Box, Text } = kit
    const total = d.turns.reduce((n, t) => n + t.input + t.output + t.cacheRead + t.cacheWrite, 0)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
        <Text>
          <Text color="claude" bold>
            ✈ USAGE
          </Text>
          <Text dimColor>
            {' '}
            {fmtTok(total)} tokens · {d.turns.length} turns · {fmtUsd(d.usage.costUsd)} · context{' '}
            {d.usage.contextPct ?? '—'}%
          </Text>
        </Text>
        {d.turns.length === 0 ? <Text dimColor>No finished turns yet.</Text> : (drawUsageChart(kit, d, 6) as never)}
        {d.usage.limits.map(l => (
          <Text dimColor>
            {l.kind.replace('_', ' ')}: {l.pct}% used
          </Text>
        ))}
        <Text dimColor>Full dashboard: /cockpit usage</Text>
      </Box>
    ) as never
  })

  // Keep the git tab fresh after the agent touches the repository.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (/\bgit\b/.test(e.command) && (await read($, viewA)).tab === 'git') void refreshGit($)
    return ran
  }).catch(($, e, next) => next(e))

}
