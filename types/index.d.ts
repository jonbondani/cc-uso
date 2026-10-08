export type Agg = {
  conversations: number
  activeMs: number
  inTok: number
  outTok: number
  cacheTok: number
  tokens: number
  cost: number
  toolRes: number
  toolErr: number
  precision: number | null
}

export type ProjectRow = { name: string; day: Agg; week: Agg; month: Agg; all: Agg }

export type ScanReport = {
  generatedAt: number
  projectsDir: string
  idleCapMin: number
  totals: { day: Agg; week: Agg; month: Agg; all: Agg }
  projects: ProjectRow[]
}

export type LiveStats = {
  startedAt: number
  project: string
  turns: number
  inTok: number
  outTok: number
  cacheTok: number
  cost: number
  toolRes: number
  toolErr: number
}

// Lo que pinta la banda: límites de uso y desglose del contexto (sin tokens).
export type RateWindow = { kind: string; percentUsed: number; resetsAt: string | null }
export type ContextPart = { name: string; tokens: number; color: string }
export type UsageSnap = {
  rateLimits: RateWindow[]
  tokens: number
  window: number
  percent: number
  rawMax: number
  parts: ContextPart[]
}

declare module 'claude-code' {
  interface PluginState {
    'cc-uso': {
      report: ScanReport | null
      live: LiveStats
      error: string | null
      usage: UsageSnap | null
      view: number
    }
  }
}
