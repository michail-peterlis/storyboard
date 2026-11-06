import { History, newProject, cloneProject, sameProject, passageIdForTitle } from './model.js';
import { compileProject, knownVariables } from './compiler.js';
import { renamePassage, appendLink, insertSnippet } from './commands.js';
import { getActs, ensureActs, actForPassage, passagesInAct, actViewport, addAct, attachPassage, movePassage, mergeAct, removePassage } from './acts.js';
import { autoLayout, snapPosition } from './layout.js';
import { createCodeEditor } from './code-editor.js';
import { createMap } from './map.js';
import { initializePassageList } from './passage-list.js';
import { initializeWorkspaceLayout } from './workspace-layout.js';
import { createPreview } from './preview.js';
import { createVariablesWindow } from './variables-window.js';
import { createMacrosWindow } from './macros-window.js';
import { createFileActions } from './files-ui.js';
import { processImage } from './images.js';
import { HELP_HTML } from './help.js';
import { createDraftStore } from './storage.js';

const byId = id => document.getElementById(id);
const history = new History(newProject());
let selectedId = history.project.startPassageId, compiled = new Map(), compileCache = new Map(), compileSignature = '';
let savedSnapshot = null, renameWarning = null, refreshTimer = null, imageRequest = null, selectedEdge = null;
const viewports = new Map(); // actId → viewport (kept out of undo history)
const project = () => history.project;
const passage = () => project().passages.find(p => p.id === selectedId);
const currentAct = () => actForPassage(project(), selectedId) ?? getActs(project())[0];
const visiblePassages = () => passagesInAct(project(), currentAct().id);
const status = text => { byId('file-status').textContent = text; };

// ---- Dialog helpers ----------------------------------------------------------------
function confirmDialog(heading, text, okLabel = 'OK') {
  return new Promise(resolve => {
    const dialog = byId('confirm-dialog'); byId('confirm-heading').textContent = heading; byId('confirm-text').textContent = text; byId('confirm-ok').textContent = okLabel;
    const done = value => { dialog.removeEventListener('close', onClose); resolve(value); };
    const onClose = () => done(dialog.returnValue === 'ok');
    dialog.addEventListener('close', onClose); byId('confirm-cancel').onclick = () => dialog.close('cancel');
    dialog.returnValue = ''; dialog.showModal();
  });
}
window.confirmDialog = confirmDialog;
function promptDialog(heading, label, value = '') {
  return new Promise(resolve => {
    const dialog = byId('prompt-dialog'); byId('prompt-heading').textContent = heading; byId('prompt-label').firstChild.textContent = `${label} `; byId('prompt-input').value = value;
    let result = null;
    const onClose = () => { dialog.removeEventListener('close', onClose); resolve(result); };
    dialog.addEventListener('close', onClose);
    byId('prompt-form').onsubmit = event => { event.preventDefault(); result = byId('prompt-input').value; dialog.close(); };
    byId('prompt-cancel').onclick = () => dialog.close();
    dialog.showModal(); byId('prompt-input').select();
  });
}
// ---- Menus -------------------------------------------------------------------------
for (const menu of document.querySelectorAll('.menu')) {
  const button = menu.querySelector('.menu-button'), list = menu.querySelector('.menu-list');
  button.addEventListener('click', event => {
    event.stopPropagation(); const open = list.hidden;
    document.querySelectorAll('.menu-list').forEach(l => { l.hidden = true; });
    if (!open) { button.setAttribute('aria-expanded', 'false'); return; }
    // Fixed positioning keeps menus above every panel and out of clipped toolbars.
    const rect = button.getBoundingClientRect(), right = rect.left > window.innerWidth / 2;
    list.classList.toggle('right', right); list.style.left = `${right ? rect.right : rect.left}px`; list.style.top = `${rect.bottom + 4}px`;
    list.hidden = false; button.setAttribute('aria-expanded', 'true');
    const overflow = list.getBoundingClientRect().bottom - window.innerHeight + 8; if (overflow > 0) list.style.top = `${Math.max(8, rect.bottom + 4 - overflow)}px`;
  });
  list.addEventListener('click', event => { if (event.target.closest('button')) { list.hidden = true; button.setAttribute('aria-expanded', 'false'); } });
}
document.addEventListener('click', () => document.querySelectorAll('.menu-list').forEach(l => { l.hidden = true; }));
document.addEventListener('keydown', event => { if (event.key === 'Escape') document.querySelectorAll('.menu-list').forEach(l => { l.hidden = true; }); });

