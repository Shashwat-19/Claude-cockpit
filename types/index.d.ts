export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Phase = 'idle' | 'working' | 'done' | 'aborted' | 'error'
export type Tab = 'overview' | 'agents' | 'usage' | 'git' | 'logs' | 'terminal' | 'settings'
export type NotifyMode = 'off' | 'toast' | 'native' | 'both'
export type LogKind = 'prompt' | 'tool' | 'error' | 'agent' | 'turn' | 'notify' | 'system'
export type LogFilter = 'all' | LogKind
export type SubModel = 'inherit' | 'haiku' | 'sonnet' | 'opus'

/** What an agent is doing right now: the tool it is in and a one-line summary of the input. */
export type Activity = { tool: string; detail: string; since: number }

export type MainStatus = {
  phase: Phase
  startedAt: number
  endedAt: number
  tools: number
  errors: number
  turns: number
  activity: Activity | null
  model: string
  hits: number[]
}

export type AgentStatusKind = 'running' | 'done' | 'failed' | 'aborted'

export type AgentRec = {
  id: string
  type: string
  description: string
  model: string
  parentId: string | null
  status: AgentStatusKind
  startedAt: number
  endedAt: number
  tools: number
  errors: number
  activity: Activity | null
  tokensIn: number
  tokensOut: number
  toolMix: Record<string, number>
  hits: number[]
}

export type TurnRec = {
  at: number
  durationMs: number
  agentId: string | null
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type RateLimit = { kind: string; pct: number; resetsAt: string | null }

export type UsageSnap = {
  startedAt: number
  contextPct: number | null
  contextTokens: number | null
  window: number
  costUsd: number | null
  limits: RateLimit[]
}

export type LogEntry = {
  id: number
  at: number
  kind: LogKind
  agent: string | null
  who: string
  title: string
  detail: string
}

/**
 * `override` is the level the mod applies to each main-loop request, null when the
 * model's own level stands; `base` is the level the engine asked for before the mod;
 * `configKey` is the /config row the mod drives instead, when this build has one.
 */
export type EffortState = {
  override: Effort | null
  base: Effort | null
  configKey: string | null
}

export type CockpitSettings = {
  notifyMain: NotifyMode
  notifySub: NotifyMode
  notifyErrors: boolean
  minSeconds: number
  subModel: SubModel
  subEffort: 'inherit' | Effort
  subBackground: boolean
  presets: Record<string, boolean>
  showBand: boolean
  showStatus: boolean
}

export type GitSnap = {
  at: number
  branch: string
  ahead: number
  behind: number
  changed: number
  graph: string[]
  error: string | null
}

export type TermLine = { kind: 'cmd' | 'out' | 'err' | 'info'; text: string }
export type TermState = { cwd: string; running: boolean; lines: TermLine[] }

export type ViewState = {
  tab: Tab
  logFilter: LogFilter
  expanded: number | null
  logPage: number
  agentSel: string | null
}

declare module 'claude-code' {
  interface PluginState {
    cockpit: {
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
    }
  }
}
