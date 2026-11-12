// Ventana de una máquina virtual en ejecución: pantalla (BIOS, instalador, consola,
// escritorio de Windows), menús de VirtualBox y barra de estado con indicadores.
import { state, on, commit, getVm, getMedium, allSlots, logEvent, emit } from '../store.js';
import { OS_TYPES, VM_STATES, attachLabel, ISOS, LINUX_IFNAMES } from '../catalog.js';
import { esc, macColon } from '../util.js';
import { icon, osIcon } from './icons.js';
import { createWindow, getWindow, menubar, popupMenu, toast, msgBox, modal } from './wm.js';
import { Terminal } from '../terminal.js';
import { runLinux, linuxPrompt, motd, homeOf, completeLinux } from '../shell/linux.js';
import { runWindows, winPrompt, completeWindows } from '../shell/windows.js';
import { vmContent, linkOf, linkChanged, dhcpServerFor, segLabel } from '../net.js';
import { setScreen, runInstall, bootFromNextVolume, bootDevice, powerOff, rebootVm, pauseVm, resumeVm, acpiShutdown, saveState, takeSnapshot, restoreSnapshot } from '../vmctl.js';

const views = new Map(); // vmId -> { win, term, stack, ... }
const previewText = new Map();

export function openVmWindow(vm) {
  let v = views.get(vm.id);
  const existing = getWindow(`vm-${vm.id}`);
  if (existing) { existing.restore(); existing.focus(); return existing; }
  const win = createWindow({
    id: `vm-${vm.id}`, title: title(vm), iconHtml: osIcon(vm.osKey, 16), w: 900, h: 640, className: 'vmwin', minW: 420, minH: 300,
    onClose: () => { closeRequested(vm); return false; },
    onFocus: () => { const t = views.get(vm.id)?.term; if (t) setTimeout(() => t.focus(), 0); },
    content: (body) => {
      body.innerHTML = `<nav class="vm-menubar"></nav><div class="vm-display"><div class="vm-screen"></div></div><footer class="vm-status"></footer>`;
    },
  });
  v = { win, vm: vm.id, term: null, stack: [], phase: null, winCmd: null };
  views.set(vm.id, v);
  buildMenu(vm);
  render(vm);
  return win;
}

const title = (vm) => `${vm.name}${vm.currentSnap ? ` (${vm.snapshots.find((s) => s.id === vm.currentSnap)?.name})` : ''} [${VM_STATES[vm.state]?.label || vm.state}] - Oracle VirtualBox`;

on('screen', (vm) => { if (views.has(vm.id)) render(getVm(vm.id) || vm); });
on('change', () => {
  for (const [id, v] of views) {
    const vm = getVm(id);
    if (!vm || !getWindow(`vm-${id}`)) { views.delete(id); continue; }
    v.win.setTitle(title(vm));
    renderStatus(vm);
    if (vm.state === 'poweroff' || vm.state === 'saved' || vm.state === 'aborted') { getWindow(`vm-${id}`)?.close(true); views.delete(id); continue; }
    const pov = v.win.body.querySelector('.vm-paused-ov');
    if (vm.state === 'paused' && !pov) v.win.body.querySelector('.vm-display').insertAdjacentHTML('beforeend', '<div class="vm-paused-ov">La máquina virtual está en pausa</div>');
    if (vm.state !== 'paused' && pov) pov.remove();
  }
});
on('open-vm-window', (id) => { const vm = getVm(id); if (vm) openVmWindow(vm); });

async function closeRequested(vm) {
  const { closeVmDialog } = await import('./actions.js');
  const r = await closeVmDialog(vm);
  if (!r) return;
  const snap = vm.snapshots.find((s) => s.id === vm.currentSnap);
  if (r.choice === 'save') saveState(vm);
  else if (r.choice === 'acpi') { if (!acpiShutdown(vm)) toast('El sistema invitado no ha respondido a la señal de apagado.', { kind: 'warn' }); return; }
  else powerOff(vm);
  if (r.restore && snap) restoreSnapshot(vm, snap.id);
  getWindow(`vm-${vm.id}`)?.close(true);
  views.delete(vm.id);
}

// ------------------------------------------------------------------ menús de la ventana
function buildMenu(vm) {
  const v = views.get(vm.id);
  const A = () => import('./actions.js');
  menubar(v.win.body.querySelector('.vm-menubar'), [
    { label: 'Archivo', items: () => [
      { label: 'Preferencias…', icon: 'prefs', action: () => A().then((a) => a.preferences()) },
      '-',
      { label: 'Cerrar…', icon: 'stop', shortcut: 'Ctrl Derecha+Q', action: () => closeRequested(vm) },
    ] },
    { label: 'Máquina', items: () => [
      { label: 'Configuración…', icon: 'settings', shortcut: 'Ctrl Derecha+S', action: () => A().then((a) => a.openSettings(vm)) },
      { label: 'Tomar instantánea…', icon: 'snapTake', shortcut: 'Ctrl Derecha+T', action: () => A().then((a) => a.takeSnapshotDialog(vm)) },
      { label: 'Información de sesión', icon: 'info', shortcut: 'Ctrl Derecha+N', action: () => sessionInfo(vm) },
      '-',
      { label: vm.state === 'paused' ? 'Continuar' : 'Pausar', shortcut: 'Ctrl Derecha+P', action: () => (vm.state === 'paused' ? resumeVm(vm) : pauseVm(vm)) },
      { label: 'Reiniciar', shortcut: 'Ctrl Derecha+R', action: () => A().then((a) => a.resetDialog(vm)) },
      { label: 'Apagado ACPI', shortcut: 'Ctrl Derecha+H', action: () => { if (!acpiShutdown(vm)) toast('El sistema invitado no responde a la señal ACPI.', { kind: 'warn' }); } },
    ] },
    { label: 'Ver', items: () => [
      { label: 'Modo pantalla completa', shortcut: 'Ctrl Derecha+F', action: () => v.win.maximize() },
      { label: 'Ajustar tamaño de ventana', shortcut: 'Ctrl Derecha+A', action: () => { v.win.maximize(false); v.win.el.style.width = '900px'; v.win.el.style.height = '640px'; } },
      '-',
      { label: 'Asistente VirtLab (explicaciones)', icon: 'assistant', action: () => A().then((a) => a.openAssistant()) },
      { label: 'Mostrar en el Administrador', icon: 'vbox', action: () => { state.selected = vm.id; commit(); import('./wm.js').then((w) => w.getWindow('manager')?.restore()); } },
    ] },
    { label: 'Entrada', items: () => [
      { label: 'Teclado', submenu: [
        { label: 'Insertar Ctrl+Alt+Supr', shortcut: 'Ctrl Derecha+Supr', action: () => sendCad(vm) },
        { label: 'Insertar Ctrl+C', action: () => views.get(vm.id)?.term?.abort() },
      ] },
      { label: 'Integración del ratón', checked: true, action: () => {} },
    ] },
    { label: 'Dispositivos', items: () => devicesMenu(vm) },
    { label: 'Ayuda', items: () => [
      { label: 'Contenidos…', icon: 'question', action: () => A().then((a) => a.helpContents()) },
      { label: 'Acerca de VirtLab…', icon: 'info', action: () => A().then((a) => a.about()) },
    ] },
  ]);
}

