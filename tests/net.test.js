import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, boot, sh, cmd, state, vmByName, commit, vmContent } from './helpers.js';
import { send, HOST_ID, topology } from '../js/net.js';

test('NAT: la VM obtiene 10.0.2.15 y sale a Internet a través del motor NAT', async () => {
  fresh();
  const u = boot('Ubuntu Server');
  const a = u.rt.ifaces[0].addrs[0];
  assert.equal(a.ip, '10.0.2.15');
  const r = send(state, u.id, '8.8.8.8');
  assert.equal(r.status, 'ok');
  assert.equal(r.hops[0].ip, '10.0.2.2');
  assert.ok(r.hops.some((h) => h.ip === '192.168.1.1'));
  const out = await sh(u, 'ping -c 2 8.8.8.8');
  assert.match(out, /64 bytes from dns.google \(8.8.8.8\): icmp_seq=1 ttl=117/);
  assert.match(out, /2 packets transmitted, 2 received, 0% packet loss/);
});

test('Solo anfitrión: DHCP 192.168.56.101, el anfitrión la alcanza y no hay Internet por esa interfaz', async () => {
  fresh();
  const u = boot('Ubuntu Server');
  const ho = u.rt.ifaces[1].addrs[0];
  assert.equal(ho.ip, '192.168.56.101');
  assert.equal(send(state, HOST_ID, '192.168.56.101').status, 'ok');
  assert.equal(send(state, HOST_ID, '10.0.2.15').status, 'timeout', 'el anfitrión no ve la red NAT privada');
  const out = await sh(u, 'ip route');
  assert.match(out, /default via 10.0.2.2 dev enp0s3 proto dhcp src 10.0.2.15 metric 100/);
  assert.doesNotMatch(out, /default via 192.168.56/);
});

test('Red interna sin DHCP: Debian sin IP; con IP estática se ven dos VMs', async () => {
  fresh();
  const d = boot('Debian 12');
  assert.equal(d.rt.ifaces[0].addrs.length, 0);
  let out = await sh(d, 'ping -c 1 8.8.8.8');
  assert.match(out, /Network is unreachable/);
  // Kali también a intnet
  const k = vmByName('Kali Linux');
  k.nics[0].attach = 'intnet';
  boot('Kali Linux');
  out = await sh(d, 'sudo ip addr add 10.10.10.1/24 dev enp0s3', { answers: ['usuario'] });
  assert.equal(out.replace(/\[sudo\].*\n?/, '').trim(), '');
  out = await sh(k, 'sudo ip addr add 10.10.10.2/24 dev enp0s3', { user: 'kali', answers: ['kali'] });
  out = await sh(k, 'ping -c 1 10.10.10.1', { user: 'kali' });
  assert.match(out, /1 received/);
});

test('ip addr add sin prefijo crea una /32 y no hay ruta a la red', async () => {
  fresh();
  const d = boot('Debian 12');
  await sh(d, 'sudo ip addr add 10.10.10.1 dev enp0s3', { answers: ['usuario'] });
  assert.equal(d.rt.ifaces[0].addrs[0].prefix, 32);
  const out = await sh(d, 'ping -c 1 10.10.10.2');
  assert.match(out, /Network is unreachable/);
});

test('Firewall de Windows bloquea el eco ICMP entrante hasta crear la regla', async () => {
  fresh();
  const w = vmByName('Windows 10');
  w.nics[0].attach = 'hostonly';
  boot('Windows 10');
  const ip = w.rt.ifaces[0].addrs[0].ip;
  assert.match(ip, /^192\.168\.56\./);
  assert.equal(send(state, HOST_ID, ip).status, 'timeout');
  let out = await cmd('host', `ping -n 1 ${ip}`);
  assert.match(out, /Tiempo de espera agotado/);
  out = await cmd(w, 'netsh advfirewall firewall add rule name="ICMP" protocol=icmpv4:8,any dir=in action=allow');
  assert.match(out, /Aceptar/);
  out = await cmd('host', `ping -n 1 ${ip}`);
  assert.match(out, new RegExp(`Respuesta desde ${ip.replace(/\./g, '\\.')}: bytes=32`));
});

test('Reenvío de puertos NAT: ssh -p 2222 desde el anfitrión llega al servidor', async () => {
  fresh();
  const u = vmByName('Ubuntu Server');
  u.nics[0].pf.push({ name: 'ssh', proto: 'tcp', hostIp: '', hostPort: 2222, guestIp: '', guestPort: 22 });
  boot('Ubuntu Server');
  const r = send(state, HOST_ID, '127.0.0.1', { proto: 'tcp', port: 2222 });
  assert.equal(r.status, 'ok');
  assert.equal(r.forwardedTo.vm.id, u.id);
  const out = await cmd('host', 'ssh -p 2222 usuario@127.0.0.1', { answers: ['yes', 'usuario'] });
  assert.match(out, /Welcome to Ubuntu 24.04.1 LTS/);
  const r2 = send(state, HOST_ID, '127.0.0.1', { proto: 'tcp', port: 2223 });
  assert.equal(r2.status, 'refused');
});

