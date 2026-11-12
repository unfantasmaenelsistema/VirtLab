// Ventana principal: Oracle VirtualBox Administrador.
import { state, on, commit, getVm, getMedium, allSlots, mediumUsers, vmDisks } from '../store.js';
import { OS_TYPES, VM_STATES, attachLabel, nicShort, BOOT_DEVICES, ISOS } from '../catalog.js';
import { esc, fmtMB, fmtGB, nowStamp } from '../util.js';
import { icon, osIcon, stateIcon } from './icons.js';
import { menubar, popupMenu, msgBox, modal, toast, createWindow } from './wm.js';
import * as A from './actions.js';
import { validateVm, takeSnapshot, deleteSnapshot } from '../vmctl.js';
import { hostOnlyOf, natNetOf, vmContent, segLabel, linkOf } from '../net.js';
import { previewHtml } from './vmwindow.js';
import { renderLabsPane } from './assistant.js';

let root;
let selSnap = null;
let mediaTab = 'hdd';
let mediaSel = null;
let netTab = 'hostonly';
let netSel = null;
let logFilter = '';
let filter = '';

export function openManager() {
  return createWindow({
    id: 'manager', title: 'Oracle VirtualBox Administrador', icon: 'vbox', w: 1180, h: 760, maximized: window.innerWidth < 1400, minW: 520, minH: 360, closable: true,
    onClose: () => { toast('El Administrador sigue disponible en la barra de tareas.'); return true; },
    content: (body) => {
      root = body;
      body.innerHTML = '<div class="mgr"><nav class="mgr-menu"></nav><div class="mgr-main"><aside class="chooser"><div class="chooser-list" tabindex="0" role="listbox" aria-label="Máquinas virtuales"></div><div class="ch-filter"><input type="text" placeholder="Buscar máquinas…" aria-label="Buscar máquinas"></div></aside><section class="pane"><div class="toolbar"></div><div class="pane-body"></div></section></div></div>';
      body.querySelector('.ch-filter input').oninput = (e) => { filter = e.target.value.toLowerCase(); renderChooser(); };
      body.querySelector('.chooser-list').addEventListener('keydown', onChooserKey);
      renderAll();
    },
  });
}

export function renderAll() {
  if (!root?.isConnected) return;
  renderMenu();
  renderChooser();
  renderToolbar();
  renderPane();
}
on('change', () => renderAll());

const selVm = () => (state.selected && state.selected.startsWith?.('vm') ? getVm(state.selected) : null);
const isTools = () => !selVm();

// ------------------------------------------------------------------ menú
function renderMenu() {
  const vm = selVm();
  const run = vm && (vm.state === 'running' || vm.state === 'paused');
  menubar(root.querySelector('.mgr-menu'), [
    { label: 'Archivo', items: () => [
      { label: 'Preferencias…', icon: 'prefs', shortcut: 'Ctrl+G', action: () => A.preferences() },
      '-',
      { label: 'Importar servicio virtualizado…', icon: 'import', shortcut: 'Ctrl+I', action: () => A.importWizard() },
      { label: 'Exportar servicio virtualizado…', icon: 'export', shortcut: 'Ctrl+E', action: () => A.exportWizard() },
      '-',
      { label: 'Herramientas', icon: 'tools', submenu: [
        { label: 'Administrador de medios virtuales', icon: 'media', shortcut: 'Ctrl+D', action: () => selectTool('media') },
        { label: 'Administrador de red', icon: 'network', shortcut: 'Ctrl+H', action: () => selectTool('network') },
        { label: 'Administrador de actividad', icon: 'activity', action: () => selectTool('activity') },
        '-',
        { label: 'Laboratorios guiados (VirtLab)', icon: 'labs', action: () => selectTool('labs') },
      ] },
      '-',
      { label: 'Exportar laboratorio (.json)…', action: () => A.exportLabFile() },
      { label: 'Importar laboratorio (.json)…', action: () => A.importLabFile() },
      { label: 'Restablecer VirtLab a valores de fábrica…', action: () => A.factoryReset() },
      '-',
      { label: 'Salir', shortcut: 'Ctrl+Q', action: () => A.quitManager() },
    ] },
    { label: 'Máquina', items: () => [
      { label: 'Nueva…', icon: 'new', shortcut: 'Ctrl+N', action: () => A.newVmWizard() },
      { label: 'Añadir…', icon: 'add', shortcut: 'Ctrl+A', action: () => A.addVm() },
      '-',
      { label: 'Configuración…', icon: 'settings', shortcut: 'Ctrl+S', disabled: !vm, action: () => A.openSettings(vm) },
      { label: 'Clonar…', icon: 'clone', shortcut: 'Ctrl+O', disabled: !vm || run, action: () => A.cloneWizard(vm) },
      { label: 'Exportar a OCI…', disabled: true },
      { label: 'Eliminar…', icon: 'remove', shortcut: 'Ctrl+R', disabled: !vm || run, action: () => A.removeVmDialog(vm) },
      '-',
      { label: run ? 'Mostrar' : 'Iniciar', icon: run ? 'show' : 'start', disabled: !vm, submenu: run ? null : startSubmenu(vm), action: () => (run ? A.showVm(vm) : A.startWithUi(vm)) },
      { label: vm?.state === 'paused' ? 'Continuar' : 'Pausar', shortcut: 'Ctrl+P', disabled: !run, action: () => A.togglePause(vm) },
      { label: 'Reiniciar', shortcut: 'Ctrl+T', disabled: !run, action: () => A.resetDialog(vm) },
      { label: 'Cerrar', icon: 'stop', disabled: !run, submenu: [
        { label: 'Guardar el estado', shortcut: 'Ctrl+V', action: () => A.saveVm(vm) },
        { label: 'Apagado ACPI', shortcut: 'Ctrl+H', action: () => A.acpi(vm) },
        { label: 'Apagar', shortcut: 'Ctrl+F', action: () => A.poweroffDialog(vm) },
      ] },
      '-',
      { label: 'Descartar estado guardado…', icon: 'discard', shortcut: 'Ctrl+J', disabled: vm?.state !== 'saved', action: () => A.discardDialog(vm) },
      { label: 'Mostrar registro…', icon: 'logs', shortcut: 'Ctrl+L', disabled: !vm, action: () => setVmTool(vm, 'logs') },
      { label: 'Refrescar', icon: 'refresh', disabled: !vm, action: () => renderAll() },
      { label: 'Mostrar en el explorador', disabled: !vm, action: () => A.showInExplorer(vm) },
    ] },
    { label: 'Ayuda', items: () => [
      { label: 'Contenidos…', icon: 'question', shortcut: 'F1', action: () => A.helpContents() },
      { label: 'Laboratorios guiados', icon: 'labs', action: () => selectTool('labs') },
      { label: 'Asistente VirtLab', icon: 'assistant', action: () => A.openAssistant() },
      '-',
      { label: 'Acerca de VirtLab…', icon: 'info', action: () => A.about() },
    ] },
  ]);
}

function startSubmenu(vm) {
  if (!vm) return null;
  return [
    { label: 'Inicio normal', icon: 'start', action: () => A.startWithUi(vm, 'normal') },
    { label: 'Inicio sin interfaz', action: () => A.startWithUi(vm, 'headless') },
    { label: 'Inicio desacoplado', action: () => A.startWithUi(vm, 'detachable') },
  ];
}

