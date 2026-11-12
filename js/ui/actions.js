// Acciones de la interfaz (diálogos de VirtualBox) compartidas por el Administrador y las ventanas de VM.
import { state, commit, getVm, getMedium, allSlots, mediumUsers, newMedium, resetAll, replaceState, logEvent, emit, STORAGE_KEY } from '../store.js';
import { OS_TYPES, ISOS, ISO_DIR, detectIsoOs } from '../catalog.js';
import { esc, fmtGB, clone } from '../util.js';
import { icon, osIcon } from './icons.js';
import { modal, msgBox, toast, getWindow, createWindow } from './wm.js';
import { startVm, powerOff, acpiShutdown, pauseVm, resumeVm, rebootVm, saveState, discardSaved, takeSnapshot, restoreSnapshot, removeVm, registerVm } from '../vmctl.js';
import { openVmWindow } from './vmwindow.js';
import { openSettingsDialog } from './settings.js';
import * as W from './wizards.js';
import { openHostTerminalWindow } from './hostterm.js';
import { openAssistantWindow } from './assistant.js';

export const newVmWizard = () => W.newVmWizard();
export const cloneWizard = (vm, snapId) => W.cloneWizard(vm, snapId);
export const exportWizard = () => W.exportWizard();
export const importWizard = () => W.importWizard();
export const openSettings = (vm, sec) => vm && openSettingsDialog(vm, sec);
export const openHostTerminal = () => openHostTerminalWindow();
export const openAssistant = () => openAssistantWindow();
export const newDiskDialog = (opts) => W.newDiskDialog(opts);
export const filePicker = (opts) => W.filePicker(opts);

export async function startWithUi(vm, mode = 'normal') {
  if (!vm) return;
  if (vm.state === 'running' || vm.state === 'paused') { showVm(vm); return; }
  const r = startVm(vm, mode === 'headless' ? 'headless' : 'normal');
  if (!r.ok) {
    await msgBox({ kind: 'error', title: 'VirtualBox - Error', text: `<p>${esc(r.error)}</p>`, detail: `${r.detail}\n\nCódigo de resultado: E_FAIL (0x80004005)\nComponente: ConsoleWrap\nInterfaz: IConsole {6ac83d89-6ee7-4e33-8ae6-b257b2e81be8}` });
    return;
  }
  if (mode !== 'headless') openVmWindow(vm);
  else toast(`«${esc(vm.name)}» se está ejecutando sin interfaz. Use «Mostrar» para abrir su ventana.`);
}

export function showVm(vm) {
  if (!vm) return;
  if (vm.rt) vm.rt.headless = false;
  openVmWindow(vm);
}

export function togglePause(vm) { if (vm.state === 'paused') resumeVm(vm); else pauseVm(vm); }
export function saveVm(vm) { saveState(vm); getWindow(`vm-${vm.id}`)?.close(true); }
export function acpi(vm) { if (!acpiShutdown(vm)) toast('El sistema invitado no responde a la señal de apagado ACPI (¿todavía arrancando o sin sistema operativo?).', { kind: 'warn' }); }

export async function poweroffDialog(vm) {
  const ok = await msgBox({ kind: 'question', title: 'VirtualBox - Pregunta', text: `<p>¿Realmente desea apagar la máquina virtual <b>${esc(vm.name)}</b>?</p><p>Esto provocará la pérdida de todos los datos no guardados de las aplicaciones que se estén ejecutando dentro de ella.</p>`, buttons: [{ label: 'Apagar', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }] });
  if (ok) { powerOff(vm); getWindow(`vm-${vm.id}`)?.close(true); }
}

export async function resetDialog(vm) {
  const ok = await msgBox({ kind: 'question', text: `<p>¿Realmente desea reiniciar la máquina virtual <b>${esc(vm.name)}</b>?</p><p>Esto provocará la pérdida de todos los datos no guardados de las aplicaciones que se estén ejecutando dentro de ella.</p>`, buttons: [{ label: 'Reiniciar', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }] });
  if (ok) rebootVm(vm);
}

export async function discardDialog(vm) {
  const ok = await msgBox({ kind: 'question', text: `<p>¿Está seguro de que desea descartar el estado guardado de la máquina virtual <b>${esc(vm.name)}</b>?</p><p>Esta operación equivale a reiniciar o apagar la máquina sin cerrar correctamente el sistema operativo invitado.</p>`, buttons: [{ label: 'Descartar', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }] });
  if (ok) discardSaved(vm);
}

