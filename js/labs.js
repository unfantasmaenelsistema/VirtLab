// Laboratorios guiados: objetivos que se comprueban automáticamente sobre el estado y los eventos.
import { state, on, emit, commit, vmByName, allSlots, getMedium, logEvent } from './store.js';
import { vmContent, linkOf } from './net.js';
import { OS_TYPES } from './catalog.js';
import { parseInterfaces, parseNetplan } from './guest.js';
import { sameNet, isIp } from './util.js';

const V = (name) => vmByName(name);
const fam = (vm) => OS_TYPES[vm?.osKey]?.family;
const ips = (vm) => (vm?.rt?.ifaces || []).flatMap((i) => i.addrs.map((a) => ({ ...a, dev: i.name, slot: i.slot })));
const hasIp = (vm, pred) => ips(vm).some(pred);
const running = (vm) => vm && vm.state === 'running' && vm.rt;
const nicAt = (vm, attach, extra = () => true) => vm?.nics.some((n) => n.enabled && n.attach === attach && extra(n));

// ev(type, pred) busca eventos desde el inicio del laboratorio
function mk(lab) {
  const since = state.labs.progress[lab.id]?.startedAt || 0;
  const evs = state.events.filter((e) => e.t >= since);
  return {
    V, fam, ips, hasIp, running, nicAt, sameNet,
    ev: (type, pred = () => true) => evs.some((e) => e.type === type && pred(e)),
    evAfter: (type1, p1, type2, p2) => { const a = evs.find((e) => e.type === type1 && p1(e)); return !!a && evs.some((e) => e.t > a.t && e.type === type2 && p2(e)); },
    cmd: (from, re) => evs.some((e) => e.type === 'cmd' && (from === '*' || e.from === from) && re.test(e.line)),
    created: () => state.vms.filter((v) => evs.some((e) => e.type === 'vm-create' && e.vm === v.id)),
    since,
  };
}

const idOf = (name) => V(name)?.id;

