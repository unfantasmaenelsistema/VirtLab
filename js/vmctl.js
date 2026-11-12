// Ciclo de vida de las máquinas: validación, arranque, instalación, apagado,
// instantáneas, clonación, exportación/importación y registro VBox.log.
import { state, emit, commit, getVm, getMedium, vmLog, logEvent, allSlots, newMedium, newVm, uniqueVmName, MACHINE_FOLDER } from './store.js';
import { OS_TYPES, ISOS, detectIsoOs, HOST_IFACES } from './catalog.js';
import { clone, uid, uuid, vboxMac, sleep, nowStamp } from './util.js';
import { bootNetwork, initLinkFlags, vmContent, linkOf, natNetOf, hostOnlyOf, linkChanged } from './net.js';
import { makeInstalledContent, addDhcpdFiles } from './guest.js';

const timers = new Map();
function later(vm, ms, fn) {
  const t = setTimeout(() => { timers.get(vm.id)?.delete(t); fn(); }, speed(ms));
  if (!timers.has(vm.id)) timers.set(vm.id, new Set());
  timers.get(vm.id).add(t);
}
function cancelTimers(vm) { (timers.get(vm.id) || []).forEach(clearTimeout); timers.delete(vm.id); }
export const speed = (ms) => (state?.prefs?.bootSpeed === 'realistic' ? ms * 2.5 : ms);

export function setScreen(vm, screen) {
  vm.rt.screen = screen;
  emit('screen', vm);
  commit({ vm: vm.id });
}

// ---------------------------------------------------------------- validación de la configuración
export function validateVm(vm) {
  const issues = [];
  const os = OS_TYPES[vm.osKey] || OS_TYPES.other;
  const hostRam = state.host.ramMB;
  if (vm.hw.ramMB > hostRam * 0.75) issues.push({ sec: 'system', level: 'error', text: `Se ha asignado más del 75 % de la memoria del anfitrión (${hostRam} MB) a la máquina virtual. No queda suficiente memoria para el sistema anfitrión.` });
  else if (vm.hw.ramMB > hostRam * 0.5) issues.push({ sec: 'system', level: 'warn', text: `Se ha asignado entre el 50 % y el 75 % de la memoria del anfitrión a la máquina virtual.` });
  if (vm.hw.ramMB < os.minRam) issues.push({ sec: 'system', level: 'warn', text: `La memoria base (${vm.hw.ramMB} MB) es menor que el mínimo recomendado para ${os.version} (${os.minRam} MB).` });
  if (vm.hw.cpus > state.host.cpus) issues.push({ sec: 'system', level: 'error', text: `Hay más CPU virtuales (${vm.hw.cpus}) asignadas que CPU físicas en el anfitrión (${state.host.cpus}).` });
  if (vm.hw.vram < 9 && os.family === 'windows') issues.push({ sec: 'display', level: 'warn', text: 'La memoria de vídeo es muy baja para un sistema Windows.' });
  vm.nics.forEach((n) => {
    if (!n.enabled) return;
    if (n.attach === 'natnet' && !natNetOf(state, n.natnet)) issues.push({ sec: 'network', level: 'error', text: `Adaptador ${n.slot + 1}: la red NAT «${n.natnet || ''}» no existe. Créela en Herramientas › Red.` });
    if (n.attach === 'hostonly' && !hostOnlyOf(state, n.hostonly)) issues.push({ sec: 'network', level: 'error', text: `Adaptador ${n.slot + 1}: no hay ninguna red solo anfitrión seleccionada.` });
    if (n.attach === 'intnet' && !n.intnet) issues.push({ sec: 'network', level: 'error', text: `Adaptador ${n.slot + 1}: no se ha indicado el nombre de la red interna.` });
    if (n.attach === 'generic' || n.attach === 'cloud') issues.push({ sec: 'network', level: 'warn', text: `Adaptador ${n.slot + 1}: el modo «${n.attach === 'generic' ? 'Controlador genérico' : 'Red en la nube'}» no se simula en VirtLab (no habrá conectividad).` });
  });
  const macs = vm.nics.filter((n) => n.enabled).map((n) => n.mac);
  if (new Set(macs).size !== macs.length) issues.push({ sec: 'network', level: 'error', text: 'Dos adaptadores de esta máquina tienen la misma dirección MAC.' });
  if (vm.hw.usb.enabled && vm.hw.usb.ver !== '1.1' && false) issues.push({});
  if (os.needsTpm && vm.hw.tpm === 'none') issues.push({ sec: 'system', level: 'warn', text: 'Windows 11 requiere TPM 2.0: el programa de instalación se negará a continuar.' });
  return issues;
}

