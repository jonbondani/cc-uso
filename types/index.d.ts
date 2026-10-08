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

declare module 'claude-code' {
  interface PluginState {
    'cc-uso': {
      report: ScanReport | null
      live: LiveStats
      error: string | null
    }
  }
}
