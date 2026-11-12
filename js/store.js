// Estado global de VirtLab, valores por defecto, persistencia y bus de eventos.
import { uid, uuid, vboxMac, clone } from './util.js';
import { OS_TYPES, ISOS, ISO_DIR, HOST_IFACES } from './catalog.js';
import { makeInstalledContent } from './guest.js';

export const STORAGE_KEY = 'virtlab_v2_state';
export const MACHINE_FOLDER = 'C:\\Users\\alumno\\VirtualBox VMs';

// ---------------- bus de eventos ----------------
const listeners = {};
export function on(ev, fn) { (listeners[ev] ||= []).push(fn); return () => { listeners[ev] = listeners[ev].filter((f) => f !== fn); }; }
export function emit(ev, data) { (listeners[ev] || []).slice().forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }

export let state = null;

export function defaultNic(slot, attach = 'none', extra = {}) {
  return {
    slot, enabled: attach !== 'none' || slot === 0, attach: attach === 'none' ? 'nat' : attach,
    natnet: 'NatNetwork', bridged: HOST_IFACES[0].name, intnet: 'intnet', hostonly: 'VirtualBox Host-Only Ethernet Adapter',
    generic: '', type: '82540EM', promisc: 'deny', mac: vboxMac(), cable: true, pf: [], ...extra,
  };
}

export function newMedium(kind, props) {
  return { id: uid('m'), uuid: uuid(), kind, ...props };
}

export function defaultStorage() {
  return [
    { id: 'ide', name: 'IDE', bus: 'IDE', type: 'PIIX4', hostIoCache: true, slots: [
      { port: 'IDE secundario maestro', kind: 'dvd', medium: null, live: false },
    ] },
    { id: 'sata', name: 'SATA', bus: 'SATA', type: 'AHCI', hostIoCache: false, portCount: 2, slots: [] },
  ];
}

export function newVm({ name, osKey, ramMB, cpus, efi = false, diskId = null, isoId = null, nics = null, description = '' }) {
  const os = OS_TYPES[osKey] || OS_TYPES.other;
  const storage = defaultStorage();
  if (isoId) storage[0].slots[0].medium = isoId;
  if (diskId) storage[1].slots.push({ port: 'Puerto SATA 0', kind: 'hdd', medium: diskId, ssd: false, hotplug: false });
  return {
    id: uid('vm'), uuid: uuid(), name, osKey, description, group: '/',
    folder: `${MACHINE_FOLDER}\\${name}`,
    hw: {
      ramMB, cpus, cpuCap: 100, chipset: 'PIIX3', tpm: os.needsTpm ? '2.0' : 'none', efi: efi || !!os.needsEfi, secureBoot: !!os.needsEfi,
      ioapic: true, utcClock: true, pae: false, nestedVt: false, nestedPaging: true, paravirt: 'Predeterminado',
      boot: [{ dev: 'floppy', on: false }, { dev: 'dvd', on: true }, { dev: 'hdd', on: true }, { dev: 'net', on: false }],
      pointing: 'Tableta USB', vram: os.family === 'windows' ? 128 : 16, monitors: 1, scale: 100, graphics: 'VMSVGA', accel3d: false,
      rdp: false, recording: false,
      audio: { enabled: true, driver: 'Predeterminado', controller: 'Intel HD Audio', out: true, in: false },
      usb: { enabled: true, ver: '2.0', filters: [] },
      serial: [{ enabled: false, mode: 'Desconectado', port: 'COM1' }],
      clipboard: 'Inhabilitado', dragdrop: 'Inhabilitado', diskEnc: false,
      miniToolbar: true,
    },
    storage,
    nics: nics || [defaultNic(0, 'nat'), defaultNic(1), defaultNic(2), defaultNic(3)],
    shared: [],
    state: 'poweroff', stateChanged: Date.now(),
    snapshots: [], currentSnap: null,
    unattended: null,
    rt: null,
    log: [],
    createdAt: Date.now(),
  };
}