// ------------------------------------------------------------------ lista de máquinas
function renderChooser() {
  const list = root.querySelector('.chooser-list');
  const toolNames = { welcome: 'Bienvenida', media: 'Medios', network: 'Red', activity: 'Actividad', labs: 'Laboratorios' };
  let h = `<div class="ch-item ch-tools-item ${isTools() ? 'sel' : ''}" data-id="tools" role="option" aria-selected="${isTools()}"><span class="ch-osico">${icon('tools', 32)}</span><div class="ch-text"><div class="ch-name">Herramientas</div><div class="ch-state">${esc(toolNames[state.view.tool] || '')}</div></div><button class="ch-tools" data-tools="tools" title="Elegir herramienta" aria-label="Elegir herramienta">${icon('menu', 18)}</button></div><div class="ch-sep"></div>`;
  for (const vm of state.vms) {
    if (filter && !vm.name.toLowerCase().includes(filter)) continue;
    const st = VM_STATES[vm.state] || VM_STATES.poweroff;
    const sel = state.selected === vm.id;
    const snapName = vm.snapshots.find((s) => s.id === vm.currentSnap)?.name;
    h += `<div class="ch-item ${sel ? 'sel' : ''}" data-id="${vm.id}" role="option" aria-selected="${sel}" title="${esc(vm.name)}"><span class="ch-osico">${osIcon(vm.osKey, 32)}</span><div class="ch-text"><div class="ch-name">${esc(vm.name)}${snapName ? ` <span style="font-weight:400;color:var(--text-2)">(${esc(snapName)})</span>` : ''}</div><div class="ch-state">${stateIcon(vm.state, 12)} ${esc(st.label)}${vm.state === 'running' && vm.rt?.headless ? ' (sin interfaz)' : ''}</div></div><button class="ch-tools" data-tools="${vm.id}" title="Herramientas de la máquina" aria-label="Herramientas de la máquina">${icon('menu', 18)}</button></div>`;
  }
  list.innerHTML = h;
  list.querySelectorAll('.ch-item').forEach((it) => {
    it.onclick = (e) => {
      if (e.target.closest('.ch-tools')) return;
      state.selected = it.dataset.id === 'tools' ? 'tools' : it.dataset.id;
      selSnap = null;
      commit();
    };
    it.ondblclick = (e) => { if (e.target.closest('.ch-tools')) return; const vm = getVm(it.dataset.id); if (vm) { if (vm.state === 'running' || vm.state === 'paused') A.showVm(vm); else A.startWithUi(vm); } };
    it.oncontextmenu = (e) => { e.preventDefault(); const vm = getVm(it.dataset.id); if (vm) { state.selected = vm.id; commit(); vmContextMenu(vm, e.clientX, e.clientY); } };
  });
  list.querySelectorAll('.ch-tools').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const r = b.getBoundingClientRect();
      if (b.dataset.tools === 'tools') {
        state.selected = 'tools'; commit();
        popupMenu(r.right, r.top, [
          { label: 'Bienvenida', icon: 'welcome', action: () => selectTool('welcome') },
          { label: 'Extensiones', icon: 'extension', disabled: true },
          { label: 'Medios', icon: 'media', action: () => selectTool('media') },
          { label: 'Red', icon: 'network', action: () => selectTool('network') },
          { label: 'Nube', icon: 'cloud', disabled: true },
          { label: 'Actividad', icon: 'activity', action: () => selectTool('activity') },
          '-',
          { label: 'Laboratorios (VirtLab)', icon: 'labs', action: () => selectTool('labs') },
        ]);
      } else {
        const vm = getVm(b.dataset.tools);
        state.selected = vm.id; commit();
        popupMenu(r.right, r.top, [
          { label: 'Detalles', icon: 'details', action: () => setVmTool(vm, 'details') },
          { label: 'Instantáneas', icon: 'snapshot', action: () => setVmTool(vm, 'snapshots') },
          { label: 'Registros', icon: 'logs', action: () => setVmTool(vm, 'logs') },
          { label: 'Actividad', icon: 'activity', action: () => setVmTool(vm, 'activity') },
        ]);
      }
    };
  });
}

function onChooserKey(e) {
  const ids = ['tools', ...state.vms.filter((v) => !filter || v.name.toLowerCase().includes(filter)).map((v) => v.id)];
  const i = ids.indexOf(state.selected === 'tools' || !selVm() ? 'tools' : state.selected);
  if (e.key === 'ArrowDown') { e.preventDefault(); state.selected = ids[Math.min(ids.length - 1, i + 1)]; commit(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); state.selected = ids[Math.max(0, i - 1)]; commit(); }
  if (e.key === 'Enter') { const vm = selVm(); if (vm) { if (vm.state === 'running') A.showVm(vm); else A.startWithUi(vm); } }
  if (e.key === 'Delete') { const vm = selVm(); if (vm) A.removeVmDialog(vm); }
}

function vmContextMenu(vm, x, y) {
  const run = vm.state === 'running' || vm.state === 'paused';
  popupMenu(x, y, [
    { label: 'Configuración…', icon: 'settings', action: () => A.openSettings(vm) },
    { label: 'Clonar…', icon: 'clone', disabled: run, action: () => A.cloneWizard(vm) },
    { label: 'Mover…', disabled: true },
    { label: 'Exportar a OCI…', disabled: true },
    { label: 'Eliminar…', icon: 'remove', disabled: run, action: () => A.removeVmDialog(vm) },
    '-',
    { label: run ? 'Mostrar' : 'Iniciar', icon: run ? 'show' : 'start', submenu: run ? null : startSubmenu(vm), action: () => (run ? A.showVm(vm) : A.startWithUi(vm)) },
    { label: vm.state === 'paused' ? 'Continuar' : 'Pausar', disabled: !run, action: () => A.togglePause(vm) },
    { label: 'Reiniciar', disabled: !run, action: () => A.resetDialog(vm) },
    { label: 'Cerrar', icon: 'stop', disabled: !run, submenu: [
      { label: 'Guardar el estado', action: () => A.saveVm(vm) },
      { label: 'Apagado ACPI', action: () => A.acpi(vm) },
      { label: 'Apagar', action: () => A.poweroffDialog(vm) },
    ] },
    '-',
    { label: 'Descartar estado guardado…', icon: 'discard', disabled: vm.state !== 'saved', action: () => A.discardDialog(vm) },
    { label: 'Mostrar registro…', icon: 'logs', action: () => setVmTool(vm, 'logs') },
    { label: 'Mostrar en el explorador', action: () => A.showInExplorer(vm) },
  ]);
}

export function selectTool(t) { state.selected = 'tools'; state.view.tool = t; commit(); }
export function setVmTool(vm, t) { state.selected = vm.id; state.view.vmTool[vm.id] = t; commit(); }

// ------------------------------------------------------------------ barra de herramientas
function tbtn(id, ic, label, { disabled = false, split = false } = {}) {
  if (split) return `<div class="tbtn split" ${disabled ? 'aria-disabled="true"' : ''}><button class="tb-main" data-act="${id}" ${disabled ? 'disabled' : ''} title="${esc(label)}">${icon(ic, 32)}<span class="lbl">${esc(label)}</span></button><button class="tb-arrow" data-act="${id}-menu" ${disabled ? 'disabled' : ''} aria-label="Más opciones de ${esc(label)}">${icon('caret', 12)}</button></div>`;
  return `<button class="tbtn" data-act="${id}" ${disabled ? 'disabled' : ''} title="${esc(label)}">${icon(ic, 32)}<span class="lbl">${esc(label)}</span></button>`;
}

