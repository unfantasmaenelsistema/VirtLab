// Utilidades comunes: IPv4, MAC, UUID, formato y escape HTML.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

export function uid(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export function uuid() {
  const h = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += h[Math.floor(Math.random() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20)}`;
}

// MAC con el OUI de VirtualBox (08:00:27), guardada sin separadores como hace VirtualBox.
export function vboxMac() {
  const h = '0123456789ABCDEF';
  let s = '080027';
  for (let i = 0; i < 6; i++) s += h[Math.floor(Math.random() * 16)];
  return s;
}
export const macColon = (m) => String(m || '').replace(/[^0-9a-f]/gi, '').toLowerCase().padEnd(12, '0').match(/.{2}/g).join(':');
export const macDash = (m) => macColon(m).toUpperCase().replace(/:/g, '-');
export const normMac = (m) => String(m || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
export const isValidMac = (m) => /^[0-9A-F]{12}$/.test(normMac(m)) && (parseInt(normMac(m).slice(0, 2), 16) & 1) === 0;

// ---------- IPv4 ----------
export function ipToInt(ip) {
  const p = String(ip).trim().split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x)) return null;
    const v = Number(x);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}
export const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
export const isIp = (ip) => ipToInt(ip) !== null;
export const prefixToMask = (p) => intToIp(p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0);
export function maskToPrefix(mask) {
  const n = ipToInt(mask);
  if (n === null) return null;
  const bin = n.toString(2).padStart(32, '0');
  if (!/^1*0*$/.test(bin)) return null;
  return bin.indexOf('0') === -1 ? 32 : bin.indexOf('0');
}
export function netOf(ip, prefix) {
  const n = ipToInt(ip);
  if (n === null) return null;
  const m = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (n & m) >>> 0;
}
export const sameNet = (a, b, prefix) => netOf(a, prefix) !== null && netOf(a, prefix) === netOf(b, prefix);
export const networkAddr = (ip, prefix) => intToIp(netOf(ip, prefix));
export function broadcastAddr(ip, prefix) {
  const net = netOf(ip, prefix);
  const host = prefix === 32 ? 0 : (2 ** (32 - prefix) - 1);
  return intToIp((net + host) >>> 0);
}
export function parseCidr(c) {
  const [ip, p] = String(c).split('/');
  const prefix = p === undefined ? 32 : Number(p);
  if (!isIp(ip) || !(prefix >= 0 && prefix <= 32) || !/^\d+$/.test(String(p ?? '32'))) return null;
  return { ip, prefix };
}
export function inCidr(ip, cidrIp, prefix) {
  return sameNet(ip, cidrIp, prefix);
}
export function isPrivate(ip) {
  const n = ipToInt(ip);
  if (n === null) return false;
  return inCidr(ip, '10.0.0.0', 8) || inCidr(ip, '172.16.0.0', 12) || inCidr(ip, '192.168.0.0', 16) ||
    inCidr(ip, '127.0.0.0', 8) || inCidr(ip, '169.254.0.0', 16) || inCidr(ip, '100.64.0.0', 10);
}
export const isLoopback = (ip) => inCidr(ip, '127.0.0.0', 8);
export const isPublic = (ip) => isIp(ip) && !isPrivate(ip) && !inCidr(ip, '0.0.0.0', 8) && ipToInt(ip) < ipToInt('224.0.0.0');
export const ipAdd = (ip, k) => intToIp((ipToInt(ip) + k) >>> 0);

// ---------- formato ----------
export function fmtMB(mb) {
  if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024} GB`;
  return `${mb} MB`;
}
export function fmtGB(gb) {
  if (gb < 1) return `${Math.round(gb * 1024)} MB`;
  return `${Number(gb.toFixed(2)).toLocaleString('es-ES', { maximumFractionDigits: 2 })} GB`;
}
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export const pad2 = (n) => String(n).padStart(2, '0');
export function nowStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rnd = (a, b) => a + Math.random() * (b - a);
