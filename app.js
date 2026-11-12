/**
 * ============================================================================
 * VirtLab - Simulador Educativo de Oracle VM VirtualBox Administrador
 * Código Final Consolidado (Fases 1, 2, 3, 4, 5 y 6) en Vanilla JavaScript (ES6+)
 *
 * Incluye:
 *  - Fase 1: Interfaz Skeumórfica/Desktop, Clase VirtualMachine, Asistente "Nueva"
 *  - Fase 2: Modal de Configuración de Red (4 Adaptadores) + Clase NetworkEngine
 *  - Fase 3: Consola Interactiva (TTY Linux / CMD Windows), `ip a`, `ipconfig`, `ping`
 *  - Fase 4: Panel de Troubleshooting ("Modo Dios" / Opciones del Instructor)
 *            con inyección en caliente de:
 *              1) Desconectar cable ("Network is unreachable" y Timeout en DHCP)
 *              2) Regla DROP en iptables/Firewall ("Request timed out")
 *              3) MAC Address Duplicada / IP Conflict en Puente (caídas aleatorias)
 *            + Botón "Restaurar estado de laboratorio".
 *  - Fase 5: Estado Compartible (Escenarios por URL `?escenario=[hash_base64]`)
 *            mediante `exportarEscenario()` (con `btoa()`) y `cargarEscenario()`
 *            en `window.onload` (con `atob()`, `try/catch` y alerta "Escenario inválido").
 *  - Fase 6: Motor DHCP Interactivo en Terminal (Proceso DORA paso a paso con `setTimeout`)
 *            mediante `dhclient` (Linux) e `ipconfig /renew` (Windows).
 *  - Fase 7: Reenvío de Puertos (Port Forwarding) exclusivo del modo NAT + Consola del Anfitrión
 *            con soporte para `curl localhost:[Puerto_Anfitrión]`.
 * ============================================================================
 */

const STORAGE_KEY = 'virtlab_vms_consolidated_v6';
const HOST_CONSOLE_ID = '__HOST__';
const HOST_TOTAL_RAM_MB = 16384;
const HOST_TOTAL_CPUS = 8;

/**
 * Direcciones IP Fijas de la Infraestructura del Laboratorio y Servidores DHCP
 */
export const LAB_INFRASTRUCTURE_IPS = {
  HOST_PHYSICAL_LAN: '192.168.1.100',
  HOST_PHYSICAL_GW: '192.168.1.1',
  HOST_ONLY_ADAPTER: '192.168.56.1',
  HOST_ONLY_DHCP_SERVER: '192.168.56.100',
  INTERNET_DNS: '8.8.8.8',
  NAT_GATEWAY: '10.0.2.2',
  CONFLICT_BRIDGE_IP: '192.168.1.150',
  CONFLICT_MAC: '080027DEAD99'
};

/**
 * Catálogo de versiones por Sistema Operativo
 */
const OS_VERSIONS = {
  Linux: [
    'Ubuntu (64-bit)',
    'Debian (64-bit)',
    'Red Hat / Rocky Linux (64-bit)',
    'Linux Mint (64-bit)',
    'Arch Linux (64-bit)',
    'Other Linux (64-bit)'
  ],
  Windows: [
    'Windows 10 (64-bit)',
    'Windows 11 (64-bit)',
    'Windows Server 2022 (64-bit)',
    'Windows Server 2019 (64-bit)',
    'Windows 7 (64-bit)'
  ]
};

/**
 * Genera una dirección MAC con el prefijo OUI oficial de Oracle VirtualBox (08:00:27)
 */
function generateVBoxMAC() {
  const hex = '0123456789ABCDEF';
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += hex[Math.floor(Math.random() * 16)];
  }
  return `080027${suffix}`;
}

/**
 * Formatea una cadena MAC de 12 caracteres como 08:00:27:XX:XX:XX
 */
function formatMacColon(macStr = '080027000000') {
  const clean = String(macStr).replace(/[^0-9A-Fa-f]/g, '').toUpperCase().padEnd(12, '0');
  return clean.match(/.{1,2}/g).join(':');
}

/**
 * ============================================================================
 * CLASE NetworkEngine (Fases 2, 3 y 4)
 * - Asigna IPs al iniciar una VM según el modo de cada adaptador.
 * - Evalúa las reglas estrictas de enrutamiento y los 3 fallos de Troubleshooting.
 * ============================================================================
 */
export class NetworkEngine {
  /**
   * Calcula los parámetros que ofrecerá el servidor DHCP simulado durante el proceso DORA (Fase 6)
   */
  static getDhcpOfferDetails(targetVm, adapter, idx = 0, allVms = []) {
    if (adapter.forcedConflictIp && adapter.mode === 'Adaptador Puente') {
      return {
        hasDhcpServer: true,
        serverIp: LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_GW,
        offeredIp: adapter.forcedConflictIp,
        cidr: `${adapter.forcedConflictIp}/24`,
        netmask: '255.255.255.0',
        gateway: LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_GW,
        dns: LAB_INFRASTRUCTURE_IPS.INTERNET_DNS,
        dhcpStatus: 'CONFLICTO ARP / IP DUPLICADA EN PUENTE',
        isWarning: true,
        isFault: true,
        note: `Colisión de IP (${adapter.forcedConflictIp}) y MAC (${formatMacColon(adapter.mac)}) detectada en la LAN.`
      };
    }

    switch (adapter.mode) {
      case 'NAT': {
        const natOctet = idx === 0 ? 2 : idx + 2;
        const ipAddr = idx === 0 ? '10.0.2.15' : `10.0.${natOctet}.15`;
        const serverIp = `10.0.${natOctet}.2`;
        return {
          hasDhcpServer: true,
          serverIp,
          offeredIp: ipAddr,
          cidr: `${ipAddr}/24`,
          netmask: '255.255.255.0',
          gateway: serverIp,
          dns: `10.0.${natOctet}.3`,
          dhcpStatus: `Concesión DHCP activa (Servidor NAT ${serverIp})`,
          isWarning: false,
          isFault: false,
          note: 'Salida a Internet mediante traducción de direcciones del Host (aislada desde el exterior).'
        };
      }

      case 'Adaptador Puente': {
        const usedBridgeOctets = this.getUsedLastOctets(allVms, targetVm.id, '192.168.1.');
        usedBridgeOctets.add(1);
        usedBridgeOctets.add(100);
        usedBridgeOctets.add(150);
        const hostOctet = this.allocateUniqueOctet(adapter.mac, 101, 240, usedBridgeOctets);
        const ipAddr = `192.168.1.${hostOctet}`;
        return {
          hasDhcpServer: true,
          serverIp: LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_GW,
          offeredIp: ipAddr,
          cidr: `${ipAddr}/24`,
          netmask: '255.255.255.0',
          gateway: LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_GW,
          dns: LAB_INFRASTRUCTURE_IPS.INTERNET_DNS,
          dhcpStatus: `Concesión DHCP activa (Router LAN ${LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_GW})`,
          isWarning: false,
          isFault: false,
          note: 'Visible por todos en la red física 192.168.1.0/24 (Anfitrión, otras VMs Puente e Internet).'
        };
      }

      case 'Adaptador sólo-anfitrión': {
        const usedHostOnlyOctets = this.getUsedLastOctets(allVms, targetVm.id, '192.168.56.');
        usedHostOnlyOctets.add(1);
        usedHostOnlyOctets.add(100);
        const hostOnlyOctet = this.allocateUniqueOctet(adapter.mac, 101, 250, usedHostOnlyOctets);
        const ipAddr = `192.168.56.${hostOnlyOctet}`;
        return {
          hasDhcpServer: true,
          serverIp: LAB_INFRASTRUCTURE_IPS.HOST_ONLY_DHCP_SERVER,
          offeredIp: ipAddr,
          cidr: `${ipAddr}/24`,
          netmask: '255.255.255.0',
          gateway: LAB_INFRASTRUCTURE_IPS.HOST_ONLY_ADAPTER,
          dns: '-',
          dhcpStatus: `Concesión DHCP activa (Host-Only ${LAB_INFRASTRUCTURE_IPS.HOST_ONLY_DHCP_SERVER})`,
          isWarning: false,
          isFault: false,
          note: 'Ve al Anfitrión (192.168.56.1) y otras VMs Host-Only, pero NO tiene acceso a Internet.'
        };
      }

      case 'Red interna': {
        const apipaA = this.hashMacByte(adapter.mac, 0, 1, 254);
        const apipaB = this.hashMacByte(adapter.mac, 2, 10, 250);
        const netName = adapter.intnetName || 'intnet';
        const ipAddr = `169.254.${apipaA}.${apipaB}`;
        return {
          hasDhcpServer: false,
          serverIp: null,
          offeredIp: ipAddr,
          cidr: `${ipAddr}/16`,
          netmask: '255.255.0.0',
          gateway: 'Sin puerta de enlace',
          dns: '-',
          dhcpStatus: `Sin servidor DHCP en '${netName}' (APIPA / Manual requerido)`,
          isWarning: true,
          isFault: false,
          note: `Red aislada "${netName}". Solo ve a otras VMs conectadas a "${netName}".`
        };
      }

      default:
        return null;
    }
  }

  /**
   * Calcula y actualiza el estado de IP de todos los adaptadores habilitados de una VM.
   * Fase 6: Al arrancar una VM, NO tiene IP asignada inmediatamente (salvo si se configuró
   * como estática en una red interna), hasta que el alumno ejecuta `dhclient` o `ipconfig /renew`.
   */
  static assignIPsForVM(targetVm, allVms = []) {
    if (!targetVm || !Array.isArray(targetVm.adapters)) return;

    if (targetVm.state !== 'Corriendo') {
      targetVm.adapters.forEach((adapter) => {
        adapter.ipInfo = null;
      });
      return;
    }

    targetVm.adapters.forEach((adapter, idx) => {
      if (!adapter.enabled) {
        adapter.ipInfo = null;
        return;
      }

      // FALLO 1 (Cable Desconectado): No hay portadora física
      if (!adapter.cableConnected) {
        adapter.ipInfo = {
          ip: 'Sin conexión (Cable desconectado)',
          hasIp: false,
          cidr: '-',
          netmask: '-',
          gateway: '-',
          dhcpStatus: 'LINK_DOWN (NO-CARRIER)',
          isWarning: true,
          isFault: true,
          note: 'El cable de red virtual está desconectado (Network is unreachable).'
        };
        return;
      }

      // EXCEPCIÓN FASE 6: IP estática manual configurada en Red interna sí está disponible al arrancar
      if (adapter.manualStaticIp && adapter.mode === 'Red interna') {
        adapter.ipInfo = {
          ip: adapter.manualStaticIp,
          hasIp: true,
          cidr: `${adapter.manualStaticIp}/24`,
          netmask: '255.255.255.0',
          gateway: 'Sin puerta de enlace',
          dns: '-',
          dhcpStatus: `IP Estática Manual en '${adapter.intnetName || 'intnet'}'`,
          isWarning: false,
          isFault: false,
          note: `Configurada como IP estática en la red interna '${adapter.intnetName || 'intnet'}'.`
        };
        return;
      }

      // FASE 6: Si aún no se ha completado el proceso DORA (dhclient / ipconfig /renew),
      // la interfaz arranca sin dirección IP asignada.
      if (!adapter.dhcpLeased) {
        const renewCmd = targetVm.os === 'Windows' ? 'ipconfig /renew' : 'dhclient';
        adapter.ipInfo = {
          ip: 'Sin IP (Pendiente DHCP)',
          hasIp: false,
          isPendingDhcp: true,
          cidr: '-',
          netmask: '-',
          gateway: '-',
          dns: '-',
          dhcpStatus: `Sin concesión DHCP (Ejecuta "${renewCmd}")`,
          isWarning: true,
          isFault: false,
          note: `La interfaz eth${adapter.slot - 1} aún no tiene IP. Ejecuta "${renewCmd}" en la consola para iniciar el proceso DORA.`
        };
        return;
      }

      // Si dhcpLeased === true, asignar la IP obtenida en el proceso DORA
      const offer = this.getDhcpOfferDetails(targetVm, adapter, idx, allVms);
      if (offer) {
        adapter.ipInfo = {
          ip: offer.offeredIp,
          hasIp: true,
          cidr: offer.cidr,
          netmask: offer.netmask,
          gateway: offer.gateway,
          dns: offer.dns,
          dhcpStatus: offer.dhcpStatus,
          isWarning: offer.isWarning,
          isFault: offer.isFault,
          note: offer.note
        };
      } else {
        adapter.ipInfo = null;
      }
    });
  }

  /**
   * Comprueba si una IP o una VM sufre conflicto de IP / MAC duplicada en el inventario activo
   */
  static hasIpOrMacConflict(sourceVm, targetIp, allVms = []) {
    const runningBridgeAdapters = [];
    allVms.forEach((vm) => {
      if (vm.state !== 'Corriendo') return;
      vm.getEnabledAdapters().forEach((ad) => {
        if (ad.cableConnected && ad.mode === 'Adaptador Puente' && ad.ipInfo?.ip) {
          runningBridgeAdapters.push({ vm, adapter: ad, ip: ad.ipInfo.ip, mac: ad.mac });
        }
      });
    });

    // Verificar si hay más de un adaptador con la misma IP o la misma MAC
    const ipCounts = {};
    const macCounts = {};
    runningBridgeAdapters.forEach((item) => {
      ipCounts[item.ip] = (ipCounts[item.ip] || 0) + 1;
      macCounts[item.mac] = (macCounts[item.mac] || 0) + 1;
    });

    // ¿El destino es una IP duplicada o el origen tiene una IP/MAC duplicada en Puente?
    if (ipCounts[targetIp] > 1) return true;

    const srcHasConflict = sourceVm
      .getEnabledAdapters()
      .some(
        (ad) =>
          ad.cableConnected &&
          ad.mode === 'Adaptador Puente' &&
          ad.ipInfo?.ip &&
          (ipCounts[ad.ipInfo.ip] > 1 || macCounts[ad.mac] > 1)
      );

    return srcHasConflict;
  }

  /**
   * Evalúa las reglas de enrutamiento y los 3 fallos de Troubleshooting (Fase 4)
   * cuando `sourceVm` ejecuta `ping [targetIp]`
   */
  static evaluatePing(sourceVm, rawTargetIp, allVms = []) {
    const targetIp = String(rawTargetIp || '').trim();

    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipv4Regex.test(targetIp)) {
      return {
        reachable: false,
        sourceIp: '-',
        adapterUsed: null,
        ttl: 64,
        baseLatencyMs: 0,
        errorCode: 'INVALID_HOST',
        reason: `Dirección IP inválida o host desconocido: "${targetIp}". Usa una dirección IPv4 como 8.8.8.8, 192.168.1.100 o 192.168.56.1.`
      };
    }

    // 0. Loopback (127.0.0.1)
    if (targetIp === '127.0.0.1' || targetIp === 'localhost') {
      return {
        reachable: true,
        sourceIp: '127.0.0.1',
        adapterUsed: 'lo (Loopback)',
        ttl: sourceVm.os === 'Windows' ? 128 : 64,
        baseLatencyMs: 0.3,
        reason: 'Tráfico interno hacia la interfaz de bucle invertido (loopback 127.0.0.1).'
      };
    }

    const enabledAdapters = sourceVm.getEnabledAdapters();
    if (enabledAdapters.length === 0) {
      return {
        reachable: false,
        sourceIp: 'Sin IP',
        adapterUsed: null,
        ttl: 64,
        baseLatencyMs: 0,
        errorCode: 'NETWORK_UNREACHABLE',
        reason: 'La máquina virtual no tiene ningún adaptador de red habilitado.'
      };
    }

    // FALLO 1 (Fase 4): Si todos los adaptadores habilitados tienen el cable desconectado -> "Network is unreachable"
    const cableConnectedAdapters = enabledAdapters.filter((a) => a.cableConnected);

    if (cableConnectedAdapters.length === 0) {
      return {
        reachable: false,
        sourceIp: '0.0.0.0',
        adapterUsed: `Adaptador ${enabledAdapters[0].slot}`,
        ttl: 64,
        baseLatencyMs: 0,
        errorCode: 'NETWORK_UNREACHABLE',
        reason: `Fallo físico ("Cable desconectado"): El adaptador de red de "${sourceVm.name}" no tiene portadora (NO-CARRIER). El kernel devuelve inmediatamente "Network is unreachable".`
      };
    }

    // FASE 6: Comprobar si los adaptadores conectados tienen IP asignada (por DHCP DORA o estática)
    const activeAdapters = cableConnectedAdapters.filter(
      (a) =>
        a.ipInfo &&
        a.ipInfo.hasIp !== false &&
        !a.ipInfo.isPendingDhcp &&
        !a.ipInfo.ip.startsWith('Sin ')
    );

    if (activeAdapters.length === 0) {
      const renewCmd = sourceVm.os === 'Windows' ? 'ipconfig /renew' : 'dhclient';
      return {
        reachable: false,
        sourceIp: '0.0.0.0',
        adapterUsed: `Adaptador ${cableConnectedAdapters[0].slot}`,
        ttl: 64,
        baseLatencyMs: 0,
        errorCode: 'NO_DHCP_LEASE',
        reason: `Sin dirección IP asignada: La máquina "${sourceVm.name}" ha arrancado sin concesión DHCP. Ejecuta "${renewCmd}" en la terminal para completar el proceso DORA y obtener una IP.`
      };
    }

    // Ping a una IP propia de la misma VM
    const ownAdapter = activeAdapters.find((a) => a.ipInfo.ip === targetIp);
    if (ownAdapter) {
      if (sourceVm.firewallDropIcmp) {
        return {
          reachable: false,
          sourceIp: ownAdapter.ipInfo.ip,
          adapterUsed: `Adaptador ${ownAdapter.slot}`,
          ttl: 64,
          baseLatencyMs: 0,
          errorCode: 'FIREWALL_TIMEOUT',
          reason: `Fallo Firewall DROP: La propia VM "${sourceVm.name}" tiene una regla activa en iptables/Firewall que descarta (DROP) los paquetes ICMP Echo Request ("Request timed out").`
        };
      }
      return {
        reachable: true,
        sourceIp: ownAdapter.ipInfo.ip,
        adapterUsed: `Adaptador ${ownAdapter.slot} (${ownAdapter.mode})`,
        ttl: sourceVm.os === 'Windows' ? 128 : 64,
        baseLatencyMs: 0.4,
        reason: `Respuesta local desde la propia interfaz Adaptador ${ownAdapter.slot} (${targetIp}).`
      };
    }

    const isConflictActive = this.hasIpOrMacConflict(sourceVm, targetIp, allVms);

    // 1. Destino: INTERNET (8.8.8.8 o 1.1.1.1)
    if (targetIp === LAB_INFRASTRUCTURE_IPS.INTERNET_DNS || targetIp === '1.1.1.1') {
      const bridgeAd = activeAdapters.find((a) => a.mode === 'Adaptador Puente');
      const natAd = activeAdapters.find((a) => a.mode === 'NAT');
      const internetAd = natAd || bridgeAd;

      if (internetAd) {
        // Si la VM origen tiene Firewall DROP activo, bloquea el ping
        if (sourceVm.firewallDropIcmp) {
          return {
            reachable: false,
            sourceIp: internetAd.ipInfo.ip,
            adapterUsed: `Adaptador ${internetAd.slot} (${internetAd.mode})`,
            ttl: 56,
            baseLatencyMs: 0,
            errorCode: 'FIREWALL_TIMEOUT',
            reason: `Fallo Firewall DROP: El enlace físico existe, pero el firewall local de "${sourceVm.name}" tiene una regla DROP para tráfico ICMP ("Request timed out").`
          };
        }

        const conflictOnBridge = internetAd.mode === 'Adaptador Puente' && isConflictActive;
        return {
          reachable: true,
          hasPacketLossConflict: conflictOnBridge,
          sourceIp: internetAd.ipInfo.ip,
          adapterUsed: `Adaptador ${internetAd.slot} (${internetAd.mode})`,
          ttl: 56,
          baseLatencyMs: internetAd.mode === 'NAT' ? 14.2 : 11.4,
          reason: conflictOnBridge
            ? `Fallo Conflicto IP/MAC en Puente: Aunque hay ruta hacia Internet (${targetIp}), existe una colisión ARP/IP en el Adaptador Puente que provoca pérdida aleatoria de paquetes.`
            : internetAd.mode === 'NAT'
              ? `Regla NAT: El paquete sale a Internet (${targetIp}) traducido por el motor NAT del Anfitrión (Gateway 10.0.2.2).`
              : `Regla Puente: El paquete sale directamente a Internet (${targetIp}) a través del router físico de la LAN (192.168.1.1).`
        };
      }

      const primary = activeAdapters[0];
      return {
        reachable: false,
        sourceIp: primary.ipInfo.ip,
        adapterUsed: `Adaptador ${primary.slot} (${primary.mode})`,
        ttl: 64,
        baseLatencyMs: 0,
        errorCode: 'NET_UNREACHABLE',
        reason:
          primary.mode === 'Adaptador sólo-anfitrión'
            ? `Regla Sólo-anfitrión: La red Host-Only (192.168.56.0/24) comunica con el Anfitrión y otras VMs Host-Only, pero NO tiene salida a Internet (${targetIp}).`
            : `Regla Red interna ('${primary.intnetName}'): Está completamente aislada del exterior y carece de puerta de enlace hacia Internet (${targetIp}).`
      };
    }

    // 2. Destino: GATEWAY NAT (10.0.2.2)
    if (targetIp === LAB_INFRASTRUCTURE_IPS.NAT_GATEWAY) {
      const natAd = activeAdapters.find((a) => a.mode === 'NAT');
      if (natAd) {
        if (sourceVm.firewallDropIcmp) {
          return {
            reachable: false,
            sourceIp: natAd.ipInfo.ip,
            adapterUsed: `Adaptador ${natAd.slot} (NAT)`,
            ttl: 64,
            baseLatencyMs: 0,
            errorCode: 'FIREWALL_TIMEOUT',
            reason: `Fallo Firewall DROP activo en "${sourceVm.name}": paquetes ICMP bloqueados ("Request timed out").`
          };
        }
        return {
          reachable: true,
          sourceIp: natAd.ipInfo.ip,
          adapterUsed: `Adaptador ${natAd.slot} (NAT)`,
          ttl: 64,
          baseLatencyMs: 1.1,
          reason: 'Respuesta de la puerta de enlace virtual del motor NAT de VirtualBox (10.0.2.2).'
        };
      }
    }

    // 3. Destino: IP DEL ANFITRIÓN FÍSICA (192.168.1.100) o Router LAN (192.168.1.1)
    if (
      targetIp === LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_LAN ||
      targetIp === LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_GW
    ) {
      const bridgeAd = activeAdapters.find((a) => a.mode === 'Adaptador Puente');
      if (bridgeAd) {
        if (sourceVm.firewallDropIcmp) {
          return {
            reachable: false,
            sourceIp: bridgeAd.ipInfo.ip,
            adapterUsed: `Adaptador ${bridgeAd.slot} (Adaptador Puente)`,
            ttl: 64,
            baseLatencyMs: 0,
            errorCode: 'FIREWALL_TIMEOUT',
            reason: `Fallo Firewall DROP: Aunque el enlace Puente hacia ${targetIp} existe, el firewall de "${sourceVm.name}" descarta los paquetes ICMP ("Request timed out").`
          };
        }
        return {
          reachable: true,
          hasPacketLossConflict: isConflictActive,
          sourceIp: bridgeAd.ipInfo.ip,
          adapterUsed: `Adaptador ${bridgeAd.slot} (Adaptador Puente)`,
          ttl: 64,
          baseLatencyMs: 1.6,
          reason: isConflictActive
            ? `Conflicto IP/MAC en Puente: Hay conectividad con el Anfitrión (${targetIp}), pero la colisión de IP/MAC en 192.168.1.0/24 genera caídas intermitentes en el ping.`
            : `Regla Puente: La VM (${bridgeAd.ipInfo.ip}) está conectada a la LAN física y tiene visibilidad total con el Anfitrión físico (${targetIp}).`
        };
      }

      const primary = activeAdapters[0];
      return {
        reachable: false,
        sourceIp: primary.ipInfo.ip,
        adapterUsed: `Adaptador ${primary.slot} (${primary.mode})`,
        ttl: 64,
        baseLatencyMs: 0,
        errorCode: 'HOST_UNREACHABLE',
        reason: `Visibilidad bloqueada: Para alcanzar la IP física del Anfitrión (${targetIp}) se requiere un adaptador en modo "Adaptador Puente" (modo actual: ${primary.mode}).`
      };
    }

    // 4. Destino: IP DEL ANFITRIÓN HOST-ONLY (192.168.56.1)
    if (targetIp === LAB_INFRASTRUCTURE_IPS.HOST_ONLY_ADAPTER) {
      const hostOnlyAd = activeAdapters.find((a) => a.mode === 'Adaptador sólo-anfitrión');
      if (hostOnlyAd) {
        if (sourceVm.firewallDropIcmp) {
          return {
            reachable: false,
            sourceIp: hostOnlyAd.ipInfo.ip,
            adapterUsed: `Adaptador ${hostOnlyAd.slot} (Adaptador sólo-anfitrión)`,
            ttl: 64,
            baseLatencyMs: 0,
            errorCode: 'FIREWALL_TIMEOUT',
            reason: `Fallo Firewall DROP: El enlace Host-Only existe, pero el firewall local bloquea ICMP ("Request timed out").`
          };
        }
        return {
          reachable: true,
          sourceIp: hostOnlyAd.ipInfo.ip,
          adapterUsed: `Adaptador ${hostOnlyAd.slot} (Adaptador sólo-anfitrión)`,
          ttl: 64,
          baseLatencyMs: 0.9,
          reason: `Regla Sólo-anfitrión: La VM (${hostOnlyAd.ipInfo.ip}) alcanza directamente el adaptador Host-Only del Anfitrión (192.168.56.1).`
        };
      }

      const primary = activeAdapters[0];
      return {
        reachable: false,
        sourceIp: primary.ipInfo.ip,
        adapterUsed: `Adaptador ${primary.slot} (${primary.mode})`,
        ttl: 64,
        baseLatencyMs: 0,
        errorCode: 'HOST_UNREACHABLE',
        reason: `Visibilidad bloqueada: La IP 192.168.56.1 pertenece al adaptador Host-Only del Anfitrión y solo es accesible desde VMs con "Adaptador sólo-anfitrión".`
      };
    }

    // 5. Destino: OTRA MÁQUINA VIRTUAL DEL LABORATORIO
    const otherRunningMatches = [];
    allVms.forEach((otherVm) => {
      if (otherVm.id === sourceVm.id || otherVm.state !== 'Corriendo') return;
      otherVm.getEnabledAdapters().forEach((otherAd) => {
        if (otherAd.cableConnected && otherAd.ipInfo && otherAd.ipInfo.ip === targetIp) {
          otherRunningMatches.push({ vm: otherVm, adapter: otherAd });
        }
      });
    });

    if (otherRunningMatches.length > 0) {
      for (const match of otherRunningMatches) {
        const targetAd = match.adapter;
        const targetVm = match.vm;

        // Comprobar visibilidad según el modo de red antes de verificar el Firewall
        let modeCompatible = false;
        let matchingSrcAdapter = null;
        let routeSuccessText = '';

        if (targetAd.mode === 'Adaptador Puente') {
          matchingSrcAdapter = activeAdapters.find((a) => a.mode === 'Adaptador Puente');
          if (matchingSrcAdapter) {
            modeCompatible = true;
            routeSuccessText = `Regla Puente: Conectividad directa en el switch LAN físico hacia la VM "${targetVm.name}" (${targetIp}).`;
          }
        } else if (targetAd.mode === 'Adaptador sólo-anfitrión') {
          matchingSrcAdapter = activeAdapters.find((a) => a.mode === 'Adaptador sólo-anfitrión');
          if (matchingSrcAdapter) {
            modeCompatible = true;
            routeSuccessText = `Regla Sólo-anfitrión: Ambas VMs ("${sourceVm.name}" y "${targetVm.name}") están conectadas a vboxnet0 (192.168.56.0/24).`;
          }
        } else if (targetAd.mode === 'Red interna') {
          const targetIntnet = targetAd.intnetName || 'intnet';
          matchingSrcAdapter = activeAdapters.find(
            (a) => a.mode === 'Red interna' && (a.intnetName || 'intnet') === targetIntnet
          );
          if (matchingSrcAdapter) {
            if (this.areInSameInternalSubnet(matchingSrcAdapter.ipInfo.ip, targetIp)) {
              modeCompatible = true;
              routeSuccessText = `Regla Red interna: Ambas VMs comparten el mismo switch interno aislado '${targetIntnet}'.`;
            } else {
              return {
                reachable: false,
                sourceIp: matchingSrcAdapter.ipInfo.ip,
                adapterUsed: `Adaptador ${matchingSrcAdapter.slot} (Red interna '${targetIntnet}')`,
                ttl: 64,
                baseLatencyMs: 0,
                errorCode: 'SUBNET_MISMATCH',
                reason: `Ambas VMs están en '${targetIntnet}', pero sus IPs (${matchingSrcAdapter.ipInfo.ip} y ${targetIp}) pertenecen a subredes distintas.`
              };
            }
          }
        } else if (targetAd.mode === 'NAT') {
          return {
            reachable: false,
            sourceIp: activeAdapters[0].ipInfo.ip,
            adapterUsed: `Adaptador ${activeAdapters[0].slot}`,
            ttl: 64,
            baseLatencyMs: 0,
            errorCode: 'NAT_ISOLATED',
            reason: `Regla NAT: Cada VM en modo NAT está aislada detrás de su propio motor NAT; otras VMs no pueden entrar a ${targetIp}.`
          };
        }

        if (modeCompatible && matchingSrcAdapter) {
          // FALLO 2 (Fase 4): ¿La VM destino o la VM origen tiene la Regla DROP en iptables/Firewall activa?
          if (targetVm.firewallDropIcmp || sourceVm.firewallDropIcmp) {
            const blockedVmName = targetVm.firewallDropIcmp ? targetVm.name : sourceVm.name;
            return {
              reachable: false,
              sourceIp: matchingSrcAdapter.ipInfo.ip,
              adapterUsed: `Adaptador ${matchingSrcAdapter.slot} (${matchingSrcAdapter.mode})`,
              ttl: 64,
              baseLatencyMs: 0,
              errorCode: 'FIREWALL_TIMEOUT',
              reason: `Fallo Firewall DROP: El enlace físico hacia "${targetVm.name}" (${targetIp}) existe, pero el firewall/iptables de "${blockedVmName}" tiene una regla DROP que descarta los paquetes ICMP ("Request timed out").`
            };
          }

          // FALLO 3 (Fase 4): ¿Hay conflicto de IP / MAC duplicada en Puente?
          const conflictHere =
            targetAd.mode === 'Adaptador Puente' &&
            (isConflictActive || Boolean(targetAd.forcedConflictIp) || Boolean(matchingSrcAdapter.forcedConflictIp));

          return {
            reachable: true,
            hasPacketLossConflict: conflictHere,
            sourceIp: matchingSrcAdapter.ipInfo.ip,
            adapterUsed: `Adaptador ${matchingSrcAdapter.slot} (${matchingSrcAdapter.mode})`,
            ttl: targetVm.os === 'Windows' ? 128 : 64,
            baseLatencyMs: 1.5,
            reason: conflictHere
              ? `Fallo Conflicto IP/MAC en Puente: Dos máquinas comparten la IP ${targetIp} o dirección MAC en la red puente, provocando caídas aleatorias de paquetes y respuestas duplicadas (DUP!).`
              : routeSuccessText
          };
        }
      }

      const firstMatch = otherRunningMatches[0];
      return {
        reachable: false,
        sourceIp: activeAdapters[0].ipInfo.ip,
        adapterUsed: `Adaptador ${activeAdapters[0].slot} (${activeAdapters[0].mode})`,
        ttl: 64,
        baseLatencyMs: 0,
        errorCode: 'MODE_ISOLATION',
        reason: `Aislamiento de red: "${sourceVm.name}" (${activeAdapters.map((a) => a.mode).join(', ')}) no comparte segmento de red con "${firstMatch.vm.name}" (${firstMatch.adapter.mode}: ${targetIp}).`
      };
    }

