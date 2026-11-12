// Diálogo de configuración de una máquina virtual (VirtualBox 7.1).
import { state, commit, getMedium, mediumUsers, logEvent } from '../store.js';
import { OS_TYPES, OS_TREE, osKeyFromVersion, ATTACH, NIC_TYPES, PROMISC, HOST_IFACES, GRAPHICS, AUDIO_CTRL, CLIPBOARD, PARAVIRT, BOOT_DEVICES, ISOS } from '../catalog.js';
import { esc, clone, vboxMac, normMac, isValidMac, fmtGB, macColon } from '../util.js';
import { icon, osIcon } from './icons.js';
import { modal, msgBox, popupMenu, toast } from './wm.js';
import { validateVm } from '../vmctl.js';
import { linkChanged, natNetOf, hostOnlyOf } from '../net.js';
import { filePicker, newDiskDialog } from './wizards.js';
import { registerIso } from './actions.js';

const SECTIONS = [
  ['general', 'general', 'General'], ['system', 'system', 'Sistema'], ['display', 'display', 'Pantalla'], ['storage', 'storage', 'Almacenamiento'],
  ['audio', 'audio', 'Audio'], ['network', 'net', 'Red'], ['serial', 'serial', 'Puertos serie'], ['usb', 'usb', 'USB'], ['shared', 'shared', 'Carpetas compartidas'], ['ui', 'ui', 'Interfaz de usuario'],
];

