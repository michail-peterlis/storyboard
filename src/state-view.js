// Graphical runtime state: actors with trait bars, key/value rows, change flashes.
import { flattenJson } from './paths.js';
import { formatValue } from './paths.js';

export function createStateView(container, { flashMs = 3000 } = {}) {
  const doc = container.ownerDocument;
  let previous = null; // Map path → value (JSON string)
  const el = (tag, className = '', text = null) => { const node = doc.createElement(tag); if (className) node.className = className; if (text !== null) node.textContent = text; return node; };
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function changes(prefix, value) {
    const map = new Map();
    for (const row of flattenJson(value, prefix ? [prefix] : [])) map.set(row.path, JSON.stringify(row.value));
    return map;
  }
  function rows(parent, value, path, diff, depth = 0) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (isObject(child) && Object.keys(child).length) {
        const group = el('div', `state-group depth-${Math.min(depth, 3)}`);
        group.append(el('div', 'state-key', key));
        rows(group, child, childPath, diff, depth + 1); parent.append(group);
        continue;
      }
      const row = el('div', 'state-row'), label = el('span', 'state-label', key), valueText = el('span', 'state-value', formatValue(child));
      row.append(label);
      if (typeof child === 'number' && /traits$/.test(path)) {
        const bar = el('span', 'state-bar'), fill = el('span', `state-fill ${child < 0 ? 'negative' : ''}`);
        const scale = Math.max(5, ...Object.values(value).filter(v => typeof v === 'number').map(Math.abs));
        fill.style.width = `${Math.min(100, Math.abs(child) / scale * 100)}%`;
        bar.append(fill); row.append(bar);
      } else if (typeof child === 'boolean') valueText.className += child ? ' true' : ' false';
      row.append(valueText);
      const change = diff.get(childPath);
      if (change) {
        row.classList.add('changed');
        if (change.delta !== null) { const delta = el('span', `state-delta ${change.delta > 0 ? 'up' : 'down'}`, `${change.delta > 0 ? '+' : ''}${change.delta}`); row.append(delta); }
        else row.append(el('span', 'state-delta', change.previous === undefined ? 'new' : `was ${change.previous}`));
        setTimeout(() => row.classList.remove('changed'), flashMs);
      }
      parent.append(row);
    }
  }
  return {
    render({ gameState = null, local = null, passageId = null } = {}) {
      container.replaceChildren();
      if (!gameState) { container.append(el('p', 'muted', 'Start the preview to see the live state.')); return; }
      const { observations, ...globals } = gameState;
      const current = new Map([...changes('', globals), ...changes('local', local ?? {})]);
      const diff = new Map();
      if (previous) for (const [path, value] of current) {
        if (previous.get(path) === value) continue;
        const before = previous.has(path) ? JSON.parse(previous.get(path)) : undefined, after = JSON.parse(value);
        diff.set(path, { previous: before === undefined ? undefined : formatValue(before), delta: typeof before === 'number' && typeof after === 'number' ? Math.round((after - before) * 1000) / 1000 : null });
      }
      previous = current;
      const actors = Object.entries(globals).filter(([, value]) => isObject(value) && Object.hasOwn(value, 'traits'));
      const rest = Object.fromEntries(Object.entries(globals).filter(([key]) => !actors.some(([name]) => name === key)));
      for (const [name, actor] of actors) {
        const card = el('section', 'state-card'); card.append(el('h4', '', name));
        const { traits, ...fields } = actor;
        if (isObject(traits) && Object.keys(traits).length) { const group = el('div', 'state-group traits'); group.append(el('div', 'state-key', 'traits')); rows(group, traits, `${name}.traits`, diff, 1); card.append(group); }
        if (Object.keys(fields).length) rows(card, fields, name, diff, 1);
        container.append(card);
      }
      if (Object.keys(rest).length) { const card = el('section', 'state-card'); card.append(el('h4', '', 'Globals')); rows(card, rest, '', diff); container.append(card); }
      if (local && Object.keys(local).length) { const card = el('section', 'state-card'); card.append(el('h4', '', `Local · ${passageId ?? ''}`)); rows(card, local, 'local', diff); container.append(card); }
      if (Array.isArray(observations) && observations.length) {
        const card = el('section', 'state-card'); card.append(el('h4', '', `Observations (${observations.length})`));
        for (const record of observations.slice(-12).reverse()) {
          const row = el('div', 'observation');
          row.append(el('span', 'observation-type', record.type), el('span', 'observation-label', record.choice.label), el('span', 'observation-passage', record.passage.title));
          if (record.changes.length) row.append(el('span', 'observation-changes', record.changes.map(c => `${c.path} ${c.delta !== null ? (c.delta > 0 ? '+' : '') + c.delta : '= ' + formatValue(c.after)}`).join(' · ')));
          card.append(row);
        }
        container.append(card);
      }
    },
    reset() { previous = null; }
  };
}