// Diálogo «Cerrar máquina virtual» (al cerrar la ventana de una VM)
export async function closeVmDialog(vm) {
  picked = null;
  const snap = vm.snapshots.find((s) => s.id === vm.currentSnap);
  const last = state.prefs.lastClose || 'save';
  const r = await modal({
    title: 'Cerrar máquina virtual', iconName: 'stop', width: 470,
    html: `<div class="msg"><div class="msg-ico">${osIcon(vm.osKey, 40)}</div><div class="msg-text"><p>Quiere:</p><div class="radio-col"><label class="chk"><input type="radio" name="cl" value="save" ${last === 'save' ? 'checked' : ''}> Guardar el estado de la máquina</label><label class="chk"><input type="radio" name="cl" value="acpi" ${last === 'acpi' ? 'checked' : ''}> Enviar la señal de apagado</label><label class="chk"><input type="radio" name="cl" value="off" ${last === 'off' ? 'checked' : ''}> Apagar la máquina</label>${snap ? `<label class="chk" style="margin-left:22px"><input type="checkbox" id="cl-restore"> Restaurar la instantánea actual «${esc(snap.name)}»</label>` : ''}</div></div></div>`,
    buttons: [{ label: 'Ayuda', value: 'help', left: true }, { label: 'Aceptar', value: 'ok', primary: true, action: (api) => { picked = { choice: api.body.querySelector('input[name=cl]:checked')?.value || 'save', restore: !!api.body.querySelector('#cl-restore')?.checked }; } }, { label: 'Cancelar', value: null, cancel: true }],
  });
  if (r === 'help') { helpContents('close'); return null; }
  if (r !== 'ok' || !picked) return null;
  state.prefs.lastClose = picked.choice;
  return picked;
}
let picked = null;

export async function removeVmDialog(vm) {
  if (!vm) return;
  if (vm.state === 'running' || vm.state === 'paused') { await msgBox({ kind: 'error', title: 'VirtualBox - Error', text: `<p>No se puede eliminar «${esc(vm.name)}» mientras está en ejecución.</p>` }); return; }
  const disks = allSlots(vm).filter((x) => x.slot.kind === 'hdd' && x.slot.medium).map((x) => getMedium(x.slot.medium));
  const r = await msgBox({ kind: 'question', text: `<p>Está a punto de eliminar la máquina virtual <b>${esc(vm.name)}</b> de la lista de máquinas virtuales.</p><p>¿Quiere eliminar también todos los archivos que contienen la máquina virtual?</p>${disks.length ? `<p class="hint">Discos afectados: ${disks.map((d) => esc(d.name)).join(', ')}</p>` : ''}`, buttons: [{ label: 'Eliminar todos los archivos', value: 'all', primary: true }, { label: 'Quitar solo', value: 'unreg' }, { label: 'Cancelar', value: null, cancel: true }] });
  if (!r) return;
  removeVm(vm, r === 'all');
  toast(r === 'all' ? `Se ha eliminado «${esc(vm.name)}» y sus discos.` : `«${esc(vm.name)}» se ha quitado de la lista. Puede volver a añadirla con Máquina › Añadir.`);
}

export async function addVm() {
  const list = state.unregistered || [];
  const pick = await W.filePicker({ title: 'Seleccionar un archivo de máquina virtual', filter: 'vbox', items: list.map((v) => ({ name: `${v.name}.vbox`, folder: v.folder, data: v })) });
  if (!pick) return;
  const r = registerVm(pick.data);
  if (!r.ok) await msgBox({ kind: 'error', text: `<p>${esc(r.error)}</p>` });
}

export async function takeSnapshotDialog(vm) {
  if (!vm) return;
  const n = vm.snapshots.length + 1;
  const res = await modal({
    title: `Tomar instantánea de la máquina virtual`, iconName: 'snapTake', width: 440,
    html: `<div class="msg"><div class="msg-ico">${icon('snapshot', 40)}</div><div class="msg-text" style="display:grid;gap:8px"><label>Nombre de la instantánea</label><input type="text" id="sn-name" value="Instantánea ${n}" autofocus><label>Descripción de la instantánea</label><textarea id="sn-desc" rows="4"></textarea>${vm.state === 'running' ? '<p class="hint">La máquina está encendida: la instantánea incluirá también el estado de la memoria (instantánea en caliente).</p>' : ''}</div></div>`,
    buttons: [{ label: 'Aceptar', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }],
    onInit: (api) => { const i = api.body.querySelector('#sn-name'); setTimeout(() => i.select(), 40); api.onOk = () => {}; },
    validate: (api) => { const v = api.body.querySelector('#sn-name').value.trim(); if (!v) { api.body.querySelector('#sn-name').classList.add('invalid'); return false; } state._snapForm = { name: v, desc: api.body.querySelector('#sn-desc').value }; return true; },
  });
  if (!res) return;
  takeSnapshot(vm, state._snapForm.name, state._snapForm.desc);
  delete state._snapForm;
  toast(`Instantánea «${esc(vm.snapshots[vm.snapshots.length - 1].name)}» tomada.`, { kind: 'ok' });
}

