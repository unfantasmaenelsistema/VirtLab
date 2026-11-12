// Motor de red de VirtLab: topología real por segmentos, tablas de rutas, ARP, NAT,
// reenvío de puertos, DHCP y DNS. Todas las respuestas (ping, traceroute, curl, ssh,
// nmap...) salen de simular el paquete salto a salto, no de una tabla precalculada.
import { ipToInt, intToIp, isIp, sameNet, isLoopback, isPublic, hashStr, networkAddr, prefixToMask } from './util.js';
import { PUBLIC_HOSTS, DNS_PUBLIC, ISP_HOPS, LINUX_IFNAMES, WIN_IFNAMES, OS_TYPES } from './catalog.js';
import { linuxDesiredConfig, sysctlForward, SERVICE_PORTS } from './guest.js';

export const HOST_ID = 'host';

const vmContent = (st, vm) => {
  const slot = vm.storage.flatMap((c) => c.slots).find((s) => s.kind === 'hdd' && s.medium);
  const m = slot && st.media.hdd.find((x) => x.id === slot.medium);
  return m?.content || null;
};
export { vmContent };

export function natNetOf(st, name) { return st.natNets.find((n) => n.name === name); }
export function hostOnlyOf(st, name) { return st.hostOnly.find((h) => h.name === name); }

// ---------------------------------------------------------------- enlace físico
export function linkOf(st, vm, nic) {
  if (!nic?.enabled) return { up: false, seg: null, reason: 'Adaptador deshabilitado' };
  if (!nic.cable) return { up: false, seg: null, reason: 'Cable desconectado' };
  switch (nic.attach) {
    case 'nat': return { up: true, seg: `nat:${vm.id}:${nic.slot}` };
    case 'natnet': {
      const n = natNetOf(st, nic.natnet);
      if (!n || n.enabled === false) return { up: false, seg: null, reason: `La red NAT «${nic.natnet}» no existe` };
      return { up: true, seg: `natnet:${n.name}` };
    }
    case 'bridged': {
      const isWifi = /wi-?fi/i.test(nic.bridged || '');
      const hif = isWifi ? st.host.wifi : st.host.eth;
      if (!hif?.up) return { up: false, seg: null, reason: `La interfaz del anfitrión «${nic.bridged}» no tiene conexión` };
      return { up: true, seg: 'lan' };
    }
    case 'intnet': return { up: true, seg: `intnet:${nic.intnet || 'intnet'}` };
    case 'hostonly': {
      const h = hostOnlyOf(st, nic.hostonly);
      if (!h) return { up: false, seg: null, reason: `No existe la interfaz solo anfitrión «${nic.hostonly}»` };
      return { up: true, seg: `hostonly:${h.name}` };
    }
    case 'none': return { up: false, seg: null, reason: 'No conectado' };
    default: return { up: false, seg: null, reason: 'Modo no simulado en VirtLab' };
  }
}

export const natNetIndex = (slot) => slot + 2; // NAT del adaptador 1 → 10.0.2.0/24, adaptador 2 → 10.0.3.0/24...
export const natPrefix = (slot) => `10.0.${natNetIndex(slot)}`;

export function segLabel(st, seg) {
  if (!seg) return '—';
  if (seg === 'lan') return 'LAN física 192.168.1.0/24 (adaptador puente)';
  const [k, a, b] = seg.split(':');
  if (k === 'nat') { const vm = st.vms.find((v) => v.id === a); return `NAT privada de «${vm?.name}» (adaptador ${Number(b) + 1})`; }
  if (k === 'natnet') return `Red NAT «${a}»`;
  if (k === 'intnet') return `Red interna «${a}»`;
  if (k === 'hostonly') return `Red solo anfitrión «${a}»`;
  return seg;
}

// ---------------------------------------------------------------- nodos
function vmNode(st, vm) {
  if (!vm.rt || (vm.state !== 'running' && vm.state !== 'paused')) return null;
  const content = vmContent(st, vm);
  const os = OS_TYPES[content?.os]?.family || 'other';
  const ifaces = vm.rt.ifaces.map((i) => {
    const nic = vm.nics[i.slot];
    const L = linkOf(st, vm, nic);
    return { name: i.name, slot: i.slot, mac: nic.mac, seg: L.seg, link: L.up && i.admin === 'up' && !i.mediaDisconnected, addrs: i.addrs.filter((a) => !a.dup) };
  });
  return {
    id: vm.id, kind: 'vm', name: vm.name, vm, os, ifaces, routes: vm.rt.routes || [], ttl0: os === 'windows' ? 128 : 64,
    paused: vm.state === 'paused', forward: os === 'linux' ? vm.rt.ipForward === 1 && (vm.rt.ipt?.policy?.FORWARD || 'ACCEPT') === 'ACCEPT' : false,
    masq: (vm.rt.ipt?.nat || []).filter((r) => r.target === 'MASQUERADE').map((r) => r.out),
  };
}

