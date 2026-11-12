// Terminal de texto reutilizable (consola Linux, CMD de Windows, consola del anfitrión)
// con historial, edición de línea, autocompletado, Ctrl+C, lectura de contraseñas y editor nano.
import { esc } from './util.js';

export class Terminal {
  constructor(el, opts = {}) {
    this.el = el;
    this.opts = opts;
    this.history = opts.history || [];
    this.hIdx = -1;
    this.buf = '';
    this.cur = 0;
    this.busy = false;
    this.reader = null;
    this.aborted = false;
    this.editor = null;
    el.classList.add('term', `term-${opts.flavor || 'linux'}`);
    el.tabIndex = 0;
    el.innerHTML = '<div class="term-out"></div><div class="term-line"><span class="term-prompt"></span><span class="term-in"></span></div><textarea class="term-kbd" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Entrada de la terminal"></textarea>';
    this.out = el.querySelector('.term-out');
    this.lineEl = el.querySelector('.term-line');
    this.promptEl = el.querySelector('.term-prompt');
    this.inEl = el.querySelector('.term-in');
    this.kbd = el.querySelector('.term-kbd');
    el.addEventListener('mousedown', (e) => { if (!this.editor && e.target === el) e.preventDefault(); });
    el.addEventListener('click', () => { if (!window.getSelection()?.toString()) this.focus(); });
    this.kbd.addEventListener('keydown', (e) => this.onKey(e));
    this.kbd.addEventListener('input', () => { const v = this.kbd.value; this.kbd.value = ''; if (v) this.insert(v.replace(/\r?\n/g, '')); });
    this.kbd.addEventListener('paste', (e) => { e.preventDefault(); const t = e.clipboardData.getData('text'); this.paste(t); });
    this.kbd.addEventListener('focus', () => el.classList.add('focused'));
    this.kbd.addEventListener('blur', () => el.classList.remove('focused'));
    this.setPrompt('');
  }

  focus() { if (this.editor) this.editor.ta.focus(); else this.kbd.focus({ preventScroll: true }); }

  setPrompt(p) { this.prompt = p; this.promptEl.textContent = p; this.render(); }

  render() {
    const hidden = this.reader?.hidden;
    const text = hidden ? '' : this.buf;
    const before = esc(text.slice(0, this.cur));
    const at = esc(text.slice(this.cur, this.cur + 1) || ' ');
    const after = esc(text.slice(this.cur + 1));
    this.inEl.innerHTML = `${before}<span class="term-cursor">${at}</span>${after}`;
    this.lineEl.style.display = this.busy && !this.reader ? 'none' : '';
    this.scroll();
  }

  scroll() { this.el.scrollTop = this.el.scrollHeight; }

  print(text = '', cls = '') {
    const s = String(text);
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = s;
    this.out.appendChild(span);
    while (this.out.childNodes.length > 3000) this.out.removeChild(this.out.firstChild);
    this.scroll();
  }
  println(text = '', cls = '') { this.print(`${text}\n`, cls); }
  html(h) { const d = document.createElement('span'); d.innerHTML = h; this.out.appendChild(d); this.scroll(); }
  clear() { this.out.innerHTML = ''; }

  insert(s) {
    if (this.editor) return;
    if (this.busy && !this.reader) return;
    this.buf = this.buf.slice(0, this.cur) + s + this.buf.slice(this.cur);
    this.cur += s.length;
    this.render();
  }
  paste(t) {
    const lines = t.replace(/\r/g, '').split('\n');
    lines.forEach((l, i) => { this.insert(l); if (i < lines.length - 1) this.enter(); });
  }

  // lee una línea (login, contraseña, confirmaciones)
  read(prompt, { hidden = false } = {}) {
    return new Promise((resolve) => {
      this.reader = { resolve, hidden };
      this.setPrompt(prompt);
      this.buf = ''; this.cur = 0;
      this.render();
    });
  }

  async enter() {
    const line = this.buf;
    const shown = this.reader?.hidden ? '' : line;
    this.println(`${this.prompt}${shown}`, 'term-echo');
    this.buf = ''; this.cur = 0;
    if (this.reader) {
      const r = this.reader; this.reader = null;
      this.setPrompt('');
      r.resolve(line);
      return;
    }
    if (this.busy) return;
    if (line.trim()) { this.history.push(line); if (this.history.length > 200) this.history.shift(); }
    this.hIdx = -1;
    this.busy = true;
    this.aborted = false;
    this.render();
    try { await this.opts.onCommand?.(line); } catch (e) { console.error(e); this.println(String(e.message || e), 'term-err'); }
    this.busy = false;
    this.opts.afterCommand?.();
    this.render();
  }

