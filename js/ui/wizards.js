// Asistentes: crear máquina, crear disco, clonar, exportar e importar servicios virtualizados,
// y un selector de archivos del anfitrión simulado.
import { state, commit, getMedium, newMedium, uniqueVmName, allSlots } from '../store.js';
import { OS_TYPES, OS_TREE, ISOS, ISO_DIR, osKeyFromVersion, detectIsoOs } from '../catalog.js';
import { esc, fmtGB, fmtMB } from '../util.js';
import { icon, osIcon } from './icons.js';
import { modal, msgBox, toast } from './wm.js';
import { createVmFromWizard, cloneVm, exportOva, importOva } from '../vmctl.js';

// ------------------------------------------------------------------ selector de archivos
const FOLDERS = () => ({
  'Descargas\\ISO': { path: ISO_DIR, files: ISOS.map((i) => ({ name: i.file, size: `${(i.sizeMB / 1024).toFixed(2).replace('.', ',')} GB`, kind: 'iso' })) },
  'Documentos': { path: 'C:\\Users\\alumno\\Documents', files: state.hostFiles.ova.map((o) => ({ name: o.file, size: `${o.sizeMB} MB`, kind: 'ova', data: o })) },
  'VirtualBox VMs': { path: state.prefs.machineFolder, files: [] },
  'Escritorio': { path: 'C:\\Users\\alumno\\Desktop', files: [] },
  'Compartida': { path: 'C:\\Users\\alumno\\Compartida', files: [] },
});

export async function filePicker({ title = 'Abrir', filter = 'iso', items = null }) {
  const folders = FOLDERS();
  let cur = filter === 'ova' ? 'Documentos' : filter === 'vbox' || filter === 'folder' ? 'VirtualBox VMs' : 'Descargas\\ISO';
  let pick = null;
  const listFor = (f) => {
    if (filter === 'vbox') return f === 'VirtualBox VMs' ? (items || []) : [];
    if (filter === 'folder') return [];
    return folders[f].files.filter((x) => x.kind === filter);
  };
  const r = await modal({
    title, iconName: 'explorer', width: 680,
    html: '<div id="fp"></div>',
    buttons: [{ label: filter === 'folder' ? 'Seleccionar carpeta' : 'Abrir', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }],
    onInit: (api) => {
      const draw = () => {
        const list = listFor(cur);
        api.body.querySelector('#fp').innerHTML = `<div class="fexp-path">${esc(folders[cur].path)}</div><div class="fexp"><div class="fexp-nav">${Object.keys(folders).map((f) => `<button class="${f === cur ? 'on' : ''}" data-f="${esc(f)}">${icon('folder', 16)} ${esc(f)}</button>`).join('')}</div><div class="fexp-list"><table class="tbl"><thead><tr><th>Nombre</th><th>Tamaño</th></tr></thead><tbody>${list.map((x, i) => `<tr data-i="${i}" class="${pick === x ? 'sel' : ''}"><td>${icon(x.kind === 'iso' ? 'dvd' : x.kind === 'ova' ? 'export' : 'vbox', 16)} ${esc(x.name)}</td><td>${esc(x.size || '')}</td></tr>`).join('') || `<tr><td colspan="2" class="hint">${filter === 'folder' ? 'Pulse «Seleccionar carpeta» para usar esta carpeta.' : filter === 'vbox' ? 'No hay máquinas sin registrar en esta carpeta (use «Quitar solo» al eliminar una máquina para que aparezca aquí).' : 'Esta carpeta está vacía.'}</td></tr>`}</tbody></table></div></div><div style="margin-top:8px;display:flex;gap:8px;align-items:center"><span>Tipo:</span><select disabled><option>${{ iso: 'Archivos de disco óptico (*.iso *.dmg *.cdr)', ova: 'Open Virtualization Format (*.ova *.ovf)', vbox: 'Máquinas virtuales (*.vbox)', folder: 'Carpetas' }[filter]}</option></select></div>`;
        api.body.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { cur = b.dataset.f; pick = null; draw(); }; });
        api.body.querySelectorAll('[data-i]').forEach((tr) => { tr.onclick = () => { pick = list[Number(tr.dataset.i)]; draw(); }; tr.ondblclick = () => { pick = list[Number(tr.dataset.i)]; api.buttons[0].click(); }; });
      };
      draw();
    },
    validate: () => filter === 'folder' || !!pick,
  });
  if (!r) return null;
  if (filter === 'folder') return { folder: folders[cur].path };
  return { ...pick, folder: folders[cur].path };
}

