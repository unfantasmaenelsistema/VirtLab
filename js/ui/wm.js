// Gestor de ventanas del "escritorio" del anfitrión: ventanas arrastrables, barra de tareas,
// cuadros de diálogo modales, menús desplegables y avisos.
import { esc } from '../util.js';
import { icon } from './icons.js';

const wins = new Map();
let zTop = 10;
let desktop;
let taskbarApps;
const taskbarPinned = [];

export function initDesktop(root) {
  desktop = root.querySelector('#desktop');
  taskbarApps = root.querySelector('#tb-apps');
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.menu-pop') && !e.target.closest('[data-menu-open]')) closeMenus();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
  window.addEventListener('resize', () => { for (const w of wins.values()) clampWin(w); });
}

export function pinTaskbar(item) { taskbarPinned.push(item); renderTaskbar(); }

export function renderTaskbar() {
  if (!taskbarApps) return;
  const items = [...taskbarPinned];
  for (const w of wins.values()) if (w.taskbar !== false && !taskbarPinned.some((p) => p.winId === w.id)) items.push({ winId: w.id, icon: w.iconName, html: w.iconHtml, title: w.title });
  taskbarApps.innerHTML = items.map((it) => {
    const w = it.winId && wins.get(it.winId);
    const open = !!w;
    const active = w && !w.minimized && w.el.classList.contains('active');
    return `<button class="tb-app ${open ? 'open' : ''} ${active ? 'active' : ''}" data-tb="${esc(it.winId || it.id)}" title="${esc(w?.title || it.title)}">${it.html || icon(it.icon, 24)}</button>`;
  }).join('');
  taskbarApps.querySelectorAll('.tb-app').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.tb;
      const w = wins.get(id);
      const pin = taskbarPinned.find((p) => p.winId === id || p.id === id);
      if (w) { if (w.minimized) w.restore(); else if (w.el.classList.contains('active')) w.minimize(); else w.focus(); }
      else pin?.launch?.();
    };
  });
}

function clampWin(w) {
  if (w.maximized) return;
  const r = desktop.getBoundingClientRect();
  const el = w.el;
  const x = Math.max(-el.offsetWidth + 120, Math.min(el.offsetLeft, r.width - 120));
  const y = Math.max(0, Math.min(el.offsetTop, r.height - 40));
  el.style.left = `${x}px`; el.style.top = `${y}px`;
}

export function getWindow(id) { return wins.get(id); }
export function allWindows() { return [...wins.values()]; }

export function createWindow(o) {
  if (wins.has(o.id)) { const w = wins.get(o.id); w.restore(); w.focus(); return w; }
  const el = document.createElement('section');
  el.className = `win ${o.className || ''}`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', o.title);
  el.dataset.win = o.id;
  el.innerHTML = `<header class="win-title"><span class="win-ico">${o.iconHtml || icon(o.icon || 'vbox', 16)}</span><span class="win-caption"></span><div class="win-btns"><button class="wb-min" title="Minimizar" aria-label="Minimizar"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor"/></svg></button><button class="wb-max" title="Maximizar" aria-label="Maximizar"><svg width="10" height="10" viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor"/></svg></button><button class="wb-close" title="Cerrar" aria-label="Cerrar"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor"/></svg></button></div></header><div class="win-body"></div>${o.resizable === false ? '' : '<div class="win-resize"></div>'}`;
  desktop.appendChild(el);
  const r = desktop.getBoundingClientRect();
  const w = Math.min(o.w || 800, r.width - 20);
  const h = Math.min(o.h || 560, r.height - 20);
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  const off = (wins.size % 6) * 28;
  el.style.left = `${o.x ?? Math.max(10, (r.width - w) / 2 + off - 60)}px`;
  el.style.top = `${o.y ?? Math.max(6, (r.height - h) / 2 + off - 40)}px`;
  const win = {
    id: o.id, el, body: el.querySelector('.win-body'), title: o.title, iconName: o.icon, iconHtml: o.iconHtml, taskbar: o.taskbar,
    minimized: false, maximized: false,
    setTitle(t) { win.title = t; el.querySelector('.win-caption').textContent = t; el.setAttribute('aria-label', t); renderTaskbar(); },
    focus() { for (const x of wins.values()) x.el.classList.remove('active'); el.classList.add('active'); el.style.zIndex = ++zTop; renderTaskbar(); o.onFocus?.(); },
    minimize() { win.minimized = true; el.classList.add('minimized'); el.classList.remove('active'); renderTaskbar(); },
    restore() { win.minimized = false; el.classList.remove('minimized'); win.focus(); },
    maximize(on = !win.maximized) { win.maximized = on; el.classList.toggle('maximized', on); o.onResize?.(); },
    close(force = false) {
      if (!force && o.onClose && o.onClose() === false) return;
      el.remove(); wins.delete(o.id); renderTaskbar();
    },
  };
  win.setTitle(o.title);
  wins.set(o.id, win);
  el.addEventListener('mousedown', () => { if (!el.classList.contains('active')) win.focus(); });
  el.querySelector('.wb-min').onclick = (e) => { e.stopPropagation(); win.minimize(); };
  el.querySelector('.wb-max').onclick = (e) => { e.stopPropagation(); win.maximize(); };
  el.querySelector('.wb-close').onclick = (e) => { e.stopPropagation(); win.close(); };
  if (o.closable === false) el.querySelector('.wb-close').disabled = true;
  const title = el.querySelector('.win-title');
  title.addEventListener('dblclick', (e) => { if (!e.target.closest('.win-btns')) win.maximize(); });
  dragBy(title, el, () => win.maximized, () => { if (win.maximized) win.maximize(false); });
  const rs = el.querySelector('.win-resize');
  if (rs) resizeBy(rs, el, o.minW || 360, o.minH || 220, () => o.onResize?.());
  if (o.maximized) win.maximize(true);
  o.content?.(win.body, win);
  win.focus();
  return win;
}

