// Utilidades de prueba: arranca VirtLab sin navegador y ejecuta órdenes en una "terminal" falsa.
import { load, resetAll, state, vmByName, commit } from '../js/store.js';
import { startVm, bootOs, powerOff } from '../js/vmctl.js';
import { vmContent } from '../js/net.js';
import { runLinux } from '../js/shell/linux.js';
import { runWindows } from '../js/shell/windows.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

export function fresh() {
  load();
  resetAll();
  return state;
}

export function boot(name) {
  const vm = vmByName(name);
  const r = startVm(vm);
  if (!r.ok) throw new Error(r.detail);
  bootOs(vm, vmContent(state, vm));
  vm.rt.screen = { phase: 'console' };
  return vm;
}

export function stopAll() { state.vms.forEach((v) => powerOff(v)); }

export class FakeTerm {
  constructor(answers = []) { this.buf = ''; this.answers = answers; this.aborted = false; this.history = []; this.opts = {}; }
  print(t) { this.buf += t; }
  println(t = '') { this.buf += `${t}\n`; }
  clear() { this.buf = ''; }
  sleep() { return Promise.resolve(!this.aborted); }
  read() { return Promise.resolve(this.answers.length ? this.answers.shift() : ''); }
  take() { const b = this.buf; this.buf = ''; return b; }
}

export async function sh(vm, line, { user = 'usuario', answers = [], sess = null } = {}) {
  const term = new FakeTerm(answers);
  const s = sess || { kind: 'vm', vmId: vm.id, user, cwd: `/home/${user}` };
  await runLinux(term, s, line);
  return term.take();
}

export async function cmd(vmOrHost, line, { answers = [], sess = null, admin = true } = {}) {
  const term = new FakeTerm(answers);
  const s = sess || (vmOrHost === 'host'
    ? { kind: 'host', user: 'alumno', cwd: 'C:\\Users\\alumno', admin: true }
    : { kind: 'vm', vmId: vmOrHost.id, user: 'Usuario', cwd: 'C:\\Users\\Usuario', elevated: admin });
  await runWindows(term, s, line);
  return term.take();
}

export { state, vmByName, commit, vmContent };
