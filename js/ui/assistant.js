// Asistente VirtLab (ventana flotante): laboratorio activo, explicación de la última operación
// de red y topología en vivo. También el panel «Laboratorios» del Administrador y el modo instructor.
import { state, on, commit, getVm, logEvent, replaceState } from '../store.js';
import { LABS, labStatus, startLab, stopLab } from '../labs.js';
import { topology, segLabel, vmContent, linkOf } from '../net.js';
import { OS_TYPES, attachLabel } from '../catalog.js';
import { esc, clone } from '../util.js';
import { icon, osIcon } from './icons.js';
import { createWindow, getWindow, toast, msgBox, modal } from './wm.js';

let tab = 'lab';
const history = [];
let assistBody = null;

export function openAssistantWindow(focusTab) {
  if (focusTab) tab = focusTab;
  const r = document.getElementById('desktop').getBoundingClientRect();
  const w = createWindow({
    id: 'assistant', title: 'Asistente VirtLab', icon: 'assistant', w: 420, h: Math.min(620, r.height - 30),
    x: Math.max(10, r.width - 440), y: Math.max(6, r.height - Math.min(620, r.height - 30) - 14), minW: 300, minH: 260,
    content: (body) => { assistBody = body; body.innerHTML = '<div class="assist"><div class="tabs"></div><div class="assist-body"></div></div>'; renderAssistant(); },
    onResize: () => { if (tab === 'topo') renderAssistant(); },
  });
  renderAssistant();
  return w;
}

function renderAssistant() {
  if (!assistBody?.isConnected) return;
  const tabs = assistBody.querySelector('.tabs');
  tabs.innerHTML = [['lab', 'Laboratorio'], ['why', 'Explicación'], ['topo', 'Topología']].map(([id, l]) => `<button class="tab ${tab === id ? 'on' : ''}" data-t="${id}">${l}</button>`).join('');
  tabs.querySelectorAll('[data-t]').forEach((b) => { b.onclick = () => { tab = b.dataset.t; renderAssistant(); }; });
  const body = assistBody.querySelector('.assist-body');
  const scroll = body.scrollTop;
  if (tab === 'lab') body.innerHTML = labView();
  else if (tab === 'why') body.innerHTML = whyView();
  else body.innerHTML = topoView(body.clientWidth - 4);
  bindLab(body);
  if (tab !== 'why') body.scrollTop = scroll;
}

// ------------------------------------------------------------------ laboratorio activo
function labView() {
  const id = state.labs.active;
  const lab = LABS.find((l) => l.id === id);
  if (!lab) return `<p>No hay ningún laboratorio en curso.</p><p class="hint">Elige uno en <b>Herramientas › Laboratorios</b> del Administrador. Mientras tanto, este asistente te explica lo que ocurre con cada orden de red (pestaña «Explicación») y dibuja la red en vivo (pestaña «Topología»).</p><button class="btn primary" data-open-labs>Ver laboratorios</button>`;
  const st = labStatus(lab);
  const exam = state.labs.examMode;
  return `<h3 style="margin:0 0 4px;font-size:14px;display:flex;gap:6px;align-items:center">${icon('labs', 18)} ${esc(lab.title)}</h3>
  <div class="meta" style="display:flex;gap:6px;margin-bottom:8px"><span class="pill lvl${lab.level}">Nivel ${lab.level}</span><span class="pill">~${lab.minutes} min</span>${exam ? '<span class="pill lvl3">Modo examen</span>' : ''}</div>
  <p style="margin:0 0 8px;line-height:1.5">${esc(lab.intro)}</p>
  ${lab.objectives.map((o, i) => `<div class="obj ${st.done[i] ? 'done' : ''}" data-obj="${i}"><span class="box">${st.done[i] ? icon('check', 12) : ''}</span><div class="txt">${esc(o.text)}${exam ? '' : ` <button class="hintbtn" data-hint="${i}">Pista</button><div class="hinttxt">${esc(o.hint).replace(/\n/g, '<br>')}</div>`}</div></div>`).join('')}
  ${st.complete ? `<div class="lab-done"><b>¡Laboratorio completado!</b><br>Código de verificación para tu profesor:<br><span class="flag">${esc(lab.flag)}</span></div>` : `<p class="hint" style="margin-top:8px">${st.done.filter(Boolean).length} de ${lab.objectives.length} objetivos. Se comprueban solos mientras trabajas.</p>`}
  <div style="display:flex;gap:6px;margin-top:8px"><button class="btn small" data-stop-lab>Abandonar</button><button class="btn small" data-restart-lab="${lab.id}">Reiniciar progreso</button></div>`;
}

