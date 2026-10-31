// Real-browser verification of the built storyline.html (Chromium via Playwright, file://).
// Usage: node test/browser/run.mjs [evidence-dir]
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH ?? ['playwright', '/home/claude/.npm-global/lib/node_modules/playwright'].find(p => { try { require.resolve(p); return true; } catch { return false; } });
if (!playwrightPath) { console.error('Playwright is not installed; browser verification skipped (FAIL).'); process.exit(2); }
const { chromium } = require(playwrightPath);
const evidence = resolve(process.argv[2] ?? 'docs/evidence');
await mkdir(evidence, { recursive: true });
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const results = []; let failures = 0;
const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failures++; console.log(results.at(-1)); };

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
// The native file picker cannot be driven by automation; the editor falls back to the file input without it.
await context.addInitScript(() => { delete window.showOpenFilePicker; });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('dialog', d => d.accept());
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
const shot = name => page.screenshot({ path: `${evidence}/${name}.png` });
const source = () => page.locator('#source textarea');
const frame = () => page.frames().find(f => f.name().startsWith('session_'));
const status = () => page.locator('#file-status').innerText();

await page.goto('file://' + resolve('storyline.html'));
await page.waitForTimeout(500);
check('page loads', await page.locator('.passage-card').count() === 3, `${await page.locator('.passage-card').count()} cards`);
await shot('01-editor');

// Title edit renames the passage and rewrites links.
await page.click('.passage-item:nth-child(2)');
await page.waitForTimeout(300);
await page.fill('#passage-title', 'Iron gate');
await page.waitForTimeout(300);
check('title edit updates ID', await page.locator('#passage-id').innerText() === 'Iron_gate');
check('title edit rewrites heading', (await source().inputValue()).startsWith('# Iron gate'));
await page.click('.passage-item:nth-child(1)');
await page.waitForTimeout(300);
check('title edit rewrites links elsewhere', (await source().inputValue()).includes('[Iron_gate]'), (await source().inputValue()).split('\n').at(-1));

// Heading edit in source renames too.
await source().click(); await page.keyboard.press('Control+Home'); await page.keyboard.press('End'); await page.keyboard.type(' at dusk');
await page.waitForTimeout(400);
check('# heading renames passage', await page.locator('#passage-title').inputValue() === 'Arrival at dusk' && await page.locator('#passage-id').innerText() === 'Arrival_at_dusk');
await page.keyboard.press('Control+Z'); await page.waitForTimeout(300);
check('undo restores title', await page.locator('#passage-title').inputValue() === 'Arrival');

// Autocomplete.
await source().click(); await page.keyboard.press('Control+End'); await page.keyboard.type('\n\nThen [Cou');
await page.waitForTimeout(250);
check('autocomplete opens for [', !(await page.locator('#source .code-complete').isHidden()));
await page.keyboard.press('Enter'); await page.waitForTimeout(200);
check('autocomplete inserts link', (await source().inputValue()).endsWith('Then [Courtyard]'));
await page.keyboard.type('\n$pl'); await page.waitForTimeout(250);
const items = await page.locator('#source .code-complete div').allInnerTexts();
check('autocomplete lists variables for $', items.some(t => t.includes('player.gold')), items.slice(0, 3).join(', '));
await page.keyboard.press('Escape'); await page.keyboard.press('Shift+Home'); await page.keyboard.press('Backspace');
await page.keyboard.type('\n@aw'); await page.waitForTimeout(250);
check('autocomplete lists macros for @', (await page.locator('.code-complete div').allInnerTexts()).some(t => t.includes('awardCoin')));
await page.keyboard.press('Enter');
await shot('02-autocomplete');

// Diagnostics for a missing passage.
await page.keyboard.type('\n[Nowhere]'); await page.waitForTimeout(400);
check('missing passage diagnostic', (await page.locator('#diagnostics').innerText()).includes('Missing passage'));
check('squiggle drawn', await page.locator('.squiggle.error').count() > 0);
await page.keyboard.press('Shift+Home'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
await page.keyboard.press('Shift+Home'); await page.keyboard.press('Backspace'); await page.waitForTimeout(300); // remove [Nowhere] and @awardCoin again
check('diagnostic cleared', !(await page.locator('#diagnostics').innerText()).includes('Missing passage'), (await source().inputValue()).split('\n').slice(-3).join(' | '));

// Drag-to-link from the Courtyard card to Iron gate.
await page.click('#fit'); await page.waitForTimeout(400);
const port = page.locator('.passage-card[data-id="Courtyard"] .card-port'), target = page.locator('.passage-card[data-id="Iron_gate"]');
const pb = await port.boundingBox(), tb = await target.boundingBox();
await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2); await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(pb.x + (tb.x + tb.width / 2 - pb.x) * i / 10, pb.y + (tb.y + tb.height / 2 - pb.y) * i / 10);
await page.waitForTimeout(100); await shot('03-drag-link'); await page.mouse.up(); await page.waitForTimeout(400);
check('drag-to-link appends link', await page.locator('#passage-id').innerText() === 'Courtyard' && (await source().inputValue()).trimEnd().endsWith('[Iron_gate]'));