function hostNode(st) {
  const h = st.host;
  const ifaces = [];
  if (h.eth.up) ifaces.push({ name: 'Ethernet', seg: 'lan', link: true, addrs: [{ ip: h.eth.ip, prefix: h.eth.prefix }], mac: h.eth.mac });
  if (h.wifi.up && h.wifi.ip) ifaces.push({ name: 'Wi-Fi', seg: 'lan', link: true, addrs: [{ ip: h.wifi.ip, prefix: 24 }], mac: h.wifi.mac });
  st.hostOnly.forEach((ho) => ifaces.push({ name: ho.name, seg: `hostonly:${ho.name}`, link: true, addrs: [{ ip: ho.ip, prefix: ho.prefix }], mac: '0A0027000000' }));
  const routes = [];
  const up = h.eth.up ? 'Ethernet' : h.wifi.up ? 'Wi-Fi' : null;
  if (up) routes.push({ dst: '0.0.0.0', prefix: 0, via: h.eth.gw, dev: up, metric: 25 });
  return { id: HOST_ID, kind: 'host', name: st.host.name, os: 'windows', ifaces, routes, ttl0: 128, forward: false, masq: [] };
}

function routerNode(st) {
  const r = st.lan.router;
  return { id: 'router', kind: 'router', name: 'Router del aula', os: 'router', ifaces: [{ name: 'lan', seg: 'lan', link: true, addrs: [{ ip: r.ip, prefix: 24 }], mac: r.mac }, { name: 'wan', seg: 'wan', link: true, addrs: [{ ip: r.wan, prefix: 32 }] }], routes: [], ttl0: 64, forward: true, masq: ['wan'] };
}

function natEngines(st, vms) {
  const out = [];
  for (const vm of vms) {
    if (!vm.rt) continue;
    vm.nics.forEach((nic) => {
      if (!nic.enabled || nic.attach !== 'nat') return;
      const p = natPrefix(nic.slot);
      out.push({ id: `nat:${vm.id}:${nic.slot}`, kind: 'natengine', name: `Motor NAT de VirtualBox (${vm.name}, adaptador ${nic.slot + 1})`, os: 'router',
        ifaces: [{ name: 'inside', seg: `nat:${vm.id}:${nic.slot}`, link: true, addrs: [{ ip: `${p}.2`, prefix: 24 }, { ip: `${p}.3`, prefix: 24 }, { ip: `${p}.4`, prefix: 24 }], mac: '525400123502' }],
        routes: [], ttl0: 64, forward: true, masq: [], net: `${p}.0`, prefix: 24, dns: `${p}.3`, gw: `${p}.2`, pf: nic.pf || [], vmId: vm.id, slot: nic.slot, guestDefault: `${p}.15` });
    });
  }
  for (const n of st.natNets) {
    if (n.enabled === false) continue;
    const [net, pfx] = n.cidr.split('/');
    const base = intToIp(ipToInt(net) & 0xffffff00);
    const b3 = base.split('.').slice(0, 3).join('.');
    out.push({ id: `natnet:${n.name}`, kind: 'natengine', name: `Red NAT «${n.name}»`, os: 'router',
      ifaces: [{ name: 'inside', seg: `natnet:${n.name}`, link: true, addrs: [{ ip: `${b3}.1`, prefix: Number(pfx) }], mac: '525400123501' }],
      routes: [], ttl0: 64, forward: true, masq: [], net: base, prefix: Number(pfx), dns: `${b3}.1`, gw: `${b3}.1`, pf: n.pf || [], natnet: n.name });
  }
  return out;
}

export function topology(st) {
  const nodes = new Map();
  const add = (n) => n && nodes.set(n.id, n);
  add(hostNode(st));
  add(routerNode(st));
  st.lan.devices.forEach((d) => add({ id: `dev:${d.ip}`, kind: 'device', name: d.name, os: d.os, ifaces: [{ name: 'eth0', seg: 'lan', link: true, addrs: [{ ip: d.ip, prefix: 24 }], mac: d.mac }], routes: [{ dst: '0.0.0.0', prefix: 0, via: st.lan.router.ip, dev: 'eth0' }], ttl0: d.os === 'windows' ? 128 : d.os === 'printer' ? 255 : 64, forward: false, masq: [], ports: d.ports }));
  const vms = st.vms.filter((v) => v.rt && (v.state === 'running' || v.state === 'paused'));
  vms.forEach((v) => add(vmNode(st, v)));
  natEngines(st, vms).forEach(add);
  add({ id: 'internet', kind: 'internet', name: 'Internet', os: 'internet', ifaces: [], routes: [], ttl0: 64, forward: true, masq: [] });
  const segs = new Map();
  for (const n of nodes.values()) for (const i of n.ifaces) {
    if (!i.link || !i.seg) continue;
    if (!segs.has(i.seg)) segs.set(i.seg, []);
    segs.get(i.seg).push({ node: n, iface: i });
  }
  return { nodes, segs, st };
}

// ---------------------------------------------------------------- rutas
export function owns(n, ip) {
  if (n.kind === 'internet') return isPublic(ip) && ip !== n._wan;
  if ((n.kind === 'vm' || n.kind === 'host') && isLoopback(ip)) return true;
  return n.ifaces.some((i) => i.addrs.some((a) => a.ip === ip));
}