test('Router Linux: sin MASQUERADE el cliente de la red interna no sale; con MASQUERADE sí', async () => {
  fresh();
  const u = vmByName('Ubuntu Server');
  u.nics[1].attach = 'intnet';
  const c = vmContent(state, u);
  c.files['/etc/netplan/50-cloud-init.yaml'] = 'network:\n    version: 2\n    ethernets:\n        enp0s3:\n            dhcp4: true\n        enp0s8:\n            addresses: [10.10.10.1/24]\n';
  boot('Ubuntu Server');
  const d = boot('Debian 12');
  await sh(d, 'sudo ip addr add 10.10.10.2/24 dev enp0s3', { answers: ['usuario'] });
  await sh(d, 'sudo ip route add default via 10.10.10.1', { answers: ['usuario'] });
  assert.equal(send(state, d.id, '8.8.8.8').status, 'timeout', 'sin ip_forward');
  await sh(u, 'sudo sysctl -w net.ipv4.ip_forward=1', { answers: ['usuario'] });
  const r1 = send(state, d.id, '8.8.8.8');
  assert.equal(r1.status, 'timeout', 'sin MASQUERADE el motor NAT descarta el origen ajeno');
  assert.ok(r1.explain.some((e) => /MASQUERADE/.test(e)));
  await sh(u, 'sudo iptables -t nat -A POSTROUTING -o enp0s3 -j MASQUERADE', { answers: ['usuario'] });
  const r2 = send(state, d.id, '8.8.8.8');
  assert.equal(r2.status, 'ok');
  assert.deepEqual(r2.hops.slice(0, 2).map((h) => h.ip), ['10.10.10.1', '10.0.2.2']);
});

test('netplan: un tabulador produce error de YAML y una IP estática se aplica', async () => {
  fresh();
  const u = boot('Ubuntu Server');
  const c = vmContent(state, u);
  c.files['/etc/netplan/50-cloud-init.yaml'] = 'network:\n  version: 2\n  ethernets:\n\tenp0s3:\n      dhcp4: true\n';
  let out = await sh(u, 'sudo netplan apply', { answers: ['usuario'] });
  assert.match(out, /Invalid YAML/);
  c.files['/etc/netplan/50-cloud-init.yaml'] = 'network:\n  version: 2\n  ethernets:\n    enp0s3:\n      dhcp4: true\n    enp0s8:\n      addresses:\n        - 192.168.56.50/24\n';
  out = await sh(u, 'sudo netplan apply', { answers: ['usuario'] });
  assert.equal(u.rt.ifaces[1].addrs[0].ip, '192.168.56.50');
});

test('DNS: apt update falla sin DNS y funciona con NAT', async () => {
  fresh();
  const u = boot('Ubuntu Server');
  let out = await sh(u, 'sudo apt update', { answers: ['usuario'] });
  assert.match(out, /Fetched/);
  out = await sh(u, 'sudo apt install -y apache2', { answers: ['usuario'] });
  assert.match(out, /Setting up apache2/);
  out = await cmd('host', 'curl http://192.168.56.101');
  assert.match(out, /Apache2 Ubuntu Default Page/);
  const d = boot('Debian 12');
  out = await sh(d, 'sudo apt update', { answers: ['usuario'] });
  assert.match(out, /Temporary failure resolving 'deb.debian.org'/);
});

test('Clonar sin regenerar MAC en modo puente produce conflicto de IP', async () => {
  fresh();
  const { cloneVm } = await import('../js/vmctl.js');
  const u = vmByName('Ubuntu Server');
  u.nics[0].attach = 'bridged';
  u.nics[1].enabled = false;
  const c2 = cloneVm(u, { name: 'Ubuntu Clon', macPolicy: 'all' });
  boot('Ubuntu Server');
  boot('Ubuntu Clon');
  assert.equal(u.rt.ifaces[0].addrs[0].ip, c2.rt.ifaces[0].addrs[0].ip);
  const r = send(state, HOST_ID, u.rt.ifaces[0].addrs[0].ip);
  assert.equal(r.conflict, true);
});

test('Red NAT: dos VMs se ven entre sí y tienen Internet', async () => {
  fresh();
  state.natNets.push({ name: 'NatNetwork', cidr: '10.0.2.0/24', dhcp: true, enabled: true, pf: [] });
  const u = vmByName('Ubuntu Server'); u.nics[0].attach = 'natnet'; u.nics[1].enabled = false;
  const k = vmByName('Kali Linux'); k.nics[0].attach = 'natnet';
  boot('Ubuntu Server'); boot('Kali Linux');
  const ipU = u.rt.ifaces[0].addrs[0].ip; const ipK = k.rt.ifaces[0].addrs[0].ip;
  assert.equal(ipU, '10.0.2.4'); assert.equal(ipK, '10.0.2.5');
  assert.equal(send(state, k.id, ipU).status, 'ok');
  assert.equal(send(state, k.id, '1.1.1.1').status, 'ok');
  const out = await sh(k, 'nmap -sn 10.0.2.0/24', { user: 'kali' });
  assert.match(out, /Nmap scan report for 10.0.2.4/);
});

test('VBoxManage: no está en el PATH y funciona desde su carpeta', async () => {
  fresh();
  let out = await cmd('host', 'VBoxManage list vms');
  assert.match(out, /no se reconoce como un comando interno/);
  const sess = { kind: 'host', user: 'alumno', cwd: 'C:\\Users\\alumno', admin: true };
  await cmd('host', 'cd "C:\\Program Files\\Oracle\\VirtualBox"', { sess });
  out = await cmd('host', 'VBoxManage list vms', { sess });
  assert.match(out, /"Ubuntu Server" \{/);
  out = await cmd('host', 'VBoxManage modifyvm "Ubuntu Server" --natpf1 "web,tcp,,8080,,80"', { sess });
  assert.equal(vmByName('Ubuntu Server').nics[0].pf[0].hostPort, 8080);
  out = await cmd('host', 'VBoxManage natnetwork add --netname RedLab --network "10.20.0.0/24" --enable --dhcp on', { sess });
  assert.equal(state.natNets[0].name, 'RedLab');
});
