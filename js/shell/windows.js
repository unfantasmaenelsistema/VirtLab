// Símbolo del sistema de Windows (en español) para invitados Windows y para el anfitrión,
// con un subconjunto de PowerShell y VBoxManage en el anfitrión.
import { parse, makeCtx, textFilters } from './core.js';
import { state, getVm, commit } from '../store.js';
import { OS_TYPES, WIN_IFNAMES, nicShort, ISOS } from '../catalog.js';
import { send, resolve, topology, vmContent, linkOf, dhcpLease, configureIface, HOST_ID, activePortForwards, vmListening } from '../net.js';
import { macDash, isIp, prefixToMask, maskToPrefix, parseCidr, sameNet, networkAddr, hashStr, nowStamp } from '../util.js';
import { PTR, jitter, httpGet, expandTargets, portName } from './netops.js';
import { linkLocal6 } from '../guest.js';
import { powerOff, rebootVm } from '../vmctl.js';
import { sshClient } from './linux.js';
import { vboxmanage } from './vboxmanage.js';

const VBOX_DIR = 'C:\\Program Files\\Oracle\\VirtualBox';

export function winPrompt(sess) { return sess.ps ? `PS ${sess.cwd}> ` : `${sess.cwd}>`; }

const isHost = (ctx) => ctx.sess.kind === 'host';
const isAdmin = (ctx) => ctx.sess.admin || (!isHost(ctx) && ctx.sess.elevated);

export async function runWindows(term, sess, line) {
  if (!line.trim()) return 0;
  let seq;
  try { seq = parse(line.replace(/\^/g, '')); } catch (e) { term.println(e.message, 'term-err'); return 1; }
  let last = 0;
  for (const item of seq) {
    if (item.op === '&&' && last !== 0) continue;
    if (item.op === '||' && last === 0) continue;
    let input = null;
    for (let i = 0; i < item.pipeline.length; i++) {
      const c = item.pipeline[i];
      const isLast = i === item.pipeline.length - 1;
      const ctx = makeCtx(term, sess, !isLast || !!c.redir);
      last = await runCmd(ctx, c.argv, input);
      if (!isLast) input = ctx.flushCapture();
      else if (c.redir) { const lines = ctx.flushCapture(); if (!isHost(ctx)) { const cont = ctx.content; cont.winFiles ||= {}; cont.winFiles[c.redir.file] = (c.redir.append ? cont.winFiles[c.redir.file] || '' : '') + lines.join('\r\n') + '\r\n'; commit(); } }
    }
    if (term.aborted) break;
  }
  if (!sess.exitRequested && !/^\s*(cls|clear|clear-host)\s*$/i.test(line)) term.println('');
  return last;
}

function notRecognized(ctx, cmd) {
  if (ctx.sess.ps) ctx.err(`${cmd} : El término '${cmd}' no se reconoce como nombre de un cmdlet, función, archivo de script o programa ejecutable.\nCompruebe si escribió correctamente el nombre o, si incluyó una ruta de acceso, compruebe que dicha ruta es correcta e inténtelo de nuevo.`);
  else ctx.err(`"${cmd}" no se reconoce como un comando interno o externo,\nprograma o archivo por lotes ejecutable.`);
  return 9009;
}

async function runCmd(ctx, argv, stdin) {
  if (!argv.length) return 0;
  let [cmd, ...args] = argv;
  const low = cmd.toLowerCase().replace(/\.exe$/, '');
  if (low.endsWith('vboxmanage') || low.endsWith('\\vboxmanage')) {
    if (!isHost(ctx)) return notRecognized(ctx, cmd);
    const inDir = ctx.sess.cwd.toLowerCase() === VBOX_DIR.toLowerCase();
    const full = cmd.toLowerCase().includes('program files\\oracle\\virtualbox');
    if (!inDir && !full && !state.host.vboxInPath) {
      notRecognized(ctx, cmd);
      ctx.didactic({ title: 'VBoxManage no está en el PATH', status: 'error', explain: ['El instalador de VirtualBox para Windows no añade su carpeta al PATH. Opciones:', `cd "${VBOX_DIR}"  y después  VBoxManage ...`, `o bien  "${VBOX_DIR}\\VBoxManage.exe" ...`, 'o añadir la carpeta al PATH:  setx PATH "%PATH%;C:\\Program Files\\Oracle\\VirtualBox"  (y abrir una consola nueva).'] });
      return 9009;
    }
    return vboxmanage(ctx, args);
  }
  const fn = CMDS[low] || (ctx.sess.ps ? PS[low] : null) || PS_ANY[low];
  if (!fn) return notRecognized(ctx, cmd);
  ctx.cmdName = low;
  try { const r = await fn(ctx, args, stdin); return typeof r === 'number' ? r : 0; }
  catch (e) { console.error(e); ctx.err(String(e.message || e)); return 1; }
}