function seedState() {
  const media = { hdd: [], dvd: [], floppy: [] };
  const iso = (file) => {
    const meta = ISOS.find((i) => i.file === file);
    const m = newMedium('dvd', { name: file, path: `${ISO_DIR}\\${file}`, sizeMB: meta.sizeMB, isoOs: meta.os });
    media.dvd.push(m);
    return m;
  };
  iso('ubuntu-24.04.1-live-server-amd64.iso');
  iso('VBoxGuestAdditions_7.1.4.iso');

  const vms = [];
  const disk = (vmName, sizeGB, usedGB, content) => {
    const m = newMedium('hdd', { name: `${vmName}.vdi`, path: `${MACHINE_FOLDER}\\${vmName}\\${vmName}.vdi`, format: 'VDI', variant: 'dynamic', sizeGB, usedGB, type: 'normal', content, parent: null });
    media.hdd.push(m);
    return m;
  };

  // 1. Ubuntu Server con NAT + solo anfitrión
  {
    const content = makeInstalledContent('ubuntu', { hostname: 'ubuntu-srv', user: 'usuario', pass: 'usuario', nics: 2 });
    const d = disk('Ubuntu Server', 25, 6.1, content);
    const vm = newVm({ name: 'Ubuntu Server', osKey: 'ubuntu', ramMB: 2048, cpus: 2, diskId: d.id,
      nics: [defaultNic(0, 'nat'), defaultNic(1, 'hostonly'), defaultNic(2), defaultNic(3)],
      description: 'Servidor de prácticas Ubuntu 24.04.1 LTS (OpenSSH instalado).\nUsuario: usuario   Contraseña: usuario' });
    vms.push(vm);
  }
  // 2. Windows 10 con NAT
  {
    const content = makeInstalledContent('win10', { hostname: 'DESKTOP-W10LAB', user: 'Usuario', pass: 'usuario', nics: 1 });
    const d = disk('Windows 10', 50, 19.4, content);
    const vm = newVm({ name: 'Windows 10', osKey: 'win10', ramMB: 4096, cpus: 2, diskId: d.id,
      description: 'Puesto cliente Windows 10 Pro 22H2.\nUsuario: Usuario   Contraseña: usuario' });
    vms.push(vm);
  }
  // 3. Debian en red interna (sin servidor DHCP)
  {
    const content = makeInstalledContent('debian', { hostname: 'debian-lab', user: 'usuario', pass: 'usuario', nics: 1 });
    const d = disk('Debian 12', 20, 2.3, content);
    const vm = newVm({ name: 'Debian 12', osKey: 'debian', ramMB: 1024, cpus: 1, diskId: d.id,
      nics: [defaultNic(0, 'intnet'), defaultNic(1), defaultNic(2), defaultNic(3)],
      description: 'Debian 12 mínima conectada a la red interna «intnet».\nUsuario: usuario   Contraseña: usuario' });
    vms.push(vm);
  }
  // 4. Kali Linux con NAT
  {
    const content = makeInstalledContent('kali', { hostname: 'kali', user: 'kali', pass: 'kali', nics: 1 });
    const d = disk('Kali Linux', 40, 14.8, content);
    const vm = newVm({ name: 'Kali Linux', osKey: 'kali', ramMB: 2048, cpus: 2, diskId: d.id,
      description: 'Kali Linux 2024.3 con herramientas de auditoría (nmap, netcat...).\nUsuario: kali   Contraseña: kali' });
    vms.push(vm);
  }

  return {
    version: 2,
    prefs: { theme: 'auto', didactic: true, bootSpeed: 'fast', machineFolder: MACHINE_FOLDER, hostKey: 'Ctrl Derecha', expert: true, autoCapture: true },
    host: {
      name: 'PC-AULA-07', user: 'alumno', ramMB: 16384, cpus: 8, cpuModel: 'Intel(R) Core(TM) i7-12700 (8 núcleos)',
      eth: { up: true, ip: '192.168.1.100', prefix: 24, gw: '192.168.1.1', mac: '3C7C3F2A91B4', dns: ['192.168.1.1'] },
      wifi: { up: false, ip: null, mac: '70A8D3B2C411' },
      icmpIn: true, sshd: false,
    },
    hostOnly: [{ name: 'VirtualBox Host-Only Ethernet Adapter', ip: '192.168.56.1', prefix: 24, dhcp: { enabled: true, server: '192.168.56.100', lower: '192.168.56.101', upper: '192.168.56.254' } }],
    natNets: [],
    intnetDhcp: [],
    leases: {},
    lan: {
      router: { ip: '192.168.1.1', wan: '83.47.112.25', dhcp: { lower: '192.168.1.101', upper: '192.168.1.199' }, mac: 'F4CAE5A1B2C3' },
      devices: [
        { ip: '192.168.1.10', name: 'PC-PROFESOR', mac: 'B42E99117A10', os: 'windows', ports: [135, 139, 445, 3389] },
        { ip: '192.168.1.20', name: 'HP-LaserJet-M404', mac: '6C02E0AA2020', os: 'printer', ports: [80, 443, 631, 9100] },
        { ip: '192.168.1.30', name: 'NAS-AULA', mac: '001132C0FF30', os: 'linux', ports: [22, 80, 139, 445] },
      ],
    },
    media,
    vms,
    hostFiles: { ova: [] },
    selected: vms[0].id,
    view: { tool: 'welcome', vmTool: {} },
    labs: { active: null, progress: {}, examMode: false },
    events: [],
  };
}