export async function restoreSnapshotDialog(vm, s) {
  if (!s) return;
  if (vm.state === 'running' || vm.state === 'paused') { await msgBox({ kind: 'warn', title: 'VirtualBox - Aviso', text: '<p>No se puede restaurar una instantánea mientras la máquina está en ejecución. Apáguela o guarde su estado primero.</p>' }); return; }
  const r = await msgBox({ kind: 'question', text: `<p>¿Está seguro de que desea restaurar la instantánea <b>${esc(s.name)}</b>?</p><p>Se perderá el estado actual de la máquina virtual si no se guarda en una nueva instantánea.</p><label class="chk"><input type="checkbox" id="rs-take" checked> Crear una instantánea del estado actual</label>`, buttons: [{ label: 'Restaurar', value: true, primary: true, action: (api) => { state._rsTake = api.body.querySelector('#rs-take').checked; } }, { label: 'Cancelar', value: false, cancel: true }] });
  if (!r) return;
  if (state._rsTake) takeSnapshot(vm, `Instantánea ${vm.snapshots.length + 1}`, 'Estado anterior a la restauración');
  delete state._rsTake;
  const res = restoreSnapshot(vm, s.id);
  if (!res.ok) await msgBox({ kind: 'error', text: `<p>${esc(res.error)}</p>` });
  else toast(`Instantánea «${esc(s.name)}» restaurada.`, { kind: 'ok' });
}

// ------------------------------------------------------------------ medios
export async function mediaAdd(kind) {
  if (kind === 'dvd') {
    const pick = await W.filePicker({ title: 'Seleccione un archivo de disco óptico virtual', filter: 'iso' });
    if (!pick) return null;
    return registerIso(pick.name);
  }
  if (kind === 'hdd') {
    const orphan = state.media.hdd;
    await msgBox({ kind: 'info', title: 'VirtualBox', text: `<p>Todos los discos de la carpeta de máquinas ya están registrados (${orphan.length}). Para crear uno nuevo use <b>Crear</b>.</p>` });
    return null;
  }
  toast('No hay imágenes de disquete en el equipo.');
  return null;
}
export function registerIso(file) {
  let m = state.media.dvd.find((d) => d.name === file);
  if (!m) {
    const meta = ISOS.find((i) => i.file === file);
    m = newMedium('dvd', { name: file, path: `${ISO_DIR}\\${file}`, sizeMB: meta?.sizeMB || 1024, isoOs: detectIsoOs(file) });
    state.media.dvd.push(m);
    commit();
  }
  return m;
}
export async function copyDisk(m) {
  if (!m) return;
  const name = `${m.name.replace(/\.vdi$|\.vmdk$/i, '')}_copia.vdi`;
  const ok = await msgBox({ kind: 'question', title: 'Copiar disco duro virtual', text: `<p>Se creará <b>${esc(name)}</b>, una copia completa de <b>${esc(m.name)}</b> (${fmtGB(m.sizeGB)}) con un UUID nuevo.</p>`, buttons: [{ label: 'Copiar', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }] });
  if (!ok) return;
  state.media.hdd.push(newMedium('hdd', { ...clone(m), id: undefined, uuid: undefined, name, path: m.path.replace(/[^\\]+$/, name), parent: null, variant: m.variant === 'diff' ? 'dynamic' : m.variant }));
  state.media.hdd[state.media.hdd.length - 1].id = `m${Math.random().toString(36).slice(2, 9)}`;
  commit();
}
export async function moveMedium(m) {
  if (!m) return;
  const dest = await W.filePicker({ title: 'Seleccione la carpeta de destino', filter: 'folder' });
  if (!dest) return;
  m.path = `${dest.folder}\\${m.name}`;
  commit();
  toast(`Medio movido a ${esc(dest.folder)}.`);
}
export async function removeMedium(m) {
  if (!m) return false;
  const users = mediumUsers(m.id);
  if (users.length) { await msgBox({ kind: 'error', title: 'VirtualBox - Error', text: `<p>El medio <b>${esc(m.name)}</b> no se puede eliminar porque está conectado a: ${users.map((u) => esc(u.name)).join(', ')}.</p><p>Libérelo primero.</p>` }); return false; }
  if (m.kind === 'hdd') {
    const r = await msgBox({ kind: 'question', text: `<p>¿Desea borrar el archivo del disco duro virtual <b>${esc(m.path)}</b>?</p><p>Si selecciona <b>Borrar</b>, el archivo se eliminará de forma permanente. Si selecciona <b>Conservar</b>, solo se quitará del registro de medios.</p>`, buttons: [{ label: 'Borrar', value: 'del', primary: true }, { label: 'Conservar', value: 'keep' }, { label: 'Cancelar', value: null, cancel: true }] });
    if (!r) return false;
  } else {
    const r = await msgBox({ kind: 'question', text: `<p>¿Desea quitar <b>${esc(m.name)}</b> de la lista de medios conocidos?</p>`, buttons: [{ label: 'Quitar', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }] });
    if (!r) return false;
  }
  state.media[m.kind] = state.media[m.kind].filter((x) => x !== m);
  commit();
  return true;
}
export async function releaseMedium(m) {
  const users = mediumUsers(m.id);
  if (users.some((u) => u.state === 'running' || u.state === 'paused')) { await msgBox({ kind: 'error', text: '<p>No se puede liberar un medio usado por una máquina en ejecución.</p>' }); return; }
  const ok = await msgBox({ kind: 'question', text: `<p>¿Desea liberar <b>${esc(m.name)}</b>? Se desconectará de: ${users.map((u) => esc(u.name)).join(', ')}.</p>`, buttons: [{ label: 'Liberar', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }] });
  if (!ok) return;
  for (const u of users) for (const c of u.storage) for (const s of c.slots) if (s.medium === m.id) s.medium = null;
  for (const u of users) for (const c of u.storage) c.slots = c.slots.filter((s) => s.kind === 'dvd' || s.medium);
  commit();
}