function bindLab(body) {
  body.querySelectorAll('[data-hint]').forEach((b) => { b.onclick = () => b.closest('.obj').classList.toggle('showhint'); });
  body.querySelectorAll('[data-open-labs]').forEach((b) => { b.onclick = () => import('./manager.js').then((m) => { m.selectTool('labs'); getWindow('manager')?.restore(); }); });
  body.querySelectorAll('[data-stop-lab]').forEach((b) => { b.onclick = () => stopLab(); });
  body.querySelectorAll('[data-restart-lab]').forEach((b) => { b.onclick = () => startLab(b.dataset.restartLab); });
}

// ------------------------------------------------------------------ explicaciones
on('didactic', (info) => {
  if (!state.prefs.didactic || state.labs.examMode) return;
  history.unshift({ ...info, t: Date.now() });
  if (history.length > 8) history.pop();
  if (getWindow('assistant') && tab === 'why') renderAssistant();
  const btn = document.querySelector('[data-tb="assistant"]');
  if (btn && !getWindow('assistant')) btn.classList.add('ping');
});

function whyView() {
  if (!state.prefs.didactic) return '<p>Las explicaciones están desactivadas (Archivo › Preferencias › Asistente didáctico).</p>';
  if (state.labs.examMode) return '<p>Modo examen activo: las explicaciones están ocultas.</p>';
  if (!history.length) return '<p>Ejecuta una orden de red en cualquier máquina o en la consola del anfitrión (ping, traceroute, curl, ssh, dhclient, apt…) y aquí verás qué camino sigue el paquete y por qué funciona o falla.</p>';
  return history.map((h, i) => explainBlock(h, i)).join('');
}
function explainBlock(h, i) {
  const ok = h.status === 'ok';
  const bad = h.status && h.status !== 'ok';
  const path = (h.path || []).filter((p, k, arr) => k === 0 || p.id !== arr[k - 1].id);
  const nodes = path.map((p, k) => `<span class="node ${k === path.length - 1 ? (ok ? 'good' : bad ? 'bad' : '') : ''}">${esc(p.name)}${p.ip ? ` <small>${esc(p.ip)}</small>` : ''}</span>`).join('<span class="arr">→</span>');
  return `<div class="explain ${i ? 'hist-item' : ''}"><h4>${icon(ok ? 'check' : bad ? 'warn' : 'info', 16)} ${esc(h.title || '')}</h4>${nodes ? `<div class="explain-path">${nodes}${bad && path.length ? '<span class="arr">✕</span>' : ''}</div>` : ''}${h.nat?.length ? `<div class="nat">NAT: ${h.nat.map(esc).join(' · ')}</div>` : ''}<ul>${(h.explain || []).map((e) => `<li>${esc(e)}</li>`).join('')}</ul><div class="hint">${new Date(h.t).toLocaleTimeString('es-ES')}</div></div>`;
}