function devicesMenu(vm) {
  const dvdSlot = allSlots(vm).find((x) => x.slot.kind === 'dvd');
  const cur = dvdSlot && getMedium(dvdSlot.slot.medium);
  const A = () => import('./actions.js');
  return [
    { label: 'Unidades ópticas', icon: 'dvd', disabled: !dvdSlot, submenu: () => [
      { label: 'Elegir/crear un disco óptico virtual…', action: async () => { const { chooseIso } = await import('./settings.js'); const m = await chooseIso(); if (m) { dvdSlot.slot.medium = m.id; commit(); logEvent({ type: 'dvd', vm: vm.id, iso: m.name }); } } },
      '-',
      ...state.media.dvd.slice(-6).map((m) => ({ label: m.name, checked: cur?.id === m.id, action: () => { dvdSlot.slot.medium = m.id; commit(); logEvent({ type: 'dvd', vm: vm.id, iso: m.name }); } })),
      '-',
      { label: 'Eliminar disco de la unidad virtual', disabled: !cur, action: () => ejectDvd(vm, dvdSlot) },
    ] },
    { label: 'Audio', icon: 'audio', submenu: [{ label: 'Salida', checked: vm.hw.audio.out }, { label: 'Entrada', checked: vm.hw.audio.in }] },
    { label: 'Red', icon: 'net', submenu: () => [
      ...vm.nics.filter((n) => n.enabled).map((n) => ({ label: `Conectar cable de red del adaptador ${n.slot + 1}`, checked: n.cable, action: () => toggleCable(vm, n) })),
      '-',
      { label: 'Configuración de red…', icon: 'settings', action: () => A().then((a) => a.openSettings(vm, 'network')) },
    ] },
    { label: 'USB', icon: 'usb', submenu: [{ label: 'Kingston DataTraveler 3.0 [0001]', checked: false, action: () => toast('Dispositivo USB capturado por la máquina virtual (simulado).') }, '-', { label: 'Configuración de USB…', action: () => A().then((a) => a.openSettings(vm, 'usb')) }] },
    { label: 'Carpetas compartidas', icon: 'shared', submenu: [{ label: 'Configuración de carpetas compartidas…', action: () => A().then((a) => a.openSettings(vm, 'shared')) }] },
    { label: 'Portapapeles compartido', submenu: ['Inhabilitado', 'Anfitrión a invitado', 'Invitado a anfitrión', 'Bidireccional'].map((c) => ({ label: c, checked: vm.hw.clipboard === c, action: () => { vm.hw.clipboard = c; commit(); } })) },
    { label: 'Arrastrar y soltar', submenu: ['Inhabilitado', 'Anfitrión a invitado', 'Invitado a anfitrión', 'Bidireccional'].map((c) => ({ label: c, checked: vm.hw.dragdrop === c, action: () => { vm.hw.dragdrop = c; commit(); } })) },
    '-',
    { label: 'Insertar imagen de CD de las «Guest Additions»…', icon: 'dvd', disabled: !dvdSlot, action: () => insertGA(vm, dvdSlot) },
  ];
}

function insertGA(vm, dvdSlot) {
  let ga = state.media.dvd.find((m) => m.isoOs === 'ga');
  if (!ga) return;
  dvdSlot.slot.medium = ga.id;
  if (vm.rt) vm.rt.cdMounted = null;
  commit();
  logEvent({ type: 'dvd', vm: vm.id, iso: ga.name });
  const c = vmContent(state, vm);
  const fam = OS_TYPES[c?.os]?.family;
  toast(fam === 'windows' ? 'CD de las Guest Additions insertado (unidad D:). Ejecute <code>D:\\VBoxWindowsAdditions.exe</code> en un símbolo del sistema de administrador.' : 'CD de las Guest Additions insertado. En Linux: <code>sudo mount /dev/cdrom /mnt</code> y <code>sudo /mnt/VBoxLinuxAdditions.run</code>.');
}
function ejectDvd(vm, dvdSlot) {
  if (vm.rt?.cdMounted) { msgBox({ kind: 'warn', title: 'VirtualBox - Aviso', text: '<p>El sistema invitado tiene montado el disco óptico. Desmóntelo antes (<code>sudo umount /mnt</code>). ¿Forzar la expulsión?</p>', buttons: [{ label: 'Forzar desmontaje', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }] }).then((ok) => { if (ok) { vm.rt.cdMounted = null; dvdSlot.slot.medium = null; commit(); } }); return; }
  dvdSlot.slot.medium = null;
  commit();
  logEvent({ type: 'dvd-eject', vm: vm.id });
}
function toggleCable(vm, n) {
  n.cable = !n.cable;
  linkChanged(state, vm);
  logEvent({ type: 'cable', vm: vm.id, slot: n.slot, on: n.cable });
  commit();
}
async function sessionInfo(vm) {
  const c = vmContent(state, vm);
  const rows = vm.rt.ifaces.map((i) => { const n = vm.nics[i.slot]; const L = linkOf(state, vm, n); return `<tr><td>Adaptador ${i.slot + 1} (${esc(i.name)})</td><td>${esc(attachLabel(n.attach))}</td><td>${L.up ? 'Conectado' : esc(L.reason)}</td><td>${i.addrs.map((a) => `${a.ip}/${a.prefix}`).join(', ') || '—'}</td><td style="font-family:var(--mono)">${macColon(n.mac)}</td></tr>`; }).join('');
  await modal({ title: `${vm.name} - Información de sesión`, iconName: 'info', width: 720, html: `<div class="form-grid"><label>Estado:</label><span>${VM_STATES[vm.state].label} desde ${new Date(vm.stateChanged).toLocaleTimeString('es-ES')}</span><label>Sistema invitado:</label><span>${esc(c ? OS_TYPES[c.os].label : 'Desconocido')}</span><label>Guest Additions:</label><span>${c?.ga ? 'Versión 7.1.4' : 'No detectadas'}</span><label>Nombre de host:</label><span>${esc(c?.hostname || '—')}</span></div><h4 style="margin:14px 0 6px">Red</h4><div class="tblwrap"><table class="tbl"><thead><tr><th>Adaptador</th><th>Conectado a</th><th>Enlace</th><th>IPv4</th><th>MAC</th></tr></thead><tbody>${rows || '<tr><td colspan="5">Sin adaptadores</td></tr>'}</tbody></table></div>`, buttons: [{ label: 'Cerrar', value: true, primary: true }] });
}
function sendCad(vm) {
  const v = views.get(vm.id);
  const ph = vm.rt?.screen?.phase;
  if (ph === 'win-login' || ph === 'win-desktop') { toast('Ctrl+Alt+Supr enviado al invitado.'); return; }
  if (ph === 'console') { rebootVm(vm); return; }
  v?.term?.abort();
}