// ---- Components ---------------------------------------------------------------------
const workspaceLayout = initializeWorkspaceLayout(document, window);
const sourceEditor = createCodeEditor(byId('source'), {
  onChange(value) {
    try {
      if (history.changeSource(selectedId, value, `source:${selectedId}`)) { touched = true; markChanged(); scheduleRefresh(); preview.sourceChanged(); }
    } catch (error) { status(`Error: ${error.message}`); sourceEditor.value = passage().source; }
  },
  onUndo: () => travel('undo'), onRedo: () => travel('redo'),
  completions: completionsAt, placeholder: 'Write the passage here. Try # Title, > event, - Name: line, * choice [target]…'
});
const passageList = initializePassageList(document, id => select(id, { center: true }));
const map = createMap(byId('map'), {
  positionOf: id => project().passages.find(p => p.id === id)?.position ?? { x: 0, y: 0 },
  titleOf: id => project().passages.find(p => p.id === id)?.title ?? id,
  onSelect: (id, options) => select(id, options),
  onOpen: id => select(id, { center: false, focus: true }),
  onMove: (id, position) => change(p => { p.passages.find(x => x.id === id).position = position; }),
  onPreviewMove: (id, position) => renderMap(id ? { id, position } : null),
  onLink: (from, to) => {
    if (change(p => { const source = p.passages.find(x => x.id === from); source.source = appendLink(source.source, to); })) { select(from, { center: false }); status(`Linked “${title(from)}” → “${title(to)}”.`); }
  },
  onViewport: view => { viewports.set(currentAct().id, { ...view }); },
  onEdge: edge => { selectedEdge = edge; if (edge) { select(edge.from, { center: false }); byId('connections').parentElement.open = true; highlightConnection(edge); } else renderConnections(); },
  onZoomLabel: zoom => { byId('zoom-label').value = `${Math.round(zoom * 100)}%`; }
});
let playingId = null;
const preview = createPreview(document, { playerJs: __PLAYER_JS__, getProject: () => project(), getTheme: () => workspaceLayout.theme, onStatus: status,
  onNavigate: id => { playingId = project().passages.some(p => p.id === id) ? id : null; if (playingId && id !== selectedId) select(id, { center: true, fromPreview: true }); else renderMap(); },
  onStop: () => { playingId = null; renderMap(); } });
