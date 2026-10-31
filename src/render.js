import { LIMITS, bytes, validateImage } from './model.js';
import { getVariable } from './paths.js';
import { INPUT_EXPECTED } from './runtime.js';

// Builds the reading view for one passage entry. Steps are split at rules (---);
// a step is one "message". Controls are built before any runtime commit so a failed
// transition leaves the previous presentation untouched.
export function createStoryView(doc, output, variables, { navigate, input, chooseGroup, diagnostic, environment = [], image = null, revealIndex = 0, initialRevealed = null, focusCurrent = true } = {}) {
  let count = 0, size = 0;
  const budget = value => { if (++count > LIMITS.nodes || (size += bytes(value ?? '')) > LIMITS.output) throw new Error('Rendered output budget exceeded'); };
  const element = (tag, className = '') => { budget(); const el = doc.createElement(tag); if (className) el.className = className; return el; };
  const text = value => { budget(value); return doc.createTextNode(value); };
  const control = (node, parent) => {
    const wrapper = element('span', 'story-input'), label = element('label'), field = element('input'), error = element('span', 'input-error');
    const value = getVariable(variables, node.name);
    if (typeof value !== INPUT_EXPECTED[node.inputType]) throw new Error(`Input $${node.name} has an incompatible value`);
    field.type = node.inputType; field.name = node.name; if (node.inputType === 'number') field.step = 'any';
    if (field.type === 'checkbox') field.checked = value; else { budget(String(value)); field.value = String(value); }
    field.setAttribute('aria-label', node.label);
    error.setAttribute('role', 'alert');
    if (node.inputType === 'checkbox') label.append(field, text(` ${node.label}`)); else label.append(text(`${node.label} `), field);
    field.addEventListener('change', () => {
      try { input?.(node.name, node.inputType, node.inputType === 'checkbox' ? field.checked : field.value); error.textContent = ''; field.removeAttribute('aria-invalid'); }
      catch (e) { error.textContent = e.message; field.setAttribute('aria-invalid', 'true'); diagnostic?.(e.message); }
    });
    wrapper.append(label, error); parent.append(wrapper);
  };
  const linkButton = (node, className = 'story-link') => {
    const button = element('button', className); button.type = 'button'; button.append(text(node.label));
    button.addEventListener('click', () => navigate?.(node.target, node.label)); return button;
  };
  const inline = (nodes, parent) => {
    for (const node of nodes) {
      if (node.type === 'text') parent.append(text(node.text));
      else if (node.type === 'break') parent.append(element('br'));
      else if (node.type === 'code') { const code = element('code'); code.append(text(node.text)); parent.append(code); }
      else if (node.type === 'strong' || node.type === 'em') { const el = element(node.type); inline(node.children, el); parent.append(el); }
      else if (node.type === 'link') parent.append(linkButton(node, 'story-link inline'));
      else if (node.type === 'input') control(node, parent);
      else throw new Error(`Unsupported inline node ${node.type}`);
    }
  };
  const render = (node, parent) => {
    if (node.type === 'paragraph') { const p = element('p', node.macro ? 'macro-output' : ''); inline(node.inline, p); parent.append(p); }
    else if (node.type === 'heading') { const h = element(node.level >= 4 ? 'h4' : node.level === 3 ? 'h3' : 'h2'); inline(node.inline, h); parent.append(h); }
    else if (node.type === 'description') { const p = element('p', 'description'); inline(node.inline, p); parent.append(p); }
    else if (node.type === 'dialogue') {
      const block = element('div', `dialogue ${node.side === 'player' ? 'side-player' : 'side-other'}`);
      if (node.speaker) { const speaker = element('span', 'speaker'); speaker.append(text(node.speaker)); block.append(speaker); }
      const line = element('p', 'line'); inline(node.inline, line); block.append(line); parent.append(block);
    }
    else if (node.type === 'scene') {
      // Consecutive scene nodes share one card: the first plain line is the slug, headings are sub-rows.
      let block = parent.lastElementChild;
      if (!block || !block.classList.contains('scene')) { block = element('div', 'scene'); const label = element('span', 'scene-label'); label.append(text('Scene')); block.append(label); parent.append(block); }
      const level = node.level ?? 0, row = element(level ? `h${Math.min(6, Math.max(3, level))}` : 'div', level ? `scene-heading level-${level}` : block.querySelector('.scene-body') ? 'scene-line' : 'scene-body');
      inline(node.inline, row); block.append(row);
    }
    else if (node.type === 'environment') {
      const level = node.level ?? 0, el = element(level ? `h${Math.min(6, Math.max(3, level))}` : 'p', level ? `environment-heading level-${level}` : 'environment-line');
      inline(node.inline, el); parent.append(el);
    }
    else if (node.type === 'link') {
      let group = parent.lastElementChild;
      if (!group || !group.classList.contains('story-links')) { group = element('div', 'story-links'); group.setAttribute('role', 'group'); parent.append(group); }
      group.append(linkButton(node));
    }
    else if (node.type === 'input') control(node, parent);
    else if (node.type === 'choiceGroup') {
      const wrapper = element('fieldset', 'story-choice-group'), legend = element('legend'), error = element('span', 'input-error');
      wrapper.dataset.groupId = node.id; wrapper.dataset.runtimeId = node.runtimeId; wrapper.dataset.mode = node.mode; wrapper.dataset.choiceType = node.personalityType ?? 'choice';
      const resolved = Array.isArray(node.selectedIds), controls = [];
      legend.append(text(resolved ? 'Your response' : node.personalityType ? `What do you ${{ thought: 'think', dialogue: 'say', action: 'do' }[node.personalityType]}?` : node.mode === 'multiple' ? 'Choose one or more' : 'Choose'));
      wrapper.append(legend); wrapper.dataset.resolved = String(resolved); error.setAttribute('role', 'alert');
      const select = ids => { try { chooseGroup?.(node.runtimeId, ids); error.textContent = ''; } catch (e) { error.textContent = e.message; diagnostic?.(e.message); } };
      for (const option of node.options) {
        const selected = resolved && node.selectedIds.includes(option.id);
        if (node.mode === 'multiple') {
          const label = element('label', `story-option${selected ? ' selected' : ''}`), box = element('input'); box.type = 'checkbox'; box.value = option.id;
          box.dataset.optionId = option.id; box.disabled = resolved; box.checked = selected;
          const span = element('span'); inline(option.inline, span); label.append(box, span); wrapper.append(label); controls.push(box);
        } else {
          const button = element('button', `story-option story-choice${selected ? ' selected' : ''}`); button.type = 'button';
          button.dataset.optionId = option.id; button.disabled = resolved; button.setAttribute('aria-pressed', String(selected)); inline(option.inline, button);
          button.addEventListener('click', () => select([option.id])); wrapper.append(button);
        }
      }
      if (node.mode === 'multiple') {
        const submit = element('button', 'story-choice-submit'); submit.type = 'button'; submit.append(text(resolved ? 'Selected' : 'Continue')); submit.disabled = resolved;
        submit.addEventListener('click', () => select(controls.filter(box => box.checked).map(box => box.value))); wrapper.append(submit);
      }
      wrapper.append(error); parent.append(wrapper);
    }
    else if (node.type === 'rule') { /* step boundary */ }
    else throw new Error(`Unsupported render node ${node.type}`);
  };
  // Split into steps at rules.
  const steps = [], stepNodes = [[]];
  output.forEach((node, index) => { if (node.type === 'rule') { if (stepNodes.at(-1).length) stepNodes.push([]); } else stepNodes.at(-1).push({ node, index }); });
  if (!stepNodes.at(-1).length && stepNodes.length > 1) stepNodes.pop();
  const fragment = doc.createDocumentFragment();
  let revealTarget = 0;
  for (const [index, nodes] of stepNodes.entries()) {
    const section = element('section', 'step'); section.dataset.step = String(index + 1);
    for (const { node, index: nodeIndex } of nodes) { render(node, section); if (nodeIndex >= revealIndex && revealTarget === 0 && index > 0) revealTarget = index; }
    steps.push(section); fragment.append(section);
  }
  // Images and environment are separate fragments so the shell can place them.
  const imageFragment = doc.createDocumentFragment();
  if (image) {
    validateImage(image);
    const figure = element('figure', 'story-image'), img = element('img');
    img.src = image.dataUrl; img.alt = image.caption || image.name; img.width = image.width; img.height = image.height; img.decoding = 'async'; figure.append(img);
    if (image.caption) { const caption = element('figcaption'); caption.append(text(image.caption)); figure.append(caption); }
    imageFragment.append(figure);
  }
  const environmentFragment = doc.createDocumentFragment();
  for (const node of environment) render(node, environmentFragment);
  let revealed = Math.max(1, Math.min(steps.length, initialRevealed ?? revealTarget + 1)), focused = focusCurrent;
  const state = () => ({ revealed, total: steps.length });
  function update() {
    steps.forEach((step, index) => {
      step.hidden = index >= revealed || (focused && index !== revealed - 1);
      step.classList.toggle('current-message', index === revealed - 1);
    });
  }
  function revealNext() { if (revealed < steps.length) revealed++; update(); return state(); }
  function showAll() { revealed = steps.length; update(); return state(); }
  function setFocused(value) { focused = !!value; update(); }
  // Read-only copy of revealed steps for the history transcript.
  function snapshot({ includeCurrent = true } = {}) {
    const result = doc.createDocumentFragment();
    for (const step of steps.slice(0, Math.max(0, revealed - (includeCurrent ? 0 : 1)))) {
      const copy = step.cloneNode(true); copy.hidden = false;
      const liveInputs = [...step.querySelectorAll('input')];
      [...copy.querySelectorAll('input')].forEach((field, index) => {
        const original = liveInputs[index], value = doc.createElement('span'); value.className = 'history-value';
        value.textContent = original.type === 'checkbox' ? (original.checked ? '☑' : '☐') : original.value; field.replaceWith(value);
      });
      for (const button of copy.querySelectorAll('button')) {
        const label = doc.createElement('span'); label.className = `history-option${button.classList.contains('selected') ? ' chosen' : ''}`;
        label.textContent = `${button.classList.contains('selected') ? '✓ ' : ''}${button.textContent}`; button.replaceWith(label);
      }
      const legend = copy.querySelector('fieldset[data-resolved="true"] legend'); if (legend) legend.textContent = 'Chosen response';
      for (const node of [copy, ...copy.querySelectorAll('*')]) for (const attribute of [...node.attributes]) if (!['class'].includes(attribute.name)) node.removeAttribute(attribute.name);
      result.append(copy);
    }
    return result;
  }
  update();
  return { fragment, imageFragment, environmentFragment, state, revealNext, showAll, setFocused, isFocused: () => focused, snapshot };
}