// ---------------------------------------------------------------- arranque
export function startVm(vm, mode = 'normal') {
  if (vm.state === 'running') return { ok: true };
  if (vm.state === 'paused') { resumeVm(vm); return { ok: true }; }
  const errs = [];
  for (const n of vm.nics) {
    if (!n.enabled) continue;
    if (n.attach === 'natnet' && !natNetOf(state, n.natnet)) errs.push(`No existe la red NAT «${n.natnet}» (VERR_NOT_FOUND).`);
    if (n.attach === 'hostonly' && !hostOnlyOf(state, n.hostonly)) errs.push(`Nonexistent host networking interface, name '${n.hostonly}' (VERR_INTERNAL_ERROR).`);
  }
  const used = state.vms.filter((v) => v !== vm && (v.state === 'running' || v.state === 'paused')).reduce((a, v) => a + v.hw.ramMB, 0);
  if (used + vm.hw.ramMB > state.host.ramMB - 2048) errs.push(`No hay suficiente memoria libre en el anfitrión: las máquinas en ejecución usan ${used} MB y esta necesita ${vm.hw.ramMB} MB (VERR_NO_MEMORY).`);
  if (vm.hw.cpus > state.host.cpus) errs.push(`El número de CPU virtuales (${vm.hw.cpus}) supera las CPU del anfitrión.`);
  if (errs.length) {
    vmLog(vm, `ERROR [COM]: aRC=E_FAIL (0x80004005) aIID={...} aComponent={ConsoleWrap} aText={${errs[0]}}`);
    commit();
    return { ok: false, error: `No se pudo iniciar la máquina virtual «${vm.name}».`, detail: errs.join('\n') };
  }

  if (vm.state === 'saved' && vm.rt) {
    vm.state = 'running';
    vm.stateChanged = Date.now();
    vm.rt.headless = mode === 'headless';
    linkChanged(state, vm);
    vmLog(vm, 'VMM: Restoring saved state...');
    vmLog(vm, 'Changing the VM state from \'LOADING\' to \'RUNNING\'');
    logEvent({ type: 'vm-start', vm: vm.id, restored: true });
    commit({ vm: vm.id });
    emit('screen', vm);
    return { ok: true };
  }

  vm.log = [];
  vm.rt = { bootAt: Date.now(), screen: { phase: 'bios' }, ifaces: [], routes: [], services: {}, headless: mode === 'headless', session: null, history: [] };
  vm.state = 'running';
  vm.stateChanged = Date.now();
  writeStartLog(vm);
  logEvent({ type: 'vm-start', vm: vm.id });
  commit({ vm: vm.id });
  emit('screen', vm);
  later(vm, vm.hw.efi ? 1400 : 1200, () => chooseBootDevice(vm));
  return { ok: true };
}

function writeStartLog(vm) {
  const os = OS_TYPES[vm.osKey];
  [
    `VirtualBox VM 7.1.4 r165100 win.amd64 (Oct 15 2024 14:19:25) release log`,
    `Log opened ${new Date().toISOString()}`,
    `Build Type: release`,
    `OS Product: Windows 11`,
    `Host RAM: ${state.host.ramMB}MB (${state.host.ramMB / 1024}.0GB) total`,
    `Executable: C:\\Program Files\\Oracle\\VirtualBox\\VirtualBoxVM.exe`,
    `Process ID: ${4000 + Math.floor(Math.random() * 9000)}`,
    `Package type: WINDOWS_64BITS_GENERIC`,
    `Installed Extension Packs:`,
    `  None installed!`,
    `Console: Machine state changed to 'Starting'`,
    `[/VirtualBox/GuestAdd/] (ostype ${os.version})`,
    `NumCPUs <integer> = ${vm.hw.cpus}`,
    `RamSize <integer> = 0x${(vm.hw.ramMB * 1024 * 1024).toString(16).padStart(16, '0')} (${vm.hw.ramMB * 1024 * 1024}, ${vm.hw.ramMB} MB)`,
    `HM: HMR3Init: VT-x w/ nested paging and unrestricted guest execution hw support`,
    `CPUM: Logical host processors: ${state.host.cpus} present, ${state.host.cpus} max, ${state.host.cpus} online`,
    vm.hw.efi ? 'EFI: Using EFI firmware image' : 'PcBios: [SMP] BIOS with 1 CPUs',
    ...vm.nics.filter((n) => n.enabled).map((n) => `NIC#${n.slot}: ${n.type} attached to ${n.attach === 'nat' ? 'NAT' : n.attach === 'natnet' ? `NAT network '${n.natnet}'` : n.attach === 'bridged' ? `bridged interface '${n.bridged}'` : n.attach === 'intnet' ? `internal network '${n.intnet}'` : n.attach === 'hostonly' ? `host-only interface '${n.hostonly}'` : 'nothing'} (MAC ${n.mac}, cable ${n.cable ? 'connected' : 'DISCONNECTED'})`),
    ...vm.nics.filter((n) => n.enabled && n.attach === 'nat').map((n) => `NAT#${n.slot}: Guest address guess 10.0.${n.slot + 2}.15; DNS proxy 10.0.${n.slot + 2}.3; ${n.pf.length} port-forwarding rule(s)`),
    ...vm.nics.filter((n) => n.enabled && n.attach === 'nat').flatMap((n) => n.pf.map((r) => `NAT: set redirect TCP host port ${r.hostPort} => guest port ${r.guestPort} @ ${r.guestIp || '10.0.2.15'}`)),
    `Changing the VM state from 'POWERING_ON' to 'RUNNING'`,
    `Console: Machine state changed to 'Running'`,
  ].forEach((l) => vmLog(vm, l));
}

