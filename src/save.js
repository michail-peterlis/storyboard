import { LIMITS, bytes, identifier, validateJson, validateVariables, validateGameState } from './model.js';
import { parseVariablePath, scopedVariable } from './paths.js';

const exact = (value, fields, optional = []) => value && typeof value === 'object' && !Array.isArray(value) && fields.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => fields.includes(key) || optional.includes(key));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = message => { throw new Error(message); };

// Identity of the executable story: artwork and positions are deliberately absent.
export function storyKey(project) {
  return JSON.stringify({ id: project.id, formatVersion: project.formatVersion, languageVersion: project.languageVersion, title: project.title, startPassageId: project.startPassageId, initialVariables: project.initialVariables, initialGameState: project.initialGameState, traitDefaults: project.traitDefaults, customMacros: project.customMacros, passages: project.passages.map(({ id, title, source }) => ({ id, title, source })) });
}
export function validateObservations(records) {
  if (!Array.isArray(records)) fail('Invalid observation history');
  for (const [index, record] of records.entries()) {
    if (!exact(record, ['sequence', 'timestamp', 'type', 'passage', 'choice', 'changes']) || record.sequence !== index + 1 || !identifier(record.type, true) || typeof record.timestamp !== 'string' || !Number.isFinite(Date.parse(record.timestamp))) fail('Invalid observation record');
    if (!exact(record.passage, ['id', 'title']) || !identifier(record.passage.id) || typeof record.passage.title !== 'string' || !exact(record.choice, ['id', 'label', 'targetPassageId']) || typeof record.choice.id !== 'string' || typeof record.choice.label !== 'string' || !(identifier(record.choice.targetPassageId) || record.choice.targetPassageId === null) || !Array.isArray(record.changes)) fail('Invalid observation context');
    for (const change of record.changes) {
      if (!exact(change, ['path', 'operation', 'existed', 'before', 'after', 'delta']) || !['add', 'set'].includes(change.operation) || typeof change.existed !== 'boolean' || !(change.delta === null || (typeof change.delta === 'number' && Number.isFinite(change.delta))) || typeof change.path !== 'string') fail('Invalid observed change');
      parseVariablePath(change.path.startsWith('[') ? `gameState${change.path}` : change.path);
      if (record.type !== 'choice' && scopedVariable(change.path.startsWith('[') ? `gameState${change.path}` : change.path).local) fail('Personality observations change global values only');
    }
  }
  return records;
}
function nodeAtPath(ast, path) {
  if (!Array.isArray(path) || !path.length || path.length > LIMITS.depth * 2 + 1 || path.length % 2 !== 1) fail('Invalid saved continuation path');
  let list = ast, node;
  for (let index = 0; index < path.length; index += 2) {
    const position = path[index];
    if (!Number.isSafeInteger(position) || position < 0 || position >= list.length) fail('Saved continuation does not match the passage source');
    node = list[position];
    if (index + 1 < path.length) {
      if (path[index + 1] !== 'children' || !Array.isArray(node.children)) fail('Invalid saved continuation branch');
      list = node.children;
    }
  }
  return node;
}
const INLINE_TYPES = new Set(['text', 'strong', 'em', 'code', 'break', 'link', 'input']);
function validateInline(nodes, compiled, depth = 0, { controls = true } = {}) {
  if (!Array.isArray(nodes) || depth > LIMITS.depth) fail('Invalid saved inline content');
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || !INLINE_TYPES.has(node.type)) fail('Invalid saved inline node');
    if (!controls && (node.type === 'link' || node.type === 'input')) fail('Saved choice labels cannot contain controls');
    if (['text', 'code'].includes(node.type) && typeof node.text !== 'string') fail('Invalid saved text');
    if (['strong', 'em'].includes(node.type)) validateInline(node.children, compiled, depth + 1, { controls });
    if (node.type === 'link' && (typeof node.label !== 'string' || !compiled.has(node.target))) fail('Invalid saved link');
    if (node.type === 'input') validateInput(node);
  }
}
function validateInput(node) {
  if (typeof node.label !== 'string' || !['text', 'number', 'checkbox'].includes(node.inputType)) fail('Invalid saved input');
  parseVariablePath(node.name);
}
const OUTPUT_TYPES = new Set(['paragraph', 'heading', 'description', 'dialogue', 'scene', 'environment', 'link', 'input', 'rule', 'choiceGroup']);
function validateOutput(output, compiled, ast, entryId, { environment = false } = {}) {
  validateJson(output, 'saved output');
  if (!Array.isArray(output) || output.length > LIMITS.nodes) fail('Invalid saved output');
  for (const node of output) {
    if (!node || typeof node !== 'object' || !OUTPUT_TYPES.has(node.type) || !Array.isArray(node.path)) fail('Unsupported saved output node');
    if (environment && node.type !== 'environment') fail('Saved environment contains story content');
    const source = nodeAtPath(ast, node.path);
    if (node.macro) {
      if (source.type !== 'run' || source.id !== node.macro || !['paragraph', 'link'].includes(node.type)) fail('Saved macro output does not match the passage source');
    } else if (source.type !== node.type && !(node.type === 'link' && source.type === 'link')) fail('Saved output does not match the passage source');
    if (node.inline) validateInline(node.inline, compiled);
    if (node.type === 'link' && (typeof node.label !== 'string' || !compiled.has(node.target))) fail('Invalid saved link');
    if (node.type === 'input') validateInput(node);
    if (node.type === 'dialogue' && !(node.speaker === null || typeof node.speaker === 'string') ) fail('Invalid saved dialogue');
    if (node.type === 'choiceGroup') {
      if (node.id !== source.id || node.mode !== source.mode || node.personalityType !== source.personalityType || node.runtimeId !== `${entryId}_${node.path.join('_')}` || !Array.isArray(node.options) || !node.options.length || node.options.length > source.options.length) fail('Saved choice group does not match the passage source');
      const ids = new Set();
      for (const option of node.options) {
        if (!exact(option, ['id', 'label', 'inline']) || ids.has(option.id) || !source.options.some(item => item.id === option.id && item.label === option.label)) fail('Invalid saved choice option');
        validateInline(option.inline, compiled, 0, { controls: false }); ids.add(option.id);
      }
      if (node.selectedIds !== null && (!Array.isArray(node.selectedIds) || !node.selectedIds.length || (node.mode === 'single' && node.selectedIds.length !== 1) || new Set(node.selectedIds).size !== node.selectedIds.length || node.selectedIds.some(id => !ids.has(id)))) fail('Invalid saved choice selection');
    }
  }
}
export function validateSave(save, project, compiled) {
  validateJson(save, 'saved game', { maxBytes: LIMITS.json, maxNodes: 5 * LIMITS.nodes, maxDepth: LIMITS.depth + 2 });
  if (!exact(save, ['format', 'formatVersion', 'projectId', 'storyKey', 'passageId', 'gameState', 'localVariables', 'output', 'environment', 'scene', 'continuation', 'pendingGroup', 'entryId'])) fail('Invalid saved-game fields');
  if (save.format !== 'storyline-save' || save.formatVersion !== 1) fail('Unsupported saved-game format');
  if (bytes(JSON.stringify(save)) > LIMITS.json) fail('Saved game exceeds 5 MiB');
  if (save.projectId !== project.id || save.storyKey !== storyKey(project)) fail('This save belongs to a different project or story revision. Reopen the matching project first.');
  if (!compiled.has(save.passageId)) fail('Saved passage no longer exists');
  validateGameState(save.gameState); validateObservations(save.gameState.observations); validateVariables(save.localVariables, 'local');
  if (!(save.scene === null || typeof save.scene === 'string') || typeof save.entryId !== 'string' || !save.entryId) fail('Invalid saved scene or entry');
  const ast = compiled.get(save.passageId).ast;
  validateOutput(save.output, compiled, ast, save.entryId);
  validateOutput(save.environment, compiled, ast, save.entryId, { environment: true });
  if (!Array.isArray(save.continuation) || save.continuation.length > LIMITS.nodes) fail('Invalid saved continuation');
  const paths = new Set();
  for (const path of save.continuation) {
    nodeAtPath(ast, path);
    const key = JSON.stringify(path);
    if (paths.has(key)) fail('Duplicate saved continuation path');
    paths.add(key);
  }
  const unresolved = save.output.filter(node => node.type === 'choiceGroup' && node.selectedIds === null);
  if (save.pendingGroup === null) {
    if (unresolved.length || save.continuation.length) fail('Saved continuation has no pending choice');
  } else {
    const pending = save.pendingGroup;
    if (!exact(pending, ['id', 'path', 'optionIds']) || typeof pending.id !== 'string' || !Array.isArray(pending.optionIds) || !pending.optionIds.length || pending.optionIds.some(id => typeof id !== 'string')) fail('Invalid pending saved choice');
    const source = nodeAtPath(ast, pending.path);
    if (source.type !== 'choiceGroup' || unresolved.length !== 1 || unresolved[0].runtimeId !== pending.id || unresolved[0].id !== source.id || !equal(unresolved[0].options.map(option => option.id), pending.optionIds) || paths.has(JSON.stringify(pending.path))) fail('Pending saved choice does not match its source and rendered options');
    const expected = [];
    for (let level = pending.path.length - 1; level >= 0; level -= 2) {
      const list = level === 0 ? ast : nodeAtPath(ast, pending.path.slice(0, level - 1)).children;
      for (let index = pending.path[level] + 1; index < list.length; index++) expected.push([...pending.path.slice(0, level), index]);
    }
    if (!equal(save.continuation, expected)) fail('Saved continuation would skip or replay passage commands');
  }
  return save;
}