export function connectedRoutes(n) {
  const out = [];
  for (const i of n.ifaces) {
    if (!i.link) continue;
    for (const a of i.addrs) if (a.prefix < 32) out.push({ dst: networkAddr(a.ip, a.prefix), prefix: a.prefix, via: null, dev: i.name, src: a.ip, seg: i.seg, metric: 0, proto: 'kernel' });
  }
  return out;
}

export function route(T, n, dst) {
  if (n.kind === 'internet') {
    const wan = T.st.lan.router.wan;
    if (dst === wan) return { seg: 'wan', via: null, dev: 'isp', src: null };
    return null;
  }
  if (n.kind === 'natengine') {
    if (sameNet(dst, n.net, n.prefix)) return { seg: n.ifaces[0].seg, via: null, dev: 'inside', src: n.gw };
    return { special: 'host' };
  }
  if (n.kind === 'router') {
    const c = connectedRoutes(n).find((r) => sameNet(dst, r.dst, r.prefix) && r.dev === 'lan');
    if (c) return c;
    return { special: 'internet', src: T.st.lan.router.wan };
  }
  const cands = connectedRoutes(n);
  for (const r of n.routes) {
    const i = n.ifaces.find((x) => x.name === r.dev);
    if (!i || !i.link) continue;
    const src = i.addrs.find((a) => r.via && sameNet(r.via, a.ip, a.prefix));
    if (r.via && !src) continue; // la pasarela debe estar en una red directamente conectada
    cands.push({ ...r, seg: i.seg, src: (src || i.addrs[0])?.ip });
  }
  const m = cands.filter((r) => r.src && sameNet(dst, r.dst, r.prefix));
  if (!m.length) return null;
  m.sort((a, b) => b.prefix - a.prefix || (a.metric || 0) - (b.metric || 0));
  return m[0];
}

const SEG_LAT = { nat: 0.25, natnet: 0.35, intnet: 0.4, hostonly: 0.45, lan: 1.2, wan: 3 };
const segLat = (seg) => SEG_LAT[String(seg).split(':')[0]] ?? 0.5;

// ---------------------------------------------------------------- cortafuegos y servicios
function inputVerdict(T, n, proto, port, srcIp) {
  if (n.kind === 'host') {
    if (proto === 'icmp') return T.st.host.icmpIn ? 'accept' : 'drop';
    return 'accept';
  }
  if (n.kind !== 'vm') return 'accept';
  const vm = n.vm;
  const c = vmContent(T.st, vm);
  if (n.os === 'windows') {
    const fw = c?.win?.fw;
    const profileOn = fw && (fw.public || fw.private || fw.domain);
    if (!profileOn) return 'accept';
    if (proto === 'icmp') return fw.icmp || fw.rules.some((r) => r.dir === 'in' && r.action === 'allow' && r.proto === 'icmpv4') ? 'accept' : 'drop';
    if (proto === 'tcp') {
      if (port === 3389 && c.win.rdp) return 'accept';
      return fw.rules.some((r) => r.dir === 'in' && r.action === 'allow' && r.proto === 'tcp' && (String(r.port) === String(port) || r.port === 'any')) ? 'accept' : 'drop';
    }
    return 'drop';
  }
  // Linux: iptables (INPUT) y después ufw
  const ipt = vm.rt.ipt;
  if (ipt) {
    for (const r of ipt.INPUT || []) {
      if (r.proto && r.proto !== 'all' && r.proto !== proto) continue;
      if (r.dport && String(r.dport) !== String(port)) continue;
      if (r.src && !sameNet(srcIp || '0.0.0.0', r.src.split('/')[0], Number(r.src.split('/')[1] ?? 32))) continue;
      if (r.target === 'ACCEPT') return 'accept';
      if (r.target === 'DROP') return 'drop';
      if (r.target === 'REJECT') return 'reject';
    }
    if (ipt.policy?.INPUT === 'DROP') return 'drop';
  }
  if (vm.rt.ufw?.enabled) {
    if (proto === 'icmp') return 'accept'; // ufw permite ICMP echo por defecto (before.rules)
    const rules = vm.rt.ufw.rules || [];
    const hit = rules.find((r) => (String(r.port) === String(port) || (r.service && (SERVICE_PORTS[r.service] || []).includes(port))) && (!r.proto || r.proto === proto));
    if (hit) return hit.action === 'allow' ? 'accept' : hit.action === 'reject' ? 'reject' : 'drop';
    return vm.rt.ufw.incoming === 'allow' ? 'accept' : 'drop';
  }
  return 'accept';
}

export function listening(T, n, proto, port) {
  if (n.kind === 'device') return proto === 'tcp' && (n.ports || []).includes(port);
  if (n.kind === 'natengine') return proto === 'udp' && port === 53;
  if (n.kind === 'router') return (proto === 'udp' && port === 53) || (proto === 'tcp' && (port === 80 || port === 443 || port === 53));
  if (n.kind === 'host') return proto === 'tcp' && ((port === 22 && T.st.host.sshd) || port === 135 || port === 445);
  if (n.kind === 'vm') return vmListening(T.st, n.vm).some((l) => l.proto === proto && l.port === port);
  return false;
}

