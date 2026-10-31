// Static validation: every source module must parse and bundle without warnings.
import { createRequire } from 'node:module';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
let esbuild;
for (const candidate of ['esbuild', resolve(process.cwd(), 'node_modules/esbuild'), '/opt/npm-tools/node_modules/esbuild']) { try { esbuild = require(candidate); break; } catch { /* next */ } }
if (!esbuild) throw new Error('esbuild not found');
const files = (await readdir('src')).filter(name => name.endsWith('.js')).map(name => `src/${name}`);
const result = await esbuild.build({ entryPoints: files, bundle: false, write: false, outdir: '/tmp/storyline-check', format: 'esm', logLevel: 'silent', target: 'es2022' });
if (result.warnings.length) { console.error(result.warnings); process.exit(1); }
for (const entry of ['src/editor.js', 'src/player.js']) {
  const bundled = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', platform: 'browser', define: { __PLAYER_JS__: '""' }, logLevel: 'silent', metafile: true });
  const external = Object.keys(bundled.metafile.inputs).filter(path => path.includes('node_modules'));
  if (external.length) { console.error(`Unexpected third-party code in ${entry}:`, external); process.exit(1); }
  if (bundled.warnings.length) { console.error(bundled.warnings); process.exit(1); }
}
console.log(`check: ${files.length} modules parse; editor and player bundle with no third-party code.`);
