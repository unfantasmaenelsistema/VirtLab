// Iconos SVG propios (estilo VirtualBox 7, sin logotipos de marcas).
import { OS_TYPES } from '../catalog.js';

const svg = (size, body, vb = 32) => `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" aria-hidden="true">${body}</svg>`;

const defs = {
  new: (s) => svg(s, '<defs><radialGradient id="gN" cx=".35" cy=".3"><stop offset="0" stop-color="#9fd3ff"/><stop offset="1" stop-color="#1366c4"/></radialGradient></defs><circle cx="16" cy="16" r="12" fill="url(#gN)"/><path d="M16 6l2.2 6.6L25 13l-5.4 4 2 6.6L16 19.8l-5.6 3.8 2-6.6L7 13l6.8-.4z" fill="#fff6c8" stroke="#f5b400" stroke-width=".8"/>'),
  add: (s) => svg(s, '<defs><linearGradient id="gA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7bd36b"/><stop offset="1" stop-color="#2c8a20"/></linearGradient></defs><circle cx="16" cy="16" r="12" fill="url(#gA)"/><path d="M16 9v14M9 16h14" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>'),
  settings: (s) => svg(s, '<defs><linearGradient id="gS" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc35a"/><stop offset="1" stop-color="#e2780a"/></linearGradient></defs><path d="M14 3h4l.7 3.3 2.4 1 2.8-1.9 2.8 2.8-1.9 2.8 1 2.4L29 14v4l-3.3.7-1 2.4 1.9 2.8-2.8 2.8-2.8-1.9-2.4 1L18 29h-4l-.7-3.3-2.4-1-2.8 1.9-2.8-2.8 1.9-2.8-1-2.4L3 18v-4l3.3-.7 1-2.4-1.9-2.8 2.8-2.8 2.8 1.9 2.4-1z" fill="url(#gS)" stroke="#b55d00" stroke-width=".8"/><circle cx="16" cy="16" r="4.6" fill="#fff6e3" stroke="#b55d00"/>'),
  discard: (s) => svg(s, '<defs><linearGradient id="gD" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff8a80"/><stop offset="1" stop-color="#c62828"/></linearGradient></defs><circle cx="16" cy="16" r="12" fill="url(#gD)"/><path d="M10.5 10.5l11 11M21.5 10.5l-11 11" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>'),
  start: (s) => svg(s, '<defs><linearGradient id="gSt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8be37a"/><stop offset="1" stop-color="#2e9a1f"/></linearGradient></defs><path d="M6 11h10V5l12 11-12 11v-6H6z" fill="url(#gSt)" stroke="#1f6e14" stroke-width="1" stroke-linejoin="round"/>'),
  show: (s) => svg(s, '<rect x="4" y="6" width="24" height="17" rx="2" fill="#2a6fd6"/><rect x="6.5" y="8.5" width="19" height="12" fill="#cfe6ff"/><path d="M11 27h10" stroke="#555" stroke-width="2.4" stroke-linecap="round"/><path d="M14 14l5 3-5 3z" fill="#2e9a1f"/>'),
  stop: (s) => svg(s, '<circle cx="16" cy="16" r="12" fill="#e0e0e0" stroke="#8a8a8a"/><path d="M16 8v8" stroke="#c62828" stroke-width="3" stroke-linecap="round"/><path d="M10.6 11.2a8 8 0 1 0 10.8 0" fill="none" stroke="#c62828" stroke-width="2.6" stroke-linecap="round"/>'),
  tools: (s) => svg(s, '<path d="M20.5 4.5a6 6 0 0 0-6.6 8.1L5 21.5 10.5 27l8.9-8.9a6 6 0 0 0 8.1-6.6l-3.6 3.6-3.6-1-1-3.6z" fill="#7a8899" stroke="#4b5866" stroke-width="1"/>'),
  menu: (s) => svg(s, '<path d="M7 10h18M7 16h18M7 22h18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  details: (s) => svg(s, '<rect x="5" y="4" width="22" height="24" rx="2" fill="#fff" stroke="#5b7aa8"/><path d="M9 10h14M9 15h14M9 20h9" stroke="#2a6fd6" stroke-width="2"/>'),
  snapshot: (s) => svg(s, '<rect x="3" y="9" width="26" height="17" rx="3" fill="#5a6c84"/><path d="M10 9l2-4h8l2 4" fill="#5a6c84"/><circle cx="16" cy="17.5" r="6" fill="#d8ecff" stroke="#fff" stroke-width="1.5"/><circle cx="16" cy="17.5" r="2.8" fill="#2a6fd6"/>'),
  snapTake: (s) => svg(s, '<rect x="3" y="9" width="22" height="15" rx="3" fill="#5a6c84"/><circle cx="14" cy="16.5" r="5" fill="#d8ecff"/><circle cx="25" cy="23" r="6" fill="#2e9a1f"/><path d="M25 20v6M22 23h6" stroke="#fff" stroke-width="2"/>'),
  snapRestore: (s) => svg(s, '<rect x="3" y="9" width="22" height="15" rx="3" fill="#5a6c84"/><circle cx="14" cy="16.5" r="5" fill="#d8ecff"/><circle cx="25" cy="23" r="6" fill="#f5a300"/><path d="M22 23a3 3 0 1 0 1-2.3M22 19.5v2h2" fill="none" stroke="#fff" stroke-width="1.6"/>'),
  snapDelete: (s) => svg(s, '<rect x="3" y="9" width="22" height="15" rx="3" fill="#5a6c84"/><circle cx="14" cy="16.5" r="5" fill="#d8ecff"/><circle cx="25" cy="23" r="6" fill="#c62828"/><path d="M22.5 20.5l5 5M27.5 20.5l-5 5" stroke="#fff" stroke-width="1.8"/>'),
  props: (s) => svg(s, '<rect x="5" y="4" width="22" height="24" rx="2" fill="#fff" stroke="#888"/><path d="M9 10h6M9 15h10M9 20h8" stroke="#555" stroke-width="2"/><circle cx="23" cy="22" r="5" fill="#ffb300"/>'),
  clone: (s) => svg(s, '<rect x="9" y="9" width="18" height="18" rx="3" fill="#cfe6ff" stroke="#2a6fd6" stroke-width="1.5"/><rect x="5" y="5" width="18" height="18" rx="3" fill="#fff" stroke="#2a6fd6" stroke-width="1.5"/><path d="M10 14h8M14 10v8" stroke="#2e9a1f" stroke-width="2.4"/>'),
  logs: (s) => svg(s, '<path d="M7 3h13l6 6v20H7z" fill="#fff" stroke="#6d6d6d"/><path d="M20 3v6h6" fill="#ddd" stroke="#6d6d6d"/><path d="M10 14h12M10 18h12M10 22h8" stroke="#888" stroke-width="1.6"/>'),
  activity: (s) => svg(s, '<rect x="4" y="5" width="24" height="22" rx="2" fill="#10213a"/><path d="M6 20l5-6 4 4 5-9 6 7" fill="none" stroke="#38d26b" stroke-width="2"/>'),
  media: (s) => svg(s, '<rect x="5" y="6" width="22" height="20" rx="3" fill="#8a96a8"/><rect x="5" y="20" width="22" height="6" rx="2" fill="#5d6878"/><circle cx="22" cy="23" r="1.4" fill="#5df07c"/><circle cx="16" cy="13" r="5" fill="#dfe6ef"/><circle cx="16" cy="13" r="1.4" fill="#5d6878"/>'),
  network: (s) => svg(s, '<rect x="12" y="3" width="8" height="7" rx="1" fill="#2a6fd6"/><rect x="3" y="21" width="8" height="7" rx="1" fill="#2a6fd6"/><rect x="21" y="21" width="8" height="7" rx="1" fill="#2a6fd6"/><path d="M16 10v5M7 21v-6h18v6" fill="none" stroke="#3b4a5e" stroke-width="2"/>'),
  welcome: (s) => svg(s, '<path d="M4 15L16 5l12 10" fill="none" stroke="#2a6fd6" stroke-width="2.4" stroke-linejoin="round"/><path d="M7 14v13h18V14" fill="#e9f2ff" stroke="#2a6fd6" stroke-width="1.6"/><rect x="13" y="19" width="6" height="8" fill="#2a6fd6"/>'),
  labs: (s) => svg(s, '<path d="M12 4h8M13 4v8L6 25a2 2 0 0 0 1.8 3h16.4a2 2 0 0 0 1.8-3L19 12V4" fill="#e8f7ec" stroke="#2e7d32" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 21h14l2 4H7z" fill="#43a047"/><circle cx="14" cy="17" r="1.3" fill="#43a047"/>'),
  extension: (s) => svg(s, '<path d="M6 10h6a3 3 0 1 1 6 0h6v6a3 3 0 1 1 0 6v6H6z" fill="#8e6ad8"/>'),
  cloud: (s) => svg(s, '<path d="M9 24a6 6 0 0 1-.5-12A8 8 0 0 1 24 13a5.5 5.5 0 0 1 0 11z" fill="#9cc6f5" stroke="#2a6fd6"/>'),
  import: (s) => svg(s, '<rect x="5" y="15" width="22" height="12" rx="2" fill="#8a96a8"/><path d="M16 3v13M10 10l6 6 6-6" fill="none" stroke="#2e9a1f" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'),
  export: (s) => svg(s, '<rect x="5" y="15" width="22" height="12" rx="2" fill="#8a96a8"/><path d="M16 16V3M10 9l6-6 6 6" fill="none" stroke="#2a6fd6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'),
  prefs: (s) => svg(s, '<rect x="4" y="6" width="24" height="20" rx="3" fill="#dfe6ef" stroke="#7a8899"/><path d="M9 12h14M9 20h14" stroke="#7a8899" stroke-width="2"/><circle cx="13" cy="12" r="2.6" fill="#2a6fd6"/><circle cx="20" cy="20" r="2.6" fill="#2a6fd6"/>'),
  refresh: (s) => svg(s, '<path d="M25 13a9 9 0 1 0 0 6" fill="none" stroke="#2a6fd6" stroke-width="2.6" stroke-linecap="round"/><path d="M26 6v7h-7" fill="none" stroke="#2a6fd6" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  create: (s) => svg(s, '<rect x="5" y="5" width="18" height="22" rx="2" fill="#fff" stroke="#7a8899"/><circle cx="23" cy="22" r="6" fill="#2e9a1f"/><path d="M23 19v6M20 22h6" stroke="#fff" stroke-width="2"/>'),
  remove: (s) => svg(s, '<rect x="5" y="5" width="18" height="22" rx="2" fill="#fff" stroke="#7a8899"/><circle cx="23" cy="22" r="6" fill="#c62828"/><path d="M20 22h6" stroke="#fff" stroke-width="2.4"/>'),
  release: (s) => svg(s, '<rect x="5" y="9" width="22" height="14" rx="3" fill="#8a96a8"/><path d="M10 16h12" stroke="#fff" stroke-width="2.4"/>'),
  search: (s) => svg(s, '<circle cx="14" cy="14" r="7" fill="none" stroke="#555" stroke-width="2.4"/><path d="M19 19l7 7" stroke="#555" stroke-width="3" stroke-linecap="round"/>'),
  copy: (s) => svg(s, '<rect x="10" y="10" width="16" height="17" rx="2" fill="#fff" stroke="#7a8899"/><rect x="6" y="5" width="16" height="17" rx="2" fill="#eef3f9" stroke="#7a8899"/>'),
  move: (s) => svg(s, '<rect x="4" y="9" width="14" height="14" rx="2" fill="#eef3f9" stroke="#7a8899"/><path d="M15 16h12M22 11l5 5-5 5" fill="none" stroke="#2a6fd6" stroke-width="2.4" stroke-linecap="round"/>'),
  info: (s) => svg(s, '<circle cx="16" cy="16" r="12" fill="#2a6fd6"/><path d="M16 14v8" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="10" r="1.8" fill="#fff"/>'),
  warn: (s) => svg(s, '<path d="M16 4l13 23H3z" fill="#ffb300" stroke="#b77d00" stroke-linejoin="round"/><path d="M16 12v7" stroke="#222" stroke-width="2.6" stroke-linecap="round"/><circle cx="16" cy="23" r="1.6" fill="#222"/>'),
  error: (s) => svg(s, '<circle cx="16" cy="16" r="12" fill="#d32f2f"/><path d="M11 11l10 10M21 11l-10 10" stroke="#fff" stroke-width="3" stroke-linecap="round"/>'),
  question: (s) => svg(s, '<circle cx="16" cy="16" r="12" fill="#2a6fd6"/><path d="M12 12.5a4 4 0 1 1 5.5 3.7c-1 .4-1.5 1.2-1.5 2.3v.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><circle cx="16" cy="23" r="1.7" fill="#fff"/>'),
  // secciones del panel de detalles / configuración
  general: (s) => svg(s, '<rect x="4" y="6" width="24" height="20" rx="3" fill="#f6c343" stroke="#b58500"/><rect x="8" y="10" width="16" height="3" fill="#fff"/><rect x="8" y="16" width="10" height="3" fill="#fff"/>'),
  system: (s) => svg(s, '<rect x="8" y="8" width="16" height="16" rx="2" fill="#4b6b95"/><rect x="12" y="12" width="8" height="8" fill="#9fc0e8"/><path d="M11 4v4M16 4v4M21 4v4M11 24v4M16 24v4M21 24v4M4 11h4M4 16h4M4 21h4M24 11h4M24 16h4M24 21h4" stroke="#4b6b95" stroke-width="2"/>'),
  display: (s) => svg(s, '<rect x="3" y="5" width="26" height="18" rx="2" fill="#2a3c55"/><rect x="5.5" y="7.5" width="21" height="13" fill="#5aa9f0"/><path d="M12 27h8M16 23v4" stroke="#2a3c55" stroke-width="2.4"/>'),
  storage: (s) => svg(s, '<ellipse cx="16" cy="8" rx="11" ry="4" fill="#9fb2c8" stroke="#56677c"/><path d="M5 8v16c0 2.2 4.9 4 11 4s11-1.8 11-4V8" fill="#c4d2e2" stroke="#56677c"/><path d="M5 16c0 2.2 4.9 4 11 4s11-1.8 11-4" fill="none" stroke="#56677c"/>'),
  audio: (s) => svg(s, '<path d="M5 12h5l7-6v20l-7-6H5z" fill="#4b6b95"/><path d="M21 11a6 6 0 0 1 0 10M24 7a11 11 0 0 1 0 18" fill="none" stroke="#4b6b95" stroke-width="2.2" stroke-linecap="round"/>'),
  net: (s) => svg(s, '<rect x="4" y="9" width="24" height="14" rx="2" fill="#2e7d32"/><path d="M8 23v4M12 23v4M16 23v4M20 23v4M24 23v4" stroke="#c7a12a" stroke-width="2"/><rect x="9" y="13" width="14" height="6" fill="#1b5e20"/>'),
  serial: (s) => svg(s, '<path d="M5 9h22l-3 14H8z" fill="#7a8899"/><circle cx="11" cy="14" r="1.3" fill="#fff"/><circle cx="16" cy="14" r="1.3" fill="#fff"/><circle cx="21" cy="14" r="1.3" fill="#fff"/><circle cx="13.5" cy="18" r="1.3" fill="#fff"/><circle cx="18.5" cy="18" r="1.3" fill="#fff"/>'),
  usb: (s) => svg(s, '<path d="M16 3v22M16 25a2.5 2.5 0 1 0 .01 0M16 9l-6 5v4M16 13l6 4v3" fill="none" stroke="#4b6b95" stroke-width="2.2" stroke-linecap="round"/><path d="M13 5l3-3 3 3z" fill="#4b6b95"/><rect x="8" y="17" width="4" height="4" fill="#4b6b95"/><circle cx="22" cy="21" r="2" fill="#4b6b95"/>'),
  shared: (s) => svg(s, '<path d="M3 8h10l2 3h14v15H3z" fill="#f6c343" stroke="#b58500"/><circle cx="22" cy="20" r="5" fill="#2a6fd6"/><path d="M19.5 20h5M22 17.5v5" stroke="#fff" stroke-width="1.8"/>'),
  description: (s) => svg(s, '<path d="M6 4h16l4 4v20H6z" fill="#fffbe6" stroke="#b58500"/><path d="M10 12h12M10 16h12M10 20h8" stroke="#b58500" stroke-width="1.6"/>'),
  ui: (s) => svg(s, '<rect x="3" y="5" width="26" height="22" rx="2" fill="#fff" stroke="#7a8899"/><rect x="3" y="5" width="26" height="5" fill="#2a6fd6"/><rect x="3" y="23" width="26" height="4" fill="#cfd8e3"/>'),
  preview: (s) => svg(s, '<rect x="3" y="5" width="26" height="18" rx="2" fill="#2a3c55"/><rect x="5.5" y="7.5" width="21" height="13" fill="#0c0c0c"/><path d="M12 27h8M16 23v4" stroke="#2a3c55" stroke-width="2.4"/>'),
  hdd: (s) => svg(s, '<rect x="4" y="7" width="24" height="18" rx="3" fill="#8a96a8"/><rect x="4" y="19" width="24" height="6" rx="2" fill="#5d6878"/><circle cx="23" cy="22" r="1.4" fill="#5df07c"/><circle cx="14" cy="13" r="4" fill="#dfe6ef"/>'),
  dvd: (s) => svg(s, '<circle cx="16" cy="16" r="12" fill="#e3e9f1" stroke="#8a96a8"/><circle cx="16" cy="16" r="12" fill="url(#gCD)"/><defs><linearGradient id="gCD"><stop offset="0" stop-color="#cfe6ff" stop-opacity=".9"/><stop offset=".5" stop-color="#ffe0f5" stop-opacity=".6"/><stop offset="1" stop-color="#e2ffd6" stop-opacity=".8"/></linearGradient></defs><circle cx="16" cy="16" r="3.5" fill="#fff" stroke="#8a96a8"/>'),
  floppy: (s) => svg(s, '<path d="M5 4h19l3 3v21H5z" fill="#3c5a86"/><rect x="9" y="4" width="12" height="8" fill="#dfe6ef"/><rect x="9" y="17" width="14" height="11" fill="#fff"/>'),
  controller: (s) => svg(s, '<rect x="4" y="10" width="24" height="12" rx="2" fill="#4b6b95"/><path d="M8 22v4M12 22v4M16 22v4M20 22v4M24 22v4" stroke="#4b6b95" stroke-width="2"/>'),
  folder: (s) => svg(s, '<path d="M3 8h10l2 3h14v15H3z" fill="#f6c343" stroke="#b58500"/>'),
  host: (s) => svg(s, '<rect x="3" y="5" width="26" height="17" rx="2" fill="#1f2a3a"/><rect x="5" y="7" width="22" height="13" fill="#3e8ef7"/><path d="M10 27h12M16 22v5" stroke="#1f2a3a" stroke-width="2.4"/>'),
  terminal: (s) => svg(s, '<rect x="3" y="5" width="26" height="22" rx="3" fill="#1e1e1e"/><path d="M8 12l5 4-5 4" fill="none" stroke="#e8e8e8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 21h8" stroke="#e8e8e8" stroke-width="2.2" stroke-linecap="round"/>'),
  assistant: (s) => svg(s, '<circle cx="16" cy="16" r="13" fill="#2e7d32"/><path d="M11 13a5 5 0 1 1 7 4.6c-1.2.5-2 1.4-2 2.6" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><circle cx="16" cy="24" r="1.7" fill="#fff"/>'),
  vbox: (s) => svg(s, '<defs><linearGradient id="gVB" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5ab0ff"/><stop offset="1" stop-color="#1557b0"/></linearGradient></defs><path d="M16 2l12 6.5v15L16 30 4 23.5v-15z" fill="url(#gVB)"/><path d="M16 2l12 6.5L16 15 4 8.5z" fill="#9dd0ff" opacity=".8"/><path d="M16 15v15" stroke="#0d3f86" stroke-width="1"/><text x="16" y="24" text-anchor="middle" font-size="9" font-weight="700" fill="#fff" font-family="Segoe UI,Arial">V</text>'),
  explorer: (s) => svg(s, '<path d="M3 8h10l2 3h14v15H3z" fill="#ffc83d"/><rect x="3" y="13" width="26" height="13" fill="#ffd968"/>'),
  close: (s) => svg(s, '<path d="M9 9l14 14M23 9L9 23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  up: (s) => svg(s, '<path d="M9 20l7-8 7 8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  down: (s) => svg(s, '<path d="M9 12l7 8 7-8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  caret: (s) => svg(s, '<path d="M10 13l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'),
  check: (s) => svg(s, '<path d="M7 17l6 6 12-14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'),
  mac: (s) => svg(s, '<path d="M25 13a9 9 0 1 0 0 6" fill="none" stroke="#2e9a1f" stroke-width="2.6" stroke-linecap="round"/><path d="M26 6v7h-7" fill="none" stroke="#2e9a1f" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  cable: (s) => svg(s, '<rect x="9" y="3" width="14" height="10" rx="1.5" fill="#4b6b95"/><path d="M12 13v3h8v-3M16 16v13" fill="none" stroke="#4b6b95" stroke-width="2.4"/>'),
  mouse: (s) => svg(s, '<rect x="9" y="4" width="14" height="24" rx="7" fill="#e0e0e0" stroke="#666"/><path d="M16 4v9M9 13h14" stroke="#666"/>'),
  keyboard: (s) => svg(s, '<rect x="3" y="9" width="26" height="15" rx="2" fill="#e0e0e0" stroke="#666"/><path d="M7 14h2M11 14h2M15 14h2M19 14h2M23 14h2M8 19h16" stroke="#666" stroke-width="1.8"/>'),
  cpu: (s) => svg(s, '<rect x="8" y="8" width="16" height="16" rx="2" fill="#4b6b95"/><path d="M11 4v4M16 4v4M21 4v4M11 24v4M16 24v4M21 24v4M4 11h4M4 21h4M24 11h4M24 21h4" stroke="#4b6b95" stroke-width="2"/>'),
  record: (s) => svg(s, '<rect x="3" y="9" width="20" height="14" rx="2" fill="#7a8899"/><path d="M23 13l6-3v12l-6-3z" fill="#7a8899"/><circle cx="9" cy="16" r="3" fill="#d32f2f"/>'),
};

export function icon(name, size = 16) { return (defs[name] || defs.info)(size); }

// Icono del SO con el indicador "64" como en VirtualBox
export function osIcon(osKey, size = 32) {
  const o = OS_TYPES[osKey] || OS_TYPES.other;
  if (o.family === 'windows') {
    const c = o.color;
    return `<svg class="ico os" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="6" fill="${c}"/><path d="M7 8.5l8-1.1v8H7zM16.5 7.2L25 6v9.5h-8.5zM7 17h8v8l-8-1.1zM16.5 17H25v9.5l-8.5-1.2z" fill="#fff" opacity=".95"/><text x="27" y="30" text-anchor="end" font-size="7.5" font-weight="700" fill="#fff" font-family="Segoe UI,Arial">${o.glyph === 'S' ? 'Srv' : o.glyph}</text></svg>`;
  }
  if (o.family === 'linux') {
    return `<svg class="ico os" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="6" fill="#33373e" stroke="rgba(255,255,255,.18)"/><ellipse cx="16" cy="18" rx="7.5" ry="9" fill="#fff"/><ellipse cx="16" cy="11" rx="6" ry="6.5" fill="#1a1a1a"/><circle cx="13.6" cy="10.3" r="1.5" fill="#fff"/><circle cx="18.4" cy="10.3" r="1.5" fill="#fff"/><circle cx="13.8" cy="10.5" r=".7" fill="#000"/><circle cx="18.2" cy="10.5" r=".7" fill="#000"/><path d="M13.6 13.2l2.4 1.6 2.4-1.6-2.4-.9z" fill="#f5a300"/><path d="M8 25.5l4-2.5 1.5 3.5zM24 25.5l-4-2.5-1.5 3.5z" fill="#f5a300"/><rect x="18.5" y="19" width="12" height="11" rx="3" fill="${o.color}"/><text x="24.5" y="27.6" text-anchor="middle" font-size="8.5" font-weight="700" fill="#fff" font-family="Segoe UI,Arial">${o.glyph}</text></svg>`;
  }
  return `<svg class="ico os" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="6" fill="#7a7a7a"/><text x="16" y="22" text-anchor="middle" font-size="16" font-weight="700" fill="#fff" font-family="Segoe UI,Arial">?</text></svg>`;
}

export function stateIcon(st, size = 14) {
  switch (st) {
    case 'running': return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 16 16"><path d="M4 2.5l9 5.5-9 5.5z" fill="#2e9a1f"/></svg>`;
    case 'paused': return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 16 16"><rect x="3.5" y="2.5" width="3" height="11" fill="#2a6fd6"/><rect x="9.5" y="2.5" width="3" height="11" fill="#2a6fd6"/></svg>`;
    case 'saved': return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="1.5" fill="#2a6fd6"/><rect x="4.5" y="2" width="7" height="4.5" fill="#cfe6ff"/><rect x="4" y="9" width="8" height="5" fill="#fff"/></svg>`;
    case 'aborted': return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="#c62828"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#fff" stroke-width="1.8"/></svg>`;
    default: return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="#c62828" stroke-width="1.6"/><path d="M8 3v5" stroke="#c62828" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  }
}