    // Comprobar si el usuario hizo ping a una VM cuyo cable fue desconectado
    const cableDownVm = allVms.find(
      (v) =>
        v.id !== sourceVm.id &&
        v.state === 'Corriendo' &&
        v.getEnabledAdapters().some((ad) => !ad.cableConnected)
    );
    if (cableDownVm) {
      return {
        reachable: false,
        sourceIp: activeAdapters[0].ipInfo.ip,
        adapterUsed: `Adaptador ${activeAdapters[0].slot}`,
        ttl: 64,
        baseLatencyMs: 0,
        errorCode: 'HOST_UNREACHABLE',
        reason: `Host inaccesible (${targetIp}): Verifica si la máquina destino está encendida y tiene su "Cable conectado" activo.`
      };
    }

    const primary = activeAdapters[0];
    return {
      reachable: false,
      sourceIp: primary.ipInfo.ip,
      adapterUsed: `Adaptador ${primary.slot} (${primary.mode})`,
      ttl: 64,
      baseLatencyMs: 0,
      errorCode: 'TIMEOUT',
      reason: `Ningún host activo responde en ${targetIp} dentro de los segmentos alcanzables por "${sourceVm.name}".`
    };
  }

  /**
   * Evalúa un ping lanzado DESDE el Anfitrión (Host 192.168.1.100 / 192.168.56.1) hacia la VM actual
   */
  static evaluateHostToVmPing(targetVm) {
    const enabled = targetVm.getEnabledAdapters();
    if (enabled.length === 0) {
      return {
        reachable: false,
        hostSourceIp: LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_LAN,
        targetIp: 'Sin IP',
        errorCode: 'NO_NET',
        reason: `La VM "${targetVm.name}" no tiene adaptadores habilitados.`
      };
    }

    const activeAdapters = enabled.filter((a) => a.cableConnected && a.ipInfo);
    if (activeAdapters.length === 0) {
      return {
        reachable: false,
        hostSourceIp: LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_LAN,
        targetIp: 'Cable desconectado',
        errorCode: 'NETWORK_UNREACHABLE',
        reason: `Fallo Cable Desconectado: El cable virtual de "${targetVm.name}" está desconectado (NO-CARRIER).`
      };
    }

    const bridgeAd = activeAdapters.find((a) => a.mode === 'Adaptador Puente');
    const hostOnlyAd = activeAdapters.find((a) => a.mode === 'Adaptador sólo-anfitrión');
    const reachableAd = bridgeAd || hostOnlyAd;

    if (reachableAd) {
      const hostIp =
        reachableAd.mode === 'Adaptador Puente'
          ? LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_LAN
          : LAB_INFRASTRUCTURE_IPS.HOST_ONLY_ADAPTER;

      if (targetVm.firewallDropIcmp) {
        return {
          reachable: false,
          hostSourceIp: hostIp,
          targetIp: reachableAd.ipInfo.ip,
          errorCode: 'FIREWALL_TIMEOUT',
          reason: `Fallo Firewall DROP en "${targetVm.name}": El Anfitrión (${hostIp}) llega físicamente a ${reachableAd.ipInfo.ip}, pero el firewall de la VM descarta los paquetes ICMP ("Request timed out").`
        };
      }

      return {
        reachable: true,
        hostSourceIp: hostIp,
        targetIp: reachableAd.ipInfo.ip,
        mode: reachableAd.mode,
        reason: `ÉXITO (Anfitrión -> VM ${reachableAd.mode}): El Anfitrión (${hostIp}) alcanza directamente a "${targetVm.name}" (${reachableAd.ipInfo.ip}).`
      };
    }

    const primary = activeAdapters[0];
    if (primary.mode === 'NAT') {
      return {
        reachable: false,
        hostSourceIp: LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_LAN,
        targetIp: primary.ipInfo.ip,
        mode: 'NAT',
        reason: `BLOQUEADO (Anfitrión -> VM NAT): NAT permite a la VM salir a Internet, pero el Anfitrión NO puede entrar directamente a la IP privada NAT (${primary.ipInfo.ip}).`
      };
    }

    return {
      reachable: false,
      hostSourceIp: LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_LAN,
      targetIp: primary.ipInfo.ip,
      mode: primary.mode,
      reason: `BLOQUEADO (Anfitrión -> VM Red interna '${primary.intnetName}'): El Anfitrión está fuera del switch virtual aislado '${primary.intnetName}'.`
    };
  }

  static areInSameInternalSubnet(ipA, ipB) {
    if (!ipA || !ipB) return false;
    if (ipA.startsWith('169.254.') && ipB.startsWith('169.254.')) return true;
    const partsA = ipA.split('.').slice(0, 3).join('.');
    const partsB = ipB.split('.').slice(0, 3).join('.');
    return partsA === partsB;
  }

  static getUsedLastOctets(allVms, currentVmId, prefix) {
    const used = new Set();
    allVms.forEach((vm) => {
      if (vm.state !== 'Corriendo') return;
      (vm.adapters || []).forEach((ad) => {
        if (ad.ipInfo && typeof ad.ipInfo.ip === 'string' && ad.ipInfo.ip.startsWith(prefix)) {
          if (vm.id !== currentVmId) {
            const parts = ad.ipInfo.ip.split('.');
            const last = Number(parts[3]);
            if (!Number.isNaN(last)) used.add(last);
          }
        }
      });
    });
    return used;
  }

  static allocateUniqueOctet(mac = '', min = 101, max = 245, usedSet = new Set()) {
    const clean = String(mac).replace(/[^0-9A-Fa-f]/g, '');
    let seed = 0;
    for (let i = 0; i < clean.length; i++) {
      seed = (seed * 31 + parseInt(clean[i], 16)) % 10000;
    }
    const range = max - min + 1;
    let candidate = min + (seed % range);
    let attempts = 0;
    while (usedSet.has(candidate) && attempts < range) {
      candidate = min + ((candidate - min + 1) % range);
      attempts++;
    }
    usedSet.add(candidate);
    return candidate;
  }

  static hashMacByte(mac = '', offset = 0, min = 1, max = 254) {
    const sub = String(mac).slice(-6 + offset, -2 + offset) || 'A4';
    const num = parseInt(sub, 16) || 42;
    return min + (num % (max - min + 1));
  }

  static getModeExplanation(mode, intnetName = 'intnet', pfRules = []) {
    switch (mode) {
      case 'NAT': {
        const pfSummary =
          Array.isArray(pfRules) && pfRules.length > 0
            ? `<br/><strong>Reenvío de puertos activo (${pfRules.length}):</strong> ` +
              pfRules
                .map(
                  (r) =>
                    `<code>${escapeHTML(r.name || 'Regla')}: ${escapeHTML(r.protocol || 'TCP')} ${escapeHTML(r.hostIp || '*')}:${escapeHTML(r.hostPort)} &rarr; ${escapeHTML(r.guestIp || '10.0.2.15')}:${escapeHTML(r.guestPort)}</code>`
                )
                .join(', ')
            : '';
        return `<strong>Modo NAT:</strong> El motor <code>NetworkEngine</code> asignará la IP <code>10.0.2.15/24</code> tras DHCP. Llega a Internet (<code>8.8.8.8</code>), pero el Anfitrión no entra a NAT salvo mediante reglas de <strong>Reenvío de puertos</strong>.${pfSummary}`;
      }
      case 'Adaptador Puente':
        return `<strong>Modo Adaptador Puente (Bridged):</strong> Recibe una IP <code>192.168.1.X/24</code> del DHCP físico. Es visible por todos (Anfitrión <code>192.168.1.100</code>, otras VMs Puente e Internet <code>8.8.8.8</code>).`;
      case 'Red interna':
        return `<strong>Modo Red Interna (<code>${escapeHTML(intnetName || 'intnet')}</code>):</strong> Solo ve a las VMs en su misma <code>${escapeHTML(intnetName || 'intnet')}</code>. Sin DHCP automático (devuelve APIPA <code>169.254.X.X</code> o admite IP manual en consola).`;
      case 'Adaptador sólo-anfitrión':
        return `<strong>Modo Adaptador sólo-anfitrión (Host-Only):</strong> Recibe <code>192.168.56.X/24</code>. Ve al Anfitrión (<code>192.168.56.1</code>) y otras VMs Host-Only, pero <strong>no</strong> sale a Internet (<code>8.8.8.8</code>).`;
      default:
        return '';
    }
  }

  /**
   * FASE 7: Evalúa una petición `curl localhost:[Puerto_Anfitrión]` (Port Forwarding en NAT)
   */
  static evaluatePortForwardingCurl(rawTargetUrl, allVms = []) {
    const cleaned = String(rawTargetUrl || '')
      .trim()
      .replace(/^https?:\/\//i, '')
      .split('/')[0];

    const lastColonIdx = cleaned.lastIndexOf(':');
    if (lastColonIdx === -1) {
      return {
        ok: false,
        hostTarget: cleaned || 'localhost',
        port: 80,
        errorCode: 'INVALID_PORT',
        reason:
          'Debes especificar el puerto del Anfitrión en el comando. Ejemplo: curl localhost:8080'
      };
    }

    const hostPart = cleaned.slice(0, lastColonIdx).trim().toLowerCase() || 'localhost';
    const portPart = Number(cleaned.slice(lastColonIdx + 1).trim());

    if (!Number.isInteger(portPart) || portPart < 1 || portPart > 65535) {
      return {
        ok: false,
        hostTarget: hostPart,
        port: cleaned.slice(lastColonIdx + 1),
        errorCode: 'INVALID_PORT',
        reason: `El puerto "${cleaned.slice(lastColonIdx + 1)}" no es un puerto TCP válido (rango 1-65535).`
      };
    }

    const validHostTargets = new Set([
      'localhost',
      '127.0.0.1',
      '127.0.1.1',
      '0.0.0.0',
      LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_LAN,
      LAB_INFRASTRUCTURE_IPS.HOST_ONLY_ADAPTER
    ]);

    if (!validHostTargets.has(hostPart)) {
      return {
        ok: false,
        hostTarget: hostPart,
        port: portPart,
        errorCode: 'CONNECTION_REFUSED',
        reason: `La dirección "${hostPart}" no corresponde a una interfaz del Anfitrión. Usa "curl localhost:${portPart}" o "curl 127.0.1.1:${portPart}".`
      };
    }

    // Buscar en todas las VMs si alguna tiene un adaptador en modo NAT con una regla que coincida con portPart
    const matchedCandidates = [];
    allVms.forEach((vm) => {
      (vm.adapters || []).forEach((ad, idx) => {
        if (!ad.enabled || ad.mode !== 'NAT') return;
        const rules = Array.isArray(ad.portForwardingRules) ? ad.portForwardingRules : [];
        rules.forEach((rule) => {
          if (Number(rule.hostPort) === portPart) {
            matchedCandidates.push({ vm, adapter: ad, adapterIdx: idx, rule });
          }
        });
      });
    });

    if (matchedCandidates.length === 0) {
      return {
        ok: false,
        hostTarget: hostPart,
        port: portPart,
        errorCode: 'CONNECTION_REFUSED',
        reason: `Connection refused: No existe ninguna regla de Reenvío de Puertos para el Puerto Anfitrión ${portPart} en ningún adaptador NAT habilitado.`
      };
    }

    // Evaluar el primer candidato o aquel cuya VM esté Corriendo
    const runningMatch =
      matchedCandidates.find((c) => c.vm.state === 'Corriendo') || matchedCandidates[0];
    const { vm, adapter, adapterIdx, rule } = runningMatch;

    // 1. Verificar protocolo TCP
    if (String(rule.protocol || 'TCP').toUpperCase() !== 'TCP') {
      return {
        ok: false,
        hostTarget: hostPart,
        port: portPart,
        errorCode: 'CONNECTION_REFUSED',
        reason: `La regla "${rule.name}" en "${vm.name}" está configurada en protocolo UDP, pero HTTP (curl) requiere TCP.`
      };
    }

    // 2. Verificar IP Anfitrión si se especificó en la regla
    const ruleHostIp = String(rule.hostIp || '').trim();
    if (
      ruleHostIp &&
      ruleHostIp !== '0.0.0.0' &&
      ruleHostIp !== '127.0.0.1' &&
      ruleHostIp !== '127.0.1.1' &&
      ruleHostIp.toLowerCase() !== 'localhost' &&
      hostPart !== 'localhost' &&
      ruleHostIp !== hostPart
    ) {
      return {
        ok: false,
        hostTarget: hostPart,
        port: portPart,
        errorCode: 'CONNECTION_REFUSED',
        reason: `La regla "${rule.name}" solo escucha en la IP Anfitrión ${ruleHostIp}, no en ${hostPart}.`
      };
    }

    // 3. Verificar que la VM esté encendida (Corriendo)
    if (vm.state !== 'Corriendo') {
      return {
        ok: false,
        hostTarget: hostPart,
        port: portPart,
        errorCode: 'CONNECTION_REFUSED',
        reason: `La regla "${rule.name}" apunta a "${vm.name}", pero la máquina virtual está Apagada. Enciéndela para que su servidor responda.`
      };
    }

    // 4. Verificar que el cable virtual esté conectado
    if (!adapter.cableConnected) {
      return {
        ok: false,
        hostTarget: hostPart,
        port: portPart,
        errorCode: 'CONNECTION_REFUSED',
        reason: `Fallo físico ("Cable desconectado"): El adaptador NAT de "${vm.name}" tiene el cable desconectado.`
      };
    }

    // 5. Verificar la IP Invitado (ej. 10.0.2.15)
    const expectedNatIp = adapterIdx === 0 ? '10.0.2.15' : `10.0.${adapterIdx + 2}.15`;
    const currentVmNatIp =
      adapter.ipInfo && adapter.ipInfo.hasIp ? adapter.ipInfo.ip : expectedNatIp;
    const ruleGuestIp = String(rule.guestIp || '').trim();

    if (ruleGuestIp && ruleGuestIp !== expectedNatIp && ruleGuestIp !== currentVmNatIp) {
      return {
        ok: false,
        hostTarget: hostPart,
        port: portPart,
        errorCode: 'CONNECTION_REFUSED',
        reason: `La regla "${rule.name}" reenvía tráfico hacia la IP Invitado ${ruleGuestIp}, pero la IP NAT de "${vm.name}" es ${expectedNatIp}.`
      };
    }

    // 6. Verificar el Puerto Invitado
    const guestPortNum = Number(rule.guestPort);
    if (!Number.isInteger(guestPortNum) || guestPortNum < 1 || guestPortNum > 65535) {
      return {
        ok: false,
        hostTarget: hostPart,
        port: portPart,
        errorCode: 'CONNECTION_REFUSED',
        reason: `El Puerto Invitado en la regla "${rule.name}" no es válido.`
      };
    }

    // Si la VM en NAT estaba recién arrancada sin dhclient, activar su concesión NAT al recibir tráfico reenviado o usar su IP NAT
    if (!adapter.dhcpLeased) {
      adapter.dhcpLeased = true;
      this.assignIPsForVM(vm, allVms);
    }

    return {
      ok: true,
      hostTarget: hostPart,
      port: portPart,
      vm,
      adapter,
      rule,
      guestIp: ruleGuestIp || expectedNatIp,
      guestPort: guestPortNum,
      reason: `Reenvío NAT exitoso (Regla "${rule.name || 'NAT-Rule'}"): Tráfico recibido en Anfitrión (${ruleHostIp || '0.0.0.0'}:${portPart}/TCP) redirigido hacia "${vm.name}" (${ruleGuestIp || expectedNatIp}:${guestPortNum}/TCP).`
    };
  }

  /**
   * FASE 8: Evalúa la ruta lógica de saltos para `traceroute [IP]` / `tracert [IP]`
   *  - Ruta NAT hacia 8.8.8.8:
   *      Salto 1: 10.0.2.2 (Gateway NAT VirtualBox)
   *      Salto 2: 192.168.1.1 (Gateway físico simulado)
   *      Salto 3: 8.8.8.8
   *  - Ruta Puente hacia 8.8.8.8:
   *      Salto 1: 192.168.1.1 (Gateway físico simulado)
   *      Salto 2: 8.8.8.8
   *  - Ruta Interna (o Sólo-anfitrión) hacia 8.8.8.8:
   *      Falla en el primer salto (* * * Request timed out) porque no hay puerta de enlace a Internet.
   */
  static evaluateTraceroute(sourceVm, rawTargetIp, allVms = []) {
    const targetIp =
      String(rawTargetIp || '').trim().toLowerCase() === 'localhost'
        ? '127.0.0.1'
        : String(rawTargetIp || '').trim();

    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipv4Regex.test(targetIp)) {
      return {
        ok: false,
        targetIp,
        errorCode: 'INVALID_HOST',
        hops: [],
        reason: `traceroute: "${targetIp}": Name or service not known (Introduce una dirección IPv4 válida, ej. 8.8.8.8).`
      };
    }

    // Si se ejecuta desde la Consola del Anfitrión (Host)
    if (sourceVm.id === HOST_CONSOLE_ID) {
      if (targetIp === LAB_INFRASTRUCTURE_IPS.INTERNET_DNS || targetIp === '1.1.1.1') {
        return {
          ok: true,
          reachable: true,
          targetIp,
          adapterUsed: 'eth0 (LAN Física del Anfitrión)',
          hops: [
            { hop: 1, ip: LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_GW, label: 'Gateway físico simulado', timeout: false },
            { hop: 2, ip: targetIp, label: 'Internet DNS', timeout: false }
          ],
          reason: `Ruta desde Anfitrión hacia ${targetIp}: Salto 1 por el Gateway físico (${LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_GW}) y Salto 2 hasta ${targetIp}.`
        };
      }
      return {
        ok: true,
        reachable: true,
        targetIp,
        adapterUsed: 'Anfitrión',
        hops: [{ hop: 1, ip: targetIp, label: 'Destino directo', timeout: false }],
        reason: `Salto directo desde el Anfitrión hacia ${targetIp}.`
      };
    }

    // 1. Loopback local
    if (targetIp === '127.0.0.1') {
      return {
        ok: true,
        reachable: true,
        targetIp,
        adapterUsed: 'lo (Loopback)',
        hops: [{ hop: 1, ip: '127.0.0.1', label: 'localhost', timeout: false }],
        reason: 'Trazado local por interfaz de loopback (127.0.0.1) en 1 salto.'
      };
    }

    const enabledAdapters = sourceVm.getEnabledAdapters();
    if (enabledAdapters.length === 0) {
      return {
        ok: false,
        targetIp,
        errorCode: 'NETWORK_UNREACHABLE',
        hops: [],
        reason: 'Ningún adaptador de red está habilitado en esta máquina virtual (Configuración > Red).'
      };
    }

    const connectedAdapters = enabledAdapters.filter((a) => a.cableConnected);
    if (connectedAdapters.length === 0) {
      return {
        ok: false,
        targetIp,
        errorCode: 'NETWORK_UNREACHABLE',
        hops: [],
        reason: 'Fallo físico ("Cable desconectado"): El cable de red virtual está desconectado en los adaptadores habilitados.'
      };
    }

    const leasedAdapters = connectedAdapters.filter(
      (a) => a.ipInfo && a.ipInfo.hasIp && /^\d+\.\d+\.\d+\.\d+$/.test(a.ipInfo.ip)
    );
    if (leasedAdapters.length === 0) {
      const cmdHint = sourceVm.os === 'Windows' ? 'ipconfig /renew' : 'dhclient';
      return {
        ok: false,
        targetIp,
        errorCode: 'NO_DHCP_LEASE',
        hops: [],
        reason: `La máquina virtual no tiene dirección IP asignada todavía. Ejecuta "${cmdHint}" en la consola para obtener una concesión DHCP (proceso DORA) o configura una IP estática.`
      };
    }

    // 2. Ruta hacia Internet (8.8.8.8 o 1.1.1.1)
    if (targetIp === LAB_INFRASTRUCTURE_IPS.INTERNET_DNS || targetIp === '1.1.1.1') {
      if (sourceVm.firewallDropIcmp) {
        return {
          ok: true,
          reachable: false,
          targetIp,
          adapterUsed: `eth${leasedAdapters[0].slot - 1} (${leasedAdapters[0].mode})`,
          hops: [{ hop: 1, timeout: true }],
          reason: `Fallo de Firewall (Regla DROP ICMP en "${sourceVm.name}"): El firewall local bloquea las respuestas ICMP de retorno (* * * Request timed out).`
        };
      }

      const natAdapter = leasedAdapters.find((a) => a.mode === 'NAT');
      if (natAdapter) {
        const natGw = natAdapter.ipInfo?.gateway || LAB_INFRASTRUCTURE_IPS.NAT_GATEWAY;
        return {
          ok: true,
          reachable: true,
          targetIp,
          adapterUsed: `eth${natAdapter.slot - 1} (NAT)`,
          hops: [
            { hop: 1, ip: natGw, label: 'Gateway NAT VirtualBox', timeout: false },
            { hop: 2, ip: LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_GW, label: 'Gateway físico simulado', timeout: false },
            { hop: 3, ip: targetIp, label: 'Internet DNS', timeout: false }
          ],
          reason: `Ruta NAT hacia ${targetIp} completada en 3 saltos: Salto 1 (${natGw} - Gateway NAT VirtualBox) -> Salto 2 (${LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_GW} - Gateway físico simulado) -> Salto 3 (${targetIp}).`
        };
      }

      const bridgeAdapter = leasedAdapters.find((a) => a.mode === 'Adaptador Puente');
      if (bridgeAdapter) {
        return {
          ok: true,
          reachable: true,
          targetIp,
          adapterUsed: `eth${bridgeAdapter.slot - 1} (Adaptador Puente)`,
          hops: [
            { hop: 1, ip: LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_GW, label: 'Gateway físico simulado', timeout: false },
            { hop: 2, ip: targetIp, label: 'Internet DNS', timeout: false }
          ],
          reason: `Ruta Adaptador Puente hacia ${targetIp} completada en 2 saltos: Salto 1 (${LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_GW} - Gateway físico simulado) -> Salto 2 (${targetIp}).`
        };
      }

      // Red interna o Adaptador sólo-anfitrión hacia 8.8.8.8: falla en el primer salto (* * * Request timed out)
      const isolatedAd = leasedAdapters[0];
      const modeLabel =
        isolatedAd.mode === 'Red interna'
          ? `Red interna '${isolatedAd.intnetName}'`
          : isolatedAd.mode;

      return {
        ok: true,
        reachable: false,
        targetIp,
        adapterUsed: `eth${isolatedAd.slot - 1} (${modeLabel})`,
        hops: [{ hop: 1, timeout: true }],
        reason: `Ruta ${modeLabel} hacia ${targetIp} fallida en el Salto 1 (* * * Request timed out): El modo ${modeLabel} está aislado de la red exterior y carece de puerta de enlace (Gateway) hacia Internet.`
      };
    }

    // 3. Ruta hacia otros destinos locales (Gateways, IPs del Anfitrión u otras VMs)
    const pingEval = this.evaluatePing(sourceVm, targetIp, allVms);
    if (pingEval.reachable) {
      return {
        ok: true,
        reachable: true,
        targetIp,
        adapterUsed: pingEval.adapterUsed,
        hops: [{ hop: 1, ip: targetIp, label: 'Destino en subred local', timeout: false }],
        reason: `Ruta directa (1 salto) hacia ${targetIp} a través de ${pingEval.adapterUsed}: ${pingEval.reason}`
      };
    }

    return {
      ok: true,
      reachable: false,
      targetIp,
      adapterUsed: pingEval.adapterUsed || `eth${leasedAdapters[0].slot - 1} (${leasedAdapters[0].mode})`,
      hops: [{ hop: 1, timeout: true }],
      reason: pingEval.reason
    };
  }
}

function normalizePortForwardingRules(rawRules) {
  if (!Array.isArray(rawRules)) return [];
  return rawRules
    .filter((r) => r && typeof r === 'object')
    .map((r, idx) => ({
      id: r.id || `pf-${Date.now()}-${idx}`,
      name: String(r.name || `Regla ${idx + 1}`).trim(),
      protocol: String(r.protocol || 'TCP').toUpperCase() === 'UDP' ? 'UDP' : 'TCP',
      hostIp: String(r.hostIp || '').trim(),
      hostPort: Number(r.hostPort) || 8080,
      guestIp: String(r.guestIp ?? '10.0.2.15').trim(),
      guestPort: Number(r.guestPort) || 80
    }));
}

/**
 * Normaliza un array de 4 adaptadores de red para cualquier instancia de VirtualMachine
 */
function createDefaultAdapters(customAdapters, legacyNetworkMode) {
  const slots = [0, 1, 2, 3];
  return slots.map((idx) => {
    const existing = Array.isArray(customAdapters) ? customAdapters[idx] : null;
    if (existing) {
      return {
        slot: idx + 1,
        enabled: Boolean(existing.enabled),
        mode: normalizeNetworkMode(existing.mode),
        intnetName: existing.intnetName ? String(existing.intnetName).trim() : 'intnet',
        mac: existing.mac || generateVBoxMAC(),
        cableConnected: existing.cableConnected !== undefined ? Boolean(existing.cableConnected) : true,
        manualStaticIp: existing.manualStaticIp || null,
        forcedConflictIp: existing.forcedConflictIp || null,
        dhcpLeased: Boolean(existing.dhcpLeased),
        portForwardingRules: normalizePortForwardingRules(existing.portForwardingRules),
        ipInfo: existing.ipInfo || null
      };
    }

    return {
      slot: idx + 1,
      enabled: idx === 0,
      mode: idx === 0 ? normalizeNetworkMode(legacyNetworkMode || 'NAT') : 'NAT',
      intnetName: 'intnet',
      mac: generateVBoxMAC(),
      cableConnected: true,
      manualStaticIp: null,
      forcedConflictIp: null,
      dhcpLeased: false,
      portForwardingRules: [],
      ipInfo: null
    };
  });
}

function normalizeNetworkMode(mode) {
  if (!mode) return 'NAT';
  const m = String(mode).toLowerCase();
  if (m.includes('puente') || m.includes('bridge')) return 'Adaptador Puente';
  if (m.includes('interna') || m.includes('intnet')) return 'Red interna';
  if (m.includes('anfitri') || m.includes('host')) return 'Adaptador sólo-anfitrión';
  return 'NAT';
}

/**
 * ============================================================================
 * CLASE VirtualMachine
 * Representa el hardware, estado, 4 adaptadores de red, firewall y consola.
 * ============================================================================
 */
export class VirtualMachine {
  constructor({
    id,
    name,
    os = 'Linux',
    osVersion,
    ram = 2048,
    cpu = 2,
    state = 'Apagada',
    vram = 128,
    diskSize = 25,
    isoMounted = 'Vacío',
    networkMode = 'NAT',
    adapters = null,
    threeDAccel = 'Habilitada',
    firewallDropIcmp = false
  }) {
    this.id = id || `vm-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    this.name = name.trim();
    this.os = os === 'Windows' ? 'Windows' : 'Linux';
    this.osVersion =
      osVersion || (this.os === 'Windows' ? 'Windows 10 (64-bit)' : 'Ubuntu (64-bit)');
    this.ram = Number(ram) || 2048;
    this.cpu = Number(cpu) || 1;
    this.state = state === 'Corriendo' ? 'Corriendo' : 'Apagada';
    this.vram = Number(vram) || 128;
    this.diskSize = Number(diskSize) || 25;
    this.isoMounted = isoMounted || 'Vacío';
    this.threeDAccel = threeDAccel || 'Habilitada';

    // Propiedad Fase 4: Regla DROP en iptables / Firewall para ICMP
    this.firewallDropIcmp = Boolean(firewallDropIcmp);

    this.adapters = createDefaultAdapters(adapters, networkMode);
    this.consoleLogs = [];
    this.commandHistory = [];
  }

  /**
   * Fase 6: Cuando una VM arranca desde estado Apagada, NO tiene IP asignada
   * inmediatamente (dhcpLeased = false), excepto si se configuró como estática en Red interna.
   */
  start(allVms = []) {
    const wasOff = this.state !== 'Corriendo';
    this.state = 'Corriendo';
    if (wasOff) {
      this.adapters.forEach((ad) => {
        // Solo si tiene conflicto forzado pre-inyectado por el instructor mantiene lease;
        // de lo contrario requiere dhclient / ipconfig /renew (salvo estática en Red interna).
        if (!ad.forcedConflictIp) {
          ad.dhcpLeased = false;
        }
      });
    }
    NetworkEngine.assignIPsForVM(this, allVms);
    if (this.consoleLogs.length === 0) {
      this.initBootBanner();
    }
  }

  powerOff(allVms = []) {
    this.state = 'Apagada';
    this.adapters.forEach((ad) => {
      ad.dhcpLeased = false;
    });
    NetworkEngine.assignIPsForVM(this, allVms);
    this.consoleLogs = [];
  }

  initBootBanner() {
    if (this.os === 'Windows') {
      this.consoleLogs = [
        {
          type: 'banner',
          text: `Microsoft Windows [Versión 10.0.19045.4291] — (${this.osVersion})\n(c) Microsoft Corporation. Todos los derechos reservados.\n[DHCP]: Interfaz arrancada sin IP automática. Ejecuta "ipconfig /renew" para solicitar IP (proceso DORA), o usa "ipconfig", "ping [IP]", "tracert [IP]", "help".`
        }
      ];
    } else {
      this.consoleLogs = [
        {
          type: 'banner',
          text: `Linux ${this.name} 6.8.0-45-generic #45-Ubuntu SMP PREEMPT_DYNAMIC x86_64\nBienvenido a ${this.osVersion} (tty1) — Memoria: ${this.ram} MB, vCPUs: ${this.cpu}\n[DHCP]: Interfaz arrancada sin IP automática. Ejecuta "dhclient" para solicitar IP (proceso DORA), o usa "ip a", "ping [IP]", "traceroute [IP]", "help".`
        }
      ];
    }
  }

  getPromptString() {
    if (this.os === 'Windows') {
      return 'C:\\Users\\Administrador>';
    }
    const cleanHost = this.name.toLowerCase().replace(/[^a-z0-9-]/g, '') || 'linux-vm';
    return `root@${cleanHost}:~#`;
  }

  getEnabledAdapters() {
    return this.adapters.filter((a) => a.enabled);
  }

  hasAnyFault() {
    const cableDown = this.getEnabledAdapters().some((a) => !a.cableConnected);
    const conflict = this.getEnabledAdapters().some((a) => Boolean(a.forcedConflictIp));
    return cableDown || this.firewallDropIcmp || conflict;
  }

  updateConfiguration(updates, allVms = []) {
    if (this.state === 'Apagada') {
      if (updates.name) this.name = updates.name.trim();
      if (updates.os) this.os = updates.os;
      if (updates.osVersion) this.osVersion = updates.osVersion;
      if (updates.ram) this.ram = Number(updates.ram);
      if (updates.cpu) this.cpu = Number(updates.cpu);
      if (updates.vram) this.vram = Number(updates.vram);
      if (updates.diskSize) this.diskSize = Number(updates.diskSize);
      if (updates.threeDAccel) this.threeDAccel = updates.threeDAccel;
    }

    if (updates.isoMounted !== undefined) {
      this.isoMounted = updates.isoMounted;
    }

    if (Array.isArray(updates.adapters)) {
      this.adapters = createDefaultAdapters(updates.adapters);
      NetworkEngine.assignIPsForVM(this, allVms);
    }
  }
}

