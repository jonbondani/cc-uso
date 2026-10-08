import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { ScanReport, LiveStats, Agg, UsageSnap } from '../types'

// Banda fija encima del prompt. Tres paneles que se recorren con ‹ ›.
const VIEWS = ['Límites', 'Contexto', 'Uso'] as const
const SCAN_EVERY_MS = 20_000
const USAGE_EVERY_MS = 30_000

const reportAtom = atom<ScanReport | null>({ plugin: 'cc-uso', key: 'report' } as const, null)
const errorAtom = atom<string | null>({ plugin: 'cc-uso', key: 'error' } as const, null)
const LIVE0: LiveStats = { startedAt: Date.now(), project: '', turns: 0, inTok: 0, outTok: 0, cacheTok: 0, cost: 0, toolRes: 0, toolErr: 0 }
const liveAtom = atom<LiveStats>({ plugin: 'cc-uso', key: 'live' } as const, LIVE0)
const usageAtom = atom<UsageSnap | null>({ plugin: 'cc-uso', key: 'usage' } as const, null)
const viewAtom = atom<number>({ plugin: 'cc-uso', key: 'view' } as const, 0)

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
// Tipo de cambio de referencia del BCE (7-oct-2026): 1 EUR = 1,1177 USD.
// Los costes se miden en USD y se convierten a euros al mostrarlos.
// Actualizar cuando se quiera: 1 / <USD por EUR>.
const USD_TO_EUR = 1 / 1.1177
const usd = (n: number) => ((n || 0) * USD_TO_EUR).toFixed(2).replace('.', ',') + ' €'
const tok = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n || 0))
const dur = (ms: number) => { const m = Math.round((ms || 0) / 60000); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm' }
const pct = (p: number | null) => p == null ? '—' : Math.round(p * 100) + '%'
const basename = (p: string) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p
const bar = (ratio: number, width: number) => {
  const n = Math.max(0, Math.min(width, Math.round(ratio * width)))
  return '█'.repeat(n) + '░'.repeat(width - n)
}
const levelColor = (p: number) => p >= 90 ? 'error' : p >= 70 ? 'warning' : 'success'
const untilReset = (iso: string | null) => {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (!(ms > 0)) return 'ya'
  const m = Math.round(ms / 60000)
  return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm'
}
const LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

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

// Lectura local: summary no envía peticiones a la API, así que no gasta tokens.
async function refreshUsage($: any) {
  try {
    const s = await $.session.usage({ breakdown: 'summary' })
    const b = s.context.breakdown
    const snap: UsageSnap = {
      rateLimits: (s.rateLimits ?? []).map((r: any) => ({
        kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt ?? null,
      })),
      tokens: s.context.tokens ?? 0,
      window: s.context.window,
      percent: s.context.percent ?? 0,
      rawMax: b?.rawMaxTokens ?? s.context.window,
      parts: (b?.categories ?? []).filter((c: any) => c.tokens > 0 && !c.isDeferred)
        .map((c: any) => ({ name: c.name, tokens: c.tokens, color: c.color })),
    }
    await update($, usageAtom, () => snap)
  } catch { }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    let project = ''
    try { project = basename(await $.session.root()) } catch { }
    await update($, liveAtom, () => ({ ...LIVE0, startedAt: Date.now(), project }))
    await $.command.register({ name: 'uso', description: 'Cambia de panel en la banda de uso' })
    void rescan($)
    void refreshUsage($)
    $.clock.every(SCAN_EVERY_MS, () => rescan($))
    $.clock.every(USAGE_EVERY_MS, () => refreshUsage($))
    return next(e)
  })

  on('command.run', { command: 'uso' }, async $ => {
    await update($, viewAtom, v => (v + 1) % VIEWS.length)
    return { text: 'Panel cambiado.' }
  })

  on('turn.complete', async ($, e, next) => {
    const u = (e as any).usage
    if (u) {
      const c = costOf(u, u.model || '')
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
    void refreshUsage($)
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
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    const usage = await read($, usageAtom)
    const live = await read($, liveAtom)
    const report = await read($, reportAtom)
    const error = await read($, errorAtom)
    const cols = Math.max(40, Math.min(e.props?.bodyColumns ?? 80, 120))
    const barW = Math.max(10, Math.min(30, cols - 34))

    const prev = () => update($, viewAtom, v => (v + VIEWS.length - 1) % VIEWS.length)
    const next = () => update($, viewAtom, v => (v + 1) % VIEWS.length)

    const nav = (
      <Box flexDirection="row">
        <Button label="‹" plain onPress={prev} />
        <Text bold>{' ' + VIEWS[view] + ' '}</Text>
        <Button label="›" plain onPress={next} />
        <Text dimColor>{'  ' + (view + 1) + '/' + VIEWS.length}</Text>
      </Box>
    )

    let body: any
    if (view === 0) {
      body = !usage || usage.rateLimits.length === 0
        ? <Text dimColor>Sin lecturas de límites todavía (aparecen tras la primera respuesta).</Text>
        : usage.rateLimits.map(r => (
          <Box flexDirection="row" key={r.kind}>
            <Text>{(LABEL[r.kind] ?? r.kind).padEnd(5)}</Text>
            <Text color={levelColor(r.percentUsed)}>{bar(r.percentUsed / 100, barW)}</Text>
            <Text color={levelColor(r.percentUsed)}>{' ' + Math.round(r.percentUsed).toString().padStart(3) + '%'}</Text>
            <Text dimColor>{r.resetsAt ? '  reinicia en ' + untilReset(r.resetsAt) : ''}</Text>
          </Box>
        ))
    } else if (view === 1) {
      if (!usage) {
        body = <Text dimColor>Leyendo el contexto…</Text>
      } else {
        const total = Math.max(1, usage.window)
        const segs = usage.parts.map(p => ({
          ...p, w: Math.max(1, Math.round((p.tokens / total) * barW * 1.6)),
        }))
        body = (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Text bold>contexto  </Text>
              <Text>{tok(usage.tokens) + ' de ' + tok(usage.window)}</Text>
              <Text dimColor>{'  · compacta en ' + tok(usage.rawMax)}</Text>
              <Text color={levelColor(usage.percent)}>{'  ' + usage.percent + '%'}</Text>
            </Box>
            <Box flexDirection="row">
              {segs.map(s => <Text key={s.name} color={s.color}>{'█'.repeat(s.w)}</Text>)}
            </Box>
            <Box flexDirection="row">
              {usage.parts.map(p => (
                <Text key={p.name} dimColor>{'■ ' + p.name + ' ' + tok(p.tokens) + '  '}</Text>
              ))}
            </Box>
          </Box>
        )
      }
    } else {
      const proj = report?.projects.find(p => p.name === live.project)
      const src = report && (proj ?? { day: report.totals.day, week: report.totals.week, month: report.totals.month })
      const livePrec = live.toolRes > 0 ? 1 - live.toolErr / live.toolRes : null
      body = (
        <Box flexDirection="column">
          <Text>{'sesión  ' + usd(live.cost) + ' · ' + tok(live.inTok + live.outTok + live.cacheTok) + ' tok · ' + live.turns + ' turnos · prec ' + pct(livePrec)}</Text>
          {src ? (
            <Text>{'hoy ' + usd(src.day.cost) + ' · ' + dur(src.day.activeMs) + ' · sem ' + usd(src.week.cost) + ' · mes ' + usd(src.month.cost)}</Text>
          ) : (
            <Text dimColor>Escaneando sesiones…</Text>
          )}
          <Text dimColor>{report ? 'todos los proyectos (semana) ' + usd(report.totals.week.cost) + ' · ' + report.projects.length + ' carpetas' : ''}</Text>
          {error && <Text dimColor>⚠ {error}</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {nav}
        {body}
      </Box>
    )
  })
}