function renderToolbar() {
  const tb = root.querySelector('.toolbar');
  const vm = selVm();
  if (!vm) {
    const t = state.view.tool;
    if (t === 'media') {
      tb.className = 'toolbar';
      tb.innerHTML = `${tbtn('m-add', 'add', 'Añadir')}${tbtn('m-create', 'create', 'Crear', { disabled: mediaTab !== 'hdd' })}${tbtn('m-copy', 'copy', 'Copiar', { disabled: !mediaSel || mediaTab !== 'hdd' })}${tbtn('m-move', 'move', 'Mover', { disabled: !mediaSel })}${tbtn('m-remove', 'remove', 'Eliminar', { disabled: !mediaSel })}${tbtn('m-release', 'release', 'Liberar', { disabled: !mediaSel || !mediumUsers(mediaSel).length })}${tbtn('m-search', 'search', 'Buscar')}${tbtn('m-props', 'props', 'Propiedades', { disabled: !mediaSel })}${tbtn('m-refresh', 'refresh', 'Refrescar')}`;
    } else if (t === 'network') {
      tb.className = 'toolbar';
      tb.innerHTML = `${tbtn('n-create', 'create', 'Crear', { disabled: netTab === 'cloud' })}${tbtn('n-remove', 'remove', 'Eliminar', { disabled: !netSel })}${tbtn('n-props', 'props', 'Propiedades', { disabled: !netSel })}`;
    } else {
      tb.className = 'toolbar';
      tb.innerHTML = `${tbtn('prefs', 'prefs', 'Preferencias')}${tbtn('import', 'import', 'Importar')}${tbtn('export', 'export', 'Exportar')}<div class="tb-sep"></div>${tbtn('new', 'new', 'Nueva')}${tbtn('add', 'add', 'Añadir')}`;
    }
  } else {
    const tool = state.view.vmTool[vm.id] || 'details';
    const run = vm.state === 'running' || vm.state === 'paused';
    if (tool === 'snapshots') {
      const s = vm.snapshots.find((x) => x.id === selSnap);
      tb.className = 'toolbar';
      tb.innerHTML = `${tbtn('s-take', 'snapTake', 'Tomar', { disabled: !!selSnap && selSnap !== 'current' })}${tbtn('s-delete', 'snapDelete', 'Eliminar', { disabled: !s })}${tbtn('s-restore', 'snapRestore', 'Restaurar', { disabled: !s })}${tbtn('s-props', 'props', 'Propiedades', { disabled: !s })}${tbtn('s-clone', 'clone', 'Clonar', { disabled: run })}<div class="tb-sep"></div>${tbtn('settings', 'settings', 'Configuración')}${run ? tbtn('show', 'show', 'Mostrar') : tbtn('start', 'start', 'Iniciar', { split: true })}`;
    } else {
      tb.className = 'toolbar';
      tb.innerHTML = `${tbtn('new', 'new', 'Nueva')}${tbtn('add', 'add', 'Añadir')}${tbtn('settings', 'settings', 'Configuración')}${tbtn('discard', 'discard', 'Descartar', { disabled: vm.state !== 'saved' })}${run ? tbtn('show', 'show', 'Mostrar') : tbtn('start', 'start', 'Iniciar', { split: true })}`;
    }
  }
  tb.querySelectorAll('[data-act]').forEach((b) => { b.onclick = (e) => toolbarAction(b.dataset.act, e); });
}

function toolbarAction(act, e) {
  const vm = selVm();
  switch (act) {
    case 'new': return A.newVmWizard();
    case 'add': return A.addVm();
    case 'prefs': return A.preferences();
    case 'import': return A.importWizard();
    case 'export': return A.exportWizard();
    case 'settings': return A.openSettings(vm);
    case 'discard': return A.discardDialog(vm);
    case 'start': return A.startWithUi(vm);
    case 'start-menu': { const r = e.currentTarget.getBoundingClientRect(); return popupMenu(r.left - 60, r.bottom, startSubmenu(vm)); }
    case 'show': return A.showVm(vm);
    case 's-take': return A.takeSnapshotDialog(vm);
    case 's-delete': return snapDelete(vm);
    case 's-restore': return A.restoreSnapshotDialog(vm, vm.snapshots.find((x) => x.id === selSnap));
    case 's-props': return snapProps(vm);
    case 's-clone': return A.cloneWizard(vm, selSnap && selSnap !== 'current' ? selSnap : null);
    case 'm-add': return A.mediaAdd(mediaTab);
    case 'm-create': return A.newDiskDialog().then((m) => { if (m) { mediaSel = m.id; renderAll(); } });
    case 'm-copy': return A.copyDisk(getMedium(mediaSel));
    case 'm-move': return A.moveMedium(getMedium(mediaSel));
    case 'm-remove': return A.removeMedium(getMedium(mediaSel)).then((ok) => { if (ok) { mediaSel = null; renderAll(); } });
    case 'm-release': return A.releaseMedium(getMedium(mediaSel));
    case 'm-search': { const q = prompt('Buscar medio por nombre:'); if (q) { const list = state.media[mediaTab]; const m = list.find((x) => x.name.toLowerCase().includes(q.toLowerCase())); if (m) { mediaSel = m.id; renderAll(); } else toast('No se ha encontrado ningún medio.'); } return; }
    case 'm-props': { const el = root.querySelector('.bottom'); if (el) el.style.display = el.style.display === 'none' ? '' : 'none'; return; }
    case 'm-refresh': return renderAll();
    case 'n-create': return netCreate();
    case 'n-remove': return netRemove();
    case 'n-props': { const el = root.querySelector('.bottom'); if (el) el.style.display = el.style.display === 'none' ? '' : 'none'; return; }
    default: return null;
  }
}

// ------------------------------------------------------------------ paneles
function renderPane() {
  const body = root.querySelector('.pane-body');
  const vm = selVm();
  const scroll = body.scrollTop;
  if (!vm) {
    const t = state.view.tool;
    if (t === 'media') body.innerHTML = mediaPane();
    else if (t === 'network') body.innerHTML = networkPane();
    else if (t === 'activity') body.innerHTML = activityPane(state.vms.filter((v) => v.state === 'running' || v.state === 'paused'));
    else if (t === 'labs') { renderLabsPane(body); return; }
    else body.innerHTML = welcomePane();
    bindPane(body, null);
    body.scrollTop = scroll;
    return;
  }
  const tool = state.view.vmTool[vm.id] || 'details';
  if (tool === 'snapshots') body.innerHTML = snapshotsPane(vm);
  else if (tool === 'logs') body.innerHTML = logsPane(vm);
  else if (tool === 'activity') body.innerHTML = activityPane([vm]);
  else body.innerHTML = detailsPane(vm);
  bindPane(body, vm);
  body.scrollTop = scroll;
}

function welcomePane() {
  return `<div class="welcome"><h1>¡Bienvenido a VirtualBox!</h1>
  <p>La parte izquierda de la ventana muestra las herramientas globales y la lista de todas las máquinas virtuales y grupos de máquinas virtuales del equipo. Puede importar, añadir y crear nuevas máquinas virtuales usando los botones correspondientes de la barra de herramientas. Puede abrir las herramientas de un elemento con el botón de menú <span style="vertical-align:middle">${icon('menu', 14)}</span> que aparece junto a él.</p>
  <p>Pulse <kbd>F1</kbd> para obtener ayuda o visite los <b>laboratorios guiados</b> de VirtLab para practicar redes virtuales, instalación de sistemas, instantáneas y clonación.</p>
  <div class="infobox" style="margin:14px 0">${icon('info', 18)}<div><b>VirtLab</b> reproduce el Administrador de VirtualBox 7.1 dentro del navegador. Las máquinas, discos e ISO son simulados, pero la red se calcula paquete a paquete: lo que funcione (o falle) aquí, funcionaría (o fallaría) igual en un VirtualBox real. Abre el <b>Asistente VirtLab</b> (botón verde de la barra de tareas) para ver por qué ocurre cada cosa.</div></div>
  <h3 style="font-size:14px;margin:18px 0 8px">Por dónde empezar</h3>
  <div class="cards">
    <button class="card" data-go="labs">${icon('labs', 22)}<h4>Laboratorios guiados</h4><p>15 prácticas con objetivos que se comprueban solos: NAT, puente, red interna, solo anfitrión, Red NAT, reenvío de puertos, instantáneas, clonación…</p></button>
    <button class="card" data-go="new">${icon('new', 22)}<h4>Crear una máquina virtual</h4><p>Asistente completo con instalación desatendida, ISO, memoria, CPU y disco VDI.</p></button>
    <button class="card" data-go="host">${icon('terminal', 22)}<h4>Consola del anfitrión</h4><p>Símbolo del sistema del PC del aula: ping, ssh, curl y VBoxManage.</p></button>
    <button class="card" data-go="network">${icon('network', 22)}<h4>Administrador de red</h4><p>Redes solo anfitrión, servidores DHCP y Redes NAT con reenvío de puertos.</p></button>
  </div></div>`;
}