export function vmListening(st, vm) {
  const out = [];
  const svc = vm.rt?.services || {};
  const c = vmContent(st, vm);
  if (!c) return out;
  if (OS_TYPES[c.os]?.family === 'windows') {
    out.push({ proto: 'tcp', port: 135, svc: 'RpcSs' }, { proto: 'tcp', port: 445, svc: 'System' }, { proto: 'tcp', port: 139, svc: 'System' });
    if (c.win.rdp) out.push({ proto: 'tcp', port: 3389, svc: 'TermService' });
    return out;
  }
  out.push({ proto: 'udp', port: 68, svc: 'dhclient', addr: '0.0.0.0' });
  if (c.os === 'ubuntu') out.push({ proto: 'tcp', port: 53, svc: 'systemd-resolve', addr: '127.0.0.53' }, { proto: 'udp', port: 53, svc: 'systemd-resolve', addr: '127.0.0.53' });
  if (svc.ssh) out.push({ proto: 'tcp', port: 22, svc: 'sshd' });
  if (svc.apache2) out.push({ proto: 'tcp', port: 80, svc: 'apache2' });
  if (svc.nginx) out.push({ proto: 'tcp', port: 80, svc: 'nginx' });
  if (svc['isc-dhcp-server']) out.push({ proto: 'udp', port: 67, svc: 'dhcpd' });
  for (const l of vm.rt.listeners || []) out.push(l);
  return out;
}

// reglas de reenvío de puertos activas en el anfitrión (la primera VM que reclama el puerto lo obtiene)
export function activePortForwards(st) {
  const T = topology(st);
  const used = new Map();
  for (const n of T.nodes.values()) {
    if (n.kind !== 'natengine') continue;
    for (const r of n.pf || []) {
      const hp = Number(r.hostPort);
      if (!hp) continue;
      const key = `${r.proto || 'tcp'}:${hp}`;
      if (used.has(key)) { used.get(key).conflicts.push({ engine: n, rule: r }); continue; }
      used.set(key, { engine: n, rule: r, conflicts: [] });
    }
  }
  return used;
}