/**
 * Generador de Iconos SVG Skeumórficos para Sistemas Operativos
 */
function getOSIconSVG(osType, size = 28) {
  if (osType === 'Windows') {
    return `
      <svg viewBox="0 0 36 36" width="${size}" height="${size}" aria-hidden="true">
        <defs>
          <linearGradient id="winRed" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#ff6b4a"/>
            <stop offset="100%" stop-color="#d9381e"/>
          </linearGradient>
          <linearGradient id="winGreen" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#9be53b"/>
            <stop offset="100%" stop-color="#5ea813"/>
          </linearGradient>
          <linearGradient id="winBlue" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#4cc2ff"/>
            <stop offset="100%" stop-color="#0078d4"/>
          </linearGradient>
          <linearGradient id="winYellow" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#ffe14d"/>
            <stop offset="100%" stop-color="#f2a900"/>
          </linearGradient>
        </defs>
        <path d="M4,7.5 L16.5,5.5 L16.5,17 L4,17 Z" fill="url(#winRed)" stroke="#9e2510" stroke-width="0.7"/>
        <path d="M18.5,5.2 L32,3 L32,17 L18.5,17 Z" fill="url(#winGreen)" stroke="#3f7508" stroke-width="0.7"/>
        <path d="M4,19 L16.5,19 L16.5,30.5 L4,28.5 Z" fill="url(#winBlue)" stroke="#005299" stroke-width="0.7"/>
        <path d="M18.5,19 L32,19 L32,33 L18.5,30.8 Z" fill="url(#winYellow)" stroke="#b37700" stroke-width="0.7"/>
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 36 36" width="${size}" height="${size}" aria-hidden="true">
      <ellipse cx="18" cy="21" rx="9.5" ry="11.5" fill="#1e2229" stroke="#0c0e12" stroke-width="1"/>
      <circle cx="18" cy="11" r="7.2" fill="#1e2229" stroke="#0c0e12" stroke-width="1"/>
      <ellipse cx="18" cy="22.5" rx="6.2" ry="8.2" fill="#f7f9fc"/>
      <ellipse cx="15.6" cy="9.8" rx="1.7" ry="2.2" fill="#ffffff"/>
      <ellipse cx="20.4" cy="9.8" rx="1.7" ry="2.2" fill="#ffffff"/>
      <circle cx="16" cy="10.2" r="0.95" fill="#111"/>
      <circle cx="20" cy="10.2" r="0.95" fill="#111"/>
      <polygon points="14.5,12.5 21.5,12.5 18,15.8" fill="#f5a623" stroke="#b56c00" stroke-width="0.7"/>
      <ellipse cx="13.2" cy="31.5" rx="3.6" ry="1.9" fill="#f5a623" stroke="#b56c00" stroke-width="0.8"/>
      <ellipse cx="22.8" cy="31.5" rx="3.6" ry="1.9" fill="#f5a623" stroke="#b56c00" stroke-width="0.8"/>
    </svg>
  `;
}

/**
 * Datos iniciales de demostración del laboratorio
 */
function getDefaultVMs() {
  return [
    new VirtualMachine({
      id: 'vm-ubuntu-srv',
      name: 'Ubuntu-Server-24.04',
      os: 'Linux',
      osVersion: 'Ubuntu (64-bit)',
      ram: 2048,
      cpu: 2,
      state: 'Apagada',
      vram: 64,
      diskSize: 40,
      isoMounted: 'ubuntu-24.04.1-live-server-amd64.iso',
      threeDAccel: 'Deshabilitada',
      adapters: [
        { slot: 1, enabled: true, mode: 'NAT', intnetName: 'intnet', mac: '080027A1B2C3', cableConnected: true },
        { slot: 2, enabled: true, mode: 'Adaptador sólo-anfitrión', intnetName: 'intnet', mac: '080027D4E5F6', cableConnected: true },
        { slot: 3, enabled: false, mode: 'NAT', intnetName: 'intnet', mac: '080027112233', cableConnected: true },
        { slot: 4, enabled: false, mode: 'NAT', intnetName: 'intnet', mac: '080027445566', cableConnected: true }
      ]
    }),
    new VirtualMachine({
      id: 'vm-win10-pro',
      name: 'Windows-10-Pro-Lab',
      os: 'Windows',
      osVersion: 'Windows 10 (64-bit)',
      ram: 4096,
      cpu: 2,
      state: 'Apagada',
      vram: 128,
      diskSize: 60,
      isoMounted: 'Win10_22H2_Spanish_x64.iso',
      threeDAccel: 'Habilitada',
      adapters: [
        { slot: 1, enabled: true, mode: 'Adaptador Puente', intnetName: 'intnet', mac: '080027778899', cableConnected: true },
        { slot: 2, enabled: true, mode: 'Red interna', intnetName: 'intnet', mac: '080027AABBCC', cableConnected: true },
        { slot: 3, enabled: false, mode: 'NAT', intnetName: 'intnet', mac: '080027DDEEFF', cableConnected: true },
        { slot: 4, enabled: false, mode: 'NAT', intnetName: 'intnet', mac: '080027123456', cableConnected: true }
      ]
    }),
    new VirtualMachine({
      id: 'vm-debian-fw',
      name: 'Debian-12-Internal',
      os: 'Linux',
      osVersion: 'Debian (64-bit)',
      ram: 1024,
      cpu: 1,
      state: 'Apagada',
      vram: 32,
      diskSize: 20,
      isoMounted: 'Vacío',
      threeDAccel: 'Deshabilitada',
      adapters: [
        { slot: 1, enabled: true, mode: 'Red interna', intnetName: 'intnet', mac: '080027987654', cableConnected: true },
        { slot: 2, enabled: false, mode: 'NAT', intnetName: 'intnet', mac: '080027654321', cableConnected: true },
        { slot: 3, enabled: false, mode: 'NAT', intnetName: 'intnet', mac: '080027334455', cableConnected: true },
        { slot: 4, enabled: false, mode: 'NAT', intnetName: 'intnet', mac: '080027667788', cableConnected: true }
      ]
    })
  ];
}

/**
 * Estado Global en Memoria del Administrador de VirtualBox
 */
const AppState = {
  vms: [],
  selectedVmId: null,
  filterText: '',
  draftAdapters: [],
  draftPortForwardingRules: [],
  activeAdapterTabIndex: 0,
  // Consola (Fase 3 y Fase 7 Consola del Anfitrión)
  consoleVmId: null,
  hostConsole: {
    id: HOST_CONSOLE_ID,
    name: 'Consola del Anfitrión (Host)',
    os: 'Linux',
    osVersion: 'Host OS (192.168.1.100 / 127.0.0.1)',
    state: 'Corriendo',
    consoleLogs: [],
    commandHistory: [],
    getPromptString() {
      return 'anfitrion@vbox-host:~$';
    },
    getEnabledAdapters() {
      return [];
    },
    initBootBanner() {
      this.consoleLogs = [
        {
          type: 'banner',
          text: `Terminal del Sistema Anfitrión (Host Machine — LAN: 192.168.1.100 | Host-Only: 192.168.56.1 | Loopback: 127.0.0.1)\n[Fase 7 - Port Forwarding]: Prueba tus reglas de reenvío de puertos NAT ejecutando:\n  curl localhost:8080   (o el Puerto Anfitrión que hayas mapeado hacia la IP Invitado 10.0.2.15:80)`
        }
      ];
    }
  },
  isPinging: false,
  activePingTimers: [],
  historyCursor: -1,
  // Troubleshooting / Modo Dios (Fase 4)
  instructorTargetVmId: null,
  examBlindMode: false,
  ipConflictActive: false,
  // Motor de Retos y Flags — Modo CTF (Fase 9)
  ctfState: {
    scenarioLoadedFromUrl: false,
    initialFirewallFaultVmIds: new Set(),
    initialPortForwardingEmptyVmIds: new Set(),
    initialCableDownVmIds: new Set(),
    firewallRemediatedVmIds: new Set(),
    unlockedFlags: new Set(),
    commandListeners: []
  }
};

/**
 * ============================================================================
 * PERSISTENCIA EN LOCALSTORAGE
 * ============================================================================
 */
function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      AppState.vms = getDefaultVMs();
      AppState.selectedVmId = AppState.vms[0]?.id || null;
      AppState.instructorTargetVmId = AppState.selectedVmId;
      saveToStorage();
      return;
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      AppState.vms = parsed.map((item) => new VirtualMachine(item));
      AppState.vms.forEach((vm) => {
        if (vm.state === 'Corriendo') {
          NetworkEngine.assignIPsForVM(vm, AppState.vms);
          vm.initBootBanner();
        }
      });
      AppState.selectedVmId = AppState.vms[0].id;
      AppState.instructorTargetVmId = AppState.selectedVmId;
      AppState.ipConflictActive = AppState.vms.some((v) =>
        v.adapters.some((a) => Boolean(a.forcedConflictIp))
      );
    } else {
      AppState.vms = getDefaultVMs();
      AppState.selectedVmId = AppState.vms[0]?.id || null;
      AppState.instructorTargetVmId = AppState.selectedVmId;
    }
  } catch (err) {
    console.warn('Error leyendo LocalStorage, usando VMs por defecto:', err);
    AppState.vms = getDefaultVMs();
    AppState.selectedVmId = AppState.vms[0]?.id || null;
    AppState.instructorTargetVmId = AppState.selectedVmId;
  }
}