function dragBy(handle, el, isMax, unmax) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const sx = e.clientX; const sy = e.clientY;
    let ox = el.offsetLeft; let oy = el.offsetTop;
    let moved = false;
    const mv = (ev) => {
      if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return;
      if (!moved && isMax()) { unmax(); ox = ev.clientX - el.offsetWidth / 2; oy = 0; }
      moved = true;
      el.style.left = `${ox + ev.clientX - sx}px`;
      el.style.top = `${Math.max(0, oy + ev.clientY - sy)}px`;
    };
    const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointermove', mv);
    document.addEventListener('pointerup', up);
  });
}
function resizeBy(handle, el, minW, minH, cb) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const sx = e.clientX; const sy = e.clientY; const w0 = el.offsetWidth; const h0 = el.offsetHeight;
    const mv = (ev) => { el.style.width = `${Math.max(minW, w0 + ev.clientX - sx)}px`; el.style.height = `${Math.max(minH, h0 + ev.clientY - sy)}px`; cb(); };
    const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointermove', mv);
    document.addEventListener('pointerup', up);
  });
}

// ------------------------------------------------------------------ diálogos modales
let modalDepth = 0;
export function modal({ title, iconName = null, html = '', buttons = [{ label: 'Aceptar', value: true, primary: true }], width = 520, onInit, className = '', validate }) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'modal-ov';
    ov.style.zIndex = 5000 + modalDepth++;
    ov.innerHTML = `<div class="win dlg active ${className}" role="dialog" aria-modal="true" aria-label="${esc(title)}" style="width:${width}px"><header class="win-title"><span class="win-ico">${icon(iconName || 'vbox', 16)}</span><span class="win-caption">${esc(title)}</span><div class="win-btns"><button class="wb-close" title="Cerrar" aria-label="Cerrar"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor"/></svg></button></div></header><div class="dlg-body">${html}</div><footer class="dlg-btns">${buttons.map((b, i) => `<button class="btn ${b.primary ? 'primary' : ''} ${b.left ? 'left' : ''}" data-i="${i}" ${b.disabled ? 'disabled' : ''}>${esc(b.label)}</button>`).join('')}</footer></div>`;
    document.body.appendChild(ov);
    const dlg = ov.querySelector('.dlg');
    dragBy(dlg.querySelector('.win-title'), dlg, () => false, () => {});
    dlg.style.position = 'relative';
    let done = false;
    const finish = (v) => { if (done) return; done = true; document.removeEventListener('keydown', onDocKey); ov.remove(); modalDepth--; resolve(v); };
    function onDocKey(e) {
      if (e.key !== 'Escape' || [...document.querySelectorAll('.modal-ov')].pop() !== ov || document.querySelector('.menu-pop')) return;
      e.stopPropagation();
      finish(buttons.find((b) => b.cancel)?.value ?? null);
    }
    document.addEventListener('keydown', onDocKey);
    const api = { el: dlg, body: dlg.querySelector('.dlg-body'), close: finish, buttons: dlg.querySelectorAll('.dlg-btns .btn'), setButton(i, props) { const b = dlg.querySelectorAll('.dlg-btns .btn')[i]; if (!b) return; if ('disabled' in props) b.disabled = props.disabled; if (props.label) b.textContent = props.label; } };
    dlg.querySelectorAll('.dlg-btns .btn').forEach((b) => {
      b.onclick = async () => {
        const bt = buttons[Number(b.dataset.i)];
        if (bt.action) { const r = await bt.action(api); if (r === false) return; }
        if (bt.value !== undefined && bt.primary && validate) { const ok = await validate(api); if (!ok) return; }
        if (bt.keepOpen) return;
        finish(bt.value);
      };
    });
    dlg.querySelector('.wb-close').onclick = () => finish(buttons.find((b) => b.cancel)?.value ?? null);
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON' && !e.target.closest('.no-enter')) { const p = [...dlg.querySelectorAll('.dlg-btns .btn.primary')].find((x) => !x.disabled); if (p) { e.preventDefault(); p.click(); } }
    });
    onInit?.(api);
    setTimeout(() => (dlg.querySelector('[autofocus]') || dlg.querySelector('input,select,textarea') || dlg.querySelector('.btn.primary'))?.focus(), 30);
  });
}

