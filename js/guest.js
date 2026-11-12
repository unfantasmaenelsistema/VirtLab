// Contenido del disco del sistema invitado (lo que "está instalado") y lectura de su
// configuración de red persistente (netplan, ifupdown, Windows) al arrancar.
import { OS_TYPES, LINUX_IFNAMES, WIN_IFNAMES } from './catalog.js';
import { parseCidr, isIp, maskToPrefix, macColon } from './util.js';

export const BASE_PKGS = {
  ubuntu: ['openssh-server', 'openssh-client', 'curl', 'wget', 'iputils-ping', 'iputils-tracepath', 'bind9-dnsutils', 'netplan.io', 'ufw', 'nano', 'iproute2', 'isc-dhcp-client', 'sudo', 'systemd-resolved'],
  debian: ['openssh-server', 'openssh-client', 'wget', 'iputils-ping', 'ifupdown', 'nano', 'iproute2', 'isc-dhcp-client', 'sudo'],
  kali: ['openssh-server', 'openssh-client', 'curl', 'wget', 'iputils-ping', 'traceroute', 'dnsutils', 'net-tools', 'nmap', 'netcat-traditional', 'nano', 'iproute2', 'isc-dhcp-client', 'sudo', 'network-manager', 'apache2', 'tcpdump', 'hydra'],
};

// Paquetes instalables con apt (requieren salida a Internet)
export const APT_CATALOG = {
  'apache2': { size: '1.912 kB', service: 'apache2', ports: [80], desc: 'Servidor HTTP Apache' },
  'nginx': { size: '1.044 kB', service: 'nginx', ports: [80], desc: 'servidor web pequeño y potente' },
  'nmap': { size: '5.874 kB', desc: 'Escáner de red' },
  'net-tools': { size: '204 kB', desc: 'ifconfig, netstat, route, arp' },
  'traceroute': { size: '45 kB', desc: 'traceroute' },
  'dnsutils': { size: '210 kB', alias: 'bind9-dnsutils', desc: 'dig, nslookup' },
  'bind9-dnsutils': { size: '210 kB', desc: 'dig, nslookup' },
  'curl': { size: '226 kB', desc: 'herramienta de transferencia de URL' },
  'openssh-server': { size: '1.381 kB', service: 'ssh', ports: [22], desc: 'servidor SSH' },
  'isc-dhcp-server': { size: '1.461 kB', service: 'isc-dhcp-server', desc: 'servidor DHCP ISC' },
  'ufw': { size: '169 kB', desc: 'cortafuegos sencillo' },
  'iputils-tracepath': { size: '18 kB', desc: 'tracepath' },
  'tcpdump': { size: '483 kB', desc: 'analizador de tráfico' },
  'netcat-traditional': { size: '64 kB', desc: 'netcat' },
  'virtualbox-guest-utils': { size: '3.112 kB', desc: 'utilidades de las Guest Additions' },
  'htop': { size: '171 kB', desc: 'visor interactivo de procesos' },
  'sl': { size: '26 kB', desc: 'Steam Locomotive' },
};

export const SERVICE_PORTS = { ssh: [22], apache2: [80], nginx: [80], 'isc-dhcp-server': [] };

export function netplanFor(nics) {
  let y = '# This file is generated from information provided by the datasource.  Changes\n# to it will not persist across an instance reboot.  To disable cloud-init\'s\n# network configuration capabilities, write a file\n# /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg with the following:\n# network: {config: disabled}\nnetwork:\n    ethernets:\n';
  for (let i = 0; i < nics; i++) y += `        ${LINUX_IFNAMES[i]}:\n            dhcp4: true\n`;
  y += '    version: 2\n';
  return y;
}

export function interfacesFor(nics, distro) {
  let t = '# This file describes the network interfaces available on your system\n# and how to activate them. For more information, see interfaces(5).\n\nsource /etc/network/interfaces.d/*\n\n# The loopback network interface\nauto lo\niface lo inet loopback\n';
  if (distro === 'kali') return t; // Kali deja las interfaces Ethernet a NetworkManager
  for (let i = 0; i < Math.min(nics, 1); i++) t += `\n# The primary network interface\nallow-hotplug ${LINUX_IFNAMES[i]}\niface ${LINUX_IFNAMES[i]} inet dhcp\n`;
  return t;
}