// ------------------------------------------------------------------ barra de estado
function renderStatus(vm) {
  const v = views.get(vm.id); if (!v) return;
  const bar = v.win.body.querySelector('.vm-status');
  const dvd = allSlots(vm).find((x) => x.slot.kind === 'dvd' && x.slot.medium);
  const nics = vm.nics.filter((n) => n.enabled);
  const netOn = nics.some((n) => linkOf(state, vm, n).up);
  const recent = state.events.some((e) => e.from === vm.id && Date.now() - e.t < 2500);
  const c = vmContent(state, vm);
  const tip = nics.map((n) => { const L = linkOf(state, vm, n); const i = vm.rt?.ifaces.find((x) => x.slot === n.slot); return `Adaptador ${n.slot + 1} (${attachLabel(n.attach)}): ${L.up ? 'cable conectado' : L.reason}${i?.addrs.length ? ` · ${i.addrs.map((a) => a.ip).join(', ')}` : ''}`; }).join('\n') || 'Sin adaptadores de red';
  bar.innerHTML = `
    <button title="Disco duro: ${esc(allSlots(vm).filter((x) => x.slot.kind === 'hdd').map((x) => getMedium(x.slot.medium)?.name).join(', ') || 'ninguno')}" class="${recent ? 'act' : ''}" data-sb="hdd">${icon('hdd', 18)}</button>
    <button title="Unidad óptica: ${esc(dvd ? getMedium(dvd.slot.medium)?.name : 'vacía')}" class="${dvd ? '' : 'off'}" data-sb="dvd">${icon('dvd', 18)}</button>
    <button title="Audio" class="${vm.hw.audio.enabled ? '' : 'off'}" data-sb="audio">${icon('audio', 18)}</button>
    <button title="${esc(tip)}" class="${netOn ? '' : 'off'} ${netOn && recent ? 'act' : ''}" data-sb="net">${icon('net', 18)}</button>
    <button title="USB" class="${vm.hw.usb.enabled ? '' : 'off'}" data-sb="usb">${icon('usb', 18)}</button>
    <button title="Carpetas compartidas: ${vm.shared.length}" class="${vm.shared.length ? '' : 'off'}" data-sb="shared">${icon('shared', 18)}</button>
    <button title="Pantalla" data-sb="display">${icon('display', 18)}</button>
    <button title="Grabación" class="${vm.hw.recording ? '' : 'off'}" data-sb="rec">${icon('record', 18)}</button>
    <button title="Integración del ratón ${c?.ga ? 'activada' : '(sin Guest Additions)'}" class="${c?.ga ? '' : 'off'}" data-sb="mouse">${icon('mouse', 18)}</button>
    <button title="Captura de teclado" data-sb="kbd">${icon('keyboard', 18)}</button>
    <span class="hostkey">Ctrl Derecha</span>`;
  bar.querySelectorAll('[data-sb]').forEach((b) => {
    b.onclick = (e) => {
      const r = b.getBoundingClientRect();
      const k = b.dataset.sb;
      if (k === 'net') popupMenu(r.left, r.top - 120, devicesMenu(vm)[2].submenu());
      else if (k === 'dvd') popupMenu(r.left, r.top - 200, devicesMenu(vm)[0].submenu());
      else if (k === 'shared') import('./actions.js').then((a) => a.openSettings(vm, 'shared'));
      else if (k === 'hdd') import('./actions.js').then((a) => a.openSettings(vm, 'storage'));
      else if (k === 'usb') import('./actions.js').then((a) => a.openSettings(vm, 'usb'));
    };
  });
}