// ------------------------------------------------------------------ preferencias y ayuda
export async function preferences() {
  const p = state.prefs;
  const r = await modal({
    title: 'VirtualBox - Preferencias', iconName: 'prefs', width: 600,
    html: `<div class="form-grid">
      <label>Carpeta predeterminada de máquinas:</label><input type="text" id="pf-folder" value="${esc(p.machineFolder)}">
      <label>Tecla anfitrión:</label><input type="text" value="${esc(p.hostKey)}" disabled>
      <label>Tema de color:</label><select id="pf-theme"><option value="auto" ${p.theme === 'auto' ? 'selected' : ''}>Automático (como el sistema)</option><option value="light" ${p.theme === 'light' ? 'selected' : ''}>Claro</option><option value="dark" ${p.theme === 'dark' ? 'selected' : ''}>Oscuro</option></select>
      <label class="full" style="text-align:left;font-weight:600;margin-top:8px">VirtLab</label>
      <label>Asistente didáctico:</label><label class="chk"><input type="checkbox" id="pf-did" ${p.didactic ? 'checked' : ''}> Explicar qué ocurre con cada orden de red</label>
      <label>Velocidad de arranque:</label><select id="pf-speed"><option value="fast" ${p.bootSpeed === 'fast' ? 'selected' : ''}>Rápida (para clase)</option><option value="realistic" ${p.bootSpeed === 'realistic' ? 'selected' : ''}>Realista</option></select>
      <label>VBoxManage en el PATH:</label><label class="chk"><input type="checkbox" id="pf-path" ${state.host.vboxInPath ? 'checked' : ''}> Añadido (en un Windows recién instalado no lo está)</label>
      <label>Ping al anfitrión:</label><label class="chk"><input type="checkbox" id="pf-icmp" ${state.host.icmpIn ? 'checked' : ''}> El firewall del anfitrión permite eco ICMP entrante</label>
    </div>`,
    buttons: [{ label: 'Aceptar', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }],
    validate: (api) => {
      const b = api.body;
      state._pf = { folder: b.querySelector('#pf-folder').value.trim() || p.machineFolder, theme: b.querySelector('#pf-theme').value, did: b.querySelector('#pf-did').checked, speed: b.querySelector('#pf-speed').value, path: b.querySelector('#pf-path').checked, icmp: b.querySelector('#pf-icmp').checked };
      return true;
    },
  });
  if (!r) return;
  const f = state._pf; delete state._pf;
  Object.assign(p, { machineFolder: f.folder, theme: f.theme, didactic: f.did, bootSpeed: f.speed });
  state.host.vboxInPath = f.path; state.host.icmpIn = f.icmp;
  applyTheme();
  commit();
}