export function makeInstalledContent(osKey, { hostname, user, pass, nics = 1 }) {
  const os = OS_TYPES[osKey];
  const c = { os: osKey, hostname, users: [{ name: user, pass, admin: true }], installedAt: Date.now(), ga: false };
  if (os.family === 'linux') {
    c.pkgs = [...BASE_PKGS[osKey]];
    c.services = { ssh: { enabled: osKey !== 'kali' } };
    if (osKey === 'kali') c.services.apache2 = { enabled: false };
    c.ufw = { enabled: false, rules: [] };
    c.users.push({ name: 'root', pass: osKey === 'debian' ? null : null, admin: true, root: true });
    c.files = {
      '/etc/hostname': `${hostname}\n`,
      '/etc/hosts': `127.0.0.1 localhost\n127.0.1.1 ${hostname}\n\n# The following lines are desirable for IPv6 capable hosts\n::1     ip6-localhost ip6-loopback\nfe00::0 ip6-localnet\nff00::0 ip6-mcastprefix\nff02::1 ip6-allnodes\nff02::2 ip6-allrouters\n`,
      '/etc/sysctl.conf': '#\n# /etc/sysctl.conf - Configuration file for setting system variables\n# See /etc/sysctl.d/ for additional system variables.\n# See sysctl.conf (5) for information.\n#\n\n# Uncomment the next line to enable packet forwarding for IPv4\n#net.ipv4.ip_forward=1\n',
      [`/home/${user}/LEEME.txt`]: `Máquina de prácticas de VirtLab (${os.pretty}).\nPrueba: ip a, ip route, ping, ss -tuln, cat /etc/resolv.conf\n`,
    };
    if (osKey === 'ubuntu') c.files['/etc/netplan/50-cloud-init.yaml'] = netplanFor(nics);
    else c.files['/etc/network/interfaces'] = interfacesFor(nics, osKey);
    if (osKey !== 'ubuntu') c.files['/etc/resolv.conf'] = '';
    if (c.pkgs.includes('isc-dhcp-server')) addDhcpdFiles(c);
  } else if (os.family === 'windows') {
    c.win = {
      adapters: Object.fromEntries(WIN_IFNAMES.map((n) => [n, { dhcp: true, ip: '', mask: '', gw: '', dns: [] }])),
      fw: { domain: true, private: true, public: true, icmp: false, rules: [] },
      rdp: false, profile: 'Pública',
    };
    c.services = {};
  }
  return c;
}

export function addDhcpdFiles(c) {
  c.files['/etc/dhcp/dhcpd.conf'] ||= '# dhcpd.conf\n#\n# Sample configuration file for ISC dhcpd\n#\n\noption domain-name "example.org";\noption domain-name-servers ns1.example.org, ns2.example.org;\n\ndefault-lease-time 600;\nmax-lease-time 7200;\n\n# A slightly different configuration for an internal subnet.\n#subnet 10.5.5.0 netmask 255.255.255.224 {\n#  range 10.5.5.26 10.5.5.30;\n#  option domain-name-servers ns1.internal.example.org;\n#  option routers 10.5.5.1;\n#  option broadcast-address 10.5.5.31;\n#  default-lease-time 600;\n#  max-lease-time 7200;\n#}\n';
  c.files['/etc/default/isc-dhcp-server'] ||= '# Defaults for isc-dhcp-server (sourced by /etc/init.d/isc-dhcp-server)\n\n# On what interfaces should the DHCP server (dhcpd) serve DHCP requests?\n#\tSeparate multiple interfaces with spaces, e.g. "eth0 eth1".\nINTERFACESv4=""\nINTERFACESv6=""\n';
}

