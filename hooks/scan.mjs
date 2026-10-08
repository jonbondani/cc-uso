#!/usr/bin/env node
// Escanea ~/.claude/projects/*.jsonl y emite por stdout un JSON con el uso
// agregado (hoy / semana / mes / todo), global y por proyecto. Sin dependencias.
// Lo invoca el mod cc-uso con:  node scan.mjs [projectsDir] [idleCapMin]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECTS_DIR = process.argv[2] || process.env.CLAUDE_PROJECTS_DIR
  || path.join(os.homedir(), '.claude', 'projects');
const IDLE_CAP_MS = Number(process.argv[3] || process.env.IDLE_CAP_MIN || 5) * 60_000;

// Precios de lista por millón de tokens (USD). ACTUALIZAR si cambian.
// [input, output, cacheWrite5m, cacheRead]. Fuente: precios Anthropic (oct-2026).
const PRICES = [
  { m: 'opus-4-1', p: [15, 75, 18.75, 1.5] },
  { m: 'claude-3-opus', p: [15, 75, 18.75, 1.5] },
  { m: 'fable', p: [10, 50, 12.5, 1.0] },
  { m: 'opus', p: [5, 25, 6.25, 0.5] },
  { m: 'sonnet', p: [3, 15, 3.75, 0.3] },
  { m: 'haiku-3', p: [0.25, 1.25, 0.3, 0.03] },
  { m: 'haiku', p: [1, 5, 1.25, 0.1] },
];
const DEFAULT_PRICE = [3, 15, 3.75, 0.3];
function rateFor(model) {
  const s = (model || '').toLowerCase();
  const hit = PRICES.find(x => s.includes(x.m));
  const p = hit ? hit.p : DEFAULT_PRICE;
  return { in: p[0] / 1e6, out: p[1] / 1e6, cw: p[2] / 1e6, cr: p[3] / 1e6 };
}
function prettyProject(cwd, folder) {
  if (cwd && typeof cwd === 'string') return path.basename(cwd) || cwd;
  const parts = String(folder).split('-').filter(Boolean);
  return parts[parts.length - 1] || folder;
}
function listJsonl(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsonl(full));
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function scan() {
  const events = [];
  const sessionTs = new Map();
  const sessionProj = new Map();
  for (const file of listJsonl(PROJECTS_DIR)) {
    const folder = path.basename(path.dirname(file));
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const ts = Date.parse(o.timestamp || o.message?.timestamp || '');
      if (!Number.isFinite(ts)) continue;
      const sessionId = o.sessionId || o.session_id || folder;
      const project = prettyProject(o.cwd, folder);
      sessionProj.set(sessionId, project);
      if (!sessionTs.has(sessionId)) sessionTs.set(sessionId, []);
      sessionTs.get(sessionId).push(ts);

      const msg = o.message || {};
      const content = Array.isArray(msg.content) ? msg.content : [];
      const u = msg.usage;
      if (u && (o.type === 'assistant' || msg.role === 'assistant')) {
        const r = rateFor(msg.model);
        const inTok = u.input_tokens || 0, outTok = u.output_tokens || 0;
        const cw = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0;
        const cost = inTok * r.in + outTok * r.out + cw * r.cw + cr * r.cr;
        events.push({ ts, project, sessionId, inTok, outTok, cacheTok: cw + cr, cost, toolRes: 0, toolErr: 0, activeMs: 0 });
      }
      let toolRes = 0, toolErr = 0;
      for (const b of content) {
        if (b?.type === 'tool_result') { toolRes++; if (b.is_error) toolErr++; }
      }
      if (toolRes) events.push({ ts, project, sessionId, inTok: 0, outTok: 0, cacheTok: 0, cost: 0, toolRes, toolErr, activeMs: 0 });
    }
  }
  for (const [sessionId, arr] of sessionTs) {
    arr.sort((a, b) => a - b);
    const project = sessionProj.get(sessionId);
    for (let i = 1; i < arr.length; i++) {
      const gap = Math.min(arr[i] - arr[i - 1], IDLE_CAP_MS);
      if (gap > 0) events.push({ ts: arr[i - 1], project, sessionId, inTok: 0, outTok: 0, cacheTok: 0, cost: 0, toolRes: 0, toolErr: 0, activeMs: gap });
    }
  }
  return events;
}

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
function startOfWeek(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return x.getTime(); }
function startOfMonth(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(1); return x.getTime(); }

function emptyAgg() { return { conv: new Set(), activeMs: 0, inTok: 0, outTok: 0, cacheTok: 0, cost: 0, toolRes: 0, toolErr: 0 }; }
function add(a, e) {
  a.conv.add(e.sessionId); a.activeMs += e.activeMs; a.inTok += e.inTok; a.outTok += e.outTok;
  a.cacheTok += e.cacheTok; a.cost += e.cost; a.toolRes += e.toolRes; a.toolErr += e.toolErr;
}
function fin(a) {
  return {
    conversations: a.conv.size, activeMs: a.activeMs, inTok: a.inTok, outTok: a.outTok,
    cacheTok: a.cacheTok, tokens: a.inTok + a.outTok + a.cacheTok, cost: a.cost,
    toolRes: a.toolRes, toolErr: a.toolErr,
    precision: a.toolRes > 0 ? 1 - a.toolErr / a.toolRes : null,
  };
}

function build() {
  const events = scan();
  const now = Date.now();
  const b = { day: startOfDay(now), week: startOfWeek(now), month: startOfMonth(now) };
  const totals = { day: emptyAgg(), week: emptyAgg(), month: emptyAgg(), all: emptyAgg() };
  const per = {};
  for (const e of events) {
    add(totals.all, e);
    if (e.ts >= b.month) add(totals.month, e);
    if (e.ts >= b.week) add(totals.week, e);
    if (e.ts >= b.day) add(totals.day, e);
    const pp = per[e.project] || (per[e.project] = { day: emptyAgg(), week: emptyAgg(), month: emptyAgg(), all: emptyAgg() });
    add(pp.all, e);
    if (e.ts >= b.month) add(pp.month, e);
    if (e.ts >= b.week) add(pp.week, e);
    if (e.ts >= b.day) add(pp.day, e);
  }
  return {
    generatedAt: now,
    projectsDir: PROJECTS_DIR,
    idleCapMin: IDLE_CAP_MS / 60000,
    totals: { day: fin(totals.day), week: fin(totals.week), month: fin(totals.month), all: fin(totals.all) },
    projects: Object.entries(per)
      .map(([name, w]) => ({ name, day: fin(w.day), week: fin(w.week), month: fin(w.month), all: fin(w.all) }))
      .sort((x, y) => y.all.cost - x.all.cost),
  };
}

process.stdout.write(JSON.stringify(build()));
