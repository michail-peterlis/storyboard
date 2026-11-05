// Passage map: cards, edges, pan/zoom, card dragging, drag-to-link wires.
import { CARD_WIDTH, GRID, snapPosition } from './layout.js';
const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attributes = {}) => { const el = document.createElementNS(SVG, tag); for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, String(value)); return el; };

export function createMap(root, hooks) {
  const world = root.querySelector('#world'), edgesSvg = root.querySelector('#edges'), cardsRoot = root.querySelector('#cards'), wire = root.querySelector('#wire-path'), hint = root.querySelector('#map-hint');
  const cards = new Map(); // id → { node, title, excerpt, badges, image, imageUrl, height }
  let view = { x: 0, y: 0, zoom: 1 }, drag = null, edgeSignature = '', selectedEdge = null, gridStep = GRID;
  const applyView = (animated = false) => {
    world.classList.toggle('animated', animated); root.classList.toggle('animated', animated);
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    // The dot grid follows the world so a dot sits on every snap point. Zoomed out it thins to every 2nd, 4th… grid
    // line, and cards snap to the dots that are visible, so the step always matches what is on screen.
    gridStep = GRID; while (gridStep * view.zoom < 16) gridStep *= 2;
    const size = gridStep * view.zoom;
    root.style.backgroundSize = `${size}px ${size}px`; root.style.backgroundPosition = `${view.x - size / 2}px ${view.y - size / 2}px`;
    hooks.onZoomLabel?.(view.zoom);
  };
  const button = (text, onClick, className = '') => { const el = document.createElement('button'); el.type = 'button'; el.textContent = text; el.className = className; el.addEventListener('click', onClick); return el; };
  const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };

  function renderCards(passages, { selectedId, playingId = null, startId, actEntryId, compiled, override = null }) {
    const present = new Set(passages.map(p => p.id));
    for (const [id, card] of cards) if (!present.has(id)) { card.node.remove(); cards.delete(id); }
    passages.forEach((passage, index) => {
      let card = cards.get(passage.id);
      if (!card) {
        const node = document.createElement('div'); node.className = 'passage-card has-port'; node.dataset.id = passage.id;
        const clip = document.createElement('div'); clip.className = 'card-clip';
        const body = document.createElement('div'); body.className = 'card-body';
        const title = document.createElement('div'); title.className = 'card-title';
        const star = document.createElement('span'); star.className = 'star'; star.hidden = true; star.textContent = '★';
        const titleText = document.createElement('span'); title.append(star, titleText);
        const excerpt = document.createElement('div'); excerpt.className = 'card-excerpt';
        const badges = document.createElement('div'); badges.className = 'card-badges';
        body.append(title, excerpt, badges); clip.append(body);
        const port = document.createElement('div'); port.className = 'card-port'; port.title = 'Drag to another passage to link'; port.dataset.port = passage.id;
        node.append(clip, port);
        node.addEventListener('dblclick', event => { if (!event.target.closest('.card-port')) hooks.onOpen?.(passage.id); });
        card = { node, clip, titleText, star, excerpt, badges, image: null, imageUrl: null }; cards.set(passage.id, card);
        cardsRoot.append(node);
      }
      const position = override?.id === passage.id ? override.position : passage.position, result = compiled.get(passage.id);
      const className = `passage-card has-port${passage.id === selectedId ? ' selected' : ''}${passage.id === playingId ? ' playing' : ''}${drag?.kind === 'card' && drag.id === passage.id ? ' dragging' : ''}`;
      if (card.node.className !== className) card.node.className = className;
      card.node.style.transform = `translate(${position.x}px, ${position.y}px)`;
      setText(card.titleText, passage.title || '(untitled)');
      card.star.hidden = passage.id !== startId;
      setText(card.excerpt, excerptOf(result));
      const badges = [];
      if (passage.id === playingId) badges.push(['playing', '▶ playing']);
      if (passage.id === actEntryId && passage.id !== startId) badges.push(['entry', 'act entry']);
      if (result.errors) badges.push(['error', `${result.errors} error${result.errors === 1 ? '' : 's'}`]);
      const warnings = result.diagnostics.length - result.errors;
      if (warnings) badges.push(['warning', `${warnings} warning${warnings === 1 ? '' : 's'}`]);
      const signature = JSON.stringify(badges);
      if (card.badgeSignature !== signature) { card.badgeSignature = signature; card.badges.replaceChildren(...badges.map(([cls, text]) => { const b = document.createElement('span'); b.className = `badge ${cls}`; b.textContent = text; return b; })); }
      if (passage.image) {
        if (!card.image) { card.image = document.createElement('img'); card.image.className = 'card-image'; card.image.loading = 'lazy'; card.image.decoding = 'async'; card.image.draggable = false; card.clip.prepend(card.image); }
        if (card.imageUrl !== passage.image.dataUrl) { card.image.src = passage.image.dataUrl; card.imageUrl = passage.image.dataUrl; }
        card.image.alt = passage.image.caption || passage.image.name;
      } else if (card.image) { card.image.remove(); card.image = null; card.imageUrl = null; }
      if (cardsRoot.children[index] !== card.node) cardsRoot.insertBefore(card.node, cardsRoot.children[index] ?? null);
    });
  }
  function excerptOf(result) {
    const parts = [];
    const walk = nodes => { for (const node of nodes) { if (parts.join(' ').length > 160) return; if (node.type === 'if') walk(node.children); else if (node.inline) parts.push(node.inline.filter(n => n.type === 'text').map(n => n.text).join('')); else if (node.type === 'choiceGroup') parts.push(node.options.map(o => `• ${o.label}`).join(' ')); } };
    walk(result.ast);
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  function cardHeight(id) { return cards.get(id)?.node.offsetHeight || 120; }
  function anchor(passage, position, side) {
    const height = cardHeight(passage.id);
    return side === 'out' ? { x: position.x + CARD_WIDTH, y: position.y + height / 2 } : { x: position.x, y: position.y + height / 2 };
  }
  function renderEdges(passages, edges, { override = null, titles }) {
    const positions = new Map(passages.map(p => [p.id, override?.id === p.id ? override.position : p.position]));
    const visible = edges.filter(edge => positions.has(edge.from) && positions.has(edge.to));
    const signature = JSON.stringify([[...positions], visible.map(e => [e.from, e.to, e.kind, e.label, e.conditional, e.broken]), [...cards.values()].map(c => c.node.offsetHeight), selectedEdge]);
    if (signature === edgeSignature) return;
    edgeSignature = signature;
    const defs = svg('defs'), marker = svg('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--line-2)' })); defs.append(marker);
    const markerSelected = svg('marker', { id: 'arrow-selected', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    markerSelected.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--accent)' })); defs.append(markerSelected);
    const markerBroken = svg('marker', { id: 'arrow-broken', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    markerBroken.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--danger)' })); defs.append(markerBroken);
    const nodes = [defs], counts = new Map(), seen = new Map();
    for (const edge of visible) { const key = `${edge.from}\0${edge.to}`; counts.set(key, (counts.get(key) ?? 0) + 1); }
    for (const edge of visible) {
      const key = `${edge.from}\0${edge.to}`, n = seen.get(key) ?? 0; seen.set(key, n + 1);
      const spread = (n - (counts.get(key) - 1) / 2) * 34;
      const from = anchor({ id: edge.from }, positions.get(edge.from), 'out'), to = anchor({ id: edge.to }, positions.get(edge.to), 'in');
      let d;
      if (edge.from === edge.to) { const p = positions.get(edge.from), h = cardHeight(edge.from); d = `M ${p.x + CARD_WIDTH} ${p.y + h / 2} C ${p.x + CARD_WIDTH + 90} ${p.y - 60 + spread}, ${p.x - 90} ${p.y - 60 + spread}, ${p.x} ${p.y + h / 2}`; }
      else { const dx = Math.max(60, Math.abs(to.x - from.x) / 2); d = `M ${from.x} ${from.y} C ${from.x + dx} ${from.y + spread}, ${to.x - dx} ${to.y + spread}, ${to.x} ${to.y}`; }
      const selected = selectedEdge === edge;
      const path = svg('path', { d, class: `${edge.kind}${edge.conditional ? ' conditional' : ''}${edge.broken ? ' broken' : ''}${selected ? ' selected' : ''}`, 'marker-end': `url(#${edge.broken ? 'arrow-broken' : selected ? 'arrow-selected' : 'arrow'})` });
      const title = svg('title'); title.textContent = `${titles.get(edge.from) ?? edge.from} → ${titles.get(edge.to) ?? edge.to}${edge.label ? ` · ${edge.label}` : ''}${edge.kind === 'macro' ? ` · macro ${edge.macroId}` : ''}`;
      path.append(title);
      path.addEventListener('click', event => { event.stopPropagation(); selectedEdge = edge; hooks.onEdge?.(edge); });
      nodes.push(path);
      if (edge.conditional || edge.kind === 'macro') {
        const label = svg('text', { class: 'edge-label', x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 + spread * 0.75 - 8, 'text-anchor': 'middle' });
        label.textContent = (edge.kind === 'macro' ? `@${edge.macroId}` : edge.label).slice(0, 40); nodes.push(label);
      }
    }
    edgesSvg.replaceChildren(...nodes);
  }
  // Every card is shown on the grid, whatever its stored position (older stories and hand-edited files are off-grid).
  const onGrid = passages => passages.map(p => ({ ...p, position: snapPosition(p.position) }));
  function render(data, { animated = false } = {}) {
    view = { ...data.viewport }; applyView(animated);
    const passages = onGrid(data.passages);
    renderCards(passages, data);
    renderEdges(passages, data.edges, data);
  }
  // ---- Pointer interaction -----------------------------------------------------------
  const client = event => { const rect = root.getBoundingClientRect(); return { x: (event.clientX - rect.left - view.x) / view.zoom, y: (event.clientY - rect.top - view.y) / view.zoom }; };
  root.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('path')) return;
    const port = event.target.closest('.card-port'), card = event.target.closest('.passage-card');
    if (!event.target.closest('button')) event.preventDefault();
    root.setPointerCapture(event.pointerId);
    if (port) {
      drag = { kind: 'link', pointer: event.pointerId, from: port.dataset.port, target: null };
      root.classList.add('linking'); hint.textContent = 'Drop on a passage to link'; hint.hidden = false;
      const start = client(event); wire.setAttribute('d', `M ${start.x} ${start.y} L ${start.x} ${start.y}`); return;
    }
    if (card) { drag = { kind: 'card', pointer: event.pointerId, id: card.dataset.id, start: { x: event.clientX, y: event.clientY }, origin: hooks.positionOf(card.dataset.id), moved: false, next: null }; hooks.onSelect?.(card.dataset.id, { center: false }); return; }
    drag = { kind: 'pan', pointer: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: { ...view }, moved: false }; root.classList.add('panning');
  });
  root.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    if (drag.kind === 'link') {
      const passage = hooks.positionOf(drag.from), from = { x: passage.x + CARD_WIDTH, y: passage.y + cardHeight(drag.from) / 2 }, to = client(event);
      wire.setAttribute('d', `M ${from.x} ${from.y} C ${from.x + 60} ${from.y}, ${to.x - 60} ${to.y}, ${to.x} ${to.y}`);
      const element = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.passage-card');
      const target = element && element.dataset.id !== drag.from ? element.dataset.id : null;
      if (target !== drag.target) { for (const card of cards.values()) card.node.classList.toggle('link-target', card.node.dataset.id === target); drag.target = target; hint.textContent = target ? `Link to “${hooks.titleOf(target)}”` : 'Drop on a passage to link'; }
      return;
    }
    const dx = event.clientX - drag.start.x, dy = event.clientY - drag.start.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    drag.moved = true;
    if (drag.kind === 'card') { drag.next = snapPosition({ x: drag.origin.x + dx / view.zoom, y: drag.origin.y + dy / view.zoom }, gridStep); hooks.onPreviewMove?.(drag.id, drag.next); }
    else { view = { ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy }; applyView(false); }
  });
  function finish(event, cancelled = false) {
    if (!drag || event.pointerId !== drag.pointer) return;
    const current = drag; drag = null;
    if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
    root.classList.remove('panning', 'linking'); hint.hidden = true; wire.removeAttribute('d');
    for (const card of cards.values()) card.node.classList.remove('link-target');
    if (cancelled) { hooks.onPreviewMove?.(null); return; }
    if (current.kind === 'link') { if (current.target) hooks.onLink?.(current.from, current.target); else hooks.onSelect?.(current.from, { center: false }); return; }
    if (current.kind === 'card') { if (current.moved && current.next) hooks.onMove?.(current.id, current.next); else hooks.onPreviewMove?.(null); return; }
    if (current.moved) hooks.onViewport?.(view);
  }
  root.addEventListener('pointerup', finish);
  root.addEventListener('pointercancel', event => finish(event, true));
  root.addEventListener('wheel', event => {
    event.preventDefault();
    const rect = root.getBoundingClientRect(), px = event.clientX - rect.left, py = event.clientY - rect.top;
    const factor = Math.exp(-Math.sign(event.deltaY) * (event.ctrlKey ? 0.25 : 0.12));
    zoomAround(factor, px, py);
  }, { passive: false });
  function zoomAround(factor, px = root.clientWidth / 2, py = root.clientHeight / 2) {
    const zoom = Math.min(2.5, Math.max(0.2, view.zoom * factor));
    view = { x: px - (px - view.x) * zoom / view.zoom, y: py - (py - view.y) * zoom / view.zoom, zoom };
    applyView(false); hooks.onViewport?.(view);
  }
  root.addEventListener('click', event => { if (!event.target.closest('path') && !event.target.closest('.passage-card')) { selectedEdge = null; edgeSignature = ''; hooks.onEdge?.(null); } });
  return {
    render, cardHeight,
    centerOn(position, id, { animated = true } = {}) {
      const height = cardHeight(id); position = snapPosition(position);
      view = { ...view, x: root.clientWidth / 2 - (position.x + CARD_WIDTH / 2) * view.zoom, y: root.clientHeight / 2 - (position.y + height / 2) * view.zoom };
      applyView(animated); hooks.onViewport?.(view); return view;
    },
    isVisible(position, id) {
      position = snapPosition(position);
      const height = cardHeight(id), left = position.x * view.zoom + view.x, top = position.y * view.zoom + view.y;
      return left >= 0 && top >= 0 && left + CARD_WIDTH * view.zoom <= root.clientWidth && top + height * view.zoom <= root.clientHeight;
    },
    fit(passages, { minZoom = 0.2 } = {}) {
      if (!passages.length) return view;
      passages = onGrid(passages);
      const xs = passages.map(p => p.position.x), ys = passages.map(p => p.position.y);
      const minX = Math.min(...xs), minY = Math.min(...ys), width = Math.max(...xs) - minX + CARD_WIDTH, height = Math.max(...passages.map(p => p.position.y + cardHeight(p.id))) - minY;
      const zoom = Math.min(1.25, Math.max(minZoom, Math.min((root.clientWidth - 80) / width, (root.clientHeight - 80) / height)));
      view = { x: (root.clientWidth - width * zoom) / 2 - minX * zoom, y: (root.clientHeight - height * zoom) / 2 - minY * zoom, zoom };
      applyView(true); hooks.onViewport?.(view); return view;
    },
    zoom(factor) { zoomAround(factor); },
    get viewport() { return { ...view }; },
    worldCenter() { return snapPosition({ x: (root.clientWidth / 2 - view.x) / view.zoom - CARD_WIDTH / 2, y: (root.clientHeight / 2 - view.y) / view.zoom - 60 }, gridStep); },
    clearEdgeSelection() { selectedEdge = null; edgeSignature = ''; }
  };
}