// ------------------------------------------------------------------
// Mini analizador YAML (lo justo para netplan) con errores al estilo netplan.
// ------------------------------------------------------------------
export function parseYaml(text, file = '/etc/netplan/50-cloud-init.yaml') {
  const lines = text.replace(/\r/g, '').split('\n');
  const toks = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const tabAt = raw.search(/\t/);
    const content = raw.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '');
    if (!content.trim()) continue;
    if (tabAt >= 0 && tabAt < raw.length - raw.trimStart().length + 1) {
      throw yamlErr(file, i + 1, tabAt + 1, 'found character that cannot start any token');
    }
    const indent = content.length - content.trimStart().length;
    toks.push({ line: i + 1, indent, text: content.trim() });
  }
  let pos = 0;
  function scalar(v, ln) {
    v = v.trim();
    if (v === '') return null;
    if (v.startsWith('[')) {
      if (!v.endsWith(']')) throw yamlErr(file, ln, v.length, "did not find expected ',' or ']'");
      const inner = v.slice(1, -1).trim();
      return inner ? inner.split(',').map((x) => scalar(x, ln)) : [];
    }
    if (/^(true|yes|on)$/i.test(v)) return true;
    if (/^(false|no|off)$/i.test(v)) return false;
    if (/^".*"$|^'.*'$/.test(v)) return v.slice(1, -1);
    if (/^-?\d+$/.test(v)) return Number(v);
    return v;
  }
  function block(indent) {
    if (pos >= toks.length) return null;
    const first = toks[pos];
    if (first.text.startsWith('- ') || first.text === '-') {
      const arr = [];
      while (pos < toks.length && toks[pos].indent === indent && (toks[pos].text.startsWith('- ') || toks[pos].text === '-')) {
        const t = toks[pos];
        const rest = t.text.slice(1).trim();
        pos++;
        if (rest.includes(': ') || rest.endsWith(':')) {
          // elemento de lista que es un mapa en línea
          const fake = { line: t.line, indent: indent + 2, text: rest };
          toks.splice(pos, 0, fake);
          arr.push(block(indent + 2));
        } else arr.push(scalar(rest, t.line));
      }
      if (pos < toks.length && toks[pos].indent > indent) throw yamlErr(file, toks[pos].line, toks[pos].indent + 1, 'did not find expected \'-\' indicator');
      return arr;
    }
    const obj = {};
    while (pos < toks.length && toks[pos].indent === indent) {
      const t = toks[pos];
      const m = t.text.match(/^([^:]+?):(\s+(.*))?$/) || t.text.match(/^([^:]+?):$/);
      if (!m) throw yamlErr(file, t.line, indent + 1, 'could not find expected \':\'');
      const key = m[1].trim();
      const val = m[3];
      pos++;
      if (val !== undefined && val.trim() !== '') obj[key] = scalar(val, t.line);
      else if (pos < toks.length && toks[pos].indent > indent) obj[key] = block(toks[pos].indent);
      else if (pos < toks.length && toks[pos].indent === indent && toks[pos].text.startsWith('- ')) obj[key] = block(indent);
      else obj[key] = null;
    }
    if (pos < toks.length && toks[pos].indent > indent) throw yamlErr(file, toks[pos].line, toks[pos].indent + 1, 'mapping values are not allowed in this context');
    return obj;
  }
  if (!toks.length) return {};
  const res = block(toks[0].indent);
  if (pos < toks.length) throw yamlErr(file, toks[pos].line, toks[pos].indent + 1, 'did not find expected key');
  return res;
}
function yamlErr(file, line, col, msg) {
  const e = new Error(`${file}:${line}:${col}: Invalid YAML: ${msg}`);
  e.netplan = true;
  return e;
}

// Devuelve { ifaces: { enp0s3: { dhcp4, addresses:[{ip,prefix}], gateway, dns:[] } } } o lanza error con texto de netplan
export function parseNetplan(text) {
  const y = parseYaml(text);
  if (!y || !y.network) throw Object.assign(new Error('/etc/netplan/50-cloud-init.yaml: Error in network definition: missing \'network\' key'), { netplan: true });
  const eth = y.network.ethernets || {};
  const out = {};
  for (const [name, cfg] of Object.entries(eth)) {
    const c = cfg || {};
    const r = { dhcp4: c.dhcp4 === true, addresses: [], gateway: null, dns: [], routes: [] };
    for (const a of [].concat(c.addresses || [])) {
      const p = parseCidr(a);
      if (!p || !String(a).includes('/')) throw Object.assign(new Error(`/etc/netplan/50-cloud-init.yaml: Error in network definition: address '${a}' is missing /prefixlength`), { netplan: true });
      r.addresses.push(p);
    }
    if (c.gateway4) { if (!isIp(c.gateway4)) throw Object.assign(new Error(`Error in network definition: invalid IPv4 address '${c.gateway4}'`), { netplan: true }); r.gateway = c.gateway4; r.deprecatedGw = true; }
    for (const rt of [].concat(c.routes || [])) {
      if (rt && (rt.to === 'default' || rt.to === '0.0.0.0/0') && isIp(rt.via)) r.gateway = rt.via;
      else if (rt && rt.to && rt.via) { const p = parseCidr(rt.to); if (p && isIp(rt.via)) r.routes.push({ dst: p.ip, prefix: p.prefix, via: rt.via }); }
    }
    const ns = c.nameservers?.addresses;
    if (ns) r.dns = [].concat(ns).filter(isIp);
    out[name] = r;
  }
  return { ifaces: out };
}