export const LABS = [
  {
    id: 'crear', title: 'Tu primera máquina virtual', level: 1, minutes: 20, tags: ['Asistente', 'ISO', 'Instalación'],
    summary: 'Crea una VM Linux desde cero, instala el sistema desde la ISO y arranca desde el disco.',
    intro: 'Vas a recorrer el ciclo completo: asistente «Nueva», hardware virtual, disco VDI, instalación del sistema y primer arranque. Puedes elegir la instalación desatendida (la hace VirtualBox) o la manual (la haces tú desde el instalador).',
    objectives: [
      { text: 'Crea una máquina nueva (Máquina › Nueva) de tipo Linux con al menos 2048 MB de RAM y 2 CPU.', hint: 'En el asistente, la página «Hardware» tiene los deslizadores de memoria base y procesadores. No pases de la zona verde.', check: (L) => L.created().some((v) => fam(v) === 'linux' && v.hw.ramMB >= 2048 && v.hw.cpus >= 2) },
      { text: 'Que tenga un disco VDI reservado dinámicamente de 20 GB o más.', hint: '«Crear un disco duro virtual ahora», tamaño ≥ 20 GB y sin marcar «Reservar completamente».', check: (L) => L.created().some((v) => allSlots(v).some((x) => { const m = getMedium(x.slot.medium); return x.slot.kind === 'hdd' && m && m.format === 'VDI' && m.variant === 'dynamic' && m.sizeGB >= 20; })) },
      { text: 'Instala el sistema operativo en el disco.', hint: 'Si elegiste una ISO en el asistente y no marcaste «Omitir instalación desatendida», basta con iniciar la máquina. Si no, monta la ISO en Configuración › Almacenamiento y elige «Install» en el menú de la ISO.', check: (L) => L.ev('install', (e) => L.created().some((v) => v.id === e.vm)) },
      { text: 'Expulsa la ISO y arranca la máquina desde el disco duro.', hint: 'Dispositivos › Unidades ópticas › Eliminar disco de la unidad virtual. Si la ISO sigue puesta, la máquina vuelve a arrancar el instalador.', check: (L) => L.created().some((v) => running(v) && ['console', 'win-login', 'win-desktop'].includes(v.rt.screen?.phase) && !allSlots(v).some((x) => x.slot.kind === 'dvd' && x.slot.medium)) },
      { text: 'Inicia sesión con el usuario que creaste.', hint: 'En la instalación desatendida, por defecto: vboxuser / changeme.', check: (L) => L.ev('login', (e) => L.created().some((v) => v.id === e.vm)) },
    ],
    flag: 'flag{pr1m3r4_vm_1nst4l4d4}',
  },
  {
    id: 'nat', title: 'Modo NAT: salir a Internet', level: 1, minutes: 15, tags: ['NAT', 'DNS', 'tracepath'],
    summary: 'Descubre cómo sale a Internet una VM en NAT y por qué nadie puede entrar en ella.',
    intro: 'En modo NAT cada máquina tiene su propio router virtual privado: la VM es 10.0.2.15, la puerta de enlace 10.0.2.2 y el DNS 10.0.2.3. El tráfico sale a Internet «disfrazado» como si lo generara el propio anfitrión.',
    objectives: [
      { text: 'Inicia «Ubuntu Server» y entra con usuario/usuario.', hint: 'Doble clic sobre la máquina en el Administrador.', check: (L) => L.ev('login', (e) => e.vm === idOf('Ubuntu Server')) },
      { text: 'Consulta su IP y su tabla de rutas (ip a, ip route).', hint: 'Fíjate en «default via 10.0.2.2 dev enp0s3».', check: (L) => L.cmd(idOf('Ubuntu Server'), /^\s*(sudo\s+)?ip\s+(-\w+\s+)*(r|ro|route)\b/) && L.cmd(idOf('Ubuntu Server'), /^\s*(sudo\s+)?ip\s+(-\w+\s+)*(a|addr|address)\b/) },
      { text: 'Haz ping a 8.8.8.8 con respuesta.', hint: 'Linux hace ping indefinidamente: detenlo con Ctrl+C, o usa ping -c 4 8.8.8.8.', check: (L) => L.ev('ping', (e) => e.from === idOf('Ubuntu Server') && e.dst === '8.8.8.8' && e.ok) },
      { text: 'Resuelve un nombre (por ejemplo ping google.es o dig google.es).', hint: 'El DNS lo sirve el proxy DNS del motor NAT (10.0.2.3, a través de systemd-resolved).', check: (L) => L.ev('dns', (e) => e.from === idOf('Ubuntu Server') && e.ok) || L.ev('ping', (e) => e.from === idOf('Ubuntu Server') && e.ok && !/^(8\.8\.8\.8|10\.|192\.168\.)/.test(e.dst)) },
      { text: 'Traza la ruta hasta 8.8.8.8 (tracepath -n 8.8.8.8).', hint: 'En Ubuntu Server «traceroute» no viene instalado; «tracepath» sí. El primer salto es 10.0.2.2.', check: (L) => L.ev('trace', (e) => e.from === idOf('Ubuntu Server') && e.ok) },
      { text: 'Desde la consola del anfitrión, comprueba que NO llegas a 10.0.2.15.', hint: 'Abre la consola del anfitrión (icono de terminal de la barra de tareas) y ejecuta ping 10.0.2.15. Esa red solo existe dentro del motor NAT de la VM.', check: (L) => L.ev('ping', (e) => e.from === 'host' && e.dst === '10.0.2.15' && !e.ok) },
    ],
    flag: 'flag{n4t_s4l3_p3r0_n0_3ntr4}',
  },
  {
    id: 'pf', title: 'Reenvío de puertos: SSH y web desde el anfitrión', level: 2, minutes: 20, tags: ['NAT', 'Port forwarding', 'SSH', 'Apache'],
    summary: 'Abre «agujeros» en el NAT para entrar por SSH y por HTTP a una VM.',
    intro: 'Como el anfitrión no puede llegar a 10.0.2.15, VirtualBox permite reenviar un puerto del anfitrión a un puerto de la VM. Así, conectarse a 127.0.0.1:2222 en el anfitrión es conectarse a 10.0.2.15:22 dentro del NAT.',
    objectives: [
      { text: 'En «Ubuntu Server» (adaptador 1, NAT), crea la regla TCP 2222 → 22.', hint: 'Configuración › Red › Adaptador 1 › Avanzadas › Reenvío de puertos. IP anfitrión e IP invitado pueden quedar vacías.', check: () => V('Ubuntu Server')?.nics.some((n) => n.attach === 'nat' && n.pf.some((r) => r.hostPort === 2222 && r.guestPort === 22)) },
      { text: 'Con la VM encendida, conéctate desde el anfitrión: ssh -p 2222 usuario@127.0.0.1', hint: 'La primera vez SSH pregunta si confías en la huella: responde yes. La contraseña es usuario.', check: (L) => L.ev('ssh', (e) => e.from === 'host' && e.ok && e.forwarded && e.vm === idOf('Ubuntu Server')) },
      { text: 'Instala Apache en la VM (sudo apt install apache2).', hint: 'Hace falta salida a Internet; en NAT la tienes.', check: (L) => L.ev('apt-install', (e) => e.ok && e.pkgs.includes('apache2') && e.from === idOf('Ubuntu Server')) },
      { text: 'Crea la regla 8080 → 80 y abre http://localhost:8080 con curl desde el anfitrión.', hint: 'La regla se puede añadir con la VM encendida. Luego: curl http://localhost:8080', check: (L) => L.ev('http', (e) => e.from === 'host' && e.ok && e.forwarded && e.vm === idOf('Ubuntu Server')) },
    ],
    flag: 'flag{n4t_p0rt_f0rw4rd_pr0}',
  },
  {
    id: 'hostonly', title: 'Red solo anfitrión', level: 1, minutes: 15, tags: ['Host-only', 'DHCP'],
    summary: 'Una red privada entre el PC y las VMs: se ven todos, pero sin Internet.',
    intro: 'La red solo anfitrión crea un adaptador virtual en el propio PC (192.168.56.1) y un servidor DHCP (192.168.56.100) que reparte direcciones desde 192.168.56.101. No tiene puerta de enlace: es ideal para laboratorios aislados con acceso desde el anfitrión.',
    objectives: [
      { text: 'Arranca «Ubuntu Server» (su adaptador 2 ya está en solo anfitrión) y localiza su IP 192.168.56.x.', hint: 'ip -br a', check: () => hasIp(V('Ubuntu Server'), (a) => a.ip.startsWith('192.168.56.')) },
      { text: 'Desde la consola del anfitrión, haz ping a esa IP.', hint: 'ping 192.168.56.101', check: (L) => L.ev('ping', (e) => e.from === 'host' && e.ok && e.dst.startsWith('192.168.56.') && e.target === idOf('Ubuntu Server')) },
      { text: 'Conecta «Kali Linux» a la misma red solo anfitrión y haz ping entre las dos VMs.', hint: 'Configuración › Red de Kali: Adaptador 1 › Adaptador solo anfitrión. Kali obtiene IP sola (NetworkManager).', check: (L) => L.ev('ping', (e) => e.ok && e.from !== 'host' && e.dst.startsWith('192.168.56.') && e.target && e.target !== e.from && state.vms.some((v) => v.id === e.target)) },
      { text: 'Comprueba que Kali, solo con esa red, no tiene Internet (ping 8.8.8.8 falla).', hint: 'Fíjate en el mensaje: «Network is unreachable» porque el DHCP de solo anfitrión no da puerta de enlace.', check: (L) => L.ev('ping', (e) => e.from === idOf('Kali Linux') && e.dst === '8.8.8.8' && !e.ok && V('Kali Linux')?.nics.filter((n) => n.enabled).every((n) => n.attach === 'hostonly')) },
    ],
    flag: 'flag{h0st_0nly_s1n_1nt3rn3t}',
  },
  {
    id: 'intnet', title: 'Red interna con IP estática', level: 2, minutes: 20, tags: ['Red interna', 'IP estática', '/etc/network/interfaces'],
    summary: 'Dos VMs aisladas del mundo, sin DHCP: toca configurar las IP a mano y hacerlas permanentes.',
    intro: 'En una red interna solo se ven las VMs conectadas a una red con el mismo nombre. VirtualBox no ofrece DHCP, así que hay que configurar las direcciones a mano. Los cambios con «ip addr add» se pierden al reiniciar: para que sean permanentes hay que escribirlos en el archivo de configuración.',
    objectives: [
      { text: 'Conecta «Debian 12» y «Kali Linux» a la red interna «intnet».', hint: 'Debian ya lo está. En Kali: Configuración › Red › Adaptador 1 › Red interna › Nombre: intnet (¡exactamente igual!).', check: () => nicAt(V('Debian 12'), 'intnet', (n) => n.intnet === 'intnet') && nicAt(V('Kali Linux'), 'intnet', (n) => n.intnet === 'intnet') },
      { text: 'Asigna 10.10.10.1/24 a Debian y 10.10.10.2/24 a Kali.', hint: 'sudo ip addr add 10.10.10.1/24 dev enp0s3 (no olvides el /24).', check: () => hasIp(V('Debian 12'), (a) => a.ip === '10.10.10.1' && a.prefix === 24) && hasIp(V('Kali Linux'), (a) => a.ip === '10.10.10.2' && a.prefix === 24) },
      { text: 'Haz ping entre ambas.', hint: 'ping -c 3 10.10.10.2 desde Debian.', check: (L) => L.ev('ping', (e) => e.ok && ((e.from === idOf('Debian 12') && e.dst === '10.10.10.2') || (e.from === idOf('Kali Linux') && e.dst === '10.10.10.1'))) },
      { text: 'Haz permanente la IP de Debian en /etc/network/interfaces y reinicia: debe conservarla.', hint: 'sudo nano /etc/network/interfaces → «iface enp0s3 inet static» y en la línea siguiente «    address 10.10.10.1/24». Guarda con Ctrl+O y sal con Ctrl+X. Después: sudo reboot', check: (L) => { const d = V('Debian 12'); const c = vmContent(state, d); if (!c) return false; const p = parseInterfaces(c.files['/etc/network/interfaces'] || ''); const ok = p.ifaces.enp0s3?.addresses.some((a) => a.ip === '10.10.10.1' && a.prefix === 24) && p.ifaces.enp0s3.auto; return ok && L.ev('vm-start', (e) => e.vm === d.id) && hasIp(d, (a) => a.ip === '10.10.10.1' && !a.manual); } },
      { text: 'Comprueba que desde la red interna no hay Internet.', hint: 'ping 8.8.8.8 → «Network is unreachable»: no hay puerta de enlace ni router.', check: (L) => L.ev('ping', (e) => e.from === idOf('Debian 12') && e.dst === '8.8.8.8' && !e.ok) },
    ],
    flag: 'flag{1ntn3t_st4t1c_r0ut1ng_ok}',
  },
  {
    id: 'natnet', title: 'Red NAT compartida', level: 2, minutes: 15, tags: ['Red NAT', 'nmap'],
    summary: 'Lo mejor de NAT y de red interna: Internet y visibilidad entre VMs.',
    intro: 'Una Red NAT es un NAT compartido: las VMs conectadas a ella están en la misma subred (por defecto 10.0.2.0/24, pasarela 10.0.2.1, DHCP en 10.0.2.3), se ven entre sí y salen a Internet. Se crea en Herramientas › Red › Redes NAT.',
    objectives: [
      { text: 'Crea una Red NAT con DHCP habilitado.', hint: 'Herramientas (menú ≡) › Red › pestaña «Redes NAT» › Crear.', check: () => state.natNets.some((n) => n.dhcp && n.enabled !== false) },
      { text: 'Conecta «Ubuntu Server» y «Kali Linux» (adaptador 1) a esa Red NAT.', hint: 'Configuración › Red › Conectado a: Red NAT. Si la VM estaba encendida, renueva la IP (sudo dhclient -r && sudo dhclient o reinicia).', check: () => nicAt(V('Ubuntu Server'), 'natnet') && nicAt(V('Kali Linux'), 'natnet') && V('Ubuntu Server').nics.find((n) => n.attach === 'natnet')?.natnet === V('Kali Linux').nics.find((n) => n.attach === 'natnet')?.natnet },
      { text: 'Desde Kali, haz ping a la IP de Ubuntu en la Red NAT.', hint: 'Mira la IP de Ubuntu con ip -br a (será 10.0.2.4 o 10.0.2.5).', check: (L) => L.ev('ping', (e) => e.from === idOf('Kali Linux') && e.ok && e.target === idOf('Ubuntu Server')) },
      { text: 'Comprueba que ambas tienen Internet.', hint: 'ping -c 2 8.8.8.8 en cada una.', check: (L) => L.ev('ping', (e) => e.from === idOf('Kali Linux') && e.ok && e.dst === '8.8.8.8') && L.ev('ping', (e) => e.from === idOf('Ubuntu Server') && e.ok && e.dst === '8.8.8.8') },
      { text: 'Descubre los equipos de la Red NAT con nmap -sn desde Kali.', hint: 'sudo nmap -sn 10.0.2.0/24', check: (L) => L.ev('nmap', (e) => e.from === idOf('Kali Linux') && e.sn && e.up.length >= 2) },
    ],
    flag: 'flag{n4t_n3tw0rk_c0mp4rt1d4}',
  },
  {
    id: 'bridge', title: 'Adaptador puente: un equipo más en la LAN', level: 1, minutes: 15, tags: ['Puente', 'LAN', 'nmap'],
    summary: 'Conecta una VM directamente a la red del aula y descubre a sus vecinos.',
    intro: 'En modo puente la tarjeta virtual se «engancha» a la tarjeta física del anfitrión: la VM recibe IP del router del aula (192.168.1.1) y es visible para todos los equipos de la LAN, como un PC más.',
    objectives: [
      { text: 'Pon el adaptador 1 de «Kali Linux» en «Adaptador puente» sobre la tarjeta Ethernet.', hint: 'Configuración › Red › Conectado a: Adaptador puente · Nombre: Intel(R) Ethernet…', check: () => nicAt(V('Kali Linux'), 'bridged', (n) => !/wi-?fi/i.test(n.bridged)) },
      { text: 'Arráncala y comprueba que recibe una IP 192.168.1.x del router.', hint: 'ip -br a', check: () => hasIp(V('Kali Linux'), (a) => a.ip.startsWith('192.168.1.')) },
      { text: 'Desde el anfitrión, haz ping a la IP de Kali.', hint: 'Anfitrión y VM están ahora en la misma red física.', check: (L) => L.ev('ping', (e) => e.from === 'host' && e.ok && e.target === idOf('Kali Linux')) },
      { text: 'Descubre la impresora y el NAS del aula con nmap.', hint: 'sudo nmap -sn 192.168.1.0/24 (y luego un escaneo de puertos a alguno, p. ej. nmap 192.168.1.20).', check: (L) => L.ev('nmap', (e) => e.from === idOf('Kali Linux') && e.up.includes('192.168.1.20') && e.up.includes('192.168.1.30')) },
    ],
    flag: 'flag{br1dg3d_3n_l4_l4n}',
  },
  {
    id: 'winfw', title: 'El Firewall de Windows y el ping', level: 2, minutes: 15, tags: ['Windows', 'Firewall', 'ICMP'],
    summary: '¿Por qué no responde al ping un Windows recién instalado? Arréglalo sin desactivar el firewall.',
    intro: 'Windows bloquea por defecto el eco ICMP entrante (la regla «Compartir archivos e impresoras (petición de eco: ICMPv4 de entrada)» está deshabilitada en el perfil público). Desactivar el firewall entero «funciona», pero es una mala práctica: lo correcto es permitir solo lo necesario.',
    objectives: [
      { text: 'Conecta «Windows 10» a la red solo anfitrión y arráncala (usuario: Usuario / usuario).', hint: 'Configuración › Red › Adaptador 1 › Adaptador solo anfitrión.', check: () => nicAt(V('Windows 10'), 'hostonly') && hasIp(V('Windows 10'), (a) => a.ip.startsWith('192.168.56.')) },
      { text: 'Desde el anfitrión, comprueba que el ping a Windows no obtiene respuesta.', hint: 'ipconfig en Windows para ver su IP; ping desde la consola del anfitrión: «Tiempo de espera agotado».', check: (L) => L.ev('ping', (e) => e.from === 'host' && !e.ok && e.status === 'timeout' && e.target === undefined && e.dst.startsWith('192.168.56.')) || L.ev('ping', (e) => e.from === 'host' && !e.ok && e.dst === ips(V('Windows 10'))[0]?.ip) },
      { text: 'Permite el eco ICMPv4 entrante con una regla (en un símbolo del sistema de administrador).', hint: 'netsh advfirewall firewall add rule name="Ping" protocol=icmpv4:8,any dir=in action=allow', check: () => { const c = vmContent(state, V('Windows 10')); return !!c && (c.win.fw.icmp || c.win.fw.rules.some((r) => r.proto === 'icmpv4' && r.action === 'allow' && r.dir === 'in')); } },
      { text: 'Haz ping desde el anfitrión con éxito… con el firewall todavía activo.', hint: 'Si has desactivado el firewall (state off), vuelve a activarlo: netsh advfirewall set allprofiles state on', check: (L) => { const c = vmContent(state, V('Windows 10')); return L.ev('ping', (e) => e.from === 'host' && e.ok && e.target === idOf('Windows 10')) && !!c && c.win.fw.public && c.win.fw.private; } },
    ],
    flag: 'flag{v1rtu4l_n3tw0rk_m4st3r}',
  },
  {
    id: 'snap', title: 'Instantáneas: deshacer un desastre', level: 1, minutes: 15, tags: ['Instantáneas'],
    summary: 'Toma una instantánea, rompe la configuración de red y vuelve atrás en segundos.',
    intro: 'Una instantánea congela la máquina (configuración, discos y, si está encendida, la memoria). Es la red de seguridad perfecta antes de un cambio arriesgado.',
    objectives: [
      { text: 'Toma una instantánea de «Ubuntu Server» (por ejemplo «Antes de tocar netplan»).', hint: 'Menú ≡ de la máquina › Instantáneas › Tomar. Se puede hacer encendida o apagada.', check: (L) => L.ev('snapshot-take', (e) => e.vm === idOf('Ubuntu Server')) },
      { text: 'Rompe netplan (por ejemplo, borra un espacio de sangría) y aplica: sudo netplan apply', hint: 'sudo nano /etc/netplan/50-cloud-init.yaml. YAML no admite tabuladores ni sangrías incoherentes.', check: () => { const c = vmContent(state, V('Ubuntu Server')); if (!c) return false; try { parseNetplan(c.files['/etc/netplan/50-cloud-init.yaml'] || ''); return !c.files['/etc/netplan/50-cloud-init.yaml']; } catch { return true; } } },
      { text: 'Apaga la máquina y restaura la instantánea.', hint: 'Al cerrar la ventana puedes marcar «Restaurar la instantánea actual», o en Instantáneas › Restaurar.', check: (L) => L.evAfter('snapshot-take', (e) => e.vm === idOf('Ubuntu Server'), 'snapshot-restore', (e) => e.vm === idOf('Ubuntu Server')) },
      { text: 'Comprueba que la red vuelve a funcionar (ping 8.8.8.8).', hint: 'Si la instantánea era «en caliente», la máquina vuelve encendida tal cual estaba.', check: (L) => L.evAfter('snapshot-restore', (e) => e.vm === idOf('Ubuntu Server'), 'ping', (e) => e.from === idOf('Ubuntu Server') && e.ok) },
    ],
    flag: 'flag{sn4psh0t_s4lv4v1d4s}',
  },
  {
    id: 'clone', title: 'Clonar sin conflictos de MAC', level: 2, minutes: 20, tags: ['Clonación', 'MAC', 'DHCP'],
    summary: 'Provoca un conflicto de direcciones clonando mal y arréglalo.',
    intro: 'Si un clon conserva la dirección MAC del original y ambos se conectan a la misma red, el servidor DHCP les dará la misma IP (la concesión va ligada a la MAC). Resultado: pings que van y vienen, (DUP!) y conexiones que fallan de forma aleatoria.',
    objectives: [
      { text: 'Clona «Ubuntu Server» con «Incluir todas las direcciones MAC de la tarjeta de red».', hint: 'Con la máquina apagada: Máquina › Clonar…', check: (L) => L.ev('clone', (e) => e.from === idOf('Ubuntu Server') && e.macPolicy === 'all') },
      { text: 'Arranca el original y el clon (los dos usan la red solo anfitrión) y comprueba que tienen la misma IP.', hint: 'ip -br a en cada uno: 192.168.56.101 en ambos.', check: () => { const o = V('Ubuntu Server'); const cl = state.vms.find((v) => v !== o && running(v) && v.nics.some((n) => o?.nics.some((m) => m.mac === n.mac && m.attach === 'hostonly' && n.attach === 'hostonly'))); return running(o) && cl && ips(o).some((a) => ips(cl).some((b) => b.ip === a.ip && a.ip.startsWith('192.168.56.'))); } },
      { text: 'Observa el conflicto: haz ping a esa IP desde el anfitrión.', hint: 'Responderán unas veces uno y otras el otro. El Asistente VirtLab lo explica.', check: (L) => L.ev('ping', (e) => e.from === 'host' && e.dst.startsWith('192.168.56.') && e.conflict) },
      { text: 'Genera una MAC nueva para el adaptador 2 del clon, reinícialo y comprueba que recibe otra IP.', hint: 'Apaga el clon › Configuración › Red › Adaptador 2 › Avanzadas › botón de refrescar junto a la MAC.', check: () => { const o = V('Ubuntu Server'); const cl = state.vms.find((v) => v !== o && v.name.toLowerCase().includes('clon') && running(v)); if (!cl || !running(o)) return false; const a = ips(o).find((x) => x.ip.startsWith('192.168.56.')); const b = ips(cl).find((x) => x.ip.startsWith('192.168.56.')); return a && b && a.ip !== b.ip; } },
    ],
    flag: 'flag{m4c_dupl1c4d4_r3su3lt4}',
  },
  {
    id: 'router', title: 'Router Linux con MASQUERADE', level: 3, minutes: 35, tags: ['Enrutamiento', 'ip_forward', 'iptables', 'NAT'],
    summary: 'Convierte Ubuntu Server en el router que da Internet a una red interna.',
    intro: 'Ubuntu tendrá dos patas: enp0s3 en NAT (salida a Internet) y enp0s8 en la red interna «intnet» (10.10.10.1/24). Debian, en la red interna, usará a Ubuntu como puerta de enlace. Para que funcione hacen falta: reenvío de paquetes (ip_forward) y traducción de direcciones (MASQUERADE), porque el motor NAT de VirtualBox solo acepta tráfico con origen en su propia red 10.0.2.0/24.',
    objectives: [
      { text: 'Configura Ubuntu Server: adaptador 1 NAT y adaptador 2 en red interna «intnet».', hint: 'Con la máquina apagada: Configuración › Red › Adaptador 2 › Red interna › intnet.', check: () => { const u = V('Ubuntu Server'); return u?.nics[0].enabled && u.nics[0].attach === 'nat' && u.nics[1].enabled && u.nics[1].attach === 'intnet' && u.nics[1].intnet === 'intnet'; } },
      { text: 'Asigna 10.10.10.1/24 a enp0s8 de Ubuntu.', hint: 'sudo ip addr add 10.10.10.1/24 dev enp0s8 (o en netplan: addresses: [10.10.10.1/24]).', check: () => hasIp(V('Ubuntu Server'), (a) => a.ip === '10.10.10.1' && a.prefix === 24 && a.dev === 'enp0s8') },
      { text: 'En Debian: IP 10.10.10.2/24 y puerta de enlace 10.10.10.1.', hint: 'sudo ip addr add 10.10.10.2/24 dev enp0s3 && sudo ip route add default via 10.10.10.1', check: () => { const d = V('Debian 12'); return hasIp(d, (a) => a.ip === '10.10.10.2' && a.prefix === 24) && d.rt?.routes.some((r) => r.dst === '0.0.0.0' && r.via === '10.10.10.1'); } },
      { text: 'Activa el reenvío de paquetes en Ubuntu.', hint: 'sudo sysctl -w net.ipv4.ip_forward=1', check: () => V('Ubuntu Server')?.rt?.ipForward === 1 },
      { text: 'Añade la regla MASQUERADE de salida por enp0s3.', hint: 'sudo iptables -t nat -A POSTROUTING -o enp0s3 -j MASQUERADE', check: () => (V('Ubuntu Server')?.rt?.ipt?.nat || []).some((r) => r.target === 'MASQUERADE' && r.out === 'enp0s3') },
      { text: 'Desde Debian, ping 8.8.8.8 con respuesta.', hint: 'Si falla, el Asistente VirtLab te dice en qué salto se pierde el paquete.', check: (L) => L.ev('ping', (e) => e.from === idOf('Debian 12') && e.dst === '8.8.8.8' && e.ok) },
      { text: 'Haz que Debian resuelva nombres (ping deb.debian.org).', hint: 'Debian no tiene DNS: echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf', check: (L) => L.ev('ping', (e) => e.from === idOf('Debian 12') && e.ok && !isIp(e.name || '') && !/^(8\.8\.8\.8|10\.|192\.168\.)/.test(e.dst)) },
    ],
    flag: 'flag{l1nux_r0ut3r_m4squ3r4d3}',
  },
  {
    id: 'dhcpd', title: 'Servidor DHCP propio en una red interna', level: 3, minutes: 35, tags: ['DHCP', 'isc-dhcp-server', 'Red interna'],
    summary: 'Monta un servidor DHCP en Ubuntu para repartir IP a la red interna.',
    intro: 'La red interna no tiene DHCP. Lo instalarás tú: Ubuntu Server con enp0s8 en «intnet» (10.10.10.1/24) ejecutará isc-dhcp-server y Debian obtendrá su IP automáticamente.',
    objectives: [
      { text: 'Ubuntu Server: adaptador 1 NAT y adaptador 2 en «intnet» con IP 10.10.10.1/24.', hint: 'Igual que en el laboratorio del router.', check: () => { const u = V('Ubuntu Server'); return u?.nics[1].attach === 'intnet' && hasIp(u, (a) => a.ip === '10.10.10.1' && a.dev === 'enp0s8'); } },
      { text: 'Instala isc-dhcp-server.', hint: 'sudo apt install isc-dhcp-server (el arranque fallará: todavía no está configurado, es normal).', check: () => vmContent(state, V('Ubuntu Server'))?.pkgs.includes('isc-dhcp-server') },
      { text: 'Indica la interfaz en /etc/default/isc-dhcp-server y declara la subred en /etc/dhcp/dhcpd.conf.', hint: 'INTERFACESv4="enp0s8"\n\nsubnet 10.10.10.0 netmask 255.255.255.0 {\n  range 10.10.10.100 10.10.10.150;\n  option routers 10.10.10.1;\n}', check: () => { const c = vmContent(state, V('Ubuntu Server')); return /INTERFACESv4\s*=\s*"[^"]*enp0s8/.test(c?.files['/etc/default/isc-dhcp-server'] || '') && /subnet\s+10\.10\.10\.0\s+netmask\s+255\.255\.255\.0\s*\{[^}]*range/.test((c?.files['/etc/dhcp/dhcpd.conf'] || '').replace(/#.*$/gm, '')); } },
      { text: 'Reinicia el servicio y comprueba que está activo.', hint: 'sudo systemctl restart isc-dhcp-server && systemctl status isc-dhcp-server', check: () => !!V('Ubuntu Server')?.rt?.services?.['isc-dhcp-server'] },
      { text: 'Debian obtiene una IP 10.10.10.x por DHCP.', hint: 'En Debian: sudo dhclient -v enp0s3', check: (L) => L.ev('dhcp', (e) => e.from === idOf('Debian 12') && e.ok && /^10\.10\.10\./.test(e.ip)) },
    ],
    flag: 'flag{dhc0_d0r4_s3rv1d0r_pr0p10}',
  },
  {
    id: 'vboxmanage', title: 'Administrar VirtualBox con VBoxManage', level: 2, minutes: 20, tags: ['CLI', 'VBoxManage'],
    summary: 'Haz desde la línea de órdenes lo mismo que con la interfaz gráfica.',
    intro: 'VBoxManage es la interfaz de línea de órdenes de VirtualBox: permite automatizar y administrar servidores sin escritorio. En Windows está en C:\\Program Files\\Oracle\\VirtualBox, que no está en el PATH.',
    objectives: [
      { text: 'Desde la consola del anfitrión, lista las máquinas registradas.', hint: 'cd "C:\\Program Files\\Oracle\\VirtualBox" y luego VBoxManage list vms', check: (L) => L.cmd('host', /vboxmanage(\.exe)?"?\s+list\s+vms/i) },
      { text: 'Arranca «Debian 12» sin interfaz gráfica (headless).', hint: 'VBoxManage startvm "Debian 12" --type headless', check: (L) => L.ev('vboxmanage', (e) => e.cmd === 'startvm' && e.headless) },
      { text: 'Añade una regla de reenvío de puertos por CLI a cualquier máquina.', hint: 'Apagada: VBoxManage modifyvm "Ubuntu Server" --natpf1 "ssh,tcp,,2222,,22". Encendida: controlvm "..." natpf1 "..."', check: (L) => L.ev('pf-add', (e) => e.from === 'host') },
      { text: 'Toma una instantánea por CLI.', hint: 'VBoxManage snapshot "Debian 12" take "Base"', check: (L) => L.cmd('host', /snapshot\s+.+\s+take\s+/i) },
      { text: 'Apaga «Debian 12» con controlvm.', hint: 'VBoxManage controlvm "Debian 12" acpipowerbutton (ordenado) o poweroff (a lo bruto)', check: (L) => L.cmd('host', /controlvm\s+.+\s+(acpipowerbutton|poweroff)/i) },
    ],
    flag: 'flag{vb0xm4n4g3_cl1_n1nj4}',
  },
  {
    id: 'ga', title: 'Guest Additions y carpeta compartida', level: 2, minutes: 25, tags: ['Guest Additions', 'Carpetas compartidas', 'vboxsf'],
    summary: 'Instala las Guest Additions en Ubuntu y accede a una carpeta del anfitrión.',
    intro: 'Las Guest Additions son controladores y servicios que se instalan dentro del invitado: integración del ratón, ajuste de resolución, portapapeles compartido y carpetas compartidas (sistema de archivos vboxsf). En Linux se compilan como módulos del núcleo, así que necesitan gcc, make, perl y las cabeceras del núcleo.',
    objectives: [
      { text: 'Añade a «Ubuntu Server» una carpeta compartida automontada.', hint: 'Configuración › Carpetas compartidas › ＋ · Ruta: C:\\Users\\alumno\\Compartida · Automontar.', check: () => V('Ubuntu Server')?.shared.some((s) => s.automount) },
      { text: 'Inserta el CD de las Guest Additions y móntalo.', hint: 'Dispositivos › Insertar imagen de CD de las «Guest Additions» y en la VM: sudo mount /dev/cdrom /mnt', check: () => V('Ubuntu Server')?.rt?.cdMounted === 'ga' || vmContent(state, V('Ubuntu Server'))?.ga },
      { text: 'Instala las dependencias y ejecuta el instalador.', hint: 'sudo apt install build-essential linux-headers-$(uname -r)  y después  sudo /mnt/VBoxLinuxAdditions.run', check: () => !!vmContent(state, V('Ubuntu Server'))?.ga },
      { text: 'Añade tu usuario al grupo vboxsf y reinicia.', hint: 'sudo usermod -aG vboxsf usuario && sudo reboot (los grupos se aplican al iniciar sesión).', check: (L) => (vmContent(state, V('Ubuntu Server'))?.groups?.vboxsf || []).includes('usuario') && L.evAfter('ga-install', (e) => e.from === idOf('Ubuntu Server'), 'vm-start', (e) => e.vm === idOf('Ubuntu Server')) },
      { text: 'Lista el contenido de la carpeta compartida desde Ubuntu.', hint: 'ls /media/sf_<nombre-de-la-carpeta>', check: (L) => L.cmd(idOf('Ubuntu Server'), /ls\s+.*\/media\/sf_/) && !!V('Ubuntu Server')?.rt?.gaActive },
    ],
    flag: 'flag{gu3st_4dd1t10ns_sh4r3d}',
    onStart: () => { const u = V('Ubuntu Server'); if (u?.rt && vmContent(state, u)?.ga) u.rt.gaActive = true; },
  },
  {
    id: 'averias', title: 'Diagnóstico: cuatro averías', level: 3, minutes: 30, tags: ['Troubleshooting', 'Instructor'],
    summary: 'El técnico anterior lo dejó todo roto. Encuentra y repara cada fallo.',
    intro: 'Al iniciar este laboratorio se introducen averías en las máquinas de ejemplo (las apaga primero). Usa ip, ping, el Asistente y la configuración de VirtualBox para encontrar cada una. Pista general: comprueba de abajo arriba (enlace → IP → ruta → DNS → servicio).',
    setup: () => {
      const u = V('Ubuntu Server'); const k = V('Kali Linux'); const w = V('Windows 10'); const d = V('Debian 12');
      for (const v of [u, k, w, d]) if (v && v.state !== 'poweroff') { v.state = 'poweroff'; v.rt = null; }
      if (u) { u.nics[0].cable = false; }
      if (k) { k.nics[0].attach = 'none'; }
      const ho = state.hostOnly[0]; if (ho) ho.dhcp.enabled = false;
      if (w) { w.nics[0].attach = 'hostonly'; }
      if (d) { const c = vmContent(state, d); c.files['/etc/resolv.conf'] = 'nameserver 192.168.56.1\n'; d.nics[0].attach = 'nat'; }
    },
    objectives: [
      { text: '«Ubuntu Server» debe hacer ping a 8.8.8.8.', hint: 'ip a muestra NO-CARRIER en enp0s3… ¿está el cable virtual conectado? (barra de estado de la VM o Dispositivos › Red).', check: (L) => L.ev('ping', (e) => e.from === idOf('Ubuntu Server') && e.dst === '8.8.8.8' && e.ok) },
      { text: '«Kali Linux» debe salir a Internet.', hint: 'Revisa «Conectado a» del adaptador 1.', check: (L) => L.ev('ping', (e) => e.from === idOf('Kali Linux') && e.ok && !/^(10\.|192\.168\.)/.test(e.dst)) },
      { text: '«Windows 10» debe recibir una IP 192.168.56.x por DHCP (no 169.254.x.x).', hint: 'Una dirección 169.254 (APIPA) significa que nadie respondió al DHCP. ¿Tiene servidor DHCP la red solo anfitrión? (Herramientas › Red).', check: () => hasIp(V('Windows 10'), (a) => a.ip.startsWith('192.168.56.') && a.dyn && !a.apipa) },
      { text: '«Debian 12» (ahora en NAT) debe resolver nombres: ping deb.debian.org.', hint: 'cat /etc/resolv.conf: ¿qué servidor DNS hay? En NAT el DNS es 10.0.2.3 (o usa sudo dhclient para que se reescriba).', check: (L) => L.ev('ping', (e) => e.from === idOf('Debian 12') && e.ok && e.dst === '151.101.134.132') },
    ],
    flag: 'flag{tr0ubl3sh00t3r_n1v3l_d10s}',
  },
];

// ------------------------------------------------------------------ motor de comprobación
export function labStatus(lab) {
  const p = state.labs.progress[lab.id];
  if (!p) return { started: false, done: [], complete: false };
  const L = mk(lab);
  const done = lab.objectives.map((o, i) => p.done?.includes(i) || safe(() => o.check(L)));
  return { started: true, done, complete: p.complete || done.every(Boolean) };
}
function safe(fn) { try { return !!fn(); } catch (e) { console.warn(e); return false; } }

export function startLab(id) {
  const lab = LABS.find((l) => l.id === id);
  state.labs.active = id;
  state.labs.progress[id] = { startedAt: Date.now(), done: [], complete: false };
  lab.setup?.();
  lab.onStart?.();
  commit();
  emit('lab', lab);
  evaluate();
}

export function stopLab() { state.labs.active = null; commit(); emit('lab', null); }

let evalTimer = null;
export function evaluate() {
  clearTimeout(evalTimer);
  evalTimer = setTimeout(() => {
    const id = state.labs.active;
    if (!id) return;
    const lab = LABS.find((l) => l.id === id);
    const p = state.labs.progress[id];
    if (!lab || !p) return;
    const L = mk(lab);
    let changed = false;
    lab.objectives.forEach((o, i) => {
      if (!p.done.includes(i) && safe(() => o.check(L))) { p.done.push(i); changed = true; emit('objective', { lab, i }); }
    });
    if (!p.complete && p.done.length === lab.objectives.length) { p.complete = true; p.completedAt = Date.now(); changed = true; emit('lab-complete', lab); }
    if (changed) { commit({ lab: true }); emit('lab', lab); }
  }, 250);
}

on('event', () => evaluate());
on('change', (info) => { if (!info?.lab) evaluate(); });

export { logEvent };