function detailsPane(vm) {
  const os = OS_TYPES[vm.osKey] || OS_TYPES.other;
  const coll = state.view.collapsed || {};
  const sec = (id, ic, title, rows, settingsSec) => `<div class="dsec ${coll[id] ? 'collapsed' : ''}" data-sec="${id}"><div class="dsec-h">${icon(ic, 16)}<button class="link" data-settings="${settingsSec || id}">${esc(title)}</button><button class="tog" data-tog="${id}" aria-label="Plegar sección">${coll[id] ? '▸' : '▾'}</button></div><div class="dsec-b">${rows}</div></div>`;
  const row = (k, v, cls = '') => `<span class="k ${cls}">${k}</span><span class="v ${cls}">${v}</span>`;
  const bootOrder = vm.hw.boot.filter((b) => b.on).map((b) => BOOT_DEVICES[b.dev]).join(', ') || 'Ninguno';
  const accel = ['Paginación anidada', vm.hw.paravirt === 'Predeterminado' ? (os.family === 'windows' ? 'Paravirtualización Hyper-V' : 'Paravirtualización KVM') : `Paravirtualización ${vm.hw.paravirt}`].join(', ');
  let storage = '';
  for (const c of vm.storage) {
    storage += `<span class="k full">Controlador: ${esc(c.name)}</span>`;
    for (const s of c.slots) {
      const m = getMedium(s.medium);
      const label = s.kind === 'dvd' ? `[Unidad óptica] ${m ? `${esc(m.name)} (${fmtGB(m.sizeMB / 1024)})` : 'Vacío'}` : m ? `${esc(m.name)} (Normal, ${fmtGB(m.sizeGB)})` : 'Vacío';
      storage += `<span class="k sub">${esc(s.port)}:</span><span class="v">${label}</span>`;
    }
  }
  const nets = vm.nics.filter((n) => n.enabled).map((n) => {
    const extra = n.attach === 'natnet' ? `Red NAT, «${esc(n.natnet)}»` : n.attach === 'bridged' ? `Adaptador puente, ${esc(n.bridged)}` : n.attach === 'intnet' ? `Red interna, «${esc(n.intnet)}»` : n.attach === 'hostonly' ? `Adaptador solo anfitrión, «${esc(n.hostonly)}»` : attachLabel(n.attach);
    return row(`Adaptador ${n.slot + 1}:`, `${esc(nicShort(n.type))} (${extra})${n.cable ? '' : ' <span style="color:var(--err)">[cable desconectado]</span>'}`);
  }).join('') || row('', 'Inhabilitado', 'off');
  const issues = validateVm(vm);
  const content = vmContent(state, vm);
  const ipRows = vm.rt && vm.state !== 'saved' ? vm.rt.ifaces.map((i) => row(`${esc(i.name)}:`, i.addrs.length ? i.addrs.map((a) => `${a.ip}/${a.prefix}`).join(', ') : '<span class="off">sin IPv4</span>')).join('') : '';
  const left = [
    sec('general', 'general', 'General', row('Nombre:', esc(vm.name)) + row('Sistema operativo:', esc(os.version)) + (vm.folder ? row('Ubicación de la configuración:', esc(`${vm.folder}\\${vm.name}.vbox`)) : '')),
    sec('system', 'system', 'Sistema', row('Memoria base:', `${vm.hw.ramMB} MB`) + row('Procesadores:', `${vm.hw.cpus}`) + row('Orden de arranque:', esc(bootOrder)) + (vm.hw.efi ? row('EFI:', 'Habilitado') : '') + (vm.hw.tpm !== 'none' ? row('TPM:', `v${vm.hw.tpm}`) : '') + (vm.hw.secureBoot ? row('Arranque seguro:', 'Habilitado') : '') + row('Aceleración:', esc(accel))),
    sec('display', 'display', 'Pantalla', row('Memoria de vídeo:', `${vm.hw.vram} MB`) + row('Controlador gráfico:', vm.hw.graphics) + row('Servidor de escritorio remoto:', vm.hw.rdp ? 'Habilitado' : 'Inhabilitado') + row('Grabación:', vm.hw.recording ? 'Habilitado' : 'Inhabilitado')),
    sec('storage', 'storage', 'Almacenamiento', storage),
    sec('audio', 'audio', 'Audio', vm.hw.audio.enabled ? row('Controlador de anfitrión:', vm.hw.audio.driver) + row('Controlador:', vm.hw.audio.controller) : row('', 'Inhabilitado', 'off')),
    sec('network', 'net', 'Red', nets),
    sec('usb', 'usb', 'USB', vm.hw.usb.enabled ? row('Controlador USB:', vm.hw.usb.ver === '1.1' ? 'OHCI' : vm.hw.usb.ver === '2.0' ? 'OHCI, EHCI' : 'xHCI') + row('Filtros de dispositivos:', `${vm.hw.usb.filters.length} (${vm.hw.usb.filters.length} activo)`) : row('', 'Inhabilitado', 'off')),
    sec('shared', 'shared', 'Carpetas compartidas', vm.shared.length ? vm.shared.map((s) => row(`${esc(s.name)}:`, esc(s.hostPath))).join('') : row('', 'Ninguno', 'off')),
    sec('description', 'description', 'Descripción', vm.description ? `<span class="v full" style="white-space:pre-wrap">${esc(vm.description)}</span>` : row('', 'Ninguno', 'off'), 'general'),
  ].join('');
  const right = `<div class="dsec"><div class="dsec-h">${icon('preview', 16)}Previsualización</div><div class="preview-box">${previewHtml(vm)}</div></div>
  ${vm.rt && (vm.state === 'running' || vm.state === 'paused') ? `<div class="dsec"><div class="dsec-h">${icon('net', 16)}Direcciones del invitado</div><div class="dsec-b">${ipRows || row('', 'sin interfaces', 'off')}${content?.ga ? '' : '<span class="v full hint" style="white-space:normal">VirtualBox solo las muestra si el invitado tiene las Guest Additions; VirtLab las enseña siempre.</span>'}</div></div>` : ''}
  ${issues.length ? `<div class="dsec"><div class="dsec-h" style="color:var(--warn)">${icon('warn', 16)}Avisos de configuración</div><div class="dsec-b">${issues.map((i) => `<span class="v full ${i.level === 'error' ? 'err' : ''}">• ${esc(i.text)}</span>`).join('')}</div></div>` : ''}
  ${!content && vmDisks(vm).length ? `<div class="dsec"><div class="dsec-h">${icon('info', 16)}Disco vacío</div><div class="dsec-b"><span class="v full">El disco virtual aún no tiene sistema operativo. Monte una ISO en la unidad óptica (Configuración › Almacenamiento) e inicie la máquina para instalarlo.</span></div></div>` : ''}`;
  return `<div class="details"><div class="details-col">${left}</div><div class="details-col">${right}</div></div>`;
}

