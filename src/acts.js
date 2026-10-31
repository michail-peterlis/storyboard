import { clone, newId, passageIdForTitle } from './model.js';

// Acts are authoring organization. Passage IDs stay unique across the story.
export function getActs(project) {
  return project.editor.actLayout?.acts ?? [{
    id: 'act_1', title: 'Act 1', startPassageId: project.startPassageId,
    passageIds: project.passages.map(passage => passage.id), viewport: clone(project.editor.viewport)
  }];
}
export function ensureActs(project) {
  project.editor.actLayout ??= { version: 1, acts: getActs(project) };
  return project.editor.actLayout.acts;
}
export function actForPassage(project, passageId) {
  return getActs(project).find(act => act.passageIds.includes(passageId));
}
export function passagesInAct(project, actId) {
  const ids = new Set(getActs(project).find(act => act.id === actId)?.passageIds ?? []);
  return project.passages.filter(passage => ids.has(passage.id));
}
export function actViewport(project, actId) {
  return project.editor.actLayout?.acts.find(act => act.id === actId)?.viewport ?? project.editor.viewport;
}
export function addAct(project, title) {
  const acts = ensureActs(project), id = newId('act');
  const passageTitle = `${title} opening`.slice(0, 200), passageId = passageIdForTitle(passageTitle, project.passages);
  project.passages.push({ id: passageId, title: passageTitle, position: { x: 80, y: 100 }, source: `# ${passageTitle}\n\nWrite your story here.` });
  acts.push({ id, title, startPassageId: passageId, passageIds: [passageId], viewport: { x: 0, y: 0, zoom: 1 } });
  return passageId;
}
export function attachPassage(project, actId, passageId) {
  if (!project.editor.actLayout) return; // The implicit act already includes every passage.
  const act = getActs(project).find(item => item.id === actId);
  if (!act) throw new Error('Act no longer exists');
  act.passageIds.push(passageId);
}
export function movePassage(project, passageId, targetId) {
  const acts = ensureActs(project), source = actForPassage(project, passageId), target = acts.find(act => act.id === targetId);
  if (!source || !target) throw new Error('Passage or destination act no longer exists');
  if (source === target) return;
  if (source.passageIds.length === 1) throw new Error('Keep one passage in each act. Use Merge act to move its final passage.');
  source.passageIds = source.passageIds.filter(id => id !== passageId);
  if (source.startPassageId === passageId) source.startPassageId = source.passageIds[0];
  target.passageIds.push(passageId);
}
export function mergeAct(project, sourceId, targetId) {
  const acts = ensureActs(project), source = acts.find(act => act.id === sourceId), target = acts.find(act => act.id === targetId);
  if (!source || !target || source === target) throw new Error('Choose another act to merge into');
  target.passageIds.push(...source.passageIds);
  project.editor.actLayout.acts = acts.filter(act => act !== source);
}
export function removePassage(project, passageId, replacementStart) {
  const act = actForPassage(project, passageId);
  if (!act || act.passageIds.length === 1) throw new Error('Keep one passage in each act. Merge this act first.');
  if (project.editor.actLayout) {
    act.passageIds = act.passageIds.filter(id => id !== passageId);
    if (act.startPassageId === passageId) act.startPassageId = act.passageIds[0];
  }
  if (project.startPassageId === passageId) project.startPassageId = replacementStart;
  project.passages = project.passages.filter(passage => passage.id !== passageId);
}
