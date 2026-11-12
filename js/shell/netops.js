// Operaciones de red de alto nivel compartidas por las consolas (HTTP, SSH, escaneos).
import { send, resolve, topology, HOST_ID, vmContent, owns, describeAddr } from '../net.js';
import { PUBLIC_HOSTS, OS_TYPES } from '../catalog.js';
import { hashStr, isIp, ipToInt, intToIp } from '../util.js';
import { state } from '../store.js';

export const PTR = {
  '8.8.8.8': 'dns.google', '8.8.4.4': 'dns.google', '1.1.1.1': 'one.one.one.one', '9.9.9.9': 'dns9.quad9.net',
  '142.250.184.163': 'mad41s14-in-f3.1e100.net', '142.250.200.78': 'mad07s24-in-f14.1e100.net', '142.250.200.68': 'mad07s24-in-f4.1e100.net',
  '80.58.67.33': '33.red-80-58-67.staticip.rima-tde.net', '72.14.215.85': '72.14.215.85', '142.251.54.137': '142.251.54.137',
};

export const jitter = (base, seed = Math.random()) => Math.max(0.02, base * (0.85 + ((typeof seed === 'number' ? seed : hashStr(String(seed)) % 1000 / 1000)) * 0.35));

export function fmtMs(ms) {
  if (ms < 1) return ms.toFixed(3);
  if (ms < 10) return ms.toFixed(2);
  return ms.toFixed(1);
}

// Busca la VM o equipo que realmente atiende una conexión (sigue reenvíos de puertos)
export function serviceOwner(res) {
  if (res.forwardedTo?.vm) return { kind: 'vm', vm: res.forwardedTo.vm };
  const t = res.target;
  if (!t) return null;
  if (t.kind === 'vm') return { kind: 'vm', vm: t.vm };
  return { kind: t.kind, node: t };
}

const APACHE_PAGE = (osName) => `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <title>Apache2 ${osName} Default Page: It works</title>
  </head>
  <body>
    <div class="main_page">
      <div class="page_header floating_element">
        <span class="floating_element">Apache2 ${osName} Default Page</span>
      </div>
      <div class="section_header">It works!</div>
      <p>This is the default welcome page used to test the correct operation of the Apache2 server after installation on ${osName} systems.</p>
    </div>
  </body>
</html>`;

export function webRoot(vm) {
  const c = vmContent(state, vm);
  if (!c?.files) return null;
  const custom = c.files['/var/www/html/index.html'];
  if (custom !== undefined) return custom;
  if (vm.rt?.services?.apache2) return APACHE_PAGE(c.os === 'ubuntu' ? 'Ubuntu' : 'Debian');
  if (vm.rt?.services?.nginx) return '<!DOCTYPE html>\n<html>\n<head>\n<title>Welcome to nginx!</title>\n</head>\n<body>\n<h1>Welcome to nginx!</h1>\n<p>If you see this page, the nginx web server is successfully installed and\nworking. Further configuration is required.</p>\n</body>\n</html>';
  return null;
}