// ------------------------------------------------------------------ crear disco
export async function newDiskDialog({ name = 'NewVirtualDisk', folder = state.prefs.machineFolder, sizeGB = 25 } = {}) {
  let fmt = 'VDI'; let pre = false; let size = sizeGB; let nm = name;
  const r = await modal({
    title: 'Crear un disco duro virtual', iconName: 'create', width: 560,
    html: `<div class="wizard"><div class="grp"><div class="grp-t">Ubicación y tamaño del archivo de disco duro</div><div class="form-grid"><label>Nombre:</label><input type="text" id="nd-name" value="${esc(nm)}"><label>Tamaño:</label><div class="slider-row"><input type="range" id="nd-size" min="4" max="2048" value="${size}"><span><input type="number" id="nd-size-n" min="4" max="2048" value="${size}" style="width:70px"> GB</span></div></div></div>
    <div class="grp"><div class="grp-t">Tipo de archivo de disco duro</div><div class="radio-col"><label class="chk"><input type="radio" name="nd-f" value="VDI" checked> VDI (VirtualBox Disk Image)</label><label class="chk"><input type="radio" name="nd-f" value="VHD"> VHD (Virtual Hard Disk)</label><label class="chk"><input type="radio" name="nd-f" value="VMDK"> VMDK (Virtual Machine Disk)</label></div></div>
    <div class="grp"><div class="grp-t">Almacenamiento en unidad de disco duro física</div><label class="chk"><input type="checkbox" id="nd-pre"> Reservar completamente</label><p class="hint" style="margin:6px 0 0">Sin reservar, el archivo crece a medida que se escribe (reservado dinámicamente). Reservado completamente ocupa todo el tamaño desde el principio, pero es algo más rápido.</p></div></div>`,
    buttons: [{ label: 'Terminar', value: true, primary: true }, { label: 'Cancelar', value: false, cancel: true }],
    onInit: (api) => {
      const b = api.body;
      b.querySelector('#nd-size').oninput = (e) => { b.querySelector('#nd-size-n').value = e.target.value; };
      b.querySelector('#nd-size-n').oninput = (e) => { b.querySelector('#nd-size').value = e.target.value; };
    },
    validate: (api) => {
      const b = api.body;
      nm = b.querySelector('#nd-name').value.trim(); size = Number(b.querySelector('#nd-size-n').value); fmt = b.querySelector('input[name=nd-f]:checked').value; pre = b.querySelector('#nd-pre').checked;
      if (!nm) { b.querySelector('#nd-name').classList.add('invalid'); return false; }
      const ext = `.${fmt.toLowerCase()}`;
      if (state.media.hdd.some((m) => m.name.toLowerCase() === (nm.endsWith(ext) ? nm : nm + ext).toLowerCase())) { msgBox({ kind: 'error', text: `<p>Ya existe un disco llamado <b>${esc(nm + ext)}</b>.</p>` }); return false; }
      return size >= 4;
    },
  });
  if (!r) return null;
  const ext = `.${fmt.toLowerCase()}`;
  const file = nm.endsWith(ext) ? nm : nm + ext;
  const m = newMedium('hdd', { name: file, path: `${folder}\\${file}`, format: fmt, variant: pre ? 'fixed' : 'dynamic', sizeGB: size, usedGB: pre ? size : 0.002, type: 'normal', content: null, parent: null });
  state.media.hdd.push(m);
  commit();
  return m;
}