// ---------------------------------------------------------------- envío de paquetes
// opts: { proto:'icmp'|'tcp'|'udp', port, srcIp, maxHops, reply }
export function send(st, fromId, dstIp, opts = {}) {
  const T = opts.T || topology(st);
  T.nodes.get('internet')._wan = st.lan.router.wan;
  const proto = opts.proto || 'icmp';
  const port = opts.port;
  const origin = T.nodes.get(fromId);
  const res = { status: 'ok', hops: [], path: [], srcIp: null, errFrom: null, rtt: 0, ttl: null, target: null, conflict: false, nat: [], arp: [], explain: [] };
  const say = (t) => res.explain.push(t);
  if (!origin) { res.status = 'noroute'; say('El equipo de origen no está encendido.'); return res; }
  if (!isIp(dstIp)) { res.status = 'badaddr'; return res; }

  let cur = origin;
  let srcIp = opts.srcIp || null;
  let ingressIp = null;
  let rtt = 0;
  res.path.push({ id: origin.id, name: origin.name, ip: null });

  for (let guard = 0; guard < 40; guard++) {
    if (owns(cur, dstIp)) return arrive(cur);
    const r = route(T, cur, dstIp);
    if (!r) {
      if (cur === origin) { res.status = 'noroute'; say(`${origin.name} no tiene ninguna ruta hacia ${dstIp}: ni una red conectada que lo contenga ni puerta de enlace por defecto utilizable.`); }
      else { res.status = 'net_unreach'; res.errFrom = ingressIp; say(`${cur.name} (${ingressIp}) recibe el paquete pero no tiene ruta hacia ${dstIp} y responde «Destination Net Unreachable».`); }
      return res;
    }
    if (cur === origin && !srcIp) srcIp = r.src || null;
    if (cur === origin) res.srcIp = srcIp;

    if (r.special === 'host') {
      // Motor NAT de VirtualBox: el tráfico sale como si lo generara el propio anfitrión
      if (!sameNet(srcIp, cur.net, cur.prefix)) {
        res.status = 'timeout';
        say(`${cur.name} descarta el paquete: su origen ${srcIp} no pertenece a ${cur.net}/${cur.prefix}. Hace falta enmascarar (MASQUERADE) en el router intermedio.`);
        return res;
      }
      if (cur === origin) res.hops.push({ ip: cur.gw, name: cur.name });
      res.nat.push(`${srcIp} → ${hostSrcFor(T, dstIp) || st.host.eth.ip} (NAT de VirtualBox)`);
      say(`${cur.name} traduce la dirección de origen (${srcIp}) y reenvía la conexión desde el anfitrión ${st.host.name}.`);
      const host = T.nodes.get(HOST_ID);
      if (dstIp === st.host.eth.ip || host.ifaces.some((i) => i.addrs.some((a) => a.ip === dstIp))) {
        srcIp = '127.0.0.1';
        cur = host;
        continue;
      }
      const hr = route(T, host, dstIp);
      srcIp = hr?.src || st.host.eth.ip;
      cur = host;
      rtt += 0.15;
      res.path.push({ id: host.id, name: host.name, ip: srcIp, nat: true });
      continue;
    }
    if (r.special === 'internet') {
      res.nat.push(`${srcIp} → ${st.lan.router.wan} (NAT del router)`);
      srcIp = st.lan.router.wan;
      if (!isPublic(dstIp)) {
        res.status = 'timeout';
        say(`El router del aula envía ${dstIp} (dirección privada) hacia el proveedor, que la descarta: las redes privadas no se enrutan en Internet.`);
        res.hops.push({ ip: ISP_HOPS[0], name: 'Proveedor (CGNAT)' });
        return res;
      }
      for (const h of ISP_HOPS) { res.hops.push({ ip: h, name: 'Internet' }); rtt += 1.5 + (hashStr(h + dstIp) % 30) / 10; }
      cur = T.nodes.get('internet');
      rtt += 8;
      res.path.push({ id: 'internet', name: 'Internet', ip: null });
      continue;
    }

    const nextIp = r.via || dstIp;
    const members = (T.segs.get(r.seg) || []).filter((m) => m.node !== cur && m.iface.addrs.some((a) => a.ip === nextIp));
    if (!members.length) {
      res.status = 'host_unreach';
      res.errFrom = cur === origin ? srcIp : ingressIp;
      if (cur === origin) res.arp.push({ ip: nextIp, dev: r.dev, state: 'FAILED' });
      say(r.via
        ? `${cur.name} intenta enviar a su puerta de enlace ${r.via} por ${r.dev}, pero nadie responde a la petición ARP en ${segLabel(st, r.seg)}.`
        : `${cur.name} pregunta por ARP «¿quién tiene ${nextIp}?» en ${segLabel(st, r.seg)} y nadie contesta: ese equipo no está en ese segmento (o está apagado).`);
      return res;
    }
    let pick = members[0];
    if (members.length > 1) {
      res.conflict = true;
      pick = members[Math.floor(Math.random() * members.length)];
      say(`¡Conflicto! ${members.length} equipos responden al ARP de ${nextIp} en ${segLabel(st, r.seg)} (${members.map((m) => m.node.name).join(', ')}). El tráfico se reparte de forma impredecible.`);
    }
    if (cur === origin) res.arp.push({ ip: nextIp, dev: r.dev, mac: pick.iface.mac, state: 'REACHABLE' });
    if (cur !== origin && cur.masq?.includes(r.dev)) {
      const myIp = cur.ifaces.find((i) => i.name === r.dev)?.addrs[0]?.ip;
      if (myIp) { res.nat.push(`${srcIp} → ${myIp} (MASQUERADE en ${cur.name})`); srcIp = myIp; }
    }
    rtt += segLat(r.seg);
    const next = pick.node;
    const nextIngress = pick.iface.addrs.find((a) => sameNet(nextIp, a.ip, a.prefix))?.ip || nextIp;
    if (owns(next, dstIp)) { res.path.push({ id: next.id, name: next.name, ip: nextIngress }); cur = next; ingressIp = nextIngress; continue; }
    if (next.paused) { res.status = 'timeout'; say(`${next.name} está en pausa y no procesa paquetes.`); return res; }
    if (!next.forward && next.kind !== 'natengine') {
      res.status = 'timeout';
      say(next.kind === 'vm'
        ? `${next.name} recibe el paquete en ${nextIngress} pero no reenvía tráfico (net.ipv4.ip_forward=0), así que lo descarta en silencio.`
        : `${next.name} recibe el paquete pero no actúa como router; lo descarta.`);
      return res;
    }
    res.hops.push({ ip: nextIngress, name: next.name });
    res.path.push({ id: next.id, name: next.name, ip: nextIngress });
    if (opts.maxHops && res.hops.length >= opts.maxHops) { res.status = 'ttl'; return res; }
    say(`${next.name} (${nextIngress}) reenvía el paquete.`);
    cur = next;
    ingressIp = nextIngress;
  }
  res.status = 'timeout';
  return res;

  function arrive(node) {
    res.target = node;
    res.rtt = rtt + (node === origin ? 0.03 : 0.2);
    if (node === origin) { res.srcIp = res.srcIp || (isLoopback(dstIp) ? '127.0.0.1' : dstIp); }
    if (node.kind === 'internet') {
      const h = PUBLIC_HOSTS[dstIp];
      if (!h) { res.status = 'timeout'; say(`El paquete llega a Internet, pero ${dstIp} no responde.`); return res; }
      if (proto === 'tcp' && !h.ports.includes(port)) { res.status = 'timeout'; say(`${dstIp} no acepta conexiones en el puerto ${port} (filtrado).`); return res; }
      res.ttl = h.ttl;
      say(`${h.name || dstIp} responde y la respuesta vuelve deshaciendo las traducciones NAT.`);
      return res;
    }
    if (node.paused) { res.status = 'timeout'; say(`${node.name} está en pausa.`); return res; }
    if (opts.reply) return res;
    if (node !== origin) {
      const v = inputVerdict(T, node, proto, port, srcIp);
      if (v === 'drop') {
        res.status = 'timeout';
        say(node.os === 'windows' && node.kind === 'vm'
          ? `El Firewall de Windows de ${node.name} descarta el ${proto === 'icmp' ? 'eco ICMP (por defecto no se permite «Eco ICMPv4 entrante»)' : `tráfico al puerto ${port}`}.`
          : `El cortafuegos de ${node.name} descarta el paquete.`);
        return res;
      }
      if (v === 'reject') { res.status = proto === 'icmp' ? 'admin' : 'refused'; say(`El cortafuegos de ${node.name} rechaza la conexión (REJECT).`); return res; }
    }
    if (proto === 'tcp' || proto === 'udp') {
      if (node.kind === 'host' && proto === 'tcp') {
        const pf = activePortForwards(st).get(`tcp:${port}`);
        const rule = pf?.rule;
        const hostIpOk = rule && (!rule.hostIp || rule.hostIp === '0.0.0.0' || rule.hostIp === dstIp || (rule.hostIp === '127.0.0.1' && isLoopback(dstIp)));
        if (pf && hostIpOk) {
          const eng = pf.engine;
          const guestIp = rule.guestIp || eng.guestDefault;
          say(`El anfitrión tiene una regla de reenvío de puertos «${rule.name}»: ${dstIp}:${port} → ${guestIp}:${rule.guestPort} (${eng.name}).`);
          if (!guestIp) { res.status = 'refused'; return res; }
          const inner = send(st, eng.id, guestIp, { proto, port: Number(rule.guestPort), srcIp: eng.gw, T });
          inner.explain = [...res.explain, ...inner.explain];
          inner.hops = [...res.hops, ...inner.hops];
          inner.path = [...res.path, ...inner.path];
          inner.srcIp = res.srcIp;
          inner.forwardedTo = { vm: eng.vmId ? st.vms.find((v) => v.id === eng.vmId) : null, natnet: eng.natnet, guestIp, guestPort: Number(rule.guestPort) };
          inner.rtt += rtt;
          return inner;
        }
      }
      if (node.kind === 'natengine' && proto === 'tcp' && dstIp === node.gw) {
        // 10.0.2.2 es el loopback del anfitrión visto desde la VM
        return send(st, HOST_ID, '127.0.0.1', { proto, port, T });
      }
      if (!listening(T, node, proto, port)) {
        res.status = node.os === 'windows' && node.kind === 'vm' ? 'timeout' : 'refused';
        say(`${node.name} no tiene ningún servicio escuchando en ${proto.toUpperCase()}/${port}${res.status === 'refused' ? ' y contesta con RST (conexión rechazada)' : ''}.`);
        return res;
      }
    }
    if (node !== origin && srcIp && !isLoopback(srcIp)) {
      const back = send(st, node.id, srcIp, { reply: true, T });
      if (back.status !== 'ok') {
        res.status = 'timeout';
        say(`${node.name} recibe el paquete y responde, pero no tiene ruta de vuelta hacia ${srcIp}: la respuesta se pierde.`);
        return res;
      }
    }
    res.ttl = node.ttl0 - res.hops.length;
    if (node !== origin) say(`${node.name} recibe el paquete y la respuesta vuelve por el mismo camino.`);
    return res;
  }
}