export function msgBox({ title = 'VirtualBox - Pregunta', kind = 'question', text, detail = '', buttons }) {
  const bts = buttons || [{ label: 'Aceptar', value: true, primary: true }];
  return modal({
    title, iconName: kind, width: 480, buttons: bts, className: 'msgbox',
    html: `<div class="msg"><div class="msg-ico">${icon(kind, 36)}</div><div class="msg-text">${text}${detail ? `<details class="msg-detail"><summary>Detalles</summary><pre>${esc(detail)}</pre></details>` : ''}</div></div>`,
  });
}

// ------------------------------------------------------------------ menús
let openMenus = [];
export function closeMenus() { openMenus.forEach((m) => m.remove()); openMenus = []; document.querySelectorAll('.menubar .open').forEach((x) => x.classList.remove('open')); }

export function popupMenu(x, y, items, { level = 0, anchor = null } = {}) {
  if (level === 0) closeMenus();
  const m = document.createElement('div');
  m.className = 'menu-pop';
  m.setAttribute('role', 'menu');
  m.innerHTML = items.map((it, i) => {
    if (it === '-') return '<div class="mi-sep" role="separator"></div>';
    if (it.header) return `<div class="mi-head">${esc(it.header)}</div>`;
    return `<button class="mi ${it.disabled ? 'disabled' : ''}" role="menuitem" data-i="${i}" ${it.disabled ? 'aria-disabled="true"' : ''}><span class="mi-ico">${it.checked !== undefined ? (it.checked ? icon('check', 14) : '') : it.icon ? icon(it.icon, 16) : ''}</span><span class="mi-label">${esc(it.label)}</span><span class="mi-sc">${esc(it.shortcut || '')}</span><span class="mi-sub">${it.submenu ? '›' : ''}</span></button>`;
  }).join('');
  document.body.appendChild(m);
  openMenus.push(m);
  const vw = window.innerWidth; const vh = window.innerHeight;
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, vw - r.width - 4)}px`;
  m.style.top = `${Math.min(y, vh - r.height - 4)}px`;
  m.querySelectorAll('.mi').forEach((b) => {
    const it = items[Number(b.dataset.i)];
    b.onmouseenter = () => {
      openMenus.filter((om) => Number(om.dataset.level) > level).forEach((om) => om.remove());
      openMenus = openMenus.filter((om) => !(Number(om.dataset.level) > level));
      if (it.submenu && !it.disabled) { const rr = b.getBoundingClientRect(); const sub = popupMenu(rr.right - 2, rr.top - 4, typeof it.submenu === 'function' ? it.submenu() : it.submenu, { level: level + 1 }); sub.dataset.level = level + 1; }
    };
    b.onclick = (e) => { e.stopPropagation(); if (it.disabled || it.submenu) return; closeMenus(); it.action?.(); };
  });
  m.dataset.level = level;
  return m;
}

// Barra de menús: menus = [{label, items: () => [...]}]
export function menubar(el, menus) {
  el.classList.add('menubar');
  el.setAttribute('role', 'menubar');
  el.innerHTML = menus.map((m, i) => `<button class="mb-item" data-menu-open="1" data-i="${i}">${esc(m.label)}</button>`).join('');
  const open = (b) => {
    const m = menus[Number(b.dataset.i)];
    closeMenus();
    b.classList.add('open');
    const r = b.getBoundingClientRect();
    popupMenu(r.left, r.bottom, typeof m.items === 'function' ? m.items() : m.items);
    b.classList.add('open');
  };
  el.querySelectorAll('.mb-item').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); if (b.classList.contains('open')) closeMenus(); else open(b); };
    b.onmouseenter = () => { if (el.querySelector('.mb-item.open') && !b.classList.contains('open')) open(b); };
  });
}

// ------------------------------------------------------------------ avisos
export function toast(html, { timeout = 4200, kind = 'info' } = {}) {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = `${icon(kind === 'ok' ? 'check' : kind, 18)}<div>${html}</div>`;
  box.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, timeout);
}

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