export function applyTheme() {
  const t = state.prefs.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

export async function about() {
  await modal({
    title: 'Acerca de VirtLab', iconName: 'info', width: 520,
    html: `<div style="display:flex;gap:16px;align-items:flex-start">${icon('vbox', 64)}<div><h3 style="margin:0 0 4px">VirtLab 2.0</h3><p style="margin:0 0 10px;color:var(--text-2)">Simulador educativo del Administrador de VirtualBox 7.1 (interfaz en español).</p><p style="line-height:1.55">Las máquinas, discos e imágenes ISO son simulados. La red se calcula paquete a paquete: modos NAT, Red NAT, adaptador puente, red interna y solo anfitrión, con DHCP, DNS, enrutamiento, cortafuegos y reenvío de puertos.</p><p class="hint" style="line-height:1.5">VirtLab es un proyecto educativo independiente y no está afiliado, patrocinado ni respaldado por Oracle. Oracle y VirtualBox son marcas registradas de Oracle y/o sus filiales. Windows es marca de Microsoft; Ubuntu, de Canonical; Debian, de SPI; Kali Linux, de OffSec.</p><p class="hint">Licencia MIT.</p></div></div>`,
    buttons: [{ label: 'Aceptar', value: true, primary: true }],
  });
}

export async function helpContents(topic) {
  const sections = [
    ['Modos de red', `<table class="tbl"><thead><tr><th>Modo</th><th>VM→VM</th><th>VM→Anfitrión</th><th>Anfitrión→VM</th><th>VM→Internet</th><th>Direcciones</th></tr></thead><tbody>
      <tr><td><b>NAT</b></td><td>No (cada VM tiene su NAT)</td><td>Sí</td><td>Solo con reenvío de puertos</td><td>Sí</td><td>10.0.2.15, pasarela 10.0.2.2, DNS 10.0.2.3</td></tr>
      <tr><td><b>Red NAT</b></td><td>Sí (misma red)</td><td>Sí</td><td>Solo con reenvío de puertos</td><td>Sí</td><td>10.0.2.4…, pasarela 10.0.2.1, DHCP 10.0.2.3</td></tr>
      <tr><td><b>Adaptador puente</b></td><td>Sí</td><td>Sí</td><td>Sí</td><td>Sí</td><td>Las da el router de la LAN (192.168.1.x)</td></tr>
      <tr><td><b>Red interna</b></td><td>Sí (mismo nombre)</td><td>No</td><td>No</td><td>No</td><td>Sin DHCP: IP estática</td></tr>
      <tr><td><b>Solo anfitrión</b></td><td>Sí</td><td>Sí</td><td>Sí</td><td>No</td><td>192.168.56.101…, anfitrión 192.168.56.1</td></tr>
      <tr><td><b>No conectado</b></td><td colspan="5">La tarjeta existe pero el «cable» no va a ningún sitio.</td></tr></tbody></table>`],
    ['Cerrar una máquina', '<p><b>Guardar el estado</b> congela la máquina tal cual (como hibernar). <b>Enviar la señal de apagado</b> pide al sistema invitado que se apague ordenadamente (ACPI). <b>Apagar la máquina</b> equivale a quitar la corriente: se pierde lo no guardado y lo configurado solo en memoria (por ejemplo, <code>ip addr add</code>).</p>'],
    ['Instantáneas', '<p>Una instantánea guarda la configuración, el contenido de los discos y, si la máquina estaba encendida, la memoria. Restaurarla devuelve la máquina exactamente a ese punto. No son copias de seguridad: dependen del disco original.</p>'],
    ['Clonación', '<p>La <b>clonación completa</b> copia los discos. La <b>enlazada</b> crea un disco diferencial que depende del original (y exige una instantánea). Si se conservan las MAC, dos clones en la misma red tendrán la misma dirección MAC y recibirán la misma IP por DHCP: conflicto.</p>'],
    ['Consola', '<p>En Linux use <kbd>Ctrl</kbd>+<kbd>C</kbd> para detener un <code>ping</code> continuo, <kbd>Tab</kbd> para completar y las flechas para el historial. En Windows, <code>ping</code> envía 4 paquetes; con <code>-t</code> no para hasta <kbd>Ctrl</kbd>+<kbd>C</kbd>. Los cambios con <code>ip addr</code> se pierden al reiniciar: para hacerlos permanentes edite <code>/etc/netplan/*.yaml</code> (Ubuntu) o <code>/etc/network/interfaces</code> (Debian) con <code>sudo nano</code>.</p>'],
    ['VBoxManage', `<p>Abra la consola del anfitrión y entre en la carpeta de VirtualBox: <code>cd "C:\\Program Files\\Oracle\\VirtualBox"</code>. Ejemplos: <code>VBoxManage list vms</code>, <code>VBoxManage startvm "Ubuntu Server" --type headless</code>, <code>VBoxManage modifyvm "Ubuntu Server" --natpf1 "ssh,tcp,,2222,,22"</code>, <code>VBoxManage controlvm "Ubuntu Server" setlinkstate1 off</code>, <code>VBoxManage snapshot "Ubuntu Server" take Base</code>.</p>`],
  ];
  await modal({ title: 'VirtLab - Ayuda', iconName: 'question', width: 820, html: sections.map(([t, h]) => `<h3 style="font-size:14px;margin:10px 0 6px">${t}</h3>${h}`).join(''), buttons: [{ label: 'Cerrar', value: true, primary: true }] });
}

export function showInExplorer(vm) {
  const files = [`${vm.name}.vbox`, `${vm.name}.vbox-prev`, 'Logs\\VBox.log', ...allSlots(vm).filter((x) => x.slot.kind === 'hdd' && x.slot.medium).map((x) => getMedium(x.slot.medium)?.name).filter(Boolean), ...(vm.snapshots.length ? ['Snapshots\\'] : [])];
  modal({ title: `${vm.folder} - Explorador de archivos`, iconName: 'explorer', width: 560, html: `<div class="fexp-path">${esc(vm.folder)}</div><div class="tblwrap"><table class="tbl"><thead><tr><th>Nombre</th><th>Tipo</th></tr></thead><tbody>${files.map((f) => `<tr><td>${icon(f.endsWith('\\') ? 'folder' : f.endsWith('.vdi') || f.endsWith('.vmdk') ? 'hdd' : f.endsWith('.log') ? 'logs' : 'vbox', 16)} ${esc(f)}</td><td>${f.endsWith('.vbox') ? 'VirtualBox Machine Definition' : f.endsWith('.vdi') ? 'Virtual Disk Image' : f.endsWith('.log') ? 'Documento de texto' : 'Carpeta de archivos'}</td></tr>`).join('')}</tbody></table></div><p class="hint">El archivo <b>.vbox</b> (XML) guarda la configuración; los discos <b>.vdi</b> guardan el contenido. Para mover una máquina a otro equipo copie la carpeta completa y use Máquina › Añadir, o exporte un servicio virtualizado (.ova).</p>`, buttons: [{ label: 'Cerrar', value: true, primary: true }] });
}

export function downloadText(name, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export function exportLabFile() {
  const s = clone(state);
  downloadText(`virtlab-laboratorio-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(s), 'application/json');
  toast('Laboratorio exportado. Puede compartirlo con el alumnado o importarlo en otro equipo.', { kind: 'ok' });
}
export function importLabFile() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try {
      const s = JSON.parse(await f.text());
      if (s.version !== 2 || !Array.isArray(s.vms)) throw new Error('formato');
      const ok = await msgBox({ kind: 'question', text: `<p>Se sustituirá el laboratorio actual por <b>${esc(f.name)}</b> (${s.vms.length} máquinas).</p>`, buttons: [{ label: 'Importar', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }] });
      if (ok) { for (const w of document.querySelectorAll('.vmwin')) w.remove(); replaceState(s); location.reload(); }
    } catch { msgBox({ kind: 'error', text: '<p>El archivo no es un laboratorio de VirtLab válido.</p>' }); }
  };
  inp.click();
}
export async function factoryReset() {
  const ok = await msgBox({ kind: 'warn', title: 'VirtLab', text: '<p>Se borrarán todas las máquinas, discos, redes, instantáneas y el progreso de los laboratorios, y se cargarán las máquinas de ejemplo.</p>', buttons: [{ label: 'Restablecer', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }] });
  if (!ok) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
  resetAll();
  location.href = location.pathname;
}
export function quitManager() { getWindow('manager')?.minimize(); }

export { msgBox, toast };