// Auto-layout.
await page.click('#auto-layout'); await page.waitForTimeout(500);
const boxes = await page.locator('.passage-card').evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }));
const overlap = boxes.some((a, i) => boxes.some((b, j) => i !== j && a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]));
check('auto-layout has no overlapping cards', !overlap);
await shot('04-auto-layout');

// Image attach.
const imagePath = `${evidence}/fixture.png`; await writeFile(imagePath, Buffer.from(PNG, 'base64'));
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#add-image')]);
await chooser.setFiles(imagePath); await page.waitForTimeout(500);
check('image attached', !(await page.locator('#image-preview').isHidden()) && (await page.locator('#image-name').innerText()).includes('1×1'));
await page.fill('#image-caption', 'A test image'); await page.waitForTimeout(300);

// Preview: try passage, choose, state.
await page.click('.passage-item:nth-child(1)'); await page.waitForTimeout(300);
await page.click('#preview'); await page.waitForTimeout(900);
check('preview docked', !(await page.locator('#preview-column').isHidden()) && !!frame(), `error: ${await frame().locator('#error').innerText()} · story: ${(await frame().locator('#story').innerText()).slice(0, 60)}`);
await frame().locator('.story-option').nth(1).click(); await page.waitForTimeout(500);
check('choice continues the passage', (await frame().locator('#story').innerText()).includes('Iron gate') || (await frame().locator('#reveal-status').innerText()).includes('of'));
await page.click('#toggle-debug'); await page.waitForTimeout(200);
check('state view shows the change graphically', await page.locator('.state-row.changed').count() >= 1 && /observations \(1\)/i.test(await page.locator('#state-view').innerText()), (await page.locator('#state-view').innerText()).replace(/\n/g, ' / ').slice(0, 400));
await page.check('#state-raw'); await page.waitForTimeout(100);
check('raw JSON state still available', (await page.locator('#debug').innerText()).includes('"empathy": 1'));
await page.uncheck('#state-raw');
check('simulator undo is offered after a choice', !(await page.locator('#preview-undo').isDisabled()));
await page.click('#preview-undo'); await page.waitForTimeout(500);
check('undo reopens the choice', await frame().locator('.story-option:not([disabled])').count() === 2 && (await page.locator('#state-view').innerText()).includes('-1'));
await frame().locator('.story-option').nth(1).click(); await page.waitForTimeout(500);
await page.click('#expand-preview'); await page.waitForTimeout(300);
check('full-window simulation hides the editor', await page.locator('#editor-column').isHidden() && !(await page.locator('#preview-column').isHidden()));
await shot('14-full-window');
await page.keyboard.press('Escape'); await page.waitForTimeout(300);
check('Escape docks the simulation again', !(await page.locator('#editor-column').isHidden()));
check('playing passage marked on the map', await page.locator('.passage-card.playing').count() === 1);
check('continuation revealed the next step', (await frame().locator('#reveal-status').innerText()).startsWith('2 of 2'), await frame().locator('#reveal-status').innerText());
await frame().locator('.story-link').first().click(); await page.waitForTimeout(600);
check('preview navigation selects passage in editor', await page.locator('#passage-id').innerText() === 'Iron_gate');
await shot('05-preview');
// Macro requires approval
await page.click('.passage-item:nth-child(3)'); await page.waitForTimeout(900);
check('macro without approval reports', (await page.locator('#play-diagnostic').innerText()).includes('JavaScript approval'));
await page.click('#enable-js'); await page.waitForTimeout(200); await page.click('#confirm-ok'); await page.waitForTimeout(900);
check('macro runs after approval', (await frame().locator('#story').innerText()).includes('A coin glints'));
check('passage image shown in preview', await frame().locator('.story-image img').count() === 1);
await shot('06-macro-run');

// Variables window.
await page.click('#variables'); await page.waitForTimeout(300);
await page.click('#variable-add'); await page.locator('#variables-rows tr:last-child input.path').fill('player.mood'); await page.locator('#variables-rows tr:last-child input.path').press('Tab');
await page.locator('#variables-rows tr:last-child input:not(.path)').fill('curious'); await page.locator('#variables-rows tr:last-child input:not(.path)').press('Tab');
await shot('07-variables');
await page.click('#variables-form button[type=submit]'); await page.waitForTimeout(300);
await page.click('#variables'); await page.waitForTimeout(200);
check('variables window round-trips a new variable', (await page.locator('#variables-rows input.path').evaluateAll(nodes => nodes.map(n => n.value))).includes('player.mood'));
await page.click('#variables-cancel');

// Macros window.
await page.click('#macros'); await page.waitForTimeout(300);
await shot('08-macros');
check('macros window shows code editor', (await page.locator('#macro-code textarea').inputValue()).includes("ctx.set('player.gold'"));
await page.click('#macros-cancel');

