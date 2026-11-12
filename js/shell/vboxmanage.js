// VBoxManage simulado (consola del anfitrión). Opera sobre el mismo estado que la interfaz gráfica.
import { state, commit, vmByName, getMedium, allSlots, newMedium, emit } from '../store.js';
import { OS_TYPES, attachLabel, NIC_TYPES, osKeyFromVersion, HOST_IFACES } from '../catalog.js';
import { startVm, powerOff, acpiShutdown, pauseVm, resumeVm, rebootVm, saveState, takeSnapshot, restoreSnapshot, deleteSnapshot, cloneVm, removeVm, exportOva, importOva, validateVm, createVmFromWizard } from '../vmctl.js';
import { linkChanged, vmContent, natNetOf, hostOnlyOf } from '../net.js';
import { isIp, prefixToMask, maskToPrefix, uuid, vboxMac, normMac, isValidMac, macColon, ipAdd, networkAddr } from '../util.js';

const VER = '7.1.4r165100';
const SYNTAX = (ctx, msg) => { ctx.line(`VBoxManage.exe: error: ${msg}`); return 1; };

function findVm(ctx, name) {
  const vm = name && vmByName(name.replace(/^"|"$/g, ''));
  if (!vm) { ctx.line(`VBoxManage.exe: error: Could not find a registered machine named '${name}'\nVBoxManage.exe: error: Details: code VBOX_E_OBJECT_NOT_FOUND (0x80bb0001), component VirtualBoxWrap, interface IVirtualBox, callee IUnknown\nVBoxManage.exe: error: Context: "FindMachine(Bstr(a->argv[0]).raw(), machine.asOutParam())" at line 3100 of file VBoxManageInfo.cpp`); return null; }
  return vm;
}
const attachCli = { nat: 'nat', natnet: 'natnetwork', bridged: 'bridged', intnet: 'intnet', hostonly: 'hostonly', none: 'null', generic: 'generic', cloud: 'cloud' };
const cliToAttach = { nat: 'nat', natnetwork: 'natnet', bridged: 'bridged', intnet: 'intnet', hostonly: 'hostonly', null: 'none', none: 'none', generic: 'generic' };

function opt(args, ...names) {
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n) return args[i + 1];
      if (args[i].startsWith(`${n}=`)) return args[i].slice(n.length + 1);
    }
  }
  return undefined;
}

function parsePfRule(spec) {
  const p = String(spec).replace(/^"|"$/g, '').split(',');
  if (p.length !== 6) return null;
  const [name, proto, hostIp, hostPort, guestIp, guestPort] = p.map((x) => x.replace(/^\[|\]$/g, ''));
  if (!name || !['tcp', 'udp'].includes(proto) || !Number(hostPort) || !Number(guestPort)) return null;
  return { name, proto, hostIp, hostPort: Number(hostPort), guestIp, guestPort: Number(guestPort) };
}

