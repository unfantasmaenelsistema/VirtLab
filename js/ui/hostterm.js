// Consola del anfitrión (Windows 11): símbolo del sistema con ping, ssh, curl y VBoxManage.
import { state, logEvent, getVm } from '../store.js';
import { createWindow, getWindow } from './wm.js';
import { Terminal } from '../terminal.js';
import { runWindows, winPrompt, completeWindows } from '../shell/windows.js';
import { runLinux, linuxPrompt, completeLinux } from '../shell/linux.js';

let n = 0;
export function openHostTerminalWindow() {
  const id = `host-term-${++n}`;
  return createWindow({
    id, title: 'Símbolo del sistema', icon: 'terminal', w: 860, h: 520, minW: 380, minH: 220,
    content: (body, win) => {
      body.style.background = '#0c0c0c';
      body.innerHTML = '<div style="flex:1;display:flex;min-height:0" class="termhost"></div>';
      const base = { kind: 'host', user: state.host.user, cwd: `C:\\Users\\${state.host.user}`, admin: true };
      const stack = [base];
      const push = (s) => { const x = { ...s }; x.pushSession = push; stack.push(x); const v = getVm(s.vmId); if (v?.rt) v.rt.openSessions = [...(v.rt.openSessions || []), x]; };
      base.pushSession = push;
      const top = () => stack[stack.length - 1];
      const term = new Terminal(body.querySelector('.termhost'), {
        flavor: 'host',
        history: state.host.history || (state.host.history = []),
        onCommand: async (line) => {
          const s = top();
          if (line.trim()) logEvent({ type: 'cmd', from: s.kind === 'host' ? 'host' : s.vmId, line, via: s.kind === 'host' ? null : 'ssh' });
          if (s.kind === 'vm') {
            const v = getVm(s.vmId);
            if (v?.state !== 'running') { term.println(`Connection to ${s.from} closed by remote host.\nConnection to ${s.from} closed.`); stack.pop(); return; }
            await runLinux(term, s, line);
          } else await runWindows(term, s, line);
        },
        complete: (before) => (top().kind === 'vm' ? completeLinux(top(), before) : completeWindows(top(), before)),
        afterCommand: () => {
          const s = top();
          if (s.exitRequested) {
            s.exitRequested = false;
            if (s.userStack?.length) { const p = s.userStack.pop(); s.user = p.user; s.cwd = p.cwd; term.println('logout'); }
            else if (stack.length > 1) { stack.pop(); term.println(`logout\nConnection to ${s.from} closed.`); }
            else { win.close(true); return; }
          }
          const t = top();
          term.setPrompt(t.kind === 'vm' ? linuxPrompt(t) : winPrompt(t));
          win.setTitle(t.kind === 'vm' ? `${t.user}@${t.from}: ~` : t.ps ? 'Windows PowerShell' : 'Símbolo del sistema');
        },
      });
      term.println(`Microsoft Windows [Versión 10.0.26100.2033]\n(c) Microsoft Corporation. Todos los derechos reservados.\n`);
      term.setPrompt(winPrompt(base));
      setTimeout(() => term.focus(), 40);
      win.term = term;
    },
    onFocus: () => setTimeout(() => getWindow(id)?.term?.focus(), 0),
  });
}