// Light theme.
await page.click('#file-menu-button'); await page.click('#theme-toggle'); await page.waitForTimeout(300);
check('light theme applied', await page.evaluate(() => document.documentElement.dataset.theme) === 'light');
await shot('09-light-theme');
await page.click('#file-menu-button'); await page.click('#theme-toggle'); await page.waitForTimeout(200);

// Download ZIP and reopen.
const [download] = await Promise.all([page.waitForEvent('download'), page.click('#file-menu-button').then(() => page.click('#download'))]);
const zipPath = `${evidence}/roundtrip.zip`; await download.saveAs(zipPath);
check('zip download', (await readFile(zipPath)).length > 500);
const [opener] = await Promise.all([page.waitForEvent('filechooser'), page.click('#file-menu-button').then(() => page.click('#open'))]);
await opener.setFiles(zipPath); await page.waitForTimeout(400);
if (await page.locator('#confirm-dialog').evaluate(d => d.open)) await page.click('#confirm-ok');
await page.waitForTimeout(600);
check('zip reopens with same passages', await page.locator('.passage-item').count() === 3 && (await status()).includes('Opened'), await status());
check('image survives zip round trip', await page.locator('.passage-card .card-image').count() === 1);

// Bundled example (two acts).
const [opener3] = await Promise.all([page.waitForEvent('filechooser'), page.click('#file-menu-button').then(() => page.click('#open'))]);
await opener3.setFiles(resolve('examples/city-gate.zip')); await page.waitForTimeout(400);
if (await page.locator('#confirm-dialog').evaluate(d => d.open)) await page.click('#confirm-ok');
await page.waitForTimeout(600);
check('example opens with two acts', await page.locator('#act-select option').count() === 2 && (await status()).includes('Opened'), await status());
await page.click('#play'); await page.waitForTimeout(900);
check('example plays', (await frame().locator('#story').innerText()).includes('Rain hangs in the air'));
await page.click('#close-preview'); await page.waitForTimeout(200);
// Acts, duplicate, delete, rename story, help.
await page.click('#act-menu-button'); await page.click('#add-act'); await page.fill('#act-name', 'Act Two'); await page.click('#act-form button[type=submit]'); await page.waitForTimeout(400);
check('new act opens its entry passage', (await page.locator('#act-select option').allInnerTexts()).some(t => t.startsWith('Act Two')) && await page.locator('#passage-id').innerText() === 'Act_Two_opening');
await page.click('#passage-menu-button'); await page.click('#duplicate'); await page.waitForTimeout(300);
check('duplicate creates a copy', (await page.locator('#passage-title').inputValue()).endsWith('(copy)') && await page.locator('.passage-item').count() === 2);
await page.click('#passage-menu-button'); await page.click('#delete'); await page.waitForTimeout(200); await page.click('#delete-form button[type=submit]'); await page.waitForTimeout(300);
check('delete removes the copy', await page.locator('.passage-item').count() === 1);
await page.selectOption('#act-select', { index: 0 }); await page.waitForTimeout(400);
check('act switch selects the act entry', await page.locator('.passage-item').count() === 3 && await page.locator('#passage-id').innerText() === 'Arrival');
await page.click('#project-title'); await page.fill('#prompt-input', 'Renamed story'); await page.click('#prompt-form button[type=submit]'); await page.waitForTimeout(200);
check('story title rename', await page.locator('#project-title').innerText() === 'Renamed story');
await page.keyboard.press('Control+z'); await page.waitForTimeout(200);
check('Ctrl+Z undoes outside the editor', await page.locator('#project-title').innerText() === 'The City Gate');
await page.click('#help-inline'); await page.waitForTimeout(200);
check('help dialog opens', await page.locator('#help-dialog').evaluate(d => d.open) && (await page.locator('#help-body').innerText()).includes('? condition'));
await shot('12-help'); await page.click('#help-close');
// Autosave draft: edit, reload, restore.
await page.click('.passage-item:nth-child(1)'); await page.waitForTimeout(200);
await source().click(); await page.keyboard.press('Control+End'); await page.keyboard.type('\n\nDraft marker line.'); await page.waitForTimeout(3500);
await page.reload(); await page.waitForTimeout(800);
check('draft banner after reload', !(await page.locator('#banner').isHidden()) && (await page.locator('#banner-text').innerText()).includes('Unsaved draft'), await page.locator('#banner-text').innerText());
await page.click('#banner-restore'); await page.waitForTimeout(600);
check('draft restores edits and acts', (await page.locator('#source textarea').inputValue()).includes('Draft marker line.') && (await page.locator('#passage-id').innerText()) === 'Arrival' && await page.locator('#act-select option').count() === 3, await page.locator('#file-status').innerText());
await shot('13-draft-restored');
check('no console or page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await writeFile(`${evidence}/browser-results.txt`, `${new Date().toISOString()}\nChromium ${browser.version()} via Playwright, file://storyline.html\n\n${results.join('\n')}\n`);
await browser.close();
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