// /etc/network/interfaces (Debian/Kali)
export function parseInterfaces(text) {
  const out = {};
  let cur = null;
  const autos = new Set();
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const w = line.split(/\s+/);
    if (w[0] === 'auto' || w[0] === 'allow-hotplug') { w.slice(1).forEach((n) => autos.add(n)); cur = null; continue; }
    if (w[0] === 'iface') {
      if (w[1] === 'lo') { cur = null; continue; }
      cur = out[w[1]] = { method: w[3] || 'manual', dhcp4: w[3] === 'dhcp', addresses: [], gateway: null, dns: [], netmask: null, routes: [] };
      continue;
    }
    if (w[0] === 'source') { cur = null; continue; }
    if (!cur) continue;
    if (w[0] === 'address') {
      const p = parseCidr(w[1]);
      if (p) cur.addresses.push({ ip: p.ip, prefix: w[1].includes('/') ? p.prefix : null });
    } else if (w[0] === 'netmask') cur.netmask = w[1];
    else if (w[0] === 'gateway' && isIp(w[1])) cur.gateway = w[1];
    else if (w[0] === 'dns-nameservers') cur.dns = w.slice(1).filter(isIp);
    else if (w[0] === 'up' && w[1] === 'ip' && w[2] === 'route' && w[3] === 'add') {
      const p = parseCidr(w[4]); const via = w[w.indexOf('via') + 1];
      if (p && isIp(via)) cur.routes.push({ dst: p.ip, prefix: p.prefix, via });
    }
  }
  for (const [n, c] of Object.entries(out)) {
    c.auto = autos.has(n);
    for (const a of c.addresses) if (a.prefix === null) a.prefix = c.netmask ? (maskToPrefix(c.netmask) ?? 24) : 24;
  }
  return { ifaces: out };
}

// Configuración Linux deseada de cada interfaz: { name: {dhcp4, addresses, gateway, dns, managed} }
export function linuxDesiredConfig(content, ifnames) {
  const os = content.os;
  const res = {};
  let error = null;
  if (os === 'ubuntu') {
    try {
      const p = parseNetplan(content.files['/etc/netplan/50-cloud-init.yaml'] || '');
      for (const n of ifnames) if (p.ifaces[n]) res[n] = { ...p.ifaces[n], managed: true };
    } catch (e) { error = e.message; }
  } else {
    const p = parseInterfaces(content.files['/etc/network/interfaces'] || '');
    for (const n of ifnames) {
      if (p.ifaces[n]) res[n] = { ...p.ifaces[n], managed: p.ifaces[n].auto };
      else if (os === 'kali') res[n] = { dhcp4: true, addresses: [], gateway: null, dns: [], routes: [], managed: true, nm: true };
    }
  }
  return { cfg: res, error };
}

export function sysctlForward(content) {
  const t = content.files?.['/etc/sysctl.conf'] || '';
  return /^\s*net\.ipv4\.ip_forward\s*=\s*1\s*$/m.test(t) ? 1 : 0;
}

// Dirección IPv6 de enlace local (EUI-64) a partir de la MAC
export function linkLocal6(mac) {
  const m = macColon(mac).split(':').map((x) => parseInt(x, 16));
  m[0] ^= 2;
  const h = (a, b) => ((a << 8) | b).toString(16);
  return `fe80::${h(m[0], m[1])}:${h(m[2], 0xff)}:${h(0xfe, m[3])}:${h(m[4], m[5])}`;
}

export function osOf(content) { return OS_TYPES[content?.os] || OS_TYPES.other; }
export const isLinux = (c) => osOf(c).family === 'linux';
export const isWindows = (c) => osOf(c).family === 'windows';