export async function vboxmanage(ctx, args) {
  const sub = (args[0] || '').toLowerCase();
  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
    ctx.line(`Oracle VirtualBox Command Line Management Interface Version ${VER}\nCopyright (C) 2005-2024 Oracle and/or its affiliates\n\nUsage:\n\n  VBoxManage [<general option>] <command>\n\nCommands (simulados en VirtLab):\n  list, showvminfo, startvm, controlvm, modifyvm, snapshot, clonevm,\n  createvm, unregistervm, registervm, export, import, natnetwork,\n  hostonlyif, dhcpserver, guestproperty, storageattach, createmedium`);
    return 0;
  }
  if (sub === '--version' || sub === '-v' || sub === '-version') { ctx.line(VER); return 0; }
  const a = args.slice(1);
  switch (sub) {
    case 'list': return list(ctx, a);
    case 'showvminfo': return showvminfo(ctx, a);
    case 'startvm': {
      const names = a.filter((x) => !x.startsWith('--') && a[a.indexOf(x) - 1] !== '--type');
      const type = opt(a, '--type') || 'gui';
      for (const n of names) {
        const vm = findVm(ctx, n);
        if (!vm) return 1;
        if (vm.state === 'running') { ctx.line(`VBoxManage.exe: error: The machine '${vm.name}' is already locked by a session (or being locked or unlocked)`); return 1; }
        ctx.line(`Waiting for VM "${vm.name}" to power on...`);
        await ctx.sleep(700);
        const r = startVm(vm, type === 'headless' ? 'headless' : 'normal');
        if (!r.ok) { ctx.line(`VBoxManage.exe: error: ${r.detail}`); return 1; }
        if (type !== 'headless') emit('open-vm-window', vm.id);
        ctx.line(`VM "${vm.name}" has been successfully started.`);
        ctx.event({ type: 'vboxmanage', cmd: 'startvm', vm: vm.id, headless: type === 'headless' });
      }
      return 0;
    }
    case 'controlvm': return controlvm(ctx, a);
    case 'modifyvm': return modifyvm(ctx, a);
    case 'snapshot': return snapshot(ctx, a);
    case 'clonevm': {
      const vm = findVm(ctx, a[0]); if (!vm) return 1;
      const name = opt(a, '--name') || `${vm.name} Clone`;
      if (!a.includes('--register')) ctx.line('(aviso: sin --register el clon no aparece en el Administrador; VirtLab lo registra igualmente)');
      const optsStr = (opt(a, '--options') || '').toLowerCase();
      const macPolicy = optsStr.includes('keepallmacs') ? 'all' : optsStr.includes('keepnatmacs') ? 'nat' : 'new';
      const linked = optsStr.includes('link');
      if (linked && !opt(a, '--snapshot')) { ctx.line('VBoxManage.exe: error: Linked clone can only be created from a snapshot'); return 1; }
      ctx.line('0%...10%...20%...30%...40%...50%...60%...70%...80%...90%...100%');
      const c = cloneVm(vm, { name, macPolicy, type: linked ? 'linked' : 'full' });
      ctx.line(`Machine has been successfully cloned as "${c.name}"`);
      ctx.event({ type: 'vboxmanage', cmd: 'clonevm', vm: c.id, macPolicy });
      return 0;
    }
    case 'unregistervm': {
      const vm = findVm(ctx, a[0]); if (!vm) return 1;
      const r = removeVm(vm, a.includes('--delete') || a.includes('--delete-all'));
      if (!r.ok) { ctx.line(`VBoxManage.exe: error: Cannot unregister the machine '${vm.name}' while it is locked`); return 1; }
      if (a.includes('--delete')) ctx.line('0%...10%...20%...30%...40%...50%...60%...70%...80%...90%...100%');
      return 0;
    }
    case 'registervm': {
      const path = a.join(' ').replace(/"/g, '');
      const v = (state.unregistered || []).find((x) => path.toLowerCase().includes(x.name.toLowerCase()));
      if (!v) { ctx.line(`VBoxManage.exe: error: Could not find file for the medium '${path}' (VERR_FILE_NOT_FOUND)`); return 1; }
      const { registerVm } = await import('../vmctl.js');
      registerVm(v);
      return 0;
    }
    case 'createvm': {
      const name = opt(a, '--name');
      if (!name) return SYNTAX(ctx, 'Parameter --name is required');
      const ost = (opt(a, '--ostype') || 'Other_64').toLowerCase();
      const map = { ubuntu_64: 'ubuntu', debian_64: 'debian', windows10_64: 'win10', windows11_64: 'win11', windows2022_64: 'ws2022' };
      const osKey = map[ost] || 'other';
      const vm = createVmFromWizard({ name, osKey, ramMB: OS_TYPES[osKey].recRam, cpus: 1, disk: 'none', folder: state.prefs.machineFolder });
      if (!a.includes('--register')) ctx.line('(aviso: VirtLab registra la máquina aunque falte --register)');
      ctx.line(`Virtual machine '${vm.name}' is created and registered.\nUUID: ${vm.uuid}\nSettings file: '${vm.folder}\\${vm.name}.vbox'`);
      return 0;
    }
    case 'createmedium': case 'createhd': {
      const file = opt(a, '--filename');
      const size = Number(opt(a, '--size'));
      if (!file || !size) return SYNTAX(ctx, 'Parameters --filename and --size are required');
      const name = file.split('\\').pop().replace(/"/g, '');
      const m = newMedium('hdd', { name: name.endsWith('.vdi') ? name : `${name}.vdi`, path: file.includes('\\') ? file : `${state.prefs.machineFolder}\\${name}`, format: 'VDI', variant: (opt(a, '--variant') || '').toLowerCase() === 'fixed' ? 'fixed' : 'dynamic', sizeGB: Math.round(size / 1024), usedGB: 0.002, type: 'normal', content: null });
      state.media.hdd.push(m); commit();
      ctx.line(`0%...10%...20%...30%...40%...50%...60%...70%...80%...90%...100%\nMedium created. UUID: ${m.uuid}`);
      return 0;
    }
    case 'storageattach': {
      const vm = findVm(ctx, a[0]); if (!vm) return 1;
      if (vm.state === 'running') { ctx.line('VBoxManage.exe: error: The machine is not mutable (state is Running)'); return 1; }
      const type = opt(a, '--type'); const med = (opt(a, '--medium') || '').replace(/"/g, '');
      const ctl = (opt(a, '--storagectl') || '').toUpperCase();
      const c = vm.storage.find((x) => x.name.toUpperCase() === ctl || x.bus.toUpperCase() === ctl);
      if (!c) { ctx.line(`VBoxManage.exe: error: Could not find a controller named '${opt(a, '--storagectl')}'`); return 1; }
      if (type === 'dvddrive') {
        let slot = vm.storage.flatMap((x) => x.slots).find((s) => s.kind === 'dvd');
        if (!slot) { slot = { port: 'IDE secundario maestro', kind: 'dvd', medium: null }; c.slots.push(slot); }
        if (med === 'emptydrive' || med === 'none') slot.medium = null;
        else { const m = state.media.dvd.find((x) => med.toLowerCase().endsWith(x.name.toLowerCase())); if (!m) { ctx.line(`VBoxManage.exe: error: Could not find file for the medium '${med}' (VERR_FILE_NOT_FOUND)`); return 1; } slot.medium = m.id; }
      } else if (type === 'hdd') {
        const m = state.media.hdd.find((x) => med.toLowerCase().endsWith(x.name.toLowerCase()));
        if (!m) { ctx.line(`VBoxManage.exe: error: Could not find file for the medium '${med}' (VERR_FILE_NOT_FOUND)`); return 1; }
        c.slots.push({ port: `Puerto SATA ${c.slots.length}`, kind: 'hdd', medium: m.id });
      }
      commit();
      return 0;
    }
    case 'export': {
      const names = a.filter((x, i) => !x.startsWith('-') && !['-o', '--output'].includes(a[i - 1]));
      const out = opt(a, '-o', '--output');
      if (!out) return SYNTAX(ctx, 'Parameter --output is required');
      const vms = names.map((n) => findVm(ctx, n)); if (vms.some((v) => !v)) return 1;
      ctx.line('0%...10%...20%...30%...40%...50%...60%...70%...80%...90%...100%');
      exportOva(vms, { file: out.split('\\').pop().replace(/"/g, ''), macPolicy: 'nat' });
      ctx.line(`Successfully exported ${vms.length} machine(s).`);
      return 0;
    }
    case 'import': {
      const file = (a[0] || '').split('\\').pop().replace(/"/g, '');
      const ova = state.hostFiles.ova.find((o) => o.file.toLowerCase() === file.toLowerCase());
      if (!ova) { ctx.line(`VBoxManage.exe: error: Appliance read failed\nVBoxManage.exe: error: Could not open the file '${a[0]}' (VERR_FILE_NOT_FOUND)`); return 1; }
      ctx.line(`0%...10%...20%...30%...40%...50%...60%...70%...80%...90%...100%\nInterpreting ${ova.path}...\nOK.`);
      if (a.includes('-n') || a.includes('--dry-run')) return 0;
      const created = importOva(ova, { macPolicy: 'nat' });
      ctx.line(`Successfully imported the appliance.\n${created.map((v) => `  "${v.name}"`).join('\n')}`);
      return 0;
    }
    case 'natnetwork': return natnetwork(ctx, a);
    case 'hostonlyif': return hostonlyif(ctx, a);
    case 'dhcpserver': return dhcpserver(ctx, a);
    case 'guestproperty': {
      const vm = findVm(ctx, a[1]); if (!vm) return 1;
      const c = vmContent(state, vm);
      const ga = c?.ga && vm.state === 'running';
      if (a[0] === 'enumerate') { if (!ga) { ctx.line('(sin propiedades de invitado: ¿están instaladas las Guest Additions?)'); return 0; } vm.rt.ifaces.forEach((i, k) => ctx.line(`/VirtualBox/GuestInfo/Net/${k}/V4/IP = '${i.addrs[0]?.ip || ''}'\n/VirtualBox/GuestInfo/Net/${k}/MAC = '${vm.nics[i.slot].mac}'\n/VirtualBox/GuestInfo/Net/${k}/Status = '${i.addrs.length ? 'Up' : 'Down'}'`)); ctx.line(`/VirtualBox/GuestInfo/OS/Product = '${OS_TYPES[c.os].family === 'linux' ? 'Linux' : 'Windows 10'}'\n/VirtualBox/GuestAdd/Version = '7.1.4'`); return 0; }
      if (a[0] === 'get') {
        const m = String(a[2] || '').match(/Net\/(\d+)\/V4\/IP/);
        if (!ga || !m) { ctx.line('No value set!'); return 0; }
        const ip = vm.rt.ifaces[Number(m[1])]?.addrs[0]?.ip;
        ctx.line(ip ? `Value: ${ip}` : 'No value set!');
        ctx.event({ type: 'vboxmanage', cmd: 'guestproperty', vm: vm.id, ok: !!ip });
        return 0;
      }
      return SYNTAX(ctx, 'Incorrect guestproperty subcommand');
    }
    default:
      ctx.line(`VBoxManage.exe: error: Unknown command '${args[0]}'`);
      return 1;
  }
}

function list(ctx, a) {
  const what = (a[0] || '').toLowerCase();
  const long = a.includes('-l') || a.includes('--long');
  switch (what) {
    case 'vms': state.vms.forEach((v) => ctx.line(`"${v.name}" {${v.uuid}}`)); return 0;
    case 'runningvms': state.vms.filter((v) => v.state === 'running' || v.state === 'paused').forEach((v) => ctx.line(`"${v.name}" {${v.uuid}}`)); return 0;
    case 'ostypes': Object.values(OS_TYPES).forEach((o) => ctx.line(`ID:          ${o.subtype}_64\nDescription: ${o.version}\nFamily ID:   ${o.family === 'windows' ? 'Windows' : o.family === 'linux' ? 'Linux' : 'Other'}\n64 bit:      true\n`)); return 0;
    case 'hostonlyifs':
      state.hostOnly.forEach((h, k) => ctx.line(`Name:            ${h.name}\nGUID:            ${(k + 'a1b2c3d4').slice(0, 8)}-5e6f-7a8b-9c0d-0a0027000000\nDHCP:            Disabled\nIPAddress:       ${h.ip}\nNetworkMask:     ${prefixToMask(h.prefix)}\nIPV6Address:     fe80::${k + 1}c4a:f0bd:5e2d:92a1\nIPV6NetworkMaskPrefixLength: 64\nHardwareAddress: 0a:00:27:00:00:${String(k + 10).padStart(2, '0')}\nMediumType:      Ethernet\nWireless:        No\nStatus:          Up\nVBoxNetworkName: HostInterfaceNetworking-${h.name}\n`));
      return 0;
    case 'natnets': case 'natnetworks':
      if (!state.natNets.length) return 0;
      state.natNets.forEach((n) => { const gw = ipAdd(n.cidr.split('/')[0], 1); ctx.line(`NetworkName:    ${n.name}\nIP:             ${gw}\nNetwork:        ${n.cidr}\nIPv6 Enabled:   No\nIPv6 Prefix:    fd17:625c:f037:2::/64\nDHCP Server:    ${n.dhcp ? 'Yes' : 'No'}\nEnabled:        ${n.enabled === false ? 'No' : 'Yes'}`); if (n.pf?.length) { ctx.line('Port-forwarding (ipv4)'); n.pf.forEach((r) => ctx.line(`        ${r.name}:${r.proto}:[${r.hostIp}]:${r.hostPort}:[${r.guestIp}]:${r.guestPort}`)); } ctx.line('loopback mappings (ipv4)\n        127.0.0.1=2\n'); });
      return 0;
    case 'dhcpservers':
      state.hostOnly.filter((h) => h.dhcp).forEach((h) => ctx.line(`NetworkName:    HostInterfaceNetworking-${h.name}\nDhcpd IP:       ${h.dhcp.server}\nLowerIPAddress: ${h.dhcp.lower}\nUpperIPAddress: ${h.dhcp.upper}\nNetworkMask:    ${prefixToMask(h.prefix)}\nEnabled:        ${h.dhcp.enabled ? 'Yes' : 'No'}\n`));
      state.natNets.filter((n) => n.dhcp).forEach((n) => { const b = n.cidr.split('/')[0]; ctx.line(`NetworkName:    ${n.name}\nDhcpd IP:       ${ipAdd(b, 3)}\nLowerIPAddress: ${ipAdd(b, 4)}\nUpperIPAddress: ${ipAdd(b, 254)}\nNetworkMask:    ${prefixToMask(Number(n.cidr.split('/')[1]))}\nEnabled:        Yes\n`); });
      state.intnetDhcp.forEach((d) => ctx.line(`NetworkName:    ${d.network}\nDhcpd IP:       ${d.server}\nLowerIPAddress: ${d.lower}\nUpperIPAddress: ${d.upper}\nNetworkMask:    ${prefixToMask(d.prefix || 24)}\nEnabled:        ${d.enabled !== false ? 'Yes' : 'No'}\n`));
      return 0;
    case 'intnets': { const names = new Set(); state.vms.forEach((v) => v.nics.forEach((n) => { if (n.enabled && n.attach === 'intnet') names.add(n.intnet); })); names.forEach((n) => ctx.line(`Name:        ${n}`)); return 0; }
    case 'bridgedifs': HOST_IFACES.forEach((h) => ctx.line(`Name:            ${h.name}\nDHCP:            Enabled\nIPAddress:       ${h.id === 'eth' ? state.host.eth.ip : '0.0.0.0'}\nNetworkMask:     255.255.255.0\nMediumType:      Ethernet\nWireless:        ${h.id === 'wifi' ? 'Yes' : 'No'}\nStatus:          ${(h.id === 'eth' ? state.host.eth.up : state.host.wifi.up) ? 'Up' : 'Down'}\n`)); return 0;
    case 'hdds': state.media.hdd.forEach((m) => ctx.line(`UUID:           ${m.uuid}\nParent UUID:    ${m.parent ? getMedium(m.parent)?.uuid : 'base'}\nState:          created\nType:           normal (base)\nLocation:       ${m.path}\nStorage format: ${m.format}\nCapacity:       ${m.sizeGB * 1024} MBytes\nEncryption:     disabled\n`)); return 0;
    case 'dvds': state.media.dvd.forEach((m) => ctx.line(`UUID:           ${m.uuid}\nState:          created\nType:           readonly\nLocation:       ${m.path}\nStorage format: RAW\nCapacity:       ${m.sizeMB} MBytes\nEncryption:     disabled\n`)); return 0;
    case 'hostinfo': ctx.line(`Host Information:\n\nHost time: ${new Date().toISOString()}\nProcessor online count: ${state.host.cpus}\nProcessor count: ${state.host.cpus}\nProcessor description: ${state.host.cpuModel}\nMemory size: ${state.host.ramMB} MByte\nMemory available: ${state.host.ramMB - state.vms.filter((v) => v.state === 'running').reduce((x, v) => x + v.hw.ramMB, 0) - 3800} MByte\nOperating system: Windows 11\nOperating system version: 10.0.26100`); return 0;
    case 'systemproperties': ctx.line(`API version:                     7_1\nMinimum guest RAM size:          4 Megabytes\nMaximum guest RAM size:          2097152 Megabytes\nMaximum guest CPU count:         64\nDefault machine folder:          ${state.prefs.machineFolder}`); return 0;
    case 'groups': ctx.line('"/"'); return 0;
    default: ctx.line(`VBoxManage.exe: error: Unknown subcommand '${a[0] || ''}'.\nUsage: VBoxManage list [--long] [--sorted] vms|runningvms|ostypes|hostdvds|hostfloppies|intnets|bridgedifs|hostonlyifs|natnets|dhcpservers|hostinfo|hostcpuids|hddbackends|hdds|dvds|floppies|usbhost|usbfilters|systemproperties|extpacks|groups|webcams|screenshotformats|cloudproviders|cloudprofiles|cloudnets|cpu-profiles|hostdrives`); return 1;
  }
}

function nicLine(vm, n) {
  if (!n.enabled) return 'disabled';
  const att = { nat: 'NAT', natnet: `NAT Network '${n.natnet}'`, bridged: `Bridged Interface '${n.bridged}'`, intnet: `Internal Network '${n.intnet}'`, hostonly: `Host-only Interface '${n.hostonly}'`, none: 'none', generic: 'Generic', cloud: 'Cloud' }[n.attach];
  return `MAC: ${n.mac}, Attachment: ${att}, Cable connected: ${n.cable ? 'on' : 'off'}, Trace: off (file: none), Type: ${n.type}, Reported speed: 0 Mbps, Boot priority: 0, Promisc Policy: ${n.promisc}, Bandwidth group: none`;
}

function showvminfo(ctx, a) {
  const vm = findVm(ctx, a.find((x) => !x.startsWith('--'))); if (!vm) return 1;
  const os = OS_TYPES[vm.osKey];
  const stMap = { poweroff: 'powered off', running: 'running', paused: 'paused', saved: 'saved', aborted: 'aborted' };
  if (a.includes('--machinereadable')) {
    ctx.line(`name="${vm.name}"\nGroups="/"\nostype="${os.version}"\nUUID="${vm.uuid}"\nCfgFile="${vm.folder}\\${vm.name}.vbox"\nmemory=${vm.hw.ramMB}\ncpus=${vm.hw.cpus}\nfirmware="${vm.hw.efi ? 'EFI' : 'BIOS'}"\nVMState="${stMap[vm.state].replace(' ', '')}"`);
    vm.nics.forEach((n, i) => { ctx.line(`nic${i + 1}="${n.enabled ? attachCli[n.attach] : 'none'}"`); if (n.enabled) { ctx.line(`macaddress${i + 1}="${n.mac}"\ncableconnected${i + 1}="${n.cable ? 'on' : 'off'}"\nnictype${i + 1}="${n.type}"`); if (n.attach === 'intnet') ctx.line(`intnet${i + 1}="${n.intnet}"`); if (n.attach === 'hostonly') ctx.line(`hostonlyadapter${i + 1}="${n.hostonly}"`); if (n.attach === 'natnet') ctx.line(`nat-network${i + 1}="${n.natnet}"`); n.pf.forEach((r, k) => ctx.line(`Forwarding(${k})="${r.name},${r.proto},${r.hostIp},${r.hostPort},${r.guestIp},${r.guestPort}"`)); } });
    return 0;
  }
  ctx.line(`Name:                        ${vm.name}\nEncryption:                  disabled\nGroups:                      /\nGuest OS:                    ${os.version}\nUUID:                        ${vm.uuid}\nConfig file:                 ${vm.folder}\\${vm.name}.vbox\nSnapshot folder:             ${vm.folder}\\Snapshots\nLog folder:                  ${vm.folder}\\Logs\nHardware UUID:               ${vm.uuid}\nMemory size:                 ${vm.hw.ramMB}MB\nVRAM size:                   ${vm.hw.vram}MB\nCPU exec cap:                ${vm.hw.cpuCap}%\nNumber of CPUs:              ${vm.hw.cpus}\nFirmware:                    ${vm.hw.efi ? 'EFI' : 'BIOS'}`);
  vm.hw.boot.forEach((b, i) => ctx.line(`Boot Device ${i + 1}:               ${b.on ? { floppy: 'Floppy', dvd: 'DVD', hdd: 'HardDisk', net: 'Network' }[b.dev] : 'Not Assigned'}`));
  ctx.line(`State:                       ${stMap[vm.state]} (since ${new Date(vm.stateChanged).toISOString()})\nGraphics Controller:         ${vm.hw.graphics}`);
  for (const c of vm.storage) {
    ctx.line(`#${vm.storage.indexOf(c)}: '${c.name}', Type: ${c.type}, Instance: 0, Ports: ${c.portCount || 2}, Bootable`);
    c.slots.forEach((s, k) => { const m = getMedium(s.medium); ctx.line(`  Port ${k}, Unit 0: ${m ? `UUID: ${m.uuid}, Location: "${m.path}"` : 'Empty'}`); });
  }
  vm.nics.forEach((n, i) => { ctx.line(`NIC ${i + 1}:                       ${nicLine(vm, n)}`); if (n.enabled && n.attach === 'nat') { ctx.line(`NIC ${i + 1} Settings:  MTU: 0, Socket (send: 64, receive: 64), TCP Window (send:64, receive: 64)`); n.pf.forEach((r, k) => ctx.line(`NIC ${i + 1} Rule(${k}):   name = ${r.name}, protocol = ${r.proto}, host ip = ${r.hostIp}, host port = ${r.hostPort}, guest ip = ${r.guestIp}, guest port = ${r.guestPort}`)); } });
  ctx.line(`Clipboard Mode:              ${vm.hw.clipboard === 'Inhabilitado' ? 'disabled' : 'Bidirectional'}\nUSB:                         ${vm.hw.usb.enabled ? 'enabled' : 'disabled'}\n\nShared folders:${vm.shared.length ? '' : '              <none>'}`);
  vm.shared.forEach((s) => ctx.line(`\nName: '${s.name}', Host path: '${s.hostPath}' (machine mapping), ${s.readonly ? 'readonly' : 'writable'}${s.automount ? ', auto-mount' : ''}`));
  const c = vmContent(state, vm);
  if (vm.state === 'running') ctx.line(`\nGuest:\n\nConfigured memory balloon:   0MB\nOS type:                     ${c ? os.version : 'Unknown'}\nAdditions run level:         ${c?.ga ? 2 : 0}${c?.ga ? '\nAdditions version            7.1.4 r165100' : ''}`);
  if (vm.snapshots.length) { ctx.line('\nSnapshots:\n'); printSnapTree(ctx, vm, null, 1); }
  return 0;
}
function printSnapTree(ctx, vm, parent, depth) {
  vm.snapshots.filter((s) => (s.parent || null) === parent).forEach((s) => { ctx.line(`${'   '.repeat(depth)}Name: ${s.name} (UUID: ${s.uuid})${vm.currentSnap === s.id ? ' *' : ''}`); printSnapTree(ctx, vm, s.id, depth + 1); });
}

async function controlvm(ctx, a) {
  const vm = findVm(ctx, a[0]); if (!vm) return 1;
  const cmd = (a[1] || '').toLowerCase();
  if (vm.state !== 'running' && vm.state !== 'paused') { ctx.line(`VBoxManage.exe: error: Machine '${vm.name}' is not currently running`); return 1; }
  if (cmd === 'poweroff') { ctx.line('0%...10%...20%...30%...40%...50%...60%...70%...80%...90%...100%'); powerOff(vm); return 0; }
  if (cmd === 'acpipowerbutton') { acpiShutdown(vm); return 0; }
  if (cmd === 'pause') { pauseVm(vm); return 0; }
  if (cmd === 'resume') { resumeVm(vm); return 0; }
  if (cmd === 'reset') { rebootVm(vm); return 0; }
  if (cmd === 'savestate') { ctx.line('0%...10%...20%...30%...40%...50%...60%...70%...80%...90%...100%'); saveState(vm); return 0; }
  let m = cmd.match(/^setlinkstate(\d)$/);
  if (m) { const n = vm.nics[Number(m[1]) - 1]; if (!n?.enabled) return SYNTAX(ctx, `NIC ${m[1]} is not enabled`); n.cable = a[2] === 'on'; linkChanged(state, vm); commit(); ctx.event({ type: 'cable', vm: vm.id, slot: n.slot, on: n.cable }); return 0; }
  m = cmd.match(/^nic(\d)$/);
  if (m) {
    const n = vm.nics[Number(m[1]) - 1]; if (!n?.enabled) return SYNTAX(ctx, `NIC ${m[1]} is not enabled`);
    const at = cliToAttach[a[2]]; if (!at) return SYNTAX(ctx, `Invalid type '${a[2]}' specfied for NIC ${m[1]}`);
    n.attach = at;
    if (a[3]) { if (at === 'intnet') n.intnet = a[3]; if (at === 'hostonly') n.hostonly = a[3]; if (at === 'natnet') n.natnet = a[3]; if (at === 'bridged') n.bridged = a[3]; }
    linkChanged(state, vm); commit(); return 0;
  }
  m = cmd.match(/^natpf(\d)$/);
  if (m) {
    const n = vm.nics[Number(m[1]) - 1];
    if (!n?.enabled || n.attach !== 'nat') return SYNTAX(ctx, `NIC ${m[1]} is not attached to NAT`);
    if (a[2] === 'delete') { n.pf = n.pf.filter((r) => r.name !== a[3]); commit(); return 0; }
    const r = parsePfRule(a[2]); if (!r) return SYNTAX(ctx, 'Invalid NAT rule format. Expected: name,tcp|udp,[hostip],hostport,[guestip],guestport');
    if (n.pf.some((x) => x.name === r.name)) { ctx.line('VBoxManage.exe: error: A NAT rule of this name already exists'); return 1; }
    n.pf.push(r); commit(); ctx.event({ type: 'pf-add', vm: vm.id, rule: r }); return 0;
  }
  ctx.line(`VBoxManage.exe: error: Invalid parameter '${a[1]}'`);
  return 1;
}

function modifyvm(ctx, a) {
  const vm = findVm(ctx, a[0]); if (!vm) return 1;
  if (vm.state === 'running' || vm.state === 'paused') { ctx.line(`VBoxManage.exe: error: The machine '${vm.name}' is already locked for a session (or being unlocked)\nVBoxManage.exe: error: Details: code VBOX_E_INVALID_OBJECT_STATE (0x80bb0007), component MachineWrap, interface IMachine`); return 1; }
  const args = a.slice(1);
  for (let i = 0; i < args.length; i++) {
    const k = args[i].replace(/^--/, '').toLowerCase().replace(/-/g, '');
    const v = args[i + 1];
    let m;
    if (k === 'memory') { vm.hw.ramMB = Number(v); i++; continue; }
    if (k === 'cpus') { vm.hw.cpus = Number(v); i++; continue; }
    if (k === 'vram') { vm.hw.vram = Number(v); i++; continue; }
    if (k === 'name') { vm.name = v; i++; continue; }
    if (k === 'description') { vm.description = v; i++; continue; }
    if (k === 'firmware') { vm.hw.efi = v === 'efi'; i++; continue; }
    if ((m = k.match(/^boot(\d)$/))) { const map = { dvd: 'dvd', disk: 'hdd', net: 'net', floppy: 'floppy' }; const idx = Number(m[1]) - 1; if (v === 'none') vm.hw.boot[idx].on = false; else { const dev = map[v]; const j = vm.hw.boot.findIndex((b) => b.dev === dev); const [b] = vm.hw.boot.splice(j, 1); b.on = true; vm.hw.boot.splice(idx, 0, b); } i++; continue; }
    if ((m = k.match(/^nic(\d)$/))) { const n = vm.nics[Number(m[1]) - 1]; const at = cliToAttach[v]; if (!at) return SYNTAX(ctx, `Invalid type '${v}' specfied for NIC ${m[1]}`); n.enabled = at !== 'none' || v === 'null'; n.attach = at; if (v === 'none') n.enabled = false; i++; continue; }
    if ((m = k.match(/^(?:nictype|nic-type)(\d)$/))) { const n = vm.nics[Number(m[1]) - 1]; if (!NIC_TYPES.some((t) => t.id === v)) return SYNTAX(ctx, `Invalid NIC type '${v}' specified for NIC ${m[1]}`); n.type = v; i++; continue; }
    if ((m = k.match(/^intnet(\d)$/))) { vm.nics[Number(m[1]) - 1].intnet = v; i++; continue; }
    if ((m = k.match(/^(?:natnetwork|natnet)(\d)$/))) { vm.nics[Number(m[1]) - 1].natnet = v; i++; continue; }
    if ((m = k.match(/^(?:hostonlyadapter)(\d)$/))) { vm.nics[Number(m[1]) - 1].hostonly = v; i++; continue; }
    if ((m = k.match(/^(?:bridgeadapter)(\d)$/))) { vm.nics[Number(m[1]) - 1].bridged = v; i++; continue; }
    if ((m = k.match(/^(?:cableconnected)(\d)$/))) { vm.nics[Number(m[1]) - 1].cable = v === 'on'; i++; continue; }
    if ((m = k.match(/^(?:macaddress)(\d)$/))) { const n = vm.nics[Number(m[1]) - 1]; if (v === 'auto') n.mac = vboxMac(); else if (isValidMac(v)) n.mac = normMac(v); else return SYNTAX(ctx, `Invalid MAC address '${v}'`); i++; continue; }
    if ((m = k.match(/^(?:nicpromisc)(\d)$/))) { vm.nics[Number(m[1]) - 1].promisc = v === 'allow-all' ? 'allow-all' : v === 'allow-vms' ? 'allow-vms' : 'deny'; i++; continue; }
    if ((m = k.match(/^(?:natpf)(\d)$/))) {
      const n = vm.nics[Number(m[1]) - 1];
      if (v === 'delete') { n.pf = n.pf.filter((r) => r.name !== args[i + 2]); i += 2; continue; }
      const r = parsePfRule(v); if (!r) return SYNTAX(ctx, 'Invalid NAT rule format. Expected: name,tcp|udp,[hostip],hostport,[guestip],guestport');
      if (n.pf.some((x) => x.name === r.name)) { ctx.line('VBoxManage.exe: error: A NAT rule of this name already exists'); return 1; }
      n.pf.push(r); ctx.event({ type: 'pf-add', vm: vm.id, rule: r }); i++; continue;
    }
    ctx.line(`VBoxManage.exe: error: Unknown option: ${args[i]}`);
    return 1;
  }
  commit();
  ctx.event({ type: 'vboxmanage', cmd: 'modifyvm', vm: vm.id, args });
  return 0;
}

function snapshot(ctx, a) {
  const vm = findVm(ctx, a[0]); if (!vm) return 1;
  const sub = (a[1] || '').toLowerCase();
  const find = (n) => vm.snapshots.find((s) => s.name === n || s.uuid === n);
  if (sub === 'take') { const name = a[2]; if (!name) return SYNTAX(ctx, 'Missing snapshot name'); ctx.line('0%...10%...20%...30%...40%...50%...60%...70%...80%...90%...100%'); const s = takeSnapshot(vm, name, opt(a, '--description') || ''); ctx.line(`Snapshot taken. UUID: ${s.uuid}`); return 0; }
  if (sub === 'list') { if (!vm.snapshots.length) { ctx.line('This machine does not have any snapshots'); return 1; } printSnapTree(ctx, vm, null, 0); return 0; }
  if (sub === 'restore' || sub === 'restorecurrent') {
    const s = sub === 'restorecurrent' ? vm.snapshots.find((x) => x.id === vm.currentSnap) : find(a[2]);
    if (!s) { ctx.line(`VBoxManage.exe: error: Could not find a snapshot named '${a[2]}'`); return 1; }
    const r = restoreSnapshot(vm, s.id);
    if (!r.ok) { ctx.line(`VBoxManage.exe: error: ${r.error}`); return 1; }
    ctx.line(`Restoring snapshot '${s.name}' (${s.uuid})\n0%...10%...20%...30%...40%...50%...60%...70%...80%...90%...100%`);
    return 0;
  }
  if (sub === 'delete') { const s = find(a[2]); if (!s) { ctx.line(`VBoxManage.exe: error: Could not find a snapshot named '${a[2]}'`); return 1; } deleteSnapshot(vm, s.id); ctx.line('0%...10%...20%...30%...40%...50%...60%...70%...80%...90%...100%'); return 0; }
  return SYNTAX(ctx, `Invalid parameter '${a[1]}'`);
}

function natnetwork(ctx, a) {
  const sub = (a[0] || '').toLowerCase();
  const name = opt(a, '--netname');
  if (sub === 'list') return list(ctx, ['natnets']);
  if (sub === 'add') {
    const net = opt(a, '--network');
    if (!name || !net) return SYNTAX(ctx, 'A net name (--netname) and network (--network) are required');
    if (natNetOf(state, name)) { ctx.line(`VBoxManage.exe: error: NATNetwork server already exists`); return 1; }
    const p = String(net).replace(/"/g, '').split('/');
    if (!isIp(p[0]) || !p[1]) return SYNTAX(ctx, `Invalid network '${net}'`);
    state.natNets.push({ name, cidr: `${networkAddr(p[0], Number(p[1]))}/${p[1]}`, dhcp: (opt(a, '--dhcp') || 'on') !== 'off', enabled: !a.includes('--disable'), pf: [] });
    commit(); ctx.event({ type: 'natnet-add', name });
    return 0;
  }
  const n = natNetOf(state, name);
  if (!n) { ctx.line(`VBoxManage.exe: error: Failed to find NAT network '${name}'`); return 1; }
  if (sub === 'remove') { state.natNets = state.natNets.filter((x) => x !== n); commit(); return 0; }
  if (sub === 'start') { n.enabled = true; commit(); return 0; }
  if (sub === 'stop') { n.enabled = false; commit(); return 0; }
  if (sub === 'modify') {
    const dhcp = opt(a, '--dhcp'); if (dhcp) n.dhcp = dhcp !== 'off';
    const pf = opt(a, '--port-forward-4');
    if (pf === 'delete') { const nm = a[a.indexOf('delete') + 1]; n.pf = n.pf.filter((r) => r.name !== nm); }
    else if (pf) { const r = parsePfRule(pf); if (!r) return SYNTAX(ctx, 'Invalid port-forward rule'); n.pf.push(r); ctx.event({ type: 'pf-add', natnet: n.name, rule: r }); }
    commit();
    return 0;
  }
  return SYNTAX(ctx, `Invalid parameter '${a[0]}'`);
}

function hostonlyif(ctx, a) {
  const sub = (a[0] || '').toLowerCase();
  if (sub === 'create') {
    const idx = state.hostOnly.length + 1;
    const name = `VirtualBox Host-Only Ethernet Adapter #${idx}`;
    const ip = `192.168.${55 + idx}.1`;
    state.hostOnly.push({ name, ip, prefix: 24, dhcp: { enabled: false, server: ipAdd(ip, 99), lower: ipAdd(ip, 100), upper: ipAdd(ip, 253) } });
    ctx.line(`0%...10%...20%...30%...40%...50%...60%...70%...80%...90%...100%\nInterface '${name}' was successfully created`);
    commit(); return 0;
  }
  const nm = a[1]?.replace(/"/g, '');
  const h = hostOnlyOf(state, nm);
  if (!h) { ctx.line(`VBoxManage.exe: error: Could not find interface '${nm}'`); return 1; }
  if (sub === 'remove') { state.hostOnly = state.hostOnly.filter((x) => x !== h); commit(); return 0; }
  if (sub === 'ipconfig') {
    const ip = opt(a, '--ip'); const mask = opt(a, '--netmask');
    if (!isIp(ip)) return SYNTAX(ctx, 'Invalid --ip');
    h.ip = ip; if (mask) h.prefix = maskToPrefix(mask) ?? 24;
    commit(); ctx.event({ type: 'hostonly-ip', name: h.name, ip });
    return 0;
  }
  return SYNTAX(ctx, `Invalid parameter '${a[0]}'`);
}

function dhcpserver(ctx, a) {
  const sub = (a[0] || '').toLowerCase();
  const netOpt = opt(a, '--network', '--netname');
  const ifOpt = opt(a, '--interface', '--ifname');
  if (ifOpt) {
    const h = hostOnlyOf(state, ifOpt.replace(/"/g, ''));
    if (!h) { ctx.line(`VBoxManage.exe: error: Could not find interface '${ifOpt}'`); return 1; }
    if (sub === 'modify' || sub === 'add') {
      if (a.includes('--disable')) h.dhcp.enabled = false;
      if (a.includes('--enable')) h.dhcp.enabled = true;
      const sip = opt(a, '--server-ip', '--ip'); if (sip) h.dhcp.server = sip;
      const lo = opt(a, '--lower-ip', '--lowerip'); if (lo) h.dhcp.lower = lo;
      const up = opt(a, '--upper-ip', '--upperip'); if (up) h.dhcp.upper = up;
      commit(); ctx.event({ type: 'dhcp-cfg', hostonly: h.name, enabled: h.dhcp.enabled });
      return 0;
    }
    if (sub === 'remove') { h.dhcp.enabled = false; commit(); return 0; }
  }
  if (netOpt) {
    const network = netOpt.replace(/"/g, '');
    let d = state.intnetDhcp.find((x) => x.network === network);
    if (sub === 'add') {
      if (d) { ctx.line('VBoxManage.exe: error: DHCP server already exists'); return 1; }
      const server = opt(a, '--server-ip', '--ip'); const mask = opt(a, '--netmask'); const lower = opt(a, '--lower-ip', '--lowerip'); const upper = opt(a, '--upper-ip', '--upperip');
      if (![server, mask, lower, upper].every(isIp)) return SYNTAX(ctx, 'Missing or invalid --server-ip/--netmask/--lower-ip/--upper-ip');
      state.intnetDhcp.push({ network, server, prefix: maskToPrefix(mask) ?? 24, lower, upper, enabled: a.includes('--enable') || !a.includes('--disable'), gw: null, dns: [] });
      commit(); ctx.event({ type: 'dhcp-cfg', intnet: network, enabled: true });
      return 0;
    }
    if (!d) { ctx.line(`VBoxManage.exe: error: DHCP server does not exist for network '${network}'`); return 1; }
    if (sub === 'remove') { state.intnetDhcp = state.intnetDhcp.filter((x) => x !== d); commit(); return 0; }
    if (sub === 'modify') { if (a.includes('--disable')) d.enabled = false; if (a.includes('--enable')) d.enabled = true; const gw = opt(a, '--set-opt'); if (gw) { /* opción 3 = router */ } commit(); return 0; }
  }
  return SYNTAX(ctx, 'dhcpserver: --network=<intnet> o --interface=<host-only> requerido');
}

export { validateVm, macColon, attachLabel, osKeyFromVersion, allSlots, uuid };