// ------------------------------------------------------------------ pantalla
function render(vm) {
  const v = views.get(vm.id);
  if (!v || !vm.rt) return;
  v.win.setTitle(title(vm));
  renderStatus(vm);
  const scr = v.win.body.querySelector('.vm-screen');
  const s = vm.rt.screen || { phase: 'bios' };
  const c = vmContent(state, vm);
  const keep = (s.phase === 'console' && v.phase === 'console') || (s.phase === 'win-desktop' && v.phase === 'win-desktop') || (s.phase === 'installing' && v.phase === 'installing');
  if (keep) { if (s.phase === 'installing') updateInstalling(scr, s); return; }
  v.phase = s.phase;
  v.term = null;
  v.stack = [];
  scr.onkeydown = null;
  scr.tabIndex = -1;
  switch (s.phase) {
    case 'bios':
      scr.innerHTML = vm.hw.efi
        ? `<div class="bios"><div class="bios-logo">VirtualBox<small>UEFI Firmware · Secure Boot ${vm.hw.secureBoot ? 'enabled' : 'disabled'}</small></div></div>`
        : `<div class="bios"><div class="bios-logo">VirtualBox<small>${esc(OS_TYPES[vm.osKey].version)}</small></div><div class="bios-foot">Press F12 to select boot device.</div></div>`;
      scr.tabIndex = 0; scr.focus();
      scr.onkeydown = (e) => { if (e.key === 'F12') { e.preventDefault(); vm.rt.screen = { phase: 'bootmenu' }; render(vm); } };
      break;
    case 'bootmenu': {
      const devs = [['floppy', 'Floppy'], ['hdd', 'Hard disk'], ['dvd', 'CD-ROM'], ['net', 'LAN']];
      scr.innerHTML = `<div class="textscr">Please select boot device:\n\n${devs.map(([d, l], i) => `${i + 1}) ${l}`).join('\n')}\n\n<span class="dim">b) Continue booting\nENTER) Continue booting\n\nPulse el número del dispositivo.</span></div>`;
      scr.tabIndex = 0; scr.focus();
      scr.onkeydown = (e) => { const k = e.key.toLowerCase(); if (/^[1-4]$/.test(k)) { e.preventDefault(); bootDevice(vm, devs[Number(k) - 1][0]); } else if (k === 'b' || k === 'enter') { e.preventDefault(); bootDevice(vm, null); } };
      break;
    }
    case 'nobootable':
      scr.innerHTML = '<div class="textscr">FATAL: No bootable medium found! System halted.\n<span class="term-cursor"> </span></div>';
      emit('didactic', { title: 'No hay ningún medio de arranque', status: 'error', explain: ['La BIOS ha recorrido el orden de arranque (disquete, óptica, disco duro…) y no ha encontrado nada arrancable.', 'Si es una máquina nueva: el disco está vacío. Inserte la ISO del sistema en Dispositivos › Unidades ópticas (o en Configuración › Almacenamiento) y reinicie (Máquina › Reiniciar).', 'Si ya estaba instalada: compruebe que el disco sigue conectado al controlador y que «Disco duro» está marcado en el orden de arranque.'] });
      break;
    case 'efishell':
      scr.innerHTML = '<div class="textscr">UEFI Interactive Shell v2.2\nEDK II\nUEFI v2.70 (EDK II, 0x00010000)\nMapping table\n      BLK0: Alias(s):\n          PciRoot(0x0)/Pci(0x1,0x1)/Ata(0x0)\nPress ESC in 1 seconds to skip startup.nsh or any other key to continue.\nShell> <span class="term-cursor"> </span></div>';
      emit('didactic', { title: 'El firmware EFI no encuentra nada que arrancar', status: 'error', explain: ['Con EFI habilitado, si no hay ningún medio arrancable se abre la «UEFI Interactive Shell».', 'Inserte la ISO de instalación (Dispositivos › Unidades ópticas) y reinicie la máquina, o revise el orden de arranque.'] });
      break;
    case 'pxe': {
      const n = vm.nics.find((x) => x.enabled);
      const ok = n && linkOf(state, vm, n).up && dhcpServerFor(state, vm, n.slot);
      scr.innerHTML = `<div class="textscr">iPXE (PCI 00:03.0) starting execution...ok\niPXE initialising devices...ok\n\niPXE 1.21.1+ -- Open Source Network Boot Firmware -- https://ipxe.org\nFeatures: DNS HTTP iSCSI TFTP VLAN AoE ELF MBOOT PXE bzImage Menu PXEXT\n\nnet0: ${macColon(n?.mac || '080027000000')} using 82540em on 0000:00:03.0 (open)\n  [Link:${n && linkOf(state, vm, n).up ? 'up' : 'down'}, TX:0 TXE:0 RX:0 RXE:0]\nConfiguring (net0 ${macColon(n?.mac || '080027000000')})...... ${ok ? 'ok' : 'No configuration methods succeeded (https://ipxe.org/040ee186)'}\n${ok ? 'net0: no filename received\n' : ''}Nothing to boot: No such file or directory (https://ipxe.org/2d03e13b)\nNo more network devices\n</div>`;
      break;
    }
    case 'isomenu': renderIsoMenu(vm, scr, s); break;
    case 'install-form': renderInstallForm(vm, scr, s); break;
    case 'installing': renderInstalling(vm, scr, s); break;
    case 'install-done': renderInstallDone(vm, scr, s); break;
    case 'install-error': renderInstallError(vm, scr, s); break;
    case 'win-presskey':
      scr.innerHTML = '<div class="textscr">Press any key to boot from CD or DVD.<span class="term-cursor">.</span></div>';
      scr.tabIndex = 0; scr.focus();
      scr.onkeydown = (e) => { e.preventDefault(); vm.rt.screen = { phase: 'install-form', iso: s.iso }; render(vm); };
      scr.onclick = () => scr.focus();
      break;
    case 'rebooting': scr.innerHTML = ''; break;
    case 'linux-boot': renderLinuxBoot(vm, scr, s, c); break;
    case 'console': renderConsole(vm, scr, c); break;
    case 'win-boot': scr.innerHTML = `<div class="win-boot">${winLogo(56)}<div class="spinner"></div></div>`; break;
    case 'win-login': renderWinLogin(vm, scr, c); break;
    case 'win-desktop': renderWinDesktop(vm, scr, c); break;
    case 'shutting-down':
      scr.innerHTML = s.win ? '<div class="win-boot"><div class="spinner"></div>Apagando</div>' : `<div class="textscr">[  <span class="ok">OK</span>  ] Stopped target graphical.target - Graphical Interface.\n[  <span class="ok">OK</span>  ] Stopped ssh.service - OpenBSD Secure Shell server.\n[  <span class="ok">OK</span>  ] Stopped systemd-networkd.service - Network Configuration.\n[  <span class="ok">OK</span>  ] Unmounted boot.mount - /boot.\n[  <span class="ok">OK</span>  ] Reached target shutdown.target - System Shutdown.\n[  <span class="ok">OK</span>  ] Reached target final.target - Late Shutdown Services.\n         Starting systemd-poweroff.service - System Power Off...\n[   42.118311] reboot: Power down</div>`;
      break;
    default: scr.innerHTML = '';
  }
  if (vm.state === 'paused' && !v.win.body.querySelector('.vm-paused-ov')) v.win.body.querySelector('.vm-display').insertAdjacentHTML('beforeend', '<div class="vm-paused-ov">La máquina virtual está en pausa</div>');
}

function winLogo(size) { return `<svg width="${size}" height="${size}" viewBox="0 0 32 32"><path d="M2 5l12-1.7V15H2zM15.5 3.1L30 1v14H15.5zM2 16.5h12v11.7L2 26.5zM15.5 16.5H30V31l-14.5-2z" fill="#3d9cf0"/></svg>`; }

// ------------------------------------------------------------------ menú de la ISO e instalador
function isoMenuItems(iso, vm) {
  const os = OS_TYPES[iso];
  if (iso === 'ubuntu') return { title: 'GNU GRUB  version 2.12', items: [['install', '*Try or Install Ubuntu Server'], ['install', 'Ubuntu Server with the HWE kernel'], ['next', 'Boot from next volume'], ...(vm.hw.efi ? [['fw', 'UEFI Firmware Settings']] : [])], foot: 'Use the ↑ and ↓ keys to select which entry is highlighted.\nPress enter to boot the selected OS.' };
  if (iso === 'kali') return { title: 'Kali Linux installer menu (BIOS mode)', items: [['install', 'Graphical install'], ['install', 'Install'], ['adv', 'Advanced options'], ['next', 'Boot from first hard disk']], foot: 'Press ENTER to boot or TAB to edit a menu entry' };
  return { title: `Debian GNU/Linux installer menu (${vm.hw.efi ? 'UEFI' : 'BIOS'} mode)`, items: [['install', 'Graphical install'], ['install', 'Install'], ['adv', 'Advanced options'], ['adv', 'Accessible dark contrast installer menu'], ['help', 'Help'], ['speech', 'Install with speech synthesis']], foot: 'Press ENTER to boot or TAB to edit a menu entry' };
}
function renderIsoMenu(vm, scr, s) {
  const m = isoMenuItems(s.iso, vm);
  let sel = s.sel || 0;
  const draw = () => {
    scr.innerHTML = `<div class="isomenu" role="menu"><div class="h">${esc(m.title)}</div>${m.items.map(([k, l], i) => `<button class="${i === sel ? 'sel' : ''}" data-i="${i}" role="menuitem">${esc(l)}</button>`).join('')}<div class="f">${esc(m.foot)}</div></div>`;
    scr.querySelectorAll('button').forEach((b) => { b.onclick = () => { sel = Number(b.dataset.i); choose(); }; });
  };
  const choose = () => {
    const k = m.items[sel][0];
    if (k === 'install') { vm.rt.screen = { phase: 'install-form', iso: s.iso }; render(vm); }
    else if (k === 'next') { bootFromNextVolume(vm); }
    else if (k === 'fw') { toast('Configuración del firmware UEFI (no simulada).'); }
    else toast('Opción no simulada en VirtLab: elija «Install».');
  };
  draw();
  scr.tabIndex = 0; setTimeout(() => scr.focus(), 30);
  scr.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % m.items.length; draw(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + m.items.length) % m.items.length; draw(); }
    if (e.key === 'Enter') { e.preventDefault(); choose(); }
  };
}

