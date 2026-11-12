// Catálogo: sistemas invitados, imágenes ISO, tipos de adaptador y textos de VirtualBox 7.1.

export const OS_TYPES = {
  ubuntu: { family: 'linux', type: 'Linux', subtype: 'Ubuntu', version: 'Ubuntu (64-bit)', label: 'Ubuntu Server 24.04.1 LTS', color: '#e95420', glyph: 'U', minRam: 1024, recRam: 2048, recDisk: 25, recCpu: 2, netcfg: 'netplan', kernel: '6.8.0-45-generic', pretty: 'Ubuntu 24.04.1 LTS', codename: 'noble' },
  debian: { family: 'linux', type: 'Linux', subtype: 'Debian', version: 'Debian (64-bit)', label: 'Debian GNU/Linux 12 (bookworm)', color: '#a80030', glyph: 'D', minRam: 512, recRam: 1024, recDisk: 20, recCpu: 1, netcfg: 'ifupdown', kernel: '6.1.0-26-amd64', pretty: 'Debian GNU/Linux 12 (bookworm)', codename: 'bookworm' },
  kali: { family: 'linux', type: 'Linux', subtype: 'Debian', version: 'Debian (64-bit)', label: 'Kali GNU/Linux Rolling 2024.3', color: '#367bf0', glyph: 'K', minRam: 2048, recRam: 4096, recDisk: 40, recCpu: 2, netcfg: 'ifupdown', kernel: '6.8.11-amd64', pretty: 'Kali GNU/Linux Rolling', codename: 'kali-rolling' },
  win10: { family: 'windows', type: 'Microsoft Windows', subtype: 'Win10', version: 'Windows 10 (64-bit)', label: 'Windows 10 Pro 22H2', color: '#0078d4', glyph: '10', minRam: 2048, recRam: 4096, recDisk: 50, recCpu: 2, netcfg: 'windows', build: '10.0.19045.4894' },
  win11: { family: 'windows', type: 'Microsoft Windows', subtype: 'Win11', version: 'Windows 11 (64-bit)', label: 'Windows 11 Pro 24H2', color: '#0067c0', glyph: '11', minRam: 4096, recRam: 4096, recDisk: 80, recCpu: 2, netcfg: 'windows', build: '10.0.26100.2033', needsEfi: true, needsTpm: true, minDisk: 64 },
  ws2022: { family: 'windows', type: 'Microsoft Windows', subtype: 'Win2k22', version: 'Windows Server 2022 (64-bit)', label: 'Windows Server 2022 Standard', color: '#3a6ea5', glyph: 'S', minRam: 2048, recRam: 2048, recDisk: 50, recCpu: 2, netcfg: 'windows', build: '10.0.20348.2700' },
  other: { family: 'other', type: 'Other', subtype: 'Other', version: 'Other/Unknown (64-bit)', label: 'Otro sistema', color: '#7a7a7a', glyph: '?', minRam: 64, recRam: 512, recDisk: 8, recCpu: 1, netcfg: 'none' },
};

// Árbol Tipo > Subtipo > Versión como en el asistente de VirtualBox 7.1
export const OS_TREE = {
  'Linux': { 'Ubuntu': ['Ubuntu (64-bit)'], 'Debian': ['Debian (64-bit)'], 'Red Hat': ['Red Hat (64-bit)'], 'Oracle Linux': ['Oracle Linux (64-bit)'], 'Arch Linux': ['Arch Linux (64-bit)'], 'Other Linux': ['Other Linux (64-bit)'] },
  'Microsoft Windows': { 'Win10': ['Windows 10 (64-bit)'], 'Win11': ['Windows 11 (64-bit)'], 'Win2k22': ['Windows Server 2022 (64-bit)'], 'Win2k19': ['Windows Server 2019 (64-bit)'] },
  'Other': { 'Other': ['Other/Unknown (64-bit)'] },
};

export function osKeyFromVersion(version) {
  for (const [k, v] of Object.entries(OS_TYPES)) if (v.version === version && k !== 'kali') return k;
  if (/Linux|Red Hat/.test(version)) return 'debian';
  if (/Windows/.test(version)) return 'win10';
  return 'other';
}

export const ISO_DIR = 'C:\\Users\\alumno\\Downloads\\ISO';
export const ISOS = [
  { file: 'ubuntu-24.04.1-live-server-amd64.iso', os: 'ubuntu', sizeMB: 2694, edition: null },
  { file: 'debian-12.7.0-amd64-netinst.iso', os: 'debian', sizeMB: 631 },
  { file: 'kali-linux-2024.3-installer-amd64.iso', os: 'kali', sizeMB: 4012 },
  { file: 'Win10_22H2_Spanish_x64v1.iso', os: 'win10', sizeMB: 5934, edition: 'Windows 10 Pro' },
  { file: 'Win11_24H2_Spanish_x64.iso', os: 'win11', sizeMB: 5617, edition: 'Windows 11 Pro' },
  { file: 'es-es_windows_server_2022_x64_dvd.iso', os: 'ws2022', sizeMB: 5170, edition: 'Windows Server 2022 Standard (experiencia de escritorio)' },
  { file: 'VBoxGuestAdditions_7.1.4.iso', os: 'ga', sizeMB: 58 },
];

export function detectIsoOs(file) {
  const f = String(file).toLowerCase();
  if (f.includes('ubuntu')) return 'ubuntu';
  if (f.includes('kali')) return 'kali';
  if (f.includes('debian')) return 'debian';
  if (f.includes('server_2022') || f.includes('server 2022')) return 'ws2022';
  if (f.includes('win11')) return 'win11';
  if (f.includes('win10')) return 'win10';
  if (f.includes('guestadditions')) return 'ga';
  return null;
}