export function parseUrl(u) {
  let s = String(u);
  let scheme = 'http';
  const m = s.match(/^(\w+):\/\//);
  if (m) { scheme = m[1].toLowerCase(); s = s.slice(m[0].length); }
  const slash = s.indexOf('/');
  const hostport = slash >= 0 ? s.slice(0, slash) : s;
  const path = slash >= 0 ? s.slice(slash) : '/';
  const [host, p] = hostport.split(':');
  const port = p ? Number(p) : scheme === 'https' ? 443 : 80;
  return { scheme, host, port, path };
}

// Petición HTTP simulada: { ok, code, server, body, error:'resolve'|'refused'|'timeout'|'noroute', res, ip }
export function httpGet(st, fromId, url) {
  const u = parseUrl(url);
  const r = resolve(st, fromId, u.host);
  if (r.error) return { ok: false, error: 'resolve', host: u.host, u };
  const res = send(st, fromId, r.ip, { proto: 'tcp', port: u.port });
  const base = { u, ip: r.ip, res };
  if (res.status === 'noroute') return { ...base, ok: false, error: 'noroute' };
  if (res.status === 'refused') return { ...base, ok: false, error: 'refused' };
  if (res.status !== 'ok') return { ...base, ok: false, error: 'timeout' };
  const owner = serviceOwner(res);
  if (owner?.kind === 'vm') {
    const vm = owner.vm;
    const c = vmContent(st, vm);
    const page = webRoot(vm);
    if (page === null) return { ...base, ok: false, error: 'refused' };
    const server = vm.rt.services.nginx ? 'nginx/1.24.0 (Ubuntu)' : `Apache/2.4.58 (${c.os === 'ubuntu' ? 'Ubuntu' : 'Debian'})`;
    if (u.path !== '/' && u.path !== '/index.html') return { ...base, ok: true, code: 404, server, body: `<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>404 Not Found</title>\n</head><body>\n<h1>Not Found</h1>\n<p>The requested URL was not found on this server.</p>\n<hr>\n<address>${server} Server at ${u.host} Port ${u.port}</address>\n</body></html>`, vm };
    return { ...base, ok: true, code: 200, server, body: page, vm };
  }
  if (owner?.kind === 'device') return { ...base, ok: true, code: 200, server: 'HP HTTP Server; HP LaserJet M404', body: `<html><head><title>${owner.node.name}</title></head><body><h1>${owner.node.name}</h1><p>Servidor web incrustado</p></body></html>` };
  if (owner?.kind === 'router') return { ...base, ok: true, code: 200, server: 'mini_httpd/1.30', body: '<html><head><title>Router</title></head><body>Acceso al router: introduzca usuario y contraseña</body></html>' };
  if (owner?.kind === 'internet') {
    const name = PUBLIC_HOSTS[r.ip]?.name || u.host;
    if (/google/.test(name) && u.port === 80) return { ...base, ok: true, code: 301, server: 'gws', location: `http://www.${u.host.replace(/^www\./, '')}/`, body: `<HTML><HEAD><meta http-equiv="content-type" content="text/html;charset=utf-8">\n<TITLE>301 Moved</TITLE></HEAD><BODY>\n<H1>301 Moved</H1>\nThe document has moved\n<A HREF="http://www.${u.host.replace(/^www\./, '')}/">here</A>.\r\n</BODY></HTML>` };
    return { ...base, ok: true, code: 200, server: name.includes('example') ? 'ECAcc (dcd/7D5A)' : 'nginx', body: `<!doctype html>\n<html>\n<head>\n    <title>${u.host}</title>\n</head>\n<body>\n<div>\n    <h1>${u.host}</h1>\n    <p>Página servida desde Internet a través del NAT.</p>\n</div>\n</body>\n</html>` };
  }
  return { ...base, ok: false, error: 'refused' };
}

// Huella de la clave de host SSH: depende del disco (las VM clonadas comparten clave)
export function hostKeyFp(vm) {
  const c = vmContent(state, vm);
  const h = hashStr(`${c?.installedAt}|${c?.hostname}`);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let s = '';
  let x = h;
  for (let i = 0; i < 43; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; s += chars[x % 64]; }
  return `SHA256:${s}`;
}

export const COMMON_PORTS = [[21, 'ftp'], [22, 'ssh'], [23, 'telnet'], [25, 'smtp'], [53, 'domain'], [80, 'http'], [110, 'pop3'], [135, 'msrpc'], [139, 'netbios-ssn'], [143, 'imap'], [443, 'https'], [445, 'microsoft-ds'], [631, 'ipp'], [3306, 'mysql'], [3389, 'ms-wbt-server'], [4444, 'krb524'], [8080, 'http-proxy'], [9100, 'jetdirect']];
export const portName = (p) => COMMON_PORTS.find((x) => x[0] === p)?.[1] || 'unknown';

export function expandTargets(spec) {
  const m = String(spec).match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
  if (m) {
    const prefix = Math.max(22, Number(m[2]));
    const n = ipToInt(m[1]);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const base = (n & mask) >>> 0;
    const size = 2 ** (32 - prefix);
    const out = [];
    for (let i = 0; i < size; i++) out.push(intToIp((base + i) >>> 0));
    return out;
  }
  const r = String(spec).match(/^(\d+\.\d+\.\d+\.)(\d+)-(\d+)$/);
  if (r) { const out = []; for (let i = Number(r[2]); i <= Number(r[3]); i++) out.push(r[1] + i); return out; }
  return [spec];
}

// Descubrimiento tipo nmap -sn: en la red local (mismo segmento) usa ARP, que atraviesa cortafuegos
export function hostDiscovery(st, fromId, targets, { root = true } = {}) {
  const T = topology(st);
  const up = [];
  const me = T.nodes.get(fromId);
  for (const ip of targets) {
    if (!isIp(ip)) continue;
    let found = null;
    if (me && root) {
      for (const i of me.ifaces) {
        if (!i.link) continue;
        if (!i.addrs.some((a) => sameNet(ip, a.ip, a.prefix))) continue;
        const own = i.addrs.some((a) => a.ip === ip);
        const m = (T.segs.get(i.seg) || []).find((x) => x.iface.addrs.some((a) => a.ip === ip));
        if (own) found = { ip, self: true, mac: i.mac, lat: 0.00003 };
        else if (m) found = { ip, mac: m.iface.mac, node: m.node, lat: 0.0002 + Math.random() * 0.0005 };
      }
    }
    if (!found) {
      const r = send(st, fromId, ip, { T });
      if (r.status === 'ok') found = { ip, node: r.target, lat: r.rtt / 1000 };
      else {
        const t = send(st, fromId, ip, { proto: 'tcp', port: 80, T });
        if (t.status === 'ok' || t.status === 'refused') found = { ip, node: t.target, lat: t.rtt / 1000 };
      }
    }
    if (found) up.push(found);
  }
  return up;
}

export function vendorOfMac(mac) {
  const m = String(mac || '').toUpperCase();
  if (m.startsWith('080027')) return 'Oracle VirtualBox virtual NIC';
  if (m.startsWith('0A0027')) return 'Unknown';
  if (m.startsWith('525400')) return 'QEMU virtual NIC';
  if (m.startsWith('6C02E0')) return 'HP';
  if (m.startsWith('001132')) return 'Synology Incorporated';
  if (m.startsWith('F4CAE5')) return 'FREEBOX SAS';
  if (m.startsWith('B42E99')) return 'Giga-byte Technology';
  return 'Unknown';
}

function sameNet(a, b, p) {
  const m = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
  return ((ipToInt(a) & m) >>> 0) === ((ipToInt(b) & m) >>> 0);
}

export { send, resolve, topology, HOST_ID, owns, describeAddr, OS_TYPES };