function saveToStorage() {
  try {
    const serializable = AppState.vms.map((vm) => ({
      id: vm.id,
      name: vm.name,
      os: vm.os,
      osVersion: vm.osVersion,
      ram: vm.ram,
      cpu: vm.cpu,
      state: vm.state,
      vram: vm.vram,
      diskSize: vm.diskSize,
      isoMounted: vm.isoMounted,
      threeDAccel: vm.threeDAccel,
      firewallDropIcmp: vm.firewallDropIcmp,
      adapters: vm.adapters
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  } catch (err) {
    console.warn('No se pudo guardar en LocalStorage:', err);
  }
}

function getSelectedVM() {
  return AppState.vms.find((vm) => vm.id === AppState.selectedVmId) || null;
}

function getConsoleVM() {
  if (AppState.consoleVmId === HOST_CONSOLE_ID) {
    return AppState.hostConsole;
  }
  return AppState.vms.find((vm) => vm.id === AppState.consoleVmId) || getSelectedVM();
}

function getInstructorTargetVM() {
  return (
    AppState.vms.find((vm) => vm.id === AppState.instructorTargetVmId) ||
    getSelectedVM() ||
    AppState.vms[0] ||
    null
  );
}

/**
 * ============================================================================
 * RENDERIZADO DE LA INTERFAZ PRINCIPAL Y PANEL MODO DIOS
 * ============================================================================
 */
function renderAll() {
  renderVMList();
  renderToolbarState();
  renderDetailsPanel();
  renderHostTelemetry();
  renderInstructorPanel();
  renderCtfBadgeCount();
  const consoleModal = document.getElementById('modal-vm-console');
  if (consoleModal && !consoleModal.classList.contains('hidden')) {
    renderConsoleWindow();
  }
  const topoModal = document.getElementById('modal-topology');
  if (topoModal && !topoModal.classList.contains('hidden')) {
    renderTopologyModal();
  }
  const ctfModal = document.getElementById('modal-ctf-hub');
  if (ctfModal && !ctfModal.classList.contains('hidden')) {
    renderCtfHubModal();
  }
}

function renderVMList() {
  const listEl = document.getElementById('vm-list-container');
  const countSummaryEl = document.getElementById('vm-count-summary');
  const runningSummaryEl = document.getElementById('vm-running-summary');

  if (!listEl) return;

  const query = AppState.filterText.trim().toLowerCase();
  const filteredVMs = AppState.vms.filter(
    (vm) =>
      vm.name.toLowerCase().includes(query) ||
      vm.os.toLowerCase().includes(query) ||
      vm.osVersion.toLowerCase().includes(query)
  );

  listEl.innerHTML = '';

  filteredVMs.forEach((vm) => {
    const li = document.createElement('li');
    const isSelected = vm.id === AppState.selectedVmId;
    const isRunning = vm.state === 'Corriendo';

    const primaryAdapter = vm.getEnabledAdapters()[0];
    const primaryIp = isRunning && primaryAdapter?.ipInfo ? primaryAdapter.ipInfo.ip : '';
    const faultIcon =
      !AppState.examBlindMode && vm.hasAnyFault()
        ? '<i class="fa-solid fa-triangle-exclamation vm-fault-dot" title="Fallo de Troubleshooting activo en esta VM"></i>'
        : '';

    li.className = `vm-item ${isSelected ? 'selected' : ''}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    li.dataset.id = vm.id;

    li.innerHTML = `
      <div class="vm-os-icon" title="${vm.osVersion}">
        ${getOSIconSVG(vm.os, 28)}
      </div>
      <div class="vm-info">
        <div class="vm-name-row">
          <span class="vm-name">${escapeHTML(vm.name)}${faultIcon}</span>
          <span class="vm-os-tag">${vm.os}</span>
        </div>
        <div class="vm-status-row ${isRunning ? 'is-running' : ''}">
          <span class="vm-status-left">
            <i class="fa-solid ${isRunning ? 'fa-play vm-status-icon' : 'fa-power-off vm-status-icon'}"></i>
            <span>${vm.state}</span>
          </span>
          ${primaryIp ? `<span class="vm-ip-mini" title="IP principal asignada">${escapeHTML(primaryIp)}</span>` : ''}
        </div>
      </div>
    `;

    li.addEventListener('click', () => {
      AppState.selectedVmId = vm.id;
      AppState.instructorTargetVmId = vm.id;
      renderAll();
      setStatusMessage(`Máquina seleccionada: "${vm.name}" (${vm.osVersion}) — Estado: ${vm.state}.`);
    });

    li.addEventListener('dblclick', () => {
      AppState.selectedVmId = vm.id;
      AppState.instructorTargetVmId = vm.id;
      handleStartOrOpenConsole();
    });

    listEl.appendChild(li);
  });

  const runningCount = AppState.vms.filter((v) => v.state === 'Corriendo').length;
  if (countSummaryEl) {
    countSummaryEl.textContent = `${AppState.vms.length} ${AppState.vms.length === 1 ? 'máquina' : 'máquinas'}`;
  }
  if (runningSummaryEl) {
    runningSummaryEl.textContent = `${runningCount} corriendo`;
  }
}

function renderToolbarState() {
  const vm = getSelectedVM();
  const btnSettings = document.getElementById('btn-settings');
  const btnDiscard = document.getElementById('btn-discard');
  const btnClone = document.getElementById('btn-clone-vm');
  const btnStart = document.getElementById('btn-start');
  const btnPowerOff = document.getElementById('btn-poweroff');
  const labelStart = document.getElementById('label-start');

  if (!vm) {
    if (btnSettings) btnSettings.disabled = true;
    if (btnDiscard) btnDiscard.disabled = true;
    if (btnClone) btnClone.disabled = true;
    if (btnStart) btnStart.disabled = true;
    btnPowerOff?.classList.add('hidden');
    return;
  }

  if (btnSettings) btnSettings.disabled = false;
  if (btnDiscard) btnDiscard.disabled = false;
  if (btnClone) btnClone.disabled = false;
  if (btnStart) btnStart.disabled = false;

  if (vm.state === 'Corriendo') {
    if (labelStart) labelStart.textContent = 'Consola';
    btnPowerOff?.classList.remove('hidden');
  } else {
    if (labelStart) labelStart.textContent = 'Iniciar';
    btnPowerOff?.classList.add('hidden');
  }
}

function renderDetailsPanel() {
  const vm = getSelectedVM();
  const emptyStateEl = document.getElementById('details-empty-state');
  const contentWrapperEl = document.getElementById('details-content-wrapper');

  if (!vm) {
    emptyStateEl?.classList.remove('hidden');
    contentWrapperEl?.classList.add('hidden');
    return;
  }

  emptyStateEl?.classList.add('hidden');
  contentWrapperEl?.classList.remove('hidden');

  setText('det-name', vm.name);
  setText('det-os', `${vm.os} — ${vm.osVersion}`);

  const stateBadge = document.getElementById('det-state-badge');
  if (stateBadge) {
    stateBadge.textContent = vm.state;
    stateBadge.className = `det-state-text ${vm.state === 'Corriendo' ? 'running' : 'off'}`;
  }

  setText('det-ram', `${vm.ram} MB`);
  setText('det-cpu', `${vm.cpu} ${vm.cpu === 1 ? 'procesador' : 'procesadores'}`);
  setText('det-vram', `${vm.vram} MB`);
  setText('det-gpu-controller', vm.os === 'Windows' ? 'VBoxSVGA' : 'VMSVGA');
  setText('det-3d-accel', vm.threeDAccel);
  setText('det-iso', vm.isoMounted === 'Vacío' ? '[Unidad óptica] Vacío' : vm.isoMounted);
  setText('det-disk', `${vm.name}.vdi (Normal, ${vm.diskSize.toFixed(2).replace('.', ',')} GB)`);

  renderNetworkDetailsSection(vm);
  renderPreviewMonitor(vm);
  renderNetworkInspector(vm);
}

function renderNetworkDetailsSection(vm) {
  const tbody = document.getElementById('det-network-tbody');
  if (!tbody) return;

  const enabledAdapters = vm.getEnabledAdapters();

  if (enabledAdapters.length === 0) {
    tbody.innerHTML = `
      <tr>
        <th>Adaptadores:</th>
        <td>
          <a href="#edit-network" class="detail-link" data-open-net-adapter="0">
            Ningún adaptador de red habilitado (Haga clic para configurar)
          </a>
        </td>
      </tr>
    `;
  } else {
    tbody.innerHTML = enabledAdapters
      .map((ad) => {
        const modeDesc =
          ad.mode === 'Red interna'
            ? `Red interna, '${escapeHTML(ad.intnetName || 'intnet')}'`
            : escapeHTML(ad.mode);

        let ipBadgeHtml = '';
        if (vm.state === 'Corriendo' && ad.ipInfo) {
          const badgeClass = ad.ipInfo.isFault
            ? 'fault-err'
            : ad.ipInfo.isWarning
              ? 'apipa-warn'
              : '';
          ipBadgeHtml = `<span class="detail-ip-inline ${badgeClass}" title="${escapeHTML(ad.ipInfo.dhcpStatus)}">IP: ${escapeHTML(ad.ipInfo.ip)}</span>`;
        } else {
          const cableLabel = !ad.cableConnected ? ' [Cable desconectado]' : '';
          ipBadgeHtml = `<span class="detail-ip-inline off-ip">IP: (Apagada${cableLabel})</span>`;
        }

          const pfRules =
            ad.mode === 'NAT' && Array.isArray(ad.portForwardingRules) ? ad.portForwardingRules : [];
          const pfHtml =
            pfRules.length > 0
              ? `<div class="detail-pf-sublist">
                   <i class="fa-solid fa-right-left"></i> Reenvío de puertos: ${pfRules
                     .map(
                       (r) =>
                         `${escapeHTML(r.name)} (${escapeHTML(r.protocol)} ${escapeHTML(r.hostIp || 'localhost')}:${escapeHTML(r.hostPort)} &rarr; ${escapeHTML(r.guestIp || '10.0.2.15')}:${escapeHTML(r.guestPort)})`
                     )
                     .join(', ')}
                 </div>`
              : '';

          return `
            <tr>
              <th>Adaptador ${ad.slot}:</th>
              <td>
                <div class="detail-net-line">
                  <a href="#edit-network" class="detail-link" data-open-net-adapter="${ad.slot - 1}">
                    Intel PRO/1000 MT Desktop (${modeDesc})
                  </a>
                  ${ipBadgeHtml}
                </div>
                ${pfHtml}
              </td>
            </tr>
          `;
        })
        .join('');
    }

  tbody.querySelectorAll('[data-open-net-adapter]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const adapterIdx = Number(link.getAttribute('data-open-net-adapter')) || 0;
      openSettingsModal('network', adapterIdx);
    });
  });
}

function renderNetworkInspector(vm) {
  const container = document.getElementById('network-inspector-body');
  if (!container) return;

  const enabled = vm.getEnabledAdapters();
  if (enabled.length === 0) {
    container.innerHTML = `<div class="inspector-nic-sub">No hay adaptadores habilitados en esta máquina.</div>`;
    return;
  }

  if (vm.state !== 'Corriendo') {
    container.innerHTML = enabled
      .map((ad) => {
        const modeLabel =
          ad.mode === 'Red interna' ? `${ad.mode} ('${escapeHTML(ad.intnetName)}')` : ad.mode;
        return `
          <div class="inspector-nic-card">
            <div class="inspector-nic-header">
              <span>Adaptador ${ad.slot} (eth${ad.slot - 1})</span>
              <span>${escapeHTML(modeLabel)}</span>
            </div>
            <div class="inspector-nic-sub">Estado: Máquina Apagada. Pulsa <strong>Iniciar</strong> para abrir terminal y asignar IP.</div>
          </div>
        `;
      })
      .join('');
    return;
  }

  container.innerHTML = enabled
    .map((ad) => {
      const info = ad.ipInfo;
      const modeLabel =
        ad.mode === 'Red interna' ? `${ad.mode} ('${escapeHTML(ad.intnetName)}')` : ad.mode;
      const fwNote =
        !AppState.examBlindMode && vm.firewallDropIcmp
          ? ' · [Firewall ICMP: DROP]'
          : '';
      return `
        <div class="inspector-nic-card">
          <div class="inspector-nic-header">
            <span>Adaptador ${ad.slot} (eth${ad.slot - 1})</span>
            <span>${escapeHTML(modeLabel)}</span>
          </div>
          <div class="inspector-nic-ip">
            IP: <strong>${escapeHTML(info?.ip || 'Sin IP')}</strong> | Máscara: ${escapeHTML(info?.netmask || '-')}
          </div>
          <div class="inspector-nic-sub">
            GW: ${escapeHTML(info?.gateway || '-')} · ${escapeHTML(info?.dhcpStatus || '')}${escapeHTML(fwNote)}
          </div>
        </div>
      `;
    })
    .join('');
}

function renderPreviewMonitor(vm) {
  const screenEl = document.getElementById('preview-screen');
  const ledEl = document.getElementById('preview-monitor-led');
  const resTagEl = document.getElementById('preview-resolution-tag');
  const powerBtnText = document.getElementById('btn-preview-power-text');

  if (!screenEl) return;

  if (vm.state === 'Apagada') {
    screenEl.className = 'preview-screen screen-off';
    screenEl.innerHTML = `
      <div>
        <div style="margin-bottom:6px; opacity:0.65;">${getOSIconSVG(vm.os, 30)}</div>
        <div><strong>${escapeHTML(vm.name)}</strong></div>
        <div style="font-size:10px; margin-top:2px;">[Máquina Apagada — Clic para Iniciar]</div>
      </div>
    `;
    ledEl?.classList.remove('led-on');
    if (resTagEl) resTagEl.textContent = 'Sin señal';
    if (powerBtnText) powerBtnText.textContent = 'Iniciar VM';
    return;
  }

  ledEl?.classList.add('led-on');
  if (resTagEl) resTagEl.textContent = 'TTY / Consola Activa';
  if (powerBtnText) powerBtnText.textContent = 'Abrir Terminal';

  const enabledAdapters = vm.getEnabledAdapters();
  const ipLines = enabledAdapters
    .map((ad) => `eth${ad.slot - 1} (${ad.mode}): ${ad.ipInfo?.ip || 'Sin IP'}`)
    .join('<br/>');

  if (vm.os === 'Linux') {
    screenEl.className = 'preview-screen screen-linux';
    screenEl.innerHTML = `
      <div>
        <div style="color:#7ce38b;">[  OK  ] Consola TTY1 activa (Clic para abrir)</div>
        <div style="color:#d2a8ff;">${escapeHTML(vm.getPromptString())} ip a</div>
        <div style="font-size:10px; color:#a5d6ff; margin-top:3px; line-height:1.35;">
          ${ipLines || 'lo: 127.0.0.1/8'}
        </div>
      </div>
      <div style="display:flex; justify-content:space-between; font-size:9.5px; color:#8b949e; border-top:1px solid #2d333b; padding-top:4px;">
        <span>Clic para escribir comandos</span>
        <span>NICs: ${enabledAdapters.length}/4</span>
      </div>
    `;
  } else {
    screenEl.className = 'preview-screen screen-windows';
    screenEl.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px;">
        ${getOSIconSVG('Windows', 20)}
        <div>
          <div style="font-weight:700; font-size:11px;">CMD.EXE — ${escapeHTML(vm.osVersion)}</div>
          <div style="font-size:9.5px; color:#cbe4ff;">C:\\Users\\Administrador&gt; ipconfig</div>
        </div>
      </div>
      <div style="background:rgba(0,0,0,0.35); padding:5px 7px; border-radius:2px; font-size:9.8px; line-height:1.35;">
        ${ipLines || 'Medios desconectados'}
      </div>
      <div style="display:flex; justify-content:space-between; font-size:9.5px; background:rgba(0,20,45,0.65); margin:-10px; margin-top:0; padding:4px 8px;">
        <span>Clic para abrir CMD</span>
        <span>NICs: ${enabledAdapters.length}</span>
      </div>
    `;
  }
}

function renderHostTelemetry() {
  const runningVMs = AppState.vms.filter((v) => v.state === 'Corriendo');
  const usedRam = runningVMs.reduce((acc, v) => acc + v.ram, 0);
  const usedCpu = runningVMs.reduce((acc, v) => acc + v.cpu, 0);

  const ramPercent = Math.min(100, Math.round((usedRam / HOST_TOTAL_RAM_MB) * 100));
  const cpuPercent = Math.min(100, Math.round((usedCpu / HOST_TOTAL_CPUS) * 100));

  setText('telemetry-ram-used', `${usedRam} MB / ${HOST_TOTAL_RAM_MB} MB`);
  setText('telemetry-cpu-used', `${usedCpu} / ${HOST_TOTAL_CPUS} hilos`);
  setText('host-ram-indicator', `Host RAM libre: ${Math.max(0, HOST_TOTAL_RAM_MB - usedRam)} MB`);

  const ramBar = document.getElementById('telemetry-ram-bar');
  const cpuBar = document.getElementById('telemetry-cpu-bar');
  if (ramBar) ramBar.style.width = `${ramPercent}%`;
  if (cpuBar) cpuBar.style.width = `${cpuPercent}%`;
}

/**
 * ============================================================================
 * FASE 4: PANEL DE TROUBLESHOOTING ("MODO DIOS" / OPCIONES DEL INSTRUCTOR)
 * ============================================================================
 */
function toggleInstructorDrawer(forceOpen) {
  const drawer = document.getElementById('instructor-drawer');
  const triggerBtn = document.getElementById('btn-instructor-toggle');
  if (!drawer) return;

  const shouldOpen =
    forceOpen !== undefined ? forceOpen : drawer.classList.contains('hidden');

  if (shouldOpen) {
    if (!AppState.instructorTargetVmId) {
      AppState.instructorTargetVmId = AppState.selectedVmId || AppState.vms[0]?.id || null;
    }
    drawer.classList.remove('hidden');
    triggerBtn?.classList.add('active');
    renderInstructorPanel();
  } else {
    drawer.classList.add('hidden');
    triggerBtn?.classList.remove('active');
  }
}

function renderInstructorPanel() {
  const targetSelect = document.getElementById('instructor-target-vm');
  const targetVm = getInstructorTargetVM();

  if (targetSelect) {
    targetSelect.innerHTML = AppState.vms
      .map(
        (vm) =>
          `<option value="${vm.id}" ${vm.id === targetVm?.id ? 'selected' : ''}>${escapeHTML(vm.name)} (${vm.state})</option>`
      )
      .join('');
  }

  // Contar todos los fallos activos en el laboratorio
  const activeFaultDescriptions = [];
  AppState.vms.forEach((vm) => {
    const cableDown = vm.getEnabledAdapters().some((a) => !a.cableConnected);
    if (cableDown) activeFaultDescriptions.push(`Cable desconectado en "${vm.name}"`);
    if (vm.firewallDropIcmp) activeFaultDescriptions.push(`Regla DROP ICMP en "${vm.name}"`);
  });
  if (AppState.ipConflictActive) {
    activeFaultDescriptions.push(`Conflicto IP/MAC (192.168.1.150) en Adaptador Puente`);
  }

  // Actualizar indicador en barra de estado inferior (si no está en Modo Examen Ciego)
  const faultBadge = document.getElementById('statusbar-fault-badge');
  const faultCountText = document.getElementById('statusbar-fault-count');
  if (faultBadge && faultCountText) {
    if (activeFaultDescriptions.length > 0 && !AppState.examBlindMode) {
      faultBadge.classList.remove('hidden');
      faultCountText.textContent = `${activeFaultDescriptions.length} fallo(s) activo(s)`;
    } else {
      faultBadge.classList.add('hidden');
    }
  }

  if (!targetVm) return;

  // Estado Fallo 1: Desconectar cable en la VM objetivo
  const enabledAdapters = targetVm.getEnabledAdapters();
  const isCableDisconnected =
    enabledAdapters.length > 0 && enabledAdapters.every((a) => !a.cableConnected);
  const cardCable = document.getElementById('fault-card-cable');
  const btnCable = document.getElementById('btn-fault-toggle-cable');
  const statusCable = document.getElementById('status-fault-cable');

  if (cardCable) cardCable.classList.toggle('fault-injected', isCableDisconnected);
  if (btnCable) {
    btnCable.textContent = isCableDisconnected ? 'Reconectar Cable' : 'Desconectar Cable';
    btnCable.classList.toggle('danger-btn', !isCableDisconnected);
  }
  if (statusCable) {
    statusCable.textContent = isCableDisconnected
      ? `FALLO ACTIVO: Cable desconectado en "${targetVm.name}" -> ping lanza "Network is unreachable"`
      : `Estado en "${targetVm.name}": Cable conectado (Nominal)`;
  }

  // Estado Fallo 2: Regla DROP en iptables / Firewall en la VM objetivo
  const isFirewallDrop = Boolean(targetVm.firewallDropIcmp);
  const cardFw = document.getElementById('fault-card-firewall');
  const btnFw = document.getElementById('btn-fault-toggle-firewall');
  const statusFw = document.getElementById('status-fault-firewall');

  if (cardFw) cardFw.classList.toggle('fault-injected', isFirewallDrop);
  if (btnFw) {
    btnFw.textContent = isFirewallDrop ? 'Quitar Regla DROP' : 'Inyectar DROP ICMP';
    btnFw.classList.toggle('danger-btn', !isFirewallDrop);
  }
  if (statusFw) {
    statusFw.textContent = isFirewallDrop
      ? `FALLO ACTIVO: iptables/Firewall DROP activo en "${targetVm.name}" -> ping lanza "Request timed out"`
      : `Estado en "${targetVm.name}": Tráfico ICMP permitido (Nominal)`;
  }

  // Estado Fallo 3: MAC Duplicada / Conflicto de IP en Adaptador Puente
  const cardConflict = document.getElementById('fault-card-conflict');
  const btnConflict = document.getElementById('btn-fault-toggle-conflict');
  const statusConflict = document.getElementById('status-fault-conflict');

  if (cardConflict) cardConflict.classList.toggle('fault-injected', AppState.ipConflictActive);
  if (btnConflict) {
    btnConflict.textContent = AppState.ipConflictActive ? 'Resolver Conflicto' : 'Forzar Conflicto IP/MAC';
    btnConflict.classList.toggle('danger-btn', !AppState.ipConflictActive);
  }
  if (statusConflict) {
    statusConflict.textContent = AppState.ipConflictActive
      ? `FALLO ACTIVO: Dos VMs comparten IP ${LAB_INFRASTRUCTURE_IPS.CONFLICT_BRIDGE_IP} y MAC en Puente (Caídas aleatorias)`
      : 'Estado global: Sin colisiones de IP/MAC en Adaptador Puente (Nominal)';
  }

  // Resumen inferior del panel del Instructor
  const summaryEl = document.getElementById('instructor-active-summary');
  if (summaryEl) {
    if (activeFaultDescriptions.length === 0) {
      summaryEl.innerHTML = `<i class="fa-solid fa-circle-check" style="color:#15803d;"></i> <strong>Laboratorio saludable:</strong> No hay fallos de red inyectados actualmente.`;
    } else {
      summaryEl.innerHTML = `<strong><i class="fa-solid fa-triangle-exclamation" style="color:#b45309;"></i> Fallos inyectados (${activeFaultDescriptions.length}):</strong><br/>• ${activeFaultDescriptions.map(escapeHTML).join('<br/>• ')}`;
    }
  }
}

/**
 * Inyecta o revierte el Fallo 1: "Desconectar cable" en la VM objetivo
 */
function handleToggleCableFault() {
  const vm = getInstructorTargetVM();
  if (!vm) return;

  const enabled = vm.getEnabledAdapters();
  if (enabled.length === 0) {
    vm.adapters[0].enabled = true;
  }

  const currentlyDisconnected = vm.getEnabledAdapters().every((a) => !a.cableConnected);
  const nextCableState = currentlyDisconnected; // true para reconectar, false para desconectar

  vm.getEnabledAdapters().forEach((ad) => {
    ad.cableConnected = nextCableState;
  });

  NetworkEngine.assignIPsForVM(vm, AppState.vms);
  saveToStorage();
  renderAll();

  if (!nextCableState) {
    setStatusMessage(
      `[Modo Dios] Cable desconectado en "${vm.name}". El comando ping devolverá "Network is unreachable".`
    );
  } else {
    setStatusMessage(`[Modo Dios] Cable reconectado en "${vm.name}". Enlace físico restaurado.`);
  }
}

/**
 * Inyecta o revierte el Fallo 2: "Regla DROP en iptables/Firewall" en la VM objetivo
 */
function handleToggleFirewallFault() {
  const vm = getInstructorTargetVM();
  if (!vm) return;

  const wasFirewallDropActive = Boolean(vm.firewallDropIcmp);
  vm.firewallDropIcmp = !vm.firewallDropIcmp;
  saveToStorage();
  renderAll();

  if (vm.firewallDropIcmp) {
    setStatusMessage(
      `[Modo Dios] Regla DROP ICMP inyectada en el Firewall/iptables de "${vm.name}". El ping dará "Request timed out".`
    );
  } else {
    // Fase 9 (Modo CTF): Si la VM tenía el fallo de Firewall y el usuario lo apaga desde la UI, registrar la remediación silenciosamente
    if (wasFirewallDropActive) {
      AppState.ctfState.firewallRemediatedVmIds.add(vm.id);
      notifyConsoleCommandListeners({
        type: 'ui_action',
        action: 'firewall_disabled_ui',
        vm,
        rawCommandLine: '[UI] Desactivar Regla DROP en Firewall'
      });
    }
    setStatusMessage(`[Modo Dios] Regla DROP eliminada del Firewall de "${vm.name}".`);
  }
}

/**
 * Inyecta o revierte el Fallo 3: "MAC Address Duplicada / IP Conflict" en Adaptador Puente
 */
function handleToggleIpConflictFault() {
  if (AppState.ipConflictActive) {
    // Limpiar el conflicto forzado y reasignar MACs e IPs limpias
    AppState.ipConflictActive = false;
    AppState.vms.forEach((vm) => {
      vm.adapters.forEach((ad) => {
        if (ad.forcedConflictIp) {
          ad.forcedConflictIp = null;
          ad.mac = generateVBoxMAC();
        }
      });
      NetworkEngine.assignIPsForVM(vm, AppState.vms);
    });
    saveToStorage();
    renderAll();
    setStatusMessage('[Modo Dios] Conflicto de IP y MAC duplicada resuelto. Direcciones DHCP restauradas.');
    return;
  }

  // Seleccionar 2 VMs para forzar el conflicto en Adaptador Puente
  if (AppState.vms.length < 2) {
    setStatusMessage('Se necesitan al menos 2 máquinas virtuales en el inventario para forzar un conflicto de IP.');
    return;
  }

  const vmA = getInstructorTargetVM() || AppState.vms[0];
  const vmB = AppState.vms.find((v) => v.id !== vmA.id) || AppState.vms[1];

  [vmA, vmB].forEach((vm) => {
    const ad = vm.adapters[0];
    ad.enabled = true;
    ad.cableConnected = true;
    ad.mode = 'Adaptador Puente';
    ad.mac = LAB_INFRASTRUCTURE_IPS.CONFLICT_MAC;
    ad.forcedConflictIp = LAB_INFRASTRUCTURE_IPS.CONFLICT_BRIDGE_IP;
    ad.dhcpLeased = true;
    if (vm.state !== 'Corriendo') {
      vm.start(AppState.vms);
      ad.dhcpLeased = true;
      NetworkEngine.assignIPsForVM(vm, AppState.vms);
    } else {
      NetworkEngine.assignIPsForVM(vm, AppState.vms);
    }
  });

  AppState.ipConflictActive = true;
  saveToStorage();
  renderAll();
  setStatusMessage(
    `[Modo Dios] Conflicto inyectado: "${vmA.name}" y "${vmB.name}" comparten IP ${LAB_INFRASTRUCTURE_IPS.CONFLICT_BRIDGE_IP} y MAC en Adaptador Puente.`
  );
}

/**
 * Botón "Restaurar estado de laboratorio": Limpia todos los fallos inyectados en todas las VMs
 */
function handleRestoreLabFaults() {
  clearActivePingTimers();
  AppState.ipConflictActive = false;

  AppState.vms.forEach((vm) => {
    vm.firewallDropIcmp = false;
    vm.adapters.forEach((ad) => {
      ad.cableConnected = true;
      if (ad.forcedConflictIp) {
        ad.forcedConflictIp = null;
        ad.mac = generateVBoxMAC();
      }
    });
    NetworkEngine.assignIPsForVM(vm, AppState.vms);
  });

  // Si la URL tenía un parámetro ?escenario=, limpiarlo al restaurar el laboratorio
  if (window.location.search.includes('escenario=')) {
    const cleanUrl = `${window.location.origin}${window.location.pathname}`;
    window.history.replaceState(null, '', cleanUrl);
  }
  document.getElementById('scenario-url-result')?.classList.add('hidden');

  saveToStorage();
  renderAll();
  setStatusMessage(
    'Estado del laboratorio restaurado: Todos los cables conectados, firewalls limpios y conflictos IP/MAC eliminados.'
  );
}

/**
 * ============================================================================
 * FASE 5: ESTADO COMPARTIBLE (ESCENARIOS POR URL `?escenario=[hash_base64]`)
 * - exportarEscenario(): Recolecta VMs, red y averías, convierte a JSON,
 *   codifica en Base64 con btoa() y actualiza la URL con ?escenario=[hash_base64].
 * - cargarEscenario(): En window.onload, lee ?escenario=, decodifica con atob(),
 *   parsea el JSON y reconstruye las VMs y los fallos exactos. Si está corrupto,
 *   captura el error con try/catch y muestra alert("Escenario inválido").
 * ============================================================================
 */
function showScenarioDialog({ title, message, detail, url = '', isError = false }) {
  const modal = document.getElementById('modal-scenario-alert');
  const titleEl = document.getElementById('scenario-alert-title');
  const iconEl = document.getElementById('scenario-alert-icon');
  const msgEl = document.getElementById('scenario-alert-message');
  const detailEl = document.getElementById('scenario-alert-detail');
  const urlBox = document.getElementById('scenario-modal-url-box');
  const urlInput = document.getElementById('scenario-modal-url-input');
  const copyBtn = document.getElementById('btn-modal-copy-scenario');

  if (!modal) return;

  if (titleEl) titleEl.textContent = title || 'Oracle VM VirtualBox — Escenario por URL';
  if (iconEl) {
    iconEl.style.color = isError ? '#b42318' : '#1a66b8';
    iconEl.innerHTML = isError
      ? '<i class="fa-solid fa-triangle-exclamation"></i>'
      : '<i class="fa-solid fa-link"></i>';
  }
  if (msgEl) msgEl.innerHTML = `<strong>${escapeHTML(message)}</strong>`;
  if (detailEl) detailEl.textContent = detail || '';

  if (urlBox && urlInput && copyBtn) {
    if (url) {
      urlBox.classList.remove('hidden');
      copyBtn.classList.remove('hidden');
      urlInput.value = url;
    } else {
      urlBox.classList.add('hidden');
      copyBtn.classList.add('hidden');
      urlInput.value = '';
    }
  }

  modal.classList.remove('hidden');
}

function closeScenarioDialog() {
  document.getElementById('modal-scenario-alert')?.classList.add('hidden');
}

/**
 * Función solicitada en Fase 5: exportarEscenario()
 * Recolecta el array de VMs actuales, sus configuraciones de red y el estado
 * de las averías inyectadas, lo convierte a JSON, lo codifica en Base64 (btoa())
 * y actualiza la URL del navegador añadiendo ?escenario=[hash_base64].
 */
export function exportarEscenario() {
  const scenarioPayload = {
    version: 5,
    selectedVmId: AppState.selectedVmId,
    instructorTargetVmId: AppState.instructorTargetVmId,
    examBlindMode: Boolean(AppState.examBlindMode),
    ipConflictActive: Boolean(AppState.ipConflictActive),
    faults: {
      ipConflictActive: Boolean(AppState.ipConflictActive),
      examBlindMode: Boolean(AppState.examBlindMode),
      vmFaults: AppState.vms.map((vm) => ({
        vmId: vm.id,
        firewallDropIcmp: Boolean(vm.firewallDropIcmp),
        cablesConnected: vm.adapters.map((a) => Boolean(a.cableConnected)),
        forcedConflictIps: vm.adapters.map((a) => a.forcedConflictIp || null)
      }))
    },
    vms: AppState.vms.map((vm) => ({
      id: vm.id,
      name: vm.name,
      os: vm.os,
      osVersion: vm.osVersion,
      ram: vm.ram,
      cpu: vm.cpu,
      state: vm.state,
      vram: vm.vram,
      diskSize: vm.diskSize,
      isoMounted: vm.isoMounted,
      threeDAccel: vm.threeDAccel,
      firewallDropIcmp: Boolean(vm.firewallDropIcmp),
      adapters: vm.adapters.map((ad) => ({
        slot: ad.slot,
        enabled: Boolean(ad.enabled),
        mode: ad.mode,
        intnetName: ad.intnetName || 'intnet',
        mac: ad.mac,
        cableConnected: Boolean(ad.cableConnected),
        manualStaticIp: ad.manualStaticIp || null,
        forcedConflictIp: ad.forcedConflictIp || null,
        dhcpLeased: Boolean(ad.dhcpLeased),
        portForwardingRules: normalizePortForwardingRules(ad.portForwardingRules)
      }))
    }))
  };

  // Escapar caracteres Unicode (> 0x7F) como \uXXXX para que btoa() y atob() nativos
  // funcionen directamente sin errores de codificación Latin1.
  const jsonString = JSON.stringify(scenarioPayload).replace(
    /[\u0080-\uFFFF]/g,
    (ch) => '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4)
  );

  const hashBase64 = btoa(jsonString);
  const newRelativeUrl = `${window.location.pathname}?escenario=${hashBase64}`;
  window.history.replaceState({ escenario: hashBase64 }, '', newRelativeUrl);

  // Fase 9 (Modo CTF): Si se exporta a la URL un escenario donde alguna VM tiene la avería
  // "Firewall bloqueando ICMP", registrar ese estado inicial para el validador CTF
  const fwFaultVms = AppState.vms.filter((v) => Boolean(v.firewallDropIcmp));
  if (fwFaultVms.length > 0) {
    AppState.ctfState.scenarioLoadedFromUrl = true;
    fwFaultVms.forEach((v) => {
      AppState.ctfState.initialFirewallFaultVmIds.add(v.id);
      AppState.ctfState.firewallRemediatedVmIds.delete(v.id);
    });
    AppState.ctfState.unlockedFlags.delete('ctf-firewall-icmp-master');
  }

  const fullShareUrl = `${window.location.origin}${newRelativeUrl}`;

  // Mostrar el enlace en el cajón del Instructor si está presente
  const resultBox = document.getElementById('scenario-url-result');
  const urlInput = document.getElementById('input-scenario-url');
  const feedbackEl = document.getElementById('scenario-copy-feedback');

  if (resultBox && urlInput) {
    resultBox.classList.remove('hidden');
    urlInput.value = fullShareUrl;
  }

  // Intentar copiar automáticamente al portapapeles
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(fullShareUrl).catch(() => {});
  }

  if (feedbackEl) {
    feedbackEl.classList.remove('hidden');
  }

  setStatusMessage(
    `Enlace de práctica generado (?escenario=...). URL actualizada con ${AppState.vms.length} VMs y estado de fallos.`
  );

  showScenarioDialog({
    title: 'Enlace de Práctica Generado (Fase 5)',
    message: 'Estado del laboratorio exportado en la URL',
    detail:
      'La barra de direcciones se ha actualizado con ?escenario=[hash_base64]. Comparte este enlace con tus alumnos para que carguen exactamente estas VMs, sus redes y las averías activas:',
    url: fullShareUrl,
    isError: false
  });

  return fullShareUrl;
}

/**
 * Función solicitada en Fase 5: cargarEscenario()
 * Se ejecuta en window.onload. Si la URL contiene el parámetro ?escenario=,
 * decodifica el Base64 (atob()), parsea el JSON y reconstruye las VMs y
 * los fallos exactos en la interfaz. Maneja errores con try/catch mostrando
 * un alert() de "Escenario inválido".
 */
export function cargarEscenario() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('escenario')) {
    return false;
  }

  const rawParam = params.get('escenario');

  try {
    if (!rawParam || !rawParam.trim()) {
      throw new Error('Parámetro escenario vacío');
    }

    // Normalizar espacios que puedan haberse convertido desde '+' en la query string
    const normalizedBase64 = rawParam.trim().replace(/ /g, '+');
    const decodedString = atob(normalizedBase64);

    let parsedData;
    try {
      parsedData = JSON.parse(decodedString);
    } catch {
      // Fallback por si el Base64 fue codificado con encodeURIComponent/escape
      parsedData = JSON.parse(decodeURIComponent(escape(decodedString)));
    }

    const rawVmsArray = Array.isArray(parsedData)
      ? parsedData
      : parsedData && Array.isArray(parsedData.vms)
        ? parsedData.vms
        : null;

    if (!rawVmsArray || rawVmsArray.length === 0) {
      throw new Error('Estructura de VMs inválida en el escenario');
    }

    // Validar que cada elemento tenga al menos nombre válido
    const validItems = rawVmsArray.every(
      (item) => item && typeof item === 'object' && typeof item.name === 'string' && item.name.trim().length > 0
    );
    if (!validItems) {
      throw new Error('Datos de máquina virtual incompletos o corruptos');
    }

    // Reconstruir las instancias de VirtualMachine y sus averías exactas
    AppState.vms = rawVmsArray.map((item) => new VirtualMachine(item));

    // Aplicar metadatos adicionales de fallos si vienen en el objeto raíz
    if (parsedData && !Array.isArray(parsedData)) {
      AppState.examBlindMode = Boolean(parsedData.examBlindMode ?? parsedData.faults?.examBlindMode);
      const examBlindChk = document.getElementById('chk-exam-blind-mode');
      if (examBlindChk) examBlindChk.checked = AppState.examBlindMode;
    }

    // Recalcular IPs en base a los modos y averías de cada VM
    AppState.vms.forEach((vm) => {
      NetworkEngine.assignIPsForVM(vm, AppState.vms);
      if (vm.state === 'Corriendo') {
        vm.initBootBanner();
      }
    });

    AppState.ipConflictActive = AppState.vms.some((v) =>
      v.adapters.some((a) => Boolean(a.forcedConflictIp))
    );

    const requestedSelectedId = !Array.isArray(parsedData) ? parsedData.selectedVmId : null;
    AppState.selectedVmId =
      AppState.vms.find((v) => v.id === requestedSelectedId)?.id || AppState.vms[0]?.id || null;

    const requestedTargetId = !Array.isArray(parsedData) ? parsedData.instructorTargetVmId : null;
    AppState.instructorTargetVmId =
      AppState.vms.find((v) => v.id === requestedTargetId)?.id || AppState.selectedVmId;

    // FASE 9 (Modo CTF): Auditar silenciosamente si el escenario cargado por URL (?escenario=)
    // traía la avería "Firewall bloqueando ICMP", cable desconectado o retos de NAT Port Forwarding
    AppState.ctfState.scenarioLoadedFromUrl = true;
    AppState.ctfState.initialFirewallFaultVmIds = new Set(
      AppState.vms.filter((v) => Boolean(v.firewallDropIcmp)).map((v) => v.id)
    );
    AppState.ctfState.initialPortForwardingEmptyVmIds = new Set(
      AppState.vms
        .filter((v) =>
          v.adapters.some(
            (a) =>
              a.enabled &&
              a.mode === 'NAT' &&
              (!Array.isArray(a.portForwardingRules) || a.portForwardingRules.length === 0)
          )
        )
        .map((v) => v.id)
    );
    AppState.ctfState.initialCableDownVmIds = new Set(
      AppState.vms
        .filter((v) => v.getEnabledAdapters().some((a) => !a.cableConnected))
        .map((v) => v.id)
    );
    AppState.ctfState.firewallRemediatedVmIds.clear();
    AppState.ctfState.unlockedFlags.clear();

    saveToStorage();
    renderAll();
    setStatusMessage(
      `Escenario de práctica cargado desde la URL (${AppState.vms.length} máquinas virtuales reconstruidas).`
    );
    return true;
  } catch (err) {
    console.error('Error al decodificar ?escenario=:', err);
    try {
      alert('Escenario inválido');
    } catch {
      // Fallback silencioso si el contenedor bloquea window.alert
    }
    showScenarioDialog({
      title: 'Error al cargar escenario',
      message: 'Escenario inválido',
      detail:
        'El código Base64 del parámetro ?escenario= está corrupto o no corresponde a un estado válido de VirtLab. Se ha cargado el estado local por defecto.',
      isError: true
    });
    return false;
  }
}

/**
 * Helper para que el instructor o alumno pueda preparar y cargar en 1 clic
 * un escenario por URL (?escenario=...) con la avería "Firewall bloqueando ICMP"
 */
function handleLoadCtfFirewallScenario() {
  const targetVm = getInstructorTargetVM() || getSelectedVM() || AppState.vms[0];
  if (!targetVm) return;

  // Asegurar que Adaptador 1 esté en NAT (con salida a 8.8.8.8) y con cable conectado, pero con Firewall bloqueando ICMP
  const primaryAd = targetVm.adapters[0];
  if (primaryAd) {
    primaryAd.enabled = true;
    primaryAd.cableConnected = true;
    if (primaryAd.mode !== 'NAT' && primaryAd.mode !== 'Adaptador Puente') {
      primaryAd.mode = 'NAT';
    }
  }
  targetVm.firewallDropIcmp = true;
  if (targetVm.state !== 'Corriendo') {
    targetVm.start(AppState.vms);
  }
  if (primaryAd) {
    primaryAd.dhcpLeased = true;
  }
  NetworkEngine.assignIPsForVM(targetVm, AppState.vms);

  exportarEscenario();
  cargarEscenario();
  setStatusMessage(
    `[Modo CTF] Escenario cargado por URL (?escenario=...) con Firewall bloqueando ICMP en "${targetVm.name}". Desbloquéalo (ej. "ufw allow icmp") y haz "ping 8.8.8.8".`
  );
}

/**
 * ============================================================================
 * FASE 3: CONSOLA INTERACTIVA DE LA VM (TTY LINUX / CMD WINDOWS) Y COMANDOS
 * ============================================================================
 */
function handleStartOrOpenConsole() {
  const vm = getSelectedVM();
  if (!vm) return;

  if (vm.state === 'Apagada') {
    const runningRam = AppState.vms
      .filter((v) => v.state === 'Corriendo')
      .reduce((acc, v) => acc + v.ram, 0);

    if (runningRam + vm.ram > HOST_TOTAL_RAM_MB) {
      setStatusMessage(
        `Error VERR_NO_MEMORY: No hay suficiente RAM libre en el Host (${HOST_TOTAL_RAM_MB - runningRam} MB libres) para iniciar "${vm.name}" (${vm.ram} MB).`
      );
      return;
    }

    vm.start(AppState.vms);
    saveToStorage();
    renderAll();
    setStatusMessage(`VM "${vm.name}" iniciada. Abriendo ventana de terminal interactiva...`);
  }

  openVMConsoleModal(vm.id);
}

function handlePowerOffSelectedVM() {
  const vm = getSelectedVM();
  if (!vm || vm.state !== 'Corriendo') return;

  clearActivePingTimers();
  vm.powerOff(AppState.vms);
  saveToStorage();

  if (AppState.consoleVmId === vm.id) {
    const anotherRunning = AppState.vms.find((v) => v.state === 'Corriendo');
    if (anotherRunning) {
      AppState.consoleVmId = anotherRunning.id;
      AppState.selectedVmId = anotherRunning.id;
    } else {
      closeVMConsoleModal();
    }
  }

  renderAll();
  setStatusMessage(`La máquina virtual "${vm.name}" se ha apagado correctamente.`);
}

function openVMConsoleModal(vmId) {
  const vm = AppState.vms.find((v) => v.id === vmId) || getSelectedVM();
  if (!vm) return;

  if (vm.state !== 'Corriendo') {
    vm.start(AppState.vms);
    saveToStorage();
  }

  AppState.consoleVmId = vm.id;
  AppState.selectedVmId = vm.id;
  AppState.instructorTargetVmId = vm.id;
  AppState.historyCursor = vm.commandHistory.length;

  const modal = document.getElementById('modal-vm-console');
  modal?.classList.remove('hidden');

  renderAll();
  focusTerminalInput();
}

function closeVMConsoleModal() {
  clearActivePingTimers();
  document.getElementById('modal-vm-console')?.classList.add('hidden');
}

function clearActivePingTimers() {
  AppState.activePingTimers.forEach((t) => clearTimeout(t));
  AppState.activePingTimers = [];
  AppState.isPinging = false;
  document.getElementById('console-net-led')?.classList.remove('net-transmitting');
}

function focusTerminalInput() {
  const input = document.getElementById('vm-terminal-input');
  if (input && !input.disabled) {
    input.focus();
  }
}

function openHostConsoleModal() {
  clearActivePingTimers();
  if (!AppState.hostConsole.consoleLogs || AppState.hostConsole.consoleLogs.length === 0) {
    AppState.hostConsole.initBootBanner();
  }
  AppState.consoleVmId = HOST_CONSOLE_ID;
  AppState.historyCursor = AppState.hostConsole.commandHistory.length;

  const modal = document.getElementById('modal-vm-console');
  modal?.classList.remove('hidden');

  renderAll();
  focusTerminalInput();
  setStatusMessage(
    'Consola del Anfitrión abierta. Ejecuta "curl localhost:8080" para probar las reglas de Reenvío de Puertos NAT.'
  );
}

function renderConsoleWindow() {
  const vm = getConsoleVM();
  if (!vm) return;

  const isHostConsole = vm.id === HOST_CONSOLE_ID;

  const titleEl = document.getElementById('vm-console-window-title');
  const osMiniIcon = document.getElementById('vm-console-os-mini-icon');
  const viewportEl = document.getElementById('vm-terminal-viewport');
  const promptPrefixEl = document.getElementById('vm-prompt-prefix');
  const quickDhcpBtn = document.getElementById('quick-btn-dhcp');
  const quickDhcpLabel = document.getElementById('quick-cmd-dhcp-label');
  const quickIpLabel = document.getElementById('quick-cmd-ip-label');
  const quickTraceLabel = document.getElementById('quick-cmd-trace-label');
  const switcherEl = document.getElementById('console-running-switcher');
  const netLedText = document.getElementById('console-net-led-text');
  const acpiBtn = document.getElementById('btn-console-acpi-off');
  const switchHostBtn = document.getElementById('btn-console-switch-host');

  if (titleEl) {
    titleEl.textContent = isHostConsole
      ? 'Consola del Anfitrión (Host — 192.168.1.100 / localhost) — Terminal del Anfitrión'
      : `${vm.name} [${vm.state}] — Oracle VM VirtualBox (${vm.os === 'Windows' ? 'CMD.EXE' : 'TTY1'})`;
  }
  if (osMiniIcon) {
    osMiniIcon.innerHTML = isHostConsole
      ? '<i class="fa-solid fa-desktop" style="color:#1d4ed8; font-size:13px; padding:1px;"></i>'
      : getOSIconSVG(vm.os, 16);
  }
  if (viewportEl) {
    viewportEl.classList.toggle('windows-cmd-theme', !isHostConsole && vm.os === 'Windows');
    viewportEl.classList.toggle('host-terminal-theme', isHostConsole);
  }
  if (promptPrefixEl) {
    promptPrefixEl.textContent = vm.getPromptString();
  }
  if (quickDhcpBtn) {
    quickDhcpBtn.classList.toggle('hidden', isHostConsole);
  }
  if (quickDhcpLabel && !isHostConsole) {
    quickDhcpLabel.textContent = vm.os === 'Windows' ? 'ipconfig /renew' : 'dhclient';
  }
  if (quickIpLabel) {
    quickIpLabel.textContent = !isHostConsole && vm.os === 'Windows' ? 'ipconfig' : 'ip a';
  }
  if (quickTraceLabel) {
    quickTraceLabel.textContent = !isHostConsole && vm.os === 'Windows' ? 'tracert 8.8.8.8' : 'traceroute 8.8.8.8';
  }
  if (acpiBtn) {
    acpiBtn.classList.toggle('hidden', isHostConsole);
  }
  if (switchHostBtn) {
    switchHostBtn.innerHTML = isHostConsole
      ? '<i class="fa-solid fa-terminal"></i> Volver a Consola VM'
      : '<i class="fa-solid fa-desktop"></i> Consola del Anfitrión';
  }

  const enabledCount = isHostConsole ? 2 : vm.getEnabledAdapters().length;
  if (netLedText) {
    netLedText.textContent = isHostConsole ? 'Host LAN + Host-Only' : `${enabledCount} NIC(s)`;
  }

  if (switcherEl) {
    const hostOption = `<option value="${HOST_CONSOLE_ID}" ${isHostConsole ? 'selected' : ''}>🖥️ Consola del Anfitrión (Host - localhost)</option>`;
    const vmOptions = AppState.vms
      .map(
        (item) =>
          `<option value="${item.id}" ${!isHostConsole && item.id === vm.id ? 'selected' : ''}>${escapeHTML(item.name)} (${item.state})</option>`
      )
      .join('');
    switcherEl.innerHTML = hostOption + vmOptions;
  }

  renderTerminalOutput(vm);
  renderLabIpMapSidebar(vm);
}

function renderTerminalOutput(vm) {
  const outputEl = document.getElementById('vm-terminal-output');
  const viewportEl = document.getElementById('vm-terminal-viewport');
  if (!outputEl) return;

  if (!vm.consoleLogs || vm.consoleLogs.length === 0) {
    vm.initBootBanner();
  }

  outputEl.innerHTML = vm.consoleLogs
    .map((entry) => {
      if (entry.type === 'routing-box') {
        if (AppState.examBlindMode) return '';
        return `<div class="term-routing-box ${entry.blocked ? 'blocked' : ''}">${entry.html}</div>`;
      }
      const cls =
        entry.type === 'ctf-flag'
          ? 'term-ctf-flag'
          : entry.type === 'banner'
            ? 'term-banner'
            : entry.type === 'cmd'
              ? 'term-cmd-echo'
              : entry.type === 'success'
                ? 'term-success'
                : entry.type === 'warn'
                  ? 'term-warn'
                  : entry.type === 'error'
                    ? 'term-error'
                    : entry.type === 'info'
                      ? 'term-info'
                      : '';
      return `<div class="term-line ${cls}">${escapeHTML(entry.text)}</div>`;
    })
    .join('');

  if (viewportEl) {
    viewportEl.scrollTop = viewportEl.scrollHeight;
  }
}

function appendTerminalLog(vm, type, text) {
  vm.consoleLogs.push({ type, text });
  renderTerminalOutput(vm);
}

function appendTerminalRoutingBox(vm, blocked, html) {
  vm.consoleLogs.push({ type: 'routing-box', blocked, html });
  renderTerminalOutput(vm);
}

function renderLabIpMapSidebar(currentVm) {
  const mapEl = document.getElementById('console-lab-ip-map');
  if (!mapEl) return;

  const infraHtml = `
    <div class="lab-ip-entry">
      <div class="lab-ip-top">
        <span><i class="fa-solid fa-globe"></i> Internet Público</span>
        <span>WAN</span>
      </div>
      <div class="lab-ip-row">
        <span>DNS: <strong>8.8.8.8</strong></span>
        <button type="button" class="btn-ping-target" data-ping-ip="8.8.8.8">Ping</button>
      </div>
    </div>

    <div class="lab-ip-entry">
      <div class="lab-ip-top">
        <span><i class="fa-solid fa-desktop"></i> Máquina Anfitrión (Host)</span>
        <span>Física / Host-Only</span>
      </div>
      <div class="lab-ip-row">
        <span>LAN Física: <strong>192.168.1.100</strong></span>
        <button type="button" class="btn-ping-target" data-ping-ip="192.168.1.100">Ping</button>
      </div>
      <div class="lab-ip-row">
        <span>Host-Only: <strong>192.168.56.1</strong></span>
        <button type="button" class="btn-ping-target" data-ping-ip="192.168.56.1">Ping</button>
      </div>
    </div>
  `;

  const vmsHtml = AppState.vms
    .map((vm) => {
      const isCurrent = vm.id === currentVm.id;
      const isRunning = vm.state === 'Corriendo';
      const enabled = vm.getEnabledAdapters();

      const adaptersRows =
        isRunning && enabled.length > 0
          ? enabled
              .map((ad) => {
                const ip = ad.ipInfo?.ip || 'Sin IP';
                const isValidIp = /^\d+\.\d+\.\d+\.\d+$/.test(ip);
                const isPendingDhcp = Boolean(ad.ipInfo?.isPendingDhcp);
                const modeShort =
                  ad.mode === 'Red interna'
                    ? `Interna '${escapeHTML(ad.intnetName)}'`
                    : escapeHTML(ad.mode);
                return `
                  <div class="lab-ip-row">
                    <span>eth${ad.slot - 1} (${modeShort}): <strong>${escapeHTML(ip)}</strong></span>
                    ${
                      isValidIp
                        ? `<button type="button" class="btn-ping-target" data-ping-ip="${escapeHTML(ip)}">Ping</button>`
                        : isPendingDhcp
                          ? `<button type="button" class="btn-ping-target" data-dhcp-vm="${vm.id}" title="Solicitar IP por DHCP (DORA)">DHCP</button>`
                          : ''
                    }
                  </div>
                `;
              })
              .join('')
          : `<div class="lab-ip-row" style="color:#6c757d;">
               <span>[Máquina Apagada — Sin IP activa]</span>
               <button type="button" class="btn-ping-target" data-boot-vm="${vm.id}">Encender</button>
             </div>`;

      return `
        <div class="lab-ip-entry ${isCurrent ? 'current-vm-entry' : ''}">
          <div class="lab-ip-top">
            <span>${escapeHTML(vm.name)} ${isCurrent ? '(Actual)' : ''}</span>
            <span style="color:${isRunning ? '#1f7a1f' : '#6c757d'};">${vm.state}</span>
          </div>
          ${adaptersRows}
        </div>
      `;
    })
    .join('');

  mapEl.innerHTML = infraHtml + vmsHtml;

  mapEl.querySelectorAll('[data-ping-ip]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetIp = btn.getAttribute('data-ping-ip');
      if (targetIp) {
        executeTerminalCommand(`ping ${targetIp}`);
      }
    });
  });

  mapEl.querySelectorAll('[data-dhcp-vm]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-dhcp-vm');
      const targetVm = AppState.vms.find((v) => v.id === targetId);
      if (!targetVm) return;
      if (targetVm.id === currentVm.id) {
        executeTerminalCommand(currentVm.os === 'Windows' ? 'ipconfig /renew' : 'dhclient');
      } else {
        targetVm.adapters.forEach((ad) => {
          if (ad.enabled && ad.cableConnected && ad.mode !== 'Red interna') {
            ad.dhcpLeased = true;
          }
        });
        NetworkEngine.assignIPsForVM(targetVm, AppState.vms);
        saveToStorage();
        renderAll();
        appendTerminalLog(
          currentVm,
          'info',
          `[VirtLab] Proceso DORA ejecutado en "${targetVm.name}" (${targetVm.adapters[0]?.ipInfo?.ip || 'IP asignada'}).`
        );
      }
    });
  });

  mapEl.querySelectorAll('[data-boot-vm]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-boot-vm');
      const targetVm = AppState.vms.find((v) => v.id === targetId);
      if (targetVm && targetVm.state === 'Apagada') {
        targetVm.start(AppState.vms);
        saveToStorage();
        renderAll();
        appendTerminalLog(
          currentVm,
          'info',
          `[VirtLab] La máquina "${targetVm.name}" se ha encendido en segundo plano (ejecuta DHCP para asignarle IP).`
        );
      }
    });
  });
}

