import { LIMITS, clone, scalar, bytes, validateProject, validateVariables, validateGameState, createGameState, mergeJson, newId } from './model.js';
import { compileProject } from './compiler.js';
import { evaluate, boolean } from './expression.js';
import { getVariable, variableScope, setScopedVariable, scopedVariable, formatValue, formatPath, hasVariable } from './paths.js';
import { storyKey, validateSave } from './save.js';
import { validateTrialState } from './session-state.js';

export const INPUT_EXPECTED = { text: 'string', number: 'number', checkbox: 'boolean' };
const CONTENT_TYPES = new Set(['paragraph', 'heading', 'description', 'dialogue', 'scene', 'environment']);
const pathsFor = (nodes, prefix = []) => nodes.map((_, index) => [...prefix, index]);
export function nodeAtPath(ast, path) {
  let node = ast;
  for (const part of path) node = node?.[part];
  if (!node || typeof node.type !== 'string') throw new Error('Invalid passage continuation');
  return node;
}
export function inferInputType(value) {
  const type = { string: 'text', number: 'number', boolean: 'checkbox' }[typeof value];
  if (!type) throw new Error(`Inputs need a text, number or true/false value, got ${formatValue(value)}`);
  return type;
}

export class StoryRuntime {
  constructor(project, { executeMacro = null } = {}) {
    this.project = clone(validateProject(project)); this.compiled = compileProject(this.project);
    this.local = clone(this.project.initialVariables); this.gameState = createGameState(this.project);
    this.passageId = null; this.output = []; this.environment = []; this.scene = null; this.continuation = []; this.pendingGroup = null; this.entryId = '';
    this.executeMacro = executeMacro;
  }
  get localVariables() { return this.local; }
  scope(tx) { return variableScope({ gameState: tx.gameState, local: tx.local }); }
  set(tx, name, value) {
    const scope = { gameState: tx.gameState, local: tx.local };
    setScopedVariable(scope, name, value, true); tx.gameState = scope.gameState; tx.local = scope.local;
  }
  transaction() { return clone({ gameState: this.gameState, local: this.local, passageId: this.passageId, output: this.output, environment: this.environment, scene: this.scene, continuation: this.continuation, pendingGroup: this.pendingGroup, entryId: this.entryId }); }
  commit(tx, render) {
    if (bytes(JSON.stringify(tx.local)) > LIMITS.output) throw new Error('Local variables exceed 1 MiB');
    validateVariables(tx.local, 'local'); validateGameState(tx.gameState);
    if (bytes(JSON.stringify([tx.output, tx.environment])) > LIMITS.output) throw new Error('Entry output budget exceeded');
    render(tx.output, this.scope(tx), { environment: tx.environment, scene: tx.scene, passageId: tx.passageId, entryId: tx.entryId });
    for (const key of ['gameState', 'local', 'passageId', 'output', 'environment', 'scene', 'continuation', 'pendingGroup', 'entryId']) this[key] = tx[key];
    return { output: this.output, passageId: this.passageId, gameState: clone(this.gameState), local: clone(this.local) };
  }
  passage(id) {
    const passage = this.project.passages.find(p => p.id === id);
    if (!passage) throw new Error(`Missing passage ${id}`);
    return passage;
  }
  entry(id, gameState = this.gameState, redirects = 0) {
    const passage = this.passage(id), compiled = this.compiled.get(id);
    const error = compiled.diagnostics.find(d => d.severity === 'error');
    if (error) throw new Error(`${passage.title} (${id}) ${error.line}:${error.column}: ${error.message}`);
    return { gameState: clone(gameState), local: clone(this.project.initialVariables), passageId: id, output: [], environment: [], scene: null, continuation: pathsFor(compiled.ast), pendingGroup: null, entryId: newId('entry'), redirects };
  }
  enter(id, render = () => {}, gameState = this.gameState) {
    const tx = this.resume(this.entry(id, gameState)); return this.commit(tx, render);
  }
  tryPassage(id, state, render = () => {}) {
    validateTrialState(state);
    const tx = this.entry(id);
    tx.gameState = mergeJson(createGameState(this.project), state.gameState);
    tx.local = mergeJson(this.project.initialVariables, state.localVariables);
    return this.commit(this.resume(tx), render);
  }
  // Executes until the continuation is exhausted or a choice group pauses. May switch passages on redirect.
  resume(tx) {
    let ops = 0;
    const tick = () => { if (++ops > LIMITS.operations) throw new Error('Entry operation budget exceeded'); };
    for (;;) {
      const passage = this.passage(tx.passageId), ast = this.compiled.get(tx.passageId).ast;
      let outputBytes = bytes(JSON.stringify([tx.output, tx.environment])), redirect = null;
      const emit = (node, destination = tx.output) => {
        tick(); outputBytes += bytes(JSON.stringify(node));
        if (outputBytes > LIMITS.output || tx.output.length + tx.environment.length >= LIMITS.nodes) throw new Error('Entry output budget exceeded');
        destination.push(node);
      };
      const resolveInline = (nodes, path) => nodes.map(node => {
        if (node.type === 'interp') return { type: 'text', text: formatValue(evaluate(node.expression, this.scope(tx), tick)) };
        if (node.type === 'input') return this.resolveInput(tx, node);
        if (node.type === 'link') return { type: 'link', target: node.target, label: this.passage(node.target).title };
        if (node.children) return { ...node, children: resolveInline(node.children, path) };
        return clone(node);
      });
      const run = (node, path) => {
        if (!this.executeMacro) throw new Error(`Macro @${node.id} requires JavaScript approval (Enable JavaScript in the preview)`);
        const macro = this.project.customMacros.find(m => m.id === node.id); let active = true;
        const guard = fn => (...args) => { if (!active) throw new Error('Macro API capability has expired'); tick(); return fn(...args); };
        const ctx = Object.freeze({
          get: guard(name => clone(getVariable(this.scope(tx), name))),
          has: guard(name => hasVariable(this.scope(tx), name)),
          set: guard((name, value) => this.set(tx, name, value)),
          text: guard(value => { if (!scalar(value)) throw new Error('ctx.text expects a scalar'); emit({ type: 'paragraph', inline: [{ type: 'text', text: String(value) }], macro: node.id, path }); }),
          link: guard((label, target) => {
            if (typeof label !== 'string' || !macro.targets.includes(target) || !this.compiled.has(target)) throw new Error('ctx.link needs a string label and an existing declared target');
            emit({ type: 'link', label, target, macro: node.id, path });
          })
        });
        try {
          const result = this.executeMacro(macro.code, ctx);
          if (result && typeof result.then === 'function') { if (result instanceof Promise) result.catch(() => {}); throw new Error('Asynchronous macro results are unsupported'); }
        } finally { active = false; }
      };
      while (tx.continuation.length && !tx.pendingGroup && !redirect) {
        const path = tx.continuation.shift(), node = nodeAtPath(ast, path);
        try {
          tick();
          if (node.type === 'if') { if (boolean(evaluate(node.expression, this.scope(tx), tick))) tx.continuation.unshift(...pathsFor(node.children, [...path, 'children'])); }
          else if (node.type === 'redirect') { if (boolean(evaluate(node.expression, this.scope(tx), tick))) redirect = node.target; }
          else if (node.type === 'set') this.effect(tx, node, tick);
          else if (node.type === 'run') run(node, path);
          else if (node.type === 'rule') emit({ type: 'rule', path });
          else if (node.type === 'link') emit({ type: 'link', target: node.target, label: this.passage(node.target).title, path });
          else if (node.type === 'environment') emit({ type: 'environment', level: node.level ?? 0, inline: resolveInline(node.inline, path), path }, tx.environment);
          else if (node.type === 'scene') {
            const inline = resolveInline(node.inline, path);
            if (!node.level && tx.scene === null) tx.scene = inline.filter(n => n.type === 'text').map(n => n.text).join(' ').trim() || null;
            emit({ type: 'scene', level: node.level ?? 0, inline, path });
          }
          else if (CONTENT_TYPES.has(node.type)) emit({ type: node.type, inline: resolveInline(node.inline, path), ...(node.speaker !== undefined ? { speaker: node.speaker, side: node.side } : {}), ...(node.level ? { level: node.level } : {}), path });
          else if (node.type === 'choiceGroup') {
            const options = node.options.filter(option => option.conditions.every(c => boolean(evaluate(c.expression, this.scope(tx), tick))));
            if (!options.length) throw new Error(`No choice is available (all ${node.options.length} options have false conditions); add an unconditional option`);
            const runtimeId = `${tx.entryId}_${path.join('_')}`;
            emit({ type: 'choiceGroup', id: node.id, runtimeId, mode: node.mode, personalityType: node.personalityType, options: options.map(option => ({ id: option.id, label: option.label, inline: resolveInline(option.inline, path) })), selectedIds: null, path });
            tx.pendingGroup = { id: runtimeId, path, optionIds: options.map(option => option.id) };
          } else throw new Error(`Unsupported node ${node.type}`);
        } catch (error) {
          if (error?.storyLocated) throw error;
          const loc = node.location ?? { line: 1, column: 1 };
          const message = typeof error?.message === 'string' ? error.message : scalar(error) ? String(error) : 'Custom code threw a non-Error value';
          const located = new Error(`${passage.title} (${tx.passageId}) ${loc.line}:${loc.column}${node.type === 'run' ? ` @${node.id}` : ''}: ${message}`);
          located.storyLocated = true; throw located;
        }
      }
      if (!redirect) return tx;
      if ((tx.redirects ?? 0) >= LIMITS.redirects) throw new Error(`Conditional jumps looped more than ${LIMITS.redirects} times (last: ${passage.title} → ${redirect})`);
      tx = this.entry(redirect, tx.gameState, (tx.redirects ?? 0) + 1);
    }
  }
  resolveInput(tx, node) {
    let value;
    try { value = getVariable(this.scope(tx), node.name); }
    catch { throw new Error(`Input $${node.name} needs a starting value; add it in Variables or assign it first`); }
    const inputType = node.inputType ?? inferInputType(value);
    if (typeof value !== INPUT_EXPECTED[inputType]) throw new Error(`Input $${node.name} is a ${inputType} field but the value is ${formatValue(value)}`);
    return { type: 'input', name: node.name, inputType, label: node.label };
  }
  effect(tx, node, tick = () => {}) {
    const operator = node.operator ?? '=', value = evaluate(node.expression, this.scope(tx), tick);
    let before = null, existed = true;
    try { before = clone(getVariable(this.scope(tx), node.name)); }
    catch (error) { if (operator !== '=') throw new Error(`$${node.name} has no value yet; set it before using ${operator}`); existed = false; }
    let after = value;
    if (operator !== '=') {
      if (typeof before !== 'number' || typeof value !== 'number') throw new Error(`${operator} needs numbers: $${node.name} is ${formatValue(before)}, value is ${formatValue(value)}`);
      after = before + (operator === '+=' ? value : -value);
      if (!Number.isFinite(after)) throw new Error('Nonfinite arithmetic result');
    }
    this.set(tx, node.name, after);
    const resolved = scopedVariable(node.name);
    return { path: resolved.local ? formatPath(resolved.path) : formatPath(resolved.path.slice(1)), operation: operator === '=' ? 'set' : 'add', existed, before, after: clone(after), delta: existed && typeof before === 'number' && typeof after === 'number' && Number.isFinite(after - before) ? after - before : null };
  }
  chooseGroup(groupId, optionIds, render = () => {}) {
    if (!this.pendingGroup || this.pendingGroup.id !== groupId) throw new Error('This choice is no longer active');
    if (!Array.isArray(optionIds) || !optionIds.length || new Set(optionIds).size !== optionIds.length) throw new Error('Select at least one distinct option');
    const tx = this.transaction(), pending = tx.pendingGroup;
    const node = nodeAtPath(this.compiled.get(tx.passageId).ast, pending.path);
    if (node.mode === 'single' && optionIds.length !== 1) throw new Error('Choose exactly one option');
    const options = node.options.filter(option => optionIds.includes(option.id));
    if (options.length !== optionIds.length || options.some(option => !pending.optionIds.includes(option.id) || option.conditions.some(c => !boolean(evaluate(c.expression, this.scope(tx)))))) throw new Error('Selected option is not available');
    const targets = new Set(options.map(option => option.target).filter(Boolean));
    if (targets.size > 1) throw new Error('Selected options have conflicting destinations');
    const target = [...targets][0] ?? null, passage = this.passage(tx.passageId);
    for (const option of options) {
      const changes = [];
      for (const effect of option.effects) {
        if (node.personalityType && scopedVariable(effect.name).local) throw new Error('Personality choices change global values only');
        changes.push(this.effect(tx, effect));
      }
      tx.gameState.observations.push({ sequence: tx.gameState.observations.length + 1, timestamp: new Date().toISOString(), type: node.personalityType ?? 'choice', passage: { id: passage.id, title: passage.title }, choice: { id: `${groupId}_${option.id}`, label: option.label, targetPassageId: target }, changes });
    }
    tx.output.find(item => item.type === 'choiceGroup' && item.runtimeId === groupId).selectedIds = options.map(option => option.id);
    tx.pendingGroup = null;
    if (target) return this.commit(this.resume(this.entry(target, tx.gameState)), render);
    return this.commit(this.resume(tx), render);
  }
  input(name, type, raw) {
    const tx = this.transaction(), expected = INPUT_EXPECTED[type];
    if (!expected) throw new Error('Unsupported input type');
    if (typeof getVariable(this.scope(tx), name) !== expected) throw new Error(`Input $${name} has an incompatible current value`);
    let value;
    if (type === 'checkbox') { if (typeof raw !== 'boolean') throw new Error('Expected checkbox value'); value = raw; }
    else if (type === 'text') { if (typeof raw !== 'string') throw new Error('Expected text value'); value = raw; }
    else {
      if (typeof raw !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim())) throw new Error('Enter a finite number');
      value = Number(raw); if (!Number.isFinite(value)) throw new Error('Enter a finite number');
    }
    this.set(tx, name, value); this.commit(tx, () => {}); return value;
  }
  // Returns to an earlier state captured with transaction() (simulator undo).
  rewind(snapshot, render = () => {}) {
    const tx = clone(snapshot);
    if (!this.compiled.has(tx.passageId)) throw new Error('Cannot undo: the passage no longer exists');
    return this.commit(tx, render);
  }
  save() {
    if (!this.passageId) throw new Error('Start the story before saving');
    const saved = { format: 'storyline-save', formatVersion: 1, projectId: this.project.id, storyKey: storyKey(this.project), passageId: this.passageId, gameState: clone(this.gameState), localVariables: clone(this.local), output: clone(this.output), environment: clone(this.environment), scene: this.scene, continuation: clone(this.continuation), pendingGroup: clone(this.pendingGroup), entryId: this.entryId };
    return validateSave(saved, this.project, this.compiled);
  }
  restore(saved, render = () => {}) {
    validateSave(saved, this.project, this.compiled);
    const tx = { gameState: clone(saved.gameState), local: clone(saved.localVariables), passageId: saved.passageId, output: clone(saved.output), environment: clone(saved.environment), scene: saved.scene, continuation: clone(saved.continuation), pendingGroup: clone(saved.pendingGroup), entryId: saved.entryId };
    return this.commit(tx, render);
  }
}