function renderInstallForm(vm, scr, s) {
  const iso = s.iso;
  const os = OS_TYPES[iso];
  const disk = allSlots(vm).find((x) => x.slot.kind === 'hdd' && x.slot.medium);
  const m = disk && getMedium(disk.slot.medium);
  const fam = os.family;
  const cls = fam === 'windows' ? 'win' : iso;
  const nets = vm.nics.filter((n) => n.enabled).map((n) => {
    const srv = dhcpServerFor(state, vm, n.slot);
    const L = linkOf(state, vm, n);
    return `<tr><td>${fam === 'windows' ? `Ethernet${n.slot ? ` ${n.slot + 1}` : ''}` : LINUX_IFNAMES[n.slot]}</td><td>${esc(attachLabel(n.attach))}</td><td>${!L.up ? 'sin enlace' : srv ? `DHCPv4 · ${srv.fixed || srv.lower}…` : 'sin DHCP: no configurada'}</td></tr>`;
  }).join('') || '<tr><td colspan="3">No se ha detectado ninguna tarjeta de red</td></tr>';
  const defUser = fam === 'windows' ? 'Usuario' : 'usuario';
  scr.innerHTML = `<div class="installer ${cls}"><div class="inst-h">${fam === 'windows' ? `Programa de instalación de ${esc(os.label)}` : iso === 'ubuntu' ? 'Configuración del perfil · Instalador de Ubuntu Server' : `Instalar ${esc(os.label)}`}</div>
  <div class="inst-b"><div class="form-grid">
    ${fam === 'windows' ? `<label>Edición:</label><select><option>${esc(ISOS.find((i) => i.os === iso)?.edition || os.label)}</option></select>` : ''}
    <label>Nombre del equipo:</label><input type="text" id="if-host" value="${esc(fam === 'windows' ? `DESKTOP-${vm.name.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 7) || 'VM'}` : vm.name.toLowerCase().replace(/[^a-z0-9-]/g, '') || 'servidor')}">
    <label>Nombre de usuario:</label><input type="text" id="if-user" value="${defUser}">
    <label>Contraseña:</label><input type="password" id="if-pass" value="">
    <label>Confirmar contraseña:</label><input type="password" id="if-pass2" value="">
    ${fam === 'linux' ? '<label></label><label class="chk"><input type="checkbox" id="if-ssh" checked> Instalar el servidor OpenSSH</label>' : '<label></label><label class="chk"><input type="checkbox" id="if-lic"> Acepto los términos de licencia del software de Microsoft</label>'}
    <label>Disco de destino:</label><span>${m ? `${esc(m.name)} — ${m.sizeGB} GB${m.content ? ' <b style="color:#c62828">(contiene un sistema: se borrará)</b>' : ' (espacio sin asignar)'}` : '<b style="color:#c62828">No se ha detectado ningún disco</b>'}</span>
  </div>
  <div><b>Conexiones de red</b><table class="tbl" style="margin-top:4px"><tbody>${nets}</tbody></table></div>
  <div id="if-err" style="color:#c62828;min-height:16px"></div></div>
  <div class="inst-f"><button class="btn" id="if-cancel">Cancelar</button><button class="btn primary" id="if-ok">${fam === 'windows' ? 'Siguiente' : 'Hecho'}</button></div></div>`;
  scr.querySelector('#if-user').focus();
  scr.querySelector('#if-cancel').onclick = () => { vm.rt.screen = fam === 'windows' ? { phase: 'install-error', iso, error: 'Se canceló la instalación. Reinicie la máquina para volver a intentarlo.' } : { phase: 'isomenu', iso, sel: 0 }; render(vm); };
  const ok = () => {
    const host = scr.querySelector('#if-host').value.trim();
    const user = scr.querySelector('#if-user').value.trim();
    const pass = scr.querySelector('#if-pass').value;
    const pass2 = scr.querySelector('#if-pass2').value;
    const err = (t) => { scr.querySelector('#if-err').textContent = t; };
    if (!/^[A-Za-z0-9-]{1,63}$/.test(host)) return err('El nombre del equipo solo puede contener letras, números y guiones.');
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(user) || (fam === 'linux' && /[A-Z]/.test(user))) return err(fam === 'linux' ? 'El nombre de usuario debe empezar por letra y estar en minúsculas.' : 'Nombre de usuario no válido.');
    if (!pass) return err('La contraseña no puede estar vacía.');
    if (pass !== pass2) return err('Las contraseñas no coinciden.');
    if (fam === 'windows' && !scr.querySelector('#if-lic').checked) return err('Debe aceptar los términos de licencia para continuar.');
    vm.rt.screen.opts = { hostname: host, user, pass, ssh: fam === 'linux' ? scr.querySelector('#if-ssh').checked : false };
    runInstall(vm, iso, vm.rt.screen.opts);
  };
  scr.querySelector('#if-ok').onclick = ok;
  scr.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
}
function renderInstalling(vm, scr, s) {
  const os = OS_TYPES[s.iso];
  const cls = os.family === 'windows' ? 'win' : s.iso;
  scr.innerHTML = `<div class="installer ${cls}"><div class="inst-h">${os.family === 'windows' ? 'Instalando Windows' : `Instalando ${esc(os.label)}`}${s.unattended ? ' (instalación desatendida)' : ''}</div><div class="inst-b"><div class="inst-step">${esc(s.step || 'Preparando…')}</div><div class="progress"><div style="width:${Math.round(s.progress || 0)}%"></div></div><div class="inst-pct hint" style="color:inherit">${Math.round(s.progress || 0)} %</div>${os.family === 'windows' ? '<p style="margin:0;font-size:12px">Es posible que el equipo se reinicie varias veces.</p>' : ''}</div></div>`;
}
function updateInstalling(scr, s) {
  const bar = scr.querySelector('.progress > div'); if (bar) bar.style.width = `${Math.round(s.progress || 0)}%`;
  const st = scr.querySelector('.inst-step'); if (st) st.textContent = s.step || '';
  const p = scr.querySelector('.inst-pct'); if (p) p.textContent = `${Math.round(s.progress || 0)} %`;
}
function renderInstallDone(vm, scr, s) {
  const os = OS_TYPES[s.iso];
  if (os.family === 'windows') {
    scr.innerHTML = `<div class="installer win"><div class="inst-h">Windows necesita reiniciarse para continuar</div><div class="inst-b"><p>El equipo se reiniciará en <b id="cd">8</b> segundos.</p></div><div class="inst-f"><button class="btn primary" id="rb">Reiniciar ahora</button></div></div>`;
    let n = 8;
    const t = setInterval(() => { n--; const el = scr.querySelector('#cd'); if (!el || vm.rt?.screen?.phase !== 'install-done') { clearInterval(t); return; } el.textContent = n; if (n <= 0) { clearInterval(t); rebootVm(vm); } }, 1000);
    scr.querySelector('#rb').onclick = () => { clearInterval(t); rebootVm(vm); };
    emit('didactic', { title: 'Instalación terminada', status: 'ok', explain: ['Windows se reinicia. Ojo: si la ISO sigue en la unidad óptica y la óptica va antes que el disco en el orden de arranque, aparecerá «Press any key to boot from CD or DVD…»: no pulse nada y arrancará desde el disco.'] });
    return;
  }
  scr.innerHTML = `<div class="installer ${s.iso}"><div class="inst-h">Instalación completada</div><div class="inst-b"><p>El sistema se ha instalado correctamente en el disco.</p><p>Retire el medio de instalación y reinicie.</p></div><div class="inst-f"><button class="btn primary" id="rb">Reiniciar ahora</button></div></div>`;
  scr.querySelector('#rb').onclick = () => {
    scr.innerHTML = '<div class="textscr">[FAILED] Failed unmounting cdrom.mount - /cdrom.\nPlease remove the installation medium, then press ENTER: <span class="term-cursor"> </span></div>';
    scr.tabIndex = 0; scr.focus();
    scr.onkeydown = (e) => { if (e.key === 'Enter') rebootVm(vm); };
    scr.onclick = () => scr.focus();
  };
  emit('didactic', { title: 'Instalación terminada', status: 'ok', explain: ['Antes de reiniciar, expulse la ISO: Dispositivos › Unidades ópticas › Eliminar disco de la unidad virtual.', 'Si no lo hace, como la unidad óptica va antes que el disco duro en el orden de arranque, la máquina volverá a arrancar el instalador.'] });
}
function renderInstallError(vm, scr, s) {
  const os = OS_TYPES[s.iso] || OS_TYPES.other;
  scr.innerHTML = `<div class="installer ${os.family === 'windows' ? 'win' : s.iso}"><div class="inst-h">${os.family === 'windows' ? 'Programa de instalación de Windows' : 'Error en la instalación'}</div><div class="inst-b"><p style="white-space:pre-wrap">${esc(s.error)}</p></div><div class="inst-f"><button class="btn" id="ie-off">Apagar</button><button class="btn primary" id="ie-back">Atrás</button></div></div>`;
  scr.querySelector('#ie-off').onclick = () => powerOff(vm);
  scr.querySelector('#ie-back').onclick = () => { vm.rt.screen = { phase: 'install-form', iso: s.iso }; render(vm); };
  emit('didactic', { title: 'La instalación no puede continuar', status: 'error', explain: [s.error.replace(/\n+/g, ' '), 'Apague la máquina, corrija la configuración (Configuración › Sistema / Almacenamiento) y vuelva a iniciarla.'] });
}