// ------------------------------------------------------------------ topología
export function topoView(width = 380) {
  const T = topology(state);
  const segs = [...T.segs.entries()].filter(([k]) => k !== 'wan');
  // también los segmentos de VMs apagadas (configuración), para que se vea el plan de red
  const planned = new Map();
  for (const vm of state.vms) vm.nics.forEach((n) => {
    if (!n.enabled) return;
    const key = n.attach === 'nat' ? `nat:${vm.id}:${n.slot}` : n.attach === 'natnet' ? `natnet:${n.natnet}` : n.attach === 'bridged' ? 'lan' : n.attach === 'intnet' ? `intnet:${n.intnet}` : n.attach === 'hostonly' ? `hostonly:${n.hostonly}` : null;
    if (!key) return;
    if (!planned.has(key)) planned.set(key, []);
    planned.get(key).push({ vm, n });
  });
  const keys = [...new Set([...segs.map(([k]) => k), ...planned.keys()])].sort((a, b) => order(a) - order(b));
  const W = Math.max(300, width);
  let y = 14;
  let out = '';
  out += `<rect x="${W / 2 - 50}" y="${y}" width="100" height="26" rx="13" fill="#e3f0ff" stroke="#2a6fd6"/><text x="${W / 2}" y="${y + 17}" text-anchor="middle">☁ Internet</text>`;
  y += 44;
  for (const k of keys) {
    const live = T.segs.get(k) || [];
    const plan = planned.get(k) || [];
    const items = [];
    for (const m of live) items.push({ name: m.node.name, ip: m.iface.addrs.map((a) => a.ip).join(', ') || 'sin IP', kind: m.node.kind, on: true, os: m.node.vm?.osKey });
    for (const p of plan) if (!live.some((m) => m.node.vm === p.vm)) items.push({ name: p.vm.name, ip: p.vm.state === 'running' ? (p.n.cable ? 'sin enlace' : 'cable desconectado') : 'apagada', kind: 'vm', on: false, os: p.vm.osKey });
    const label = segLabel(state, k);
    const color = k === 'lan' ? '#2e7d32' : k.startsWith('nat:') ? '#6d4c41' : k.startsWith('natnet') ? '#8e24aa' : k.startsWith('intnet') ? '#ef6c00' : '#0277bd';
    const perRow = Math.max(1, Math.floor((W - 20) / 118));
    const rows = Math.ceil(items.length / perRow) || 1;
    out += `<text x="8" y="${y + 4}" class="seg-label" fill="${color}" style="fill:${color}">${esc(label)}</text>`;
    y += 12;
    out += `<line x1="8" y1="${y}" x2="${W - 8}" y2="${y}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`;
    items.forEach((it, i) => {
      const col = i % perRow; const row = Math.floor(i / perRow);
      const x = 10 + col * 118; const yy = y + 10 + row * 50;
      const lx = x + 8 + row * 10;
      out += `<line x1="${lx}" y1="${y}" x2="${lx}" y2="${yy}" stroke="${color}" stroke-width="1.4" ${it.on ? '' : 'stroke-dasharray="3 3"'}/>`;
    });
    items.forEach((it, i) => {
      const col = i % perRow; const row = Math.floor(i / perRow);
      const x = 10 + col * 118; const yy = y + 10 + row * 50;
      out += `<rect x="${x}" y="${yy}" width="108" height="38" rx="6" fill="${it.on ? 'var(--panel)' : 'var(--panel-3)'}" stroke="${it.on ? color : 'var(--line)'}"/>`;
      out += `<text x="${x + 6}" y="${yy + 15}" style="font-weight:600">${esc(short(it.name, 17))}</text><text x="${x + 6}" y="${yy + 30}" class="muted">${esc(short(it.ip, 19))}</text>`;
    });
    y += 10 + rows * 50 + 18;
  }
  if (!keys.length) out += `<text x="10" y="${y}" class="muted">No hay adaptadores de red habilitados.</text>`;
  return `<svg class="topo" viewBox="0 0 ${W} ${y + 10}" width="${W}" height="${y + 10}" role="img" aria-label="Topología de red">${out}</svg><p class="hint">Línea continua: equipo encendido y con enlace. Discontinua: máquina apagada o sin cable. El anfitrión aparece en la LAN y en cada red solo anfitrión; cada adaptador NAT tiene su propia red privada con el motor NAT de VirtualBox.</p>`;
}
const short = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const order = (k) => (k === 'lan' ? 0 : k.startsWith('hostonly') ? 1 : k.startsWith('natnet') ? 2 : k.startsWith('nat:') ? 3 : 4);

// ------------------------------------------------------------------ eventos de laboratorio
on('lab', () => renderAssistant());
on('change', () => { if (tab !== 'why') renderAssistant(); });
on('objective', ({ lab, i }) => { toast(`Objetivo cumplido: ${esc(lab.objectives[i].text)}`, { kind: 'ok', timeout: 5000 }); });
on('lab-complete', (lab) => {
  if (!getWindow('assistant')) openAssistantWindow('lab');
  msgBox({ kind: 'info', title: 'VirtLab - Laboratorio completado', text: `<p><b>¡Enhorabuena!</b> Has completado «${esc(lab.title)}».</p><p>Código de verificación: <span class="flag">${esc(lab.flag)}</span></p>` });
});

