import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject, newProject, validateProject } from '../src/model.js';
import { StoryRuntime } from '../src/runtime.js';
import { compileProject } from '../src/compiler.js';
import { validateSave } from '../src/save.js';

function project(sources, extra = {}) {
  const base = emptyProject();
  base.passages = Object.entries(sources).map(([id, source], i) => ({ id, title: id, position: { x: i * 300, y: 0 }, source }));
  base.startPassageId = base.passages[0].id;
  Object.assign(base, extra);
  return validateProject(base);
}
const types = output => output.map(n => n.type);
const text = output => output.filter(n => n.inline).map(n => n.inline.filter(i => i.type === 'text').map(i => i.text).join('').trim()).join(' | ');

test('segments split at rules and choice groups pause execution', () => {
  const rt = new StoryRuntime(project({ A: 'One.\n\n---\n\nTwo.\n* Go ($gold += 1)\n* Stay\n\nAfter.' }, { initialGameState: { player: { traits: {} }, gold: 0 } }));
  rt.enter('A');
  assert.deepEqual(types(rt.output), ['paragraph', 'rule', 'paragraph', 'choiceGroup']);
  assert.ok(rt.pendingGroup);
  rt.chooseGroup(rt.pendingGroup.id, [rt.pendingGroup.optionIds[0]]);
  assert.deepEqual(types(rt.output), ['paragraph', 'rule', 'paragraph', 'choiceGroup', 'paragraph']);
  assert.equal(rt.gameState.gold, 1);
  assert.equal(rt.gameState.observations.length, 1);
  assert.equal(rt.gameState.observations[0].type, 'choice');
});
test('failed effects roll back the whole choice', () => {
  const rt = new StoryRuntime(project({ A: '* Bad ($gold += "x")\n* Fine' }, { initialGameState: { player: { traits: {} }, gold: 0 } }));
  rt.enter('A');
  const id = rt.pendingGroup.id;
  assert.throws(() => rt.chooseGroup(id, [rt.pendingGroup.optionIds[0]]), /needs numbers/);
  assert.equal(rt.gameState.gold, 0); assert.ok(rt.pendingGroup, 'group still pending');
  rt.chooseGroup(id, [rt.pendingGroup.optionIds[1]]);
  assert.equal(rt.pendingGroup, null);
});
test('choice with a target navigates and records the observation', () => {
  const rt = new StoryRuntime(project({ A: '* action: Leave ($player.traits.empathy += 1) [B]\n* action: Stay', B: 'There.' }));
  rt.enter('A');
  rt.chooseGroup(rt.pendingGroup.id, [rt.pendingGroup.optionIds[0]]);
  assert.equal(rt.passageId, 'B');
  assert.equal(rt.gameState.player.traits.empathy, 1);
  assert.equal(rt.gameState.observations[0].choice.targetPassageId, 'B');
});
test('conditions filter options and hidden options cannot be chosen', () => {
  const rt = new StoryRuntime(project({ A: '* Rich ($gold > 10)\n* Poor' }, { initialGameState: { player: { traits: {} }, gold: 0 } }));
  rt.enter('A');
  assert.deepEqual(rt.output[0].options.map(o => o.label), ['Poor']);
  assert.throws(() => rt.chooseGroup(rt.pendingGroup.id, ['choice_1:1']), /not available/);
});
test('multi-select applies every chosen option once', () => {
  const rt = new StoryRuntime(project({ A: '* [ ] A ($local.a = true)\n* [ ] B ($local.b = true)\n* [ ] C' }));
  rt.enter('A');
  rt.chooseGroup(rt.pendingGroup.id, [rt.pendingGroup.optionIds[0], rt.pendingGroup.optionIds[1]]);
  assert.deepEqual(rt.local, { a: true, b: true });
});
test('redirect enters the target with carried state and detects loops', () => {
  const rt = new StoryRuntime(project({ A: '$gold += 1\n? $gold >= 1 [B]\nNot reached.', B: 'Gold: $gold', Loop: '? true [Loop]' }, { initialGameState: { player: { traits: {} }, gold: 0 } }));
  rt.enter('A');
  assert.equal(rt.passageId, 'B'); assert.equal(text(rt.output), 'Gold: 1');
  assert.throws(() => rt.enter('Loop'), /looped more than/);
  assert.equal(rt.passageId, 'B', 'failed entry leaves state intact');
});
test('locals reset on entry, globals persist, inputs update state', () => {
  const rt = new StoryRuntime(project({ A: '$local.n += 1\n$gold += 1\nn=$local.n g=$gold [?player.name]', B: '[A]' }, { initialGameState: { player: { traits: {}, name: 'x' }, gold: 0 }, initialVariables: { n: 0 } }));
  rt.enter('A'); rt.enter('B'); rt.enter('A');
  assert.equal(text(rt.output), 'n=1 g=2');
  assert.equal(rt.input('player.name', 'text', 'Mika'), 'Mika');
  assert.equal(rt.gameState.player.name, 'Mika');
  assert.throws(() => rt.input('gold', 'number', 'abc'), /finite number/);
});
test('input type inference and errors', () => {
  const rt = new StoryRuntime(project({ A: '[?flag] [?count:text]' }, { initialGameState: { player: { traits: {} }, flag: true, count: 1 } }));
  assert.throws(() => rt.enter('A'), /is a text field but the value is 1/);
  const rt2 = new StoryRuntime(project({ A: '[?flag]' }, { initialGameState: { player: { traits: {} }, flag: true } }));
  rt2.enter('A');
  assert.equal(rt2.output[0].inline[0].inputType, 'checkbox');
});
test('environment and scene are captured separately', () => {
  const rt = new StoryRuntime(project({ A: '## environment\n### Weather\nRainy $gold\n\n## scene\nEXT. YARD\n### Time\nDusk\n\n## story\nText.' }, { initialGameState: { player: { traits: {} }, gold: 3 } }));
  rt.enter('A');
  assert.equal(rt.environment.length, 2); assert.equal(text(rt.environment), 'Weather | Rainy 3'); assert.equal(rt.environment[0].level, 3);
  assert.equal(rt.scene, 'EXT. YARD');
  assert.deepEqual(types(rt.output), ['scene', 'scene', 'scene', 'paragraph']);
});
test('macros need approval; with approval they can read, write, emit text and declared links', () => {
  const p = project({ A: '@m', B: 'end' }, { customMacros: [{ id: 'm', code: "ctx.set('gold', ctx.get('gold') + 5); ctx.text('Paid'); ctx.link('Go', 'B');", targets: ['B'] }], initialGameState: { player: { traits: {} }, gold: 0 } });
  assert.throws(() => new StoryRuntime(p).enter('A'), /JavaScript approval/);
  const rt = new StoryRuntime(p, { executeMacro: (code, ctx) => new Function('ctx', code)(ctx) });
  rt.enter('A');
  assert.equal(rt.gameState.gold, 5);
  assert.deepEqual(types(rt.output), ['paragraph', 'link']);
  assert.equal(rt.output[1].target, 'B');
});
test('saves round-trip through validation, including a pending group', () => {
  const p = newProject();
  const rt = new StoryRuntime(p);
  rt.enter(p.startPassageId);
  const save = rt.save();
  assert.equal(save.formatVersion, 1); assert.ok(save.pendingGroup);
  const rt2 = new StoryRuntime(p);
  rt2.restore(save);
  assert.equal(rt2.passageId, p.startPassageId);
  rt2.chooseGroup(rt2.pendingGroup.id, [rt2.pendingGroup.optionIds[0]]);
  assert.equal(rt2.gameState.observations.length, 1);
  const tampered = { ...save, continuation: [] };
  assert.throws(() => validateSave(tampered, rt.project, compileProject(rt.project)), /skip or replay|pending/);
  const other = newProject();
  assert.throws(() => validateSave(save, other, compileProject(other)), /different project/);
});
test('entry fails clearly on error diagnostics', () => {
  const rt = new StoryRuntime(project({ A: '[Nowhere]' }));
  assert.throws(() => rt.enter('A'), /Missing passage/);
});