// ------------------------------------------------------------------ nueva máquina
export async function newVmWizard() {
  const o = { name: '', folder: state.prefs.machineFolder, iso: '', osKey: 'ubuntu', skipUnattended: false, user: 'vboxuser', pass: 'changeme', pass2: 'changeme', hostname: '', domain: 'myguest.virtualbox.org', ga: false, ramMB: 2048, cpus: 2, efi: false, disk: 'new', diskGB: 25, prealloc: false, existing: null };
  let step = 0;
  let expert = false;
  let osTouched = false;
  const isoOs = () => detectIsoOs(o.iso);
  const unattended = () => !!o.iso && !o.skipUnattended && isoOs() && isoOs() !== 'ga';
  const steps = () => (unattended() ? ['name', 'unattended', 'hw', 'disk', 'summary'] : ['name', 'hw', 'disk', 'summary']);
  let api;
  const hostRam = state.host.ramMB;

  const pageName = () => {
    const os = OS_TYPES[o.osKey];
    const t = os.type; const subs = Object.keys(OS_TREE[t] || OS_TREE.Other); const vers = OS_TREE[t]?.[os.subtype] || [os.version];
    const det = isoOs();
    return `<h3>Nombre y sistema operativo de la máquina virtual</h3><p class="lead">Elija un nombre descriptivo y una carpeta de destino para la nueva máquina virtual. El nombre que escoja se usará en VirtualBox para identificarla. Además, puede seleccionar una imagen ISO que podrá usarse para instalar el sistema operativo invitado.</p>
    <div class="form-grid"><label for="w-name">Nombre:</label><input type="text" id="w-name" value="${esc(o.name)}" autofocus>
    <label for="w-folder">Carpeta:</label><input type="text" id="w-folder" value="${esc(o.folder)}">
    <label for="w-iso">Imagen ISO:</label><div style="display:flex;gap:4px"><select id="w-iso" style="flex:1"><option value="">&lt;no seleccionado&gt;</option>${ISOS.filter((i) => i.os !== 'ga').map((i) => `<option ${o.iso === i.file ? 'selected' : ''}>${esc(i.file)}</option>`).join('')}</select><button class="btn-ico" id="w-iso-pick" title="Elegir un archivo de imagen ISO">${icon('folder', 18)}</button></div>
    <label>Edición:</label><select disabled><option>${esc(ISOS.find((i) => i.file === o.iso)?.edition || '')}</option></select>
    <label for="w-type">Tipo:</label><select id="w-type" ${det ? 'disabled' : ''}>${Object.keys(OS_TREE).map((x) => `<option ${x === t ? 'selected' : ''}>${x}</option>`).join('')}</select>
    <label for="w-sub">Subtipo:</label><select id="w-sub" ${det ? 'disabled' : ''}>${subs.map((x) => `<option ${x === os.subtype ? 'selected' : ''}>${x}</option>`).join('')}</select>
    <label for="w-ver">Versión:</label><div style="display:flex;gap:8px;align-items:center"><select id="w-ver" style="flex:1" ${det ? 'disabled' : ''}>${vers.map((x) => `<option ${x === os.version ? 'selected' : ''}>${x}</option>`).join('')}</select>${osIcon(o.osKey, 30)}</div>
    <label></label><label class="chk"><input type="checkbox" id="w-skip" ${o.skipUnattended ? 'checked' : ''} ${o.iso && det ? '' : 'disabled'}> Omitir instalación desatendida</label>
    <label></label><div class="${det ? 'infobox' : 'hint'}" style="margin:0">${det ? `${icon('info', 16)}<div>Se ha detectado el tipo de sistema operativo: <b>${esc(OS_TYPES[det].label)}</b>. ${o.skipUnattended ? 'La imagen se montará en la unidad óptica y tendrá que instalar el sistema a mano al iniciar la máquina.' : 'Este sistema operativo se instalará de forma desatendida cuando se inicie la máquina virtual.'}</div>` : o.iso ? 'No se ha podido detectar el sistema operativo de la imagen.' : 'Sin imagen ISO, la máquina se crea con el disco vacío: podrá montar una ISO más tarde en Configuración › Almacenamiento.'}</div></div>`;
  };
  const pageUnattended = () => `<h3>Configurar la instalación desatendida del sistema operativo invitado</h3><p class="lead">Puede configurar la instalación desatendida del sistema operativo invitado modificando el nombre de usuario, la contraseña y el nombre de host. También puede indicar si se deben instalar las Guest Additions.</p>
    <div class="grp"><div class="grp-t">Nombre de usuario y contraseña</div><div class="form-grid"><label for="w-user">Nombre de usuario:</label><input type="text" id="w-user" value="${esc(o.user)}"><label for="w-pass">Contraseña:</label><input type="password" id="w-pass" value="${esc(o.pass)}"><label for="w-pass2">Repetir contraseña:</label><input type="password" id="w-pass2" value="${esc(o.pass2)}"></div></div>
    <div class="grp"><div class="grp-t">Opciones adicionales</div><div class="form-grid"><label for="w-host">Nombre de host:</label><input type="text" id="w-host" value="${esc(o.hostname || o.name.replace(/[^A-Za-z0-9-]/g, '') || 'vm')}"><label for="w-dom">Nombre de dominio:</label><input type="text" id="w-dom" value="${esc(o.domain)}"><label></label><label class="chk"><input type="checkbox" disabled> Instalar en segundo plano</label></div></div>
    <div class="grp"><div class="grp-t">Guest Additions</div><label class="chk"><input type="checkbox" id="w-ga" ${o.ga ? 'checked' : ''}> Instalar Guest Additions</label><div class="form-grid" style="margin-top:6px"><label>ISO de Guest Additions:</label><select disabled><option>${ISO_DIR.replace('Downloads\\ISO', '')}…\\VBoxGuestAdditions.iso</option></select></div></div>
    ${o.user === 'vboxuser' && o.pass === 'changeme' ? `<div class="warnbox">${icon('warn', 16)}<div>Está usando las credenciales por defecto de VirtualBox (vboxuser / changeme). Apúntelas o cámbielas: las necesitará para iniciar sesión.</div></div>` : ''}`;
  const pageHw = () => {
    const os = OS_TYPES[o.osKey];
    return `<h3>Hardware</h3><p class="lead">Puede modificar la cantidad de memoria (RAM) y de procesadores virtuales de la máquina virtual. Si desea habilitar EFI, también puede hacerlo aquí.</p>
    <div class="form-grid"><label for="w-ram">Memoria base:</label><div><div class="slider-row"><input type="range" id="w-ram" min="4" max="${hostRam}" step="4" value="${o.ramMB}"><span><input type="number" id="w-ram-n" value="${o.ramMB}" style="width:76px"> MB</span></div><div class="range-zones" style="--g:${50}%;--y:${75}%"></div><div class="slider-scale"><span>4 MB</span><span>${hostRam} MB</span></div></div>
    <label for="w-cpu">Procesadores:</label><div><div class="slider-row"><input type="range" id="w-cpu" min="1" max="${state.host.cpus * 2}" value="${o.cpus}"><span><input type="number" id="w-cpu-n" value="${o.cpus}" style="width:76px"> CPU</span></div><div class="range-zones" style="--g:${50 - 6}%;--y:${50}%"></div><div class="slider-scale"><span>1 CPU</span><span>${state.host.cpus * 2} CPU</span></div></div>
    <label></label><label class="chk"><input type="checkbox" id="w-efi" ${o.efi || os.needsEfi ? 'checked' : ''}> Habilitar EFI (solo SO especiales)</label>
    <label></label><p class="hint" style="margin:0">Recomendado para ${esc(os.version)}: ${os.recRam} MB y ${os.recCpu} CPU. El anfitrión tiene ${hostRam} MB y ${state.host.cpus} núcleos: la zona roja deja al anfitrión sin recursos.${os.needsTpm ? ' Windows 11 necesita además EFI, TPM 2.0 y arranque seguro (VirtualBox los activa al elegir ese tipo).' : ''}</p></div>`;
  };
  const pageDisk = () => {
    const free = state.media.hdd.filter((m) => !state.vms.some((v) => allSlots(v).some((x) => x.slot.medium === m.id)));
    return `<h3>Disco duro virtual</h3><p class="lead">Si lo desea puede añadir un disco duro virtual a la nueva máquina. Puede crear un nuevo archivo de disco duro o seleccionar uno existente. Si necesita una configuración de almacenamiento más compleja puede omitir este paso y hacer los cambios en la configuración de la máquina una vez creada.</p>
    <div class="radio-col"><label class="chk"><input type="radio" name="w-disk" value="new" ${o.disk === 'new' ? 'checked' : ''}> Crear un disco duro virtual ahora</label>
    <div style="margin-left:24px" class="form-grid"><label>Tamaño del disco:</label><div class="slider-row"><input type="range" id="w-dsz" min="4" max="2048" value="${o.diskGB}" ${o.disk !== 'new' ? 'disabled' : ''}><span><input type="number" id="w-dsz-n" value="${o.diskGB}" style="width:76px" ${o.disk !== 'new' ? 'disabled' : ''}> GB</span></div><label></label><label class="chk"><input type="checkbox" id="w-pre" ${o.prealloc ? 'checked' : ''} ${o.disk !== 'new' ? 'disabled' : ''}> Reservar completamente</label></div>
    <label class="chk"><input type="radio" name="w-disk" value="existing" ${o.disk === 'existing' ? 'checked' : ''} ${free.length ? '' : 'disabled'}> Usar un archivo de disco duro virtual existente</label>
    <div style="margin-left:24px"><select id="w-exist" ${o.disk !== 'existing' ? 'disabled' : ''} style="width:100%">${free.map((m) => `<option value="${m.id}" ${o.existing === m.id ? 'selected' : ''}>${esc(m.name)} (${fmtGB(m.sizeGB)}${m.content ? `, ${esc(OS_TYPES[m.content.os].label)}` : ', vacío'})</option>`).join('') || '<option>No hay discos libres</option>'}</select></div>
    <label class="chk"><input type="radio" name="w-disk" value="none" ${o.disk === 'none' ? 'checked' : ''}> No añadir un disco duro virtual</label></div>
    ${o.disk === 'none' ? `<div class="warnbox" style="margin-top:10px">${icon('warn', 16)}<div>Sin disco duro la máquina no podrá instalar ni arrancar ningún sistema (salvo un live CD).</div></div>` : ''}`;
  };
  const pageSummary = () => {
    const rows = [['Nombre y tipo de SO', ''], ['Nombre de la máquina', o.name], ['Carpeta de la máquina', `${o.folder}\\${o.name}`], ['Imagen ISO', o.iso || '—'], ['Tipo de SO', OS_TYPES[o.osKey].version], ['Instalación desatendida', unattended() ? 'Habilitada' : 'Deshabilitada']];
    if (unattended()) rows.push(['Nombre de usuario', o.user], ['Nombre de host', o.hostname || o.name], ['Instalar Guest Additions', o.ga ? 'Sí' : 'No']);
    rows.push(['Hardware', ''], ['Memoria base', `${o.ramMB} MB`], ['Procesadores', String(o.cpus)], ['Habilitar EFI', o.efi || OS_TYPES[o.osKey].needsEfi ? 'Sí' : 'No'], ['Disco', ''], ...(o.disk === 'new' ? [['Ruta del disco', `${o.folder}\\${o.name}\\${o.name}.vdi`], ['Tamaño del disco', `${o.diskGB} GB`], ['Reservar tamaño completo', o.prealloc ? 'Sí' : 'No']] : o.disk === 'existing' ? [['Disco existente', getMedium(o.existing)?.name || '']] : [['Disco', 'Ninguno']]));
    return `<h3>Resumen</h3><p class="lead">A continuación se muestra un resumen de la configuración de la nueva máquina. Pulse «Terminar» para crearla o «Atrás» para modificarla.</p><div class="tblwrap"><table class="tbl sum">${rows.map(([k, v]) => (v === '' ? `<tr><td colspan="2" style="font-weight:600;background:var(--panel-2)">${esc(k)}</td></tr>` : `<tr><td style="padding-left:16px">${esc(k)}</td><td>${esc(v)}</td></tr>`)).join('')}</table></div>`;
  };

  const collect = () => {
    const b = api.body; const g = (id) => b.querySelector(`#${id}`);
    if (g('w-name')) { o.name = g('w-name').value.trim(); o.folder = g('w-folder').value.trim(); o.skipUnattended = g('w-skip').checked; }
    if (g('w-user')) { o.user = g('w-user').value.trim(); o.pass = g('w-pass').value; o.pass2 = g('w-pass2').value; o.hostname = g('w-host').value.trim(); o.domain = g('w-dom').value.trim(); o.ga = g('w-ga').checked; }
    if (g('w-ram')) { o.ramMB = Number(g('w-ram-n').value); o.cpus = Number(g('w-cpu-n').value); o.efi = g('w-efi').checked; }
    if (b.querySelector('input[name=w-disk]')) { o.disk = b.querySelector('input[name=w-disk]:checked').value; if (g('w-dsz-n')) o.diskGB = Number(g('w-dsz-n').value); o.prealloc = !!g('w-pre')?.checked; o.existing = g('w-exist')?.value || null; }
  };
  const validStep = () => {
    const s = steps()[step];
    if (s === 'name') {
      if (!o.name) return 'Escriba un nombre para la máquina virtual.';
      if (state.vms.some((v) => v.name.toLowerCase() === o.name.toLowerCase())) return `Ya existe una máquina virtual llamada «${o.name}».`;
      if (/[\\/:*?"<>|]/.test(o.name)) return 'El nombre contiene caracteres no válidos.';
    }
    if (s === 'unattended') {
      if (!o.user) return 'El nombre de usuario no puede estar vacío.';
      if (o.pass !== o.pass2) return 'Las contraseñas no coinciden.';
      if (!o.pass) return 'La contraseña no puede estar vacía.';
      if (!/^[A-Za-z0-9-]{2,}$/.test(o.hostname || 'x1')) return 'El nombre de host solo puede contener letras, números y guiones.';
    }
    if (s === 'hw' && o.cpus > state.host.cpus) return `No se pueden asignar más de ${state.host.cpus} CPU (núcleos del anfitrión).`;
    return null;
  };

  const draw = () => {
    const s = steps()[step];
    const html = expert ? `${pageName()}<hr>${unattended() ? pageUnattended() + '<hr>' : ''}${pageHw()}<hr>${pageDisk()}` : { name: pageName, unattended: pageUnattended, hw: pageHw, disk: pageDisk, summary: pageSummary }[s]();
    api.body.innerHTML = `<div class="wizard" style="min-height:430px">${html}<div class="errbox" id="w-err" style="display:none;margin-top:10px"></div></div>`;
    const last = expert || step === steps().length - 1;
    api.setButton(1, { label: expert ? 'Modo guiado' : 'Modo experto' });
    api.setButton(2, { disabled: expert || step === 0 });
    api.setButton(3, { label: last ? 'Terminar' : 'Siguiente' });
    bind();
  };
  const bind = () => {
    const b = api.body; const g = (id) => b.querySelector(`#${id}`);
    const pair = (a, n) => { if (!g(a)) return; g(a).oninput = () => { g(n).value = g(a).value; }; g(n).oninput = () => { g(a).value = g(n).value; }; };
    pair('w-ram', 'w-ram-n'); pair('w-cpu', 'w-cpu-n'); pair('w-dsz', 'w-dsz-n');
    if (g('w-name')) g('w-name').oninput = () => {
      const v = g('w-name').value.toLowerCase();
      if (!isoOs() && !osTouched) {
        const guess = /ubuntu/.test(v) ? 'ubuntu' : /kali/.test(v) ? 'kali' : /debian/.test(v) ? 'debian' : /win.*11|w11/.test(v) ? 'win11' : /server|2022/.test(v) ? 'ws2022' : /win|w10/.test(v) ? 'win10' : null;
        if (guess && guess !== o.osKey) { collect(); o.osKey = guess; const os = OS_TYPES[guess]; o.ramMB = os.recRam; o.cpus = os.recCpu; o.diskGB = os.recDisk; const pos = g('w-name').selectionStart; draw(); g('w-name').focus(); g('w-name').setSelectionRange(pos, pos); }
      }
    };
    if (g('w-iso')) g('w-iso').onchange = () => { collect(); o.iso = g('w-iso').value; const d = isoOs(); if (d) { o.osKey = d; const os = OS_TYPES[d]; o.ramMB = os.recRam; o.cpus = os.recCpu; o.diskGB = os.recDisk; o.efi = !!os.needsEfi; } draw(); };
    if (g('w-iso-pick')) g('w-iso-pick').onclick = async () => { collect(); const f = await filePicker({ title: 'Seleccione un archivo de imagen ISO', filter: 'iso' }); if (f) { o.iso = f.name; const d = isoOs(); if (d && d !== 'ga') { o.osKey = d; const os = OS_TYPES[d]; o.ramMB = os.recRam; o.cpus = os.recCpu; o.diskGB = os.recDisk; o.efi = !!os.needsEfi; } draw(); } };
    if (g('w-skip')) g('w-skip').onchange = () => { collect(); draw(); };
    const setOs = (k) => { collect(); osTouched = true; o.osKey = k; const os = OS_TYPES[k]; o.ramMB = os.recRam; o.cpus = os.recCpu; o.diskGB = os.recDisk; o.efi = !!os.needsEfi; draw(); };
    if (g('w-type')) g('w-type').onchange = () => { const t = g('w-type').value; const sub = Object.keys(OS_TREE[t])[0]; setOs(osKeyFromVersion(OS_TREE[t][sub][0])); };
    if (g('w-sub')) g('w-sub').onchange = () => { const t = g('w-type').value; setOs(osKeyFromVersion(OS_TREE[t][g('w-sub').value][0])); };
    if (g('w-ver')) g('w-ver').onchange = () => setOs(osKeyFromVersion(g('w-ver').value));
    b.querySelectorAll('input[name=w-disk]').forEach((r) => { r.onchange = () => { collect(); draw(); }; });
  };
  const showErr = (t) => { const e = api.body.querySelector('#w-err'); e.style.display = 'flex'; e.innerHTML = `${icon('error', 16)}<div>${esc(t)}</div>`; };

  const result = await modal({
    title: 'Crear máquina virtual', iconName: 'new', width: 720,
    html: '',
    buttons: [
      { label: 'Ayuda', left: true, keepOpen: true, action: () => { import('./actions.js').then((A) => A.helpContents()); return false; } },
      { label: 'Modo experto', keepOpen: true, action: () => { collect(); expert = !expert; draw(); return false; } },
      { label: 'Atrás', keepOpen: true, action: () => { collect(); step = Math.max(0, step - 1); draw(); return false; } },
      { label: 'Siguiente', value: 'next', primary: true, action: () => {
        collect();
        if (expert) {
          for (step = 0; step < steps().length - 1; step++) { const e = validStep(); if (e) { draw(); showErr(e); return false; } }
          return true;
        }
        const e = validStep();
        if (e) { showErr(e); return false; }
        if (step < steps().length - 1) { step++; draw(); return false; }
        return true;
      } },
      { label: 'Cancelar', value: null, cancel: true },
    ],
    onInit: (a) => { api = a; draw(); },
  });
  if (result !== 'next') return null;
  const vm = createVmFromWizard({ ...o, hostname: o.hostname || o.name.replace(/[^A-Za-z0-9-]/g, '').toLowerCase() || 'vm', unattended: unattended() });
  toast(`Máquina virtual «${esc(vm.name)}» creada.${unattended() ? ' Al iniciarla se instalará el sistema de forma desatendida.' : ''}`, { kind: 'ok' });
  return vm;
}

// ------------------------------------------------------------------ clonar
export async function cloneWizard(vm, snapId = null) {
  if (!vm) return;
  if (vm.state === 'running' || vm.state === 'paused') { await msgBox({ kind: 'warn', text: '<p>Apague la máquina (o guarde su estado) antes de clonarla.</p>' }); return; }
  const o = { name: uniqueVmName(`${vm.name} Clon`), folder: state.prefs.machineFolder, mac: 'nat', keepNames: false, keepUuids: false, type: 'full', snaps: 'current' };
  let step = 0;
  let api;
  const draw = () => {
    const p0 = `<h3>Nuevo nombre de máquina y ruta</h3><p class="lead">Elija un nombre y, opcionalmente, una carpeta para la nueva máquina virtual. La nueva máquina será un clon de <b>${esc(vm.name)}</b>.</p>
    <div class="form-grid"><label for="c-name">Nombre:</label><input type="text" id="c-name" value="${esc(o.name)}" autofocus><label for="c-path">Ruta:</label><input type="text" id="c-path" value="${esc(o.folder)}">
    <label for="c-mac">Política de dirección MAC:</label><select id="c-mac"><option value="nat" ${o.mac === 'nat' ? 'selected' : ''}>Incluir solo direcciones MAC de la tarjeta de red NAT</option><option value="all" ${o.mac === 'all' ? 'selected' : ''}>Incluir todas las direcciones MAC de la tarjeta de red</option><option value="new" ${o.mac === 'new' ? 'selected' : ''}>Generar nuevas direcciones MAC para todas las tarjetas de red</option></select>
    <label>Opciones adicionales:</label><div class="radio-col"><label class="chk"><input type="checkbox" id="c-kn" ${o.keepNames ? 'checked' : ''}> Mantener nombres de las unidades de disco</label><label class="chk"><input type="checkbox" id="c-ku" ${o.keepUuids ? 'checked' : ''}> Mantener UUID de hardware</label></div>
    <label></label><p class="hint" style="margin:0">${o.mac === 'all' ? '⚠ Si el original y el clon se conectan a la misma red (puente, red interna, solo anfitrión, Red NAT), tendrán la misma MAC: los servidores DHCP les darán la misma IP y habrá conflictos.' : 'Las tarjetas en modo NAT pueden conservar la MAC sin problema porque cada VM tiene su propia red NAT aislada.'}</p></div>`;
    const p1 = `<h3>Tipo de clonación</h3><p class="lead">Elija el tipo de clon que desea crear.</p><div class="radio-col"><label class="chk"><input type="radio" name="c-type" value="full" ${o.type === 'full' ? 'checked' : ''}> <b>Clonación completa</b></label><p class="hint" style="margin:0 0 6px 24px">Copia exacta e independiente de todos los discos de la máquina original.</p><label class="chk"><input type="radio" name="c-type" value="linked" ${o.type === 'linked' ? 'checked' : ''}> <b>Clonación enlazada</b></label><p class="hint" style="margin:0 0 6px 24px">Se crea un disco diferencial que depende de los discos originales: ocupa muy poco, pero si se borra o daña el original el clon deja de funcionar. Se tomará una instantánea nueva en la máquina original.</p></div>${vm.snapshots.length && o.type === 'full' ? `<div class="grp" style="margin-top:10px"><div class="grp-t">Instantáneas</div><div class="radio-col"><label class="chk"><input type="radio" name="c-snap" value="current" checked> Estado actual de la máquina</label><label class="chk"><input type="radio" name="c-snap" value="all"> Todo</label></div></div>` : ''}`;
    api.body.innerHTML = `<div class="wizard" style="min-height:300px">${step === 0 ? p0 : p1}<div class="errbox" id="c-err" style="display:none;margin-top:10px"></div></div>`;
    api.setButton(1, { disabled: step === 0 });
    api.setButton(2, { label: step === 1 ? 'Terminar' : 'Siguiente' });
    const g = (id) => api.body.querySelector(`#${id}`);
    if (g('c-mac')) g('c-mac').onchange = () => { collect(); draw(); };
    api.body.querySelectorAll('input[name=c-type]').forEach((r) => { r.onchange = () => { collect(); draw(); }; });
  };
  const collect = () => {
    const g = (id) => api.body.querySelector(`#${id}`);
    if (g('c-name')) { o.name = g('c-name').value.trim(); o.folder = g('c-path').value.trim(); o.mac = g('c-mac').value; o.keepNames = g('c-kn').checked; o.keepUuids = g('c-ku').checked; }
    const t = api.body.querySelector('input[name=c-type]:checked'); if (t) o.type = t.value;
    const s = api.body.querySelector('input[name=c-snap]:checked'); if (s) o.snaps = s.value;
  };
  const r = await modal({
    title: 'Clonar máquina virtual', iconName: 'clone', width: 640,
    buttons: [
      { label: 'Ayuda', left: true, keepOpen: true, action: () => { import('./actions.js').then((A) => A.helpContents()); return false; } },
      { label: 'Atrás', keepOpen: true, action: () => { collect(); step = 0; draw(); return false; } },
      { label: 'Siguiente', value: 'ok', primary: true, action: () => {
        collect();
        const err = !o.name ? 'Escriba un nombre.' : state.vms.some((v) => v.name.toLowerCase() === o.name.toLowerCase()) ? `Ya existe una máquina llamada «${o.name}».` : null;
        if (err) { const e = api.body.querySelector('#c-err'); e.style.display = 'flex'; e.innerHTML = `${icon('error', 16)}<div>${esc(err)}</div>`; return false; }
        if (step === 0) { step = 1; draw(); return false; }
        return true;
      } },
      { label: 'Cancelar', value: null, cancel: true },
    ],
    onInit: (a) => { api = a; draw(); },
  });
  if (r !== 'ok') return;
  const c = cloneVm(vm, { name: o.name, folder: `${o.folder}\\${o.name}`, macPolicy: o.mac, type: o.type, keepDiskNames: o.keepNames, keepUuids: o.keepUuids, snapMode: o.snaps });
  toast(`Se ha creado «${esc(c.name)}» (${o.type === 'linked' ? 'clonación enlazada' : 'clonación completa'}).`, { kind: 'ok' });
}

// ------------------------------------------------------------------ exportar / importar
export async function exportWizard() {
  const sel = new Set(state.selected?.startsWith?.('vm') ? [state.selected] : []);
  let fmt = 'OVF 1.0'; let file = ''; let mac = 'nat'; let manifest = true;
  let step = 0; let api;
  const draw = () => {
    if (step === 0) {
      api.body.innerHTML = `<div class="wizard"><h3>Máquinas virtuales para exportar</h3><p class="lead">Seleccione las máquinas virtuales que se exportarán al servicio virtualizado. Solo pueden exportarse máquinas apagadas o guardadas.</p><div class="tblwrap" style="max-height:260px">${state.vms.map((v) => `<label class="chk" style="display:flex;padding:5px 8px;gap:8px"><input type="checkbox" data-v="${v.id}" ${sel.has(v.id) ? 'checked' : ''} ${v.state === 'running' || v.state === 'paused' ? 'disabled' : ''}>${osIcon(v.osKey, 20)} ${esc(v.name)} ${v.state === 'running' ? '<span class="hint">(en ejecución)</span>' : ''}</label>`).join('')}</div></div>`;
      api.body.querySelectorAll('[data-v]').forEach((c) => { c.onchange = () => { if (c.checked) sel.add(c.dataset.v); else sel.delete(c.dataset.v); }; });
    } else {
      const first = state.vms.find((v) => sel.has(v.id));
      if (!file) file = `${sel.size === 1 ? first.name : 'Servicio virtualizado'}.ova`;
      api.body.innerHTML = `<div class="wizard"><h3>Configuración del formato</h3><p class="lead">Elija el formato y el archivo de destino del servicio virtualizado.</p><div class="form-grid"><label>Formato:</label><select id="x-fmt">${['OVF 0.9', 'OVF 1.0', 'OVF 2.0'].map((f) => `<option ${fmt === f ? 'selected' : ''}>Open Virtualization Format ${f.split(' ')[1]}</option>`).join('')}</select><label>Archivo:</label><input type="text" id="x-file" value="C:\\Users\\alumno\\Documents\\${esc(file)}"><label>Política de dirección MAC:</label><select id="x-mac"><option value="nat">Incluir solo direcciones MAC de la tarjeta de red NAT</option><option value="all">Incluir todas las direcciones MAC de la tarjeta de red</option><option value="new">Quitar todas las direcciones MAC de la tarjeta de red</option></select><label>Opciones adicionales:</label><div class="radio-col"><label class="chk"><input type="checkbox" id="x-man" ${manifest ? 'checked' : ''}> Escribir archivo Manifest</label><label class="chk"><input type="checkbox"> Incluir imágenes ISO</label></div></div><p class="hint">Un archivo .ova es un único paquete (tar) con el descriptor .ovf, los discos en formato VMDK y el manifiesto con las sumas SHA256.</p></div>`;
    }
    api.setButton(0, { disabled: step === 0 });
    api.setButton(1, { label: step === 1 ? 'Terminar' : 'Siguiente' });
  };
  const r = await modal({
    title: 'Exportar servicio virtualizado', iconName: 'export', width: 640,
    buttons: [
      { label: 'Atrás', keepOpen: true, action: () => { step = 0; draw(); return false; } },
      { label: 'Siguiente', value: 'ok', primary: true, action: () => {
        if (step === 0) { if (!sel.size) { toast('Seleccione al menos una máquina.', { kind: 'warn' }); return false; } step = 1; draw(); return false; }
        const b = api.body; fmt = `OVF ${b.querySelector('#x-fmt').value.split(' ').pop()}`; file = b.querySelector('#x-file').value.split('\\').pop(); mac = b.querySelector('#x-mac').value; manifest = b.querySelector('#x-man').checked;
        if (!/\.(ova|ovf)$/i.test(file)) file += '.ova';
        return true;
      } },
      { label: 'Cancelar', value: null, cancel: true },
    ],
    onInit: (a) => { api = a; draw(); },
  });
  if (r !== 'ok') return;
  const ova = exportOva(state.vms.filter((v) => sel.has(v.id)), { file, format: fmt, macPolicy: mac, manifest });
  toast(`Exportado ${esc(ova.file)} (${ova.sizeMB} MB) en Documentos.`, { kind: 'ok' });
}

export async function importWizard() {
  let ova = null; let step = 0; let api; let mac = 'nat'; let names = [];
  const draw = () => {
    if (step === 0) {
      api.body.innerHTML = `<div class="wizard"><h3>Servicio virtualizado a importar</h3><p class="lead">Elija el origen desde el que importar el servicio virtualizado.</p><div class="form-grid"><label>Origen:</label><select disabled><option>Sistema de archivos local</option></select><label>Archivo:</label><div style="display:flex;gap:4px"><input type="text" id="i-file" readonly value="${esc(ova?.path || '')}" style="flex:1"><button class="btn-ico" id="i-pick" title="Elegir archivo">${icon('folder', 18)}</button></div></div>${state.hostFiles.ova.length ? '' : `<div class="infobox" style="margin-top:10px">${icon('info', 16)}<div>Todavía no hay ningún archivo .ova en Documentos. Exporte primero una máquina (Archivo › Exportar servicio virtualizado).</div></div>`}</div>`;
      api.body.querySelector('#i-pick').onclick = async () => { const f = await filePicker({ title: 'Seleccione un archivo de servicio virtualizado', filter: 'ova' }); if (f) { ova = f.data; names = ova.items.map((it) => uniqueVmName(it.vm.name)); draw(); } };
    } else {
      api.body.innerHTML = `<div class="wizard"><h3>Configuración del servicio virtualizado</h3><p class="lead">Estas son las máquinas virtuales contenidas en el servicio y la configuración sugerida para las máquinas importadas.</p><div class="tblwrap" style="max-height:260px"><table class="tbl">${ova.items.map((it, i) => `<tr><td colspan="2" style="font-weight:600;background:var(--panel-2)">Sistema virtual ${i + 1}</td></tr><tr><td>${icon('general', 14)} Nombre</td><td><input type="text" data-n="${i}" value="${esc(names[i])}"></td></tr><tr><td>Tipo de SO invitado</td><td>${esc(OS_TYPES[it.vm.osKey].version)}</td></tr><tr><td>CPU</td><td>${it.vm.hw.cpus}</td></tr><tr><td>RAM</td><td>${it.vm.hw.ramMB} MB</td></tr><tr><td>Adaptadores de red</td><td>${it.vm.nics.filter((n) => n.enabled).length}</td></tr><tr><td>Discos</td><td>${it.disks.map((d) => esc(d.name)).join(', ')}</td></tr>`).join('')}</table></div><div class="form-grid" style="margin-top:10px"><label>Carpeta base de la máquina:</label><input type="text" value="${esc(state.prefs.machineFolder)}" disabled><label>Política de dirección MAC:</label><select id="i-mac"><option value="nat">Incluir solo direcciones MAC de la tarjeta de red NAT</option><option value="all">Incluir todas las direcciones MAC de la tarjeta de red</option><option value="new">Generar nuevas direcciones MAC para todas las tarjetas de red</option></select><label>Opciones adicionales:</label><label class="chk"><input type="checkbox" checked disabled> Importar discos duros como VDI</label></div></div>`;
    }
    api.setButton(0, { disabled: step === 0 });
    api.setButton(1, { label: step === 1 ? 'Terminar' : 'Siguiente' });
  };
  const r = await modal({
    title: 'Importar servicio virtualizado', iconName: 'import', width: 660,
    buttons: [
      { label: 'Atrás', keepOpen: true, action: () => { step = 0; draw(); return false; } },
      { label: 'Siguiente', value: 'ok', primary: true, action: () => {
        if (step === 0) { if (!ova) { toast('Elija un archivo .ova.', { kind: 'warn' }); return false; } step = 1; draw(); return false; }
        api.body.querySelectorAll('[data-n]').forEach((i) => { names[Number(i.dataset.n)] = i.value.trim() || names[Number(i.dataset.n)]; });
        mac = api.body.querySelector('#i-mac').value;
        return true;
      } },
      { label: 'Cancelar', value: null, cancel: true },
    ],
    onInit: (a) => { api = a; draw(); },
  });
  if (r !== 'ok') return;
  const created = importOva(ova, { names, macPolicy: mac });
  toast(`Importado: ${created.map((v) => esc(v.name)).join(', ')}.`, { kind: 'ok' });
}

export { fmtMB };