function bootableIso(m) { return m && m.isoOs && m.isoOs !== 'ga'; }

function chooseBootDevice(vm, skipDvd = false, forced = null) {
  if (vm.state !== 'running' || !vm.rt) return;
  if (!forced && vm.rt.screen?.phase === 'bootmenu') return;
  const base = vm.hw.boot.filter((b) => b.on).map((b) => b.dev);
  const order = forced ? [forced, ...base.filter((d) => d !== forced)] : base;
  for (const dev of order) {
    if (dev === 'dvd' && !skipDvd) {
      const s = allSlots(vm).find((x) => x.slot.kind === 'dvd' && x.slot.medium);
      const m = s && getMedium(s.slot.medium);
      if (bootableIso(m)) {
        vmLog(vm, `VMMDev: Guest booting from optical medium '${m.name}'`);
        const disk = vmContent(state, vm);
        if (vm.unattended && !disk) { setScreen(vm, { phase: 'installing', iso: m.isoOs, progress: 0, unattended: true }); runInstall(vm, m.isoOs, vm.unattended); return; }
        if (OS_TYPES[m.isoOs].family === 'windows') { setScreen(vm, { phase: 'win-presskey', iso: m.isoOs, hasOs: !!disk }); later(vm, 5200, () => { if (vm.rt?.screen?.phase === 'win-presskey') chooseBootDevice(vm, true); }); return; }
        setScreen(vm, { phase: 'isomenu', iso: m.isoOs, sel: 0 });
        return;
      }
    }
    if (dev === 'hdd') {
      const content = vmContent(state, vm);
      if (content) { bootOs(vm, content); return; }
    }
    if (dev === 'net') {
      setScreen(vm, { phase: 'pxe' });
      later(vm, 2600, () => { if (vm.rt?.screen?.phase === 'pxe') { vm.hw.boot = vm.hw.boot.map((b) => b); chooseBootDeviceAfter(vm, 'net'); } });
      return;
    }
  }
  noBootable(vm);
}
function chooseBootDeviceAfter(vm, after) {
  const order = vm.hw.boot.filter((b) => b.on).map((b) => b.dev);
  const rest = order.slice(order.indexOf(after) + 1);
  for (const dev of rest) {
    if (dev === 'hdd' && vmContent(state, vm)) { bootOs(vm, vmContent(state, vm)); return; }
  }
  noBootable(vm);
}
function noBootable(vm) {
  vmLog(vm, 'VMMDev: Guest Log: BIOS: Boot failed: no bootable medium');
  setScreen(vm, { phase: vm.hw.efi ? 'efishell' : 'nobootable' });
}

export function bootFromNextVolume(vm) { chooseBootDevice(vm, true); }
export function bootDevice(vm, dev) { vm.rt.screen = { phase: 'bios' }; chooseBootDevice(vm, false, dev || null); }

export function bootOs(vm, content) {
  const os = OS_TYPES[content.os];
  vmLog(vm, `VMMDev: Guest booting from hard disk (${os.pretty || os.label})`);
  vm.rt.services = {};
  vm.rt.gaActive = !!content.ga;
  bootNetwork(state, vm, content);
  initLinkFlags(state, vm);
  vm.rt.ipt = { policy: { INPUT: 'ACCEPT', FORWARD: 'ACCEPT', OUTPUT: 'ACCEPT' }, INPUT: [], FORWARD: [], OUTPUT: [], nat: [] };
  vm.rt.ufw = content.ufw ? clone(content.ufw) : null;
  // reglas persistentes (iptables-persistent)
  for (const line of (content.files?.['/etc/iptables/rules.v4'] || '').split('\n')) {
    const m = line.match(/^-A (INPUT|FORWARD|OUTPUT)\s+(.*)-j (ACCEPT|DROP|REJECT)/);
    if (!m) continue;
    const proto = m[2].match(/-p (\w+)/)?.[1] || null;
    const dport = m[2].match(/--dport (\d+)/)?.[1] || null;
    vm.rt.ipt[m[1]].push({ proto, dport, target: m[3] });
  }
  if (os.family === 'windows') {
    setScreen(vm, { phase: 'win-boot' });
    later(vm, 2600, () => { if (vm.state === 'running') { setScreen(vm, { phase: 'win-login' }); vmLog(vm, 'GUI: Guest reached the logon screen'); } });
    return;
  }
  for (const [svc, cfg] of Object.entries(content.services || {})) if (cfg.enabled) startService(vm, content, svc);
  const waitOnline = content.os === 'ubuntu' && vm.rt.ifaces.some((i) => i.cfg?.dhcp4 && !i.addrs.some((a) => a.dyn));
  setScreen(vm, { phase: 'linux-boot', waitOnline, netError: vm.rt.netError });
  later(vm, waitOnline ? 3800 : 2000, () => {
    if (vm.state !== 'running') return;
    setScreen(vm, { phase: 'console' });
    vmLog(vm, `VMMDev: Guest Additions ${content.ga ? 'information report: Version 7.1.4' : 'not installed'}`);
  });
}