  abort() {
    if (this.reader) { const r = this.reader; this.reader = null; this.println(`${this.prompt}${this.buf}^C`); this.buf = ''; this.cur = 0; r.resolve(null); this.setPrompt(''); return; }
    if (this.busy) { this.aborted = true; this.print('^C\n'); return; }
    this.println(`${this.prompt}${this.buf}^C`);
    this.buf = ''; this.cur = 0;
    this.render();
  }

  sleep(ms) {
    return new Promise((res) => {
      const t0 = Date.now();
      const tick = () => { if (this.aborted || Date.now() - t0 >= ms) res(!this.aborted); else setTimeout(tick, 40); };
      tick();
    });
  }

  onKey(e) {
    if (this.editor) return;
    const k = e.key;
    if (e.ctrlKey && (k === 'c' || k === 'C')) { if (!window.getSelection()?.toString()) { e.preventDefault(); this.abort(); } return; }
    if (e.ctrlKey && (k === 'l' || k === 'L')) { e.preventDefault(); this.clear(); return; }
    if (e.ctrlKey && (k === 'u' || k === 'U')) { e.preventDefault(); this.buf = this.buf.slice(this.cur); this.cur = 0; this.render(); return; }
    if (e.ctrlKey && (k === 'a' || k === 'A')) { e.preventDefault(); this.cur = 0; this.render(); return; }
    if (e.ctrlKey && (k === 'e' || k === 'E')) { e.preventDefault(); this.cur = this.buf.length; this.render(); return; }
    if (e.ctrlKey && (k === 'd' || k === 'D')) { e.preventDefault(); if (!this.buf && !this.busy) { this.buf = 'exit'; this.enter(); } return; }
    if (k === 'Enter') { e.preventDefault(); this.enter(); return; }
    if (this.busy && !this.reader) return;
    if (k === 'Backspace') { e.preventDefault(); if (this.cur > 0) { this.buf = this.buf.slice(0, this.cur - 1) + this.buf.slice(this.cur); this.cur--; this.render(); } return; }
    if (k === 'Delete') { e.preventDefault(); this.buf = this.buf.slice(0, this.cur) + this.buf.slice(this.cur + 1); this.render(); return; }
    if (k === 'ArrowLeft') { e.preventDefault(); this.cur = Math.max(0, this.cur - 1); this.render(); return; }
    if (k === 'ArrowRight') { e.preventDefault(); this.cur = Math.min(this.buf.length, this.cur + 1); this.render(); return; }
    if (k === 'Home') { e.preventDefault(); this.cur = 0; this.render(); return; }
    if (k === 'End') { e.preventDefault(); this.cur = this.buf.length; this.render(); return; }
    if (this.reader) return;
    if (k === 'ArrowUp') {
      e.preventDefault();
      if (!this.history.length) return;
      this.hIdx = this.hIdx < 0 ? this.history.length - 1 : Math.max(0, this.hIdx - 1);
      this.buf = this.history[this.hIdx]; this.cur = this.buf.length; this.render(); return;
    }
    if (k === 'ArrowDown') {
      e.preventDefault();
      if (this.hIdx < 0) return;
      this.hIdx++;
      if (this.hIdx >= this.history.length) { this.hIdx = -1; this.buf = ''; } else this.buf = this.history[this.hIdx];
      this.cur = this.buf.length; this.render(); return;
    }
    if (k === 'Tab') {
      e.preventDefault();
      const r = this.opts.complete?.(this.buf.slice(0, this.cur));
      if (!r) return;
      if (r.length === 1) {
        const before = this.buf.slice(0, this.cur);
        const m = before.match(/(\S*)$/);
        const word = m[1];
        const add = r[0].slice(word.length);
        this.insert(add + (r[0].endsWith('/') ? '' : ' '));
      } else if (r.length > 1) {
        const before = this.buf.slice(0, this.cur);
        const word = before.match(/(\S*)$/)[1];
        let common = r[0];
        for (const x of r) while (!x.startsWith(common)) common = common.slice(0, -1);
        if (common.length > word.length) this.insert(common.slice(word.length));
        else { this.println(`${this.prompt}${this.buf}`); this.println(r.join('  ')); }
      }
    }
  }