// ------------------------------------------------------------------ panel «Laboratorios» del Administrador
export function renderLabsPane(body) {
  const sub = state.view.labsTab || 'catalog';
  const prog = LABS.map((l) => labStatus(l));
  body.innerHTML = `<div class="welcome" style="max-width:1100px"><h1>${icon('labs', 26)} Laboratorios guiados</h1><p>Cada laboratorio plantea una situación real de clase. Los objetivos se comprueban automáticamente analizando la configuración de VirtualBox y lo que ejecutas en las consolas. Al terminar obtendrás un código de verificación.</p>
  <div class="tabs" style="margin-bottom:12px"><button class="tab ${sub === 'catalog' ? 'on' : ''}" data-lt="catalog">Catálogo</button><button class="tab ${sub === 'teacher' ? 'on' : ''}" data-lt="teacher">Modo instructor</button></div>
  ${sub === 'catalog' ? `<div class="cards">${LABS.map((l, i) => { const s = prog[i]; const n = s.done.filter(Boolean).length; return `<div class="card"><h4>${s.complete ? icon('check', 16) : icon('labs', 16)} ${esc(l.title)}</h4><div class="meta"><span class="pill lvl${l.level}">Nivel ${l.level}</span><span class="pill">~${l.minutes} min</span>${l.tags.map((t) => `<span class="pill">${esc(t)}</span>`).join('')}</div><p>${esc(l.summary)}</p><div style="display:flex;gap:6px;align-items:center;margin-top:4px">${s.complete ? '<span class="pill ok">Completado</span>' : s.started ? `<span class="pill">${n}/${l.objectives.length}</span>` : ''}<span style="flex:1"></span><button class="btn small ${state.labs.active === l.id ? '' : 'primary'}" data-start="${l.id}">${state.labs.active === l.id ? 'Continuar' : s.started ? 'Repetir' : 'Empezar'}</button></div></div>`; }).join('')}</div>` : teacherView()}
  </div>`;
  body.querySelectorAll('[data-lt]').forEach((b) => { b.onclick = () => { state.view.labsTab = b.dataset.lt; commit(); }; });
  body.querySelectorAll('[data-start]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.start;
      const lab = LABS.find((l) => l.id === id);
      if (state.labs.active !== id) {
        if (lab.setup) { const ok = await msgBox({ kind: 'warn', title: 'VirtLab', text: '<p>Este laboratorio modifica las máquinas de ejemplo (las apaga e introduce averías). ¿Continuar?</p><p class="hint">Si quieres conservar tu trabajo, exporta antes el laboratorio (Archivo › Exportar laboratorio).</p>', buttons: [{ label: 'Empezar', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }] }); if (!ok) return; }
        startLab(id);
      }
      openAssistantWindow('lab');
    };
  });
  bindTeacher(body);
}

const FAULTS = [
  ['cable', 'Desconectar el cable del adaptador 1'],
  ['none', 'Adaptador 1 «No conectado»'],
  ['wrongnet', 'Adaptador 1 en una red interna con otro nombre («intnet2»)'],
  ['netplan', 'Romper netplan / interfaces (error de sintaxis)'],
  ['dns', 'DNS incorrecto en el invitado'],
  ['icmp', 'Cortafuegos que bloquea el ping (ufw / Firewall de Windows)'],
  ['ssh', 'Detener y deshabilitar el servidor SSH'],
  ['iso', 'ISO olvidada en la unidad y arranque desde óptica'],
  ['hodhcp', 'Desactivar el DHCP de la red solo anfitrión'],
  ['bootorder', 'Quitar el disco duro del orden de arranque'],
];

function teacherView() {
  const vms = state.vms;
  return `<div class="grp" style="border:1px solid var(--line);border-radius:6px;padding:12px;margin-bottom:12px"><h3 style="margin:0 0 8px;font-size:14px">Inyectar averías</h3><div class="form-grid"><label>Máquina:</label><select id="t-vm">${vms.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select><label>Avería:</label><select id="t-fault">${FAULTS.map(([id, l]) => `<option value="${id}">${esc(l)}</option>`).join('')}</select><label></label><div><button class="btn primary small" id="t-apply">Aplicar avería</button> <span class="hint">La máquina se apaga para aplicar los cambios de hardware.</span></div></div></div>
  <div class="grp" style="border:1px solid var(--line);border-radius:6px;padding:12px;margin-bottom:12px"><h3 style="margin:0 0 8px;font-size:14px">Compartir el escenario</h3><p class="hint" style="margin:0 0 8px">Genera un enlace con el estado completo del laboratorio (máquinas, discos, redes y averías). Quien lo abra empezará exactamente desde aquí. Para escenarios grandes es preferible exportar el archivo .json.</p><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn small" id="t-link">Generar enlace</button><button class="btn small" id="t-json">Exportar .json</button><button class="btn small" id="t-import">Importar .json</button></div><textarea id="t-out" rows="3" style="width:100%;margin-top:8px;display:none" readonly></textarea></div>
  <div class="grp" style="border:1px solid var(--line);border-radius:6px;padding:12px"><h3 style="margin:0 0 8px;font-size:14px">Modo examen</h3><label class="chk"><input type="checkbox" id="t-exam" ${state.labs.examMode ? 'checked' : ''}> Ocultar pistas y explicaciones del Asistente</label><p class="hint" style="margin:8px 0 0">Progreso de la clase en este equipo: ${LABS.filter((l) => labStatus(l).complete).length} de ${LABS.length} laboratorios completados.</p></div>`;
}