export async function openSettingsDialog(vm, startSec = 'general') {
  const running = vm.state === 'running' || vm.state === 'paused';
  const saved = vm.state === 'saved';
  const locked = running || saved; // con estado guardado tampoco se puede cambiar el hardware
  const d = clone({ name: vm.name, osKey: vm.osKey, description: vm.description, hw: vm.hw, storage: vm.storage, nics: vm.nics, shared: vm.shared });
  let sec = startSec === 'description' ? 'general' : startSec;
  let tab = { general: startSec === 'description' ? 'desc' : 'basic', system: 'mb', display: 'screen', network: 0, serial: 0 };
  let storSel = { c: 0, s: -1 };
  let bootSel = 0;
  let api;

  const draftVm = () => ({ ...vm, ...d, hw: d.hw, nics: d.nics, storage: d.storage });
  const issues = () => validateVm(draftVm());
  const dis = (cond) => (cond ? 'disabled' : '');
  const hostRam = state.host.ramMB;

  function render() {
    const iss = issues();
    const errSecs = new Set(iss.filter((i) => i.level === 'error').map((i) => i.sec));
    const head = SECTIONS.find((s) => s[0] === sec);
    api.body.innerHTML = `<div class="settings"><nav class="set-nav" aria-label="Secciones">${SECTIONS.map(([id, ic, label]) => `<button class="${id === sec ? 'on' : ''}" data-sec="${id}">${icon(ic, 20)}<span>${label}</span>${errSecs.has(id) ? `<span class="bad">${icon('warn', 14)}</span>` : ''}</button>`).join('')}</nav><div class="set-main"><div class="set-head">${icon(head[1], 22)}${head[2]}</div><div class="set-content">${page()}</div></div></div>`;
    const foot = api.el.querySelector('.set-foot');
    if (foot) foot.innerHTML = iss.length ? `${icon(iss.some((i) => i.level === 'error') ? 'error' : 'warn', 14)} <span title="${esc(iss.map((i) => i.text).join('\n'))}">${iss.some((i) => i.level === 'error') ? 'Configuración no válida detectada' : 'Hay avisos de configuración'}: ${esc(iss[0].text)}</span>` : running ? `${icon('info', 14)} Algunos ajustes no se pueden cambiar mientras la máquina está en ejecución.` : '';
    api.setButton(1, { disabled: iss.some((i) => i.level === 'error') });
    bind();
  }

  function page() {
    switch (sec) {
      case 'general': return generalPage();
      case 'system': return systemPage();
      case 'display': return displayPage();
      case 'storage': return storagePage();
      case 'audio': return audioPage();
      case 'network': return networkPage();
      case 'serial': return serialPage();
      case 'usb': return usbPage();
      case 'shared': return sharedPage();
      default: return uiPage();
    }
  }
  const tabs = (key, list) => `<div class="tabs">${list.map(([id, label]) => `<button class="tab ${String(tab[key]) === String(id) ? 'on' : ''}" data-tab="${key}:${id}">${label}</button>`).join('')}</div>`;

  function generalPage() {
    const os = OS_TYPES[d.osKey];
    let body = '';
    if (tab.general === 'basic') {
      const types = Object.keys(OS_TREE);
      const subs = Object.keys(OS_TREE[os.type] || OS_TREE.Other);
      const vers = OS_TREE[os.type]?.[os.subtype] || [os.version];
      body = `<div class="form-grid"><label for="g-name">Nombre:</label><input type="text" id="g-name" value="${esc(d.name)}" ${dis(running)}>
      <label>Carpeta de la máquina:</label><input type="text" value="${esc(vm.folder)}" disabled>
      <label for="g-type">Tipo:</label><select id="g-type" ${dis(locked)}>${types.map((t) => `<option ${t === os.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <label for="g-sub">Subtipo:</label><select id="g-sub" ${dis(locked)}>${subs.map((t) => `<option ${t === os.subtype ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <label for="g-ver">Versión:</label><div style="display:flex;gap:8px;align-items:center"><select id="g-ver" style="flex:1" ${dis(locked)}>${vers.map((t) => `<option ${t === os.version ? 'selected' : ''}>${t}</option>`).join('')}</select>${osIcon(d.osKey, 28)}</div></div>`;
    } else if (tab.general === 'adv') {
      body = `<div class="form-grid"><label>Carpeta de instantáneas:</label><input type="text" value="${esc(vm.folder)}\\Snapshots" disabled>
      <label for="g-clip">Compartir portapapeles:</label><select id="g-clip">${CLIPBOARD.map((c) => `<option ${d.hw.clipboard === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
      <label for="g-dnd">Arrastrar y soltar:</label><select id="g-dnd">${CLIPBOARD.map((c) => `<option ${d.hw.dragdrop === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
      <label></label><p class="hint" style="margin:0">El portapapeles compartido y arrastrar y soltar necesitan las Guest Additions instaladas en el invitado.</p></div>`;
    } else if (tab.general === 'desc') {
      body = `<textarea id="g-desc" rows="12" style="width:100%" aria-label="Descripción">${esc(d.description)}</textarea>`;
    } else {
      body = `<div class="form-grid"><label></label><label class="chk"><input type="checkbox" id="g-enc" ${d.hw.diskEnc ? 'checked' : ''} ${dis(locked)}> Habilitar cifrado de disco</label><label>Cifrado:</label><select disabled><option>AES-XTS256-PLAIN64</option></select><label></label><p class="hint" style="margin:0">El cifrado de disco requiere el paquete de extensión de Oracle VirtualBox; VirtLab solo guarda la opción.</p></div>`;
    }
    return tabs('general', [['basic', 'Básico'], ['adv', 'Avanzado'], ['desc', 'Descripción'], ['enc', 'Cifrado de disco']]) + `<div class="tabpage">${body}</div>`;
  }

  function slider(id, val, min, max, unit, { zones = false, disabled = false, step = 1 } = {}) {
    const g = zones ? `--g:${(hostRam * 0.5 - min) / (max - min) * 100}%;--y:${(hostRam * 0.75 - min) / (max - min) * 100}%` : '';
    return `<div><div class="slider-row"><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}" ${dis(disabled)}><span style="display:flex;gap:4px;align-items:center"><input type="number" id="${id}-n" min="${min}" max="${max}" value="${val}" style="width:72px" ${dis(disabled)}> ${unit}</span></div>${zones ? `<div class="range-zones" style="${g}"></div>` : ''}<div class="slider-scale"><span>${min} ${unit}</span><span>${max} ${unit}</span></div></div>`;
  }

  function systemPage() {
    let body = '';
    if (tab.system === 'mb') {
      body = `<div class="form-grid"><label for="s-ram">Memoria base:</label>${slider('s-ram', d.hw.ramMB, 4, hostRam, 'MB', { zones: true, disabled: locked, step: 4 })}
      <label>Orden de arranque:</label><div style="display:flex;gap:6px;align-items:flex-start"><div class="boot-list" role="listbox">${d.hw.boot.map((b, i) => `<div class="${i === bootSel ? 'sel' : ''}" data-boot="${i}"><input type="checkbox" data-bootchk="${i}" ${b.on ? 'checked' : ''} ${dis(locked)} aria-label="${BOOT_DEVICES[b.dev]}">${icon(b.dev === 'hdd' ? 'hdd' : b.dev === 'dvd' ? 'dvd' : b.dev === 'net' ? 'net' : 'floppy', 16)} ${BOOT_DEVICES[b.dev]}</div>`).join('')}</div><div style="display:grid;gap:2px"><button class="btn-ico" id="b-up" ${dis(locked)} title="Subir">${icon('up', 14)}</button><button class="btn-ico" id="b-down" ${dis(locked)} title="Bajar">${icon('down', 14)}</button></div></div>
      <label for="s-chip">Chipset:</label><select id="s-chip" ${dis(locked)}><option ${d.hw.chipset === 'PIIX3' ? 'selected' : ''}>PIIX3</option><option ${d.hw.chipset === 'ICH9' ? 'selected' : ''}>ICH9</option></select>
      <label for="s-tpm">Chip TPM:</label><select id="s-tpm" ${dis(locked)}>${[['none', 'Ninguno'], ['1.2', 'v1.2'], ['2.0', 'v2.0']].map(([v, l]) => `<option value="${v}" ${d.hw.tpm === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label for="s-ptr">Dispositivo apuntador:</label><select id="s-ptr" ${dis(locked)}>${['Ratón PS/2', 'Tableta USB', 'Tableta USB multitáctil'].map((p) => `<option ${d.hw.pointing === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
      <label>Características extendidas:</label><div class="radio-col"><label class="chk"><input type="checkbox" id="s-ioapic" ${d.hw.ioapic ? 'checked' : ''} ${dis(locked)}> Habilitar I/O APIC</label><label class="chk"><input type="checkbox" id="s-utc" ${d.hw.utcClock ? 'checked' : ''} ${dis(locked)}> Hardware de reloj en tiempo UTC</label><label class="chk"><input type="checkbox" id="s-efi" ${d.hw.efi ? 'checked' : ''} ${dis(locked)}> Habilitar EFI (solo SO especiales)</label><label class="chk"><input type="checkbox" id="s-sb" ${d.hw.secureBoot ? 'checked' : ''} ${dis(locked || !d.hw.efi)}> Habilitar arranque seguro</label></div></div>`;
    } else if (tab.system === 'cpu') {
      body = `<div class="form-grid"><label for="s-cpu">Procesadores:</label>${slider('s-cpu', d.hw.cpus, 1, state.host.cpus * 2, 'CPU', { disabled: locked })}
      <label for="s-cap">Límite de ejecución:</label>${slider('s-cap', d.hw.cpuCap, 1, 100, '%', { disabled: false })}
      <label>Características extendidas:</label><div class="radio-col"><label class="chk"><input type="checkbox" id="s-pae" ${d.hw.pae ? 'checked' : ''} ${dis(locked)}> Habilitar PAE/NX</label><label class="chk"><input type="checkbox" id="s-nvt" ${d.hw.nestedVt ? 'checked' : ''} ${dis(locked)}> Habilitar VT-x/AMD-V anidado</label></div></div>`;
    } else {
      body = `<div class="form-grid"><label for="s-pv">Interfaz de paravirtualización:</label><select id="s-pv" ${dis(locked)}>${PARAVIRT.map((p) => `<option ${d.hw.paravirt === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
      <label>Virtualización por hardware:</label><label class="chk"><input type="checkbox" id="s-np" ${d.hw.nestedPaging ? 'checked' : ''} ${dis(locked)}> Habilitar paginación anidada</label></div>`;
    }
    return tabs('system', [['mb', 'Placa base'], ['cpu', 'Procesador'], ['acc', 'Aceleración']]) + `<div class="tabpage">${body}</div>`;
  }

  function displayPage() {
    let body = '';
    if (tab.display === 'screen') {
      body = `<div class="form-grid"><label for="d-vram">Memoria de vídeo:</label>${slider('d-vram', d.hw.vram, 0, 256, 'MB', { disabled: locked })}
      <label for="d-mon">Número de monitores:</label>${slider('d-mon', d.hw.monitors, 1, 8, '', { disabled: locked })}
      <label for="d-scale">Factor de escalado:</label>${slider('d-scale', d.hw.scale, 100, 200, '%', { step: 25 })}
      <label for="d-gc">Controlador gráfico:</label><select id="d-gc" ${dis(locked)}>${GRAPHICS.map((g) => `<option ${d.hw.graphics === g ? 'selected' : ''}>${g}</option>`).join('')}</select>
      <label>Características extendidas:</label><label class="chk"><input type="checkbox" id="d-3d" ${d.hw.accel3d ? 'checked' : ''} ${dis(locked)}> Habilitar aceleración 3D</label></div>`;
    } else if (tab.display === 'rdp') {
      body = `<div class="form-grid"><label></label><label class="chk"><input type="checkbox" id="d-rdp" ${d.hw.rdp ? 'checked' : ''}> Habilitar servidor</label><label>Puerto del servidor:</label><input type="text" value="3389" disabled><label>Método de autenticación:</label><select disabled><option>Nulo</option></select></div>`;
    } else {
      body = `<div class="form-grid"><label></label><label class="chk"><input type="checkbox" id="d-rec" ${d.hw.recording ? 'checked' : ''}> Habilitar grabación</label><label>Ruta de archivo:</label><input type="text" value="${esc(vm.folder)}\\${esc(vm.name)}.webm" disabled></div>`;
    }
    return tabs('display', [['screen', 'Pantalla'], ['rdp', 'Pantalla remota'], ['rec', 'Grabación']]) + `<div class="tabpage">${body}</div>`;
  }

  function storagePage() {
    let tree = '';
    d.storage.forEach((c, ci) => {
      tree += `<div class="node ${storSel.c === ci && storSel.s === -1 ? 'sel' : ''}" data-st="${ci}:-1">${icon('controller', 16)} Controlador: ${esc(c.name)}</div>`;
      c.slots.forEach((s, si) => {
        const m = getMedium(s.medium);
        tree += `<div class="node child ${storSel.c === ci && storSel.s === si ? 'sel' : ''}" data-st="${ci}:${si}">${icon(s.kind === 'dvd' ? 'dvd' : 'hdd', 16)} ${m ? esc(m.name) : 'Vacío'}</div>`;
      });
    });
    const c = d.storage[storSel.c];
    const s = c?.slots[storSel.s];
    let attrs = '';
    if (c && !s) {
      attrs = `<div class="form-grid"><label>Nombre:</label><input type="text" value="${esc(c.name)}" disabled><label>Tipo:</label><select disabled><option>${c.type}</option></select>${c.bus === 'SATA' ? `<label>Cantidad de puertos:</label><input type="number" value="${c.portCount || 2}" min="1" max="30" id="st-ports" ${dis(locked)} style="width:70px">` : ''}<label></label><label class="chk"><input type="checkbox" ${c.hostIoCache ? 'checked' : ''} disabled> Usar cache de E/S anfitrión</label></div>`;
    } else if (s) {
      const m = getMedium(s.medium);
      const portsFor = c.bus === 'IDE' ? ['IDE primario maestro', 'IDE primario esclavo', 'IDE secundario maestro', 'IDE secundario esclavo'] : Array.from({ length: c.portCount || 2 }, (_, i) => `Puerto SATA ${i}`);
      attrs = `<div class="form-grid"><label>${s.kind === 'dvd' ? 'Unidad óptica:' : 'Disco duro:'}</label><div style="display:flex;gap:4px"><select id="st-port" ${dis(locked)} style="flex:1">${portsFor.map((p) => `<option ${p === s.port ? 'selected' : ''}>${p}</option>`).join('')}</select><button class="btn-ico" id="st-pick" title="${s.kind === 'dvd' ? 'Elegir un disco óptico' : 'Elegir un disco duro'}" ${dis(locked && s.kind !== 'dvd')}>${icon(s.kind === 'dvd' ? 'dvd' : 'hdd', 18)}${icon('caret', 10)}</button></div>
      ${s.kind === 'dvd' ? `<label></label><label class="chk"><input type="checkbox" id="st-live" ${s.live ? 'checked' : ''}> Live CD/DVD</label>` : `<label></label><label class="chk"><input type="checkbox" ${s.ssd ? 'checked' : ''} id="st-ssd" ${dis(locked)}> Unidad de estado sólido</label><label></label><label class="chk"><input type="checkbox" ${s.hotplug ? 'checked' : ''} id="st-hot" ${dis(locked)}> Conectable en caliente</label>`}
      <label class="full" style="text-align:left;font-weight:600;margin-top:8px">Información</label>
      <label>Tipo:</label><span>${m ? (s.kind === 'dvd' ? 'Imagen' : `${m.format === 'VDI' ? 'Normal (VDI)' : `Normal (${m.format})`}`) : '--'}</span>
      <label>Tamaño ${s.kind === 'dvd' ? '' : 'virtual'}:</label><span>${m ? (s.kind === 'dvd' ? fmtGB(m.sizeMB / 1024) : fmtGB(m.sizeGB)) : '--'}</span>
      ${s.kind === 'hdd' ? `<label>Tamaño real:</label><span>${m ? fmtGB(m.usedGB) : '--'}</span><label>Detalles:</label><span>${m ? (m.variant === 'fixed' ? 'Almacenamiento de tamaño fijo' : m.variant === 'diff' ? 'Diferencial' : 'Almacenamiento reservado dinámicamente') : '--'}</span>` : ''}
      <label>Ubicación:</label><span style="overflow-wrap:anywhere">${m ? esc(m.path) : '--'}</span>
      <label>Conectado a:</label><span>${m ? esc(mediumUsers(m.id).map((v) => v.name).join(', ') || '--') : '--'}</span></div>`;
    }
    return `<div class="tabpage"><div class="stor-wrap"><div><div style="font-weight:600;margin-bottom:4px">Dispositivos de almacenamiento</div><div class="stor-tree">${tree}</div><div class="stor-actions"><button class="btn-ico" id="st-addc" title="Añadir controlador" ${dis(locked)}>${icon('controller', 18)}</button><button class="btn-ico" id="st-addd" title="Añadir unidad óptica" ${dis(locked || !c)}>${icon('dvd', 18)}</button><button class="btn-ico" id="st-addh" title="Añadir disco duro" ${dis(locked || !c)}>${icon('hdd', 18)}</button><button class="btn-ico" id="st-rm" title="Eliminar la conexión seleccionada" ${dis(locked || !c)}>${icon('remove', 18)}</button></div></div><div><div style="font-weight:600;margin-bottom:4px">Atributos</div>${attrs || '<p class="hint">Seleccione un controlador o una unidad.</p>'}</div></div></div>`;
  }

  function audioPage() {
    return `<div class="tabpage"><div class="form-grid"><label></label><label class="chk"><input type="checkbox" id="a-en" ${d.hw.audio.enabled ? 'checked' : ''} ${dis(locked)}> Habilitar audio</label>
    <label>Controlador de audio de anfitrión:</label><select id="a-drv" ${dis(locked || !d.hw.audio.enabled)}>${['Predeterminado', 'Windows DirectSound', 'Windows Audio Session', 'Audio nulo'].map((x) => `<option ${d.hw.audio.driver === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
    <label>Controlador de audio:</label><select id="a-ctl" ${dis(locked || !d.hw.audio.enabled)}>${AUDIO_CTRL.map((x) => `<option ${d.hw.audio.controller === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
    <label>Características extendidas:</label><div class="radio-col"><label class="chk"><input type="checkbox" id="a-out" ${d.hw.audio.out ? 'checked' : ''} ${dis(!d.hw.audio.enabled)}> Habilitar salida de audio</label><label class="chk"><input type="checkbox" id="a-in" ${d.hw.audio.in ? 'checked' : ''} ${dis(!d.hw.audio.enabled)}> Habilitar entrada de audio</label></div></div></div>`;
  }

  function networkPage() {
    const i = Number(tab.network);
    const n = d.nics[i];
    const names = (() => {
      if (n.attach === 'bridged') return `<select id="n-name" ${dis(!n.enabled)}>${HOST_IFACES.map((h) => `<option ${n.bridged === h.name ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}</select>`;
      if (n.attach === 'intnet') { const known = new Set(['intnet']); state.vms.forEach((v) => v.nics.forEach((x) => { if (x.attach === 'intnet' && x.intnet) known.add(x.intnet); })); return `<input type="text" id="n-name" list="intnets" value="${esc(n.intnet)}" ${dis(!n.enabled)}><datalist id="intnets">${[...known].map((k) => `<option value="${esc(k)}">`).join('')}</datalist>`; }
      if (n.attach === 'hostonly') return state.hostOnly.length ? `<select id="n-name" ${dis(!n.enabled)}>${state.hostOnly.map((h) => `<option ${n.hostonly === h.name ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}</select>` : '<select id="n-name" disabled><option>No seleccionado</option></select>';
      if (n.attach === 'natnet') return state.natNets.length ? `<select id="n-name" ${dis(!n.enabled)}>${state.natNets.map((x) => `<option ${n.natnet === x.name ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : '<select id="n-name" disabled><option>No seleccionado</option></select>';
      if (n.attach === 'generic') return `<input type="text" id="n-name" value="${esc(n.generic)}" placeholder="UDPTunnel / VDE" ${dis(!n.enabled)}>`;
      return '<select disabled><option></option></select>';
    })();
    const help = {
      none: 'La tarjeta de red existe en la VM pero no está conectada a nada (como un cable sin enchufar al otro extremo).',
      nat: 'Cada VM queda detrás de su propio router NAT privado (10.0.2.0/24). Tiene Internet, pero no se ve con otras VMs ni es accesible desde fuera salvo con reenvío de puertos.',
      natnet: 'Como NAT, pero compartido: todas las VMs conectadas a la misma Red NAT se ven entre sí y salen a Internet. Créela antes en Herramientas › Red.',
      bridged: 'La VM se conecta directamente a la red física del anfitrión, como un equipo más: recibe IP del router del aula y es visible por todos.',
      intnet: 'Red aislada solo entre VMs con el mismo nombre de red interna. No hay DHCP ni salida a Internet: las IP se configuran a mano.',
      hostonly: 'Red privada entre el anfitrión (192.168.56.1) y las VMs. Tiene DHCP, pero no salida a Internet.',
      generic: 'Controladores especiales (UDP Tunnel, VDE). No se simulan en VirtLab.',
      cloud: 'Conecta con una red de Oracle Cloud Infrastructure. No se simula en VirtLab.',
    }[n.attach];
    const canPf = n.attach === 'nat';
    return tabs('network', [0, 1, 2, 3].map((k) => [k, `Adaptador ${k + 1}`])) + `<div class="tabpage"><div class="form-grid">
      <label></label><label class="chk"><input type="checkbox" id="n-en" ${n.enabled ? 'checked' : ''} ${dis(locked)}> Habilitar adaptador de red</label>
      <label for="n-att">Conectado a:</label><select id="n-att" ${dis(!n.enabled)}>${ATTACH.map((a) => `<option value="${a.id}" ${n.attach === a.id ? 'selected' : ''}>${a.label}</option>`).join('')}</select>
      <label for="n-name">Nombre:</label>${names}
      <label></label><p class="hint" style="margin:0">${help}</p>
      <label></label><details class="adv" ${state.view.advOpen ? 'open' : ''}><summary>Avanzadas</summary><div class="form-grid" style="margin-top:6px">
        <label for="n-type">Tipo de adaptador:</label><select id="n-type" ${dis(!n.enabled || locked)}>${NIC_TYPES.map((t) => `<option value="${t.id}" ${n.type === t.id ? 'selected' : ''}>${t.label}</option>`).join('')}</select>
        <label for="n-prom">Modo promiscuo:</label><select id="n-prom" ${dis(!n.enabled || !['bridged', 'intnet', 'hostonly', 'natnet'].includes(n.attach))}>${PROMISC.map((p) => `<option value="${p.id}" ${n.promisc === p.id ? 'selected' : ''}>${p.label}</option>`).join('')}</select>
        <label for="n-mac">Dirección MAC:</label><div style="display:flex;gap:4px"><input type="text" id="n-mac" value="${esc(n.mac)}" maxlength="17" style="flex:1;font-family:var(--mono)" ${dis(!n.enabled || locked)}><button class="btn-ico" id="n-mac-new" title="Genera una nueva dirección MAC aleatoria" ${dis(!n.enabled || locked)}>${icon('mac', 18)}</button></div>
        <label></label><label class="chk"><input type="checkbox" id="n-cable" ${n.cable ? 'checked' : ''} ${dis(!n.enabled)}> Cable conectado</label>
        <label></label><div><button class="btn" id="n-pf" ${dis(!n.enabled || !canPf)}>Reenvío de puertos</button>${n.attach === 'natnet' ? ' <span class="hint">En Red NAT el reenvío se configura en Herramientas › Red.</span>' : ''}</div>
      </div></details></div></div>`;
  }

  function serialPage() {
    const p = d.hw.serial[0];
    return tabs('serial', [[0, 'Puerto 1'], [1, 'Puerto 2'], [2, 'Puerto 3'], [3, 'Puerto 4']]) + `<div class="tabpage"><div class="form-grid"><label></label><label class="chk"><input type="checkbox" id="se-en" ${Number(tab.serial) === 0 && p.enabled ? 'checked' : ''} ${dis(locked)}> Habilitar puerto serie</label><label>Número de puerto:</label><select disabled><option>COM${Number(tab.serial) + 1}</option></select><label>Modo de puerto:</label><select disabled><option>Desconectado</option><option>Dispositivo anfitrión</option><option>Tubería anfitrión</option><option>Archivo sin procesar</option><option>TCP</option></select></div></div>`;
  }

  function usbPage() {
    const u = d.hw.usb;
    return `<div class="tabpage"><div class="form-grid"><label></label><label class="chk"><input type="checkbox" id="u-en" ${u.enabled ? 'checked' : ''} ${dis(locked)}> Habilitar controlador USB</label>
    <label></label><div class="radio-col">${[['1.1', 'Controlador USB 1.1 (OHCI)'], ['2.0', 'Controlador USB 2.0 (OHCI + EHCI)'], ['3.0', 'Controlador USB 3.0 (xHCI)']].map(([v, l]) => `<label class="chk"><input type="radio" name="u-ver" value="${v}" ${u.ver === v ? 'checked' : ''} ${dis(locked || !u.enabled)}> ${l}</label>`).join('')}</div>
    <label>Filtros de dispositivos USB:</label><div class="tblwrap" style="min-height:90px"><table class="tbl"><tbody>${u.filters.map((f, i) => `<tr><td><label class="chk"><input type="checkbox" checked> ${esc(f)}</label></td><td style="width:30px"><button class="btn-ico" data-ufdel="${i}" title="Eliminar filtro">${icon('remove', 14)}</button></td></tr>`).join('') || '<tr><td class="hint">Sin filtros</td></tr>'}</tbody></table></div>
    <label></label><div><button class="btn small" id="u-add" ${dis(!u.enabled)}>${icon('add', 14)} Añadir filtro (dispositivo del anfitrión)</button></div>
    <label></label><p class="hint" style="margin:0">USB 2.0 y 3.0 en un VirtualBox real requieren el paquete de extensión de Oracle.</p></div></div>`;
  }

  function sharedPage() {
    return `<div class="tabpage"><div style="display:flex;gap:8px"><div class="tblwrap" style="flex:1;min-height:200px"><table class="tbl"><thead><tr><th>Nombre</th><th>Ruta</th><th>Acceso</th><th>Automontar</th><th>En</th></tr></thead><tbody><tr><td colspan="5" style="font-weight:600">Carpetas de la máquina</td></tr>${d.shared.map((s, i) => `<tr class="${state.view.shSel === i ? 'sel' : ''}" data-sh="${i}"><td style="padding-left:18px">${icon('folder', 14)} ${esc(s.name)}</td><td>${esc(s.hostPath)}</td><td>${s.readonly ? 'Solo lectura' : 'Completo'}</td><td>${s.automount ? 'Sí' : ''}</td><td>${esc(s.mountPoint || '')}</td></tr>`).join('')}</tbody></table></div><div style="display:grid;gap:2px;align-content:start"><button class="btn-ico" id="sh-add" title="Añadir carpeta compartida">${icon('add', 18)}</button><button class="btn-ico" id="sh-edit" title="Editar carpeta compartida" ${dis(state.view.shSel == null)}>${icon('props', 18)}</button><button class="btn-ico" id="sh-rm" title="Eliminar carpeta compartida" ${dis(state.view.shSel == null)}>${icon('remove', 18)}</button></div></div><p class="hint">En Linux, las carpetas con «Automontar» aparecen en <code>/media/sf_&lt;nombre&gt;</code> y solo las pueden abrir root y los miembros del grupo <code>vboxsf</code>. En Windows, en una unidad de red (<code>\\\\VBOXSVR\\&lt;nombre&gt;</code>). Requiere las Guest Additions.</p></div>`;
  }

  function uiPage() {
    return `<div class="tabpage"><div class="form-grid"><label>Barra de menús:</label><label class="chk"><input type="checkbox" checked disabled> Habilitar barra de menús</label><label>Mini barra de herramientas:</label><label class="chk"><input type="checkbox" id="ui-mini" ${d.hw.miniToolbar ? 'checked' : ''}> Mostrar en pantalla completa/modo integrado</label><label>Barra de estado:</label><label class="chk"><input type="checkbox" checked disabled> Habilitar barra de estado</label></div></div>`;
  }

  // ------------------------------------------------------------------ eventos
  function bindSlider(id, apply) {
    const r = api.body.querySelector(`#${id}`); const n = api.body.querySelector(`#${id}-n`);
    if (!r) return;
    r.oninput = () => { n.value = r.value; apply(Number(r.value)); refreshFooter(); };
    n.onchange = () => { r.value = n.value; apply(Number(n.value)); render(); };
    r.onchange = () => render();
  }
  function refreshFooter() {
    const iss = issues();
    const foot = api.el.querySelector('.set-foot');
    foot.innerHTML = iss.length ? `${icon(iss.some((i) => i.level === 'error') ? 'error' : 'warn', 14)} <span>${esc(iss[0].text)}</span>` : '';
    api.setButton(1, { disabled: iss.some((i) => i.level === 'error') });
  }
  const val = (id) => api.body.querySelector(`#${id}`);
  const onv = (id, fn, ev = 'change') => { const e = val(id); if (e) e.addEventListener(ev, () => { fn(e.type === 'checkbox' ? e.checked : e.value, e); }); };

  function bind() {
    api.body.querySelectorAll('[data-sec]').forEach((b) => { b.onclick = () => { sec = b.dataset.sec; render(); }; });
    api.body.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { const [k, v] = b.dataset.tab.split(':'); tab[k] = v; render(); }; });
    // general
    onv('g-name', (v) => { d.name = v; }, 'input');
    onv('g-type', (v) => { const sub = Object.keys(OS_TREE[v])[0]; d.osKey = osKeyFromVersion(OS_TREE[v][sub][0]); render(); });
    onv('g-sub', (v) => { const t = OS_TYPES[d.osKey].type; d.osKey = osKeyFromVersion(OS_TREE[t][v][0]); render(); });
    onv('g-ver', (v) => { d.osKey = osKeyFromVersion(v); render(); });
    onv('g-clip', (v) => { d.hw.clipboard = v; });
    onv('g-dnd', (v) => { d.hw.dragdrop = v; });
    onv('g-desc', (v) => { d.description = v; }, 'input');
    onv('g-enc', (v) => { d.hw.diskEnc = v; });
    // sistema
    bindSlider('s-ram', (v) => { d.hw.ramMB = v; });
    bindSlider('s-cpu', (v) => { d.hw.cpus = v; });
    bindSlider('s-cap', (v) => { d.hw.cpuCap = v; });
    api.body.querySelectorAll('[data-boot]').forEach((r) => { r.onclick = (e) => { bootSel = Number(r.dataset.boot); if (!e.target.matches('input')) render(); }; });
    api.body.querySelectorAll('[data-bootchk]').forEach((c) => { c.onchange = () => { d.hw.boot[Number(c.dataset.bootchk)].on = c.checked; }; });
    const mv = (dir) => { const j = bootSel + dir; if (j < 0 || j >= d.hw.boot.length) return; [d.hw.boot[bootSel], d.hw.boot[j]] = [d.hw.boot[j], d.hw.boot[bootSel]]; bootSel = j; render(); };
    onv('b-up', () => mv(-1), 'click'); onv('b-down', () => mv(1), 'click');
    onv('s-chip', (v) => { d.hw.chipset = v; });
    onv('s-tpm', (v) => { d.hw.tpm = v; render(); });
    onv('s-ptr', (v) => { d.hw.pointing = v; });
    onv('s-ioapic', (v) => { d.hw.ioapic = v; });
    onv('s-utc', (v) => { d.hw.utcClock = v; });
    onv('s-efi', (v) => { d.hw.efi = v; if (!v) d.hw.secureBoot = false; render(); });
    onv('s-sb', (v) => { d.hw.secureBoot = v; });
    onv('s-pae', (v) => { d.hw.pae = v; });
    onv('s-nvt', (v) => { d.hw.nestedVt = v; });
    onv('s-pv', (v) => { d.hw.paravirt = v; });
    onv('s-np', (v) => { d.hw.nestedPaging = v; });
    // pantalla
    bindSlider('d-vram', (v) => { d.hw.vram = v; });
    bindSlider('d-mon', (v) => { d.hw.monitors = v; });
    bindSlider('d-scale', (v) => { d.hw.scale = v; });
    onv('d-gc', (v) => { d.hw.graphics = v; });
    onv('d-3d', (v) => { d.hw.accel3d = v; });
    onv('d-rdp', (v) => { d.hw.rdp = v; });
    onv('d-rec', (v) => { d.hw.recording = v; });
    // audio
    onv('a-en', (v) => { d.hw.audio.enabled = v; render(); });
    onv('a-drv', (v) => { d.hw.audio.driver = v; });
    onv('a-ctl', (v) => { d.hw.audio.controller = v; });
    onv('a-out', (v) => { d.hw.audio.out = v; });
    onv('a-in', (v) => { d.hw.audio.in = v; });
    // usb
    onv('u-en', (v) => { d.hw.usb.enabled = v; render(); });
    api.body.querySelectorAll('input[name=u-ver]').forEach((r) => { r.onchange = () => { d.hw.usb.ver = r.value; }; });
    onv('u-add', () => { const devs = ['Kingston DataTraveler 3.0 [0001]', 'Logitech USB Receiver [1211]', 'SanDisk Ultra USB 3.0 [0100]']; const b = val('u-add').getBoundingClientRect(); popupMenu(b.left, b.bottom, devs.map((x) => ({ label: x, action: () => { d.hw.usb.filters.push(x); render(); } }))); }, 'click');
    api.body.querySelectorAll('[data-ufdel]').forEach((b) => { b.onclick = () => { d.hw.usb.filters.splice(Number(b.dataset.ufdel), 1); render(); }; });
    onv('se-en', (v) => { if (Number(tab.serial) === 0) d.hw.serial[0].enabled = v; });
    onv('ui-mini', (v) => { d.hw.miniToolbar = v; });
    // red
    const n = d.nics[Number(tab.network)];
    onv('n-en', (v) => { n.enabled = v; render(); });
    onv('n-att', (v) => { n.attach = v; if (v === 'natnet' && !natNetOf(state, n.natnet) && state.natNets[0]) n.natnet = state.natNets[0].name; if (v === 'hostonly' && !hostOnlyOf(state, n.hostonly) && state.hostOnly[0]) n.hostonly = state.hostOnly[0].name; render(); });
    onv('n-name', (v) => { if (n.attach === 'bridged') n.bridged = v; if (n.attach === 'intnet') n.intnet = v.trim(); if (n.attach === 'hostonly') n.hostonly = v; if (n.attach === 'natnet') n.natnet = v; if (n.attach === 'generic') n.generic = v; refreshFooter(); }, 'input');
    onv('n-type', (v) => { n.type = v; });
    onv('n-prom', (v) => { n.promisc = v; });
    onv('n-mac', (v, e) => { const m = normMac(v); e.classList.toggle('invalid', !isValidMac(m)); if (isValidMac(m)) n.mac = m; refreshFooter(); }, 'input');
    onv('n-mac-new', () => { n.mac = vboxMac(); render(); }, 'click');
    onv('n-cable', (v) => { n.cable = v; });
    onv('n-pf', () => portForwardDialog(n, vm).then(() => render()), 'click');
    const adv = api.body.querySelector('details.adv'); if (adv) adv.ontoggle = () => { state.view.advOpen = adv.open; };
    // almacenamiento
    api.body.querySelectorAll('[data-st]').forEach((x) => { x.onclick = () => { const [c, s] = x.dataset.st.split(':').map(Number); storSel = { c, s }; render(); }; });
    onv('st-port', (v) => { d.storage[storSel.c].slots[storSel.s].port = v; });
    onv('st-live', (v) => { d.storage[storSel.c].slots[storSel.s].live = v; });
    onv('st-ssd', (v) => { d.storage[storSel.c].slots[storSel.s].ssd = v; });
    onv('st-hot', (v) => { d.storage[storSel.c].slots[storSel.s].hotplug = v; });
    onv('st-ports', (v) => { d.storage[storSel.c].portCount = Number(v); });
    onv('st-addc', () => { const b = val('st-addc').getBoundingClientRect(); popupMenu(b.left, b.bottom, [['PIIX4', 'IDE'], ['AHCI', 'SATA'], ['LsiLogic', 'SCSI'], ['NVMe', 'NVMe'], ['VirtIO', 'VirtIO']].map(([t, bus]) => ({ label: `${bus} (${t})`, action: () => { let nm = bus; let k = 1; while (d.storage.some((c) => c.name === nm)) nm = `${bus} ${++k}`; d.storage.push({ id: nm.toLowerCase(), name: nm, bus, type: t, slots: [], portCount: 2 }); render(); } }))); }, 'click');
    onv('st-addd', () => { const c = d.storage[storSel.c]; const used = new Set(c.slots.map((s) => s.port)); const ports = c.bus === 'IDE' ? ['IDE primario maestro', 'IDE primario esclavo', 'IDE secundario maestro', 'IDE secundario esclavo'] : Array.from({ length: c.portCount || 2 }, (_, i) => `Puerto ${c.bus} ${i}`); const p = ports.find((x) => !used.has(x)); if (!p) { toast('No quedan puertos libres en ese controlador.', { kind: 'warn' }); return; } c.slots.push({ port: p, kind: 'dvd', medium: null, live: false }); storSel.s = c.slots.length - 1; render(); }, 'click');
    onv('st-addh', async () => {
      const c = d.storage[storSel.c];
      const used = new Set(c.slots.map((s) => s.port));
      const ports = c.bus === 'IDE' ? ['IDE primario maestro', 'IDE primario esclavo', 'IDE secundario maestro', 'IDE secundario esclavo'] : Array.from({ length: Math.max(c.portCount || 2, 2) }, (_, i) => `Puerto ${c.bus} ${i}`);
      const p = ports.find((x) => !used.has(x));
      if (!p) { toast('No quedan puertos libres en ese controlador.', { kind: 'warn' }); return; }
      const m = await chooseDisk(vm);
      if (!m) return;
      c.slots.push({ port: p, kind: 'hdd', medium: m.id }); storSel.s = c.slots.length - 1; render();
    }, 'click');
    onv('st-rm', () => { const c = d.storage[storSel.c]; if (storSel.s >= 0) { c.slots.splice(storSel.s, 1); storSel.s = -1; } else if (c) { if (c.slots.length && !confirm('El controlador tiene dispositivos conectados. ¿Eliminarlo igualmente?')) return; d.storage.splice(storSel.c, 1); storSel = { c: 0, s: -1 }; } render(); }, 'click');
    onv('st-pick', async () => {
      const s = d.storage[storSel.c].slots[storSel.s];
      const b = val('st-pick').getBoundingClientRect();
      if (s.kind === 'dvd') {
        const recent = state.media.dvd.slice(-6);
        popupMenu(b.left, b.bottom, [
          { label: 'Elegir/crear un disco óptico virtual…', action: async () => { const m = await chooseIso(); if (m) { s.medium = m.id; render(); } } },
          { label: 'Elegir un archivo de disco…', action: async () => { const f = await filePicker({ title: 'Seleccione un archivo de disco óptico virtual', filter: 'iso' }); if (f) { s.medium = registerIso(f.name).id; render(); } } },
          '-',
          ...recent.map((m) => ({ label: m.name, icon: 'dvd', action: () => { s.medium = m.id; render(); } })),
          '-',
          { label: 'Eliminar disco de la unidad virtual', disabled: !s.medium, action: () => { s.medium = null; render(); } },
        ]);
      } else {
        const m = await chooseDisk(vm);
        if (m) { s.medium = m.id; render(); }
      }
    }, 'click');
    // carpetas compartidas
    api.body.querySelectorAll('[data-sh]').forEach((r) => { r.onclick = () => { state.view.shSel = Number(r.dataset.sh); render(); }; r.ondblclick = () => editShared(Number(r.dataset.sh)); });
    onv('sh-add', () => editShared(null), 'click');
    onv('sh-edit', () => editShared(state.view.shSel), 'click');
    onv('sh-rm', () => { d.shared.splice(state.view.shSel, 1); state.view.shSel = null; render(); }, 'click');
  }

  async function editShared(idx) {
    const s = idx == null ? { name: '', hostPath: '', readonly: false, automount: true, mountPoint: '' } : { ...d.shared[idx] };
    const res = await modal({
      title: idx == null ? 'Añadir carpeta compartida' : 'Editar carpeta compartida', iconName: 'shared', width: 480,
      html: `<div class="form-grid"><label>Ruta carpeta:</label><div style="display:flex;gap:4px"><input type="text" id="sf-path" value="${esc(s.hostPath)}" style="flex:1" placeholder="C:\\Users\\alumno\\Compartida"><button class="btn-ico" id="sf-pick" title="Elegir carpeta">${icon('folder', 18)}</button></div><label>Nombre carpeta:</label><input type="text" id="sf-name" value="${esc(s.name)}"><label></label><label class="chk"><input type="checkbox" id="sf-ro" ${s.readonly ? 'checked' : ''}> Solo lectura</label><label></label><label class="chk"><input type="checkbox" id="sf-auto" ${s.automount ? 'checked' : ''}> Automontar</label><label>Punto de montaje:</label><input type="text" id="sf-mp" value="${esc(s.mountPoint)}"></div>`,
      buttons: [{ label: 'Aceptar', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }],
      onInit: (a) => {
        a.body.querySelector('#sf-pick').onclick = async () => { const f = await filePicker({ title: 'Seleccionar carpeta', filter: 'folder' }); if (f) { a.body.querySelector('#sf-path').value = f.folder; const nm = a.body.querySelector('#sf-name'); if (!nm.value) nm.value = f.folder.split('\\').pop(); } };
        a.body.querySelector('#sf-path').oninput = (e) => { const nm = a.body.querySelector('#sf-name'); if (!nm.dataset.touched) nm.value = e.target.value.split('\\').pop(); };
        a.body.querySelector('#sf-name').oninput = (e) => { e.target.dataset.touched = '1'; };
      },
      validate: (a) => {
        const p = a.body.querySelector('#sf-path').value.trim(); const nm = a.body.querySelector('#sf-name').value.trim();
        if (!p) { a.body.querySelector('#sf-path').classList.add('invalid'); return false; }
        if (!nm || /\s/.test(nm)) { a.body.querySelector('#sf-name').classList.add('invalid'); return false; }
        Object.assign(s, { hostPath: p, name: nm, readonly: a.body.querySelector('#sf-ro').checked, automount: a.body.querySelector('#sf-auto').checked, mountPoint: a.body.querySelector('#sf-mp').value.trim() });
        return true;
      },
    });
    if (!res) return;
    if (idx == null) d.shared.push(s); else d.shared[idx] = s;
    state.hostFiles.shared ||= {};
    state.hostFiles.shared[s.hostPath] ||= [{ name: 'LEEME.txt', text: `Carpeta compartida del anfitrión (${s.hostPath}).\n` }, { name: 'apuntes-redes.pdf', text: '%PDF-1.7', size: 482113 }];
    render();
  }

  const ok = await modal({
    title: `${vm.name} - Configuración`, iconName: 'settings', width: 860, className: 'settings-dlg',
    html: '',
    buttons: [{ label: 'Ayuda', value: 'help', left: true, keepOpen: true, action: () => { import('./actions.js').then((A) => A.helpContents()); return false; } }, { label: 'Aceptar', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }],
    onInit: (a) => {
      api = a;
      const f = document.createElement('div');
      f.className = 'set-foot';
      f.style.marginRight = 'auto';
      a.el.querySelector('.dlg-btns').insertBefore(f, a.el.querySelector('.dlg-btns .btn:nth-child(2)'));
      render();
    },
  });
  if (!ok) return false;
  // aplicar
  const netChanged = JSON.stringify(vm.nics) !== JSON.stringify(d.nics);
  const before = JSON.stringify({ nics: vm.nics, hw: vm.hw, storage: vm.storage });
  if (!running) { vm.name = d.name.trim() || vm.name; vm.osKey = d.osKey; }
  vm.description = d.description;
  vm.shared = d.shared;
  if (locked) {
    // con la máquina encendida solo se aplican los cambios «en caliente»
    d.nics.forEach((n, i) => { Object.assign(vm.nics[i], { attach: n.attach, natnet: n.natnet, bridged: n.bridged, intnet: n.intnet, hostonly: n.hostonly, generic: n.generic, cable: n.cable, promisc: n.promisc, pf: n.pf }); });
    Object.assign(vm.hw, { clipboard: d.hw.clipboard, dragdrop: d.hw.dragdrop, cpuCap: d.hw.cpuCap, scale: d.hw.scale, rdp: d.hw.rdp, recording: d.hw.recording, usb: { ...vm.hw.usb, filters: d.hw.usb.filters }, audio: { ...vm.hw.audio, out: d.hw.audio.out, in: d.hw.audio.in } });
    d.storage.forEach((c, ci) => c.slots.forEach((s, si) => { if (s.kind === 'dvd' && vm.storage[ci]?.slots[si]) vm.storage[ci].slots[si].medium = s.medium; }));
    if (running && netChanged) linkChanged(state, vm);
  } else {
    vm.hw = d.hw; vm.nics = d.nics; vm.storage = d.storage;
  }
  if (netChanged) logEvent({ type: 'settings-net', vm: vm.id, nics: vm.nics.map((n) => ({ enabled: n.enabled, attach: n.attach, cable: n.cable, intnet: n.intnet, natnet: n.natnet, hostonly: n.hostonly, pf: n.pf.length })) });
  if (before !== JSON.stringify({ nics: vm.nics, hw: vm.hw, storage: vm.storage })) logEvent({ type: 'settings', vm: vm.id });
  commit();
  return true;
}

// ------------------------------------------------------------------ reenvío de puertos (NAT)
export async function portForwardDialog(nic, vm) {
  const rules = clone(nic.pf);
  let sel = null;
  const r = await modal({
    title: 'Reglas de reenvío de puertos', iconName: 'net', width: 760,
    html: '<div id="pf-wrap"></div>',
    buttons: [{ label: 'Aceptar', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }],
    onInit: (api) => {
      const draw = () => {
        api.body.querySelector('#pf-wrap').innerHTML = `<div style="display:flex;gap:8px"><div class="tblwrap" style="flex:1;min-height:200px"><table class="tbl" id="pf-t"><thead><tr><th>Nombre</th><th>Protocolo</th><th>IP anfitrión</th><th>Puerto anfitrión</th><th>IP invitado</th><th>Puerto invitado</th></tr></thead><tbody>${rules.map((x, i) => `<tr class="${sel === i ? 'sel' : ''}" data-i="${i}"><td><input value="${esc(x.name)}" data-f="name" aria-label="Nombre"></td><td><select data-f="proto" aria-label="Protocolo"><option ${x.proto === 'tcp' ? 'selected' : ''}>TCP</option><option ${x.proto === 'udp' ? 'selected' : ''}>UDP</option></select></td><td><input value="${esc(x.hostIp)}" data-f="hostIp" placeholder="" aria-label="IP anfitrión"></td><td><input value="${x.hostPort}" data-f="hostPort" aria-label="Puerto anfitrión"></td><td><input value="${esc(x.guestIp)}" data-f="guestIp" aria-label="IP invitado"></td><td><input value="${x.guestPort}" data-f="guestPort" aria-label="Puerto invitado"></td></tr>`).join('')}</tbody></table></div><div style="display:grid;gap:2px;align-content:start"><button class="btn-ico" id="pf-add" title="Añadir nueva regla de reenvío de puertos">${icon('add', 18)}</button><button class="btn-ico" id="pf-copy" title="Copiar la regla seleccionada" ${sel == null ? 'disabled' : ''}>${icon('copy', 18)}</button><button class="btn-ico" id="pf-rm" title="Eliminar la regla seleccionada" ${sel == null ? 'disabled' : ''}>${icon('remove', 18)}</button></div></div><div class="infobox" style="margin-top:10px">${icon('info', 16)}<div>Ejemplo: <b>Nombre</b> ssh · <b>Protocolo</b> TCP · <b>IP anfitrión</b> vacía (todas) · <b>Puerto anfitrión</b> 2222 · <b>IP invitado</b> vacía (10.0.2.15) · <b>Puerto invitado</b> 22. Después, desde el anfitrión: <code>ssh -p 2222 usuario@127.0.0.1</code>. Los puertos del anfitrión menores de 1024 pueden estar ocupados o requerir permisos.</div></div>`;
        api.body.querySelectorAll('#pf-t tbody tr').forEach((tr) => {
          tr.onclick = () => { if (sel !== Number(tr.dataset.i)) { sync(); sel = Number(tr.dataset.i); draw(); } };
          tr.querySelectorAll('[data-f]').forEach((inp) => { inp.onchange = sync; });
        });
        api.body.querySelector('#pf-add').onclick = () => { sync(); rules.push({ name: `Regla ${rules.length + 1}`, proto: 'tcp', hostIp: '', hostPort: '', guestIp: '', guestPort: '' }); sel = rules.length - 1; draw(); api.body.querySelector(`#pf-t tbody tr[data-i="${sel}"] input`)?.focus(); };
        api.body.querySelector('#pf-copy').onclick = () => { sync(); rules.push({ ...rules[sel], name: `${rules[sel].name} copia` }); draw(); };
        api.body.querySelector('#pf-rm').onclick = () => { sync(); rules.splice(sel, 1); sel = null; draw(); };
      };
      const sync = () => {
        api.body.querySelectorAll('#pf-t tbody tr').forEach((tr) => { const x = rules[Number(tr.dataset.i)]; tr.querySelectorAll('[data-f]').forEach((inp) => { const f = inp.dataset.f; x[f] = f === 'proto' ? inp.value.toLowerCase() : /Port$/.test(f) ? (inp.value.trim() === '' ? '' : Number(inp.value)) : inp.value.trim(); }); });
      };
      api.sync = sync;
      draw();
    },
    validate: (api) => {
      api.sync();
      for (const x of rules) {
        if (!x.name || !(x.hostPort > 0 && x.hostPort < 65536) || !(x.guestPort > 0 && x.guestPort < 65536)) { msgBox({ kind: 'error', title: 'VirtualBox - Error', text: `<p>La regla <b>${esc(x.name || '(sin nombre)')}</b> no es válida: los puertos deben estar entre 1 y 65535.</p>` }); return false; }
      }
      const names = rules.map((x) => x.name);
      if (new Set(names).size !== names.length) { msgBox({ kind: 'error', text: '<p>Hay reglas con el mismo nombre.</p>' }); return false; }
      return true;
    },
  });
  if (r) {
    nic.pf = rules.map((x) => ({ ...x, hostPort: Number(x.hostPort), guestPort: Number(x.guestPort) }));
    if (vm) logEvent({ type: 'pf-set', vm: vm.id, rules: nic.pf });
  }
  return r;
}

// Selector de disco duro (como el de VirtualBox)
export async function chooseDisk(vm) {
  let pick = null;
  const r = await modal({
    title: `${vm.name} - Selector de disco duro`, iconName: 'hdd', width: 620,
    html: '<div id="dsel"></div>',
    buttons: [{ label: 'Seleccionar', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }],
    onInit: (api) => {
      const draw = () => {
        const att = state.media.hdd.filter((m) => mediumUsers(m.id).length);
        const free = state.media.hdd.filter((m) => !mediumUsers(m.id).length);
        api.body.querySelector('#dsel').innerHTML = `<div class="toolbar small" style="border:0;padding:0 0 6px"><button class="tbtn" id="ds-create">${icon('create', 16)}Crear</button><button class="tbtn" id="ds-refresh">${icon('refresh', 16)}Refrescar</button></div><div class="tblwrap" style="max-height:280px"><table class="tbl"><thead><tr><th>Nombre</th><th>Tamaño virtual</th><th>Tamaño real</th></tr></thead><tbody><tr><td colspan="3" style="font-weight:600">No conectados</td></tr>${free.map((m) => `<tr data-d="${m.id}" class="${pick === m.id ? 'sel' : ''}"><td style="padding-left:18px">${icon('hdd', 14)} ${esc(m.name)}${m.content ? ` <span class="pill">${esc(OS_TYPES[m.content.os].label)}</span>` : ''}</td><td>${fmtGB(m.sizeGB)}</td><td>${fmtGB(m.usedGB)}</td></tr>`).join('') || '<tr><td colspan="3" class="hint" style="padding-left:18px">Ninguno</td></tr>'}<tr><td colspan="3" style="font-weight:600">Conectados</td></tr>${att.map((m) => `<tr data-d="${m.id}" class="${pick === m.id ? 'sel' : ''}"><td style="padding-left:18px">${icon('hdd', 14)} ${esc(m.name)} <span class="hint">(${esc(mediumUsers(m.id).map((v) => v.name).join(', '))})</span></td><td>${fmtGB(m.sizeGB)}</td><td>${fmtGB(m.usedGB)}</td></tr>`).join('')}</tbody></table></div>`;
        api.body.querySelectorAll('[data-d]').forEach((tr) => { tr.onclick = () => { pick = tr.dataset.d; draw(); }; tr.ondblclick = () => { pick = tr.dataset.d; api.buttons[0].click(); }; });
        api.body.querySelector('#ds-create').onclick = async () => { const m = await newDiskDialog({ name: vm.name, folder: vm.folder }); if (m) { pick = m.id; draw(); } };
        api.body.querySelector('#ds-refresh').onclick = draw;
      };
      draw();
    },
    validate: () => !!pick,
  });
  return r ? getMedium(pick) : null;
}

export async function chooseIso() {
  let pick = null;
  const r = await modal({
    title: 'Selector de disco óptico', iconName: 'dvd', width: 600,
    html: '<div id="isel"></div>',
    buttons: [{ label: 'Seleccionar', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }],
    onInit: (api) => {
      const draw = () => {
        api.body.querySelector('#isel').innerHTML = `<div class="toolbar small" style="border:0;padding:0 0 6px"><button class="tbtn" id="is-add">${icon('add', 16)}Añadir</button></div><div class="tblwrap" style="max-height:280px"><table class="tbl"><thead><tr><th>Nombre</th><th>Tamaño</th></tr></thead><tbody>${state.media.dvd.map((m) => `<tr data-d="${m.id}" class="${pick === m.id ? 'sel' : ''}"><td>${icon('dvd', 14)} ${esc(m.name)}</td><td>${fmtGB(m.sizeMB / 1024)}</td></tr>`).join('')}</tbody></table></div>`;
        api.body.querySelectorAll('[data-d]').forEach((tr) => { tr.onclick = () => { pick = tr.dataset.d; draw(); }; tr.ondblclick = () => { pick = tr.dataset.d; api.buttons[0].click(); }; });
        api.body.querySelector('#is-add').onclick = async () => { const f = await filePicker({ title: 'Seleccione un archivo de disco óptico virtual', filter: 'iso' }); if (f) { pick = registerIso(f.name).id; draw(); } };
      };
      draw();
    },
    validate: () => !!pick,
  });
  return r ? getMedium(pick) : null;
}

export { macColon };