export function load() {
  let s = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) s = JSON.parse(raw);
  } catch { s = null; }
  if (!s || s.version !== 2) s = seedState();
  state = s;
  return state;
}

export function resetAll() {
  state = seedState();
  save();
  emit('change', { reset: true });
}

export function replaceState(s) {
  state = s;
  save();
  emit('change', { reset: true });
}

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* sin almacenamiento */ }
  }, 150);
}

export function commit(info = {}) {
  save();
  emit('change', info);
}

// --------------- consultas ----------------
export const getVm = (id) => state.vms.find((v) => v.id === id);
export const vmByName = (name) => state.vms.find((v) => v.name.toLowerCase() === String(name).toLowerCase() || v.uuid === name);
export const getMedium = (id) => id && (state.media.hdd.find((m) => m.id === id) || state.media.dvd.find((m) => m.id === id) || state.media.floppy.find((m) => m.id === id));
export const allSlots = (vm) => vm.storage.flatMap((c) => c.slots.map((s) => ({ ctrl: c, slot: s })));
export const vmDisks = (vm) => allSlots(vm).filter((x) => x.slot.kind === 'hdd' && x.slot.medium).map((x) => getMedium(x.slot.medium)).filter(Boolean);
export const vmDvd = (vm) => allSlots(vm).filter((x) => x.slot.kind === 'dvd');
export const bootDisk = (vm) => vmDisks(vm)[0] || null;
export function mediumUsers(mid) {
  return state.vms.filter((vm) => allSlots(vm).some((x) => x.slot.medium === mid) || vm.snapshots.some((s) => JSON.stringify(s.storage || []).includes(mid)));
}
export const runningVms = () => state.vms.filter((v) => v.state === 'running' || v.state === 'paused');

export function logEvent(ev) {
  const e = { t: Date.now(), ...ev };
  state.events.push(e);
  if (state.events.length > 400) state.events.splice(0, state.events.length - 400);
  emit('event', e);
  save();
  return e;
}

export function vmLog(vm, line) {
  const t = vm.rt?.bootAt ? (Date.now() - vm.rt.bootAt) / 1000 : 0;
  const hh = String(Math.floor(t / 3600)).padStart(2, '0');
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const ss = (t % 60).toFixed(6).padStart(9, '0');
  vm.log.push(`${hh}:${mm}:${ss} ${line}`);
  if (vm.log.length > 600) vm.log.splice(0, vm.log.length - 600);
}

export function uniqueVmName(base) {
  let n = base;
  let i = 1;
  while (state.vms.some((v) => v.name.toLowerCase() === n.toLowerCase())) n = `${base} ${++i}`;
  return n;
}

export { clone };
