// Núcleo de los intérpretes: análisis de la línea (comillas, ;, &&, ||, |, >, >>),
// ejecución de tuberías y sesiones (incluidas las anidadas por SSH).
import { state, getVm, emit, logEvent, commit } from '../store.js';
import { vmContent } from '../net.js';
import { OS_TYPES } from '../catalog.js';

export function tokenize(line) {
  const toks = [];
  let cur = '';
  let q = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (c === '\\' && q === '"' && i + 1 < line.length && '"\\$'.includes(line[i + 1])) { cur += line[++i]; continue; }
      cur += c; continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === ' ' || c === '\t') { if (cur || has) { toks.push(cur); cur = ''; has = false; } continue; }
    const two = line.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '>>') { if (cur || has) { toks.push(cur); cur = ''; has = false; } toks.push({ op: two }); i++; continue; }
    if (c === '|' || c === ';' || c === '>') { if (cur || has) { toks.push(cur); cur = ''; has = false; } toks.push({ op: c }); continue; }
    cur += c;
  }
  if (q) throw new Error('unexpected EOF while looking for matching `' + q + "'");
  if (cur || has) toks.push(cur);
  return toks;
}

// Devuelve [{ op:'&&'|'||'|';'|null, pipeline:[{argv, redir:{file, append}}] }]
export function parse(line) {
  const toks = tokenize(line);
  const seq = [];
  let pipe = [];
  let cmd = { argv: [], redir: null };
  let joiner = null;
  const flushCmd = () => { if (cmd.argv.length || cmd.redir) pipe.push(cmd); cmd = { argv: [], redir: null }; };
  const flushPipe = (op) => { flushCmd(); if (pipe.length) seq.push({ op: joiner, pipeline: pipe }); pipe = []; joiner = op; };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (typeof t === 'object') {
      if (t.op === '|') { flushCmd(); continue; }
      if (t.op === '>' || t.op === '>>') { const f = toks[++i]; if (typeof f !== 'string') throw new Error("syntax error near unexpected token `newline'"); cmd.redir = { file: f, append: t.op === '>>' }; continue; }
      flushPipe(t.op);
      continue;
    }
    cmd.argv.push(t);
  }
  flushPipe(null);
  return seq;
}

// Utilidades de texto compartidas por Linux y Windows
export const textFilters = {
  grep(args, input) {
    let inv = false; let ign = false; let cnt = false; const pats = [];
    for (const a of args) { if (a.startsWith('-') && a.length > 1 && !pats.length) { if (a.includes('v')) inv = true; if (a.includes('i')) ign = true; if (a.includes('c')) cnt = true; if (a.includes('E')) { /* regex extendida */ } } else pats.push(a); }
    const p = pats[0] ?? '';
    let re;
    try { re = new RegExp(p, ign ? 'i' : ''); } catch { re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ign ? 'i' : ''); }
    const lines = input.filter((l) => re.test(l) !== inv);
    return cnt ? [String(lines.length)] : lines;
  },
  head(args, input) { const n = numArg(args, 10); return input.slice(0, n); },
  tail(args, input) { const n = numArg(args, 10); return input.slice(-n); },
  wc(args, input) {
    const l = input.length; const w = input.join(' ').split(/\s+/).filter(Boolean).length; const c = input.join('\n').length + (l ? 1 : 0);
    if (args.includes('-l')) return [String(l)];
    if (args.includes('-w')) return [String(w)];
    return [`${String(l).padStart(7)} ${String(w).padStart(7)} ${String(c).padStart(7)}`];
  },
  sort(args, input) { const r = [...input].sort(); return args.includes('-r') ? r.reverse() : r; },
  uniq(args, input) { return input.filter((l, i) => l !== input[i - 1]); },
  findstr(args, input) {
    const ign = args.some((a) => /^\/i$/i.test(a));
    const p = args.filter((a) => !a.startsWith('/')).join(' ').replace(/^"|"$/g, '');
    return input.filter((l) => (ign ? l.toLowerCase().includes(p.toLowerCase()) : l.includes(p)));
  },
};
function numArg(args, def) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n') return Number(args[i + 1]) || def;
    const m = args[i].match(/^-(\d+)$/); if (m) return Number(m[1]);
    const m2 = args[i].match(/^-n(\d+)$/); if (m2) return Number(m2[1]);
  }
  return def;
}

// ------------------------------------------------------------ sesiones
export function sessionContent(sess) {
  if (sess.kind !== 'vm') return null;
  return vmContent(state, getVm(sess.vmId));
}

export function makeCtx(term, sess, capture) {
  const ctx = {
    term, sess, st: state,
    get vm() { return sess.kind === 'vm' ? getVm(sess.vmId) : null; },
    get content() { return sessionContent(sess); },
    get rt() { return sess.kind === 'vm' ? getVm(sess.vmId)?.rt : null; },
    captured: capture ? [] : null,
    partial: '',
    out(text = '') {
      if (ctx.captured) {
        const s = ctx.partial + String(text);
        const parts = s.split('\n');
        ctx.partial = parts.pop();
        ctx.captured.push(...parts);
      } else term.print(text);
    },
    line(text = '') { ctx.out(`${text}\n`); },
    err(text) { if (ctx.captured && sess.os === 'never') ctx.line(text); else term.println(text, 'term-err'); },
    sleep: (ms) => term.sleep(ms),
    get aborted() { return term.aborted; },
    read: (p, o) => term.read(p, o),
    didactic(info) { emit('didactic', { sess, ...info }); },
    event(e) { logEvent({ from: sess.kind === 'vm' ? sess.vmId : 'host', user: sess.user, ...e }); },
    commit() { commit({ vm: sess.vmId }); },
    flushCapture() { if (ctx.partial) { ctx.captured.push(ctx.partial); ctx.partial = ''; } return ctx.captured; },
  };
  return ctx;
}

export function osFamilyOfSession(sess) {
  if (sess.kind === 'host') return 'windows';
  const c = sessionContent(sess);
  return OS_TYPES[c?.os]?.family || 'linux';
}