const variablesWindow = createVariablesWindow(document, { getProject: () => project(), apply: values => change(p => Object.assign(p, values)) });
const macrosWindow = createMacrosWindow(document, { getProject: () => project(), apply: macros => change(p => { p.customMacros = macros; }) });
const files = createFileActions(document, {
  loadProject, getProject: () => withViewports(project()), status, prompt: promptDialog, confirm: confirmDialog,
  confirmDiscard: async () => !(touched && isDirty()) || confirmDialog('Discard unsaved changes?', 'The current project has unsaved changes. Opening another project will discard them.', 'Discard'),
  markSaved: () => { savedSnapshot = withViewports(project()); drafts.clear().catch(() => {}); refresh({ editor: false }); },
  onTargetChange: target => { byId('save-json').textContent = target ? `Save to ${target.kind === 'folder' ? 'folder' : 'ZIP'}` : 'Save'; }
});
// ---- Autosave draft (IndexedDB) --------------------------------------------------
const drafts = createDraftStore();
let draftTimer = null, draftBusy = false, draftDirty = false, touched = false; // touched: the user edited since the project was loaded
function scheduleDraft(dirty = isDirty()) {
  if (!drafts.available || !touched || !dirty) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(async () => {
    if (draftBusy) { draftDirty = true; return; }
    draftBusy = true; draftDirty = false;
    try { await drafts.save(withViewports(project()), { target: files.target }); byId('dirty').title = `Draft kept in this browser at ${new Date().toLocaleTimeString()}`; }
    catch (error) { byId('dirty').title = `Draft not kept: ${error.message}`; }
    finally { draftBusy = false; if (draftDirty) scheduleDraft(); }
  }, 2500);
}
function showBanner(text, { restore = null, discard = null } = {}) {
  byId('banner-text').textContent = text; byId('banner').hidden = false;
  byId('banner-restore').hidden = !restore; byId('banner-restore').onclick = restore;
  byId('banner-discard').onclick = discard ?? (() => { byId('banner').hidden = true; });
}
async function offerDraft() {
  let draft;
  try { draft = await drafts.peek(); } catch { return; }
  if (!draft) return;
  const when = new Date(draft.savedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  showBanner(`Unsaved draft of “${draft.title}” from ${when} was kept in this browser.`, {
    restore: async () => {
      try {
        const full = await drafts.load();
        loadProject(full.project, { saved: false, message: `Draft of “${full.title}” restored — use Save to write it to your project files.` });
        byId('banner').hidden = true;
        if (full.meta?.target) status(`Draft restored. It was last saved to ${full.meta.target.name}; choose that location again when you save.`);
      } catch (error) { status(`Could not restore the draft: ${error.message}`); }
    },
    discard: async () => { byId('banner').hidden = true; try { await drafts.clear(); } catch { /* ignore */ } }
  });
}
const title = id => project().passages.find(p => p.id === id)?.title ?? id;

// ---- Project state -------------------------------------------------------------------
function withViewports(p) {
  // Inject the live viewports into a copy of the project for saving/dirty checks.
  const copy = cloneProject(p);
  if (viewports.size) { const acts = ensureActs(copy); for (const act of acts) if (viewports.has(act.id)) act.viewport = { ...viewports.get(act.id) }; if (acts.length === 1 && viewports.has(acts[0].id)) copy.editor.viewport = { ...viewports.get(acts[0].id) }; }
  return copy;
}
function isDirty() { return !savedSnapshot || !sameProject(savedSnapshot, withViewports(project())); }
function markChanged() { const dirty = isDirty(); byId('dirty').textContent = dirty ? '● Unsaved changes' : '✓ Saved'; byId('dirty').classList.toggle('dirty', dirty); scheduleDraft(dirty); }
function loadProject(next, { saved = false, message = 'Project opened.' } = {}) {
  preview.close(); passageList.clear(); viewports.clear(); compileCache.clear(); renameWarning = null;
  history.reset(next); touched = false; clearTimeout(draftTimer);
  for (const act of getActs(project())) viewports.set(act.id, { ...act.viewport });
  selectedId = project().startPassageId; savedSnapshot = saved ? withViewports(project()) : null;
  refresh(); requestAnimationFrame(() => { initialView(); status(message); });
}
const storySignature = p => JSON.stringify([p.passages.map(x => [x.id, x.title, x.source]), p.initialGameState, p.initialVariables, p.traitDefaults, p.customMacros, p.startPassageId]);
function change(mutate, { group = null, nextSelection = null, editor = true } = {}) {
  const macrosBefore = JSON.stringify(project().customMacros), storyBefore = storySignature(project());
  try {
    if (!history.change(mutate, group)) return false;
    touched = true;
    if (nextSelection !== null) selectedId = nextSelection;
    if (macrosBefore !== JSON.stringify(project().customMacros)) preview.revokeTrust();
    if (storyBefore !== storySignature(project())) preview.sourceChanged();
    markChanged(); refresh({ editor }); return true;
  } catch (error) { status(`Error: ${error.message}`); return false; }
}
function travel(direction) {
  const macrosBefore = JSON.stringify(project().customMacros), previousAct = currentAct().id;
  if (!history[direction]()) return;
  touched = true;
  if (!passage()) selectedId = getActs(project()).find(act => act.id === previousAct)?.startPassageId ?? project().startPassageId;
  if (macrosBefore !== JSON.stringify(project().customMacros)) preview.revokeTrust();
  renameWarning = null; markChanged(); refresh(); preview.sourceChanged(); status(direction === 'undo' ? 'Undone.' : 'Redone.');
}
function compileAll() {
  const p = project();
  const signature = JSON.stringify([p.passages.map(x => [x.id, x.title]), p.initialGameState, p.initialVariables, p.traitDefaults, p.customMacros.map(m => [m.id, m.targets])]);
  if (signature !== compileSignature) { compileCache.clear(); compileSignature = signature; }
  const unchanged = p.passages.every(x => compileCache.get(x.id)?.source === x.source);
  if (unchanged && compiled.size === p.passages.length) return;
  compiled = compileProject(p);
  compileCache = new Map(p.passages.map(x => [x.id, { source: x.source }]));
}
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh({ editor: false }), 140); }