export function startService(vm, content, svc) {
  if (svc === 'isc-dhcp-server') {
    const cfg = parseDhcpd(content, vm);
    if (!cfg.ok) { vm.rt.services[svc] = false; vm.rt.svcError = { ...vm.rt.svcError, [svc]: cfg.error }; return false; }
    vm.rt.dhcpd = cfg;
  }
  vm.rt.services[svc] = true;
  if (vm.rt.svcError) delete vm.rt.svcError[svc];
  return true;
}

// Configuración de isc-dhcp-server
export function parseDhcpd(content, vm) {
  const def = content.files['/etc/default/isc-dhcp-server'] || '';
  const ifm = def.match(/^\s*INTERFACESv4\s*=\s*"([^"]*)"/m);
  const ifaces = (ifm?.[1] || '').split(/\s+/).filter(Boolean);
  const conf = content.files['/etc/dhcp/dhcpd.conf'] || '';
  const clean = conf.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
  const subnets = [];
  const re = /subnet\s+([\d.]+)\s+netmask\s+([\d.]+)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const body = m[3];
    const range = body.match(/range\s+([\d.]+)\s+([\d.]+)\s*;/);
    const routers = body.match(/option\s+routers\s+([\d.]+)\s*;/);
    const dns = body.match(/option\s+domain-name-servers\s+([^;]+);/);
    const prefix = String(m[2]).split('.').map(Number).reduce((a, o) => a + o.toString(2).split('1').length - 1, 0);
    if (!range) continue;
    subnets.push({ net: m[1], prefix, lower: range[1], upper: range[2], routers: routers?.[1] || null, dns: dns ? dns[1].split(',').map((s) => s.trim()).filter((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x)) : [] });
  }
  if (!ifaces.length) return { ok: false, error: 'No subnet declaration for any interface: INTERFACESv4 está vacío en /etc/default/isc-dhcp-server.' };
  const addrs = (vm.rt.ifaces || []).filter((i) => ifaces.includes(i.name)).flatMap((i) => i.addrs);
  if (!addrs.length) return { ok: false, error: `No subnet declaration for ${ifaces[0]} (no IPv4 addresses). ** Ignoring requests on ${ifaces[0]}.` };
  const match = subnets.some((s) => addrs.some((a) => sameNet24(a.ip, s.net, s.prefix)));
  if (!match) return { ok: false, error: `No subnet declaration for ${ifaces[0]} (${addrs[0].ip}).\n** Ignoring requests on ${ifaces[0]}.  If this is not what\n   you want, please write a subnet declaration\n   in your dhcpd.conf file for the network segment\n   to which interface ${ifaces[0]} is attached. **\n\nNot configured to listen on any interfaces!` };
  return { ok: true, ifaces, subnets };
}
function sameNet24(ip, net, prefix) {
  const toN = (x) => x.split('.').reduce((a, o) => a * 256 + Number(o), 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((toN(ip) & mask) >>> 0) === ((toN(net) & mask) >>> 0);
}

// ---------------------------------------------------------------- instalación
export function runInstall(vm, isoOs, opts) {
  const os = OS_TYPES[isoOs];
  const disk = allSlots(vm).find((x) => x.slot.kind === 'hdd' && x.slot.medium);
  const m = disk && getMedium(disk.slot.medium);
  if (!m) { setScreen(vm, { phase: 'install-error', iso: isoOs, error: 'No se ha detectado ningún disco duro. Añada un disco virtual en Configuración › Almacenamiento.' }); return; }
  const req = installRequirements(vm, isoOs, m);
  if (req) { setScreen(vm, { phase: 'install-error', iso: isoOs, error: req }); return; }
  vmLog(vm, `GUI: ${opts.unattended ? 'Unattended' : 'Guest'} installation of ${os.label} started`);
  let p = 0;
  const steps = os.family === 'windows'
    ? ['Copiando archivos de Windows', 'Preparando archivos para la instalación', 'Instalando características', 'Instalando actualizaciones', 'Finalizando']
    : ['Particionando el disco', 'Instalando el sistema base', 'Configurando la red', 'Instalando el núcleo', 'Instalando el gestor de arranque GRUB', 'Configurando usuarios'];
  const tick = () => {
    if (vm.state !== 'running' || vm.rt?.screen?.phase !== 'installing') return;
    p = Math.min(100, p + 4 + Math.random() * 7);
    vm.rt.screen.progress = p;
    vm.rt.screen.step = steps[Math.min(steps.length - 1, Math.floor((p / 100) * steps.length))];
    emit('screen', vm);
    if (p >= 100) {
      const nics = vm.nics.filter((n) => n.enabled).length;
      m.content = makeInstalledContent(isoOs, { hostname: opts.hostname, user: opts.user, pass: opts.pass, nics: Math.max(1, nics) });
      if (opts.ssh === false && m.content.pkgs) { m.content.pkgs = m.content.pkgs.filter((x) => x !== 'openssh-server'); delete m.content.services.ssh; }
      if (opts.ga) m.content.ga = true;
      m.usedGB = Math.min(m.sizeGB, os.family === 'windows' ? 17 + Math.random() * 3 : 3 + Math.random() * 2);
      vmLog(vm, `GUI: Installation finished, disk '${m.name}' now contains ${os.label}`);
      logEvent({ type: 'install', vm: vm.id, os: isoOs, unattended: !!opts.unattended });
      if (opts.unattended) {
        vm.unattended = null;
        const dvd = allSlots(vm).find((x) => x.slot.kind === 'dvd' && x.slot.medium);
        if (dvd) dvd.slot.medium = null;
        setScreen(vm, { phase: 'rebooting' });
        later(vm, 1500, () => { if (vm.state === 'running') { vm.rt.screen = { phase: 'bios' }; emit('screen', vm); later(vm, 900, () => chooseBootDevice(vm)); } });
      } else {
        setScreen(vm, { phase: 'install-done', iso: isoOs });
      }
      commit();
      return;
    }
    later(vm, 420, tick);
  };
  setScreen(vm, { phase: 'installing', iso: isoOs, progress: 0, step: steps[0], unattended: !!opts.unattended });
  later(vm, 420, tick);
}

export function installRequirements(vm, isoOs, disk) {
  const os = OS_TYPES[isoOs];
  if (isoOs === 'win11') {
    const fails = [];
    if (!vm.hw.efi) fails.push('El firmware no es UEFI (Configuración › Sistema › Habilitar EFI).');
    if (vm.hw.tpm === 'none') fails.push('No se ha detectado TPM 2.0 (Configuración › Sistema › Chip TPM).');
    if (!vm.hw.secureBoot) fails.push('El arranque seguro no está habilitado.');
    if (vm.hw.ramMB < 4096) fails.push(`La memoria es de ${vm.hw.ramMB} MB y se requieren 4 GB.`);
    if (vm.hw.cpus < 2) fails.push('Se requieren al menos 2 procesadores.');
    if (disk.sizeGB < 64) fails.push(`El disco tiene ${disk.sizeGB} GB y se requieren 64 GB.`);
    if (fails.length) return `Este equipo no puede ejecutar Windows 11.\n\n${fails.join('\n')}`;
  }
  const minDisk = os.family === 'windows' ? 32 : isoOs === 'kali' ? 20 : 5;
  if (disk.sizeGB < minDisk) return `El disco seleccionado (${disk.sizeGB} GB) es demasiado pequeño. ${os.label} necesita al menos ${minDisk} GB.`;
  if (vm.hw.ramMB < Math.min(os.minRam, 1024) && os.family === 'linux') return `El instalador se ha quedado sin memoria (Kernel panic - not syncing: Out of memory). Asigne al menos ${os.minRam} MB.`;
  return null;
}

// ---------------------------------------------------------------- apagado y estados
export function powerOff(vm, how = 'hard') {
  if (vm.state !== 'running' && vm.state !== 'paused' && !(how === 'discard' && vm.state === 'saved')) return;
  cancelTimers(vm);
  vmLog(vm, how === 'acpi' ? 'Guest requested shutdown (ACPI)' : 'Console: Machine state changed to \'PoweredOff\'');
  vm.state = 'poweroff';
  vm.stateChanged = Date.now();
  vm.rt = null;
  logEvent({ type: 'vm-stop', vm: vm.id, how });
  commit({ vm: vm.id });
  emit('screen', vm);
}

export function acpiShutdown(vm) {
  if (vm.state !== 'running' || !vm.rt) return false;
  const ph = vm.rt.screen?.phase;
  if (!['console', 'win-desktop', 'win-login', 'linux-boot'].includes(ph)) {
    vmLog(vm, 'ACPI: power button pressed but the guest did not respond');
    return false;
  }
  setScreen(vm, { phase: 'shutting-down', win: OS_TYPES[vmContent(state, vm)?.os]?.family === 'windows' });
  later(vm, 1800, () => powerOff(vm, 'acpi'));
  return true;
}

export function rebootVm(vm) {
  if (vm.state !== 'running') return;
  cancelTimers(vm);
  vmLog(vm, 'Console: VM reset');
  const headless = vm.rt?.headless;
  vm.rt = { bootAt: Date.now(), screen: { phase: 'bios' }, ifaces: [], routes: [], services: {}, headless, history: [] };
  commit({ vm: vm.id });
  emit('screen', vm);
  later(vm, 1100, () => chooseBootDevice(vm));
}

export function saveState(vm) {
  if (vm.state !== 'running' && vm.state !== 'paused') return;
  cancelTimers(vm);
  vm.state = 'saved';
  vm.stateChanged = Date.now();
  vmLog(vm, 'Console: Machine state changed to \'Saved\'');
  logEvent({ type: 'vm-save', vm: vm.id });
  commit({ vm: vm.id });
  emit('screen', vm);
}

export function discardSaved(vm) {
  if (vm.state !== 'saved') return;
  vm.state = 'poweroff';
  vm.rt = null;
  commit({ vm: vm.id });
}

export function pauseVm(vm) { if (vm.state === 'running') { vm.state = 'paused'; vmLog(vm, 'Console: Machine state changed to \'Paused\''); commit({ vm: vm.id }); emit('screen', vm); } }
export function resumeVm(vm) { if (vm.state === 'paused') { vm.state = 'running'; vmLog(vm, 'Console: Machine state changed to \'Running\''); commit({ vm: vm.id }); emit('screen', vm); } }

// Al recargar la página, los temporizadores de arranque se pierden: se recolocan las pantallas intermedias
export function recoverAfterReload() {
  for (const vm of state.vms) {
    if ((vm.state === 'running' || vm.state === 'paused') && vm.rt) {
      const ph = vm.rt.screen?.phase;
      if (['bios', 'linux-boot', 'win-boot', 'rebooting', 'pxe', 'shutting-down'].includes(ph)) {
        const c = vmContent(state, vm);
        if (ph === 'shutting-down') { powerOff(vm); continue; }
        if (c && vm.rt.ifaces?.length !== undefined && ph !== 'bios') vm.rt.screen = { phase: OS_TYPES[c.os].family === 'windows' ? 'win-login' : 'console' };
        else { vm.rt.screen = { phase: 'bios' }; later(vm, 800, () => chooseBootDevice(vm)); }
      }
      if (ph === 'installing') { vm.rt.screen.progress = 0; const iso = vm.rt.screen.iso; runInstall(vm, iso, vm.unattended || vm.rt.screen.opts || { hostname: 'vm', user: 'usuario', pass: 'usuario' }); }
      vm.rt.session = vm.rt.session || null;
    }
  }
}

// ---------------------------------------------------------------- instantáneas
function snapshotPayload(vm, online) {
  const disks = {};
  for (const m of allSlots(vm).filter((x) => x.slot.kind === 'hdd' && x.slot.medium).map((x) => getMedium(x.slot.medium)).filter(Boolean)) disks[m.id] = clone(m.content || null);
  return {
    config: clone({ hw: vm.hw, storage: vm.storage, nics: vm.nics, shared: vm.shared, description: vm.description, osKey: vm.osKey }),
    disks,
    rt: online ? clone(vm.rt) : null,
    vmState: online ? 'saved' : 'poweroff',
  };
}

export function takeSnapshot(vm, name, desc = '') {
  const online = vm.state === 'running' || vm.state === 'paused' || vm.state === 'saved';
  const snap = { id: uid('s'), uuid: uuid(), name, desc, ts: Date.now(), parent: vm.currentSnap, online, ...snapshotPayload(vm, online) };
  vm.snapshots.push(snap);
  vm.currentSnap = snap.id;
  vmLog(vm, `Snapshot: Taking snapshot '${name}' {${snap.uuid}}${online ? ' (online, with saved state)' : ''}`);
  logEvent({ type: 'snapshot-take', vm: vm.id, name, online });
  commit({ vm: vm.id });
  return snap;
}

export function restoreSnapshot(vm, snapId) {
  const s = vm.snapshots.find((x) => x.id === snapId);
  if (!s) return { ok: false, error: 'Instantánea no encontrada' };
  if (vm.state === 'running' || vm.state === 'paused') return { ok: false, error: 'La máquina virtual debe estar apagada o guardada para restaurar una instantánea.' };
  Object.assign(vm, clone(s.config));
  for (const [mid, content] of Object.entries(s.disks)) {
    const m = getMedium(mid);
    if (m) m.content = clone(content);
  }
  vm.state = s.vmState;
  vm.rt = s.rt ? clone(s.rt) : null;
  vm.currentSnap = s.id;
  vm.stateChanged = Date.now();
  vmLog(vm, `Snapshot: Restoring snapshot '${s.name}'`);
  logEvent({ type: 'snapshot-restore', vm: vm.id, name: s.name });
  commit({ vm: vm.id });
  emit('screen', vm);
  return { ok: true };
}

export function deleteSnapshot(vm, snapId) {
  const s = vm.snapshots.find((x) => x.id === snapId);
  if (!s) return;
  vm.snapshots.forEach((c) => { if (c.parent === s.id) c.parent = s.parent; });
  if (vm.currentSnap === s.id) vm.currentSnap = s.parent;
  vm.snapshots = vm.snapshots.filter((x) => x.id !== s.id);
  logEvent({ type: 'snapshot-delete', vm: vm.id, name: s.name });
  commit({ vm: vm.id });
}

// ---------------------------------------------------------------- clonación
export function cloneVm(src, { name, folder, macPolicy = 'new', type = 'full', keepDiskNames = false, keepUuids = false, snapMode = 'current' }) {
  const vm = newVm({ name, osKey: src.osKey, ramMB: src.hw.ramMB, cpus: src.hw.cpus });
  vm.hw = clone(src.hw);
  vm.description = src.description;
  vm.shared = clone(src.shared);
  vm.storage = clone(src.storage);
  vm.folder = folder || `${state.prefs.machineFolder}\\${name}`;
  vm.nics = clone(src.nics).map((n) => {
    if (macPolicy === 'new' || (macPolicy === 'nat' && n.attach !== 'nat')) n.mac = vboxMac();
    return n;
  });
  if (keepUuids) vm.uuid = src.uuid;
  if (type === 'linked') {
    const base = takeSnapshot(src, `Linked Base for ${src.name} and ${name}`, '');
    base.linked = true;
  }
  for (const c of vm.storage) for (const s of c.slots) {
    if (s.kind !== 'hdd' || !s.medium) continue;
    const m = getMedium(s.medium);
    if (!m) continue;
    const nm = keepDiskNames ? m.name : `${name}${c.slots.filter((x) => x.kind === 'hdd').indexOf(s) > 0 ? `-disk${c.slots.indexOf(s) + 1}` : ''}.vdi`;
    const copy = newMedium('hdd', {
      name: type === 'linked' ? `{${uuid()}}.vdi` : nm,
      path: type === 'linked' ? `${vm.folder}\\Snapshots\\{diff}.vdi` : `${vm.folder}\\${nm}`,
      format: 'VDI', variant: type === 'linked' ? 'diff' : m.variant, sizeGB: m.sizeGB, usedGB: type === 'linked' ? 0.002 : m.usedGB, type: 'normal',
      content: clone(m.content), parent: type === 'linked' ? m.id : null,
    });
    state.media.hdd.push(copy);
    s.medium = copy.id;
  }
  if (snapMode === 'all' && type === 'full') vm.snapshots = [];
  state.vms.push(vm);
  vmLog(vm, `Cloned from '${src.name}' (${type === 'linked' ? 'linked' : 'full'} clone, MAC policy: ${macPolicy})`);
  logEvent({ type: 'clone', vm: vm.id, from: src.id, macPolicy, linked: type === 'linked' });
  state.selected = vm.id;
  commit();
  return vm;
}

// ---------------------------------------------------------------- eliminar / añadir
export function removeVm(vm, deleteFiles) {
  if (vm.state === 'running' || vm.state === 'paused') return { ok: false, error: 'No se puede eliminar una máquina en ejecución.' };
  const disks = allSlots(vm).filter((x) => x.slot.kind === 'hdd' && x.slot.medium).map((x) => x.slot.medium);
  state.vms = state.vms.filter((v) => v !== vm);
  if (deleteFiles) {
    state.media.hdd = state.media.hdd.filter((m) => !disks.includes(m.id) || state.vms.some((v) => allSlots(v).some((x) => x.slot.medium === m.id)));
  } else {
    state.unregistered ||= [];
    state.unregistered.push(clone(vm));
  }
  if (state.selected === vm.id) state.selected = state.vms[0]?.id || null;
  logEvent({ type: 'vm-remove', name: vm.name, deleteFiles });
  commit();
  return { ok: true };
}

export function registerVm(vmData) {
  const vm = clone(vmData);
  if (state.vms.some((v) => v.uuid === vm.uuid)) return { ok: false, error: `Ya existe una máquina virtual con el UUID {${vm.uuid}}.` };
  vm.state = 'poweroff'; vm.rt = null;
  state.vms.push(vm);
  state.unregistered = (state.unregistered || []).filter((v) => v.uuid !== vm.uuid);
  state.selected = vm.id;
  commit();
  return { ok: true, vm };
}

// ---------------------------------------------------------------- servicio virtualizado (OVA)
export function exportOva(vms, { file, format = 'OVF 1.0', macPolicy = 'nat', manifest = true }) {
  const items = vms.map((vm) => {
    const disks = allSlots(vm).filter((x) => x.slot.kind === 'hdd' && x.slot.medium).map((x) => clone(getMedium(x.slot.medium)));
    const copy = clone(vm);
    copy.rt = null; copy.state = 'poweroff'; copy.snapshots = []; copy.currentSnap = null; copy.log = [];
    return { vm: copy, disks };
  });
  const sizeMB = Math.round(items.reduce((a, it) => a + it.disks.reduce((b, d) => b + d.usedGB * 1024 * 0.42, 0), 0));
  const ova = { id: uid('ova'), file, path: `C:\\Users\\alumno\\Documents\\${file}`, format, macPolicy, manifest, items, sizeMB, ts: Date.now() };
  state.hostFiles.ova = state.hostFiles.ova.filter((o) => o.file !== file);
  state.hostFiles.ova.push(ova);
  logEvent({ type: 'export', vms: vms.map((v) => v.id), file });
  commit();
  return ova;
}

export function importOva(ova, { names = [], macPolicy = 'nat', folder }) {
  const created = [];
  ova.items.forEach((it, idx) => {
    const name = uniqueVmName(names[idx] || it.vm.name);
    const vm = clone(it.vm);
    vm.id = uid('vm'); vm.uuid = uuid(); vm.name = name; vm.folder = `${folder || state.prefs.machineFolder}\\${name}`;
    vm.state = 'poweroff'; vm.rt = null; vm.snapshots = []; vm.currentSnap = null; vm.log = [];
    vm.nics.forEach((n) => { if (macPolicy === 'new' || (macPolicy === 'nat' && n.attach !== 'nat')) n.mac = vboxMac(); });
    const map = {};
    it.disks.forEach((d, i) => {
      const nm = `${name}-disk00${i + 1}.vmdk`;
      const m = newMedium('hdd', { name: nm, path: `${vm.folder}\\${nm}`, format: 'VMDK', variant: 'dynamic', sizeGB: d.sizeGB, usedGB: d.usedGB, type: 'normal', content: clone(d.content), parent: null });
      state.media.hdd.push(m);
      map[d.id] = m.id;
    });
    for (const c of vm.storage) for (const s of c.slots) if (s.kind === 'hdd' && map[s.medium]) s.medium = map[s.medium]; else if (s.kind === 'hdd') s.medium = null;
    state.vms.push(vm);
    created.push(vm);
  });
  if (created[0]) state.selected = created[0].id;
  logEvent({ type: 'import', file: ova.file, vms: created.map((v) => v.id) });
  commit();
  return created;
}

// ---------------------------------------------------------------- creación (asistente)
export function createVmFromWizard(o) {
  const os = OS_TYPES[o.osKey] || OS_TYPES.other;
  let diskId = null;
  if (o.disk === 'new') {
    const nm = `${o.name}.vdi`;
    const m = newMedium('hdd', { name: nm, path: `${o.folder}\\${o.name}\\${nm}`, format: o.diskFormat || 'VDI', variant: o.prealloc ? 'fixed' : 'dynamic', sizeGB: o.diskGB, usedGB: o.prealloc ? o.diskGB : 0.002, type: 'normal', content: null, parent: null });
    state.media.hdd.push(m);
    diskId = m.id;
  } else if (o.disk && o.disk !== 'none') diskId = o.disk;
  let isoId = null;
  if (o.iso) {
    let m = state.media.dvd.find((d) => d.name === o.iso);
    if (!m) {
      const meta = ISOS.find((i) => i.file === o.iso);
      m = newMedium('dvd', { name: o.iso, path: `C:\\Users\\alumno\\Downloads\\ISO\\${o.iso}`, sizeMB: meta?.sizeMB || 1000, isoOs: detectIsoOs(o.iso) });
      state.media.dvd.push(m);
    }
    isoId = m.id;
  }
  const vm = newVm({ name: o.name, osKey: o.osKey, ramMB: o.ramMB, cpus: o.cpus, efi: o.efi, diskId, isoId });
  vm.folder = `${o.folder}\\${o.name}`;
  if (o.unattended) vm.unattended = { user: o.user, pass: o.pass, hostname: o.hostname, ga: o.ga, unattended: true, ssh: true };
  if (os.family === 'windows') { vm.hw.vram = 128; vm.hw.graphics = 'VMSVGA'; }
  state.vms.push(vm);
  state.selected = vm.id;
  logEvent({ type: 'vm-create', vm: vm.id, os: o.osKey, unattended: !!o.unattended });
  commit();
  return vm;
}

export { addDhcpdFiles, nowStamp, HOST_IFACES, MACHINE_FOLDER, linkOf, linkChanged };
