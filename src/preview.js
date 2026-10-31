// Docked preview: one sandboxed player session at a time (trial of a passage or full play).
import { cloneProject, clone, newId, LIMITS, bytes } from './model.js';
import { PROTOCOL, validFrameMessage, validInit, validCommand } from './bridge.js';
import { playerDocument } from './player-shell.js';
import { createStateView } from './state-view.js';

export function createPreview(document, { playerJs, getProject, getTheme, onStatus, onNavigate, onStop }) {
  const byId = id => document.getElementById(id);
  const column = byId('preview-column'), splitter = byId('preview-splitter'), workspace = byId('workspace'), container = byId('frame-container');
  const stateView = createStateView(byId('state-view'));
  let session = null, allowJavaScript = false, live = byId('preview-live').checked, liveTimer = null;
  const state = { get open() { return !column.hidden; }, get allowJavaScript() { return allowJavaScript; }, get session() { return session; } };

  function describe() {
    byId('preview-live').parentElement.hidden = !session?.trial;
    if (!session) { byId('preview-mode').textContent = 'Preview'; return; }
    const title = session.init.project.passages.find(p => p.id === session.init.startId)?.title ?? session.init.startId;
    byId('preview-mode').textContent = session.trial ? `Trying “${title}”` : 'Playing from start';
    byId('preview-mode').title = session.trial ? `Trial of “${title}” ${session.init.trialState ? 'with state copied from the previous run' : 'with project defaults'}` : 'Full play from the story start';
  }
  function updateDebug() {
    const current = session;
    byId('play-diagnostic').textContent = current?.diagnostic ?? '';
    byId('snapshot-status').textContent = current ? (sameSnapshot(current) ? 'Snapshot matches the current source.' : 'Source changed since this run started — restart to use the edits.') : '';
    const raw = byId('state-raw').checked;
    byId('state-view').hidden = raw; byId('debug').hidden = !raw; byId('observations').hidden = !raw; byId('observation-summary').hidden = !raw;
    if (raw) {
      byId('debug').textContent = current?.runtimeState ? JSON.stringify({ passage: current.passageId, scene: current.scene, gameState: Object.fromEntries(Object.entries(current.runtimeState.gameState).filter(([key]) => key !== 'observations')), local: current.runtimeState.localVariables }, null, 2) : '';
      byId('observations').textContent = JSON.stringify(current?.runtimeState?.gameState.observations ?? [], null, 2);
      byId('observation-summary').textContent = `Observations (${current?.runtimeState?.gameState.observations.length ?? 0})`;
    }
    byId('preview-undo').disabled = !current?.canUndo;
    byId('enable-js').textContent = allowJavaScript ? 'Revoke JavaScript' : 'Enable JavaScript';
    byId('restart').textContent = session?.trial ? '↻ Retry' : '↻ Restart';
    describe();
  }
  const sameSnapshot = current => JSON.stringify(stripArt(current.init.project)) === JSON.stringify(stripArt(getProject()));
  const stripArt = project => ({ ...project, passages: project.passages.map(({ image, position, ...rest }) => rest), editor: null });
  function show() {
    column.hidden = false; splitter.hidden = false; workspace.classList.add('with-preview');
  }
  function close() {
    stop(); column.hidden = true; splitter.hidden = true; workspace.classList.remove('with-preview'); setExpanded(false); onStatus?.('Preview closed.');
  }
  function stop() { container.replaceChildren(); session = null; stateView.reset(); stateView.render({}); updateDebug(); onStop?.(); }
  function start({ trial, startId, seed = null }) {
    const project = cloneProject(getProject());
    const id = startId ?? project.startPassageId;
    if (!project.passages.some(p => p.id === id)) { onStatus?.('Select a passage to try.'); return; }
    const sessionId = newId('session'), frame = document.createElement('iframe');
    const init = { protocol: PROTOCOL, session: sessionId, kind: 'init', project, allowJavaScript, startId: id, ...(seed ? { trialState: clone(seed) } : {}) };
    if (!validInit(init, sessionId)) { onStatus?.('Could not start the player: invalid project or trial state.'); return; }
    frame.title = trial ? 'Passage trial' : 'Story player'; frame.name = sessionId;
    frame.setAttribute('sandbox', 'allow-scripts'); frame.referrerPolicy = 'no-referrer';
    container.replaceChildren(frame);
    session = { frame, session: sessionId, init, trial, seed, sent: false, diagnostic: '', runtimeState: null, passageId: null, scene: null, canUndo: false };
    stateView.reset();
    frame.srcdoc = playerDocument(playerJs, allowJavaScript);
    show(); updateDebug();
  }
  function currentSeed() {
    const current = session?.runtimeState;
    return current ? { gameState: clone(current.gameState), localVariables: clone(current.localVariables) } : null;
  }
  window.addEventListener('message', event => {
    const current = session;
    if (!current || event.source !== current.frame.contentWindow || !validFrameMessage(event.data, current.session)) return;
    const message = event.data;
    if (message.kind === 'ready' && !current.sent) { current.sent = true; current.frame.contentWindow.postMessage(current.init, '*'); current.frame.contentWindow.postMessage({ protocol: PROTOCOL, session: current.session, kind: 'theme', theme: getTheme() }, '*'); }
    if (!current.sent) return;
    if (message.kind === 'diagnostic') current.diagnostic = message.message;
    if (message.kind === 'debug') {
      current.runtimeState = clone({ gameState: message.gameState, localVariables: message.localVariables }); current.passageId = message.passageId; current.scene = message.scene; current.canUndo = message.canUndo;
      stateView.render({ gameState: current.runtimeState.gameState, local: current.runtimeState.localVariables, passageId: current.passageId });
    }
    if (message.kind === 'navigate') onNavigate?.(message.passageId);
    if (message.kind === 'checkpoint' && current.pendingSave) {
      current.pendingSave = false;
      try { download(message.save, 'game.save.json'); onStatus?.('Saved-game download started. Keep the matching project to resume.'); }
      catch (error) { current.diagnostic = error.message; }
    }
    updateDebug();
  });
  function download(value, suffix) {
    const text = JSON.stringify(value, null, 2);
    if (bytes(text) > LIMITS.json) throw new Error('Export exceeds 5 MiB');
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })), link = document.createElement('a');
    link.href = url; link.download = `${getProject().title.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 70) || 'story'}.${suffix}`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function command(payload) {
    if (!session?.sent) throw new Error('Start the story first');
    const message = { protocol: PROTOCOL, session: session.session, ...payload };
    if (!validCommand(message, session.session)) throw new Error('Runtime command exceeds the 5 MiB limit');
    session.frame.contentWindow.postMessage(message, '*');
  }
  byId('save-game').addEventListener('click', () => { try { command({ kind: 'save-game' }); session.pendingSave = true; } catch (error) { byId('play-diagnostic').textContent = error.message; } });
  byId('load-game').addEventListener('click', () => byId('save-input').click());
  byId('save-input').addEventListener('change', async () => {
    const file = byId('save-input').files[0], current = session; byId('save-input').value = '';
    if (!file) return;
    try {
      if (file.size > LIMITS.json) throw new Error('Saved game exceeds 5 MiB');
      const save = JSON.parse(await file.text());
      if (session !== current) throw new Error('The session changed while reading the save; choose the file again');
      command({ kind: 'restore-game', save });
    } catch (error) { byId('play-diagnostic').textContent = error.message; }
  });
  byId('export-observations').addEventListener('click', () => {
    try { if (!session?.runtimeState) throw new Error('Start the story before exporting observations'); download({ format: 'storyline-observations', formatVersion: 1, projectId: session.init.project.id, observations: session.runtimeState.gameState.observations }, 'observations.json'); onStatus?.('Observation export started.'); }
    catch (error) { byId('play-diagnostic').textContent = error.message; }
  });
  byId('enable-js').addEventListener('click', async () => {
    if (!allowJavaScript) {
      const ok = await (window.confirmDialog?.('Enable custom JavaScript for this project?', 'Macros run with full JavaScript inside a sandboxed frame. They can freeze the tab; the sandbox is not a guarantee against hostile code. Only continue if you trust the author.', 'Enable JavaScript') ?? Promise.resolve(confirm('Enable custom JavaScript for this trusted project?')));
      if (!ok) return;
    }
    allowJavaScript = !allowJavaScript;
    if (session) restart(); else updateDebug();
  });
  byId('toggle-debug').addEventListener('click', () => { const hidden = !byId('debug-sidebar').hidden; byId('debug-sidebar').hidden = hidden; byId('toggle-debug').setAttribute('aria-expanded', String(!hidden)); });
  byId('state-raw').addEventListener('change', updateDebug);
  byId('preview-undo').addEventListener('click', () => { try { command({ kind: 'undo' }); } catch (error) { byId('play-diagnostic').textContent = error.message; } });
  // Full-window simulation: the preview takes the whole workspace until docked again.
  function setExpanded(expanded) {
    workspace.classList.toggle('preview-full', expanded);
    byId('expand-preview').setAttribute('aria-pressed', String(expanded)); byId('expand-preview').textContent = expanded ? '⤡' : '⤢'; byId('expand-preview').title = expanded ? 'Back to the editor layout' : 'Simulate in the whole window';
    if (expanded && byId('debug-sidebar').hidden) { byId('debug-sidebar').hidden = false; byId('toggle-debug').setAttribute('aria-expanded', 'true'); }
  }
  byId('expand-preview').addEventListener('click', () => setExpanded(!workspace.classList.contains('preview-full')));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && workspace.classList.contains('preview-full') && !document.querySelector('dialog[open]')) setExpanded(false); });
  byId('close-preview').addEventListener('click', close);
  byId('restart').addEventListener('click', () => restart());
  byId('preview-live').addEventListener('change', () => { live = byId('preview-live').checked; });
  function restart() {
    if (!session) return;
    start({ trial: session.trial, startId: session.init.startId, seed: session.seed });
  }
  return {
    state,
    tryPassage(id) { start({ trial: true, startId: id, seed: currentSeed() }); onStatus?.(`Trying “${getProject().passages.find(p => p.id === id)?.title}” in the preview.`); },
    playFromStart() { start({ trial: false }); onStatus?.('Playing from the story start.'); },
    restart, close,
    revokeTrust() { allowJavaScript = false; if (session) { stop(); byId('play-diagnostic').textContent = 'Macros or settings changed; JavaScript approval was revoked. Start the preview again.'; } },
    sourceChanged() {
      // Live mode: restart the trial after edits settle.
      if (!session || !live || !session.trial) { updateDebug(); return; }
      clearTimeout(liveTimer); liveTimer = setTimeout(() => { if (session?.trial) restart(); }, 700);
    },
    // Live trials follow the selected passage.
    followSelection(id) { if (session?.trial && live && session.init.startId !== id) { start({ trial: true, startId: id, seed: currentSeed() }); onStatus?.(`Live preview follows the selection: trying “${getProject().passages.find(p => p.id === id)?.title}”.`); } },
    setTheme(theme) { try { if (session?.sent) command({ kind: 'theme', theme }); } catch { /* ignore */ } },
    refresh: updateDebug
  };
}
