import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, boot, sh, cmd, state, vmByName, vmContent } from './helpers.js';
import { LABS, labStatus, startLab } from '../js/labs.js';
import { logEvent } from '../js/store.js';
import { send } from '../js/net.js';

const flush = () => new Promise((r) => setTimeout(r, 300));

test('Laboratorio «Servidor DHCP propio»: Debian obtiene IP del isc-dhcp-server de Ubuntu', async () => {
  fresh();
  startLab('dhcpd');
  const u = vmByName('Ubuntu Server');
  u.nics[1].attach = 'intnet';
  const c = vmContent(state, u);
  c.files['/etc/netplan/50-cloud-init.yaml'] = 'network:\n  version: 2\n  ethernets:\n    enp0s3:\n      dhcp4: true\n    enp0s8:\n      addresses: [10.10.10.1/24]\n';
  boot('Ubuntu Server');
  let out = await sh(u, 'sudo apt install -y isc-dhcp-server', { answers: ['usuario'] });
  assert.match(out, /Setting up isc-dhcp-server/);
  assert.match(out, /failed/, 'sin configurar, el servicio no arranca (como en Ubuntu real)');
  c.files['/etc/default/isc-dhcp-server'] = 'INTERFACESv4="enp0s8"\nINTERFACESv6=""\n';
  c.files['/etc/dhcp/dhcpd.conf'] += '\nsubnet 10.10.10.0 netmask 255.255.255.0 {\n  range 10.10.10.100 10.10.10.150;\n  option routers 10.10.10.1;\n}\n';
  out = await sh(u, 'sudo systemctl restart isc-dhcp-server', { answers: ['usuario'] });
  assert.equal(u.rt.services['isc-dhcp-server'], true);
  const d = boot('Debian 12');
  out = await sh(d, 'sudo dhclient -v enp0s3', { answers: ['usuario'] });
  assert.match(out, /DHCPACK of 10\.10\.10\.100 from 10\.10\.10\.1/);
  await flush();
  const st = labStatus(LABS.find((l) => l.id === 'dhcpd'));
  assert.deepEqual(st.done, [true, true, true, true, true]);
});

test('Laboratorio «Router Linux»: todos los objetivos', async () => {
  fresh();
  startLab('router');
  const u = vmByName('Ubuntu Server');
  u.nics[1].attach = 'intnet';
  boot('Ubuntu Server');
  const d = boot('Debian 12');
  const su = (vm, line, user = 'usuario') => sh(vm, line, { user, answers: ['usuario'] });
  await su(u, 'sudo ip addr add 10.10.10.1/24 dev enp0s8');
  await su(d, 'sudo ip addr add 10.10.10.2/24 dev enp0s3');
  await su(d, 'sudo ip route add default via 10.10.10.1');
  await su(u, 'sudo sysctl -w net.ipv4.ip_forward=1');
  await su(u, 'sudo iptables -t nat -A POSTROUTING -o enp0s3 -j MASQUERADE');
  let out = await sh(d, 'ping -c 1 8.8.8.8');
  assert.match(out, /1 received/);
  out = await sh(d, 'ping -c 1 deb.debian.org');
  assert.match(out, /Temporary failure in name resolution/);
  await su(d, 'echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf');
  out = await sh(d, 'ping -c 1 deb.debian.org');
  assert.match(out, /1 received/);
  await flush();
  const st = labStatus(LABS.find((l) => l.id === 'router'));
  assert.ok(st.complete, `objetivos: ${st.done}`);
});

test('Instantánea en caliente: restaurar devuelve el disco y la memoria', async () => {
  fresh();
  const { takeSnapshot, restoreSnapshot, powerOff } = await import('../js/vmctl.js');
  const u = boot('Ubuntu Server');
  takeSnapshot(u, 'Base');
  await sh(u, 'sudo rm /etc/netplan/50-cloud-init.yaml', { answers: ['usuario'] });
  assert.equal(vmContent(state, u).files['/etc/netplan/50-cloud-init.yaml'], undefined);
  powerOff(u);
  const r = restoreSnapshot(u, u.snapshots[0].id);
  assert.ok(r.ok);
  assert.equal(u.state, 'saved');
  assert.ok(vmContent(state, u).files['/etc/netplan/50-cloud-init.yaml']);
});

test('Windows sin DHCP se autoasigna APIPA y la red solo anfitrión sin DHCP lo provoca', async () => {
  fresh();
  state.hostOnly[0].dhcp.enabled = false;
  const w = vmByName('Windows 10');
  w.nics[0].attach = 'hostonly';
  boot('Windows 10');
  const a = w.rt.ifaces[0].addrs[0];
  assert.match(a.ip, /^169\.254\./);
  const out = await cmd(w, 'ipconfig');
  assert.match(out, /Dirección IPv4 de configuración automática: 169\.254\./);
});

test('SSH: la clave de host cambia si otra máquina ocupa la misma IP', async () => {
  fresh();
  const { powerOff } = await import('../js/vmctl.js');
  vmByName('Kali Linux').nics[0].attach = 'hostonly';
  vmByName('Debian 12').nics[0].attach = 'hostonly';
  const u = boot('Ubuntu Server');
  const k = boot('Kali Linux');
  let out = await sh(k, 'ssh usuario@192.168.56.101', { user: 'kali', answers: ['yes', 'usuario'] });
  assert.match(out, /Welcome to Ubuntu/);
  powerOff(u);
  const d = boot('Debian 12');
  await sh(d, 'sudo ip addr add 192.168.56.101/24 dev enp0s3', { answers: ['usuario'] });
  out = await sh(k, 'ssh usuario@192.168.56.101', { user: 'kali', answers: ['usuario'] });
  assert.match(out, /REMOTE HOST IDENTIFICATION HAS CHANGED/);
});

test('Cable desconectado: NO-CARRIER y «Network is unreachable»', async () => {
  fresh();
  const { linkChanged } = await import('../js/net.js');
  const u = boot('Ubuntu Server');
  u.nics[0].cable = false;
  u.nics[1].cable = false;
  linkChanged(state, u);
  let out = await sh(u, 'ip link');
  assert.match(out, /enp0s3: <NO-CARRIER,BROADCAST,MULTICAST,UP>/);
  out = await sh(u, 'ping -c 1 8.8.8.8');
  assert.match(out, /Network is unreachable/);
  u.nics[0].cable = true;
  linkChanged(state, u);
  out = await sh(u, 'ping -c 1 8.8.8.8');
  assert.match(out, /1 received/, 'al reconectar, systemd-networkd renueva la concesión DHCP');
});

test('Firewall de Linux persistente (iptables-persistent) bloquea el ping tras reiniciar', async () => {
  fresh();
  const u = vmByName('Ubuntu Server');
  vmContent(state, u).files['/etc/iptables/rules.v4'] = '*filter\n-A INPUT -p icmp -j DROP\nCOMMIT\n';
  boot('Ubuntu Server');
  assert.equal(send(state, 'host', '192.168.56.101').status, 'timeout');
});

test('Todos los laboratorios tienen objetivos, pistas y código', () => {
  assert.ok(LABS.length >= 14);
  for (const l of LABS) {
    assert.ok(l.objectives.length >= 4, l.id);
    for (const o of l.objectives) { assert.ok(o.text && o.hint && typeof o.check === 'function', `${l.id}: ${o.text}`); }
    assert.match(l.flag, /^flag\{.+\}$/);
  }
  assert.equal(new Set(LABS.map((l) => l.flag)).size, LABS.length);
});