// ------------------------------------------------------------------ arranque de Linux
function renderLinuxBoot(vm, scr, s, c) {
  const os = OS_TYPES[c.os];
  const lines = [
    `[    0.000000] Linux version ${os.kernel} (buildd@lcy02-amd64-051) (x86_64-linux-gnu-gcc-13 (Ubuntu 13.2.0-23ubuntu4) 13.2.0) #45-Ubuntu SMP PREEMPT_DYNAMIC`,
    `[    0.000000] Hypervisor detected: KVM`,
    `[    0.412200] e1000: Intel(R) PRO/1000 Network Driver`,
    ...vm.nics.filter((n) => n.enabled).map((n) => `[    0.98${n.slot}000] e1000 0000:00:0${[3, 8, 9, 10][n.slot]}.0 ${LINUX_IFNAMES[n.slot]}: renamed from eth${n.slot}`),
    `[  <span class="ok">OK</span>  ] Started systemd-journald.service - Journal Service.`,
    `[  <span class="ok">OK</span>  ] Finished systemd-remount-fs.service - Remount Root and Kernel File Systems.`,
    `[  <span class="ok">OK</span>  ] Reached target local-fs.target - Local File Systems.`,
    s.netError ? `[<span class="bad">FAILED</span>] Failed to start netplan-generate - Generate network configuration from netplan YAML.` : `[  <span class="ok">OK</span>  ] Started ${c.os === 'ubuntu' ? 'systemd-networkd.service - Network Configuration' : 'networking.service - Raise network interfaces'}.`,
    ...(s.waitOnline ? ['         Starting systemd-networkd-wait-online.service - Wait for Network to be Configured...', '[<span class="bad"> ***  </span>] A start job is running for Wait for…k to be Configured (12s / no limit)', '[  <span class="ok">OK</span>  ] Finished systemd-networkd-wait-online.service - Wait for Network to be Configured.'] : []),
    `[  <span class="ok">OK</span>  ] Reached target network-online.target - Network is Online.`,
    ...(vm.rt.services.ssh ? [`[  <span class="ok">OK</span>  ] Started ssh.service - OpenBSD Secure Shell server.`] : []),
    ...(vm.rt.services.apache2 ? [`[  <span class="ok">OK</span>  ] Started apache2.service - The Apache HTTP Server.`] : []),
    `[  <span class="ok">OK</span>  ] Reached target multi-user.target - Multi-User System.`,
  ];
  scr.innerHTML = '<div class="textscr"></div>';
  const box = scr.querySelector('.textscr');
  let i = 0;
  const step = () => {
    if (vm.rt?.screen?.phase !== 'linux-boot' || !box.isConnected) return;
    if (i >= lines.length) return;
    box.innerHTML += `${lines[i++]}\n`;
    box.scrollTop = box.scrollHeight;
    setTimeout(step, (s.waitOnline && i > lines.length - 5 ? 600 : 110));
  };
  step();
}

// ------------------------------------------------------------------ consola Linux
function renderConsole(vm, scr, c) {
  const v = views.get(vm.id);
  const flavor = c.os === 'kali' ? 'kali' : 'linux';
  scr.innerHTML = '<div class="termhost" style="flex:1;display:flex;min-height:0"></div>';
  const host = scr.querySelector('.termhost');
  const term = new Terminal(host, {
    flavor,
    history: vm.rt.history || (vm.rt.history = []),
    onCommand: (line) => onLinuxCommand(vm, line),
    complete: (before) => { const s = v.stack[v.stack.length - 1]; return s ? completeLinux(s, before) : []; },
    afterCommand: () => afterLinux(vm),
  });
  v.term = term;
  const orig = term.print.bind(term);
  term.print = (t, cls) => { orig(t, cls); trackPreview(vm, term); };
  if (vm.rt.session && c.users.some((u) => u.name === vm.rt.session.user)) {
    v.stack = [mkSess(vm, vm.rt.session.user, vm.rt.session.cwd)];
    term.println(`${OS_TYPES[c.os].pretty} ${c.hostname} tty1\n`);
    setPrompt(vm);
  } else loginLoop(vm, term, c);
  setTimeout(() => term.focus(), 50);
}