function bindTeacher(body) {
  const g = (id) => body.querySelector(`#${id}`);
  if (!g('t-apply')) return;
  g('t-apply').onclick = async () => {
    const vm = getVm(g('t-vm').value);
    const f = g('t-fault').value;
    const { powerOff } = await import('../vmctl.js');
    if (vm.state !== 'poweroff') powerOff(vm);
    const c = vmContent(state, vm);
    const fam = OS_TYPES[c?.os]?.family;
    switch (f) {
      case 'cable': vm.nics[0].cable = false; break;
      case 'none': vm.nics[0].attach = 'none'; break;
      case 'wrongnet': vm.nics[0].attach = 'intnet'; vm.nics[0].intnet = 'intnet2'; break;
      case 'netplan': if (c?.files?.['/etc/netplan/50-cloud-init.yaml']) c.files['/etc/netplan/50-cloud-init.yaml'] = c.files['/etc/netplan/50-cloud-init.yaml'].replace('dhcp4: true', 'dhcp4 true'); else if (c?.files?.['/etc/network/interfaces']) c.files['/etc/network/interfaces'] = c.files['/etc/network/interfaces'].replace(/iface (\S+) inet dhcp/, 'iface $1 inet dchp'); break;
      case 'dns': if (fam === 'windows') c.win.adapters.Ethernet.dns = ['10.9.9.9']; else c.files['/etc/resolv.conf.user'] = 'nameserver 10.9.9.9\n'; break;
      case 'icmp': if (fam === 'windows') { c.win.fw.icmp = false; c.win.fw.rules = c.win.fw.rules.filter((r) => r.proto !== 'icmpv4'); } else { c.files['/etc/iptables/rules.v4'] = '# Generated by iptables-save v1.8.10\n*filter\n:INPUT ACCEPT [0:0]\n:FORWARD ACCEPT [0:0]\n:OUTPUT ACCEPT [0:0]\n-A INPUT -p icmp -j DROP\nCOMMIT\n'; } break;
      case 'ssh': if (c?.services?.ssh) c.services.ssh.enabled = false; break;
      case 'iso': { const s = vm.storage.flatMap((x) => x.slots).find((x) => x.kind === 'dvd'); const iso = state.media.dvd.find((m) => m.isoOs === c?.os) || state.media.dvd[0]; if (s && iso) s.medium = iso.id; const dvd = vm.hw.boot.find((b) => b.dev === 'dvd'); vm.hw.boot = [dvd, ...vm.hw.boot.filter((b) => b !== dvd)]; dvd.on = true; break; }
      case 'hodhcp': if (state.hostOnly[0]) state.hostOnly[0].dhcp.enabled = false; break;
      case 'bootorder': vm.hw.boot.find((b) => b.dev === 'hdd').on = false; break;
      default: break;
    }
    logEvent({ type: 'fault', vm: vm.id, fault: f });
    commit();
    toast(`Avería aplicada a «${esc(vm.name)}».`, { kind: 'ok' });
  };
  g('t-exam').onchange = () => { state.labs.examMode = g('t-exam').checked; commit(); };
  g('t-json').onclick = () => import('./actions.js').then((a) => a.exportLabFile());
  g('t-import').onclick = () => import('./actions.js').then((a) => a.importLabFile());
  g('t-link').onclick = async () => {
    const s = clone(state);
    s.events = []; s.labs.progress = {}; s.vms.forEach((v) => { v.log = []; if (v.state === 'running' || v.state === 'paused') { v.state = 'poweroff'; v.rt = null; } });
    const enc = await encodeState(s);
    const url = `${location.origin}${location.pathname}#escenario=${enc}`;
    const out = g('t-out');
    out.style.display = '';
    out.value = url;
    out.select();
    try { await navigator.clipboard.writeText(url); toast(`Enlace copiado al portapapeles (${Math.round(url.length / 1024)} KB).`, { kind: 'ok' }); } catch { toast('Copia el enlace del cuadro de texto.'); }
  };
}

export async function encodeState(s) {
  const json = JSON.stringify(s);
  if (typeof CompressionStream === 'undefined') return `j${btoa(unescape(encodeURIComponent(json)))}`;
  const cs = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = new Uint8Array(await new Response(cs).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `z${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}
export async function decodeState(enc) {
  if (enc[0] === 'j') return JSON.parse(decodeURIComponent(escape(atob(enc.slice(1)))));
  const b64 = enc.slice(1).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return JSON.parse(await new Response(ds).text());
}

export { replaceState };