function snapshotsPane(vm) {
  const fmt = (t) => { const d = (Date.now() - t) / 1000; if (d < 60) return `(hace ${Math.max(1, Math.round(d))} segundos)`; if (d < 3600) return `(hace ${Math.round(d / 60)} minutos)`; return `(${new Date(t).toLocaleString('es-ES')})`; };
  const rows = [];
  const walk = (parent, depth) => {
    vm.snapshots.filter((s) => (s.parent || null) === parent).forEach((s) => {
      rows.push(`<div class="row ${selSnap === s.id ? 'sel' : ''}" data-snap="${s.id}" style="padding-left:${10 + depth * 20}px">${icon('snapshot', 16)}<span>${esc(s.name)}${vm.currentSnap === s.id ? ' <b>*</b>' : ''}</span>${s.online ? `<span class="pill">con estado</span>` : ''}<span class="when">${fmt(s.ts)}</span></div>`);
      walk(s.id, depth + 1);
      if (vm.currentSnap === s.id) rows.push(`<div class="row ${selSnap === 'current' ? 'sel' : ''}" data-snap="current" style="padding-left:${10 + (depth + 1) * 20}px">${stateIcon(vm.state, 14)}<span>Estado actual${vm.state === 'running' ? ' (en ejecución)' : ''}</span></div>`);
    });
  };
  walk(null, 0);
  if (!vm.currentSnap) rows.push(`<div class="row ${selSnap === 'current' || !selSnap ? 'sel' : ''}" data-snap="current" style="padding-left:10px">${stateIcon(vm.state, 14)}<span>Estado actual</span></div>`);
  const s = vm.snapshots.find((x) => x.id === selSnap);
  return `<div class="tool-split"><div class="top snap-tree"><table class="tbl"><thead><tr><th>Nombre</th></tr></thead></table>${rows.join('')}</div>
  <div class="bottom" style="padding:10px 12px">${s ? `<div class="form-grid"><label>Nombre:</label><input type="text" id="snap-name" value="${esc(s.name)}"><label>Descripción:</label><textarea id="snap-desc" rows="3">${esc(s.desc)}</textarea><label></label><div><button class="btn small" id="snap-save">Aplicar</button></div><label>Tomada:</label><span>${new Date(s.ts).toLocaleString('es-ES')}</span><label>Estado de la máquina:</label><span>${s.online ? 'Guardado (instantánea en caliente)' : 'Apagada'}</span><label>Memoria / CPU:</label><span>${s.config.hw.ramMB} MB · ${s.config.hw.cpus} CPU</span><label>Red:</label><span>${s.config.nics.filter((n) => n.enabled).map((n) => `${n.slot + 1}: ${attachLabel(n.attach)}`).join(' · ')}</span></div>` : `<p class="hint">Una instantánea guarda el estado completo de la máquina (configuración, contenido de los discos y, si estaba encendida, la memoria) para poder volver a él más tarde. Seleccione «Estado actual» y pulse <b>Tomar</b>.</p>`}</div></div>`;
}

function logsPane(vm) {
  const lines = vm.log.length ? vm.log : ['(No hay ningún registro todavía: la máquina no se ha iniciado en esta sesión.)'];
  const shown = logFilter ? lines.filter((l) => l.toLowerCase().includes(logFilter.toLowerCase())) : lines;
  const hi = (l) => (logFilter ? esc(l).replace(new RegExp(logFilter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), (m) => `<mark>${m}</mark>`) : esc(l));
  return `<div class="tool-split"><div class="toolbar small"><button class="tbtn" data-log="save">${icon('export', 16)}Guardar</button><button class="tbtn" data-log="refresh">${icon('refresh', 16)}Refrescar</button><div class="tb-grow"></div><input type="text" id="log-filter" placeholder="Filtrar…" value="${esc(logFilter)}" style="width:200px"></div><div class="tabs"><button class="tab on">VBox.log</button></div><div class="top"><div class="logview">${shown.map(hi).join('\n')}</div></div></div>`;
}