function mkSess(vm, user, cwd) {
  const s = { kind: 'vm', vmId: vm.id, user, cwd: cwd || homeOf(user) };
  s.pushSession = (n) => pushSession(vm, n);
  vm.rt.openSessions = [...(vm.rt.openSessions || []).filter((x) => x.vmId !== vm.id || x === s), s];
  return s;
}
function pushSession(vm, n) {
  const v = views.get(vm.id);
  const s = { ...n };
  s.pushSession = (m) => pushSession(vm, m);
  v.stack.push(s);
  const tvm = getVm(n.vmId);
  if (tvm?.rt) tvm.rt.openSessions = [...(tvm.rt.openSessions || []), s];
}

async function loginLoop(vm, term, c) {
  term.println(`\n${OS_TYPES[c.os].pretty} ${c.hostname} tty1\n`);
  for (;;) {
    if (!term.el.isConnected || vm.rt?.screen?.phase !== 'console') return;
    const user = await term.read(`${c.hostname} login: `);
    if (user === null) continue;
    if (!user.trim()) continue;
    const pass = await term.read('Password: ', { hidden: true });
    if (pass === null) continue;
    const u = c.users.find((x) => x.name === user.trim());
    if (u && !u.root && u.pass === pass) {
      term.println(motd(c));
      if (c.os === 'ubuntu') term.println(`  System information as of ${new Date().toUTCString()}\n\n  System load:  0.08              Processes:             112\n  Usage of /:   ${(Math.random() * 10 + 20).toFixed(1)}% of 11.21GB   Users logged in:       0\n  Memory usage: 11%               IPv4 address for ${vm.rt.ifaces[0]?.name || 'enp0s3'}: ${vm.rt.ifaces[0]?.addrs[0]?.ip || '-'}\n  Swap usage:   0%\n`);
      term.println(`Last login: ${new Date(Date.now() - 86400000).toUTCString()} on tty1`);
      vm.rt.session = { user: u.name, cwd: homeOf(u.name) };
      const v = views.get(vm.id);
      v.stack = [mkSess(vm, u.name)];
      logEvent({ type: 'login', vm: vm.id, user: u.name });
      setPrompt(vm);
      commit({ vm: vm.id });
      return;
    }
    await term.sleep(1200);
    term.println('\nLogin incorrect');
    emit('didactic', { title: 'Inicio de sesión incorrecto', status: 'error', explain: ['Usuario o contraseña incorrectos. Las credenciales de las máquinas de ejemplo están en su Descripción (panel de Detalles del Administrador).', 'Linux distingue mayúsculas y minúsculas, y la contraseña no se muestra mientras se escribe.'] });
  }
}

function setPrompt(vm) {
  const v = views.get(vm.id);
  if (!v?.term) return;
  const s = v.stack[v.stack.length - 1];
  if (!s) return;
  v.term.setPrompt(linuxPrompt(s));
}

async function onLinuxCommand(vm, line) {
  const v = views.get(vm.id);
  let s = v.stack[v.stack.length - 1];
  if (!s) return;
  const remote = s.vmId !== vm.id ? getVm(s.vmId) : null;
  if (remote && remote.state !== 'running') { v.term.println(`Connection to ${s.from} closed by remote host.\nConnection to ${s.from} closed.`); v.stack.pop(); return; }
  if (line.trim()) logEvent({ type: 'cmd', from: s.vmId, line });
  await runLinux(v.term, s, line);
  if (vm.rt) vm.rt.session = v.stack[0] ? { user: v.stack[0].user, cwd: v.stack[0].cwd } : null;
}
function afterLinux(vm) {
  const v = views.get(vm.id);
  if (!v || !vm.rt) return;
  let s = v.stack[v.stack.length - 1];
  if (s?.exitRequested) {
    s.exitRequested = false;
    if (s.userStack?.length) { const p = s.userStack.pop(); s.user = p.user; s.cwd = p.cwd; v.term.println('logout'); }
    else if (v.stack.length > 1) { v.stack.pop(); v.term.println(`logout\nConnection to ${s.from} closed.`); }
    else { v.stack = []; vm.rt.session = null; v.term.clear(); commit({ vm: vm.id }); loginLoop(vm, v.term, vmContent(state, vm)); return; }
  }
  if (s?.staleGroups === true && s.refreshGroups) s.staleGroups = false;
  setPrompt(vm);
}

function trackPreview(vm, term) {
  clearTimeout(trackPreview.t);
  trackPreview.t = setTimeout(() => {
    const txt = term.out.textContent.split('\n').slice(-16).join('\n');
    previewText.set(vm.id, txt);
  }, 200);
}

// ------------------------------------------------------------------ Windows
function renderWinLogin(vm, scr, c) {
  const u = c.users[0];
  scr.innerHTML = `<div class="win-lock"><div class="who"><div class="avatar">👤</div><div style="font-size:22px">${esc(u.name)}</div><input type="password" id="wl-pass" placeholder="Contraseña" aria-label="Contraseña"><div class="err" id="wl-err"></div><button class="btn" id="wl-go">Iniciar sesión</button><div style="font-size:11px;opacity:.8">Ctrl+Alt+Supr se envía con Entrada › Teclado</div></div></div>`;
  const inp = scr.querySelector('#wl-pass');
  setTimeout(() => inp.focus(), 50);
  const go = () => {
    if (inp.value === u.pass) {
      vm.rt.winUser = u.name;
      vm.rt.gaActive = !!c.ga;
      logEvent({ type: 'login', vm: vm.id, user: u.name });
      setScreen(vm, { phase: 'win-desktop', firstLogin: !vm.rt.desktopSeen });
    } else {
      scr.querySelector('#wl-err').textContent = 'La contraseña no es correcta. Inténtalo de nuevo.';
      inp.value = '';
      emit('didactic', { title: 'Contraseña incorrecta', status: 'error', explain: ['Las credenciales de las máquinas de ejemplo están en su Descripción (Detalles del Administrador).'] });
    }
  };
  scr.querySelector('#wl-go').onclick = go;
  inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
}

function renderWinDesktop(vm, scr, c) {
  const v = views.get(vm.id);
  scr.innerHTML = `<div class="win-desk"><div class="wd-area"><div class="wd-icons"><button class="wd-icon" data-open="cmd">${icon('terminal', 36)}Símbolo del sistema</button><button class="wd-icon" data-open="admin">${icon('terminal', 36)}Símbolo del sistema (administrador)</button><button class="wd-icon" data-open="ps">${icon('terminal', 36)}Windows PowerShell</button><button class="wd-icon" data-open="info">${icon('host', 36)}Este equipo</button></div></div><div class="wd-bar">${winLogo(16)}<span>Buscar</span><span class="sp"></span><span>${esc(c.hostname)}</span><span>${new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</span></div></div>`;
  scr.querySelectorAll('[data-open]').forEach((b) => {
    b.ondblclick = () => openWinApp(vm, b.dataset.open);
    b.onkeydown = (e) => { if (e.key === 'Enter') openWinApp(vm, b.dataset.open); };
  });
  if (!vm.rt.desktopSeen) { vm.rt.desktopSeen = true; openWinApp(vm, 'cmd'); }
  else if (vm.rt.cmdOpen) openWinApp(vm, vm.rt.cmdOpen);
}