/**
 * ============================================================================
 * INTÉRPRETE DE COMANDOS DE LA TERMINAL (`ip a`, `ipconfig`, `ping`, `iptables`)
 * ============================================================================
 */
function executeTerminalCommand(rawCommandLine) {
  const vm = getConsoleVM();
  if (!vm) return;

  if (AppState.isPinging) {
    clearActivePingTimers();
    appendTerminalLog(vm, 'warn', '^C (Ejecución de ping interrumpida)');
  }

  const trimmed = String(rawCommandLine || '').trim();
  appendTerminalLog(vm, 'cmd', `${vm.getPromptString()} ${trimmed}`);

  if (!trimmed) return;

  vm.commandHistory.push(trimmed);
  AppState.historyCursor = vm.commandHistory.length;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  // FASE 9: Notificar al listener silencioso del procesador de comandos de la consola
  notifyConsoleCommandListeners({
    type: 'command',
    action: 'command_entered',
    vm,
    rawCommandLine: trimmed,
    cmd,
    parts
  });

  // 1. Limpiar pantalla: clear / cls
  if (cmd === 'clear' || cmd === 'cls') {
    vm.consoleLogs = [];
    renderTerminalOutput(vm);
    return;
  }

  // 2. Ayuda: help / ?
  if (cmd === 'help' || cmd === '?') {
    printHelpCommand(vm);
    return;
  }

  // 3. FASE 7: Comando `curl localhost:[Puerto_Anfitrión]` (Reenvío de Puertos / Port Forwarding NAT)
  const lowerTrimmed = trimmed.toLowerCase();
  if (cmd === 'curl') {
    const targetUrl = parts.slice(1).find((p) => !p.startsWith('-'));
    if (!targetUrl) {
      appendTerminalLog(
        vm,
        'error',
        'curl: try "curl localhost:8080" (Especifica la dirección y el Puerto Anfitrión configurado en el Reenvío de Puertos NAT).'
      );
      return;
    }
    runCurlPortForwardingSimulation(vm, targetUrl);
    return;
  }

  // 4. FASE 6: Motor DHCP Interactivo en Terminal (`dhclient` en Linux / `ipconfig /renew` en Windows)
  if (
    cmd === 'dhclient' ||
    lowerTrimmed.startsWith('sudo dhclient') ||
    lowerTrimmed === 'ipconfig /renew' ||
    lowerTrimmed.startsWith('ipconfig /renew ') ||
    lowerTrimmed === 'ipconfig /release'
  ) {
    if (vm.id === HOST_CONSOLE_ID) {
      appendTerminalLog(
        vm,
        'info',
        'La Máquina Anfitrión (Host) ya posee sus IPs fijas: 192.168.1.100 (LAN Física) y 192.168.56.1 (Host-Only).'
      );
      return;
    }
    if (lowerTrimmed === 'ipconfig /release' || parts.includes('-r')) {
      vm.adapters.forEach((ad) => {
        if (!ad.manualStaticIp || ad.mode !== 'Red interna') {
          ad.dhcpLeased = false;
        }
      });
      NetworkEngine.assignIPsForVM(vm, AppState.vms);
      saveToStorage();
      renderAll();
      appendTerminalLog(
        vm,
        'info',
        vm.os === 'Windows'
          ? 'Configuración IP de Windows:\n   Se ha liberado correctamente la concesión de dirección IPv4 (DHCPRELEASE).'
          : 'DHCPRELEASE sent. Concesión DHCP liberada en las interfaces activas.'
      );
      return;
    }

    runDhcpClientSimulation(vm, trimmed);
    return;
  }

  // 5. Comando `ip a` / `ip addr` / `ifconfig` / `ipconfig`
  if (
    cmd === 'ipconfig' ||
    cmd === 'ifconfig' ||
    lowerTrimmed === 'ip a' ||
    lowerTrimmed === 'ip addr' ||
    lowerTrimmed === 'ip address' ||
    lowerTrimmed.startsWith('ip -4 a')
  ) {
    if (vm.id === HOST_CONSOLE_ID) {
      appendTerminalLog(
        vm,
        'normal',
        [
          '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 state UNKNOWN',
          '    inet 127.0.0.1/8 scope host lo',
          '    inet 127.0.1.1/8 scope host secondary lo',
          '2: eth0 (LAN Física del Anfitrión): <BROADCAST,MULTICAST,UP,LOWER_UP> state UP',
          `    inet ${LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_LAN}/24 brd 192.168.1.255 scope global eth0`,
          '3: vboxnet0 (VirtualBox Host-Only Ethernet Adapter): <BROADCAST,MULTICAST,UP,LOWER_UP> state UP',
          `    inet ${LAB_INFRASTRUCTURE_IPS.HOST_ONLY_ADAPTER}/24 brd 192.168.56.255 scope global vboxnet0`
        ].join('\n')
      );
      return;
    }
    printIpConfiguration(vm);
    return;
  }

  // 6. FASE 4 y FASE 9: Inspección y desbloqueo de Firewall (`ufw allow icmp`, `ufw disable`, `iptables -L`, `iptables -F`, `netsh`)
  if (
    cmd === 'ufw' ||
    lowerTrimmed.startsWith('sudo ufw') ||
    lowerTrimmed.startsWith('netsh advfirewall')
  ) {
    if (vm.id === HOST_CONSOLE_ID) {
      appendTerminalLog(vm, 'normal', 'Status: inactive (El firewall del Anfitrión no tiene reglas de bloqueo activas).');
      return;
    }

    const ufwNormalized = lowerTrimmed.replace(/^sudo\s+/, '').trim();
    if (
      ufwNormalized === 'ufw allow icmp' ||
      ufwNormalized === 'ufw allow proto icmp' ||
      ufwNormalized === 'ufw disable' ||
      ufwNormalized === 'ufw reset' ||
      ufwNormalized.includes('state off')
    ) {
      vm.firewallDropIcmp = false;
      AppState.ctfState.firewallRemediatedVmIds.add(vm.id);
      saveToStorage();
      renderAll();

      if (ufwNormalized.includes('disable')) {
        appendTerminalLog(vm, 'success', 'Firewall stopped and disabled on system startup');
      } else if (ufwNormalized.includes('state off')) {
        appendTerminalLog(vm, 'success', 'Aceptar.\n[Firewall de Windows]: Estado del firewall desactivado (Tráfico ICMP permitido).');
      } else {
        appendTerminalLog(
          vm,
          'success',
          'Rule added\nRule added (v6)\n[ufw]: Tráfico ICMP (echo-request / echo-reply) permitido en el firewall.'
        );
      }

      notifyConsoleCommandListeners({
        type: 'command',
        action: 'firewall_remediated_cli',
        vm,
        rawCommandLine: trimmed,
        cmd: 'ufw'
      });
      return;
    }

    if (ufwNormalized === 'ufw status' || ufwNormalized === 'ufw status verbose') {
      if (vm.firewallDropIcmp) {
        appendTerminalLog(
          vm,
          'warn',
          'Status: active\n\nTo                         Action      From\n--                         ------      ----\nAnywhere (icmp)            DENY IN     Anywhere                   # Regla DROP ICMP activa\n\n(Ejecuta "ufw allow icmp" o "ufw disable" para permitir el tráfico ICMP)'
        );
      } else {
        appendTerminalLog(
          vm,
          'normal',
          'Status: active\n\nTo                         Action      From\n--                         ------      ----\nAnywhere (icmp)            ALLOW IN    Anywhere'
        );
      }
      return;
    }

    appendTerminalLog(
      vm,
      'info',
      'Uso de ufw: "ufw status", "ufw allow icmp" o "ufw disable".'
    );
    return;
  }

  if (cmd === 'iptables' || lowerTrimmed.startsWith('sudo iptables')) {
    if (vm.id === HOST_CONSOLE_ID) {
      appendTerminalLog(vm, 'normal', 'Chain INPUT (policy ACCEPT)\nChain FORWARD (policy ACCEPT)\nChain OUTPUT (policy ACCEPT)');
      return;
    }
    const cleanParts = lowerTrimmed.replace(/^sudo\s+/, '').split(/\s+/);
    const flag = (cleanParts[1] || '-L').toUpperCase();
    if (flag === '-F' || flag === '--FLUSH' || flag === '-D') {
      vm.firewallDropIcmp = false;
      AppState.ctfState.firewallRemediatedVmIds.add(vm.id);
      saveToStorage();
      renderAll();
      appendTerminalLog(vm, 'success', 'iptables: Todas las reglas DROP de la cadena INPUT han sido limpiadas (ACCEPT).');

      notifyConsoleCommandListeners({
        type: 'command',
        action: 'firewall_remediated_cli',
        vm,
        rawCommandLine: trimmed,
        cmd: 'iptables'
      });
      return;
    }
    if (vm.firewallDropIcmp) {
      appendTerminalLog(
        vm,
        'warn',
        'Chain INPUT (policy ACCEPT)\ntarget     prot opt source               destination\nDROP       icmp --  anywhere             anywhere             icmp echo-request\n\n(Usa "ufw allow icmp" o "iptables -F" para eliminar la regla de bloqueo ICMP)'
      );
    } else {
      appendTerminalLog(
        vm,
        'normal',
        'Chain INPUT (policy ACCEPT)\ntarget     prot opt source               destination\n\nChain FORWARD (policy ACCEPT)\nChain OUTPUT (policy ACCEPT)'
      );
    }
    return;
  }

  // 7. Configuración manual de IP estática (`ip set eth0 10.10.10.1`)
  if (cmd === 'ip' && (parts[1] === 'set' || parts[1] === 'addr')) {
    if (vm.id === HOST_CONSOLE_ID) {
      appendTerminalLog(vm, 'warn', 'No puedes modificar las IPs fijas del Anfitrión. Cambia a una VM desde el selector superior.');
      return;
    }
    handleManualIpCommand(vm, parts);
    return;
  }

  // 8. Comando `ping [IP]`
  if (cmd === 'ping') {
    const targetArg = parts.slice(1).find((p) => !p.startsWith('-'));
    if (!targetArg) {
      appendTerminalLog(
        vm,
        'error',
        vm.os === 'Windows'
          ? 'Uso: ping dirección_IP (Ejemplo: ping 8.8.8.8 o ping 192.168.1.100)'
          : 'ping: usage error: Destination address required (Ejemplo: ping 8.8.8.8)'
      );
      return;
    }
    if (vm.id === HOST_CONSOLE_ID) {
      const targetVm = AppState.vms.find((v) =>
        v.state === 'Corriendo' && v.getEnabledAdapters().some((a) => a.ipInfo?.ip === targetArg)
      );
      if (targetVm) {
        runHostToVmPingSimulation(targetVm, vm);
      } else if (
        targetArg === '127.0.0.1' ||
        targetArg === 'localhost' ||
        targetArg === LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_LAN ||
        targetArg === LAB_INFRASTRUCTURE_IPS.HOST_ONLY_ADAPTER ||
        targetArg === LAB_INFRASTRUCTURE_IPS.INTERNET_DNS
      ) {
        appendTerminalLog(
          vm,
          'success',
          `PING ${targetArg} (${targetArg}) 56(84) bytes of data.\n64 bytes from ${targetArg}: icmp_seq=1 ttl=64 time=0.4 ms\n64 bytes from ${targetArg}: icmp_seq=2 ttl=64 time=0.3 ms\n--- ${targetArg} ping statistics: 0% packet loss ---`
        );
      } else {
        appendTerminalLog(
          vm,
          'error',
          `PING ${targetArg} (${targetArg}) 56(84) bytes of data.\nFrom ${LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_LAN} icmp_seq=1 Destination Host Unreachable\n--- ${targetArg} ping statistics: 100% packet loss ---`
        );
      }
      return;
    }
    runRealisticPingSimulation(vm, targetArg);
    return;
  }

  // 9. FASE 8: Comando `traceroute [IP]` (Linux) / `tracert [IP]` (Windows)
  if (cmd === 'traceroute' || cmd === 'tracert') {
    const targetArg = parts.slice(1).find((p) => !p.startsWith('-'));
    if (!targetArg) {
      appendTerminalLog(
        vm,
        'error',
        vm.os === 'Windows'
          ? 'Uso: tracert dirección_destino (Ejemplo: tracert 8.8.8.8)'
          : 'traceroute: Specify "host" missing argument (Ejemplo: traceroute 8.8.8.8)'
      );
      return;
    }
    runTracerouteSimulation(vm, targetArg, cmd);
    return;
  }

  // 10. Comando `host-ping` / `host-test`
  if (cmd === 'host-ping' || cmd === 'host-test') {
    const targetVm = vm.id === HOST_CONSOLE_ID ? getSelectedVM() : vm;
    if (targetVm) {
      runHostToVmPingSimulation(targetVm, vm);
    }
    return;
  }

  if (cmd === 'hostname') {
    appendTerminalLog(vm, 'normal', vm.id === HOST_CONSOLE_ID ? 'vbox-host' : vm.name);
    return;
  }

  if (cmd === 'whoami') {
    appendTerminalLog(
      vm,
      'normal',
      vm.id === HOST_CONSOLE_ID ? 'anfitrion' : vm.os === 'Windows' ? `${vm.name}\\Administrador` : 'root'
    );
    return;
  }

  if (cmd === 'route' || lowerTrimmed === 'ip r' || lowerTrimmed === 'ip route') {
    if (vm.id === HOST_CONSOLE_ID) {
      appendTerminalLog(
        vm,
        'normal',
        `default via ${LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_GW} dev eth0\n192.168.1.0/24 dev eth0 proto kernel scope link src ${LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_LAN}\n192.168.56.0/24 dev vboxnet0 proto kernel scope link src ${LAB_INFRASTRUCTURE_IPS.HOST_ONLY_ADAPTER}`
      );
      return;
    }
    printRoutingTable(vm);
    return;
  }

  // 11. Comandos educativos adicionales: `arp -a` / `ip neigh`, `netstat -tuln` / `ss -tuln`, `nslookup` / `dig`, `uname -a`
  if (cmd === 'arp' || lowerTrimmed === 'ip neigh' || lowerTrimmed === 'ip n') {
    printArpTableCommand(vm);
    return;
  }

  if (cmd === 'netstat' || cmd === 'ss') {
    printNetstatCommand(vm);
    return;
  }

  if (cmd === 'nslookup' || cmd === 'dig' || cmd === 'host') {
    const queryDomain = parts.slice(1).find((p) => !p.startsWith('-')) || 'oracle.com';
    printDnsLookupCommand(vm, queryDomain);
    return;
  }

  if (lowerTrimmed === 'cat /etc/resolv.conf') {
    appendTerminalLog(
      vm,
      'normal',
      `# Generated by VirtLab NetworkEngine\nnameserver ${LAB_INFRASTRUCTURE_IPS.INTERNET_DNS}\nsearch virtlab.local`
    );
    return;
  }

  if (cmd === 'uname' || cmd === 'systeminfo' || cmd === 'ver') {
    if (vm.os === 'Windows' && vm.id !== HOST_CONSOLE_ID) {
      appendTerminalLog(
        vm,
        'normal',
        `Nombre de host:                            ${vm.name}\nNombre del sistema operativo:              Microsoft ${vm.osVersion}\nFabricante del sistema:                    innotek GmbH\nModelo el sistema:                         VirtualBox\nCantidad total de memoria física:          ${vm.ram} MB`
      );
    } else {
      appendTerminalLog(
        vm,
        'normal',
        `Linux ${vm.id === HOST_CONSOLE_ID ? 'vbox-host' : vm.name} 6.8.0-45-generic #45-Ubuntu SMP PREEMPT_DYNAMIC x86_64 GNU/Linux`
      );
    }
    return;
  }

  appendTerminalLog(
    vm,
    'error',
    vm.os === 'Windows'
      ? `"${parts[0]}" no se reconoce como un comando interno o externo.\nEscribe "ipconfig /renew", "ipconfig", "ping [IP]", "tracert [IP]", "arp -a", "netstat -tuln", "curl localhost:8080" o "help".`
      : `${parts[0]}: command not found. Escribe "dhclient", "ip a", "ping [IP]", "traceroute [IP]", "ufw allow icmp", "arp -a", "netstat -tuln", "curl localhost:8080" o "help".`
  );
}

/**
 * ============================================================================
 * FASE 8: SIMULACIÓN DE `traceroute [IP]` / `tracert [IP]`
 * - Respeta el modo de red, el estado de DHCP y las averías físicas/firewall.
 * - Imprime los saltos lógicos con un `setTimeout` de 500ms por línea.
 * - Muestra tiempos en milisegundos aleatorios entre 1ms y 50ms.
 * ============================================================================
 */
function getRandomLatency1To50Ms() {
  return Math.floor(Math.random() * 50) + 1;
}

function runTracerouteSimulation(vm, rawTargetIp, invokedCmd = 'traceroute') {
  const evalTrace = NetworkEngine.evaluateTraceroute(vm, rawTargetIp, AppState.vms);
  const isWinStyle = vm.os === 'Windows' || String(invokedCmd).toLowerCase() === 'tracert';
  const targetIp = evalTrace.targetIp;

  if (evalTrace.errorCode === 'INVALID_HOST') {
    appendTerminalLog(vm, 'error', evalTrace.reason);
    return;
  }

  // Si la VM no tiene concesión DHCP activa todavía
  if (evalTrace.errorCode === 'NO_DHCP_LEASE') {
    const dhcpCmd = vm.os === 'Windows' ? 'ipconfig /renew' : 'dhclient';
    appendTerminalLog(
      vm,
      'error',
      isWinStyle
        ? `No se puede resolver el sistema de destino ${targetIp}: Network is unreachable (Ejecuta "${dhcpCmd}" primero).`
        : `traceroute to ${targetIp} (${targetIp}), 30 hops max, 60 byte packets\nconnect: Network is unreachable (Sin IP asignada — Ejecuta "${dhcpCmd}")`
    );
    appendTerminalRoutingBox(
      vm,
      true,
      `<i class="fa-solid fa-arrows-rotate"></i> <strong>Sin Concesión DHCP (Fase 6):</strong> ${escapeHTML(evalTrace.reason)}`
    );
    return;
  }

  // Si el cable virtual está desconectado
  if (evalTrace.errorCode === 'NETWORK_UNREACHABLE') {
    appendTerminalLog(
      vm,
      'error',
      isWinStyle
        ? `Imposible alcanzar el host de destino ${targetIp}. Error de transmisión (connect: Network is unreachable — Cable desconectado).`
        : `traceroute to ${targetIp} (${targetIp}), 30 hops max, 60 byte packets\nconnect: Network is unreachable`
    );
    appendTerminalRoutingBox(
      vm,
      true,
      `<i class="fa-solid fa-plug-circle-xmark"></i> <strong>Diagnóstico Traceroute:</strong> ${escapeHTML(evalTrace.reason)}`
    );
    return;
  }

  AppState.isPinging = true;
  document.getElementById('console-net-led')?.classList.add('net-transmitting');

  // Encabezado inicial de traceroute / tracert
  if (isWinStyle) {
    appendTerminalLog(
      vm,
      'normal',
      `\nTraza a la dirección ${targetIp} sobre un máximo de 30 saltos:`
    );
  } else {
    appendTerminalLog(
      vm,
      'normal',
      `traceroute to ${targetIp} (${targetIp}), 30 hops max, 60 byte packets`
    );
  }

  const hops = evalTrace.hops || [];
  const totalHops = hops.length;

  hops.forEach((hopItem, idx) => {
    const hopNum = hopItem.hop || idx + 1;
    const delayMs = (idx + 1) * 500; // 500ms por línea según especificación de Fase 8

    const timerId = setTimeout(() => {
      if (hopItem.timeout) {
        if (isWinStyle) {
          appendTerminalLog(
            vm,
            'error',
            `  ${hopNum}     *        *        *     Request timed out.`
          );
        } else {
          appendTerminalLog(
            vm,
            'error',
            ` ${hopNum}  * * * Request timed out`
          );
        }
      } else {
        const t1 = getRandomLatency1To50Ms();
        const t2 = getRandomLatency1To50Ms();
        const t3 = getRandomLatency1To50Ms();
        const descSuffix = hopItem.label ? ` (${hopItem.label})` : '';

        if (isWinStyle) {
          appendTerminalLog(
            vm,
            hopNum === totalHops && evalTrace.reachable ? 'success' : 'info',
            `  ${hopNum}    ${String(t1).padStart(2, ' ')} ms    ${String(t2).padStart(2, ' ')} ms    ${String(t3).padStart(2, ' ')} ms  ${hopItem.ip}${descSuffix}`
          );
        } else {
          appendTerminalLog(
            vm,
            hopNum === totalHops && evalTrace.reachable ? 'success' : 'info',
            ` ${hopNum}  ${hopItem.ip}${descSuffix}  ${t1} ms  ${t2} ms  ${t3} ms`
          );
        }
      }

      // Al imprimir el último salto, cerrar estado de transmisión y mostrar resumen pedagógico
      if (idx === totalHops - 1) {
        AppState.isPinging = false;
        document.getElementById('console-net-led')?.classList.remove('net-transmitting');

        if (isWinStyle && evalTrace.reachable) {
          appendTerminalLog(vm, 'normal', '\nTraza completa.');
        }

        appendTerminalRoutingBox(
          vm,
          !evalTrace.reachable,
          `<i class="fa-solid ${evalTrace.reachable ? 'fa-route' : 'fa-ban'}"></i> <strong>Diagnóstico Traceroute (${escapeHTML(evalTrace.adapterUsed || '')}):</strong> ${escapeHTML(evalTrace.reason)}`
        );
      }
    }, delayMs);

    AppState.activePingTimers.push(timerId);
  });
}

/**
 * ============================================================================
 * FASE 7: SIMULACIÓN DE `curl localhost:[Puerto_Anfitrión]` (PORT FORWARDING NAT)
 * ============================================================================
 */
function runCurlPortForwardingSimulation(consoleTarget, rawTargetUrl) {
  const res = NetworkEngine.evaluatePortForwardingCurl(rawTargetUrl, AppState.vms);

  if (res.ok) {
    saveToStorage();
    renderAll();

    const serverBanner = `HTTP/1.1 200 OK - Apache Server on ${res.vm.name}`;
    const fullHttpResponse = [
      serverBanner,
      `Date: ${new Date().toUTCString()}`,
      `Server: Apache/2.4.58 (${res.vm.osVersion}) VirtLab-NAT-Forwarder`,
      `X-Port-Forwarding-Rule: ${res.rule.name} (${res.rule.protocol} ${res.rule.hostIp || '0.0.0.0'}:${res.port} -> ${res.guestIp}:${res.guestPort})`,
      'Content-Type: text/html; charset=UTF-8',
      '',
      `<html><body><h1>It works! - Apache Server on ${res.vm.name} (${res.guestIp}:${res.guestPort})</h1></body></html>`
    ].join('\n');

    appendTerminalLog(consoleTarget, 'success', fullHttpResponse);
    appendTerminalRoutingBox(
      consoleTarget,
      false,
      `<i class="fa-solid fa-right-left"></i> <strong>Port Forwarding NAT Exitoso:</strong> ${escapeHTML(res.reason)}`
    );

    // Fase 9 (Modo CTF): Notificar validación exitosa de Port Forwarding NAT con curl
    notifyConsoleCommandListeners({
      type: 'curl_result',
      action: 'curl_completed',
      success: true,
      consoleTarget,
      vm: res.vm,
      port: res.port,
      guestIp: res.guestIp,
      guestPort: res.guestPort,
      rule: res.rule
    });
  } else {
    appendTerminalLog(
      consoleTarget,
      'error',
      `curl: (7) Failed to connect to ${res.hostTarget} port ${res.port}: Connection refused`
    );
    appendTerminalRoutingBox(
      consoleTarget,
      true,
      `<i class="fa-solid fa-ban"></i> <strong>Diagnóstico Port Forwarding (NAT):</strong> ${escapeHTML(res.reason)}`
    );
  }
}

/**
 * ============================================================================
 * FASE 6: SIMULACIÓN INTERACTIVA DEL PROCESO DHCP DORA EN TERMINAL
 * - Comandos soportados: `dhclient` (Linux) / `ipconfig /renew` (Windows)
 * - Imprime con retrasos simulados (setTimeout) el proceso DORA:
 *     1. DHCPDISCOVER sent to 255.255.255.255...
 *     2. DHCPOFFER received from [IP_del_Servidor_DHCP_Simulado]...
 *     3. DHCPREQUEST sent...
 *     4. DHCPACK received. IP Address assigned: [IP_Asignada].
 * - Si la avería "Cable desconectado" está activa, el DHCPDISCOVER falla con timeout.
 * ============================================================================
 */
function runDhcpClientSimulation(vm, rawCmd = '') {
  const enabledAdapters = vm.getEnabledAdapters();

  if (enabledAdapters.length === 0) {
    appendTerminalLog(
      vm,
      'error',
      'DHCP Error: No hay ningún adaptador de red habilitado en esta máquina virtual (Configuración > Red).'
    );
    return;
  }

  // Permitir especificar interfaz opcional (ej. dhclient eth1), por defecto el primer adaptador habilitado
  const matchIf = String(rawCmd).match(/eth(\d)/i);
  let targetAdapter = enabledAdapters[0];
  if (matchIf) {
    const requestedSlot = Number(matchIf[1]) + 1;
    const found = enabledAdapters.find((a) => a.slot === requestedSlot);
    if (found) targetAdapter = found;
  }

  const adapterIdx = vm.adapters.findIndex((a) => a.slot === targetAdapter.slot);
  const ifName = `eth${targetAdapter.slot - 1}`;

  AppState.isPinging = true;
  document.getElementById('console-net-led')?.classList.add('net-transmitting');

  // Paso 1 (D - DISCOVER): Broadcast a 255.255.255.255
  const t1 = setTimeout(() => {
    appendTerminalLog(vm, 'info', 'DHCPDISCOVER sent to 255.255.255.255...');
  }, 180);
  AppState.activePingTimers.push(t1);

  // Si la avería "Cable desconectado" (Fase 4) está activa, el DHCPDISCOVER falla con un timeout
  if (!targetAdapter.cableConnected) {
    const tTimeout1 = setTimeout(() => {
      appendTerminalLog(vm, 'warn', 'DHCPDISCOVER sent to 255.255.255.255... (retrying)');
    }, 950);

    const tTimeoutFail = setTimeout(() => {
      AppState.isPinging = false;
      document.getElementById('console-net-led')?.classList.remove('net-transmitting');

      appendTerminalLog(
        vm,
        'error',
        `DHCPDISCOVER timeout: No DHCPOFFERS received on ${ifName} (Connection timed out — El cable de red virtual está desconectado).`
      );
      appendTerminalRoutingBox(
        vm,
        true,
        `<i class="fa-solid fa-plug-circle-xmark"></i> <strong>Fallo en DHCP (DORA):</strong> El paquete broadcast <code>DHCPDISCOVER</code> hacia <code>255.255.255.255</code> ha expirado por <strong>timeout</strong> porque la interfaz <code>${ifName}</code> tiene el <strong>cable desconectado</strong>.`
      );
    }, 1850);

    AppState.activePingTimers.push(tTimeout1, tTimeoutFail);
    return;
  }

  const offerDetails = NetworkEngine.getDhcpOfferDetails(
    vm,
    targetAdapter,
    adapterIdx >= 0 ? adapterIdx : 0,
    AppState.vms
  );

  // Caso especial: Red interna sin servidor DHCP (y sin IP estática manual)
  if (!offerDetails.hasDhcpServer) {
    const tNoDhcp = setTimeout(() => {
      AppState.isPinging = false;
      document.getElementById('console-net-led')?.classList.remove('net-transmitting');

      targetAdapter.dhcpLeased = true;
      NetworkEngine.assignIPsForVM(vm, AppState.vms);
      saveToStorage();
      renderAll();

      appendTerminalLog(
        vm,
        'warn',
        `No DHCPOFFERS received on '${targetAdapter.intnetName}'. Fallback APIPA Address assigned: ${offerDetails.offeredIp} (169.254.0.0/16).`
      );
      appendTerminalRoutingBox(
        vm,
        false,
        `<i class="fa-solid fa-network-wired"></i> <strong>Red Interna '${escapeHTML(targetAdapter.intnetName)}':</strong> No existe servidor DHCP en este switch virtual aislado. Se ha asignado dirección APIPA <code>${escapeHTML(offerDetails.offeredIp)}</code> (o usa <code>ip set ${ifName} 10.10.10.X</code> para IP estática).`
      );
    }, 1350);

    AppState.activePingTimers.push(tNoDhcp);
    return;
  }

  // Paso 2 (O - OFFER): Respuesta del servidor DHCP simulado (10.0.2.2 en NAT, 192.168.56.100 en Host-Only, 192.168.1.1 en Puente)
  const t2 = setTimeout(() => {
    appendTerminalLog(
      vm,
      'info',
      `DHCPOFFER received from ${offerDetails.dhcpServerIp}...`
    );
  }, 780);

  // Paso 3 (R - REQUEST): El cliente solicita formalmente la IP ofrecida
  const t3 = setTimeout(() => {
    appendTerminalLog(vm, 'info', 'DHCPREQUEST sent...');
  }, 1380);

  // Paso 4 (A - ACK): Confirmación final y asignación de la IP en la interfaz
  const t4 = setTimeout(() => {
    AppState.isPinging = false;
    document.getElementById('console-net-led')?.classList.remove('net-transmitting');

    // Marcar concesión DHCP como activa en los adaptadores habilitados con cable conectado
    enabledAdapters.forEach((ad) => {
      if (ad.cableConnected) {
        ad.dhcpLeased = true;
      }
    });

    NetworkEngine.assignIPsForVM(vm, AppState.vms);
    saveToStorage();
    renderAll();

    const assignedIp = targetAdapter.ipInfo?.ip || offerDetails.offeredIp;
    appendTerminalLog(
      vm,
      'success',
      `DHCPACK received. IP Address assigned: ${assignedIp}.`
    );

    appendTerminalRoutingBox(
      vm,
      false,
      `<i class="fa-solid fa-circle-check"></i> <strong>Proceso DHCP (DORA) Completado en ${escapeHTML(ifName)} (${escapeHTML(targetAdapter.mode)}):</strong> Servidor DHCP <code>${escapeHTML(offerDetails.dhcpServerIp)}</code> concesionó la IP <code>${escapeHTML(assignedIp)}</code>.`
    );

    // Fase 9 (Modo CTF): Notificar concesión DHCP DORA exitosa
    notifyConsoleCommandListeners({
      type: 'dhcp_result',
      action: 'dhcp_completed',
      success: true,
      vm,
      assignedIp,
      adapter: targetAdapter
    });
  }, 1980);

  AppState.activePingTimers.push(t2, t3, t4);
}