function hostSrcFor(T, dst) {
  const r = route(T, T.nodes.get(HOST_ID), dst);
  return r?.src;
}

// Atajo para la VM o el anfitrión
export const nodeIdOf = (vmOrHost) => (vmOrHost === 'host' || !vmOrHost ? HOST_ID : vmOrHost.id);

// ---------------------------------------------------------------- DHCP
export function dhcpServerFor(st, vm, slot) {
  const nic = vm.nics[slot];
  const L = linkOf(st, vm, nic);
  if (!L.up) return null;
  const [kind, name] = L.seg.split(':');
  if (kind === 'nat') {
    const p = natPrefix(slot);
    return { key: L.seg, server: `${p}.2`, fixed: `${p}.15`, prefix: 24, gw: `${p}.2`, dns: [`${p}.3`], domain: 'home', lease: 86400, label: 'servidor DHCP del motor NAT' };
  }
  if (kind === 'natnet') {
    const n = natNetOf(st, name);
    if (!n?.dhcp) return null;
    const [net, pfx] = n.cidr.split('/');
    const b3 = net.split('.').slice(0, 3).join('.');
    return { key: L.seg, server: `${b3}.3`, lower: `${b3}.4`, upper: `${b3}.254`, prefix: Number(pfx), gw: `${b3}.1`, dns: [`${b3}.1`], lease: 1200, label: `servidor DHCP de la red NAT «${n.name}»` };
  }
  if (kind === 'hostonly') {
    const h = hostOnlyOf(st, name);
    if (!h?.dhcp?.enabled) return null;
    return { key: L.seg, server: h.dhcp.server, lower: h.dhcp.lower, upper: h.dhcp.upper, prefix: h.prefix, gw: null, dns: [], lease: 1200, label: `servidor DHCP de «${h.name}»` };
  }
  if (kind === 'lan') {
    const r = st.lan.router;
    return { key: 'lan', server: r.ip, lower: r.dhcp.lower, upper: r.dhcp.upper, prefix: 24, gw: r.ip, dns: [r.ip], lease: 86400, label: 'router del aula (192.168.1.1)' };
  }
  if (kind === 'intnet') {
    const d = st.intnetDhcp.find((x) => x.network === name && x.enabled !== false);
    if (d) return { key: L.seg, server: d.server, lower: d.lower, upper: d.upper, prefix: d.prefix || 24, gw: d.gw || null, dns: d.dns || [], lease: 1200, label: `servidor DHCP de VirtualBox para «${name}»` };
    // ¿alguna VM del mismo segmento ejecuta isc-dhcp-server con una subred válida?
    const T = topology(st);
    for (const m of T.segs.get(L.seg) || []) {
      if (m.node.kind !== 'vm' || m.node.vm === vm) continue;
      const cfg = m.node.vm.rt?.dhcpd;
      if (!m.node.vm.rt?.services?.['isc-dhcp-server'] || !cfg) continue;
      const a = m.iface.addrs[0];
      if (!a || !cfg.ifaces.includes(m.iface.name)) continue;
      const sub = cfg.subnets.find((s) => sameNet(a.ip, s.net, s.prefix));
      if (!sub) continue;
      return { key: `${L.seg}@${m.node.vm.id}`, server: a.ip, lower: sub.lower, upper: sub.upper, prefix: sub.prefix, gw: sub.routers || null, dns: sub.dns || [], lease: 600, label: `isc-dhcp-server de «${m.node.vm.name}»` };
    }
  }
  return null;
}