async function openWinApp(vm, kind) {
  const v = views.get(vm.id);
  const scr = v.win.body.querySelector('.wd-area');
  const c = vmContent(state, vm);
  if (kind === 'info') { msgBox({ kind: 'info', title: 'Acerca de Windows', text: `<p><b>${esc(OS_TYPES[c.os].label)}</b><br>Versión ${esc(OS_TYPES[c.os].build)}<br>Nombre del equipo: ${esc(c.hostname)}<br>Memoria: ${vm.hw.ramMB} MB · Procesadores: ${vm.hw.cpus}</p><p>Guest Additions: ${c.ga ? 'instaladas' : 'no instaladas'}</p>` }); return; }
  if (kind === 'admin') {
    const ok = await uac(scr);
    if (!ok) return;
  }
  scr.querySelector('.cmdwin')?.remove();
  vm.rt.cmdOpen = kind;
  const elevated = kind === 'admin';
  const ps = kind === 'ps';
  const w = document.createElement('div');
  w.className = 'cmdwin';
  w.innerHTML = `<div class="cmdwin-t">${icon('terminal', 14)}<span>${elevated ? 'Administrador: ' : ''}${ps ? 'Windows PowerShell' : 'Símbolo del sistema'}</span><span class="sp"></span><button class="cw-close" title="Cerrar">✕</button></div><div class="termhost" style="flex:1;display:flex;min-height:0"></div>`;
  scr.appendChild(w);
  w.querySelector('.cw-close').onclick = () => { w.remove(); vm.rt.cmdOpen = null; v.term = null; };
  const sess = { kind: 'vm', vmId: vm.id, user: c.users[0].name, cwd: elevated ? 'C:\\Windows\\system32' : `C:\\Users\\${c.users[0].name}`, elevated, ps };
  v.stack = [sess];
  sess.pushSession = (n) => pushSession(vm, n);
  const term = new Terminal(w.querySelector('.termhost'), {
    flavor: ps ? 'ps' : 'cmd',
    history: vm.rt.history || (vm.rt.history = []),
    onCommand: async (line) => { const s = v.stack[v.stack.length - 1]; if (line.trim()) logEvent({ type: 'cmd', from: s.vmId, line }); if (s.kind === 'vm' && s.vmId !== vm.id) { const remote = getVm(s.vmId); if (remote?.state !== 'running') { term.println(`Connection to ${s.from} closed by remote host.`); v.stack.pop(); return; } await runLinux(term, s, line); } else await runWindows(term, s, line); },
    complete: (before) => { const s = v.stack[v.stack.length - 1]; return s.vmId !== vm.id ? completeLinux(s, before) : completeWindows(s, before); },
    afterCommand: () => {
      const s = v.stack[v.stack.length - 1];
      if (s.exitRequested) {
        s.exitRequested = false;
        if (v.stack.length > 1) { v.stack.pop(); term.println(`logout\nConnection to ${s.from} closed.`); }
        else { w.remove(); vm.rt.cmdOpen = null; v.term = null; return; }
      }
      const top = v.stack[v.stack.length - 1];
      term.setPrompt(top.vmId !== vm.id ? linuxPrompt(top) : winPrompt(top));
      term.el.classList.toggle('term-ps', !!top.ps);
    },
  });
  v.term = term;
  const orig = term.print.bind(term);
  term.print = (t, cls) => { orig(t, cls); trackPreview(vm, term); };
  if (ps) term.println('Windows PowerShell\nCopyright (C) Microsoft Corporation. Todos los derechos reservados.\n\nInstale la versión más reciente de PowerShell para obtener nuevas características y mejoras. https://aka.ms/PSWindows\n');
  else term.println(`Microsoft Windows [Versión ${OS_TYPES[c.os].build}]\n(c) Microsoft Corporation. Todos los derechos reservados.\n`);
  term.setPrompt(winPrompt(sess));
  setTimeout(() => term.focus(), 40);
}

function uac(scr) {
  return new Promise((resolve) => {
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,.55);display:grid;place-items:center;z-index:5';
    d.innerHTML = `<div style="width:min(420px,90%);background:#f3f3f3;color:#111;border:1px solid #0067c0;font:13px var(--font)"><div style="background:#0067c0;color:#fff;padding:10px 14px">Control de cuentas de usuario</div><div style="padding:14px"><p style="font-size:15px;margin:0 0 10px">¿Quieres permitir que esta aplicación haga cambios en el dispositivo?</p><p style="margin:0"><b>Procesador de comandos de Windows</b><br>Editor comprobado: Microsoft Windows</p></div><div style="display:flex;gap:8px;justify-content:flex-end;padding:10px 14px;background:#e6e6e6"><button class="btn primary" data-a="1">Sí</button><button class="btn" data-a="0">No</button></div></div>`;
    scr.appendChild(d);
    d.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => { d.remove(); resolve(b.dataset.a === '1'); }; });
    d.querySelector('[data-a="1"]').focus();
  });
}

// ------------------------------------------------------------------ previsualización (panel de detalles)
export function previewHtml(vm) {
  if (vm.state === 'poweroff' || vm.state === 'aborted' || !vm.rt) return `<div class="pv-off">${esc(vm.name)}</div>`;
  if (vm.state === 'saved') return `<div class="pv-off">${esc(vm.name)}<br><small>(estado guardado)</small></div>`;
  const ph = vm.rt.screen?.phase;
  if (ph === 'win-desktop' || ph === 'win-login') return '<div style="position:absolute;inset:0;background:linear-gradient(140deg,#0f3b7a,#1d6fd0 55%,#6ab3ff)"></div>';
  if (ph === 'bios') return '<div style="color:#fff;font:700 18px var(--font)">VirtualBox</div>';
  if (ph === 'installing' || ph === 'install-form') return '<div style="position:absolute;inset:18% 12%;background:#e0e0e0"></div>';
  const t = previewText.get(vm.id) || (ph === 'console' ? `${vmContent(state, vm)?.hostname || ''} login:` : ph === 'nobootable' ? 'FATAL: No bootable medium found!' : '');
  return `<pre style="position:absolute;left:4px;top:4px;right:4px;margin:0;font:6.5px/1.15 var(--mono);color:#ccc;white-space:pre-wrap;overflow:hidden">${esc(t)}</pre>${vm.state === 'paused' ? '<div class="vm-paused-ov" style="font-size:11px">Pausada</div>' : ''}`;
}

export function termOf(vmId) { return views.get(vmId)?.term; }
