import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { ScanReport, LiveStats, Agg } from '../types'

const PANE = 'cc-uso'
const SCAN_EVERY_MS = 20_000

const reportAtom = atom<ScanReport | null>({ plugin: 'cc-uso', key: 'report' } as const, null)
const errorAtom = atom<string | null>({ plugin: 'cc-uso', key: 'error' } as const, null)
const LIVE0: LiveStats = { startedAt: Date.now(), project: '', turns: 0, inTok: 0, outTok: 0, cacheTok: 0, cost: 0, toolRes: 0, toolErr: 0 }
const liveAtom = atom<LiveStats>({ plugin: 'cc-uso', key: 'live' } as const, LIVE0)

// --- precios (mismos que scan.mjs; actualizar en ambos sitios si cambian) ---
const PRICES: Array<[string, number[]]> = [
  ['opus-4-1', [15, 75, 18.75, 1.5]], ['claude-3-opus', [15, 75, 18.75, 1.5]],
  ['fable', [10, 50, 12.5, 1.0]], ['opus', [5, 25, 6.25, 0.5]],
  ['sonnet', [3, 15, 3.75, 0.3]], ['haiku-3', [0.25, 1.25, 0.3, 0.03]], ['haiku', [1, 5, 1.25, 0.1]],
]
function costOf(u: any, model: string): number {
  const s = (model || '').toLowerCase()
  const hit = PRICES.find(([m]) => s.includes(m))
  const [i, o, cw, cr] = (hit ? hit[1] : [3, 15, 3.75, 0.3])
  return ((u.input_tokens || 0) * i + (u.output_tokens || 0) * o +
    (u.cache_creation_input_tokens || 0) * cw + (u.cache_read_input_tokens || 0) * cr) / 1e6
}

// --- formato ---
const usd = (n: number) => '$' + (n || 0).toFixed(2)
const tok = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n || 0))
const dur = (ms: number) => { const m = Math.round((ms || 0) / 60000); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm' }
const pct = (p: number | null) => p == null ? '—' : Math.round(p * 100) + '%'
const basename = (p: string) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p

let scanning = false
async function rescan($: any) {
  if (scanning) return
  scanning = true
  try {
    const res = await $.process.run(['node', `${$.plugin.root}/hooks/scan.mjs`], { timeoutMs: 120_000 })
    if (res.exitCode === 0 && res.stdout) {
      const report = JSON.parse(res.stdout) as ScanReport
      await update($, reportAtom, () => report)
      await update($, errorAtom, () => null)
    } else {
      await update($, errorAtom, () => String(res.stderr || 'scan sin salida').slice(0, 160))
    }
  } catch (err) {
    await update($, errorAtom, () => String(err).slice(0, 160))
  } finally {
    scanning = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    let project = ''
    try { project = basename(await $.session.root()) } catch { }
    await update($, liveAtom, () => ({ ...LIVE0, startedAt: Date.now(), project }))
    await $.command.register({ name: 'uso', description: 'Abre/actualiza el panel de uso de Claude Code' })
    void $.ui.open({ id: PANE, title: 'Uso' })
    void rescan($)
    $.clock.every(SCAN_EVERY_MS, () => rescan($))
    return next(e)
  })

  on('command.run', { command: 'uso' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Uso' })
    void rescan($)
    return { text: 'Panel de uso abierto.' }
  })

  on('turn.complete', async ($, e, next) => {
    const u = (e as any).usage
    if (u) {
      const model = u.model || ''
      const c = costOf(u, model)
      await update($, liveAtom, s => ({
        ...s,
        turns: s.turns + ((e as any).agentId ? 0 : 1),
        inTok: s.inTok + (u.input_tokens || 0),
        outTok: s.outTok + (u.output_tokens || 0),
        cacheTok: s.cacheTok + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
        cost: s.cost + c,
      }))
    }
    void rescan($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    await update($, liveAtom, s => ({
      ...s,
      toolRes: s.toolRes + 1,
      toolErr: s.toolErr + ((ran as any)?.isError ? 1 : 0),
    }))
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const report = await read($, reportAtom)
    const live = await read($, liveAtom)
    const error = await read($, errorAtom)

    if (!report) {
      return (
        <Box flexDirection="column">
          <Text bold>Claude Code · Uso</Text>
          <Text dimColor>{error ? 'Error: ' + error : 'Escaneando sesiones…'}</Text>
        </Box>
      )
    }

    const proj = report.projects.find(p => p.name === live.project)
    const src = proj ?? { name: live.project || '(este proyecto)', day: report.totals.day, week: report.totals.week, month: report.totals.month, all: report.totals.all }
    const ago = Math.max(0, Math.round((Date.now() - report.generatedAt) / 1000))

    const LW = 11, CW = 9
    const header = 'métrica'.padEnd(LW) + 'Hoy'.padStart(CW) + 'Semana'.padStart(CW) + 'Mes'.padStart(CW)
    const rowOf = (label: string, f: (a: Agg) => string) =>
      label.padEnd(LW) + f(src.day).padStart(CW) + f(src.week).padStart(CW) + f(src.month).padStart(CW)

    const livePrec = live.toolRes > 0 ? 1 - live.toolErr / live.toolRes : null
    const liveLine = `Sesión: ${dur(Date.now() - live.startedAt)} · ${usd(live.cost)} · ${tok(live.inTok + live.outTok + live.cacheTok)} tok · ${live.turns} turnos · prec ${pct(livePrec)}`
    const allWk = report.totals.week
    const allLine = `Todos (semana): ${usd(allWk.cost)} · ${dur(allWk.activeMs)} · ${allWk.conversations} conv · ${tok(allWk.tokens)} tok`

    return (
      <Box flexDirection="column">
        <Text bold>Claude Code · Uso{proj ? '  ·  ' + proj.name : ''}</Text>
        <Text dimColor>actualizado hace {ago}s · {report.projects.length} proyectos{proj ? '' : ' · (sin datos de este proyecto aún)'}</Text>
        <Text> </Text>
        <Text dimColor>{header}</Text>
        <Text>{rowOf('Coste', a => usd(a.cost))}</Text>
        <Text>{rowOf('Tiempo', a => dur(a.activeMs))}</Text>
        <Text>{rowOf('Conversac.', a => String(a.conversations))}</Text>
        <Text>{rowOf('Tokens', a => tok(a.tokens))}</Text>
        <Text>{rowOf('Precisión', a => pct(a.precision))}</Text>
        <Text> </Text>
        <Text>{liveLine}</Text>
        <Text dimColor>{allLine}</Text>
        {error && <Text dimColor>⚠ {error}</Text>}
      </Box>
    )
  })
}