  // ---------------- editor nano ----------------
  edit(path, text, { readonly = false, title = 'GNU nano 7.2' } = {}) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'nano';
      wrap.innerHTML = `<div class="nano-top"><span>${esc(title)}</span><span class="nano-file">${esc(path)}</span><span class="nano-mod"></span></div><textarea class="nano-ta" spellcheck="false"></textarea><div class="nano-msg"></div><div class="nano-keys"><button data-k="save"><b>^O</b> Guardar</button><button data-k="exit"><b>^X</b> Salir</button><button data-k="cut"><b>^K</b> Cortar</button><button data-k="paste"><b>^U</b> Pegar</button><button data-k="help"><b>^G</b> Ayuda</button></div>`;
      this.el.appendChild(wrap);
      const ta = wrap.querySelector('.nano-ta');
      const msg = wrap.querySelector('.nano-msg');
      const mod = wrap.querySelector('.nano-mod');
      ta.value = text;
      ta.readOnly = readonly;
      let saved = text;
      let clip = '';
      const ed = { ta, wrap };
      this.editor = ed;
      this.lineEl.style.display = 'none';
      const setMod = () => { mod.textContent = ta.value !== saved ? 'Modificado' : ''; };
      const flash = (t) => { msg.textContent = t; };
      const lines = () => ta.value.split('\n').length;
      const save = () => {
        if (readonly) { flash('[ El archivo es de solo lectura ]'); return; }
        const r = this.opts.onSave?.(path, ta.value);
        if (r && r.error) { flash(`[ Error escribiendo ${path}: ${r.error} ]`); return; }
        saved = ta.value; setMod(); flash(`[ ${lines()} líneas escritas ]`);
      };
      let confirm = false;
      const exit = (force) => {
        if (!force && ta.value !== saved && !readonly) {
          confirm = true;
          msg.innerHTML = '¿Guardar el búfer modificado? <button data-a="y">S Sí</button> <button data-a="n">N No</button> <button data-a="c">^C Cancelar</button>';
          return;
        }
        wrap.remove();
        this.editor = null;
        this.lineEl.style.display = '';
        this.render();
        this.focus();
        resolve(saved !== text);
      };
      msg.addEventListener('click', (e) => {
        const a = e.target.closest('button')?.dataset.a;
        if (a === 'y') { save(); if (ta.value === saved) exit(true); }
        if (a === 'n') exit(true);
        if (a === 'c') { confirm = false; msg.textContent = ''; ta.focus(); }
      });
      wrap.querySelector('.nano-keys').addEventListener('click', (e) => {
        const k = e.target.closest('button')?.dataset.k;
        if (k === 'save') save();
        if (k === 'exit') exit(false);
        if (k === 'help') flash('Use las flechas para moverse. ^O guarda, ^X sale, ^K corta la línea, ^U la pega.');
        if (k === 'cut' || k === 'paste') ta.dispatchEvent(new KeyboardEvent('keydown', { key: k === 'cut' ? 'k' : 'u', ctrlKey: true }));
        ta.focus();
      });
      ta.addEventListener('input', setMod);
      ta.addEventListener('keydown', (e) => {
        if (confirm) {
          const k = e.key.toLowerCase();
          if (k === 's' || k === 'y') { e.preventDefault(); save(); if (ta.value === saved) exit(true); }
          else if (k === 'n') { e.preventDefault(); exit(true); }
          else if (e.ctrlKey && k === 'c') { e.preventDefault(); confirm = false; msg.textContent = ''; }
          else e.preventDefault();
          return;
        }
        if (!e.ctrlKey) { if (e.key === 'Tab') { e.preventDefault(); document.execCommand?.('insertText', false, '\t'); } return; }
        const k = e.key.toLowerCase();
        if (k === 'o' || k === 's') { e.preventDefault(); save(); }
        else if (k === 'x') { e.preventDefault(); exit(false); }
        else if (k === 'g') { e.preventDefault(); flash('^O guarda, ^X sale, ^K corta la línea actual y ^U la pega.'); }
        else if (k === 'k') {
          e.preventDefault();
          const v = ta.value; const p = ta.selectionStart;
          const s = v.lastIndexOf('\n', p - 1) + 1; let en = v.indexOf('\n', p); en = en < 0 ? v.length : en + 1;
          clip = v.slice(s, en); ta.value = v.slice(0, s) + v.slice(en); ta.selectionStart = ta.selectionEnd = s; setMod();
        } else if (k === 'u') {
          e.preventDefault();
          const v = ta.value; const p = ta.selectionStart; const s = v.lastIndexOf('\n', p - 1) + 1;
          ta.value = v.slice(0, s) + clip + v.slice(s); ta.selectionStart = ta.selectionEnd = s + clip.length; setMod();
        }
      });
      setTimeout(() => ta.focus(), 0);
    });
  }
}