const actHist = new Map();
function activityPane(vms) {
  if (!vms.length) return '<div class="welcome"><p>No hay ninguna máquina virtual en ejecución. El administrador de actividad muestra el uso de CPU, memoria, red y disco de las máquinas encendidas.</p></div>';
  return `<div><table class="tbl"><thead><tr><th>Nombre de la MV</th><th>Uso de CPU %</th><th>RAM usada/total</th><th>Red recibida</th><th>Red enviada</th><th>Tiempo encendida</th></tr></thead><tbody>${vms.map((v) => { const s = sample(v); return `<tr><td>${osIcon(v.osKey, 16)} ${esc(v.name)}</td><td>${s.cpu.toFixed(0)}</td><td>${Math.round(v.hw.ramMB * s.mem)} MB / ${v.hw.ramMB} MB</td><td>${s.rx} KB</td><td>${s.tx} KB</td><td>${Math.round((Date.now() - (v.rt?.bootAt || Date.now())) / 1000)} s</td></tr>`; }).join('')}</tbody></table>
  <div class="act-grid">${vms.map((v) => `<div><h5>${esc(v.name)} — CPU</h5><canvas class="chart" data-chart="${v.id}" data-k="cpu"></canvas><h5 style="margin-top:6px">${esc(v.name)} — Red (KB/s)</h5><canvas class="chart" data-chart="${v.id}" data-k="net"></canvas></div>`).join('')}</div></div>`;
}
function sample(v) {
  const h = actHist.get(v.id) || { cpu: [], net: [], rx: 0, tx: 0 };
  const ph = v.rt?.screen?.phase;
  const busy = ['bios', 'linux-boot', 'win-boot', 'installing'].includes(ph);
  const recent = state.events.filter((e) => e.from === v.id && Date.now() - e.t < 4000).length;
  const cpu = v.state === 'paused' ? 0 : busy ? 55 + Math.random() * 40 : 1 + Math.random() * 4 + recent * 6;
  const net = v.state === 'paused' ? 0 : recent * (5 + Math.random() * 30) + Math.random() * 0.5;
  h.cpu.push(cpu); h.net.push(net); h.rx += Math.round(net * 0.6); h.tx += Math.round(net * 0.4);
  if (h.cpu.length > 60) { h.cpu.shift(); h.net.shift(); }
  actHist.set(v.id, h);
  return { cpu, mem: busy ? 0.4 : 0.25 + Math.min(0.5, recent * 0.02), rx: h.rx, tx: h.tx };
}
function drawCharts(body) {
  body.querySelectorAll('canvas[data-chart]').forEach((c) => {
    const h = actHist.get(c.dataset.chart); if (!h) return;
    const data = h[c.dataset.k];
    const dpr = window.devicePixelRatio || 1;
    c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    const W = c.clientWidth; const H = c.clientHeight;
    const max = c.dataset.k === 'cpu' ? 100 : Math.max(10, ...data);
    g.strokeStyle = 'rgba(127,127,127,.25)';
    for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(0, (H * i) / 4); g.lineTo(W, (H * i) / 4); g.stroke(); }
    g.beginPath();
    data.forEach((v, i) => { const x = (i / 59) * W; const y = H - (v / max) * (H - 4) - 2; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.strokeStyle = c.dataset.k === 'cpu' ? '#2a6fd6' : '#2e9a1f'; g.lineWidth = 1.6; g.stroke();
  });
}
setInterval(() => {
  if (!root?.isConnected) return;
  const vm = selVm();
  const onAct = (!vm && state.view.tool === 'activity') || (vm && state.view.vmTool[vm.id] === 'activity');
  if (onAct) renderPane();
  else for (const v of state.vms) if (v.state === 'running') sample(v);
  const pv = root.querySelector('.preview-box');
  if (pv && vm) pv.innerHTML = previewHtml(vm);
}, 1500);

// medios
function mediaPane() {
  const list = state.media[mediaTab];
  const users = (m) => mediumUsers(m.id).map((v) => v.name).join(', ');
  const rows = list.map((m) => {
    const virt = mediaTab === 'hdd' ? fmtGB(m.sizeGB) : fmtGB(m.sizeMB / 1024);
    const real = mediaTab === 'hdd' ? fmtGB(m.usedGB) : fmtGB(m.sizeMB / 1024);
    const indent = m.parent ? 'padding-left:26px' : '';
    return `<tr class="${mediaSel === m.id ? 'sel' : ''}" data-m="${m.id}"><td style="${indent}">${icon(mediaTab === 'hdd' ? 'hdd' : mediaTab === 'dvd' ? 'dvd' : 'floppy', 16)} ${esc(m.name)}</td><td>${virt}</td><td>${real}</td></tr>`;
  }).join('') || '<tr><td colspan="3" class="hint">No hay medios registrados.</td></tr>';
  const m = getMedium(mediaSel);
  let bottom = '';
  if (m) {
    const u = users(m);
    bottom = `<div class="tabs"><button class="tab on">Atributos</button></div><div class="tabpage"><div class="form-grid">
      <label>Tipo:</label><select id="m-type" ${mediaTab !== 'hdd' || u ? 'disabled' : ''}>${['normal', 'inmutable', 'escritura múltiple', 'multiconexión'].map((t) => `<option ${m.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <label>Ubicación:</label><input type="text" readonly value="${esc(m.path)}">
      <label>Descripción:</label><input type="text" id="m-desc" value="${esc(m.desc || '')}">
      ${mediaTab === 'hdd' ? `<label>Tamaño:</label><div class="slider-row"><input type="range" id="m-size" min="4" max="2048" value="${m.sizeGB}" ${m.variant === 'diff' ? 'disabled' : ''}><span><input type="number" id="m-size-n" min="4" max="2048" value="${m.sizeGB}" style="width:70px"> GB</span></div>` : ''}
      <label></label><div><button class="btn small" id="m-apply">Aplicar</button> <button class="btn small" id="m-reset">Restablecer</button></div>
      <label>Formato:</label><span>${mediaTab === 'hdd' ? `${m.format === 'VDI' ? 'VDI (VirtualBox Disk Image)' : m.format === 'VMDK' ? 'VMDK (Virtual Machine Disk)' : m.format}` : 'RAW'}</span>
      ${mediaTab === 'hdd' ? `<label>Detalles de almacenamiento:</label><span>${m.variant === 'fixed' ? 'Almacenamiento de tamaño fijo' : m.variant === 'diff' ? 'Disco diferencial (clonación enlazada)' : 'Almacenamiento reservado dinámicamente'}</span>` : ''}
      <label>UUID:</label><span>{${m.uuid}}</span>
      <label>Conectado a:</label><span>${esc(u) || '<i class="hint">No conectado</i>'}</span>
      ${mediaTab === 'hdd' ? `<label>Contenido:</label><span>${m.content ? esc(OS_TYPES[m.content.os].label) : '<i class="hint">Vacío (sin sistema operativo)</i>'}</span>` : ''}
    </div></div>`;
  }
  return `<div class="tool-split"><div class="tabs" style="padding-top:4px"><button class="tab ${mediaTab === 'hdd' ? 'on' : ''}" data-mtab="hdd">${icon('hdd', 14)} Discos duros</button><button class="tab ${mediaTab === 'dvd' ? 'on' : ''}" data-mtab="dvd">${icon('dvd', 14)} Discos ópticos</button><button class="tab ${mediaTab === 'floppy' ? 'on' : ''}" data-mtab="floppy">${icon('floppy', 14)} Disquetes</button></div><div class="top"><table class="tbl"><thead><tr><th>Nombre</th><th>Tamaño virtual</th><th>Tamaño real</th></tr></thead><tbody>${rows}</tbody></table></div>${m ? `<div class="bottom">${bottom}</div>` : ''}</div>`;
}

function networkPane() {
  let table = '';
  let bottom = '';
  if (netTab === 'hostonly') {
    table = `<table class="tbl"><thead><tr><th>Nombre</th><th>Prefijo IPv4</th><th>Prefijo IPv6</th><th>Servidor DHCP</th></tr></thead><tbody>${state.hostOnly.map((h) => `<tr class="${netSel === h.name ? 'sel' : ''}" data-n="${esc(h.name)}"><td>${icon('net', 16)} ${esc(h.name)}</td><td>${h.ip}/${h.prefix}</td><td></td><td>${h.dhcp.enabled ? 'Habilitar' : 'Inhabilitar'}</td></tr>`).join('') || '<tr><td colspan="4" class="hint">No hay redes solo anfitrión.</td></tr>'}</tbody></table>`;
    const h = hostOnlyOf(state, netSel);
    if (h) bottom = `<div class="tabs"><button class="tab ${!state.view.netSub || state.view.netSub === 'adapter' ? 'on' : ''}" data-nsub="adapter">Adaptador</button><button class="tab ${state.view.netSub === 'dhcp' ? 'on' : ''}" data-nsub="dhcp">Servidor DHCP</button></div><div class="tabpage">${state.view.netSub === 'dhcp' ? `<div class="form-grid"><label></label><label class="chk"><input type="checkbox" id="ho-dhcp" ${h.dhcp.enabled ? 'checked' : ''}> Habilitar servidor</label><label>Dirección del servidor:</label><input type="text" id="ho-srv" value="${h.dhcp.server}"><label>Máscara del servidor:</label><input type="text" value="${prefixMask(h.prefix)}" disabled><label>Límite inferior de direcciones:</label><input type="text" id="ho-lo" value="${h.dhcp.lower}"><label>Límite superior de direcciones:</label><input type="text" id="ho-up" value="${h.dhcp.upper}"></div>` : `<div class="form-grid"><label></label><div class="radio-col"><label class="chk"><input type="radio" name="ho-mode" disabled> Configurar adaptador automáticamente</label><label class="chk"><input type="radio" name="ho-mode" checked> Configurar adaptador manualmente</label></div><label>Dirección IPv4:</label><input type="text" id="ho-ip" value="${h.ip}"><label>Máscara de red IPv4:</label><input type="text" id="ho-mask" value="${prefixMask(h.prefix)}"><label>Dirección IPv6:</label><input type="text" disabled value="fe80::${(h.ip.split('.')[2] * 1).toString(16)}:1"></div>`}<div style="margin-top:10px;display:flex;gap:6px;justify-content:flex-end"><button class="btn small" id="ho-reset">Restablecer</button><button class="btn small primary" id="ho-apply">Aplicar</button></div></div>`;
  } else if (netTab === 'natnet') {
    table = `<table class="tbl"><thead><tr><th>Nombre</th><th>Prefijo IPv4</th><th>Prefijo IPv6</th><th>DHCP</th></tr></thead><tbody>${state.natNets.map((n) => `<tr class="${netSel === n.name ? 'sel' : ''}" data-n="${esc(n.name)}"><td>${icon('net', 16)} ${esc(n.name)}</td><td>${n.cidr}</td><td></td><td>${n.dhcp ? 'Habilitar' : 'Inhabilitar'}</td></tr>`).join('') || '<tr><td colspan="4" class="hint">No hay redes NAT. Pulse «Crear» para añadir una.</td></tr>'}</tbody></table>`;
    const n = natNetOf(state, netSel);
    if (n) bottom = `<div class="tabs"><button class="tab ${state.view.netSub !== 'pf' ? 'on' : ''}" data-nsub="general">Opciones generales</button><button class="tab ${state.view.netSub === 'pf' ? 'on' : ''}" data-nsub="pf">Reenvío de puertos</button></div><div class="tabpage">${state.view.netSub === 'pf' ? `<div class="tblwrap" style="max-height:180px"><table class="tbl" id="nn-pf"><thead><tr><th>Nombre</th><th>Protocolo</th><th>IP anfitrión</th><th>Puerto anfitrión</th><th>IP invitado</th><th>Puerto invitado</th><th></th></tr></thead><tbody>${n.pf.map((r, i) => `<tr data-i="${i}"><td><input value="${esc(r.name)}" data-f="name"></td><td><select data-f="proto"><option ${r.proto === 'tcp' ? 'selected' : ''}>tcp</option><option ${r.proto === 'udp' ? 'selected' : ''}>udp</option></select></td><td><input value="${esc(r.hostIp)}" data-f="hostIp"></td><td><input value="${r.hostPort}" data-f="hostPort"></td><td><input value="${esc(r.guestIp)}" data-f="guestIp"></td><td><input value="${r.guestPort}" data-f="guestPort"></td><td><button class="btn-ico" data-del="${i}" title="Eliminar regla">${icon('remove', 16)}</button></td></tr>`).join('')}</tbody></table></div><div style="margin-top:6px;display:flex;gap:6px"><button class="btn small" id="nn-pf-add">${icon('add', 14)} Añadir regla</button><span class="hint">En una Red NAT la IP del invitado es obligatoria (cada VM tiene la suya).</span></div>` : `<div class="form-grid"><label></label><label class="chk"><input type="checkbox" id="nn-en" ${n.enabled !== false ? 'checked' : ''}> Habilitar red</label><label>Nombre:</label><input type="text" id="nn-name" value="${esc(n.name)}"><label>Prefijo IPv4:</label><input type="text" id="nn-cidr" value="${n.cidr}"><label></label><label class="chk"><input type="checkbox" id="nn-dhcp" ${n.dhcp ? 'checked' : ''}> Habilitar DHCP</label><label></label><label class="chk"><input type="checkbox" disabled> Habilitar IPv6</label><label></label><span class="hint">Pasarela ${n.cidr.split('/')[0].replace(/\.\d+$/, '.1')} · servidor DHCP ${n.cidr.split('/')[0].replace(/\.\d+$/, '.3')} · ámbito desde ${n.cidr.split('/')[0].replace(/\.\d+$/, '.4')}</span></div>`}<div style="margin-top:10px;display:flex;gap:6px;justify-content:flex-end"><button class="btn small primary" id="nn-apply">Aplicar</button></div></div>`;
  } else {
    table = '<div class="welcome"><p>Las redes en la nube conectan máquinas locales con Oracle Cloud Infrastructure. No se simulan en VirtLab.</p></div>';
  }
  return `<div class="tool-split"><div class="tabs" style="padding-top:4px"><button class="tab ${netTab === 'hostonly' ? 'on' : ''}" data-ntab="hostonly">Redes solo anfitrión</button><button class="tab ${netTab === 'natnet' ? 'on' : ''}" data-ntab="natnet">Redes NAT</button><button class="tab ${netTab === 'cloud' ? 'on' : ''}" data-ntab="cloud">Redes en la nube</button></div><div class="top">${table}</div>${bottom ? `<div class="bottom">${bottom}</div>` : ''}</div>`;
}
const prefixMask = (p) => [24, 16, 8, 0].map((s) => ((p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0) >>> s) & 255).join('.');

async function netCreate() {
  if (netTab === 'hostonly') {
    const idx = state.hostOnly.length + 1;
    const name = idx === 1 ? 'VirtualBox Host-Only Ethernet Adapter' : `VirtualBox Host-Only Ethernet Adapter #${idx}`;
    let third = 56; while (state.hostOnly.some((h) => h.ip === `192.168.${third}.1`)) third++;
    state.hostOnly.push({ name, ip: `192.168.${third}.1`, prefix: 24, dhcp: { enabled: true, server: `192.168.${third}.100`, lower: `192.168.${third}.101`, upper: `192.168.${third}.254` } });
    netSel = name;
    toast(`Se ha creado «${esc(name)}» (192.168.${third}.1/24).`, { kind: 'ok' });
  } else if (netTab === 'natnet') {
    let i = 0; let name = 'NatNetwork';
    while (natNetOf(state, name)) name = `NatNetwork${++i}`;
    let third = 2; while (state.natNets.some((n) => n.cidr === `10.0.${third}.0/24`)) third++;
    state.natNets.push({ name, cidr: `10.0.${third}.0/24`, dhcp: true, enabled: true, pf: [] });
    netSel = name;
    (await import('../store.js')).logEvent({ type: 'natnet-add', name });
  }
  commit();
}
async function netRemove() {
  const usedBy = state.vms.filter((v) => v.nics.some((n) => n.enabled && ((netTab === 'hostonly' && n.attach === 'hostonly' && n.hostonly === netSel) || (netTab === 'natnet' && n.attach === 'natnet' && n.natnet === netSel))));
  const ok = await msgBox({ kind: 'question', text: `<p>¿Desea eliminar la red <b>${esc(netSel)}</b>?</p>${usedBy.length ? `<p>La usan: ${usedBy.map((v) => esc(v.name)).join(', ')}. Esas máquinas no podrán arrancar hasta que cambie su configuración de red.</p>` : ''}`, buttons: [{ label: 'Eliminar', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }] });
  if (!ok) return;
  if (netTab === 'hostonly') state.hostOnly = state.hostOnly.filter((h) => h.name !== netSel);
  else state.natNets = state.natNets.filter((n) => n.name !== netSel);
  netSel = null;
  commit();
}

// ------------------------------------------------------------------ eventos de los paneles
function bindPane(body, vm) {
  body.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => { const g = b.dataset.go; if (g === 'new') A.newVmWizard(); else if (g === 'host') A.openHostTerminal(); else selectTool(g); }; });
  body.querySelectorAll('[data-settings]').forEach((b) => { b.onclick = () => A.openSettings(vm, b.dataset.settings); });
  body.querySelectorAll('[data-tog]').forEach((b) => { b.onclick = () => { state.view.collapsed ||= {}; state.view.collapsed[b.dataset.tog] = !state.view.collapsed[b.dataset.tog]; commit(); }; });
  const pv = body.querySelector('.preview-box');
  if (pv && vm) pv.onclick = () => { if (vm.state === 'running' || vm.state === 'paused') A.showVm(vm); else A.startWithUi(vm); };
  // instantáneas
  body.querySelectorAll('[data-snap]').forEach((r) => {
    r.onclick = () => { selSnap = r.dataset.snap; renderToolbar(); renderPane(); };
    r.ondblclick = () => { const s = vm.snapshots.find((x) => x.id === r.dataset.snap); if (s) A.restoreSnapshotDialog(vm, s); };
    r.oncontextmenu = (e) => {
      e.preventDefault(); selSnap = r.dataset.snap; renderToolbar(); renderPane();
      const s = vm.snapshots.find((x) => x.id === selSnap);
      popupMenu(e.clientX, e.clientY, s ? [
        { label: 'Restaurar', icon: 'snapRestore', action: () => A.restoreSnapshotDialog(vm, s) },
        { label: 'Eliminar', icon: 'snapDelete', action: () => snapDelete(vm) },
        { label: 'Clonar…', icon: 'clone', action: () => A.cloneWizard(vm, s.id) },
      ] : [{ label: 'Tomar…', icon: 'snapTake', action: () => A.takeSnapshotDialog(vm) }]);
    };
  });
  const ss = body.querySelector('#snap-save');
  if (ss) ss.onclick = () => { const s = vm.snapshots.find((x) => x.id === selSnap); s.name = body.querySelector('#snap-name').value || s.name; s.desc = body.querySelector('#snap-desc').value; commit(); };
  // registros
  const lf = body.querySelector('#log-filter');
  if (lf) { lf.oninput = () => { logFilter = lf.value; const p = lf.selectionStart; renderPane(); const n = root.querySelector('#log-filter'); n.focus(); n.setSelectionRange(p, p); }; }
  body.querySelectorAll('[data-log]').forEach((b) => { b.onclick = () => { if (b.dataset.log === 'save') A.downloadText(`${vm.name}-VBox.log`, vm.log.join('\n')); else renderPane(); }; });
  // actividad
  drawCharts(body);
  // medios
  body.querySelectorAll('[data-mtab]').forEach((b) => { b.onclick = () => { mediaTab = b.dataset.mtab; mediaSel = null; renderAll(); }; });
  body.querySelectorAll('[data-m]').forEach((r) => {
    r.onclick = () => { mediaSel = r.dataset.m; renderAll(); };
    r.oncontextmenu = (e) => { e.preventDefault(); mediaSel = r.dataset.m; renderAll(); const m = getMedium(mediaSel); popupMenu(e.clientX, e.clientY, [{ label: 'Copiar…', icon: 'copy', disabled: mediaTab !== 'hdd', action: () => A.copyDisk(m) }, { label: 'Mover…', icon: 'move', action: () => A.moveMedium(m) }, { label: 'Eliminar', icon: 'remove', action: () => A.removeMedium(m).then((ok) => { if (ok) { mediaSel = null; renderAll(); } }) }, { label: 'Liberar', icon: 'release', disabled: !mediumUsers(m.id).length, action: () => A.releaseMedium(m) }]); };
  });
  const msz = body.querySelector('#m-size'); const msn = body.querySelector('#m-size-n');
  if (msz) { msz.oninput = () => { msn.value = msz.value; }; msn.oninput = () => { msz.value = msn.value; }; }
  const ma = body.querySelector('#m-apply');
  if (ma) ma.onclick = async () => {
    const m = getMedium(mediaSel);
    const sz = Number(body.querySelector('#m-size-n')?.value || m.sizeGB);
    if (sz < m.sizeGB) { await msgBox({ kind: 'error', title: 'VirtualBox - Error', text: `<p>No se puede reducir el tamaño del disco duro <b>${esc(m.name)}</b>: VirtualBox solo permite ampliarlo.</p>` }); renderAll(); return; }
    if (sz > m.sizeGB && mediumUsers(m.id).some((v) => v.state === 'running')) { await msgBox({ kind: 'error', title: 'VirtualBox - Error', text: '<p>No se puede cambiar el tamaño de un disco en uso por una máquina en ejecución.</p>' }); return; }
    if (sz > m.sizeGB) { m.sizeGB = sz; toast(`Disco ampliado a ${sz} GB. Recuerda ampliar también la partición dentro del invitado.`, { kind: 'ok' }); }
    m.desc = body.querySelector('#m-desc').value;
    const t = body.querySelector('#m-type'); if (t && !t.disabled) m.type = t.value;
    commit();
  };
  const mr = body.querySelector('#m-reset'); if (mr) mr.onclick = () => renderAll();
  // red
  body.querySelectorAll('[data-ntab]').forEach((b) => { b.onclick = () => { netTab = b.dataset.ntab; netSel = null; state.view.netSub = null; renderAll(); }; });
  body.querySelectorAll('[data-nsub]').forEach((b) => { b.onclick = () => { state.view.netSub = b.dataset.nsub; renderPane(); }; });
  body.querySelectorAll('[data-n]').forEach((r) => { r.onclick = () => { netSel = r.dataset.n; renderAll(); }; });
  const hoa = body.querySelector('#ho-apply');
  if (hoa) hoa.onclick = () => {
    const h = hostOnlyOf(state, netSel);
    const ip = body.querySelector('#ho-ip'); const mask = body.querySelector('#ho-mask');
    if (ip) { if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip.value)) { ip.classList.add('invalid'); return; } h.ip = ip.value; const p = mask.value.split('.').reduce((a, o) => a + (Number(o) >>> 0).toString(2).split('1').length - 1, 0); h.prefix = p; }
    const dh = body.querySelector('#ho-dhcp');
    if (dh) { h.dhcp.enabled = dh.checked; h.dhcp.server = body.querySelector('#ho-srv').value; h.dhcp.lower = body.querySelector('#ho-lo').value; h.dhcp.upper = body.querySelector('#ho-up').value; import('../store.js').then((s) => s.logEvent({ type: 'dhcp-cfg', hostonly: h.name, enabled: h.dhcp.enabled })); }
    commit();
    toast('Cambios aplicados a la red solo anfitrión.', { kind: 'ok' });
  };
  const hor = body.querySelector('#ho-reset'); if (hor) hor.onclick = () => renderPane();
  const nna = body.querySelector('#nn-apply');
  if (nna) nna.onclick = () => {
    const n = natNetOf(state, netSel);
    const nm = body.querySelector('#nn-name');
    if (nm) {
      const cidr = body.querySelector('#nn-cidr').value.trim();
      if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(cidr)) { body.querySelector('#nn-cidr').classList.add('invalid'); return; }
      const old = n.name;
      n.name = nm.value.trim() || n.name; n.cidr = cidr; n.dhcp = body.querySelector('#nn-dhcp').checked; n.enabled = body.querySelector('#nn-en').checked;
      if (old !== n.name) state.vms.forEach((v) => v.nics.forEach((x) => { if (x.natnet === old) x.natnet = n.name; }));
      netSel = n.name;
    } else syncPf(body, n);
    commit();
    toast('Cambios aplicados a la Red NAT.', { kind: 'ok' });
  };
  const add = body.querySelector('#nn-pf-add'); if (add) add.onclick = () => { const n = natNetOf(state, netSel); syncPf(body, n); n.pf.push({ name: `Regla ${n.pf.length + 1}`, proto: 'tcp', hostIp: '', hostPort: 2222 + n.pf.length, guestIp: n.cidr.split('/')[0].replace(/\.\d+$/, '.4'), guestPort: 22 }); commit(); };
  body.querySelectorAll('#nn-pf [data-del]').forEach((b) => { b.onclick = () => { const n = natNetOf(state, netSel); syncPf(body, n); n.pf.splice(Number(b.dataset.del), 1); commit(); }; });
}
function syncPf(body, n) {
  body.querySelectorAll('#nn-pf tbody tr').forEach((tr) => { const r = n.pf[Number(tr.dataset.i)]; tr.querySelectorAll('[data-f]').forEach((inp) => { const f = inp.dataset.f; r[f] = /Port$/.test(f) ? Number(inp.value) : inp.value.trim(); }); });
}

async function snapDelete(vm) {
  const s = vm.snapshots.find((x) => x.id === selSnap); if (!s) return;
  const ok = await msgBox({ kind: 'question', text: `<p>¿Está seguro de que desea eliminar la instantánea <b>${esc(s.name)}</b>?</p><p>Eliminar una instantánea no afecta al estado actual de la máquina: solo se pierde la posibilidad de volver a ella.</p>`, buttons: [{ label: 'Eliminar', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }] });
  if (!ok) return;
  deleteSnapshot(vm, s.id);
  selSnap = null;
}
function snapProps(vm) { const el = root.querySelector('#snap-name'); el?.focus(); }

export { renderPane };