export const ATTACH = [
  { id: 'none', label: 'No conectado' },
  { id: 'nat', label: 'NAT' },
  { id: 'natnet', label: 'Red NAT' },
  { id: 'bridged', label: 'Adaptador puente' },
  { id: 'intnet', label: 'Red interna' },
  { id: 'hostonly', label: 'Adaptador solo anfitrión' },
  { id: 'generic', label: 'Controlador genérico' },
  { id: 'cloud', label: 'Red en la nube' },
];
export const attachLabel = (id) => ATTACH.find((a) => a.id === id)?.label || id;

export const NIC_TYPES = [
  { id: 'Am79C970A', label: 'PCnet-PCI II (Am79C970A)' },
  { id: 'Am79C973', label: 'PCnet-FAST III (Am79C973)' },
  { id: '82540EM', label: 'Intel PRO/1000 MT Desktop (82540EM)' },
  { id: '82543GC', label: 'Intel PRO/1000 T Server (82543GC)' },
  { id: '82545EM', label: 'Intel PRO/1000 MT Server (82545EM)' },
  { id: 'virtio', label: 'Red paravirtualizada (virtio-net)' },
];
export const nicTypeLabel = (id) => NIC_TYPES.find((t) => t.id === id)?.label || id;
export const nicShort = (id) => nicTypeLabel(id).replace(/ \(.*\)$/, '');

export const PROMISC = [
  { id: 'deny', label: 'Denegar' },
  { id: 'allow-vms', label: 'Permitir MVs' },
  { id: 'allow-all', label: 'Permitir todo' },
];

// Nombres de interfaz que asigna el kernel Linux a cada ranura PCI de VirtualBox (Intel PRO/1000)
export const LINUX_IFNAMES = ['enp0s3', 'enp0s8', 'enp0s9', 'enp0s10'];
export const WIN_IFNAMES = ['Ethernet', 'Ethernet 2', 'Ethernet 3', 'Ethernet 4'];

export const HOST_IFACES = [
  { id: 'eth', name: 'Intel(R) Ethernet Connection (17) I219-V', kind: 'ethernet' },
  { id: 'wifi', name: 'Intel(R) Wi-Fi 6E AX211 160MHz', kind: 'wifi' },
];

export const GRAPHICS = ['VMSVGA', 'VBoxVGA', 'VBoxSVGA'];
export const AUDIO_CTRL = ['Intel HD Audio', 'ICH AC97', 'SoundBlaster 16'];
export const CLIPBOARD = ['Inhabilitado', 'Anfitrión a invitado', 'Invitado a anfitrión', 'Bidireccional'];
export const PARAVIRT = ['Predeterminado', 'Legacy', 'Mínimo', 'Hyper-V', 'KVM', 'Ninguno'];
export const BOOT_DEVICES = { floppy: 'Disquete', dvd: 'Óptica', hdd: 'Disco duro', net: 'Red' };

export const VM_STATES = {
  poweroff: { label: 'Apagada', icon: 'off' },
  running: { label: 'Corriendo', icon: 'run' },
  paused: { label: 'Pausada', icon: 'pause' },
  saved: { label: 'Guardada', icon: 'saved' },
  aborted: { label: 'Abortada', icon: 'abort' },
};

// Internet simulado: nombres DNS conocidos
export const DNS_PUBLIC = {
  'google.es': '142.250.184.163', 'www.google.es': '142.250.184.163', 'google.com': '142.250.200.78', 'www.google.com': '142.250.200.68',
  'dns.google': '8.8.8.8', 'one.one.one.one': '1.1.1.1', 'cloudflare.com': '104.16.132.229',
  'ubuntu.com': '185.125.190.20', 'archive.ubuntu.com': '185.125.190.36', 'security.ubuntu.com': '185.125.190.39',
  'deb.debian.org': '151.101.134.132', 'debian.org': '130.89.148.77', 'http.kali.org': '104.17.253.239',
  'github.com': '140.82.121.4', 'www.virtualbox.org': '137.254.60.32', 'virtualbox.org': '137.254.60.32',
  'example.com': '93.184.215.14', 'www.example.com': '93.184.215.14', 'wikipedia.org': '185.15.59.224', 'es.wikipedia.org': '185.15.59.224',
  'microsoft.com': '20.70.246.20', 'www.microsoft.com': '23.215.0.137', 'windowsupdate.com': '20.191.46.211',
};
export const PUBLIC_HOSTS = {
  '8.8.8.8': { name: 'dns.google', ttl: 117, dns: true, ports: [53, 443] },
  '8.8.4.4': { name: 'dns.google', ttl: 117, dns: true, ports: [53, 443] },
  '1.1.1.1': { name: 'one.one.one.one', ttl: 57, dns: true, ports: [53, 80, 443] },
  '9.9.9.9': { name: 'dns9.quad9.net', ttl: 56, dns: true, ports: [53, 443] },
};
for (const ip of Object.values(DNS_PUBLIC)) if (!PUBLIC_HOSTS[ip]) PUBLIC_HOSTS[ip] = { ttl: 55, ports: [80, 443] };
for (const [n, ip] of Object.entries(DNS_PUBLIC)) if (!PUBLIC_HOSTS[ip].name) PUBLIC_HOSTS[ip].name = n;

export const ISP_HOPS = ['100.64.0.1', '10.255.12.9', '80.58.67.33', '72.14.215.85', '142.251.54.137'];