/**
 * Imprime la salida realista de `ip a` (Linux) o `ipconfig` (Windows)
 */
function printIpConfiguration(vm) {
  const enabledAdapters = vm.getEnabledAdapters();

  if (vm.os === 'Windows') {
    const lines = ['Configuración IP de Windows', ''];
    if (enabledAdapters.length === 0) {
      lines.push('No hay adaptadores de red Ethernet habilitados en esta máquina virtual.');
    } else {
      enabledAdapters.forEach((ad) => {
        const info = ad.ipInfo;
        const modeDesc =
          ad.mode === 'Red interna' ? `${ad.mode} ('${ad.intnetName}')` : ad.mode;
        lines.push(`Adaptador de Ethernet Ethernet ${ad.slot} [${modeDesc}]:`);
        if (!ad.cableConnected) {
          lines.push('   Estado de los medios. . . . . . . . . . . : medios desconectados (Cable desconectado)');
          lines.push(`   Dirección física (MAC). . . . . . . . . . : ${formatMacColon(ad.mac).replace(/:/g, '-')}`);
        } else if (info?.isPendingDhcp) {
          lines.push('   Sufijo DNS específico para la conexión. . : virtlab.local');
          lines.push(`   Dirección física (MAC). . . . . . . . . . : ${formatMacColon(ad.mac).replace(/:/g, '-')}`);
          lines.push('   DHCP habilitado . . . . . . . . . . . . . : sí');
          lines.push('   Dirección IPv4. . . . . . . . . . . . . . : Sin asignar (Ejecuta "ipconfig /renew" para iniciar DORA)');
          lines.push('   Máscara de subred . . . . . . . . . . . . : 0.0.0.0');
          lines.push('   Puerta de enlace predeterminada . . . . . :');
        } else {
          lines.push('   Sufijo DNS específico para la conexión. . : virtlab.local');
          lines.push(`   Dirección física (MAC). . . . . . . . . . : ${formatMacColon(ad.mac).replace(/:/g, '-')}`);
          if (ad.forcedConflictIp) {
            lines.push(`   Dirección IPv4 (CONFLICTO DUPLICADO). . . : ${info?.ip} (Duplicada en LAN)`);
          } else if (ad.mode === 'Red interna' && !ad.manualStaticIp) {
            lines.push(`   Dirección IPv4 de autoconfiguración . . . : ${info?.ip || '169.254.0.1'} (Sin DHCP en '${ad.intnetName}')`);
          } else {
            lines.push(`   Dirección IPv4. . . . . . . . . . . . . . : ${info?.ip || 'Sin IP'}`);
          }
          lines.push(`   Máscara de subred . . . . . . . . . . . . : ${info?.netmask || '255.255.255.0'}`);
          lines.push(`   Puerta de enlace predeterminada . . . . . : ${info?.gateway === 'Sin puerta de enlace' ? '' : info?.gateway || ''}`);
        }
        lines.push('');
      });
    }
    appendTerminalLog(vm, 'normal', lines.join('\n'));
    return;
  }

  // Formato Linux (`ip a`)
  const lines = [
    '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000',
    '    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00',
    '    inet 127.0.0.1/8 scope host lo',
    '       valid_lft forever preferred_lft forever'
  ];

  enabledAdapters.forEach((ad, idx) => {
    const ifIndex = idx + 2;
    const ifName = `eth${ad.slot - 1}`;
    const macColon = formatMacColon(ad.mac).toLowerCase();
    const stateFlags = ad.cableConnected ? '<BROADCAST,MULTICAST,UP,LOWER_UP>' : '<NO-CARRIER,BROADCAST,MULTICAST,UP>';
    const operState = ad.cableConnected ? 'UP' : 'DOWN';
    const modeDesc =
      ad.mode === 'Red interna' ? `${ad.mode} '${ad.intnetName}'` : ad.mode;

    lines.push(
      `${ifIndex}: ${ifName}: ${stateFlags} mtu 1500 qdisc fq_codel state ${operState} group default qlen 1000`
    );
    lines.push(`    link/ether ${macColon} brd ff:ff:ff:ff:ff:ff  # [VirtualBox: ${modeDesc}]`);
    if (ad.cableConnected && ad.ipInfo) {
      if (ad.ipInfo.isPendingDhcp) {
        lines.push(`    # [Sin IP asignada — Ejecuta "dhclient" para solicitar IP por DHCP (proceso DORA)]`);
      } else {
        const scopeNote = ad.forcedConflictIp
          ? `scope global tentative dadfailed ${ifName} (IP/MAC CONFLICT)`
          : ad.mode === 'Red interna' && !ad.manualStaticIp
            ? 'scope link noprefixroute (APIPA - Sin DHCP)'
            : ad.manualStaticIp
              ? `scope global ${ifName} (Estática)`
              : `scope global dynamic ${ifName}`;
        lines.push(`    inet ${ad.ipInfo.cidr || `${ad.ipInfo.ip}/24`} brd 255.255.255.255 ${scopeNote}`);
        lines.push(`       gateway ${ad.ipInfo.gateway}`);
      }
    }
  });

  if (enabledAdapters.length === 0) {
    lines.push('# (Ningún adaptador de red habilitado en Configuración > Red)');
  }

  appendTerminalLog(vm, 'normal', lines.join('\n'));
}

function handleManualIpCommand(vm, parts) {
  let ifName = '';
  let newIp = '';

  if (parts[1] === 'set') {
    ifName = (parts[2] || '').toLowerCase();
    newIp = (parts[3] || '').split('/')[0];
  } else if (parts[1] === 'addr' && parts[2] === 'add') {
    newIp = (parts[3] || '').split('/')[0];
    const devIdx = parts.indexOf('dev');
    ifName = devIdx !== -1 && parts[devIdx + 1] ? parts[devIdx + 1].toLowerCase() : 'eth0';
  }

  const matchSlot = ifName.match(/^eth(\d)$/);
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!matchSlot || !ipv4Regex.test(newIp)) {
    appendTerminalLog(
      vm,
      'warn',
      'Uso para asignar IP estática: ip set eth0 10.10.10.1  (o: ip addr add 10.10.10.1/24 dev eth0)'
    );
    return;
  }

  const slotIndex = Number(matchSlot[1]);
  const adapter = vm.adapters[slotIndex];
  if (!adapter || !adapter.enabled) {
    appendTerminalLog(vm, 'error', `Error: La interfaz ${ifName} (Adaptador ${slotIndex + 1}) no está habilitada.`);
    return;
  }

  adapter.manualStaticIp = newIp;
  adapter.forcedConflictIp = null;
  adapter.dhcpLeased = true;
  NetworkEngine.assignIPsForVM(vm, AppState.vms);

  saveToStorage();
  renderAll();
  appendTerminalLog(
    vm,
    'success',
    `[OK] Interfaz ${ifName} (Adaptador ${adapter.slot} - ${adapter.mode}) configurada con IP estática ${newIp}/24.`
  );
}

/**
 * Ejecuta la simulación realista de `ping [IP]` contemplando:
 *  - Fallo 1 (Cable desconectado): Lanza inmediatamente "Network is unreachable".
 *  - Fallo 2 (Regla DROP en Firewall/iptables): Lanza "Request timed out" en los 4 paquetes.
 *  - Fallo 3 (MAC Duplicada / IP Conflict): Genera caídas aleatorias y paquetes DUP! en el ping.
 */
function runRealisticPingSimulation(vm, targetIp) {
  const evalResult = NetworkEngine.evaluatePing(vm, targetIp, AppState.vms);
  const isWin = vm.os === 'Windows';

  if (evalResult.errorCode === 'INVALID_HOST') {
    appendTerminalLog(vm, 'error', evalResult.reason);
    return;
  }

  // FASE 6: Si la VM aún no tiene concesión DHCP activa -> avisar que ejecute dhclient / ipconfig /renew
  if (evalResult.errorCode === 'NO_DHCP_LEASE') {
    const dhcpCmd = isWin ? 'ipconfig /renew' : 'dhclient';
    if (isWin) {
      appendTerminalLog(
        vm,
        'error',
        `PING: error en la transmisión. Error general.\nconnect: Network is unreachable (La interfaz no tiene dirección IPv4 asignada. Ejecuta "${dhcpCmd}").`
      );
    } else {
      appendTerminalLog(
        vm,
        'error',
        `ping: connect: Network is unreachable (Sin dirección IP asignada — Ejecuta "${dhcpCmd}")`
      );
    }
    appendTerminalRoutingBox(
      vm,
      true,
      `<i class="fa-solid fa-arrows-rotate"></i> <strong>Sin Concesión DHCP (Fase 6):</strong> ${escapeHTML(evalResult.reason)}`
    );
    return;
  }

  // FALLO 1: Si el cable está desconectado -> "Network is unreachable" inmediato
  if (evalResult.errorCode === 'NETWORK_UNREACHABLE') {
    if (isWin) {
      appendTerminalLog(
        vm,
        'error',
        `PING: error en la transmisión. Error general.\nconnect: Network is unreachable (El cable de red virtual está desconectado).`
      );
    } else {
      appendTerminalLog(vm, 'error', `ping: connect: Network is unreachable`);
    }
    appendTerminalRoutingBox(
      vm,
      true,
      `<i class="fa-solid fa-plug-circle-xmark"></i> <strong>Diagnóstico de Fallo:</strong> ${escapeHTML(evalResult.reason)}`
    );
    return;
  }

  AppState.isPinging = true;
  document.getElementById('console-net-led')?.classList.add('net-transmitting');

  const totalPackets = 4;

  if (isWin) {
    appendTerminalLog(vm, 'normal', `\nHaciendo ping a ${targetIp} con 32 bytes de datos:`);
  } else {
    appendTerminalLog(vm, 'normal', `PING ${targetIp} (${targetIp}) 56(84) bytes of data.`);
  }

  const rtts = [];
  let receivedCount = 0;
  let dupCount = 0;

  for (let seq = 1; seq <= totalPackets; seq++) {
    const timerId = setTimeout(() => {
      // Caso A: Enlace alcanzable pero con CONFLICTO DE IP / MAC DUPLICADA (Fallo 3)
      if (evalResult.reachable && evalResult.hasPacketLossConflict) {
        // Aseguramos que siempre haya mezcla de caídas y respuestas erráticas/DUP!
        const dropThisPacket = seq === 2 || (seq === 4 && Math.random() < 0.7) || (seq !== 1 && Math.random() < 0.45);
        if (dropThisPacket) {
          if (isWin) {
            appendTerminalLog(vm, 'error', 'Tiempo de espera agotado para esta solicitud. (Colisión ARP/IP)');
          } else {
            appendTerminalLog(vm, 'error', `Request timeout for icmp_seq ${seq} (ARP/MAC collision on ${targetIp})`);
          }
        } else {
          receivedCount++;
          const erraticRtt = Number((evalResult.baseLatencyMs + Math.random() * 48 + 4).toFixed(1));
          rtts.push(erraticRtt);
          const isDup = seq === 1 || Math.random() < 0.5;
          if (isDup) dupCount++;

          if (isWin) {
            appendTerminalLog(
              vm,
              'warn',
              `Respuesta desde ${targetIp}: bytes=32 tiempo=${Math.round(erraticRtt)}ms TTL=${evalResult.ttl}${isDup ? ' (Conflicto MAC/IP detectado)' : ''}`
            );
          } else {
            appendTerminalLog(
              vm,
              'warn',
              `64 bytes from ${targetIp}: icmp_seq=${seq} ttl=${evalResult.ttl} time=${erraticRtt} ms${isDup ? ' (DUP!)' : ''}`
            );
          }
        }
      } else if (evalResult.reachable) {
        // Caso B: Ping exitoso normal
        receivedCount++;
        const jitter = Math.random() * 0.8 - 0.4;
        const rtt = Math.max(0.2, Number((evalResult.baseLatencyMs + jitter).toFixed(1)));
        rtts.push(rtt);

        if (isWin) {
          appendTerminalLog(
            vm,
            'success',
            `Respuesta desde ${targetIp}: bytes=32 tiempo=${Math.max(1, Math.round(rtt))}ms TTL=${evalResult.ttl}`
          );
        } else {
          appendTerminalLog(
            vm,
            'success',
            `64 bytes from ${targetIp}: icmp_seq=${seq} ttl=${evalResult.ttl} time=${rtt} ms`
          );
        }
      } else {
        // Caso C: Ping bloqueado (por Firewall DROP -> Request timed out, o por aislamiento de subred -> Destination Host Unreachable)
        const isTimeout =
          evalResult.errorCode === 'FIREWALL_TIMEOUT' || evalResult.errorCode === 'TIMEOUT';

        if (isWin) {
          appendTerminalLog(
            vm,
            'error',
            isTimeout
              ? 'Request timed out. (Tiempo de espera agotado para esta solicitud).'
              : `Respuesta desde ${evalResult.sourceIp}: Host de destino inaccesible.`
          );
        } else {
          appendTerminalLog(
            vm,
            'error',
            isTimeout
              ? `Request timed out (icmp_seq=${seq})`
              : `From ${evalResult.sourceIp} icmp_seq=${seq} Destination Host Unreachable`
          );
        }
      }

      // Al finalizar el 4º paquete, mostrar estadísticas finales
      if (seq === totalPackets) {
        AppState.isPinging = false;
        document.getElementById('console-net-led')?.classList.remove('net-transmitting');

        const lostCount = totalPackets - receivedCount;
        const lossPercent = Math.round((lostCount / totalPackets) * 100);

        if (receivedCount > 0) {
          const min = Math.min(...rtts).toFixed(2);
          const max = Math.max(...rtts).toFixed(2);
          const avg = (rtts.reduce((a, b) => a + b, 0) / rtts.length).toFixed(2);
          const dupText = dupCount > 0 ? `, +${dupCount} duplicates` : '';

          if (isWin) {
            appendTerminalLog(
              vm,
              'normal',
              `\nEstadísticas de ping para ${targetIp}:\n    Paquetes: enviados = 4, recibidos = ${receivedCount}, perdidos = ${lostCount} (${lossPercent}% perdidos),\nTiempos aproximados de ida y vuelta en milisegundos:\n    Mínimo = ${Math.round(Number(min))}ms, Máximo = ${Math.round(Number(max))}ms, Media = ${Math.round(Number(avg))}ms`
            );
          } else {
            appendTerminalLog(
              vm,
              'normal',
              `\n--- ${targetIp} ping statistics ---\n4 packets transmitted, ${receivedCount} received${dupText}, ${lossPercent}% packet loss, time 1208ms\nrtt min/avg/max/mdev = ${min}/${avg}/${max}/1.420 ms`
            );
          }

          appendTerminalRoutingBox(
            vm,
            Boolean(evalResult.hasPacketLossConflict),
            `<i class="fa-solid ${evalResult.hasPacketLossConflict ? 'fa-triangle-exclamation' : 'fa-circle-check'}"></i> <strong>Diagnóstico (${escapeHTML(evalResult.adapterUsed || '')}):</strong> ${escapeHTML(evalResult.reason)}`
          );

          // FASE 9 (Modo CTF): Notificar al validador silencioso que un ping ha resultado exitoso
          notifyConsoleCommandListeners({
            type: 'ping_result',
            action: 'ping_completed',
            success: true,
            vm,
            targetIp,
            receivedCount,
            hasConflict: Boolean(evalResult.hasPacketLossConflict)
          });
        } else {
          if (isWin) {
            appendTerminalLog(
              vm,
              'normal',
              `\nEstadísticas de ping para ${targetIp}:\n    Paquetes: enviados = 4, recibidos = 0, perdidos = 4 (100% perdidos).`
            );
          } else {
            appendTerminalLog(
              vm,
              'normal',
              `\n--- ${targetIp} ping statistics ---\n4 packets transmitted, 0 received, 100% packet loss, time 3015ms`
            );
          }

          appendTerminalRoutingBox(
            vm,
            true,
            `<i class="fa-solid fa-ban"></i> <strong>Diagnóstico de Fallo / Enrutamiento:</strong> ${escapeHTML(evalResult.reason)}`
          );

          notifyConsoleCommandListeners({
            type: 'ping_result',
            action: 'ping_completed',
            success: false,
            vm,
            targetIp,
            receivedCount: 0
          });
        }
      }
    }, seq * 320);

    AppState.activePingTimers.push(timerId);
  }
}

function runHostToVmPingSimulation(vm, logReceiver = vm) {
  const res = NetworkEngine.evaluateHostToVmPing(vm);
  appendTerminalLog(
    logReceiver,
    'info',
    `[Simulación desde Anfitrión Host (${res.hostSourceIp}) -> ejecutando: ping ${res.targetIp}]`
  );
  if (res.reachable) {
    appendTerminalLog(
      logReceiver,
      'success',
      `64 bytes from ${res.targetIp}: icmp_seq=1 ttl=64 time=1.2 ms\n64 bytes from ${res.targetIp}: icmp_seq=2 ttl=64 time=1.1 ms\n--- ${res.targetIp} ping statistics: 0% packet loss ---`
    );
    appendTerminalRoutingBox(logReceiver, false, `<i class="fa-solid fa-circle-check"></i> ${escapeHTML(res.reason)}`);
  } else {
    const errMsg =
      res.errorCode === 'FIREWALL_TIMEOUT'
        ? `Request timed out (Firewall DROP en ${vm.name})`
        : res.errorCode === 'NETWORK_UNREACHABLE'
          ? 'connect: Network is unreachable (Cable desconectado)'
          : `From ${res.hostSourceIp} icmp_seq=1 Destination Host Unreachable`;
    appendTerminalLog(
      logReceiver,
      'error',
      `${errMsg}\n--- ${res.targetIp} ping statistics: 100% packet loss ---`
    );
    appendTerminalRoutingBox(logReceiver, true, `<i class="fa-solid fa-shield-halved"></i> ${escapeHTML(res.reason)}`);
  }
}

function printRoutingTable(vm) {
  const enabled = vm.getEnabledAdapters();
  const lines = ['Tabla de rutas activas en esta máquina virtual:'];
  enabled.forEach((ad) => {
    const ifName = `eth${ad.slot - 1}`;
    if (!ad.cableConnected) {
      lines.push(`  # ${ifName}: link down (Network is unreachable)`);
      return;
    }
    if (ad.ipInfo?.isPendingDhcp) {
      lines.push(
        `  # ${ifName}: sin concesión IP activa (Ejecuta "${vm.os === 'Windows' ? 'ipconfig /renew' : 'dhclient'}")`
      );
      return;
    }
    if (ad.mode === 'NAT' || ad.mode === 'Adaptador Puente') {
      lines.push(`  default via ${ad.ipInfo?.gateway} dev ${ifName} (${ad.mode})`);
    }
    lines.push(`  ${ad.ipInfo?.cidr || ad.ipInfo?.ip} dev ${ifName} proto kernel scope link src ${ad.ipInfo?.ip}`);
  });
  appendTerminalLog(vm, 'normal', lines.join('\n'));
}

function printArpTableCommand(vm) {
  if (vm.id === HOST_CONSOLE_ID) {
    const lines = [
      `? (${LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_GW}) at 00:1a:2b:3c:4d:01 [ether] on eth0`,
      `? (${LAB_INFRASTRUCTURE_IPS.HOST_ONLY_DHCP}) at 0a:00:27:00:00:00 [ether] on vboxnet0`
    ];
    AppState.vms.forEach((guest) => {
      if (guest.state !== 'Corriendo') return;
      guest.getEnabledAdapters().forEach((ad) => {
        if (!ad.cableConnected || !ad.ipInfo?.hasIp) return;
        if (ad.mode === 'Adaptador Puente' || ad.mode === 'Adaptador sólo-anfitrión') {
          const dev = ad.mode === 'Adaptador Puente' ? 'eth0' : 'vboxnet0';
          lines.push(`? (${ad.ipInfo.ip}) at ${formatMacColon(ad.mac).toLowerCase()} [ether] on ${dev}  # ${guest.name}`);
        }
      });
    });
    appendTerminalLog(vm, 'normal', lines.join('\n'));
    return;
  }

  const enabled = vm.getEnabledAdapters().filter((a) => a.cableConnected && a.ipInfo?.hasIp);
  if (enabled.length === 0) {
    appendTerminalLog(vm, 'warn', 'arp: No hay entradas ARP en caché (interfaz sin IP o cable desconectado).');
    return;
  }

  const lines = [];
  enabled.forEach((ad) => {
    const ifName = `eth${ad.slot - 1}`;
    if (ad.mode === 'NAT') {
      lines.push(`? (${ad.ipInfo.gateway}) at 52:54:00:12:35:02 [ether] on ${ifName}  # Gateway NAT VirtualBox`);
    } else if (ad.mode === 'Adaptador Puente') {
      lines.push(`? (${LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_GW}) at 00:1a:2b:3c:4d:01 [ether] on ${ifName}  # Gateway físico`);
      lines.push(`? (${LAB_INFRASTRUCTURE_IPS.HOST_PHYSICAL_LAN}) at 00:e0:4c:68:01:00 [ether] on ${ifName}  # Anfitrión LAN`);
      AppState.vms.forEach((other) => {
        if (other.id === vm.id || other.state !== 'Corriendo') return;
        other.getEnabledAdapters().forEach((oAd) => {
          if (oAd.cableConnected && oAd.mode === 'Adaptador Puente' && oAd.ipInfo?.hasIp) {
            const conflictWarn = oAd.forcedConflictIp ? ' [ALERTA: COLISIÓN ARP/MAC DUPLICADA]' : '';
            lines.push(`? (${oAd.ipInfo.ip}) at ${formatMacColon(oAd.mac).toLowerCase()} [ether] on ${ifName}  # ${other.name}${conflictWarn}`);
          }
        });
      });
    } else if (ad.mode === 'Adaptador sólo-anfitrión') {
      lines.push(`? (${LAB_INFRASTRUCTURE_IPS.HOST_ONLY_ADAPTER}) at 0a:00:27:00:00:01 [ether] on ${ifName}  # Anfitrión vboxnet0`);
      lines.push(`? (${LAB_INFRASTRUCTURE_IPS.HOST_ONLY_DHCP}) at 0a:00:27:00:00:64 [ether] on ${ifName}  # Servidor DHCP Host-Only`);
    } else if (ad.mode === 'Red interna') {
      AppState.vms.forEach((other) => {
        if (other.id === vm.id || other.state !== 'Corriendo') return;
        other.getEnabledAdapters().forEach((oAd) => {
          if (oAd.cableConnected && oAd.mode === 'Red interna' && oAd.intnetName === ad.intnetName && oAd.ipInfo?.hasIp) {
            lines.push(`? (${oAd.ipInfo.ip}) at ${formatMacColon(oAd.mac).toLowerCase()} [ether] on ${ifName}  # ${other.name} ('${ad.intnetName}')`);
          }
        });
      });
    }
  });

  appendTerminalLog(
    vm,
    lines.some((l) => l.includes('ALERTA')) ? 'warn' : 'normal',
    lines.length > 0 ? lines.join('\n') : 'arp: Sin vecinos ARP detectados en el segmento actual.'
  );
}

function printNetstatCommand(vm) {
  if (vm.id === HOST_CONSOLE_ID) {
    const pfLines = [];
    AppState.vms.forEach((guest) => {
      guest.getEnabledAdapters().forEach((ad) => {
        if (ad.mode === 'NAT' && Array.isArray(ad.portForwardingRules)) {
          ad.portForwardingRules.forEach((r) => {
            pfLines.push(
              `${r.protocol.toLowerCase()}   0   0 ${(r.hostIp || '0.0.0.0')}:${r.hostPort}   0.0.0.0:*   LISTEN   VBoxHeadless (${guest.name} -> ${r.guestIp}:${r.guestPort})`
            );
          });
        }
      });
    });
    appendTerminalLog(
      vm,
      'normal',
      [
        'Active Internet connections (only servers) — Anfitrión Host',
        'Proto Recv-Q Send-Q Local Address           Foreign Address         State       Program',
        ...(pfLines.length > 0
          ? pfLines
          : ['(Ninguna regla de Reenvío de Puertos NAT activa en escucha en el Anfitrión)'])
      ].join('\n')
    );
    return;
  }

  appendTerminalLog(
    vm,
    'normal',
    [
      `Active Internet connections (only servers) — ${vm.name}`,
      'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
      'tcp        0      0 0.0.0.0:80              0.0.0.0:*               LISTEN      842/apache2 (HTTP Server)',
      'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      614/sshd'
    ].join('\n')
  );
}

function printDnsLookupCommand(vm, domain) {
  const pingCheck =
    vm.id === HOST_CONSOLE_ID
      ? { reachable: true }
      : NetworkEngine.evaluatePing(vm, LAB_INFRASTRUCTURE_IPS.INTERNET_DNS, AppState.vms);

  if (pingCheck.reachable) {
    appendTerminalLog(
      vm,
      'normal',
      [
        `Server:\t\t${LAB_INFRASTRUCTURE_IPS.INTERNET_DNS}`,
        `Address:\t${LAB_INFRASTRUCTURE_IPS.INTERNET_DNS}#53`,
        '',
        'Non-authoritative answer:',
        `Name:\t${domain}`,
        'Address: 93.184.216.34'
      ].join('\n')
    );
  } else {
    appendTerminalLog(
      vm,
      'error',
      `;; connection timed out; no servers could be reached (Sin ruta hacia el servidor DNS ${LAB_INFRASTRUCTURE_IPS.INTERNET_DNS})`
    );
  }
}

function printHelpCommand(vm) {
  const helpText = [
    'Comandos disponibles en la consola de VirtLab (Fases 3 a 9):',
    '  traceroute [IP] / tracert [IP] (Fase 8) Traza los saltos lógicos (500ms/salto) según el modo de red (ej. traceroute 8.8.8.8).',
    '  curl localhost:[Puerto]      (Fase 7) Prueba el Reenvío de Puertos NAT desde el Anfitrión (ej. curl localhost:8080).',
    '  dhclient                     (Linux) Inicia el proceso DHCP DORA (DISCOVER -> OFFER -> REQUEST -> ACK).',
    '  ipconfig /renew              (Windows) Solicita/renueva la concesión IPv4 mediante el proceso DORA.',
    '  ip a / ipconfig              Muestra las interfaces de red, estado del cable y la IP asignada.',
    '  ping [IP]                    Envía 4 paquetes ICMP aplicando las reglas de enrutamiento y fallos.',
    '                               Ejemplos: ping 8.8.8.8 | ping 192.168.1.100 | ping 192.168.56.1',
    '  ufw allow icmp / iptables -F (Fase 9 CTF) Permite el tráfico ICMP o limpia las reglas DROP del firewall local.',
    '  ufw status / iptables -L     Muestra las reglas activas del firewall local (detecta reglas DROP).',
    '  arp -a / ip neigh            Muestra la tabla ARP (IP <-> MAC) y detecta colisiones en Adaptador Puente.',
    '  netstat -tuln / ss -tuln     Muestra los puertos en escucha (ej. 0.0.0.0:80 Apache Server).',
    '  nslookup [dominio]           Realiza una consulta DNS contra 8.8.8.8 según la conectividad actual.',
    '  ip set eth0 [IP]             Asigna una IP estática manual a un adaptador (útil en Red interna).',
    '  host-test                    Simula un ping desde el Anfitrión hacia esta VM.',
    '  ip route / route             Muestra la tabla de enrutamiento de la máquina virtual.',
    '  clear / cls                  Limpia la pantalla de la terminal.'
  ].join('\n');
  appendTerminalLog(vm, 'info', helpText);
}

/**
 * ============================================================================
 * FASE 9: MOTOR DE RETOS Y FLAGS (MODO CTF) — VALIDADOR SILENCIOSO
 * - Listener en el procesador de comandos de la consola:
 *     `registerConsoleCommandListener(fn)` / `notifyConsoleCommandListeners(ctx)`
 * - Función extensible `checkCTFWinCondition(eventContext)`:
 *     Evalúa un catálogo modular de retos (`CTF_CHALLENGES`) y puede ampliarse
 *     mediante `registerCTFChallenge(challengeDefinition)`.
 * - Reto oculto principal:
 *     Si el laboratorio cargó por URL (`?escenario=`) un escenario donde la VM
 *     tenía la avería "Firewall bloqueando ICMP", y el alumno usa un comando
 *     simulado como `ufw allow icmp` (o `iptables -F` / `ufw disable`) o apaga
 *     el firewall desde la UI, y luego logra hacer un `ping` exitoso a `8.8.8.8`,
 *     inyecta en verde brillante:
 *     `[+] RETO COMPLETADO. Flag: flag{v1rtu4l_n3tw0rk_m4st3r}`
 * ============================================================================
 */
