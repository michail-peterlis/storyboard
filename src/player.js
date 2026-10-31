import { StoryRuntime } from './runtime.js';
import { createStoryView } from './render.js';
import { createReadingHistory } from './reading-history.js';
import { PROTOCOL, validInit, validFrameMessage, validCommand } from './bridge.js';

const session = window.name;
const send = payload => {
  const message = { protocol: PROTOCOL, session, ...payload };
  if (validFrameMessage(message, session)) parent.postMessage(message, '*');
  else if (payload.kind !== 'diagnostic') send({ kind: 'diagnostic', message: 'Runtime snapshot exceeds the bridge limit. State was not exported.' });
};
const byId = id => document.getElementById(id);
const root = byId('story'), error = byId('error'), environmentRoot = byId('environment'), imageRoot = byId('focus-image');
const history = createReadingHistory(document);
let initialized = false, runtime, view;
const revealControls = byId('reveal-controls'), nextButton = byId('reveal-next'), allButton = byId('reveal-all'), focusButton = byId('focus-current'), undoButton = byId('undo-step');
const undoStack = []; // simulator undo: runtime snapshots taken before each state change

function updateHistory() {
  history.render(byId('past-history'));
  const previous = Math.max(0, (view?.state().revealed ?? 0) - 1), archived = history.state();
  byId('current-history').replaceChildren(...(view ? [view.snapshot({ includeCurrent: false })] : []));
  byId('current-history-title').hidden = previous === 0;
  byId('history-trimmed').hidden = !archived.trimmed;
  byId('reading-history').hidden = !previous && !archived.entries && !archived.trimmed;
  const parts = [];
  if (previous) parts.push(`${previous} earlier message${previous === 1 ? '' : 's'}`);
  if (archived.entries) parts.push(`${archived.entries} previous passage${archived.entries === 1 ? '' : 's'}`);
  byId('history-summary').textContent = `History${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
}
function updateReveal() {
  const state = view?.state() ?? { revealed: 0, total: 0 }, focused = view?.isFocused() ?? true, atEnd = state.revealed === state.total;
  revealControls.hidden = state.total === 0 && !undoStack.length;
  undoButton.disabled = !undoStack.length;
  nextButton.disabled = atEnd; nextButton.hidden = state.total < 2; allButton.hidden = state.total < 2; allButton.disabled = atEnd && !focused;
  focusButton.hidden = focused; root.classList.toggle('focused', focused);
  root.setAttribute('aria-label', focused ? 'Current message' : 'Current passage');
  byId('activity-label').textContent = focused ? 'Now' : 'Passage';
  byId('reveal-status').textContent = state.total > 1 ? `${state.revealed} of ${state.total} messages${runtime?.pendingGroup && atEnd ? ' · choose a response to continue' : ''}` : runtime?.pendingGroup ? 'Choose a response to continue' : '';
  updateHistory();
}
function focusStory({ entry = false } = {}) {
  root.focus({ preventScroll: true });
  if (entry) window.scrollTo?.({ top: 0, behavior: 'instant' });
  else root.scrollIntoView?.({ block: 'nearest' });
}
nextButton.addEventListener('click', () => { view?.setFocused(true); view?.revealNext(); updateReveal(); focusStory(); });
allButton.addEventListener('click', () => { view?.setFocused(false); view?.showAll(); updateReveal(); focusStory(); });
focusButton.addEventListener('click', () => { view?.setFocused(true); updateReveal(); focusStory(); });
function diagnose(message) { error.textContent = message; send({ kind: 'diagnostic', message: message.slice(0, 10000) }); }
function debug() { send({ kind: 'debug', passageId: runtime.passageId, gameState: runtime.gameState, localVariables: runtime.localVariables, scene: runtime.scene, canUndo: undoStack.length > 0 }); }
function snapshot() {
  if (!runtime.passageId) return null;
  return { tx: runtime.transaction(), archived: history.state().entries, revealed: view?.state().revealed ?? 1, focused: view?.isFocused() ?? true };
}
function remember(step) { if (step) { undoStack.push(step); if (undoStack.length > 100) undoStack.shift(); } }
function display(operation, { continuing = false, restoring = false, rewinding = null, decision = '' } = {}) {
  const before = restoring ? null : snapshot();
  try {
    let nextView;
    const previousEntry = runtime.entryId, previousView = view, previousOutput = runtime.output.length;
    const previousTitle = runtime.project.passages.find(p => p.id === runtime.passageId)?.title ?? runtime.passageId;
    operation((output, variables, context) => {
      const sameEntry = continuing && context.entryId === previousEntry;
      const passage = runtime.project.passages.find(item => item.id === context.passageId);
      nextView = createStoryView(document, output, variables, { navigate, chooseGroup, environment: context.environment, image: passage.image ?? null,
        revealIndex: sameEntry ? previousOutput : 0, initialRevealed: rewinding?.revealed ?? null, focusCurrent: rewinding ? rewinding.focused : sameEntry ? previousView?.isFocused() ?? true : true,
        input: (name, type, raw) => { const step = snapshot(); runtime.input(name, type, raw); remember(step); diagnose(''); debug(); updateHistory(); }, diagnostic: diagnose });
    });
    if (restoring) { history.clear(); byId('reading-history').open = false; }
    else if (rewinding) history.truncate(rewinding.archived);
    else if (previousView && runtime.entryId !== previousEntry) history.archive(previousTitle, previousView.snapshot(), decision);
    if (!restoring && !rewinding) remember(before);
    root.replaceChildren(nextView.fragment); imageRoot.replaceChildren(nextView.imageFragment); imageRoot.hidden = !imageRoot.hasChildNodes();
    environmentRoot.replaceChildren(nextView.environmentFragment); byId('environment-panel').hidden = !environmentRoot.hasChildNodes();
    byId('passage-name').textContent = runtime.project.passages.find(p => p.id === runtime.passageId)?.title ?? runtime.passageId;
    byId('scene-name').textContent = runtime.scene ?? '';
    view = nextView; updateReveal(); diagnose(''); debug(); send({ kind: 'navigate', passageId: runtime.passageId });
    // A new passage starts at the top; continuing in the same passage keeps the reading position.
    if (restoring || rewinding || runtime.entryId !== previousEntry) focusStory({ entry: true });
  } catch (e) { diagnose(e.message); }
}
function undo() {
  const step = undoStack.pop();
  if (!step) return;
  display(render => runtime.rewind(step.tx, render), { rewinding: step });
}
undoButton.addEventListener('click', undo);
function navigate(id, label = '') { display(render => runtime.enter(id, render), { decision: label }); }
function chooseGroup(id, ids) {
  const group = runtime.output.find(node => node.type === 'choiceGroup' && node.runtimeId === id);
  const decision = group?.options.filter(option => ids.includes(option.id)).map(option => option.label).join(' / ') ?? '';
  display(render => runtime.chooseGroup(id, ids, render), { continuing: true, decision });
}
window.addEventListener('message', event => {
  if (event.source !== parent) return;
  if (initialized) {
    if (!runtime || !validCommand(event.data, session)) return;
    if (event.data.kind === 'save-game') { try { send({ kind: 'checkpoint', save: runtime.save() }); } catch (e) { diagnose(e.message); } }
    else if (event.data.kind === 'theme') document.documentElement.dataset.theme = event.data.theme;
    else if (event.data.kind === 'undo') undo();
    else display(render => runtime.restore(event.data.save, render), { restoring: true });
    return;
  }
  if (!validInit(event.data, session)) return;
  initialized = true;
  try {
    const { project, allowJavaScript, startId, trialState } = event.data;
    runtime = new StoryRuntime(project, { executeMacro: allowJavaScript ? (code, ctx) => new Function('ctx', `"use strict";\n${code}`)(ctx) : null });
    if (trialState) display(render => runtime.tryPassage(startId, trialState, render));
    else navigate(startId);
  } catch (e) { diagnose(e.message); }
});
send({ kind: 'ready' });
