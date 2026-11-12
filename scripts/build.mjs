// Genera dist/ para GitHub Pages: la web (módulos ES sin compilar) y una versión offline
// en un único archivo HTML con el CSS y el JavaScript incrustados.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync('index.html', 'dist/index.html');
cpSync('css', 'dist/css', { recursive: true });
cpSync('js', 'dist/js', { recursive: true });

const r = await build({ entryPoints: ['js/main.js'], bundle: true, format: 'iife', minify: true, target: 'es2020', write: false, legalComments: 'none' });
// un «</script» dentro del código cerraría la etiqueta antes de tiempo
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\/script');
const css = readFileSync('css/virtlab.css', 'utf8');
const html = readFileSync('index.html', 'utf8')
  .replace('<link rel="stylesheet" href="css/virtlab.css">', () => `<style>${css}</style>`)
  .replace('<script type="module" src="js/main.js"></script>', () => `<script>${js}</script>`)
  .replace('<title>VirtLab — Simulador de VirtualBox</title>', '<title>VirtLab — Simulador de VirtualBox (offline)</title>');
if (html.includes('src="js/main.js"') || !html.includes('<style>')) throw new Error('No se pudo incrustar el código en la versión offline');
writeFileSync('dist/virtlab-offline.html', html);
console.log(`dist/ listo · versión offline: ${(html.length / 1024).toFixed(0)} KB`);