const CTF_CHALLENGES = [
  {
    id: 'ctf-firewall-icmp-master',
    title: 'Reto 1: Troubleshooting de Firewall ICMP y Salida a Internet',
    description:
      'Carga un escenario por URL donde la VM tiene la avería "Firewall bloqueando ICMP". Desbloquea el firewall usando <code>ufw allow icmp</code> (o <code>iptables -F</code> o desde la UI) y logra un <code>ping 8.8.8.8</code> exitoso.',
    flag: 'flag{v1rtu4l_n3tw0rk_m4st3r}',
    enabled: true,
    evaluate(eventContext, ctfState) {
      if (eventContext.action !== 'ping_completed' || !eventContext.success) {
        return false;
      }
      if (eventContext.targetIp !== '8.8.8.8') {
        return false;
      }
      const vm = eventContext.vm;
      if (!vm || vm.id === HOST_CONSOLE_ID) {
        return false;
      }

      // Debe provenir de un escenario cargado por URL donde la VM tenía la avería "Firewall bloqueando ICMP"
      const hadUrlFirewallFault =
        ctfState.scenarioLoadedFromUrl && ctfState.initialFirewallFaultVmIds.has(vm.id);
      if (!hadUrlFirewallFault) {
        return false;
      }

      // Y el alumno debe haber desbloqueado el firewall (por comando como `ufw allow icmp` o desde la UI)
      const firewallCleared =
        !vm.firewallDropIcmp && ctfState.firewallRemediatedVmIds.has(vm.id);

      return firewallCleared;
    }
  },
  {
    id: 'ctf-nat-port-forwarding-curl',
    title: 'Reto 2: Mapeo de Puertos NAT (Port Forwarding) validado con curl',
    description:
      'Con una VM en modo <code>NAT</code>, abre <strong>Configuración &rarr; Red &rarr; Avanzado &rarr; Reenvío de puertos</strong>, añade una regla TCP del puerto anfitrión <code>8080</code> al puerto invitado <code>80</code> (<code>10.0.2.15</code>) y valídala ejecutando <code>curl localhost:8080</code>.',
    flag: 'flag{n4t_p0rt_f0rw4rd_m4st3r}',
    enabled: true,
    evaluate(eventContext, ctfState) {
      if (eventContext.action !== 'curl_completed' || !eventContext.success) {
        return false;
      }
      const vm = eventContext.vm;
      if (!vm) return false;
      const hadNoPfInitially =
        ctfState.scenarioLoadedFromUrl && ctfState.initialPortForwardingEmptyVmIds.has(vm.id);
      return Boolean(hadNoPfInitially && eventContext.rule);
    }
  },
  {
    id: 'ctf-internal-network-static',
    title: 'Reto 3: Comunicación en Switch Aislado (Red Interna intnet)',
    description:
      'Configura dos máquinas virtuales en modo <code>Red interna</code> (mismo nombre <code>intnet</code>), asígnales direcciones IP estáticas en la misma subred (ej. <code>ip set eth0 10.10.10.1</code> y <code>ip set eth0 10.10.10.2</code>) y completa un <code>ping</code> exitoso entre ambas.',
    flag: 'flag{1nt3rn4l_sw1tch_1s0l4t3d}',
    enabled: true,
    evaluate(eventContext) {
      if (eventContext.action !== 'ping_completed' || !eventContext.success) {
        return false;
      }
      const sourceVm = eventContext.vm;
      if (!sourceVm || sourceVm.id === HOST_CONSOLE_ID) return false;
      const peerVm = AppState.vms.find(
        (v) =>
          v.id !== sourceVm.id &&
          v.state === 'Corriendo' &&
          v.getEnabledAdapters().some(
            (a) =>
              a.mode === 'Red interna' &&
              a.manualStaticIp &&
              a.ipInfo?.ip === eventContext.targetIp
          )
      );
      return Boolean(peerVm);
    }
  },
  {
    id: 'ctf-cable-dhcp-dora',
    title: 'Reto 4: Diagnóstico de Capa Física y Concesión DHCP DORA',
    description:
      'Carga un escenario donde el cable virtual está desconectado (<code>NO-CARRIER</code>), reconéctalo desde Configuración o Modo Dios y completa la negociación DORA ejecutando <code>dhclient</code> o <code>ipconfig /renew</code>.',
    flag: 'flag{dhcP_d0r4_h4ndsh4k3_ok}',
    enabled: true,
    evaluate(eventContext, ctfState) {
      if (eventContext.action !== 'dhcp_completed' || !eventContext.success) {
        return false;
      }
      const vm = eventContext.vm;
      if (!vm) return false;
      return Boolean(ctfState.scenarioLoadedFromUrl && ctfState.initialCableDownVmIds.has(vm.id));
    }
  }
];

export function registerConsoleCommandListener(listenerFn) {
  if (typeof listenerFn === 'function') {
    AppState.ctfState.commandListeners.push(listenerFn);
  }
}

function notifyConsoleCommandListeners(eventContext = {}) {
  AppState.ctfState.commandListeners.forEach((listenerFn) => {
    try {
      listenerFn(eventContext, AppState.ctfState);
    } catch (err) {
      console.warn('Error en listener de consola CTF:', err);
    }
  });
}

export function registerCTFChallenge(challengeDef) {
  if (!challengeDef || !challengeDef.id || typeof challengeDef.evaluate !== 'function') {
    return false;
  }
  const existingIdx = CTF_CHALLENGES.findIndex((c) => c.id === challengeDef.id);
  const normalized = {
    enabled: true,
    ...challengeDef
  };
  if (existingIdx >= 0) {
    CTF_CHALLENGES[existingIdx] = normalized;
  } else {
    CTF_CHALLENGES.push(normalized);
  }
  return true;
}

export function checkCTFWinCondition(eventContext = {}) {
  const ctfState = AppState.ctfState;
  const completedChallenges = [];

  CTF_CHALLENGES.forEach((challenge) => {
    if (!challenge.enabled) return;
    if (ctfState.unlockedFlags.has(challenge.id)) return;

    const isSolved = Boolean(challenge.evaluate(eventContext, ctfState));
    if (isSolved) {
      ctfState.unlockedFlags.add(challenge.id);
      completedChallenges.push(challenge);

      const targetConsole =
        eventContext.consoleTarget || eventContext.vm || getConsoleVM();
      const flagMessage = `[+] RETO COMPLETADO. Flag: ${challenge.flag}`;

      if (targetConsole) {
        appendTerminalLog(targetConsole, 'ctf-flag', flagMessage);
      }
      setStatusMessage(flagMessage);
      renderCtfBadgeCount();
    }
  });

  return completedChallenges;
}

function renderCtfBadgeCount() {
  const badge = document.getElementById('toolbar-ctf-badge');
  const pill = document.getElementById('ctf-modal-score-pill');
  const total = CTF_CHALLENGES.filter((c) => c.enabled).length;
  const solved = AppState.ctfState.unlockedFlags.size;

  if (badge) {
    badge.textContent = `${solved}/${total}`;
    badge.classList.toggle('all-cleared', solved > 0 && solved >= total);
  }
  if (pill) {
    pill.textContent = `${solved} / ${total} Flags`;
  }
}

/**
 * ============================================================================
 * MODAL DE CONFIGURACIÓN Y SUB-PESTAÑAS DE LOS 4 ADAPTADORES DE RED
 * ============================================================================
 */
function populateOSVersionSelect(selectEl, osType, selectedVersion) {
  if (!selectEl) return;
  const list = OS_VERSIONS[osType] || OS_VERSIONS.Linux;
  selectEl.innerHTML = list
    .map((ver) => `<option value="${ver}" ${ver === selectedVersion ? 'selected' : ''}>${ver}</option>`)
    .join('');
}

function openSettingsModal(initialTab = 'network', initialAdapterIdx = 0) {
  const vm = getSelectedVM();
  if (!vm) return;

  const modal = document.getElementById('modal-settings-vm');
  const titleEl = document.getElementById('settings-vm-title');
  const runningBanner = document.getElementById('settings-running-banner');
  const errEl = document.getElementById('settings-vm-error');

  if (!modal) return;

  if (titleEl) titleEl.textContent = `${vm.name} — Configuración`;
  if (errEl) errEl.textContent = '';

  const isRunning = vm.state === 'Corriendo';
  if (runningBanner) {
    runningBanner.classList.toggle('hidden', !isRunning);
  }

  const nameInput = document.getElementById('set-vm-name');
  const osSelect = document.getElementById('set-vm-os');
  const verSelect = document.getElementById('set-vm-version');
  const ramInput = document.getElementById('set-vm-ram');
  const cpuInput = document.getElementById('set-vm-cpu');
  const vramSelect = document.getElementById('set-vm-vram');
  const threeDSelect = document.getElementById('set-vm-3d');
  const isoSelect = document.getElementById('set-vm-iso');
  const diskInput = document.getElementById('set-vm-disk');

  if (nameInput) {
    nameInput.value = vm.name;
    nameInput.disabled = isRunning;
  }
  if (osSelect) {
    osSelect.value = vm.os;
    osSelect.disabled = isRunning;
  }
  populateOSVersionSelect(verSelect, vm.os, vm.osVersion);
  if (verSelect) verSelect.disabled = isRunning;

  if (ramInput) {
    ramInput.value = String(vm.ram);
    ramInput.disabled = isRunning;
  }
  if (cpuInput) {
    cpuInput.value = String(vm.cpu);
    cpuInput.disabled = isRunning;
  }
  if (vramSelect) {
    vramSelect.value = String(vm.vram);
    vramSelect.disabled = isRunning;
  }
  if (threeDSelect) {
    threeDSelect.value = vm.threeDAccel;
    threeDSelect.disabled = isRunning;
  }
  if (isoSelect) isoSelect.value = vm.isoMounted;
  if (diskInput) {
    diskInput.value = String(vm.diskSize);
    diskInput.disabled = isRunning;
  }

  AppState.draftAdapters = vm.adapters.map((ad) => ({
    slot: ad.slot,
    enabled: Boolean(ad.enabled),
    mode: ad.mode,
    intnetName: ad.intnetName || 'intnet',
    mac: ad.mac || generateVBoxMAC(),
    cableConnected: ad.cableConnected !== false,
    manualStaticIp: ad.manualStaticIp || null,
    forcedConflictIp: ad.forcedConflictIp || null,
    dhcpLeased: Boolean(ad.dhcpLeased),
    portForwardingRules: normalizePortForwardingRules(ad.portForwardingRules)
  }));

  AppState.activeAdapterTabIndex = initialAdapterIdx;
  switchSettingsTab(initialTab);
  renderAdapterSubTab(AppState.activeAdapterTabIndex);

  modal.classList.remove('hidden');
}

function closeSettingsModal() {
  document.getElementById('modal-settings-vm')?.classList.add('hidden');
}

function switchSettingsTab(tabName) {
  document.querySelectorAll('.settings-cat-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
  });
  document.querySelectorAll('.settings-tab-pane').forEach((pane) => {
    const match = pane.getAttribute('data-pane') === tabName;
    pane.classList.toggle('active', match);
    pane.classList.toggle('hidden', !match);
  });
}

function syncCurrentAdapterFormToDraft() {
  const idx = AppState.activeAdapterTabIndex;
  const draft = AppState.draftAdapters[idx];
  if (!draft) return;

  const enabledChk = document.getElementById('net-adapter-enabled');
  const modeSel = document.getElementById('net-adapter-mode');
  const intnetInput = document.getElementById('net-adapter-intnet-name');
  const macInput = document.getElementById('net-adapter-mac');
  const cableChk = document.getElementById('net-adapter-cable');

  if (enabledChk) draft.enabled = enabledChk.checked;
  if (modeSel) {
    if (draft.mode !== modeSel.value) {
      draft.manualStaticIp = null;
      draft.forcedConflictIp = null;
      draft.dhcpLeased = false;
    }
    draft.mode = modeSel.value;
  }
  if (intnetInput) draft.intnetName = intnetInput.value.trim() || 'intnet';
  if (macInput) draft.mac = macInput.value.trim() || draft.mac;
  if (cableChk) draft.cableConnected = cableChk.checked;
}

function renderAdapterSubTab(adapterIdx) {
  AppState.activeAdapterTabIndex = adapterIdx;
  const draft = AppState.draftAdapters[adapterIdx];
  if (!draft) return;

  document.querySelectorAll('.vbox-subtab-btn').forEach((btn) => {
    const idx = Number(btn.getAttribute('data-adapter-tab'));
    const isCurrent = idx === adapterIdx;
    const isEnabled = AppState.draftAdapters[idx]?.enabled;
    btn.classList.toggle('active', isCurrent);
    btn.classList.toggle('has-enabled-dot', Boolean(isEnabled));
    btn.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
  });

  const enabledChk = document.getElementById('net-adapter-enabled');
  const slotBadge = document.getElementById('net-adapter-slot-badge');
  const fieldsContainer = document.getElementById('net-adapter-fields-container');
  const modeSel = document.getElementById('net-adapter-mode');
  const intnetRow = document.getElementById('net-intnet-row');
  const intnetInput = document.getElementById('net-adapter-intnet-name');
  const macInput = document.getElementById('net-adapter-mac');
  const cableChk = document.getElementById('net-adapter-cable');
  const pfRow = document.getElementById('net-port-forwarding-row');
  const pfBtn = document.getElementById('btn-open-port-forwarding');
  const pfBadge = document.getElementById('net-pf-count-badge');
  const explainerEl = document.getElementById('net-mode-explainer');

  if (enabledChk) enabledChk.checked = draft.enabled;
  if (slotBadge) slotBadge.textContent = `eth${adapterIdx} / Adaptador ${adapterIdx + 1}`;
  if (modeSel) modeSel.value = draft.mode;
  if (intnetInput) intnetInput.value = draft.intnetName || 'intnet';
  if (macInput) macInput.value = draft.mac;
  if (cableChk) cableChk.checked = draft.cableConnected;

  if (fieldsContainer) {
    fieldsContainer.classList.toggle('is-disabled', !draft.enabled);
  }
  if (modeSel) modeSel.disabled = !draft.enabled;
  if (intnetInput) intnetInput.disabled = !draft.enabled;
  if (cableChk) cableChk.disabled = !draft.enabled;

  if (intnetRow) {
    intnetRow.classList.toggle('hidden', draft.mode !== 'Red interna');
  }

  // FASE 7: Mostrar botón "Reenvío de puertos" exclusivamente cuando el adaptador está en modo NAT
  const isNat = draft.mode === 'NAT';
  if (pfRow) {
    pfRow.classList.toggle('hidden', !isNat);
  }
  if (pfBtn) {
    pfBtn.disabled = !draft.enabled || !isNat;
  }
  const rulesCount = Array.isArray(draft.portForwardingRules) ? draft.portForwardingRules.length : 0;
  if (pfBadge) {
    pfBadge.textContent = `${rulesCount} ${rulesCount === 1 ? 'regla' : 'reglas'}`;
    pfBadge.classList.toggle('has-rules', rulesCount > 0);
  }

  if (explainerEl) {
    explainerEl.innerHTML = NetworkEngine.getModeExplanation(
      draft.mode,
      draft.intnetName,
      draft.portForwardingRules
    );
  }
}

/**
 * ============================================================================
 * SUB-MODAL FASE 7: REGLAS DE REENVÍO DE PUERTOS (PORT FORWARDING EN NAT)
 * ============================================================================
 */
function openPortForwardingModal() {
  syncCurrentAdapterFormToDraft();
  const draft = AppState.draftAdapters[AppState.activeAdapterTabIndex];
  if (!draft || draft.mode !== 'NAT') return;

  const vm = getSelectedVM();
  const titleEl = document.getElementById('pf-modal-title');
  const errEl = document.getElementById('pf-validation-error');

  if (titleEl) {
    titleEl.textContent = `Reglas de reenvío de puertos — ${vm ? vm.name : 'VM'} (Adaptador ${draft.slot}: NAT)`;
  }
  if (errEl) errEl.textContent = '';

  AppState.draftPortForwardingRules = normalizePortForwardingRules(draft.portForwardingRules).map(
    (r) => ({ ...r })
  );

  renderPortForwardingTable();
  document.getElementById('modal-port-forwarding')?.classList.remove('hidden');
}

function closePortForwardingModal() {
  document.getElementById('modal-port-forwarding')?.classList.add('hidden');
}

function syncPortForwardingTableInputsToDraft() {
  const tbody = document.getElementById('pf-rules-tbody');
  if (!tbody) return;

  const rows = tbody.querySelectorAll('tr[data-pf-index]');
  rows.forEach((tr) => {
    const idx = Number(tr.getAttribute('data-pf-index'));
    const rule = AppState.draftPortForwardingRules[idx];
    if (!rule) return;

    const nameEl = tr.querySelector('[data-pf-field="name"]');
    const protoEl = tr.querySelector('[data-pf-field="protocol"]');
    const hostIpEl = tr.querySelector('[data-pf-field="hostIp"]');
    const hostPortEl = tr.querySelector('[data-pf-field="hostPort"]');
    const guestIpEl = tr.querySelector('[data-pf-field="guestIp"]');
    const guestPortEl = tr.querySelector('[data-pf-field="guestPort"]');

    if (nameEl) rule.name = nameEl.value.trim() || `Regla ${idx + 1}`;
    if (protoEl) rule.protocol = protoEl.value === 'UDP' ? 'UDP' : 'TCP';
    if (hostIpEl) rule.hostIp = hostIpEl.value.trim();
    if (hostPortEl) rule.hostPort = Number(hostPortEl.value) || 0;
    if (guestIpEl) rule.guestIp = guestIpEl.value.trim();
    if (guestPortEl) rule.guestPort = Number(guestPortEl.value) || 0;
  });
}