export function dhcpLease(st, vm, slot) {
  const s = dhcpServerFor(st, vm, slot);
  if (!s) return null;
  const mac = vm.nics[slot].mac;
  if (s.fixed) return { ...s, ip: s.fixed };
  st.leases[s.key] ||= {};
  const db = st.leases[s.key];
  if (db[mac]) return { ...s, ip: db[mac] };
  const used = new Set(Object.values(db));
  for (let n = ipToInt(s.lower); n <= ipToInt(s.upper); n++) {
    const ip = intToIp(n);
    if (!used.has(ip)) { db[mac] = ip; return { ...s, ip }; }
  }
  return null; // ámbito agotado
}

// ---------------------------------------------------------------- arranque de la red del invitado
export function apipa(mac) {
  const h = hashStr(mac);
  return `169.254.${1 + (h % 254)}.${1 + ((h >>> 8) % 254)}`;
}

export function ifaceNames(content) {
  return OS_TYPES[content?.os]?.family === 'windows' ? WIN_IFNAMES : LINUX_IFNAMES;
}

// Aplica la configuración persistente del invitado a una interfaz (DHCP o estática)
export function configureIface(st, vm, iface, cfg, family) {
  const linkUp = linkOf(st, vm, vm.nics[iface.slot]).up;
  iface.addrs = iface.addrs.filter((a) => a.manual); // conserva lo añadido a mano con ip addr
  vm.rt.routes = vm.rt.routes.filter((r) => r.dev !== iface.name || r.proto === 'static-manual');
  iface.dns = [];
  iface.lease = null;
  iface.cfg = cfg;
  if (!cfg) { iface.admin = family === 'windows' ? 'up' : 'down'; return; }
  iface.admin = 'up';
  if (family === 'windows') iface.mediaDisconnected = !linkUp;
  for (const a of cfg.addresses || []) iface.addrs.push({ ip: a.ip, prefix: a.prefix, dyn: false });
  if (cfg.gateway) vm.rt.routes.push({ dst: '0.0.0.0', prefix: 0, via: cfg.gateway, dev: iface.name, proto: 'static', metric: family === 'windows' ? 25 : 0 });
  for (const r of cfg.routes || []) vm.rt.routes.push({ ...r, dev: iface.name, proto: 'static', metric: 0 });
  iface.dns = [...(cfg.dns || [])];
  if (cfg.dhcp4 && linkUp) {
    const l = dhcpLease(st, vm, iface.slot);
    if (l) {
      iface.lease = { server: l.server, ip: l.ip, prefix: l.prefix, gw: l.gw, dns: l.dns, at: Date.now(), time: l.lease, label: l.label };
      iface.addrs.push({ ip: l.ip, prefix: l.prefix, dyn: true });
      if (l.gw) vm.rt.routes.push({ dst: '0.0.0.0', prefix: 0, via: l.gw, dev: iface.name, proto: 'dhcp', metric: family === 'windows' ? 25 : 100 + iface.slot });
      if (!cfg.dns?.length) iface.dns = [...l.dns];
    } else if (family === 'windows') {
      iface.addrs.push({ ip: apipa(vm.nics[iface.slot].mac), prefix: 16, dyn: true, apipa: true });
    }
  }
  if (family === 'windows' && !linkUp) iface.addrs = [];
}