// ------------------------------------------------------------------ modelo de interfaces
function winIfaces(ctx) {
  if (isHost(ctx)) {
    const h = state.host;
    const out = [{ name: 'Ethernet', desc: 'Intel(R) Ethernet Connection (17) I219-V', mac: h.eth.mac, up: h.eth.up, addrs: h.eth.up ? [{ ip: h.eth.ip, prefix: h.eth.prefix }] : [], gw: h.eth.gw, dns: h.dns || ['192.168.1.1'], dhcp: true, server: '192.168.1.1', suffix: 'home' }];
    out.push({ name: 'Wi-Fi', desc: 'Intel(R) Wi-Fi 6E AX211 160MHz', mac: h.wifi.mac, up: h.wifi.up, addrs: h.wifi.up && h.wifi.ip ? [{ ip: h.wifi.ip, prefix: 24 }] : [], dhcp: true });
    state.hostOnly.forEach((ho, k) => out.push({ name: k ? `Ethernet ${k + 2}` : 'Ethernet 2', desc: ho.name, mac: '0A0027000000', up: true, addrs: [{ ip: ho.ip, prefix: ho.prefix }], dhcp: false, gw: null, dns: [] }));
    return out;
  }
  const vm = ctx.vm;
  return vm.rt.ifaces.map((i) => {
    const nic = vm.nics[i.slot];
    const up = linkOf(state, vm, nic).up && !i.mediaDisconnected;
    const gw = vm.rt.routes.find((r) => r.dev === i.name && r.dst === '0.0.0.0')?.via || null;
    return { name: i.name, desc: `${nic.type === '82540EM' ? 'Intel(R) PRO/1000 MT Desktop Adapter' : nicShort(nic.type)}${i.slot ? ` #${i.slot + 1}` : ''}`, mac: nic.mac, up, addrs: i.addrs, gw, dns: i.dns || [], dhcp: !!i.cfg?.dhcp4, server: i.lease?.server, lease: i.lease, apipa: i.addrs.some((a) => a.apipa), suffix: i.lease ? 'home' : '' };
  });
}
const fromId = (ctx) => (isHost(ctx) ? HOST_ID : ctx.vm.id);
const hostname = (ctx) => (isHost(ctx) ? state.host.name : ctx.content.hostname);
const dots = (label, w = 44) => `   ${label} ${'. '.repeat(Math.max(1, Math.floor((w - label.length) / 2))).trimEnd()}${(label.length % 2 ? '' : ' ')}: `.replace(/ {2,}:/, ' :');

const CMDS = {};
const def = (names, fn) => names.split(' ').forEach((n) => { CMDS[n] = fn; });

def('help', (ctx) => {
  ctx.line('Para obtener más información acerca de un comando específico, escriba HELP nombre_de_comando\n');
  [['CD', 'Muestra el nombre del directorio actual o cambia de directorio.'], ['CLS', 'Borra la pantalla.'], ['DIR', 'Muestra una lista de archivos y subdirectorios.'], ['ECHO', 'Muestra mensajes.'], ['EXIT', 'Sale del programa CMD.EXE.'], ['HOSTNAME', 'Muestra el nombre del equipo.'], ['IPCONFIG', 'Configuración IP (/all, /release, /renew, /flushdns).'], ['PING', 'Comprueba la conectividad (-n, -t).'], ['TRACERT', 'Traza la ruta hasta un destino.'], ['NSLOOKUP', 'Consulta servidores DNS.'], ['ARP', 'Muestra la caché ARP (-a).'], ['ROUTE', 'Muestra la tabla de rutas (route print).'], ['NETSTAT', 'Conexiones y puertos (-an, -ano).'], ['NETSH', 'Configura interfaces y el Firewall de Windows.'], ['CURL', 'Cliente HTTP.'], ['SSH', 'Cliente OpenSSH.'], ['GETMAC', 'Direcciones MAC.'], ['SYSTEMINFO', 'Información del sistema.'], ['SHUTDOWN', 'Apaga o reinicia (/s /r /t 0).'], ['POWERSHELL', 'Abre Windows PowerShell (Test-NetConnection, Get-NetIPAddress...).'], ...(isHost(ctx) ? [['VBOXMANAGE', `CLI de VirtualBox (en ${VBOX_DIR}).`]] : [])].forEach(([a, b]) => ctx.line(`${a.padEnd(15)}${b}`));
});
def('cls clear', (ctx) => ctx.term.clear());
def('exit', (ctx) => { if (ctx.sess.ps) { ctx.sess.ps = false; return 0; } ctx.sess.exitRequested = true; });
def('ver', (ctx) => { ctx.line(`\nMicrosoft Windows [Versión ${isHost(ctx) ? '10.0.26100.2033' : OS_TYPES[ctx.content.os].build}]`); });
def('hostname', (ctx) => ctx.line(hostname(ctx)));
def('whoami', (ctx, a) => { const u = isHost(ctx) ? `${state.host.name.toLowerCase()}\\${state.host.user}` : `${ctx.content.hostname.toLowerCase()}\\${ctx.sess.user.toLowerCase()}`; ctx.line(a.includes('/groups') ? `${u}\n\nBUILTIN\\Administradores  ${isAdmin(ctx) ? 'Habilitado' : 'Grupo usado solo para denegar'}` : u); });
def('echo', (ctx, a) => ctx.line(a.join(' ') || 'ECHO está activado.'));
def('cd chdir', (ctx, a) => {
  if (!a.length) { ctx.line(ctx.sess.cwd); return; }
  let p = a.join(' ').replace(/^\/d\s+/i, '').replace(/"/g, '');
  if (p === '..') { const parts = ctx.sess.cwd.split('\\'); if (parts.length > 1) parts.pop(); ctx.sess.cwd = parts.join('\\') || 'C:\\'; if (/^[A-Z]:$/.test(ctx.sess.cwd)) ctx.sess.cwd += '\\'; return; }
  if (p === '\\') { ctx.sess.cwd = 'C:\\'; return; }
  if (!/^[A-Za-z]:/.test(p)) p = `${ctx.sess.cwd.replace(/\\$/, '')}\\${p}`;
  const known = [VBOX_DIR, 'C:\\', 'C:\\Windows', 'C:\\Windows\\System32', 'C:\\Users', `C:\\Users\\${isHost(ctx) ? state.host.user : ctx.sess.user}`, `C:\\Users\\${isHost(ctx) ? state.host.user : ctx.sess.user}\\Desktop`, `C:\\Users\\${isHost(ctx) ? state.host.user : ctx.sess.user}\\Documents`, `C:\\Users\\${isHost(ctx) ? state.host.user : ctx.sess.user}\\Downloads`, 'C:\\Program Files', 'C:\\Program Files\\Oracle', ...(isHost(ctx) ? [state.prefs.machineFolder, 'C:\\Users\\alumno\\Downloads\\ISO', ...state.vms.map((v) => v.folder), ...Object.keys(state.hostFiles.shared || {})] : [])];
  const hit = known.find((k) => k.toLowerCase() === p.toLowerCase());
  if (!hit) { ctx.err('El sistema no puede encontrar la ruta especificada.'); return 1; }
  ctx.sess.cwd = hit;
});
def('dir', (ctx) => {
  const cwd = ctx.sess.cwd;
  ctx.line(` El volumen de la unidad C no tiene etiqueta.\n El número de serie del volumen es: 6A1C-2F0B\n\n Directorio de ${cwd}\n`);
  const rows = [];
  const d = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const lc = cwd.toLowerCase();
  if (isHost(ctx)) {
    if (lc === VBOX_DIR.toLowerCase()) ['VBoxManage.exe', 'VirtualBox.exe', 'VirtualBoxVM.exe', 'VBoxHeadless.exe', 'VBoxSVC.exe', 'VBoxNetDHCP.exe', 'VBoxNetNAT.exe'].forEach((f) => rows.push([f, 1024 + hashStr(f) % 9000]));
    if (lc === 'c:\\users\\alumno\\downloads\\iso') ISOS.forEach((i) => rows.push([i.file, i.sizeMB * 1048576]));
    if (lc === state.prefs.machineFolder.toLowerCase()) state.vms.forEach((v) => rows.push([v.name, '<DIR>']));
    const vm = state.vms.find((v) => v.folder.toLowerCase() === lc);
    if (vm) { rows.push([`${vm.name}.vbox`, 4211], ['Logs', '<DIR>']); state.media.hdd.filter((m) => m.path.toLowerCase().startsWith(lc + '\\')).forEach((m) => rows.push([m.name, Math.round(m.usedGB * 1024 * 1024)])); }
    for (const [path, files] of Object.entries(state.hostFiles.shared || {})) if (path.toLowerCase() === lc) files.forEach((f) => rows.push([f.name, (f.text || '').length || f.size || 0]));
    if (lc === 'c:\\users\\alumno\\documents') state.hostFiles.ova.forEach((o) => rows.push([o.file, o.sizeMB * 1024 * 1024]));
  } else {
    for (const [f, t] of Object.entries(ctx.content.winFiles || {})) rows.push([f, t.length]);
  }
  rows.forEach(([n, s]) => ctx.line(`${d}  10:00    ${s === '<DIR>' ? '<DIR>          ' : String(s).padStart(14)} ${n}`));
  ctx.line(`               ${rows.filter((r) => r[1] !== '<DIR>').length} archivos\n               ${rows.filter((r) => r[1] === '<DIR>').length + 2} dirs  312.204.517.376 bytes libres`);
});
def('type', (ctx, a) => {
  const f = a.join(' ');
  if (/hosts$/i.test(f)) { ctx.line('# Copyright (c) 1993-2009 Microsoft Corp.\n#\n# This is a sample HOSTS file used by Microsoft TCP/IP for Windows.\n#\n# localhost name resolution is handled within DNS itself.\n#\t127.0.0.1       localhost\n#\t::1             localhost'); return; }
  const t = !isHost(ctx) && ctx.content.winFiles?.[f];
  if (t) { ctx.out(t.replace(/\r\n/g, '\n')); return; }
  for (const files of Object.values(state.hostFiles.shared || {})) { const x = files.find((y) => y.name.toLowerCase() === f.toLowerCase() || f.toLowerCase().endsWith('\\' + y.name.toLowerCase())); if (x && isHost(ctx)) { ctx.line(x.text || ''); return; } }
  ctx.err('El sistema no puede encontrar el archivo especificado.'); return 1;
});
def('find findstr', (ctx, a, stdin) => { textFilters.findstr(a, stdin || []).forEach((l) => ctx.line(l)); });
def('more', (ctx, a, stdin) => { (stdin || []).forEach((l) => ctx.line(l)); });
def('getmac', (ctx) => {
  ctx.line('\nDirección física    Nombre de transporte\n=================== ==========================================================');
  winIfaces(ctx).forEach((i) => ctx.line(`${macDash(i.mac).padEnd(20)}${i.up ? `\\Device\\Tcpip_{${(hashStr(i.name) >>> 0).toString(16).toUpperCase().padStart(8, '0')}-1D2E-4F6A-8B9C-0A1B2C3D4E5F}` : 'Medios desconectados'}`));
});
def('systeminfo', (ctx) => {
  const h = isHost(ctx);
  const os = h ? { label: 'Windows 11 Pro', build: '10.0.26100' } : OS_TYPES[ctx.content.os];
  const ifs = winIfaces(ctx);
  ctx.line(`\nNombre de host:                            ${hostname(ctx)}\nNombre del sistema operativo:              Microsoft ${os.label}\nVersión del sistema operativo:             ${(os.build || '').split('.').slice(0, 3).join('.')} N/D Compilación ${(os.build || '').split('.')[2]}\nFabricante del sistema operativo:          Microsoft Corporation\nFabricante del sistema:                    ${h ? 'Dell Inc.' : 'innotek GmbH'}\nModelo el sistema:                         ${h ? 'OptiPlex 7010' : 'VirtualBox'}\nTipo de sistema:                           x64-based PC\nProcesador(es):                            ${h ? state.host.cpus : ctx.vm.hw.cpus} Procesadores instalados.\nVersión del BIOS:                          ${h ? 'Dell Inc. 1.14.0' : 'innotek GmbH VirtualBox, 01/12/2006'}\nCantidad total de memoria física:          ${(h ? state.host.ramMB : ctx.vm.hw.ramMB).toLocaleString('es-ES')} MB\nTarjeta(s) de red:                         ${ifs.length} Tarjetas de interfaz de red instaladas.`);
  ifs.forEach((i, k) => ctx.line(`                                           [${String(k + 1).padStart(2, '0')}]: ${i.desc}\n                                                 Nombre de conexión: ${i.name}${i.up ? `\n                                                 DHCP habilitado:    ${i.dhcp ? 'Sí' : 'No'}${i.addrs[0] ? `\n                                                 Direcciones IP\n                                                 [01]: ${i.addrs[0].ip}` : ''}` : '\n                                                 Estado:             Medios desconectados'}`));
  ctx.line(`Requisitos Hyper-V:                        ${h ? 'Se detectó un hipervisor. No se mostrarán las características necesarias para Hyper-V.' : 'Se detectó un hipervisor.'}`);
});
def('tasklist', (ctx) => {
  ctx.line('\nNombre de imagen               PID Nombre de sesión Núm. de ses Uso de memoria\n========================= ======== ================ =========== ===============');
  const list = [['System', 4], ['svchost.exe', 1012], ['explorer.exe', 4412], ['cmd.exe', 6120]];
  if (isHost(ctx)) { list.push(['VBoxSVC.exe', 7204], ['VirtualBox.exe', 7310]); state.vms.filter((v) => v.state === 'running').forEach((v, k) => list.push([v.rt?.headless ? 'VBoxHeadless.exe' : 'VirtualBoxVM.exe', 8100 + k * 37])); }
  list.forEach(([n, p]) => ctx.line(`${n.padEnd(25)} ${String(p).padStart(8)} Console                    1 ${String(10000 + hashStr(n) % 90000).padStart(10)} KB`));
});
def('shutdown', async (ctx, a) => {
  const args = a.map((x) => x.toLowerCase());
  if (isHost(ctx)) { ctx.line('(VirtLab no apaga el equipo anfitrión)'); return 0; }
  if (args.includes('/s') || args.includes('-s') || args.includes('/p')) { await ctx.sleep(300); powerOff(ctx.vm, 'acpi'); return 0; }
  if (args.includes('/r') || args.includes('-r')) { await ctx.sleep(300); rebootVm(ctx.vm); return 0; }
  ctx.line('Uso: shutdown [/i | /l | /s | /sg | /r | /g | /a | /p | /h | /e | /o] [/hybrid] [/soft] [/fw] [/f]\n    [/m \\\\equipo][/t xxx][/d [p|u:]xx:yy [/c "comentario"]]');
});

// ------------------------------------------------------------------ ipconfig
def('ipconfig', async (ctx, a) => {
  const all = a.some((x) => /^[/-]all$/i.test(x));
  const sub = a.find((x) => /^[/-](release|renew|flushdns|displaydns)$/i.test(x))?.slice(1).toLowerCase();
  if (sub === 'flushdns') { ctx.line('\nConfiguración IP de Windows\n\nSe vació correctamente la caché de resolución de DNS.'); return 0; }
  if (sub === 'displaydns') { ctx.line('\nConfiguración IP de Windows\n'); return 0; }
  if (sub === 'release' || sub === 'renew') {
    if (isHost(ctx)) { ctx.line('\nConfiguración IP de Windows\n\n(VirtLab no permite renovar la IP del anfitrión)'); return 0; }
    const filt = a.find((x) => !x.startsWith('/') && !x.startsWith('-'));
    const vm = ctx.vm;
    ctx.line('\nConfiguración IP de Windows\n');
    for (const i of vm.rt.ifaces) {
      if (filt && i.name.toLowerCase() !== filt.replace(/"/g, '').toLowerCase()) continue;
      const nic = vm.nics[i.slot];
      const link = linkOf(state, vm, nic).up;
      if (!i.cfg?.dhcp4) { if (filt) ctx.line(`El adaptador ${i.name} no tiene DHCP habilitado.`); continue; }
      if (!link) { ctx.line(`No se puede realizar ninguna operación en ${i.name} mientras los medios estén desconectados.`); continue; }
      if (sub === 'release') { i.addrs = []; vm.rt.routes = vm.rt.routes.filter((r) => r.dev !== i.name); i.lease = null; continue; }
      if (!(await ctx.sleep(1200))) return 130;
      const l = dhcpLease(state, vm, i.slot);
      if (!l) {
        if (!(await ctx.sleep(1800))) return 130;
        ctx.line(`Error al renovar la interfaz ${i.name} : no se puede contactar con el servidor DHCP. Se agotó el tiempo de espera de la solicitud.`);
        configureIface(state, vm, i, i.cfg, 'windows');
        ctx.didactic({ title: `DHCP en ${i.name}`, status: 'dhcp-fail', explain: ['Ningún servidor DHCP responde en esa red, así que Windows se autoasigna una dirección APIPA 169.254.x.x/16 (sin puerta de enlace). Solo sirve para hablar con otros equipos APIPA del mismo segmento.'] });
        ctx.event({ type: 'dhcp', dev: i.name, ok: false });
        continue;
      }
      configureIface(state, vm, i, i.cfg, 'windows');
      ctx.didactic({ title: `DHCP (DORA) en ${i.name}`, status: 'ok', explain: [`DISCOVER → OFFER → REQUEST → ACK con el ${l.label} (${l.server}).`, `Concesión: ${l.ip}/${l.prefix}${l.gw ? `, puerta de enlace ${l.gw}` : ', sin puerta de enlace'}${l.dns.length ? `, DNS ${l.dns.join(', ')}` : ''}.`] });
      ctx.event({ type: 'dhcp', dev: i.name, ok: true, ip: l.ip });
    }
    commit();
  } else ctx.line('\nConfiguración IP de Windows\n');
  if (all) ctx.line(`   Nombre de host. . . . . . . . . : ${hostname(ctx)}\n   Sufijo DNS principal  . . . . . : \n   Tipo de nodo. . . . . . . . . . : híbrido\n   Enrutamiento IP habilitado. . . : no\n   Proxy WINS habilitado . . . . . : no\n   Lista de búsqueda de sufijos DNS: home\n`);
  for (const i of winIfaces(ctx)) {
    ctx.line(`Adaptador de ${/wi-?fi/i.test(i.name) ? 'LAN inalámbrica' : 'Ethernet'} ${i.name}:\n`);
    if (!i.up) { ctx.line('   Estado de los medios. . . . . . . . . . . : medios desconectados\n   Sufijo DNS específico para la conexión. . : '); if (all) ctx.line(`   Descripción . . . . . . . . . . . . . . . : ${i.desc}\n   Dirección física. . . . . . . . . . . . . : ${macDash(i.mac)}\n   DHCP habilitado . . . . . . . . . . . . . : ${i.dhcp ? 'sí' : 'no'}\n   Configuración automática habilitada . . . : sí`); ctx.line(''); continue; }
    ctx.line(`   Sufijo DNS específico para la conexión. . : ${i.suffix || ''}`);
    if (all) ctx.line(`   Descripción . . . . . . . . . . . . . . . : ${i.desc}\n   Dirección física. . . . . . . . . . . . . : ${macDash(i.mac)}\n   DHCP habilitado . . . . . . . . . . . . . : ${i.dhcp ? 'sí' : 'no'}\n   Configuración automática habilitada . . . : sí`);
    ctx.line(`   Vínculo: dirección IPv6 local. . . : ${linkLocal6(i.mac)}%${5 + winIfaces(ctx).indexOf(i)}${all ? '(Preferido)' : ''}`);
    for (const ad of i.addrs) {
      if (ad.apipa) ctx.line(`   Dirección IPv4 de configuración automática: ${ad.ip}${all ? '(Preferido)' : ''}`);
      else ctx.line(`   Dirección IPv4. . . . . . . . . . . . . . : ${ad.ip}${all ? '(Preferido)' : ''}`);
      ctx.line(`   Máscara de subred . . . . . . . . . . . . : ${prefixToMask(ad.prefix)}`);
    }
    if (all && i.lease) { ctx.line(`   Concesión obtenida. . . . . . . . . . . . : ${new Date(i.lease.at).toLocaleString('es-ES', { dateStyle: 'full', timeStyle: 'medium' })}\n   La concesión expira . . . . . . . . . . . : ${new Date(i.lease.at + i.lease.time * 1000).toLocaleString('es-ES', { dateStyle: 'full', timeStyle: 'medium' })}`); }
    ctx.line(`   Puerta de enlace predeterminada . . . . . : ${i.gw || ''}`);
    if (all) {
      if (i.lease || (isHost(ctx) && i.server)) ctx.line(`   Servidor DHCP . . . . . . . . . . . . . . : ${i.lease?.server || i.server}`);
      ctx.line(`   Servidores DNS. . . . . . . . . . . . . . : ${(i.dns || []).join('\n                                               ') || 'fec0:0:0:ffff::1%1'}\n   NetBIOS sobre TCP/IP. . . . . . . . . . . : habilitado`);
    }
    ctx.line('');
  }
});

// ------------------------------------------------------------------ ping / tracert
def('ping', async (ctx, a) => {
  let count = 4; let forever = false; let target = null;
  for (let i = 0; i < a.length; i++) {
    const x = a[i].toLowerCase();
    if (x === '-n' || x === '/n') count = Number(a[++i]) || 4;
    else if (x === '-t' || x === '/t') forever = true;
    else if (x === '-4' || x === '-a') continue;
    else if (x === '-l' || x === '-w' || x === '-i') i++;
    else if (!x.startsWith('-') && !x.startsWith('/')) target = a[i];
  }
  if (!target) { ctx.line('\nUso: ping [-t] [-a] [-n cuenta] [-l tamaño] [-f] [-i TTL] [-v TOS]\n            [-r cuenta] [-s cuenta] [[-j lista-host] | [-k lista-host]]\n            [-w tiempo de espera] [-R] [-S srcaddr] [-c compartimiento]\n            [-p] [-4] [-6] nombre_destino'); return 1; }
  let ip = target;
  if (!isIp(target)) {
    const r = resolve(state, fromId(ctx), target);
    if (r.error) { if (r.error === 'timeout') await ctx.sleep(1500); ctx.line(`La solicitud de ping no pudo encontrar el host ${target}. Compruebe el nombre y vuelva a intentarlo.`); ctx.event({ type: 'dns', name: target, ok: false }); return 1; }
    ip = r.ip;
  }
  const first = send(state, fromId(ctx), ip);
  if (first.status === 'noroute') {
    ctx.line(`\nHaciendo ping a ${ip} con 32 bytes de datos:`);
    for (let k = 0; k < count; k++) { ctx.line('PING: error en la transmisión. Error general. '); if (k < count - 1 && !(await ctx.sleep(400))) break; }
    ctx.line(`\nEstadísticas de ping para ${ip}:\n    Paquetes: enviados = ${count}, recibidos = 0, perdidos = ${count}\n    (100% perdidos),`);
    explain(ctx, `ping ${target}`, first);
    ctx.event({ type: 'ping', dst: ip, ok: false, status: 'noroute' });
    return 1;
  }
  ctx.line(`\nHaciendo ping a ${isIp(target) ? ip : `${target} [${ip}]`} con 32 bytes de datos:`);
  let sent = 0; let recv = 0; let lost = 0; const times = []; let last = first;
  while (forever || sent < count) {
    const r = sent === 0 ? first : send(state, fromId(ctx), ip);
    last = r; sent++;
    if (r.status === 'ok' && !(r.conflict && Math.random() < 0.45)) {
      const ms = jitter(Math.max(0.2, r.rtt), Math.random());
      times.push(ms); recv++;
      ctx.line(`Respuesta desde ${ip}: bytes=32 tiempo${ms < 1 ? '<1m' : `=${Math.floor(ms)}m`}s TTL=${r.ttl}`);
    } else if (r.status === 'host_unreach' || r.status === 'net_unreach') {
      recv++;
      if (!(await ctx.sleep(r.status === 'host_unreach' ? 1800 : 50))) break;
      ctx.line(`Respuesta desde ${r.errFrom || r.srcIp}: Host de destino inaccesible.`);
    } else {
      lost++;
      if (!(await ctx.sleep(2600))) break;
      ctx.line('Tiempo de espera agotado para esta solicitud.');
    }
    if (!forever && sent >= count) break;
    if (!(await ctx.sleep(700))) break;
  }
  const perd = sent - recv;
  ctx.line(`\nEstadísticas de ping para ${ip}:\n    Paquetes: enviados = ${sent}, recibidos = ${recv}, perdidos = ${perd}\n    (${Math.round((perd / sent) * 100)}% perdidos),`);
  if (times.length) ctx.line(`Tiempos aproximados de ida y vuelta en milisegundos:\n    Mínimo = ${Math.floor(Math.min(...times))}ms, Máximo = ${Math.floor(Math.max(...times))}ms, Media = ${Math.floor(times.reduce((x, y) => x + y, 0) / times.length)}ms`);
  if (ctx.term.aborted) ctx.line('Control-C\n^C');
  explain(ctx, `ping ${target}`, last);
  ctx.event({ type: 'ping', dst: ip, name: target, ok: times.length > 0, status: last.status, target: last.target?.id, recv: times.length, conflict: !!(first.conflict || last.conflict) });
  return times.length ? 0 : 1;
});
function explain(ctx, title, res, extra = []) { ctx.didactic({ title, explain: [...extra, ...(res?.explain || [])], path: res?.path || [], nat: res?.nat || [], status: res?.status }); }

def('tracert', async (ctx, a) => {
  const target = a.filter((x) => !x.startsWith('-') && !x.startsWith('/')).pop();
  if (!target) { ctx.line('\nUso: tracert [-d] [-h saltos_máximos] [-j lista_de_hosts] [-w tiempo_de_espera]\n               [-R] [-S srcaddr] [-4] [-6] nombre_destino'); return 1; }
  let ip = target;
  if (!isIp(target)) { const r = resolve(state, fromId(ctx), target); if (r.error) { ctx.line(`No se puede resolver el nombre de destino ${target}.`); return 1; } ip = r.ip; }
  const res = send(state, fromId(ctx), ip);
  if (res.status === 'noroute') { ctx.line(`\nTraza a ${ip} sobre caminos de 30 saltos como máximo.\n\n  1     Error general.\n\nTraza completa.`); explain(ctx, `tracert ${target}`, res); return 1; }
  ctx.line(`\nTraza a ${PTR[ip] && !isIp(target) ? `${target} [${ip}]` : PTR[ip] ? `${PTR[ip]} [${ip}]` : ip}\nsobre un máximo de 30 saltos:\n`);
  let acc = 0; let n = 0;
  const ms = (v) => (v < 1 ? '  <1 ms' : `${String(Math.round(v)).padStart(4)} ms`);
  for (const h of res.hops) {
    n++; acc += h.ip.startsWith('10.0.') ? 0.4 : h.ip.startsWith('192.168.') ? 1.4 : 2.6;
    const t = [0, 1, 2].map(() => ms(jitter(acc, Math.random())));
    ctx.line(`${String(n).padStart(3)} ${t.join(' ')}  ${PTR[h.ip] ? `${PTR[h.ip]} [${h.ip}]` : h.ip} `);
    if (!(await ctx.sleep(450))) return 130;
  }
  if (res.status === 'ok') { n++; const t = [0, 1, 2].map(() => ms(jitter(Math.max(res.rtt, acc + 0.5), Math.random()))); ctx.line(`${String(n).padStart(3)} ${t.join(' ')}  ${PTR[ip] ? `${PTR[ip]} [${ip}]` : ip} `); }
  else if (res.status === 'host_unreach' || res.status === 'net_unreach') { n++; ctx.line(`${String(n).padStart(3)}  ${res.errFrom || res.srcIp}  informes: Host de destino inaccesible.`); }
  else for (let k = n + 1; k <= 30; k++) { ctx.line(`${String(k).padStart(3)}     *        *        *     Tiempo de espera agotado para esta solicitud.`); if (!(await ctx.sleep(260))) return 130; }
  ctx.line('\nTraza completa.');
  explain(ctx, `tracert ${target}`, res);
  ctx.event({ type: 'trace', dst: ip, ok: res.status === 'ok', hops: res.hops.length });
});

def('nslookup', async (ctx, a) => {
  const name = a.find((x) => !x.startsWith('-'));
  const server = a.filter((x) => !x.startsWith('-'))[1];
  const ifs = winIfaces(ctx).filter((i) => i.up);
  const dns = server ? [server] : (isHost(ctx) ? (state.host.dns || ['192.168.1.1']) : ifs.flatMap((i) => i.dns || []));
  const srv = dns[0];
  if (!srv) { ctx.line(`*** No se puede encontrar el nombre de servidor para la dirección 127.0.0.1: No existe el dominio.\nServidor predeterminado:  UnKnown\nAddress:  ::1\n`); }
  if (!name) { ctx.line(`Servidor predeterminado:  ${srv === '192.168.1.1' ? 'router.home' : 'UnKnown'}\nAddress:  ${srv}\n\n> (el modo interactivo no está disponible en VirtLab)`); return 0; }
  const r = resolve(state, fromId(ctx), name, server ? { server } : {});
  if (r.error === 'timeout' || r.error === 'noservers') { await ctx.sleep(2000); ctx.line(`DNS request timed out.\n    timeout was 2 seconds.\nServidor:  UnKnown\nAddress:  ${srv || '::1'}\n\nDNS request timed out.\n    timeout was 2 seconds.\n*** Se agotó el tiempo de espera de la solicitud a UnKnown`); ctx.event({ type: 'dns', name, ok: false }); return 1; }
  ctx.line(`Servidor:  ${srv === '192.168.1.1' ? 'router.home' : 'UnKnown'}\nAddress:  ${srv}\n`);
  if (r.error) { ctx.line(`*** ${srv === '192.168.1.1' ? 'router.home' : 'UnKnown'} no encuentra ${name}: Non-existent domain`); ctx.event({ type: 'dns', name, ok: false }); return 1; }
  ctx.line(`Respuesta no autoritativa:\nNombre:  ${name}\nAddress:  ${r.ip}\n`);
  ctx.event({ type: 'dns', name, ok: true, ip: r.ip });
});

def('arp', (ctx, a) => {
  if (!a.length || !/^[-/]a$/i.test(a[0]) && !/^-g$/i.test(a[0])) { ctx.line('\nMuestra y modifica las tablas de conversión de direcciones IP en direcciones\nfísicas usadas por el protocolo de resolución de direcciones (ARP).\n\nARP -s inet_addr eth_addr [if_addr]\nARP -d inet_addr [if_addr]\nARP -a [inet_addr] [-N if_addr] [-v]'); return 0; }
  const T = topology(state);
  const me = T.nodes.get(fromId(ctx));
  me.ifaces.filter((i) => i.link && i.addrs.length).forEach((i, k) => {
    ctx.line(`\nInterfaz: ${i.addrs[0].ip} --- 0x${(k + 5).toString(16)}\n  Dirección de Internet          Dirección física      Tipo`);
    for (const m of T.segs.get(i.seg) || []) if (m.node !== me && m.iface.addrs[0] && (m.node.kind !== 'vm' || Math.random() < 2)) ctx.line(`  ${m.iface.addrs[0].ip.padEnd(31)}${macDash(m.iface.mac || '000000000000').toLowerCase().padEnd(22)}dinámico`);
    const b = i.addrs[0];
    ctx.line(`  ${(networkAddr(b.ip, b.prefix).replace(/\.0$/, '.255')).padEnd(31)}ff-ff-ff-ff-ff-ff     estático\n  224.0.0.22                     01-00-5e-00-00-16     estático\n  239.255.255.250                01-00-5e-7f-ff-fa     estático`);
  });
});

def('route', (ctx, a) => {
  if ((a[0] || '').toLowerCase() !== 'print') { ctx.line('\nManipula tablas de enrutamiento de red.\n\nROUTE [-f] [-p] [-4|-6] command [destination]\n                  [MASK netmask]  [gateway] [METRIC metric]  [IF interface]\n\n  command      Especifica uno de estos:\n                 PRINT     Imprime una ruta\n                 ADD       Agrega una ruta\n                 DELETE    Elimina una ruta'); return 0; }
  const ifs = winIfaces(ctx).filter((i) => i.up);
  ctx.line('===========================================================================\nLista de interfaces');
  ifs.forEach((i, k) => ctx.line(`  ${String(k + 5).padStart(2)}...${macDash(i.mac).toLowerCase().replace(/-/g, ' ')} ......${i.desc}`));
  ctx.line('  1...........................Software Loopback Interface 1\n===========================================================================\n\nIPv4 Tabla de enrutamiento\n===========================================================================\nRutas activas:\nDestino de red        Máscara de red   Puerta de enlace   Interfaz  Métrica');
  for (const i of ifs) if (i.gw && i.addrs[0]) ctx.line(`          0.0.0.0          0.0.0.0${i.gw.padStart(19)}${i.addrs[0].ip.padStart(17)}     25`);
  ctx.line('        127.0.0.0        255.0.0.0         En vínculo         127.0.0.1    331');
  for (const i of ifs) for (const ad of i.addrs) ctx.line(`${networkAddr(ad.ip, ad.prefix).padStart(17)}${prefixToMask(ad.prefix).padStart(17)}         En vínculo${ad.ip.padStart(18)}    281`);
  ctx.line('===========================================================================\nRutas persistentes:\n  Ninguno');
});

def('netstat', (ctx, a) => {
  const flags = a.join('').toLowerCase();
  if (flags.includes('r')) { CMDS.route(ctx, ['print']); return; }
  ctx.line('\nConexiones activas\n\n  Proto  Dirección local          Dirección remota         Estado' + (flags.includes('o') ? '           PID' : ''));
  const L = isHost(ctx) ? [{ proto: 'tcp', port: 135 }, { proto: 'tcp', port: 445 }, ...[...activePortForwards(state).entries()].map(([k, v]) => ({ proto: 'tcp', port: Number(k.split(':')[1]), addr: v.rule.hostIp || '0.0.0.0', pid: 8100 }))] : vmListening(state, ctx.vm);
  for (const l of L) ctx.line(`  ${l.proto.toUpperCase().padEnd(7)}${`${l.addr || '0.0.0.0'}:${l.port}`.padEnd(25)}${(l.proto === 'tcp' ? '0.0.0.0:0' : '*:*').padEnd(25)}${l.proto === 'tcp' ? 'LISTENING' : '         '}${flags.includes('o') ? `       ${l.pid || 1000 + l.port}` : ''}`);
});

// ------------------------------------------------------------------ netsh
def('netsh', (ctx, a) => {
  const s = a.map((x) => x.toLowerCase());
  const adminErr = () => { ctx.line('La operación solicitada requiere elevación (Ejecutar como administrador).'); return 1; };
  if (s[0] === 'interface' || s[0] === 'int') {
    const sub = s.slice(1);
    if ((sub[0] === 'ip' || sub[0] === 'ipv4') && sub[1] === 'show' && (sub[2] === 'config' || sub[2] === 'addresses')) {
      for (const i of winIfaces(ctx)) {
        ctx.line(`\nConfiguración de interfaz "${i.name}"\n    DHCP habilitado:                         ${i.dhcp ? 'Sí' : 'No'}`);
        for (const ad of i.addrs) ctx.line(`    Dirección IP:                           ${ad.ip}\n    Prefijo de subred:                     ${networkAddr(ad.ip, ad.prefix)}/${ad.prefix} (máscara ${prefixToMask(ad.prefix)})`);
        if (i.gw) ctx.line(`    Puerta de enlace predeterminada:        ${i.gw}\n    Métrica de puerta de enlace:            0`);
        ctx.line(`    Métrica de interfaz:                    25\n    ${i.dhcp ? 'Servidores DNS configurados a través de DHCP' : 'Servidores DNS configurados estáticamente'}:  ${(i.dns || []).join(', ') || 'Ninguno'}`);
      }
      return 0;
    }
    if (sub[0] === 'show' && sub[1] === 'interface') {
      ctx.line('\nEstado admin.  Estado          Tipo             Nombre de interfaz\n-------------------------------------------------------------------------');
      winIfaces(ctx).forEach((i) => ctx.line(`Habilitado     ${(i.up ? 'Conectado' : 'Desconectado').padEnd(16)}Dedicado         ${i.name}`));
      return 0;
    }
    if ((sub[0] === 'ip' || sub[0] === 'ipv4') && sub[1] === 'set' && (sub[2] === 'address' || sub[2] === 'dns' || sub[2] === 'dnsservers')) {
      if (isHost(ctx)) { ctx.line('(VirtLab no permite cambiar la IP del anfitrión)'); return 1; }
      if (!isAdmin(ctx)) return adminErr();
      const rest = a.slice(4);
      const kv = {}; const pos = [];
      for (const x of rest) { const m = x.match(/^(\w+)=(.*)$/); if (m) kv[m[1].toLowerCase()] = m[2].replace(/"/g, ''); else pos.push(x.replace(/"/g, '')); }
      const name = kv.name || pos.shift();
      const i = ctx.vm.rt.ifaces.find((x) => x.name.toLowerCase() === String(name || '').toLowerCase());
      if (!i) { ctx.line('El nombre de archivo, el nombre de directorio o la sintaxis de la etiqueta del volumen no son correctos.'); return 1; }
      const cont = ctx.content;
      const cfg = cont.win.adapters[i.name];
      if (sub[2] === 'address') {
        const mode = (kv.source || pos.shift() || '').toLowerCase();
        if (mode === 'dhcp') { cfg.dhcp = true; cfg.ip = ''; cfg.gw = ''; }
        else if (mode === 'static') {
          const ip = kv.address || kv.addr || pos.shift(); const mask = kv.mask || pos.shift(); const gw = kv.gateway || pos.shift();
          if (!isIp(ip) || (mask && maskToPrefix(mask) === null)) { ctx.line('Parámetro incorrecto.'); return 1; }
          if (mask && maskToPrefix(mask) !== null && gw && gw !== 'none' && !sameNet(ip, gw, maskToPrefix(mask))) { ctx.line('La puerta de enlace predeterminada no está en la misma red o subred que la dirección IP.'); }
          cfg.dhcp = false; cfg.ip = ip; cfg.prefix = mask ? maskToPrefix(mask) : 24; cfg.gw = gw && gw !== 'none' ? gw : '';
        } else { ctx.line('Uso: set address [name=]<cadena>\n       [[source=]dhcp|static]\n       [[address=]<IPv4>[/<entero>] [[mask=]<IPv4>] [[gateway=]<IPv4>|none [gwmetric=]<entero>]'); return 1; }
      } else {
        const mode = (kv.source || pos.shift() || '').toLowerCase();
        if (mode === 'dhcp') cfg.dns = [];
        else { const d = kv.address || pos.shift(); if (!isIp(d)) { ctx.line('Parámetro incorrecto.'); return 1; } cfg.dns = [d]; }
      }
      const dcfg = cfg.dhcp ? { dhcp4: true, addresses: [], dns: cfg.dns || [] } : { dhcp4: false, addresses: cfg.ip ? [{ ip: cfg.ip, prefix: cfg.prefix ?? 24 }] : [], gateway: cfg.gw || null, dns: cfg.dns || [] };
      configureIface(state, ctx.vm, i, dcfg, 'windows');
      ctx.event({ type: 'win-ipset', dev: i.name, cfg: { ...cfg } });
      commit();
      ctx.line('');
      return 0;
    }
    if ((sub[0] === 'ip' || sub[0] === 'ipv4') && sub[1] === 'add' && sub[2] === 'dns') { return CMDS.netsh(ctx, ['interface', 'ip', 'set', 'dns', ...a.slice(4).filter((x) => !/^index=/i.test(x)).slice(0, 1), 'static', ...a.slice(5)]); }
  }
  if (s[0] === 'advfirewall') {
    const fw = isHost(ctx) ? null : ctx.content.win.fw;
    if (s[1] === 'show') {
      const prof = (n, on) => ctx.line(`\nConfiguración de perfil ${n}:\n----------------------------------------------------------------------\nEstado                                ${on ? 'ACTIVAR' : 'DESACTIVAR'}\nDirectiva de firewall                 BlockInbound,AllowOutbound`);
      if (isHost(ctx)) { prof('Privado', true); prof('Público', true); return 0; }
      prof('Dominio', fw.domain); prof('Privado', fw.private); prof('Público', fw.public); ctx.line('Aceptar.'); return 0;
    }
    if (!isAdmin(ctx)) return adminErr();
    if (s[1] === 'set' && s[3] === 'state') {
      if (isHost(ctx)) { state.host.icmpIn = s[4] === 'off' ? true : state.host.icmpIn; ctx.line('Aceptar.'); commit(); return 0; }
      const on = s[4] === 'on';
      if (s[2] === 'allprofiles') { fw.domain = fw.private = fw.public = on; }
      else if (s[2] === 'publicprofile') fw.public = on; else if (s[2] === 'privateprofile') fw.private = on; else if (s[2] === 'domainprofile') fw.domain = on; else if (s[2] === 'currentprofile') fw.public = on;
      ctx.line('Aceptar.'); ctx.event({ type: 'winfw', state: on }); commit(); return 0;
    }
    if (s[1] === 'firewall' && (s[2] === 'add' || s[2] === 'delete') && s[3] === 'rule') {
      const kv = {};
      for (const x of a.slice(4)) { const m = x.match(/^(\w+)=(.*)$/); if (m) kv[m[1].toLowerCase()] = m[2].replace(/"/g, ''); }
      if (s[2] === 'delete') { if (isHost(ctx)) return 0; const before = fw.rules.length; fw.rules = fw.rules.filter((r) => r.name !== kv.name); ctx.line(before === fw.rules.length ? '\nNinguna regla coincide con los criterios especificados.\n' : `\nSe eliminaron ${before - fw.rules.length} reglas.\nAceptar.\n`); commit(); return 0; }
      if (!kv.name || !kv.dir || !kv.action) { ctx.line('\nUno o más parámetros esenciales no se especificaron.\nVerifique los parámetros necesarios y vuelva a escribirlos.\n\nUso: add rule name=<cadena>\n      dir=in|out\n      action=allow|block|bypass\n      [protocol=0-255|icmpv4|icmpv6|icmpv4:type,code|icmpv6:type,code|tcp|udp|any]\n      [localport=0-65535|<intervalo de puertos>[,...]|RPC|RPC-EPMap|IPHTTPS|any (valor predeterminado=any)]'); return 1; }
      const proto = (kv.protocol || 'any').toLowerCase().startsWith('icmpv4') ? 'icmpv4' : (kv.protocol || 'any').toLowerCase();
      if (isHost(ctx)) { if (proto === 'icmpv4') state.host.icmpIn = kv.action.toLowerCase() === 'allow'; ctx.line('Aceptar.'); commit(); return 0; }
      fw.rules.push({ name: kv.name, dir: kv.dir.toLowerCase(), action: kv.action.toLowerCase(), proto, port: kv.localport || 'any' });
      ctx.line('Aceptar.');
      ctx.event({ type: 'winfw-rule', proto, port: kv.localport, action: kv.action.toLowerCase() });
      commit();
      return 0;
    }
    if (s[1] === 'reset') { if (!isHost(ctx)) { Object.assign(fw, { domain: true, private: true, public: true, icmp: false, rules: [] }); commit(); } ctx.line('Aceptar.'); return 0; }
  }
  if (s[0] === 'wlan') { ctx.line('No hay ninguna interfaz inalámbrica en el sistema.'); return 1; }
  ctx.line('No se encontró el siguiente comando: ' + a.join(' ') + '.');
  return 1;
});

// ------------------------------------------------------------------ clientes
def('curl', async (ctx, a) => {
  const head = a.includes('-I') || a.includes('--head');
  const url = a.find((x) => !x.startsWith('-'));
  if (!url) { ctx.line('curl: try \'curl --help\' for more information'); return 2; }
  const r = httpGet(state, fromId(ctx), url);
  if (!r.ok) {
    if (r.error === 'timeout') { if (!(await ctx.sleep(2500))) return 130; }
    const u = r.u || { host: url, port: 80 };
    ctx.line({ resolve: `curl: (6) Could not resolve host: ${u.host}`, refused: `curl: (7) Failed to connect to ${u.host} port ${u.port} after 2032 ms: Could not connect to server`, timeout: `curl: (28) Failed to connect to ${u.host} port ${u.port} after 21045 ms: Could not connect to server`, noroute: `curl: (7) Failed to connect to ${u.host} port ${u.port} after 0 ms: Could not connect to server` }[r.error]);
    explain(ctx, `curl ${url}`, r.res);
    ctx.event({ type: 'http', url, ok: false, error: r.error });
    return 7;
  }
  if (head) ctx.line(`HTTP/1.1 ${r.code} ${r.code === 200 ? 'OK' : 'Moved Permanently'}\nDate: ${new Date().toUTCString()}\nServer: ${r.server}\nContent-Type: text/html; charset=UTF-8\n`);
  else ctx.line(r.body);
  explain(ctx, `curl ${url}`, r.res, r.res.forwardedTo ? [`La conexión entra por el puerto ${r.u.port} del anfitrión y la regla de reenvío la entrega a ${r.res.forwardedTo.guestIp}:${r.res.forwardedTo.guestPort} dentro de la red NAT.`] : []);
  ctx.event({ type: 'http', url, ok: true, code: r.code, vm: r.vm?.id, forwarded: !!r.res.forwardedTo });
});
def('ssh', (ctx, a) => sshClient(ctx, a));
def('telnet', (ctx) => { notRecognized(ctx, 'telnet'); return 9009; });
def('powershell pwsh', (ctx) => { ctx.sess.ps = true; ctx.line('Windows PowerShell\nCopyright (C) Microsoft Corporation. Todos los derechos reservados.\n\nInstale la versión más reciente de PowerShell para obtener nuevas características y mejoras. https://aka.ms/PSWindows\n'); });
def('cmd', (ctx) => { ctx.sess.ps = false; ctx.line(`Microsoft Windows [Versión ${isHost(ctx) ? '10.0.26100.2033' : OS_TYPES[ctx.content.os].build}]\n(c) Microsoft Corporation. Todos los derechos reservados.\n`); });
def('setx', (ctx, a) => { if (/path/i.test(a[0] || '') && /virtualbox/i.test(a.join(' '))) { state.host.vboxInPath = true; commit(); } ctx.line('\nCORRECTO: se guardó el valor especificado.'); });
def('vboxwindowsadditions vboxwindowsadditions-amd64', async (ctx) => {
  if (isHost(ctx)) return notRecognized(ctx, 'VBoxWindowsAdditions');
  const cd = ctx.vm.storage.flatMap((x) => x.slots).find((s) => s.kind === 'dvd' && s.medium);
  const m = cd && state.media.dvd.find((x) => x.id === cd.medium);
  if (m?.isoOs !== 'ga') { ctx.line('"VBoxWindowsAdditions" no se reconoce como un comando interno o externo,\nprograma o archivo por lotes ejecutable.\n(Inserte antes el CD de las Guest Additions: Dispositivos › Insertar imagen de CD de las «Guest Additions»)'); return 9009; }
  ctx.line('Oracle VirtualBox Guest Additions 7.1.4 Setup\nInstalando controladores (VBoxGuest, VBoxMouse, VBoxVideo, VBoxSF)...');
  if (!(await ctx.sleep(1800))) return 130;
  ctx.line('Instalación completada. Es necesario reiniciar para que los cambios surtan efecto.');
  ctx.content.ga = true; ctx.vm.rt.gaActive = false; commit();
  ctx.event({ type: 'ga-install', os: ctx.content.os });
});
def('d:', (ctx) => { const cd = ctx.vm?.storage.flatMap((x) => x.slots).find((s) => s.kind === 'dvd' && s.medium); if (!cd) { ctx.line('El dispositivo no está listo.'); return 1; } ctx.sess.cwd = 'D:\\'; });
def('c:', (ctx) => { ctx.sess.cwd = 'C:\\'; });
def('net', (ctx, a) => {
  if ((a[0] || '').toLowerCase() === 'use') { const share = a[2]; if (share && /\\\\vboxsvr\\/i.test(share)) { if (!ctx.content?.ga) { ctx.line('Error de sistema 67.\n\nNo se encuentra el nombre de red.'); return 2; } ctx.line('Se ha completado el comando correctamente.'); return 0; } ctx.line('Se registrarán las nuevas conexiones.\n\nNo hay entradas en la lista.'); return 0; }
  if ((a[0] || '').toLowerCase() === 'user') { ctx.line(`\nCuentas de usuario de \\\\${hostname(ctx)}\n\n-------------------------------------------------------------------------------\nAdministrador            DefaultAccount           ${isHost(ctx) ? state.host.user : ctx.sess.user}\nInvitado                 WDAGUtilityAccount\nSe ha completado el comando correctamente.`); return 0; }
  ctx.line('La sintaxis de este comando es:\n\nNET\n    [ ACCOUNTS | COMPUTER | CONFIG | CONTINUE | FILE | GROUP | HELP |\n      HELPMSG | LOCALGROUP | PAUSE | SESSION | SHARE | START |\n      STATISTICS | STOP | TIME | USE | USER | VIEW ]');
});

// ------------------------------------------------------------------ PowerShell (subconjunto)
const PS = {};
const PS_ANY = {};
PS_ANY['test-netconnection'] = async (ctx, a) => {
  let host = null; let port = null;
  for (let i = 0; i < a.length; i++) { if (/^-port$/i.test(a[i])) port = Number(a[++i]); else if (/^-computername$/i.test(a[i])) host = a[++i]; else if (!a[i].startsWith('-')) host = host || a[i]; }
  host = host || 'internetbeacon.msedge.net';
  const r = resolve(state, fromId(ctx), host);
  if (r.error) { ctx.line(`ADVERTENCIA: No se pudo resolver el nombre: ${host}\n\nComputerName           : ${host}\nRemoteAddress          :\nInterfaceAlias         :\nSourceAddress          :\nPingSucceeded          : False`); return 1; }
  const res = send(state, fromId(ctx), r.ip, port ? { proto: 'tcp', port } : {});
  await ctx.sleep(res.status === 'ok' ? 600 : 2500);
  const ok = res.status === 'ok';
  if (port && !ok) ctx.line(`ADVERTENCIA: TCP connect to (${r.ip} : ${port}) failed`);
  if (!port && !ok) ctx.line(`ADVERTENCIA: Ping to ${r.ip} failed with status: ${res.status === 'noroute' ? 'DestinationNetworkUnreachable' : res.status === 'host_unreach' ? 'DestinationHostUnreachable' : 'TimedOut'}`);
  const iface = winIfaces(ctx).find((i) => i.addrs.some((x) => x.ip === res.srcIp));
  ctx.line(`\nComputerName     : ${host}\nRemoteAddress    : ${r.ip}\n${port ? `RemotePort       : ${port}\n` : ''}InterfaceAlias   : ${iface?.name || ''}\nSourceAddress    : ${res.srcIp || ''}\n${port ? `TcpTestSucceeded : ${ok ? 'True' : 'False'}` : `PingSucceeded    : ${ok ? 'True' : 'False'}\nPingReplyDetails (RTT) : ${ok ? Math.round(res.rtt) : 0} ms`}\n`);
  explain(ctx, `Test-NetConnection ${host}${port ? ` -Port ${port}` : ''}`, res);
  ctx.event({ type: port ? 'tcp' : 'ping', dst: r.ip, port, ok, target: res.target?.id });
  return ok ? 0 : 1;
};
PS_ANY.tnc = PS_ANY['test-netconnection'];
PS_ANY['get-netipaddress'] = (ctx) => { for (const i of winIfaces(ctx)) for (const ad of i.addrs) ctx.line(`\nIPAddress         : ${ad.ip}\nInterfaceIndex    : ${5 + winIfaces(ctx).indexOf(i)}\nInterfaceAlias    : ${i.name}\nAddressFamily     : IPv4\nType              : Unicast\nPrefixLength      : ${ad.prefix}\nPrefixOrigin      : ${ad.apipa ? 'WellKnown' : i.dhcp ? 'Dhcp' : 'Manual'}\nSuffixOrigin      : ${ad.apipa ? 'Link' : i.dhcp ? 'Dhcp' : 'Manual'}\nAddressState      : Preferred`); };
PS_ANY['get-netadapter'] = (ctx) => { ctx.line('\nName                      InterfaceDescription                    ifIndex Status       MacAddress             LinkSpeed\n----                      --------------------                    ------- ------       ----------             ---------'); winIfaces(ctx).forEach((i, k) => ctx.line(`${i.name.padEnd(26)}${i.desc.slice(0, 38).padEnd(40)}${String(k + 5).padStart(7)} ${(i.up ? 'Up' : 'Disconnected').padEnd(13)}${macDash(i.mac).padEnd(23)}${i.up ? '1 Gbps' : '0 bps'}`)); };
PS_ANY['get-netipconfiguration'] = (ctx) => { for (const i of winIfaces(ctx).filter((x) => x.up)) ctx.line(`\nInterfaceAlias       : ${i.name}\nInterfaceIndex       : ${5 + winIfaces(ctx).indexOf(i)}\nInterfaceDescription : ${i.desc}\nIPv4Address          : ${i.addrs.map((x) => x.ip).join(', ')}\nIPv4DefaultGateway   : ${i.gw || ''}\nDNSServer            : ${(i.dns || []).join(', ')}`); };
PS_ANY.gip = PS_ANY['get-netipconfiguration'];
PS_ANY['set-netfirewallprofile'] = (ctx, a) => { if (isHost(ctx)) { ctx.line(''); return 0; } if (!isAdmin(ctx)) { ctx.line('Set-NetFirewallProfile : Acceso denegado.'); return 1; } const en = a.join(' ').match(/-Enabled\s+(\w+)/i)?.[1]; const on = /true/i.test(en || ''); const fw = ctx.content.win.fw; const prof = a.join(' ').match(/-Profile\s+([\w,]+)/i)?.[1] || 'Domain,Public,Private'; for (const p of prof.split(',')) { if (/public/i.test(p)) fw.public = on; if (/private/i.test(p)) fw.private = on; if (/domain/i.test(p)) fw.domain = on; } commit(); ctx.event({ type: 'winfw', state: on }); };
PS_ANY['new-netfirewallrule'] = (ctx, a) => { if (isHost(ctx)) return 0; if (!isAdmin(ctx)) { ctx.line('New-NetFirewallRule : Acceso denegado.'); return 1; } const s = a.join(' '); const name = s.match(/-DisplayName\s+"?([^"]+?)"?(\s+-|$)/i)?.[1] || 'Regla'; const proto = (s.match(/-Protocol\s+(\w+)/i)?.[1] || 'any').toLowerCase(); const port = s.match(/-LocalPort\s+(\d+)/i)?.[1] || 'any'; const action = /-Action\s+Allow/i.test(s) ? 'allow' : 'block'; const dir = /-Direction\s+Outbound/i.test(s) ? 'out' : 'in'; ctx.content.win.fw.rules.push({ name, dir, action, proto, port }); commit(); ctx.event({ type: 'winfw-rule', proto, port, action }); ctx.line(`\nName                  : {${hashStr(name).toString(16)}-a1b2-c3d4}\nDisplayName           : ${name}\nEnabled               : True\nDirection             : ${dir === 'in' ? 'Inbound' : 'Outbound'}\nAction                : ${action === 'allow' ? 'Allow' : 'Block'}\nPrimaryStatus         : OK`); };
PS_ANY['enable-netfirewallrule'] = (ctx, a) => { if (isHost(ctx)) return 0; if (!isAdmin(ctx)) { ctx.line('Enable-NetFirewallRule : Acceso denegado.'); return 1; } const s = a.join(' '); if (/FPS-ICMP4-ERQ-In|Eco ICMPv4|ICMPv4/i.test(s)) { ctx.content.win.fw.icmp = true; commit(); ctx.event({ type: 'winfw-rule', proto: 'icmpv4', action: 'allow' }); } else ctx.line('Enable-NetFirewallRule : No se encontraron objetos MSFT_NetFirewallRule cuya propiedad coincida.'); };
PS_ANY['get-netfirewallprofile'] = (ctx) => { const fw = isHost(ctx) ? { domain: true, private: true, public: true } : ctx.content.win.fw; [['Domain', fw.domain], ['Private', fw.private], ['Public', fw.public]].forEach(([n, on]) => ctx.line(`\nName                            : ${n}\nEnabled                         : ${on ? 'True' : 'False'}\nDefaultInboundAction            : NotConfigured\nDefaultOutboundAction           : NotConfigured`)); };
PS_ANY['restart-computer'] = async (ctx) => { if (isHost(ctx)) return 0; await ctx.sleep(300); rebootVm(ctx.vm); };
PS_ANY['stop-computer'] = async (ctx) => { if (isHost(ctx)) return 0; await ctx.sleep(300); powerOff(ctx.vm, 'acpi'); };
PS_ANY['get-computerinfo'] = (ctx) => CMDS.systeminfo(ctx, []);
PS_ANY['resolve-dnsname'] = (ctx, a) => CMDS.nslookup(ctx, a);
PS['ls'] = CMDS.dir; PS['pwd'] = (ctx) => ctx.line(`\nPath\n----\n${ctx.sess.cwd}\n`); PS['cat'] = CMDS.type; PS['get-content'] = CMDS.type; PS['clear-host'] = CMDS.cls;

export function completeWindows(sess, before) {
  const words = before.split(/\s+/);
  if (words.length <= 1) {
    const all = [...Object.keys(CMDS), ...Object.keys(PS_ANY), ...(sess.kind === 'host' ? ['VBoxManage'] : [])];
    return all.filter((x) => x.toLowerCase().startsWith(words[0].toLowerCase()) && !x.endsWith(':')).sort();
  }
  return [];
}