function renderPortForwardingTable() {
  const tbody = document.getElementById('pf-rules-tbody');
  if (!tbody) return;

  const rules = AppState.draftPortForwardingRules;
  if (!rules || rules.length === 0) {
    tbody.innerHTML = `
      <tr class="pf-empty-row">
        <td colspan="7">
          No hay reglas de reenvío de puertos configuradas. Haz clic en <strong>"Añadir regla"</strong> o <strong>"Ejemplo 8080&rarr;80"</strong> a la derecha.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = rules
    .map(
      (rule, idx) => `
        <tr data-pf-index="${idx}">
          <td>
            <input
              type="text"
              class="pf-cell-input"
              data-pf-field="name"
              value="${escapeHTML(rule.name)}"
              placeholder="Regla ${idx + 1}"
            />
          </td>
          <td>
            <select class="pf-cell-select" data-pf-field="protocol">
              <option value="TCP" ${rule.protocol === 'TCP' ? 'selected' : ''}>TCP</option>
              <option value="UDP" ${rule.protocol === 'UDP' ? 'selected' : ''}>UDP</option>
            </select>
          </td>
          <td>
            <input
              type="text"
              class="pf-cell-input mono"
              data-pf-field="hostIp"
              value="${escapeHTML(rule.hostIp || '')}"
              placeholder="127.0.1.1 o vacía"
            />
          </td>
          <td>
            <input
              type="number"
              class="pf-cell-input mono"
              data-pf-field="hostPort"
              min="1"
              max="65535"
              value="${Number(rule.hostPort) || 8080}"
              placeholder="8080"
            />
          </td>
          <td>
            <input
              type="text"
              class="pf-cell-input mono"
              data-pf-field="guestIp"
              value="${escapeHTML(rule.guestIp ?? '10.0.2.15')}"
              placeholder="10.0.2.15"
            />
          </td>
          <td>
            <input
              type="number"
              class="pf-cell-input mono"
              data-pf-field="guestPort"
              min="1"
              max="65535"
              value="${Number(rule.guestPort) || 80}"
              placeholder="80"
            />
          </td>
          <td style="text-align: center;">
            <button
              type="button"
              class="pf-delete-row-btn"
              data-pf-delete="${idx}"
              title="Eliminar esta regla"
            >
              <i class="fa-solid fa-xmark"></i>
            </button>
          </td>
        </tr>
      `
    )
    .join('');

  tbody.querySelectorAll('[data-pf-delete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      syncPortForwardingTableInputsToDraft();
      const delIdx = Number(btn.getAttribute('data-pf-delete'));
      AppState.draftPortForwardingRules.splice(delIdx, 1);
      renderPortForwardingTable();
    });
  });
}

function addPortForwardingRule(useHttpPreset = false) {
  syncPortForwardingTableInputsToDraft();
  const nextNum = AppState.draftPortForwardingRules.length + 1;
  const adapterIdx = AppState.activeAdapterTabIndex;
  const defaultGuestIp = adapterIdx === 0 ? '10.0.2.15' : `10.0.${adapterIdx + 2}.15`;

  if (useHttpPreset) {
    AppState.draftPortForwardingRules.push({
      id: `pf-${Date.now()}-${nextNum}`,
      name: nextNum === 1 ? 'HTTP-Apache' : `HTTP-${nextNum}`,
      protocol: 'TCP',
      hostIp: '127.0.1.1',
      hostPort: 8080,
      guestIp: defaultGuestIp,
      guestPort: 80
    });
  } else {
    AppState.draftPortForwardingRules.push({
      id: `pf-${Date.now()}-${nextNum}`,
      name: `Regla ${nextNum}`,
      protocol: 'TCP',
      hostIp: '',
      hostPort: 8080,
      guestIp: defaultGuestIp,
      guestPort: 80
    });
  }

  renderPortForwardingTable();
}

function savePortForwardingModal() {
  syncPortForwardingTableInputsToDraft();
  const errEl = document.getElementById('pf-validation-error');

  for (const r of AppState.draftPortForwardingRules) {
    if (!r.hostPort || r.hostPort < 1 || r.hostPort > 65535 || !r.guestPort || r.guestPort < 1 || r.guestPort > 65535) {
      if (errEl) {
        errEl.textContent = `Los puertos Anfitrión e Invitado en "${r.name}" deben estar entre 1 y 65535.`;
      }
      return;
    }
  }

  const draft = AppState.draftAdapters[AppState.activeAdapterTabIndex];
  if (draft) {
    draft.portForwardingRules = normalizePortForwardingRules(AppState.draftPortForwardingRules);
  }

  closePortForwardingModal();
  renderAdapterSubTab(AppState.activeAdapterTabIndex);
}

/**
 * ============================================================================
 * MODAL "NUEVA MÁQUINA VIRTUAL" Y "DESCARTAR"
 * ============================================================================
 */
function openNewVMModal() {
  const modal = document.getElementById('modal-new-vm');
  const nameInput = document.getElementById('input-vm-name');
  const osSelect = document.getElementById('select-vm-os');
  const verSelect = document.getElementById('select-vm-version');
  const ramRange = document.getElementById('range-vm-ram');
  const ramNumber = document.getElementById('number-vm-ram');
  const cpuRange = document.getElementById('range-vm-cpu');
  const cpuNumber = document.getElementById('number-vm-cpu');
  const diskInput = document.getElementById('input-vm-disk');
  const errEl = document.getElementById('new-vm-error');

  if (!modal) return;

  if (nameInput) nameInput.value = '';
  if (osSelect) osSelect.value = 'Linux';
  populateOSVersionSelect(verSelect, 'Linux');
  updateWizardOSPreview('Linux');

  if (ramRange) ramRange.value = '2048';
  if (ramNumber) ramNumber.value = '2048';
  if (cpuRange) cpuRange.value = '2';
  if (cpuNumber) cpuNumber.value = '2';
  if (diskInput) diskInput.value = '25';
  if (errEl) errEl.textContent = '';

  updateRamHintText(2048);
  modal.classList.remove('hidden');
  nameInput?.focus();
}

function closeNewVMModal() {
  document.getElementById('modal-new-vm')?.classList.add('hidden');
}

function updateWizardOSPreview(osType) {
  const previewBox = document.getElementById('wizard-os-icon-preview');
  if (previewBox) {
    previewBox.innerHTML = getOSIconSVG(osType, 44);
  }
}

function updateRamHintText(ramVal) {
  const hint = document.getElementById('ram-warning-msg');
  if (!hint) return;
  if (ramVal > 12288) {
    hint.textContent = 'Atención: Supera el 75% de la RAM del Host';
    hint.style.color = '#b42318';
  } else if (ramVal > 8192) {
    hint.textContent = 'Carga elevada para el Host';
    hint.style.color = '#b56c00';
  } else {
    hint.textContent = `Zona segura (${ramVal} MB)`;
    hint.style.color = '#1f5c2e';
  }
}

function openDiscardModal() {
  const vm = getSelectedVM();
  if (!vm) return;

  const modal = document.getElementById('modal-discard-vm');
  const textEl = document.getElementById('discard-confirm-text');
  if (textEl) {
    textEl.innerHTML = `¿Estás seguro de que deseas eliminar la máquina virtual <strong>"${escapeHTML(vm.name)}"</strong> (${vm.osVersion})?`;
  }
  modal?.classList.remove('hidden');
}

function closeDiscardModal() {
  document.getElementById('modal-discard-vm')?.classList.add('hidden');
}

function confirmDiscardVM() {
  const vm = getSelectedVM();
  if (!vm) return;

  const removedName = vm.name;
  AppState.vms = AppState.vms.filter((item) => item.id !== vm.id);
  AppState.selectedVmId = AppState.vms[0]?.id || null;
  AppState.instructorTargetVmId = AppState.selectedVmId;

  saveToStorage();
  closeDiscardModal();
  renderAll();
  setStatusMessage(`La máquina virtual "${removedName}" fue eliminada del inventario.`);
}

/**
 * ============================================================================
 * UTILIDADES E INICIALIZACIÓN DE EVENTOS DOM
 * ============================================================================
 */
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setStatusMessage(msg) {
  setText('statusbar-message', msg);
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function closeAllMenus() {
  document.querySelectorAll('.menu-dropdown').forEach((d) => d.classList.add('hidden'));
  document.querySelectorAll('.menu-trigger').forEach((t) => t.classList.remove('active'));
}

function initEvents() {
  // 1. Botones principales de la Top Toolbar
  document.getElementById('btn-new')?.addEventListener('click', openNewVMModal);
  document.getElementById('btn-empty-create')?.addEventListener('click', openNewVMModal);
  document.getElementById('btn-settings')?.addEventListener('click', () => openSettingsModal('network', 0));
  document.getElementById('btn-discard')?.addEventListener('click', openDiscardModal);
  document.getElementById('btn-start')?.addEventListener('click', handleStartOrOpenConsole);
  document.getElementById('btn-poweroff')?.addEventListener('click', handlePowerOffSelectedVM);
  document.getElementById('btn-host-console')?.addEventListener('click', openHostConsoleModal);
  document.getElementById('menu-host-console')?.addEventListener('click', openHostConsoleModal);

  document.getElementById('preview-monitor-clickable')?.addEventListener('click', handleStartOrOpenConsole);
  document.getElementById('btn-preview-power')?.addEventListener('click', handleStartOrOpenConsole);
  document.getElementById('btn-preview-settings')?.addEventListener('click', () => openSettingsModal('network', 0));

  // 2. Eventos del Panel de Troubleshooting / Opciones del Instructor (Fase 4)
  document.getElementById('btn-instructor-toggle')?.addEventListener('click', () => toggleInstructorDrawer());
  document.getElementById('btn-close-instructor')?.addEventListener('click', () => toggleInstructorDrawer(false));
  document.getElementById('menu-instructor-open')?.addEventListener('click', () => toggleInstructorDrawer(true));
  document.getElementById('btn-console-open-instructor')?.addEventListener('click', () => toggleInstructorDrawer(true));

  const instructorTargetSelect = document.getElementById('instructor-target-vm');
  instructorTargetSelect?.addEventListener('change', () => {
    AppState.instructorTargetVmId = instructorTargetSelect.value;
    renderInstructorPanel();
  });

  const examBlindChk = document.getElementById('chk-exam-blind-mode');
  examBlindChk?.addEventListener('change', () => {
    AppState.examBlindMode = examBlindChk.checked;
    renderAll();
  });

  document.getElementById('btn-fault-toggle-cable')?.addEventListener('click', handleToggleCableFault);
  document.getElementById('btn-fault-toggle-firewall')?.addEventListener('click', handleToggleFirewallFault);
  document.getElementById('btn-fault-toggle-conflict')?.addEventListener('click', handleToggleIpConflictFault);
  document.getElementById('btn-restore-lab-state')?.addEventListener('click', handleRestoreLabFaults);
  document.getElementById('menu-clear-faults')?.addEventListener('click', handleRestoreLabFaults);

  // Eventos Fase 5 y Fase 9: Botones "Generar Enlace de Práctica" y "Cargar Escenario Reto CTF"
  document.getElementById('btn-share-scenario')?.addEventListener('click', exportarEscenario);
  document.getElementById('menu-share-scenario')?.addEventListener('click', exportarEscenario);
  document.getElementById('btn-instructor-share-scenario')?.addEventListener('click', exportarEscenario);
  document.getElementById('btn-load-ctf-firewall-scenario')?.addEventListener('click', handleLoadCtfFirewallScenario);

  const copyScenarioUrlAction = () => {
    const input =
      document.getElementById('input-scenario-url') ||
      document.getElementById('scenario-modal-url-input');
    const urlToCopy = input?.value || window.location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(urlToCopy).catch(() => {});
    }
    const feedbackEl = document.getElementById('scenario-copy-feedback');
    feedbackEl?.classList.remove('hidden');
    setStatusMessage('Enlace de práctica (?escenario=...) copiado al portapapeles.');
  };

  document.getElementById('btn-copy-scenario-url')?.addEventListener('click', copyScenarioUrlAction);
  document.getElementById('btn-modal-copy-scenario')?.addEventListener('click', copyScenarioUrlAction);
  document.getElementById('btn-close-scenario-alert')?.addEventListener('click', closeScenarioDialog);
  document.getElementById('btn-ok-scenario-alert')?.addEventListener('click', closeScenarioDialog);

  // 3. Eventos de la Ventana de Consola Interactiva (Fase 3 y Fase 7 Consola del Anfitrión)
  document.getElementById('btn-minimize-console')?.addEventListener('click', closeVMConsoleModal);
  document.getElementById('btn-close-console')?.addEventListener('click', closeVMConsoleModal);
  document.getElementById('btn-maximize-console')?.addEventListener('click', () => {
    document.getElementById('vm-console-window-box')?.classList.toggle('maximized');
  });

  document.getElementById('btn-console-open-net')?.addEventListener('click', () => {
    const vm = getConsoleVM();
    const targetVm = vm && vm.id !== HOST_CONSOLE_ID ? vm : getSelectedVM();
    if (targetVm) {
      AppState.selectedVmId = targetVm.id;
      openSettingsModal('network', 0);
    }
  });

  document.getElementById('btn-console-switch-host')?.addEventListener('click', () => {
    clearActivePingTimers();
    if (AppState.consoleVmId === HOST_CONSOLE_ID) {
      const targetVm = getSelectedVM() || AppState.vms[0];
      if (targetVm) {
        openVMConsoleModal(targetVm.id);
      }
    } else {
      openHostConsoleModal();
    }
  });

  document.getElementById('btn-console-acpi-off')?.addEventListener('click', () => {
    const vm = getConsoleVM();
    if (vm && vm.id !== HOST_CONSOLE_ID) {
      AppState.selectedVmId = vm.id;
      handlePowerOffSelectedVM();
    }
  });

  const consoleSwitcher = document.getElementById('console-running-switcher');
  consoleSwitcher?.addEventListener('change', () => {
    const nextId = consoleSwitcher.value;
    clearActivePingTimers();
    if (nextId === HOST_CONSOLE_ID) {
      openHostConsoleModal();
      return;
    }
    const nextVm = AppState.vms.find((v) => v.id === nextId);
    if (!nextVm) return;
    if (nextVm.state !== 'Corriendo') {
      nextVm.start(AppState.vms);
      saveToStorage();
    }
    AppState.consoleVmId = nextVm.id;
    AppState.selectedVmId = nextVm.id;
    AppState.instructorTargetVmId = nextVm.id;
    AppState.historyCursor = nextVm.commandHistory.length;
    renderAll();
    focusTerminalInput();
  });

  document.getElementById('vm-terminal-viewport')?.addEventListener('click', () => {
    focusTerminalInput();
  });

  const termForm = document.getElementById('vm-terminal-form');
  const termInput = document.getElementById('vm-terminal-input');

  termForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!termInput) return;
    const cmdLine = termInput.value;
    termInput.value = '';
    executeTerminalCommand(cmdLine);
  });

  termInput?.addEventListener('keydown', (e) => {
    const vm = getConsoleVM();
    if (!vm || !vm.commandHistory.length) return;

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      AppState.historyCursor = Math.max(0, AppState.historyCursor - 1);
      termInput.value = vm.commandHistory[AppState.historyCursor] || '';
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      AppState.historyCursor = Math.min(vm.commandHistory.length, AppState.historyCursor + 1);
      termInput.value = vm.commandHistory[AppState.historyCursor] || '';
    }
  });

  document.querySelectorAll('.quick-cmd-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const vm = getConsoleVM();
      if (!vm) return;
      const rawCmd = btn.getAttribute('data-cmd');
      if (rawCmd === 'dhcp') {
        executeTerminalCommand(vm.os === 'Windows' ? 'ipconfig /renew' : 'dhclient');
      } else if (rawCmd === 'ip') {
        executeTerminalCommand(vm.os === 'Windows' ? 'ipconfig' : 'ip a');
      } else if (rawCmd === 'trace') {
        executeTerminalCommand(vm.os === 'Windows' ? 'tracert 8.8.8.8' : 'traceroute 8.8.8.8');
      } else if (rawCmd) {
        executeTerminalCommand(rawCmd);
      }
      focusTerminalInput();
    });
  });

  // 4. Filtro de búsqueda de VMs en el panel izquierdo
  const filterInput = document.getElementById('vm-filter-input');
  filterInput?.addEventListener('input', (e) => {
    AppState.filterText = e.target.value || '';
    renderVMList();
  });

  // 5. Secciones colapsables del Panel de Detalles
  document.querySelectorAll('.detail-group-header').forEach((header) => {
    header.addEventListener('click', () => {
      const group = header.closest('.detail-group');
      if (!group) return;
      const isCollapsed = group.classList.toggle('collapsed');
      header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    });
  });

  document.querySelectorAll('[data-open-settings]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const targetTab = link.getAttribute('data-open-settings') || 'network';
      openSettingsModal(targetTab, 0);
    });
  });

  // 6. Sincronización del Asistente "Nueva Máquina Virtual"
  const nameInput = document.getElementById('input-vm-name');
  const osSelect = document.getElementById('select-vm-os');
  const verSelect = document.getElementById('select-vm-version');

  nameInput?.addEventListener('input', () => {
    const val = nameInput.value.toLowerCase();
    if (val.includes('win')) {
      osSelect.value = 'Windows';
      const ver = val.includes('11')
        ? 'Windows 11 (64-bit)'
        : val.includes('server')
          ? 'Windows Server 2022 (64-bit)'
          : 'Windows 10 (64-bit)';
      populateOSVersionSelect(verSelect, 'Windows', ver);
      updateWizardOSPreview('Windows');
    } else if (
      val.includes('ubuntu') ||
      val.includes('debian') ||
      val.includes('linux') ||
      val.includes('arch') ||
      val.includes('mint')
    ) {
      osSelect.value = 'Linux';
      const ver = val.includes('debian')
        ? 'Debian (64-bit)'
        : val.includes('arch')
          ? 'Arch Linux (64-bit)'
          : val.includes('mint')
            ? 'Linux Mint (64-bit)'
            : 'Ubuntu (64-bit)';
      populateOSVersionSelect(verSelect, 'Linux', ver);
      updateWizardOSPreview('Linux');
    }
  });

  osSelect?.addEventListener('change', () => {
    const os = osSelect.value;
    populateOSVersionSelect(verSelect, os);
    updateWizardOSPreview(os);
  });

  const ramRange = document.getElementById('range-vm-ram');
  const ramNumber = document.getElementById('number-vm-ram');
  ramRange?.addEventListener('input', () => {
    ramNumber.value = ramRange.value;
    updateRamHintText(Number(ramRange.value));
  });
  ramNumber?.addEventListener('input', () => {
    const clamped = Math.max(512, Math.min(HOST_TOTAL_RAM_MB, Number(ramNumber.value) || 512));
    ramRange.value = String(clamped);
    updateRamHintText(clamped);
  });

  const cpuRange = document.getElementById('range-vm-cpu');
  const cpuNumber = document.getElementById('number-vm-cpu');
  cpuRange?.addEventListener('input', () => {
    cpuNumber.value = cpuRange.value;
  });
  cpuNumber?.addEventListener('input', () => {
    const clamped = Math.max(1, Math.min(HOST_TOTAL_CPUS, Number(cpuNumber.value) || 1));
    cpuRange.value = String(clamped);
  });

  document.getElementById('form-new-vm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const errEl = document.getElementById('new-vm-error');
    const name = nameInput?.value.trim() || '';

    if (!name) {
      if (errEl) errEl.textContent = 'Debes indicar un nombre para la máquina virtual.';
      return;
    }

    const duplicate = AppState.vms.some((v) => v.name.toLowerCase() === name.toLowerCase());
    if (duplicate) {
      if (errEl) errEl.textContent = `Ya existe una máquina llamada "${name}".`;
      return;
    }

    const os = osSelect?.value === 'Windows' ? 'Windows' : 'Linux';
    const osVersion = verSelect?.value || (os === 'Windows' ? 'Windows 10 (64-bit)' : 'Ubuntu (64-bit)');
    const ram = Math.max(512, Math.min(HOST_TOTAL_RAM_MB, Number(ramNumber?.value) || 2048));
    const cpu = Math.max(1, Math.min(HOST_TOTAL_CPUS, Number(cpuNumber?.value) || 2));
    const diskSize = Math.max(8, Math.min(500, Number(document.getElementById('input-vm-disk')?.value) || 25));

    const newVm = new VirtualMachine({
      name,
      os,
      osVersion,
      ram,
      cpu,
      diskSize,
      state: 'Apagada'
    });

    AppState.vms.push(newVm);
    AppState.selectedVmId = newVm.id;
    AppState.instructorTargetVmId = newVm.id;
    saveToStorage();
    closeNewVMModal();
    renderAll();
    setStatusMessage(`Máquina virtual "${newVm.name}" (${newVm.osVersion}) creada con Adaptador 1 en modo NAT.`);
  });

  document.getElementById('btn-close-new-modal')?.addEventListener('click', closeNewVMModal);
  document.getElementById('btn-cancel-new-modal')?.addEventListener('click', closeNewVMModal);

  // 7. Eventos del Modal "Configuración" y Pestaña "Red" (4 Adaptadores)
  document.querySelectorAll('.settings-cat-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchSettingsTab(btn.getAttribute('data-tab') || 'network');
    });
  });

  document.querySelectorAll('.vbox-subtab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      syncCurrentAdapterFormToDraft();
      const nextIdx = Number(btn.getAttribute('data-adapter-tab')) || 0;
      renderAdapterSubTab(nextIdx);
    });
  });

  const netEnabledChk = document.getElementById('net-adapter-enabled');
  const netModeSel = document.getElementById('net-adapter-mode');
  const netIntnetInput = document.getElementById('net-adapter-intnet-name');
  const netCableChk = document.getElementById('net-adapter-cable');
  const btnRegenMac = document.getElementById('btn-regen-mac');

  netEnabledChk?.addEventListener('change', () => {
    syncCurrentAdapterFormToDraft();
    renderAdapterSubTab(AppState.activeAdapterTabIndex);
  });

  netModeSel?.addEventListener('change', () => {
    syncCurrentAdapterFormToDraft();
    renderAdapterSubTab(AppState.activeAdapterTabIndex);
  });

  netIntnetInput?.addEventListener('input', () => {
    syncCurrentAdapterFormToDraft();
    const explainerEl = document.getElementById('net-mode-explainer');
    const draft = AppState.draftAdapters[AppState.activeAdapterTabIndex];
    if (explainerEl && draft) {
      explainerEl.innerHTML = NetworkEngine.getModeExplanation(draft.mode, draft.intnetName);
    }
  });

  netCableChk?.addEventListener('change', () => {
    syncCurrentAdapterFormToDraft();
  });

  btnRegenMac?.addEventListener('click', () => {
    const draft = AppState.draftAdapters[AppState.activeAdapterTabIndex];
    if (!draft || !draft.enabled) return;
    draft.mac = generateVBoxMAC();
    draft.forcedConflictIp = null;
    const macInput = document.getElementById('net-adapter-mac');
    if (macInput) macInput.value = draft.mac;
  });

  // Eventos Fase 7: Sub-modal "Reglas de reenvío de puertos" (Port Forwarding en NAT)
  document.getElementById('btn-open-port-forwarding')?.addEventListener('click', openPortForwardingModal);
  document.getElementById('btn-close-pf-modal')?.addEventListener('click', closePortForwardingModal);
  document.getElementById('btn-cancel-pf-modal')?.addEventListener('click', closePortForwardingModal);
  document.getElementById('btn-save-pf-modal')?.addEventListener('click', savePortForwardingModal);
  document.getElementById('btn-pf-add-rule')?.addEventListener('click', () => addPortForwardingRule(false));
  document.getElementById('btn-pf-preset-http')?.addEventListener('click', () => addPortForwardingRule(true));
  document.getElementById('btn-pf-clear-rules')?.addEventListener('click', () => {
    AppState.draftPortForwardingRules = [];
    renderPortForwardingTable();
  });

  const setOsSelect = document.getElementById('set-vm-os');
  const setVerSelect = document.getElementById('set-vm-version');
  setOsSelect?.addEventListener('change', () => {
    populateOSVersionSelect(setVerSelect, setOsSelect.value);
  });

  document.getElementById('form-settings-vm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const vm = getSelectedVM();
    if (!vm) return;

    syncCurrentAdapterFormToDraft();

    const newName = document.getElementById('set-vm-name')?.value.trim() || vm.name;
    const newOs = document.getElementById('set-vm-os')?.value === 'Windows' ? 'Windows' : 'Linux';
    const newVer = document.getElementById('set-vm-version')?.value || vm.osVersion;
    const newRam = Math.max(512, Math.min(HOST_TOTAL_RAM_MB, Number(document.getElementById('set-vm-ram')?.value) || vm.ram));
    const newCpu = Math.max(1, Math.min(HOST_TOTAL_CPUS, Number(document.getElementById('set-vm-cpu')?.value) || vm.cpu));
    const newVram = Number(document.getElementById('set-vm-vram')?.value) || vm.vram;
    const new3D = document.getElementById('set-vm-3d')?.value || vm.threeDAccel;
    const newIso = document.getElementById('set-vm-iso')?.value || 'Vacío';
    const newDisk = Math.max(8, Math.min(500, Number(document.getElementById('set-vm-disk')?.value) || vm.diskSize));

    vm.updateConfiguration(
      {
        name: newName,
        os: newOs,
        osVersion: newVer,
        ram: newRam,
        cpu: newCpu,
        vram: newVram,
        threeDAccel: new3D,
        isoMounted: newIso,
        diskSize: newDisk,
        adapters: AppState.draftAdapters
      },
      AppState.vms
    );

    AppState.ipConflictActive = AppState.vms.some((v) =>
      v.adapters.some((a) => Boolean(a.forcedConflictIp))
    );

    if (vm.state === 'Corriendo') {
      appendTerminalLog(
        vm,
        'info',
        `[NetworkEngine] Configuración de red actualizada en caliente. Ejecuta "${vm.os === 'Windows' ? 'ipconfig' : 'ip a'}" para verificar tus interfaces.`
      );
    }

    saveToStorage();
    closeSettingsModal();
    renderAll();

    const activeCount = vm.getEnabledAdapters().length;
    setStatusMessage(
      `Configuración de "${vm.name}" guardada (${activeCount} adaptador(es) de red habilitado(s)).`
    );
  });

  document.getElementById('btn-close-settings-modal')?.addEventListener('click', closeSettingsModal);
  document.getElementById('btn-cancel-settings-modal')?.addEventListener('click', closeSettingsModal);

  // 8. Eventos del Modal "Descartar / Eliminar"
  document.getElementById('btn-confirm-discard')?.addEventListener('click', confirmDiscardVM);
  document.getElementById('btn-close-discard-modal')?.addEventListener('click', closeDiscardModal);
  document.getElementById('btn-cancel-discard')?.addEventListener('click', closeDiscardModal);

  // 9. Menú superior desplegable (Archivo, Máquina, Ayuda)
  const menuPairs = [
    ['menu-file-btn', 'menu-file-dropdown'],
    ['menu-machine-btn', 'menu-machine-dropdown'],
    ['menu-help-btn', 'menu-help-dropdown']
  ];

  menuPairs.forEach(([btnId, dropId]) => {
    const btn = document.getElementById(btnId);
    const drop = document.getElementById(dropId);
    btn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasHidden = drop?.classList.contains('hidden');
      closeAllMenus();
      if (wasHidden) {
        drop?.classList.remove('hidden');
        btn.classList.add('active');
      }
    });
  });

  document.addEventListener('click', () => closeAllMenus());

  const resetFactoryAction = () => {
    clearActivePingTimers();
    closeVMConsoleModal();
    AppState.ipConflictActive = false;
    AppState.vms = getDefaultVMs();
    AppState.selectedVmId = AppState.vms[0].id;
    AppState.instructorTargetVmId = AppState.selectedVmId;
    saveToStorage();
    renderAll();
    setStatusMessage('Inventario de máquinas virtuales de fábrica restaurado sin fallos.');
  };

  document.getElementById('menu-reset-vms')?.addEventListener('click', resetFactoryAction);
  document.getElementById('btn-reset-demo')?.addEventListener('click', resetFactoryAction);

  document.getElementById('menu-export-json')?.addEventListener('click', () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(AppState.vms, null, 2));
    const link = document.createElement('a');
    link.setAttribute('href', dataStr);
    link.setAttribute('download', 'virtlab_inventario_vms.json');
    document.body.appendChild(link);
    link.click();
    link.remove();
    setStatusMessage('Inventario exportado como virtlab_inventario_vms.json.');
  });

  const importJsonInput = document.getElementById('input-import-json-file');
  document.getElementById('menu-import-json')?.addEventListener('click', () => {
    importJsonInput?.click();
  });
  importJsonInput?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || ''));
        const list = Array.isArray(parsed) ? parsed : parsed?.vms;
        if (!Array.isArray(list) || list.length === 0) {
          throw new Error('Formato inválido');
        }
        AppState.vms = list.map((item) => new VirtualMachine(item));
        AppState.vms.forEach((v) => NetworkEngine.assignIPsForVM(v, AppState.vms));
        AppState.selectedVmId = AppState.vms[0].id;
        AppState.instructorTargetVmId = AppState.selectedVmId;
        saveToStorage();
        renderAll();
        setStatusMessage(`Inventario JSON importado correctamente (${AppState.vms.length} máquinas virtuales).`);
      } catch {
        setStatusMessage('Error al importar el archivo JSON: estructura no válida.');
      }
      importJsonInput.value = '';
    };
    reader.readAsText(file);
  });

  document.getElementById('menu-new-vm')?.addEventListener('click', openNewVMModal);
  document.getElementById('menu-clone-vm')?.addEventListener('click', openCloneVMModal);
  document.getElementById('btn-clone-vm')?.addEventListener('click', openCloneVMModal);
  document.getElementById('btn-close-clone-modal')?.addEventListener('click', closeCloneVMModal);
  document.getElementById('btn-cancel-clone-modal')?.addEventListener('click', closeCloneVMModal);
  document.getElementById('form-clone-vm')?.addEventListener('submit', handleCloneVMSubmit);

  document.getElementById('btn-topology')?.addEventListener('click', openTopologyModal);
  document.getElementById('menu-topology-open')?.addEventListener('click', openTopologyModal);
  document.getElementById('btn-close-topology-modal')?.addEventListener('click', closeTopologyModal);
  document.getElementById('btn-ok-topology-modal')?.addEventListener('click', closeTopologyModal);

  document.getElementById('btn-ctf-hub')?.addEventListener('click', openCtfHubModal);
  document.getElementById('menu-ctf-open')?.addEventListener('click', openCtfHubModal);
  document.getElementById('btn-close-ctf-modal')?.addEventListener('click', closeCtfHubModal);
  document.getElementById('btn-ok-ctf-modal')?.addEventListener('click', closeCtfHubModal);

  document.getElementById('menu-settings-vm')?.addEventListener('click', () => openSettingsModal('network', 0));
  document.getElementById('menu-start-vm')?.addEventListener('click', handleStartOrOpenConsole);
  document.getElementById('menu-poweroff-vm')?.addEventListener('click', handlePowerOffSelectedVM);
  document.getElementById('menu-discard-vm')?.addEventListener('click', openDiscardModal);

  const openAbout = () => document.getElementById('modal-about')?.classList.remove('hidden');
  const closeAbout = () => document.getElementById('modal-about')?.classList.add('hidden');
  document.getElementById('menu-about-open')?.addEventListener('click', openAbout);
  document.getElementById('btn-about-virtlab')?.addEventListener('click', openAbout);
  document.getElementById('btn-close-about-modal')?.addEventListener('click', closeAbout);
  document.getElementById('btn-ok-about')?.addEventListener('click', closeAbout);

  document.getElementById('btn-toggle-fullscreen')?.addEventListener('click', () => {
    document.getElementById('vbox-main-window')?.classList.toggle('maximized');
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      openNewVMModal();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      openCloneVMModal();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      openSettingsModal('network', 0);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      toggleInstructorDrawer();
    } else if (e.key === 'Escape') {
      const settingsModal = document.getElementById('modal-settings-vm');
      if (settingsModal && !settingsModal.classList.contains('hidden')) {
        closeSettingsModal();
        return;
      }
      closeNewVMModal();
      closeCloneVMModal();
      closeTopologyModal();
      closeCtfHubModal();
      closeDiscardModal();
      closeAbout();
      closeScenarioDialog();
      closeAllMenus();
    }
  });
}

/**
 * ============================================================================
 * MODALES EDUCATIVOS ADICIONALES: TOPOLOGÍA DE RED, CENTRO CTF Y CLONAR VM
 * ============================================================================
 */
function openTopologyModal() {
  renderTopologyModal();
  document.getElementById('modal-topology')?.classList.remove('hidden');
}

function closeTopologyModal() {
  document.getElementById('modal-topology')?.classList.add('hidden');
}

function renderTopologyModal() {
  const gridEl = document.getElementById('topology-canvas-grid');
  if (!gridEl) return;

  const zones = [
    {
      mode: 'NAT',
      icon: 'fa-shield-halved',
      title: '1. Motor NAT VirtualBox',
      subnet: '10.0.2.0/24 (GW: 10.0.2.2)',
      desc: 'Las VMs salen a Internet (8.8.8.8) traducidas tras el Anfitrión. El exterior solo entra si configuras reglas de Reenvío de Puertos.'
    },
    {
      mode: 'Adaptador Puente',
      icon: 'fa-bridge',
      title: '2. Switch Puente (LAN Física)',
      subnet: '192.168.1.0/24 (GW: 192.168.1.1)',
      desc: 'Comparte la red física con el Anfitrión (192.168.1.100) y el router real. Visibilidad bidireccional completa.'
    },
    {
      mode: 'Adaptador sólo-anfitrión',
      icon: 'fa-laptop-code',
      title: '3. Switch Host-Only (vboxnet0)',
      subnet: '192.168.56.0/24 (Host: .56.1)',
      desc: 'Comunica las VMs entre sí y con el adaptador virtual del Anfitrión (192.168.56.1), pero sin salida a Internet.'
    },
    {
      mode: 'Red interna',
      icon: 'fa-network-wired',
      title: '4. Switches de Red Interna (intnet)',
      subnet: 'Sin DHCP (Estática / APIPA)',
      desc: 'Laboratorio cerrado puro entre VMs que compartan el mismo nombre de switch virtual. Aislado del Anfitrión y de Internet.'
    }
  ];

  gridEl.innerHTML = zones
    .map((zone) => {
      const attachedNodes = [];
      AppState.vms.forEach((vm) => {
        vm.getEnabledAdapters().forEach((ad) => {
          if (ad.mode === zone.mode) {
            attachedNodes.push({ vm, ad });
          }
        });
      });

      const nodesHtml =
        attachedNodes.length === 0
          ? `<div class="topo-zone-desc" style="font-style:italic; color:#64748b;">(Ningún adaptador conectado actualmente a este modo)</div>`
          : attachedNodes
              .map(({ vm, ad }) => {
                const isRunning = vm.state === 'Corriendo';
                const ipText = isRunning ? ad.ipInfo?.ip || 'Sin IP (Pendiente DHCP)' : 'Máquina Apagada';
                const intnetBadge =
                  ad.mode === 'Red interna' ? ` [Switch: '${escapeHTML(ad.intnetName)}']` : '';
                const faultBadge = !ad.cableConnected
                  ? ' · [Cable desconectado]'
                  : vm.firewallDropIcmp
                    ? ' · [Firewall DROP ICMP]'
                    : ad.forcedConflictIp
                      ? ' · [Conflicto IP/MAC]'
                      : '';
                const hasFault = !ad.cableConnected || vm.firewallDropIcmp || Boolean(ad.forcedConflictIp);

                return `
                  <div class="topo-node-item ${!isRunning ? 'is-off' : ''} ${hasFault ? 'has-fault' : ''}">
                    <div class="topo-node-meta">
                      <span class="topo-node-name">${escapeHTML(vm.name)} — eth${ad.slot - 1}${intnetBadge}</span>
                      <span class="topo-node-ip">IP: <strong>${escapeHTML(ipText)}</strong> · MAC: ${escapeHTML(formatMacColon(ad.mac))}${escapeHTML(faultBadge)}</span>
                    </div>
                    <div class="topo-node-actions">
                      <button type="button" class="vbox-classic-btn small" data-topo-console="${vm.id}" title="Abrir terminal de esta VM">
                        <i class="fa-solid fa-terminal"></i> Consola
                      </button>
                      <button type="button" class="vbox-classic-btn small" data-topo-net="${vm.id}:${ad.slot - 1}" title="Configurar este adaptador">
                        <i class="fa-solid fa-gear"></i>
                      </button>
                    </div>
                  </div>
                `;
              })
              .join('');

      return `
        <div class="topo-zone-card">
          <div class="topo-zone-header">
            <span class="topo-zone-title"><i class="fa-solid ${zone.icon}"></i> ${zone.title}</span>
            <span class="topo-zone-subnet">${zone.subnet}</span>
          </div>
          <p class="topo-zone-desc">${zone.desc}</p>
          <div class="topo-nodes-list">${nodesHtml}</div>
        </div>
      `;
    })
    .join('');

  gridEl.querySelectorAll('[data-topo-console]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const vmId = btn.getAttribute('data-topo-console');
      closeTopologyModal();
      openVMConsoleModal(vmId);
    });
  });

  gridEl.querySelectorAll('[data-topo-net]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [vmId, slotIdx] = (btn.getAttribute('data-topo-net') || '').split(':');
      AppState.selectedVmId = vmId;
      closeTopologyModal();
      openSettingsModal('network', Number(slotIdx) || 0);
    });
  });
}

function openCtfHubModal() {
  renderCtfHubModal();
  document.getElementById('modal-ctf-hub')?.classList.remove('hidden');
}

function closeCtfHubModal() {
  document.getElementById('modal-ctf-hub')?.classList.add('hidden');
}

function renderCtfHubModal() {
  renderCtfBadgeCount();
  const listEl = document.getElementById('ctf-challenges-list');
  if (!listEl) return;

  listEl.innerHTML = CTF_CHALLENGES.map((ch) => {
    const isSolved = AppState.ctfState.unlockedFlags.has(ch.id);
    return `
      <div class="ctf-challenge-card ${isSolved ? 'solved' : ''}">
        <div class="ctf-card-header">
          <span class="ctf-card-title">
            <i class="fa-solid ${isSolved ? 'fa-circle-check' : 'fa-flag'}" style="color:${isSolved ? '#059669' : '#2563eb'};"></i>
            ${escapeHTML(ch.title)}
          </span>
          <span class="ctf-status-tag ${isSolved ? 'solved' : ''}">
            ${isSolved ? 'COMPLETADO' : 'PENDIENTE'}
          </span>
        </div>
        <p class="ctf-card-desc">${ch.description || ''}</p>
        <div class="ctf-card-footer">
          ${
            isSolved
              ? `<span class="ctf-flag-reveal">[+] Flag obtenida: ${escapeHTML(ch.flag)}</span>`
              : `<span class="dialog-helper-text" style="margin:0;">Recompensa al superar: <code>flag{...}</code> en consola</span>`
          }
          <button type="button" class="vbox-classic-btn small primary" data-load-ctf="${ch.id}">
            <i class="fa-solid fa-play"></i> Preparar y Abrir Escenario del Reto
          </button>
        </div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('[data-load-ctf]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const chId = btn.getAttribute('data-load-ctf');
      loadCtfChallengeScenario(chId);
    });
  });
}

function loadCtfChallengeScenario(challengeId) {
  const targetVm = getSelectedVM() || AppState.vms[0];
  if (!targetVm) return;

  if (challengeId === 'ctf-firewall-icmp-master') {
    closeCtfHubModal();
    handleLoadCtfFirewallScenario();
    closeScenarioDialog();
    openVMConsoleModal(targetVm.id);
    return;
  }

  if (challengeId === 'ctf-nat-port-forwarding-curl') {
    const ad = targetVm.adapters[0];
    if (ad) {
      ad.enabled = true;
      ad.mode = 'NAT';
      ad.cableConnected = true;
      ad.portForwardingRules = [];
      ad.dhcpLeased = true;
    }
    targetVm.firewallDropIcmp = false;
    if (targetVm.state !== 'Corriendo') targetVm.start(AppState.vms);
    if (ad) ad.dhcpLeased = true;
    NetworkEngine.assignIPsForVM(targetVm, AppState.vms);
    exportarEscenario();
    cargarEscenario();
    closeScenarioDialog();
    closeCtfHubModal();
    openSettingsModal('network', 0);
    setStatusMessage(
      `[Reto 2 CTF] Configura Reenvío de Puertos NAT (8080 -> 10.0.2.15:80) en "${targetVm.name}" y luego ejecuta "curl localhost:8080" en consola.`
    );
    return;
  }

  if (challengeId === 'ctf-internal-network-static') {
    if (AppState.vms.length >= 2) {
      const [vm1, vm2] = AppState.vms;
      [vm1, vm2].forEach((v) => {
        v.firewallDropIcmp = false;
        v.adapters[0].enabled = true;
        v.adapters[0].mode = 'Red interna';
        v.adapters[0].intnetName = 'intnet';
        v.adapters[0].cableConnected = true;
        v.adapters[0].manualStaticIp = null;
        if (v.state !== 'Corriendo') v.start(AppState.vms);
        NetworkEngine.assignIPsForVM(v, AppState.vms);
      });
      exportarEscenario();
      cargarEscenario();
      closeScenarioDialog();
      closeCtfHubModal();
      openVMConsoleModal(vm1.id);
      setStatusMessage(
        `[Reto 3 CTF] Ambas VMs están en Red interna 'intnet'. Asígnales IPs estáticas (ej. "ip set eth0 10.10.10.1" y "10.10.10.2") y haz ping entre ellas.`
      );
    }
    return;
  }

  if (challengeId === 'ctf-cable-dhcp-dora') {
    const ad = targetVm.adapters[0];
    if (ad) {
      ad.enabled = true;
      ad.mode = 'NAT';
      ad.cableConnected = false;
      ad.dhcpLeased = false;
    }
    targetVm.firewallDropIcmp = false;
    if (targetVm.state !== 'Corriendo') targetVm.start(AppState.vms);
    NetworkEngine.assignIPsForVM(targetVm, AppState.vms);
    exportarEscenario();
    cargarEscenario();
    closeScenarioDialog();
    closeCtfHubModal();
    openVMConsoleModal(targetVm.id);
    setStatusMessage(
      `[Reto 4 CTF] El cable de "${targetVm.name}" está desconectado. Reconéctalo y ejecuta "${targetVm.os === 'Windows' ? 'ipconfig /renew' : 'dhclient'}".`
    );
  }
}

function openCloneVMModal() {
  const vm = getSelectedVM();
  if (!vm) return;
  const inputName = document.getElementById('input-clone-name');
  const errEl = document.getElementById('clone-vm-error');
  if (inputName) inputName.value = `${vm.name}-Clon`;
  if (errEl) errEl.textContent = '';
  document.getElementById('modal-clone-vm')?.classList.remove('hidden');
}

function closeCloneVMModal() {
  document.getElementById('modal-clone-vm')?.classList.add('hidden');
}

function handleCloneVMSubmit(e) {
  e.preventDefault();
  const sourceVm = getSelectedVM();
  if (!sourceVm) return;

  const inputName = document.getElementById('input-clone-name');
  const macPolicy = document.getElementById('select-clone-mac-policy')?.value || 'generate';
  const errEl = document.getElementById('clone-vm-error');
  const cloneName = inputName?.value.trim() || `${sourceVm.name}-Clon`;

  if (AppState.vms.some((v) => v.name.toLowerCase() === cloneName.toLowerCase())) {
    if (errEl) errEl.textContent = `Ya existe una máquina llamada "${cloneName}".`;
    return;
  }

  const keepMacs = macPolicy === 'keep';
  const clonedAdapters = sourceVm.adapters.map((ad) => ({
    ...ad,
    mac: keepMacs ? ad.mac : generateVBoxMAC(),
    forcedConflictIp: keepMacs && ad.mode === 'Adaptador Puente' ? LAB_INFRASTRUCTURE_IPS.CONFLICT_BRIDGE_IP : null,
    dhcpLeased: false,
    portForwardingRules: normalizePortForwardingRules(ad.portForwardingRules)
  }));

  const clonedVm = new VirtualMachine({
    name: cloneName,
    os: sourceVm.os,
    osVersion: sourceVm.osVersion,
    ram: sourceVm.ram,
    cpu: sourceVm.cpu,
    vram: sourceVm.vram,
    diskSize: sourceVm.diskSize,
    isoMounted: sourceVm.isoMounted,
    threeDAccel: sourceVm.threeDAccel,
    firewallDropIcmp: sourceVm.firewallDropIcmp,
    adapters: clonedAdapters,
    state: 'Apagada'
  });

  if (keepMacs && sourceVm.adapters.some((a) => a.enabled && a.mode === 'Adaptador Puente')) {
    sourceVm.adapters[0].forcedConflictIp = LAB_INFRASTRUCTURE_IPS.CONFLICT_BRIDGE_IP;
    AppState.ipConflictActive = true;
    NetworkEngine.assignIPsForVM(sourceVm, AppState.vms);
  }

  AppState.vms.push(clonedVm);
  AppState.selectedVmId = clonedVm.id;
  AppState.instructorTargetVmId = clonedVm.id;
  saveToStorage();
  closeCloneVMModal();
  renderAll();
  setStatusMessage(
    `Máquina "${sourceVm.name}" clonada como "${clonedVm.name}" (${keepMacs ? 'MACs conservadas' : 'Nuevas MACs generadas'}).`
  );
}

// Exponer funciones de Fase 5 y Fase 9 (Modo CTF) en window para acceso global
if (typeof window !== 'undefined') {
  window.exportarEscenario = exportarEscenario;
  window.cargarEscenario = cargarEscenario;
  window.checkCTFWinCondition = checkCTFWinCondition;
  window.registerCTFChallenge = registerCTFChallenge;
  window.registerConsoleCommandListener = registerConsoleCommandListener;
}

// Inicializar aplicación y cargar escenario desde la URL (?escenario=) en window.onload (Fase 5 y Fase 9)
let isAppInitialized = false;
function bootstrapVirtLab() {
  if (isAppInitialized) return;
  isAppInitialized = true;
  // Registrar el listener silencioso del Motor de Retos y Flags (Fase 9)
  registerConsoleCommandListener((eventContext) => {
    checkCTFWinCondition(eventContext);
  });
  loadFromStorage();
  initEvents();
  const loadedFromUrl = cargarEscenario();
  if (!loadedFromUrl) {
    renderAll();
  }
}

window.onload = () => {
  if (!isAppInitialized) {
    bootstrapVirtLab();
  } else {
    cargarEscenario();
  }
};

document.addEventListener('DOMContentLoaded', () => {
  bootstrapVirtLab();
});