export function bootNetwork(st, vm, content) {
  const family = OS_TYPES[content.os]?.family;
  const names = ifaceNames(content);
  vm.rt.routes = [];
  vm.rt.ifaces = vm.nics.filter((n) => n.enabled).map((n) => ({ slot: n.slot, name: names[n.slot], admin: 'down', addrs: [], dns: [] }));
  vm.rt.netError = null;
  if (family === 'windows') {
    for (const i of vm.rt.ifaces) {
      const a = content.win.adapters[i.name] || { dhcp: true };
      const cfg = a.dhcp ? { dhcp4: true, addresses: [], dns: a.dns || [] } : { dhcp4: false, addresses: a.ip ? [{ ip: a.ip, prefix: a.prefix ?? 24 }] : [], gateway: a.gw || null, dns: a.dns || [] };
      configureIface(st, vm, i, cfg, 'windows');
    }
    vm.rt.ipForward = 0;
    return;
  }
  const { cfg, error } = linuxDesiredConfig(content, vm.rt.ifaces.map((i) => i.name));
  vm.rt.netError = error;
  for (const i of vm.rt.ifaces) configureIface(st, vm, i, cfg[i.name] || null, 'linux');
  vm.rt.ipForward = sysctlForward(content);
}

// Cambio de cable / modo con la VM encendida
export function linkChanged(st, vm) {
  if (!vm.rt) return;
  const content = vmContent(st, vm);
  const family = OS_TYPES[content?.os]?.family;
  for (const i of vm.rt.ifaces) {
    const up = linkOf(st, vm, vm.nics[i.slot]).up;
    const wasUp = i.linkWas !== false;
    if (up === wasUp && i.linkWas !== undefined) continue;
    i.linkWas = up;
    if (!up) {
      if (family === 'windows') { i.mediaDisconnected = true; i.addrs = []; }
      else i.addrs = i.addrs.filter((a) => !a.dyn);
      vm.rt.routes = vm.rt.routes.filter((r) => !(r.dev === i.name && r.proto === 'dhcp'));
      if (family === 'windows') vm.rt.routes = vm.rt.routes.filter((r) => r.dev !== i.name);
    } else if (i.cfg && (i.cfg.dhcp4 || family === 'windows')) {
      i.mediaDisconnected = false;
      configureIface(st, vm, i, i.cfg, family);
    } else i.mediaDisconnected = false;
  }
}

export function initLinkFlags(st, vm) {
  if (!vm.rt) return;
  for (const i of vm.rt.ifaces) i.linkWas = linkOf(st, vm, vm.nics[i.slot]).up;
}

// ---------------------------------------------------------------- DNS
export function dnsServersOf(vm) {
  const out = [];
  for (const i of vm.rt?.ifaces || []) for (const d of i.dns || []) if (!out.includes(d)) out.push(d);
  return out;
}

// Resolución de nombres: hosts → servidores DNS configurados. Devuelve {ip, server} o {error}
export function resolve(st, fromId, name, opts = {}) {
  name = String(name).toLowerCase().replace(/\.$/, '');
  if (isIp(name)) return { ip: name };
  if (name === 'localhost') return { ip: '127.0.0.1', local: true };
  let servers;
  let content = null;
  if (fromId === HOST_ID) {
    servers = st.host.dns || ['192.168.1.1'];
    if (name === st.host.name.toLowerCase()) return { ip: st.host.eth.ip, local: true };
  } else {
    const vm = st.vms.find((v) => v.id === fromId);
    content = vmContent(st, vm);
    const hosts = content?.files?.['/etc/hosts'] || '';
    for (const line of hosts.split('\n')) {
      const w = line.replace(/#.*/, '').trim().split(/\s+/);
      if (w.length > 1 && isIp(w[0]) && w.slice(1).map((x) => x.toLowerCase()).includes(name)) return { ip: w[0], local: true };
    }
    if (content?.hostname && name === content.hostname.toLowerCase()) {
      const a = vm.rt.ifaces.flatMap((i) => i.addrs)[0];
      return { ip: OS_TYPES[content.os].family === 'linux' ? '127.0.1.1' : (a?.ip || '127.0.0.1'), local: true };
    }
    servers = opts.servers || dnsServersOf(vm);
  }
  if (opts.server) servers = [opts.server];
  if (!servers.length) return { error: 'noservers' };
  const T = topology(st);
  for (const s of servers) {
    const r = send(st, fromId, s, { proto: 'udp', port: 53, T });
    if (r.status !== 'ok') continue;
    const t = r.target;
    const recursive = t.kind === 'natengine' || t.kind === 'router' || t.kind === 'internet';
    if (!recursive) return { error: 'refused', server: s };
    if (t.kind === 'natengine') {
      // el proxy DNS de VirtualBox pregunta con el resolvedor del anfitrión
      const up = send(st, HOST_ID, st.lan.router.ip, { proto: 'udp', port: 53, T });
      if (up.status !== 'ok') continue;
    }
    const ip = DNS_PUBLIC[name];
    if (!ip) return { error: 'nxdomain', server: s };
    return { ip, server: s, viaRtt: r.rtt };
  }
  return { error: 'timeout', server: servers[0] };
}

// ---------------------------------------------------------------- utilidades de diagnóstico
export function vmIps(vm) {
  return (vm.rt?.ifaces || []).flatMap((i) => i.addrs.map((a) => ({ ...a, dev: i.name, slot: i.slot })));
}

export function describeAddr(st, ip) {
  const T = topology(st);
  for (const n of T.nodes.values()) if (n.kind !== 'internet' && owns(n, ip) && !isLoopback(ip)) return n.name;
  if (PUBLIC_HOSTS[ip]) return PUBLIC_HOSTS[ip].name;
  return null;
}

export { prefixToMask };