// ---- Rendering ----------------------------------------------------------------------
function refresh({ editor = true } = {}) {
  clearTimeout(refreshTimer);
  if (!passage()) selectedId = project().startPassageId;
  compileAll();
  syncTitleFromSource();
  const p = project(), current = passage(), result = compiled.get(current.id), act = currentAct();
  if (editor) sourceEditor.value = current.source;
  sourceEditor.setDiagnostics(result.diagnostics); // measures the editor while layout is still clean, before the writes below
  byId('project-title').textContent = p.title; document.title = `${p.title} — Storyline`;
  const errors = [...compiled.values()].reduce((sum, r) => sum + r.errors, 0), warnings = [...compiled.values()].reduce((sum, r) => sum + r.diagnostics.length - r.errors, 0);
  byId('counts').textContent = `${getActs(p).length} act${getActs(p).length === 1 ? '' : 's'} · ${p.passages.length} passage${p.passages.length === 1 ? '' : 's'}${errors ? ` · ${errors} error${errors === 1 ? '' : 's'}` : ''}${warnings ? ` · ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}`;
  renderActs();
  if (document.activeElement !== byId('passage-title')) byId('passage-title').value = current.title;
  byId('passage-id').textContent = current.id;
  const badges = [];
  if (current.id === p.startPassageId) badges.push(['start', '★ story start']);
  if (current.id === act.startPassageId) badges.push(['entry', 'act entry']);
  byId('passage-badges').replaceChildren(...badges.map(([cls, text]) => { const b = document.createElement('span'); b.className = `badge ${cls}`; b.textContent = text; return b; }));
  byId('set-start').disabled = current.id === p.startPassageId; byId('set-act-start').disabled = current.id === act.startPassageId;
  byId('delete').disabled = act.passageIds.length === 1; byId('delete').title = act.passageIds.length === 1 ? 'An act needs one passage; merge the act instead.' : '';
  renderImage(); renderDiagnostics(result); renderConnections();
  passageList.render(visiblePassages(), selectedId, p.startPassageId, compiled);
  renderMap();
  byId('undo').disabled = !history.undoStack.length; byId('redo').disabled = !history.redoStack.length;
  byId('preview').title = `Try “${current.title}” in the preview`;
  markChanged();
  if (renameWarning) status(`Review JavaScript IDs in macro(s) ${renameWarning.macrosToReview.join(', ')}: ${renameWarning.oldId} → ${renameWarning.id}. Macro code is not rewritten.`);
}
function syncTitleFromSource() {
  // `# Title` in the source renames the passage (ID follows the title).
  const current = passage(), result = compiled.get(current.id);
  if (result?.title === null || result?.title === undefined || result.title === current.title || !result.title) return;
  const newTitle = result.title;
  try {
    const outcome = renamePassage(cloneProject(project()), current.id, newTitle);
    if (history.change(p => { renamePassage(p, current.id, newTitle); }, `source:${current.id}`)) {
      selectedId = outcome.id; compileAll();
      if (outcome.macrosToReview.length) renameWarning = outcome;
    }
  } catch (error) { status(`Error: ${error.message}`); }
}
function renderActs() {
  const acts = getActs(project()), active = currentAct();
  const options = JSON.stringify(acts.map(act => [act.id, act.title, act.passageIds.length]));
  if (byId('act-select').dataset.signature !== options) {
    byId('act-select').dataset.signature = options;
    for (const id of ['act-select', 'passage-act']) byId(id).replaceChildren(...acts.map(act => { const o = document.createElement('option'); o.value = act.id; o.textContent = id === 'act-select' ? `${act.title} (${act.passageIds.length})` : act.title; return o; }));
  }
  for (const id of ['act-select', 'passage-act']) if (byId(id).value !== active.id) byId(id).value = active.id;
  byId('passage-act').disabled = acts.length < 2 || active.passageIds.length === 1; byId('passage-act').hidden = acts.length < 2;
  byId('merge-act').disabled = acts.length < 2;
}
function renderMap(override = null) {
  const act = currentAct();
  const viewport = viewports.get(act.id) ?? actViewport(project(), act.id);
  if (!viewports.has(act.id)) viewports.set(act.id, { ...viewport });
  const titles = new Map(project().passages.map(p => [p.id, p.title]));
  map.render({ passages: visiblePassages(), edges: [...compiled.values()].flatMap(r => r.edges), viewport, selectedId, playingId, startId: project().startPassageId, actEntryId: act.startPassageId, compiled, override, titles });
}
function renderImage() {
  const image = passage().image ?? null;
  byId('image-preview').hidden = !image; byId('replace-image').hidden = !image; byId('remove-image').hidden = !image; byId('image-caption').hidden = !image; byId('add-image').hidden = !!image;
  byId('image-name').textContent = image ? `${image.name} · ${image.width}×${image.height}` : 'No image — one illustration per passage, shown when it starts.';
  if (image) { if (byId('image-thumb').src !== image.dataUrl) byId('image-thumb').src = image.dataUrl; byId('image-thumb').alt = image.caption || image.name; if (document.activeElement !== byId('image-caption')) byId('image-caption').value = image.caption; }
}
function renderDiagnostics(result) {
  const list = byId('diagnostics'); list.replaceChildren();
  byId('diagnostic-summary').textContent = `Diagnostics${result.diagnostics.length ? ` (${result.errors ? `${result.errors} error${result.errors === 1 ? '' : 's'}` : ''}${result.errors && result.diagnostics.length - result.errors ? ', ' : ''}${result.diagnostics.length - result.errors ? `${result.diagnostics.length - result.errors} warning${result.diagnostics.length - result.errors === 1 ? '' : 's'}` : ''})` : ''}`;
  for (const d of result.diagnostics) {
    const li = document.createElement('li'), button = document.createElement('button'); button.type = 'button'; button.className = `diag-${d.severity}`; button.textContent = `${d.line}:${d.column} — ${d.message}`;
    button.addEventListener('click', () => { sourceEditor.focus(); sourceEditor.setSelectionRange(d.range[0], Math.max(d.range[1], d.range[0] + 1)); });
    li.append(button); list.append(li);
  }
  if (!result.diagnostics.length) { const li = document.createElement('li'); li.innerHTML = '<span class="ok">No problems in this passage.</span>'; list.append(li); }
}
function renderConnections() {
  const result = compiled.get(selectedId), list = byId('connections'); list.replaceChildren();
  const incoming = [...compiled.values()].flatMap(r => r.edges).filter(e => e.to === selectedId && e.from !== selectedId);
  byId('connections-summary').textContent = `Connections (${result.edges.length} out · ${incoming.length} in)`;
  for (const edge of result.edges) {
    const li = document.createElement('li'); li.dataset.range = edge.range.join(',');
    const target = project().passages.find(p => p.id === edge.to);
    li.append(`→ ${target ? target.title : `missing “${edge.to}”`}${edge.label ? ` · ${edge.label}` : ''}${edge.kind === 'macro' ? ` · @${edge.macroId}` : ''}`);
    if (edge.kind === 'source') { const show = document.createElement('button'); show.type = 'button'; show.textContent = 'Show in source'; show.addEventListener('click', () => { sourceEditor.focus(); sourceEditor.setSelectionRange(edge.range[0], edge.range[1]); }); li.append(show); }
    if (target) { const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Open'; open.addEventListener('click', () => select(target.id, { center: true })); li.append(open); }
    list.append(li);
  }
  for (const edge of incoming) {
    const li = document.createElement('li'); li.append(`← ${title(edge.from)}${edge.label ? ` · ${edge.label}` : ''}`);
    const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Open'; open.addEventListener('click', () => select(edge.from, { center: true })); li.append(open); list.append(li);
  }
  if (!result.edges.length && !incoming.length) { const li = document.createElement('li'); li.innerHTML = '<span class="ok">No links yet. Write [Passage] or drag the card port to another card.</span>'; list.append(li); }
}
function highlightConnection(edge) { renderConnections(); sourceEditor.setSelectionRange(edge.range[0], edge.range[1]); }
function select(id, { center = true, focus = false, fromPreview = false } = {}) {
  if (!project().passages.some(p => p.id === id)) return;
  const actChanged = actForPassage(project(), id)?.id !== currentAct().id, changed = id !== selectedId;
  selectedId = id; renameWarning = null; refresh();
  if (changed && !fromPreview) preview.followSelection(id);
  const target = passage();
  if (center || actChanged) requestAnimationFrame(() => { if (!map.isVisible(target.position, target.id) || center) map.centerOn(target.position, target.id, { animated: !actChanged }); });
  if (focus) sourceEditor.focus();
}

// ---- Autocomplete --------------------------------------------------------------------
function completionsAt(text, position) {
  const lineStart = text.lastIndexOf('\n', position - 1) + 1, before = text.slice(lineStart, position);
  let match;
  if ((match = /\[\?([A-Za-z0-9_.]*)$/.exec(before))) {
    const prefix = match[1].toLowerCase(), from = position - match[0].length;
    return { from, to: position, items: knownVariables(project(), compiled).filter(v => v.toLowerCase().includes(prefix)).map(v => ({ label: v, kind: '[?', detail: 'input', insert: `[?${v}]` })) };
  }
  if ((match = /(^|[^\\\]])\[([^\[\]\n]*)$/.exec(before))) {
    const prefix = match[2].toLowerCase(), from = position - match[2].length - 1;
    return { from, to: position, items: project().passages.filter(p => p.id !== selectedId && (p.title.toLowerCase().includes(prefix) || p.id.toLowerCase().includes(prefix))).map(p => ({ label: p.title, kind: '[', detail: p.id, insert: `[${p.id}]` })) };
  }
  if ((match = /(^|[^A-Za-z0-9_$\\])\$([A-Za-z0-9_.]*)$/.exec(before))) {
    const prefix = match[2].toLowerCase(), from = position - match[2].length - 1;
    const items = knownVariables(project(), compiled).filter(v => v.toLowerCase().startsWith(prefix) || (prefix.length > 1 && v.toLowerCase().includes(prefix))).map(v => ({ label: v, kind: '$', insert: `$${v}` }));
    if (!prefix) items.unshift({ label: 'local.', kind: '$', detail: 'passage-local', insert: '$local.' });
    return { from, to: position, items };
  }
  if ((match = /(^|\s)@([A-Za-z0-9_-]*)$/.exec(before))) {
    const prefix = match[2].toLowerCase(), from = position - match[2].length - 1;
    return { from, to: position, items: project().customMacros.filter(m => m.id.toLowerCase().includes(prefix)).map(m => ({ label: m.id, kind: '@', detail: 'macro', insert: `@${m.id}` })) };
  }
  return null;
}

// ---- Passage header ---------------------------------------------------------------------
byId('passage-title').addEventListener('input', () => {
  const id = selectedId, value = byId('passage-title').value;
  if (!value.trim()) return;
  let outcome;
  if (!change(p => { outcome = renamePassage(p, id, value); }, { group: `title:${id}`, nextSelection: passageIdForTitle(value, project().passages, id), editor: false })) return;
  sourceEditor.value = passage().source;
  if (outcome?.macrosToReview.length) renameWarning = outcome;
});
byId('passage-title').addEventListener('blur', () => { byId('passage-title').value = passage().title; });
byId('passage-act').addEventListener('change', () => { if (!change(p => movePassage(p, selectedId, byId('passage-act').value))) refresh(); });
byId('set-start').addEventListener('click', () => change(p => { p.startPassageId = selectedId; }));
byId('set-act-start').addEventListener('click', () => change(p => { ensureActs(p); actForPassage(p, selectedId).startPassageId = selectedId; }));
byId('locate-passage').addEventListener('click', () => map.centerOn(passage().position, selectedId));
byId('duplicate').addEventListener('click', () => {
  const copy = cloneProject(project()).passages.find(p => p.id === selectedId);
  copy.title = `${copy.title.slice(0, 193)} (copy)`; copy.id = passageIdForTitle(copy.title, project().passages); copy.position = snapPosition({ x: copy.position.x + 48, y: copy.position.y + 168 });
  const lines = copy.source.split('\n'); let first = 0;
  while (first < lines.length && (!lines[first].trim() || lines[first].trimStart().startsWith('//'))) first++;
  if (/^\s*#\s+/.test(lines[first] ?? '')) { lines[first] = lines[first].replace(/^(\s*#\s+).*$/, `$1${copy.title}`); copy.source = lines.join('\n'); }
  change(p => { p.passages.push(copy); attachPassage(p, currentAct().id, copy.id); }, { nextSelection: copy.id });
});
byId('delete').addEventListener('click', () => {
  const incoming = [...compiled.values()].flatMap(r => r.edges).filter(e => e.to === selectedId && e.from !== selectedId).length;
  byId('delete-warning').textContent = `Delete “${passage().title}”? ${incoming ? `${incoming} link${incoming === 1 ? '' : 's'} to it will be reported as missing.` : 'Nothing links to it.'} Undo can restore it.`;
  const isStart = selectedId === project().startPassageId;
  byId('replacement-row').hidden = !isStart;
  byId('replacement-start').replaceChildren(...project().passages.filter(p => p.id !== selectedId).map(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.title; return o; }));
  byId('delete-dialog').showModal();
});
byId('delete-cancel').addEventListener('click', () => byId('delete-dialog').close());
byId('delete-form').addEventListener('submit', event => {
  event.preventDefault();
  const act = currentAct(), replacement = byId('replacement-start').value, id = selectedId;
  const next = act.passageIds.find(p => p !== id) ?? replacement;
  if (change(p => removePassage(p, id, replacement), { nextSelection: next })) byId('delete-dialog').close();
});

// ---- Image --------------------------------------------------------------------------
byId('add-image').addEventListener('click', () => { imageRequest = selectedId; byId('image-input').click(); });
byId('replace-image').addEventListener('click', () => { imageRequest = selectedId; byId('image-input').click(); });
byId('remove-image').addEventListener('click', () => change(p => { delete p.passages.find(x => x.id === selectedId).image; }));
byId('image-input').addEventListener('change', async () => {
  const file = byId('image-input').files[0], target = imageRequest; byId('image-input').value = ''; imageRequest = null;
  if (!file || !target) return;
  status('Preparing image…');
  try {
    const image = await processImage(file);
    if (!project().passages.some(p => p.id === target)) throw new Error('The passage no longer exists');
    change(p => { const x = p.passages.find(y => y.id === target); x.image = { ...image, id: x.image?.id ?? image.id, caption: x.image?.caption ?? '' }; });
    status(`Image attached to “${title(target)}”.`);
  } catch (error) { status(`Error: ${error.message}`); }
});
byId('image-caption').addEventListener('input', () => { const caption = byId('image-caption').value, id = selectedId; change(p => { p.passages.find(x => x.id === id).image.caption = caption; }, { group: `caption:${id}`, editor: false }); });
byId('image-preview').addEventListener('click', () => { const image = passage().image; byId('image-full').src = image.dataUrl; byId('image-full').alt = image.caption || image.name; byId('image-full-caption').textContent = image.caption || image.name; byId('image-dialog').showModal(); });
byId('image-close').addEventListener('click', () => byId('image-dialog').close());
byId('image-dialog').addEventListener('close', () => byId('image-full').removeAttribute('src'));

// ---- Editor toolbar --------------------------------------------------------------------
document.querySelector('.editor-toolbar').addEventListener('click', event => {
  const name = event.target.closest('button[data-snippet]')?.dataset.snippet;
  if (!name) return;
  try {
    const result = insertSnippet(sourceEditor.value, sourceEditor.selectionStart, sourceEditor.selectionEnd, name);
    if (history.changeSource(selectedId, result.source, null)) { touched = true; markChanged(); sourceEditor.value = result.source; refresh({ editor: false }); preview.sourceChanged(); }
    sourceEditor.focus(); sourceEditor.setSelectionRange(...result.selection);
  } catch (error) { status(`Error: ${error.message}`); }
});
function openLinkDialog() {
  const select = byId('link-target'); select.replaceChildren();
  for (const act of getActs(project())) {
    const group = document.createElement('optgroup'); group.label = act.title;
    group.append(...passagesInAct(project(), act.id).filter(p => p.id !== selectedId).map(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = `${p.title}${p.id === act.startPassageId ? ' · entry' : ''}`; return o; }));
    if (group.children.length) select.append(group);
  }
  byId('link-label').value = ''; byId('link-error').textContent = ''; byId('link-dialog').showModal();
}
byId('insert-link').addEventListener('click', openLinkDialog);
byId('link-cancel').addEventListener('click', () => byId('link-dialog').close()); byId('link-close').addEventListener('click', () => byId('link-dialog').close());
byId('link-form').addEventListener('submit', event => {
  event.preventDefault();
  const target = byId('link-target').value, label = byId('link-label').value.trim();
  if (!target) { byId('link-error').textContent = 'Create another passage first.'; return; }
  const text = label ? `* ${label.replace(/[\\\[\]()$*_`]/g, '\\$&')} [${target}]` : `[${target}]`;
  const source = sourceEditor.value, start = sourceEditor.selectionStart, before = source.slice(0, start), needsBreak = label && before && !/\n$/.test(before);
  sourceEditor.replaceSelection(`${needsBreak ? '\n' : ''}${text}${label ? '\n' : ''}`);
  byId('link-dialog').close();
});
byId('help').addEventListener('click', () => byId('help-dialog').showModal()); byId('help-inline').addEventListener('click', () => byId('help-dialog').showModal());
byId('help-close').addEventListener('click', () => byId('help-dialog').close());
byId('help-body').innerHTML = HELP_HTML;

// ---- Map toolbar ---------------------------------------------------------------------
byId('act-select').addEventListener('change', () => { const act = getActs(project()).find(a => a.id === byId('act-select').value); if (act) select(act.startPassageId, { center: true }); });
byId('add-passage').addEventListener('click', () => {
  const id = passageIdForTitle('New passage', project().passages), position = map.worldCenter(), actId = currentAct().id;
  const taken = visiblePassages().some(p => Math.abs(p.position.x - position.x) < 40 && Math.abs(p.position.y - position.y) < 40);
  if (taken) { position.x += 72; position.y += 72; }
  if (change(p => { p.passages.push({ id, title: 'New passage', position: snapPosition(position), source: '# New passage\n\n' }); attachPassage(p, actId, id); }, { nextSelection: id })) { byId('passage-title').focus(); byId('passage-title').select(); }
});
byId('auto-layout').addEventListener('click', () => {
  const passages = visiblePassages(), positions = autoLayout(passages, [...compiled.values()].flatMap(r => r.edges), { startId: currentAct().startPassageId, cardHeight: id => map.cardHeight(id) });
  if (change(p => { for (const x of p.passages) if (positions.has(x.id)) x.position = positions.get(x.id); })) requestAnimationFrame(() => { map.fit(visiblePassages()); status('Passages arranged. Undo restores the previous layout.'); });
});
byId('fit').addEventListener('click', () => map.fit(visiblePassages()));
byId('zoom-in').addEventListener('click', () => map.zoom(1.2)); byId('zoom-out').addEventListener('click', () => map.zoom(1 / 1.2));

// ---- Acts ----------------------------------------------------------------------------
let editingActId = null;
function openActDialog(id = null) {
  editingActId = id; byId('act-heading').textContent = id ? 'Rename act' : 'New act';
  byId('act-name').value = id ? currentAct().title : `Act ${getActs(project()).length + 1}`; byId('act-error').textContent = ''; byId('act-dialog').showModal(); byId('act-name').select();
}
byId('add-act').addEventListener('click', () => openActDialog()); byId('rename-act').addEventListener('click', () => openActDialog(currentAct().id));
byId('act-cancel').addEventListener('click', () => byId('act-dialog').close());
byId('act-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = byId('act-name').value.trim(); if (!name) { byId('act-error').textContent = 'Enter an act name.'; return; }
  let entry = null;
  if (change(p => { if (editingActId) ensureActs(p).find(a => a.id === editingActId).title = name; else entry = addAct(p, name); })) { byId('act-dialog').close(); if (entry) select(entry, { center: true }); }
  else byId('act-error').textContent = byId('file-status').textContent;
});
byId('merge-act').addEventListener('click', () => {
  byId('merge-act-help').textContent = `All passages in “${currentAct().title}” keep their IDs, text and links. Undo restores the acts.`;
  byId('merge-act-target').replaceChildren(...getActs(project()).filter(a => a.id !== currentAct().id).map(a => { const o = document.createElement('option'); o.value = a.id; o.textContent = a.title; return o; }));
  byId('merge-act-dialog').showModal();
});
byId('merge-act-cancel').addEventListener('click', () => byId('merge-act-dialog').close());
byId('merge-act-form').addEventListener('submit', event => { event.preventDefault(); if (change(p => mergeAct(p, currentAct().id, byId('merge-act-target').value))) byId('merge-act-dialog').close(); });

// ---- Top bar --------------------------------------------------------------------------
byId('project-title').addEventListener('click', async () => { const name = await promptDialog('Rename story', 'Title', project().title); if (name !== null && name.trim()) change(p => { p.title = name.trim().slice(0, 200); }); });
byId('new').addEventListener('click', async () => { if (!(touched && isDirty()) || await confirmDialog('Discard unsaved changes?', 'Starting a new project discards the unsaved changes in the current one.', 'Discard')) { files.reset(); loadProject(newProject(), { saved: false, message: 'New project — not saved yet.' }); } });
byId('undo').addEventListener('click', () => travel('undo')); byId('redo').addEventListener('click', () => travel('redo'));
byId('variables').addEventListener('click', () => variablesWindow.open());
byId('macros').addEventListener('click', () => macrosWindow.open());
byId('preview').addEventListener('click', () => preview.tryPassage(selectedId));
byId('play').addEventListener('click', () => preview.playFromStart());
byId('theme-toggle').addEventListener('click', () => { const theme = workspaceLayout.theme === 'dark' ? 'light' : 'dark'; workspaceLayout.setTheme(theme); preview.setTheme(theme); byId('theme-toggle').textContent = theme === 'dark' ? 'Light theme' : 'Dark theme'; });
byId('theme-toggle').textContent = workspaceLayout.theme === 'dark' ? 'Light theme' : 'Dark theme';
// Editor settings: font size and family for the source and macro editors (authoring preferences, kept in the browser).
const settingsDialog = byId('settings-dialog'), fontSizeInput = byId('settings-font-size'), fontSelect = byId('settings-font');
function showSettings() { const { editorFontSize, editorFont } = workspaceLayout.settings; fontSizeInput.value = String(editorFontSize); fontSelect.value = editorFont; }
byId('settings').addEventListener('click', () => { showSettings(); settingsDialog.showModal(); fontSizeInput.focus(); });
byId('settings-close').addEventListener('click', () => settingsDialog.close());
byId('settings-reset').addEventListener('click', () => { workspaceLayout.resetSettings(); showSettings(); });
fontSizeInput.addEventListener('input', () => { const size = Number(fontSizeInput.value); if (Number.isFinite(size) && size >= Number(fontSizeInput.min) && size <= Number(fontSizeInput.max)) workspaceLayout.setSettings({ editorFontSize: size }); });
byId('settings-font-smaller').addEventListener('click', () => { workspaceLayout.setSettings({ editorFontSize: workspaceLayout.settings.editorFontSize - 1 }); showSettings(); });
byId('settings-font-larger').addEventListener('click', () => { workspaceLayout.setSettings({ editorFontSize: workspaceLayout.settings.editorFontSize + 1 }); showSettings(); });
fontSelect.addEventListener('change', () => workspaceLayout.setSettings({ editorFont: fontSelect.value }));
document.addEventListener('keydown', event => {
  const mod = event.ctrlKey || event.metaKey;
  if (!mod || event.defaultPrevented) return;
  if (event.key.toLowerCase() === 's') { event.preventDefault(); if (!document.querySelector('dialog[open]')) files.save(); return; }
  const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || document.querySelector('dialog[open]');
  if (!editing && event.key.toLowerCase() === 'z') { event.preventDefault(); travel(event.shiftKey ? 'redo' : 'undo'); }
  if (!editing && event.key.toLowerCase() === 'y') { event.preventDefault(); travel('redo'); }
});
window.addEventListener('beforeunload', event => { if (isDirty()) { event.preventDefault(); event.returnValue = ''; } });

// ---- Start ------------------------------------------------------------------------------
for (const act of getActs(project())) viewports.set(act.id, { ...act.viewport });
refresh(); offerDraft();
function initialView() {
  // Fit the act when it fits comfortably; otherwise center the selected passage at a readable zoom.
  const view = map.fit(visiblePassages(), { minZoom: 0.55 });
  if (view.zoom <= 0.55) map.centerOn(passage().position, selectedId, { animated: false });
}
requestAnimationFrame(initialView);
