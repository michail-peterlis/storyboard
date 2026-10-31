import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject, newProject, validateProject } from '../src/model.js';
import { compilePassage, compileProject, resolveTarget, splitItems } from '../src/compiler.js';
import { parseInline } from '../src/inline.js';

function project(sources, extra = {}) {
  const base = emptyProject();
  base.passages = Object.entries(sources).map(([id, source], i) => ({ id, title: id.replace(/_/g, ' '), position: { x: i * 300, y: 0 }, source }));
  base.startPassageId = base.passages[0].id;
  Object.assign(base, extra);
  return validateProject(base);
}
const compile = (sources, extra) => { const p = project(sources, extra); return compilePassage(p, p.passages[0]); };
const errors = result => result.diagnostics.filter(d => d.severity === 'error').map(d => d.message);
const warnings = result => result.diagnostics.filter(d => d.severity === 'warning').map(d => d.message);

test('title line sets the title and is not content', () => {
  const result = compile({ A: '# Hello world\n\nText.' });
  assert.equal(result.title, 'Hello world');
  assert.deepEqual(result.ast.map(n => n.type), ['paragraph']);
});
test('comments before the title are allowed and a later # is a heading', () => {
  const result = compile({ A: '// note\n# Title\n\n# Not a title' });
  assert.equal(result.title, 'Title');
  assert.deepEqual(result.ast.map(n => n.type), ['heading']);
});
test('sections run to the next ## header; nested headings keep their level; notes vanish', () => {
  const result = compile({ A: '## environment\n### Setting\nINT. ROOM\nQuiet.\n\n#### Light\nDim.\n\n## scene\nEXT. YARD\n### Time\nDusk\n\n## notes\nTODO fix this\n* not a choice\n\n## story\n> Event\n\n## environment\nLater context' });
  assert.deepEqual(result.ast.map(n => [n.type, n.level]), [['environment', 3], ['environment', 0], ['environment', 4], ['environment', 0], ['scene', 0], ['scene', 3], ['scene', 0], ['description', undefined], ['environment', 0]]);
  assert.equal(result.ast[1].inline.filter(n => n.type === 'break').length, 1);
  assert.deepEqual(errors(result), []);
});
test('story content inside environment is an error; unknown sections warn; conditions scope sections', () => {
  const bad = compile({ A: '## environment\n* choice\n- Pete: hi' });
  assert.equal(errors(bad).filter(m => m.includes('belong in a environment section')).length, 2);
  const unknown = compile({ A: '## chapter one\nText' });
  assert.ok(warnings(unknown).some(m => m.includes('Unknown section')));
  const scoped = compile({ A: 'Story.\n\n? $x\n## environment\nOnly when x\n\nBack in the story.' }, { initialGameState: { player: { traits: {} }, x: true } });
  assert.deepEqual(scoped.ast.map(n => n.type), ['paragraph', 'if', 'paragraph']);
  assert.equal(scoped.ast[1].children[0].type, 'environment');
});
test('dialogue sides, speakers and joining', () => {
  const result = compile({ A: '- Pete: Hi.\n- Pete: Again.\n+ You: Hello.\n- Unnamed line' });
  const dialogue = result.ast.filter(n => n.type === 'dialogue');
  assert.equal(dialogue.length, 3);
  assert.deepEqual(dialogue.map(d => [d.side, d.speaker]), [['other', 'Pete'], ['player', 'You'], ['other', null]]);
});
test('choice group parses labels, conditions, effects, targets, types and multi-select', () => {
  const result = compile({ A: '* dialogue: Fine. ($gold >= 1; $player.traits.empathy += 1)\n* dialogue: Nope (\'a;b\' == $x) [B]', B: 'x' });
  const group = result.ast[0];
  assert.equal(group.type, 'choiceGroup'); assert.equal(group.personalityType, 'dialogue'); assert.equal(group.mode, 'single');
  assert.equal(group.options[0].label, 'Fine.'); assert.deepEqual(group.options[0].conditions.map(c => c.text), ['$gold >= 1']); assert.equal(group.options[0].effects[0].operator, '+=');
  assert.equal(group.options[1].target, 'B'); assert.equal(group.options[1].conditions[0].text, "'a;b' == $x");
  assert.ok(result.edges.some(e => e.to === 'B' && e.conditional));
  const multi = compile({ A: '* [ ] One ($local.a = 1)\n* [x] Two' });
  assert.equal(multi.ast[0].mode, 'multiple');
});
test('mixed personality types in one group is an error', () => {
  assert.ok(errors(compile({ A: '* thought: a\n* action: b' })).some(m => m.includes('share one type')));
});
test('conditional block, nested statements and redirect', () => {
  const result = compile({ A: '? $gold > 0\nRich.\n* Spend ($gold -= 1)\n\n? $gold == 0 [B]\n\n? $done\n$x = 1', B: 'x' }, { initialGameState: { player: { traits: {} }, gold: 0, done: true, x: 0 } });
  assert.deepEqual(result.ast.map(n => n.type), ['if', 'redirect', 'if']);
  assert.deepEqual(result.ast[0].children.map(n => n.type), ['paragraph', 'choiceGroup']);
  assert.equal(result.ast[1].target, 'B');
  assert.deepEqual(errors(result), []);
  assert.ok(warnings(result).some(m => m.includes('skipped when the jump fires')));
});
test('consecutive ? lines start new blocks without a blank line', () => {
  const result = compile({ A: '? $a\nOne\n? $b\nTwo' }, { initialGameState: { player: { traits: {} }, a: true, b: false } });
  assert.deepEqual(result.ast.map(n => n.type), ['if', 'if']);
});
test('links resolve by id, exact title, case-insensitive title; ambiguity is an error', () => {
  const p = project({ A: '[B]\n\n[Second one]\n\n[second ONE]\n\n[Twin]', B: '', Second_one: '', T1: '', T2: '' });
  p.passages[3].title = 'Twin'; p.passages[4].title = 'Twin';
  const result = compilePassage(p, p.passages[0]);
  assert.deepEqual(result.edges.filter(e => !e.broken).map(e => e.to), ['B', 'Second_one', 'Second_one']);
  assert.ok(errors(result).some(m => m.includes('Ambiguous')));
  assert.equal(resolveTarget('nope', p.passages).id, null);
});
test('missing passage and stray brackets are errors with positions', () => {
  const result = compile({ A: 'Go [Nowhere] now.\nA [ lonely bracket' });
  assert.equal(result.diagnostics[0].line, 1); assert.equal(result.diagnostics[0].column, 5);
  assert.ok(errors(result).some(m => m.includes('Missing passage')));
  assert.ok(errors(result).some(m => m.includes('Unmatched [')));
});
test('assignments, interpolation, escapes and inputs', () => {
  const result = compile({ A: '$player.name = "Pete"\n$local.n += 1\nHello $player.name, you owe \\$5 and ${$local.n * 2}.\n[?player.name:text Your name] [?flag]' }, { initialGameState: { player: { traits: {}, name: '' }, flag: true }, initialVariables: { n: 0 } });
  assert.deepEqual(errors(result), []);
  assert.deepEqual(warnings(result), []);
  const paragraph = result.ast[2];
  assert.equal(paragraph.inline.filter(n => n.type === 'interp').length, 2);
  assert.ok(paragraph.inline.some(n => n.type === 'text' && n.text.includes('$5')));
  const inputs = paragraph.inline.filter(n => n.type === 'input');
  assert.deepEqual(inputs.map(i => [i.name, i.inputType, i.label]), [['player.name', 'text', 'Your name'], ['flag', null, 'Flag']]);
});
test('unknown variables warn, assigned ones do not', () => {
  const result = compile({ A: 'Hi $ghost.\n$known = 1\nAnd $known.' });
  assert.deepEqual(warnings(result).length, 1);
  assert.ok(warnings(result)[0].includes('$ghost'));
});
test('rules, comments, headings and macros', () => {
  const result = compile({ A: '---\n// hidden\n### Heading\n@awardCoin\n@missing' }, { customMacros: [{ id: 'awardCoin', code: '', targets: ['A'] }] });
  assert.deepEqual(result.ast.map(n => n.type), ['rule', 'heading', 'run', 'run']);
  assert.ok(errors(result).some(m => m.includes('Unknown macro @missing')));
  assert.ok(result.edges.some(e => e.kind === 'macro' && e.to === 'A'));
});
test('splitItems respects quotes and nesting', () => {
  assert.deepEqual(splitItems('$a >= 1; $b = "x;y"; $c = [1;2]').map(i => i.text.trim()), ['$a >= 1', '$b = "x;y"', '$c = [1;2]']);
});
test('inline parser handles emphasis, code and unterminated marks', () => {
  const { nodes, errors: errs } = parseInline('**bold** and *em* and `code **x**` and ** stray');
  assert.deepEqual(errs, []);
  assert.deepEqual(nodes.map(n => n.type), ['strong', 'text', 'em', 'text', 'code', 'text']);
  assert.ok(nodes.at(-1).text.includes('** stray'));
});
test('default project compiles without errors', () => {
  const compiled = compileProject(newProject());
  assert.deepEqual([...compiled.values()].flatMap(r => errors(r)), []);
});
