// Builds the single-file editor: storyline.html (no third-party runtime code).
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
function loadEsbuild() {
  const candidates = ['esbuild', resolve(process.cwd(), 'node_modules/esbuild'), '/opt/npm-tools/node_modules/esbuild'];
  for (const candidate of candidates) { try { return require(candidate); } catch { /* try next */ } }
  throw new Error('esbuild not found: run npm install, or set ESBUILD_PATH');
}
const esbuild = process.env.ESBUILD_PATH ? require(process.env.ESBUILD_PATH) : loadEsbuild();
const minify = !process.argv.includes('--dev');
const bundle = async (entry, define = {}) => {
  const result = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', platform: 'browser', target: ['chrome120', 'firefox120', 'safari17'], minify, legalComments: 'none', define, logLevel: 'warning' });
  return result.outputFiles[0].text;
};
const player = await bundle('src/player.js');
const editor = await bundle('src/editor.js', { __PLAYER_JS__: JSON.stringify(player) });
const css = await readFile('src/style.css', 'utf8');
const template = await readFile('src/index.html', 'utf8');
const html = template.replace('/* APP_CSS */', () => css).replace('/* APP_JS */', () => editor.replace(/<\/script/gi, '<\\/script'));
await writeFile('storyline.html', html);
console.log(`Built storyline.html: ${Buffer.byteLength(html)} bytes (player ${Buffer.byteLength(player)} bytes).`);
