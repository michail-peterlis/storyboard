// Regression tests for findings of the independent review (see README → Verification).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightStoryLine, highlightInline } from '../src/highlight.js';
import { emptyProject, validateProject } from '../src/model.js';
import { compilePassage, compileProject } from '../src/compiler.js';
import { renamePassage } from '../src/commands.js';
import { StoryRuntime } from '../src/runtime.js';
import { validateSave } from '../src/save.js';

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function project(sources, extra = {}) {
  const base = emptyProject();
  base.passages = Object.entries(sources).map(([id, source], i) => ({ id, title: id.replace(/_/g, ' '), position: { x: i * 300, y: 0 }, source }));
  base.startPassageId = base.passages[0].id; Object.assign(base, extra); return validateProject(base);
}
const errors = r => r.diagnostics.filter(d => d.severity === 'error').map(d => d.message);

test('R1 highlighter handles emphasis without recursion and escapes HTML', () => {
  const html = highlightStoryLine('This is *very* **important** <b>x</b>', esc);
  assert.ok(html.includes('tok-em') && html.includes('tok-strong') && html.includes('&lt;b&gt;') && !html.includes('<b>'));
  assert.ok(highlightInline('*a* and **b** and *unterminated', esc).includes('*unterminated'));
});
test('R3 rename never writes a title link that resolves elsewhere', () => {
  const p = project({ Start: '* Walk [Gate]\nSee [gate].', Gate: 'x', Other: 'y' });
  p.passages[1].title = 'Gate';
  renamePassage(p, 'Gate', 'Other');
  const start = p.passages[0].source;
  assert.ok(start.includes('[Other_2]') && !start.includes('[Other]\n') && !/\[Other\]/.test(start), start);
  const compiled = compilePassage(p, p.passages[0]);
  assert.deepEqual(compiled.edges.map(e => e.to), ['Other_2', 'Other_2']);
});
test('R7 unclosed ( in a choice is an error', () => {
  const r = compilePassage(...(() => { const p = project({ A: '* a ($x = 1 [B]', B: 'x' }); return [p, p.passages[0]]; })());
  assert.ok(errors(r).some(m => m.includes('Unclosed (')));
  const ok = compilePassage(...(() => { const p = project({ A: '* Say (hello) there [B]\n* Nod \\(silently\\)', B: 'x' }); return [p, p.passages[0]]; })());
  assert.deepEqual(errors(ok), []);
});
test('R8 saves cannot smuggle controls into choice labels', () => {
  const p = project({ A: '* One\n* Two', B: 'x' });
  const rt = new StoryRuntime(p); rt.enter('A');
  const save = rt.save();
  const tampered = structuredClone(save);
  tampered.output[0].options[0].inline.push({ type: 'link', target: 'B', label: 'B' });
  assert.throws(() => validateSave(tampered, rt.project, compileProject(rt.project)), /controls/);
});
test('R9/R10/R11 blank link, reserved assignment, observations read', () => {
  const r = compilePassage(...(() => { const p = project({ A: '[ ]\n$gameState.observations = 1\n$observations = 2\n$local = 3\nCount ${$observations}' }); return [p, p.passages[0]]; })());
  assert.ok(errors(r).filter(m => m.includes('runtime-managed')).length === 3, errors(r).join(' | '));
  assert.ok(!errors(r).some(m => m.includes('Missing passage')));
  assert.ok(!r.diagnostics.some(d => d.message.includes('$observations is never set')));
});
