// Arranque de VirtLab: escritorio del anfitrión, Administrador, barra de tareas y escenarios por URL.
import { load, state, replaceState, commit, on } from './store.js';
import { recoverAfterReload } from './vmctl.js';
import { initDesktop, pinTaskbar, getWindow, msgBox, toast, popupMenu, modal } from './ui/wm.js';
import { icon } from './ui/icons.js';
import { openManager } from './ui/manager.js';
import { openHostTerminalWindow } from './ui/hostterm.js';
import { openAssistantWindow, decodeState } from './ui/assistant.js';
import { applyTheme, preferences, helpContents, about } from './ui/actions.js';
import { openVmWindow } from './ui/vmwindow.js';
import { linkChanged } from './net.js';
import './labs.js';

const WIN_LOGO = '<svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true"><path d="M2 2h13v13H2zM17 2h13v13H17zM2 17h13v13H2zM17 17h13v13H17z" fill="#0078d4"/></svg>';

async function boot() {
  load();
  // escenario compartido por enlace (#escenario=...) o enlace de la versión 1 (?escenario=)
  const m = location.hash.match(/escenario=([^&]+)/);
  if (m) {
    try {
      const s = await decodeState(m[1]);
      if (s.version !== 2 || !Array.isArray(s.vms)) throw new Error('versión');
      replaceState(s);
      history.replaceState(null, '', location.pathname);
      setTimeout(() => toast('Escenario cargado desde el enlace del instructor.', { kind: 'ok', timeout: 6000 }), 600);
    } catch (e) {
      console.warn(e);
      setTimeout(() => msgBox({ kind: 'error', title: 'VirtLab', text: '<p>El enlace del escenario no es válido o está incompleto.</p>' }), 600);
    }
  } else if (new URLSearchParams(location.search).has('escenario')) {
    setTimeout(() => msgBox({ kind: 'warn', title: 'VirtLab', text: '<p>Este enlace se creó con la versión anterior de VirtLab y no es compatible con la 2.0. Se carga el laboratorio por defecto.</p>' }), 600);
  }
  applyTheme();
  recoverAfterReload();

  const root = document.getElementById('root');
  initDesktop(root);
  const start = root.querySelector('#tb-start');
  start.innerHTML = WIN_LOGO;
  start.onclick = () => {
    const r = start.getBoundingClientRect();
    popupMenu(r.left, r.top - 300, [
      { header: 'Equipo del aula · alumno' },
      { label: 'Oracle VirtualBox', icon: 'vbox', action: launchManager },
      { label: 'Símbolo del sistema', icon: 'terminal', action: () => openHostTerminalWindow() },
      { label: 'Asistente VirtLab', icon: 'assistant', action: () => openAssistantWindow() },
      '-',
      { label: 'Configuración de red del anfitrión…', icon: 'network', action: hostNetDialog },
      { label: 'Preferencias de VirtualBox…', icon: 'prefs', action: preferences },
      { label: 'Ayuda de VirtLab', icon: 'question', action: () => helpContents() },
      { label: 'Acerca de VirtLab', icon: 'info', action: about },
    ]);
  };
  pinTaskbar({ id: 'mgr', winId: 'manager', icon: 'vbox', title: 'Oracle VirtualBox', launch: launchManager });
  pinTaskbar({ id: 'term', icon: 'terminal', title: 'Símbolo del sistema (anfitrión)', launch: () => openHostTerminalWindow() });
  pinTaskbar({ id: 'assistant', winId: 'assistant', icon: 'assistant', title: 'Asistente VirtLab', launch: () => openAssistantWindow() });

  const icons = root.querySelector('.desk-icons');
  icons.innerHTML = `<button class="desk-icon" data-d="vbox">${icon('vbox', 40)}Oracle VirtualBox</button><button class="desk-icon" data-d="term">${icon('terminal', 40)}Símbolo del sistema</button><button class="desk-icon" data-d="assist">${icon('assistant', 40)}Asistente VirtLab</button>`;
  const acts = { vbox: launchManager, term: () => openHostTerminalWindow(), assist: () => openAssistantWindow() };
  icons.querySelectorAll('[data-d]').forEach((b) => { b.ondblclick = () => acts[b.dataset.d](); b.onkeydown = (e) => { if (e.key === 'Enter') acts[b.dataset.d](); }; });

  const tray = root.querySelector('.tb-tray');
  const clock = () => { const d = new Date(); tray.querySelector('.tb-clock').innerHTML = `${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}<br>${d.toLocaleDateString('es-ES')}`; };
  const netBtn = tray.querySelector('#tb-net');
  netBtn.onclick = hostNetDialog;
  const netIco = () => {
    netBtn.innerHTML = state.host.eth.up
      ? '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="9" width="12" height="5" rx="1" fill="currentColor"/><path d="M5 9V6h6v3M8 6V2" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="9" width="12" height="5" rx="1" fill="currentColor" opacity=".4"/><path d="M3 3l10 10" stroke="#c42b1c" stroke-width="2"/></svg>';
    netBtn.title = state.host.eth.up ? `Ethernet: ${state.host.eth.ip} (acceso a Internet)` : 'Ethernet: cable de red desconectado';
  };
  clock(); netIco();
  setInterval(clock, 15000);
  on('change', netIco);

  launchManager();
  for (const vm of state.vms) if ((vm.state === 'running' || vm.state === 'paused') && vm.rt && !vm.rt.headless) openVmWindow(vm);
  if (!state.prefs.welcomed) {
    state.prefs.welcomed = true;
    commit();
    setTimeout(() => openAssistantWindow('lab'), 400);
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'F1') { e.preventDefault(); helpContents(); } });
}

function launchManager() {
  const w = getWindow('manager');
  if (w) { w.restore(); w.focus(); return; }
  openManager();
}

let picked = null;
async function hostNetDialog() {
  const h = state.host;
  picked = null;
  const r = await modal({
    title: `Configuración de red del anfitrión (${h.name})`, iconName: 'network', width: 540,
    html: `<div class="form-grid"><label>Ethernet:</label><label class="chk"><input type="checkbox" id="h-eth" ${h.eth.up ? 'checked' : ''}> Cable conectado (${h.eth.ip}/24, puerta de enlace ${h.eth.gw})</label><label>Wi-Fi:</label><label class="chk"><input type="checkbox" id="h-wifi" ${h.wifi.up ? 'checked' : ''}> Conectado a «AULA-07» (192.168.1.120)</label><label>Firewall:</label><label class="chk"><input type="checkbox" id="h-icmp" ${h.icmpIn ? 'checked' : ''}> Permitir ping entrante (eco ICMPv4)</label></div><p class="hint">Desconectar el cable del anfitrión deja sin red a las máquinas en modo puente sobre esa tarjeta y sin Internet a todas las demás. Las redes solo anfitrión y las redes internas siguen funcionando.</p>`,
    buttons: [{ label: 'Aceptar', value: true, primary: true, action: (a) => { picked = { eth: a.body.querySelector('#h-eth').checked, wifi: a.body.querySelector('#h-wifi').checked, icmp: a.body.querySelector('#h-icmp').checked }; } }, { label: 'Cancelar', value: false, cancel: true }],
  });
  if (!r || !picked) return;
  h.eth.up = picked.eth; h.wifi.up = picked.wifi; h.wifi.ip = picked.wifi ? '192.168.1.120' : null; h.icmpIn = picked.icmp;
  for (const vm of state.vms) if (vm.rt) linkChanged(state, vm);
  commit();
}

boot();
