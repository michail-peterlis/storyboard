// Dependency-free code editor: textarea input with a highlighted mirror layer,
// line numbers, diagnostics underlines, find bar and inline autocomplete.
import { highlightStoryLine, highlightJsLine } from './highlight.js';

const escapeHtml = text => text.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

export function createCodeEditor(parent, { mode = 'story', onChange = () => {}, onUndo = null, onRedo = null, completions = null, placeholder = '' } = {}) {
  const doc = parent.ownerDocument;
  parent.classList.add('code-editor');
  const gutter = doc.createElement('div'); gutter.className = 'code-gutter'; gutter.setAttribute('aria-hidden', 'true');
  const scroll = doc.createElement('div'); scroll.className = 'code-scroll';
  const layer = doc.createElement('pre'); layer.className = 'code-layer'; layer.setAttribute('aria-hidden', 'true');
  const squiggles = doc.createElement('div'); squiggles.className = 'code-squiggles';
  const input = doc.createElement('textarea'); input.className = 'code-input'; input.spellcheck = false; input.autocapitalize = 'off'; input.autocomplete = 'off'; input.wrap = 'soft'; input.placeholder = placeholder;
  input.setAttribute('aria-label', parent.getAttribute('aria-label') ?? 'Source');
  const popup = doc.createElement('div'); popup.className = 'code-complete'; popup.setAttribute('role', 'listbox'); popup.hidden = true;
  scroll.append(layer, squiggles, input); parent.append(gutter, scroll, popup);
  const highlighter = mode === 'js' ? highlightJsLine : highlightStoryLine;
  let diagnostics = [], suppress = false, syncQueued = false, lineNodes = [], shownLines = [], lineStarts = [0], lineHeights = [], expectedLayerHeight = -1;
  const headerPattern = /^\s*##(?!#)\s*(\S*)/;
  let complete = null; // { items, index, from, to }
  let findBar = null;

  function render() {
    const lines = input.value.split('\n');
    const safe = line => { try { return highlighter(line, escapeHtml); } catch { return escapeHtml(line); } };
    const headerOf = line => (mode === 'story' ? headerPattern.exec(line) : null);
    // Only the lines that changed are re-highlighted: the common prefix and suffix of the shown text are kept.
    let prefix = 0; const shared = Math.min(lines.length, shownLines.length);
    while (prefix < shared && lines[prefix] === shownLines[prefix]) prefix++;
    let suffix = 0; const maxSuffix = shared - prefix;
    while (suffix < maxSuffix && lines[lines.length - 1 - suffix] === shownLines[shownLines.length - 1 - suffix]) suffix++;
    // Author notes (## notes … next ##) are dimmed like comments, so a changed section header redraws the rest.
    for (let i = prefix; i < lines.length - suffix && suffix; i++) if (headerOf(lines[i])) suffix = 0;
    for (let i = prefix; i < shownLines.length - suffix && suffix; i++) if (headerOf(shownLines[i])) suffix = 0;
    let notes = false;
    for (let i = 0; i < prefix; i++) { const header = headerOf(lines[i]); if (header) notes = header[1].toLowerCase() === 'notes'; }
    let html = '';
    for (let i = prefix; i < lines.length - suffix; i++) {
      const header = headerOf(lines[i]); if (header) notes = header[1].toLowerCase() === 'notes';
      const content = safe(lines[i]);
      html += `<span class="ln">${notes && !header ? `<span class="tok-comment">${content}</span>` : content}\n</span>`;
    }
    const template = doc.createElement('template'); template.innerHTML = html;
    const fresh = [...template.content.children], anchor = lineNodes[lineNodes.length - suffix] ?? null, removed = lineNodes.length - suffix - prefix;
    for (const node of lineNodes.slice(prefix, lineNodes.length - suffix)) node.remove();
    if (fresh.length) { if (anchor) anchor.before(...fresh); else layer.append(...fresh); }
    lineNodes.splice(prefix, removed, ...fresh);
    shownLines = lines;
    lineStarts = new Array(lines.length);
    for (let i = 0, position = 0; i < lines.length; i++) { lineStarts[i] = position; position += lines[i].length + 1; }
    // Only the fresh lines are measured (the one forced layout per edit); the others keep their known heights.
    lineHeights.splice(prefix, removed, ...fresh.map(measure));
    expectedLayerHeight = layer.offsetHeight;
    drawSquiggles();
    while (gutter.children.length > lines.length) gutter.lastChild.remove();
    if (gutter.children.length < lines.length) {
      let numbers = ''; for (let i = gutter.children.length; i < lines.length; i++) numbers += `<div>${i + 1}</div>`;
      const more = doc.createElement('template'); more.innerHTML = numbers; gutter.append(more.content);
    }
    applyHeights(prefix);
  }
  const measure = node => node.getBoundingClientRect().height;
  function applyHeights(from) {
    // Wrapped lines: give each gutter number the height of its rendered line. Reads come before writes.
    const numbers = gutter.children, height = `${layer.scrollHeight}px`;
    for (let i = from; i < lineHeights.length; i++) { const value = `${lineHeights[i]}px`; if (numbers[i] && numbers[i].style.height !== value) numbers[i].style.height = value; }
    if (input.style.height !== height) input.style.height = height;
    if (gutter.scrollTop !== scroll.scrollTop) gutter.scrollTop = scroll.scrollTop;
  }
  function syncHeights() {
    // Full re-measure after anything that reflows the layer without editing it: width, font, or a dialog opening.
    lineHeights = lineNodes.map(measure); expectedLayerHeight = layer.offsetHeight;
    drawSquiggles(); applyHeights(0);
  }
  function offsetToNode(offset) {
    // Returns [textNode, offsetInNode] for a document offset inside the layer: binary search for the line, then walk it.
    let low = 0, high = lineStarts.length - 1;
    while (low < high) { const middle = (low + high + 1) >> 1; if (lineStarts[middle] <= offset) low = middle; else high = middle - 1; }
    const line = lineNodes[low];
    if (!line) return null;
    const walker = doc.createTreeWalker(line, 4);
    let node, position = lineStarts[low];
    while ((node = walker.nextNode())) {
      const length = node.nodeValue.length;
      if (offset <= position + length) return [node, offset - position];
      position += length;
    }
    return null;
  }
  function rectsFor(from, to) {
    const start = offsetToNode(from), end = offsetToNode(Math.max(from, to));
    if (!start || !end) return [];
    const range = doc.createRange(); range.setStart(...start); range.setEnd(...end);
    const base = layer.getBoundingClientRect();
    return [...range.getClientRects()].map(rect => ({ left: rect.left - base.left, top: rect.top - base.top, width: rect.width, height: rect.height }));
  }
  function drawSquiggles() {
    // Measure every range first, then build the marks: appending between measurements would force a layout each.
    const marks = [];
    for (const diagnostic of diagnostics) {
      const [from, to] = diagnostic.range;
      for (const rect of rectsFor(from, Math.max(to, from + 1))) {
        const mark = doc.createElement('div'); mark.className = `squiggle ${diagnostic.severity}`;
        mark.style.left = `${rect.left}px`; mark.style.top = `${rect.top + rect.height - 3}px`; mark.style.width = `${Math.max(6, rect.width)}px`;
        mark.title = diagnostic.message; marks.push(mark);
      }
    }
    squiggles.replaceChildren(...marks);
  }
  const queueSync = () => { if (!syncQueued) { syncQueued = true; requestAnimationFrame(() => { syncQueued = false; syncHeights(); }); } };
  input.addEventListener('input', () => {
    if (!suppress) onChange(input.value);
    render();
    updateCompletion();
  });
  scroll.addEventListener('scroll', () => { gutter.scrollTop = scroll.scrollTop; });
  new ResizeObserver(() => queueSync()).observe(scroll);
  // Font changes (editor settings) reflow the layer without changing the scroll box; our own renders are skipped.
  new ResizeObserver(() => { if (Math.abs(layer.offsetHeight - expectedLayerHeight) > 0.5) queueSync(); }).observe(layer);

  // ---- Autocomplete ---------------------------------------------------------------
  function updateCompletion() {
    if (!completions) return;
    const position = input.selectionStart;
    if (position !== input.selectionEnd) return hideCompletion();
    const result = completions(input.value, position);
    if (!result || !result.items.length) return hideCompletion();
    complete = { ...result, index: 0 };
    popup.replaceChildren(...result.items.slice(0, 60).map((item, index) => {
      const row = doc.createElement('div'); row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === 0));
      const kind = doc.createElement('span'); kind.className = 'kind'; kind.textContent = item.kind ?? '';
      const label = doc.createElement('span'); label.textContent = item.label;
      row.append(kind, label);
      if (item.detail) { const detail = doc.createElement('span'); detail.className = 'detail'; detail.textContent = item.detail; row.append(detail); }
      row.addEventListener('pointerdown', event => { event.preventDefault(); complete.index = index; accept(); });
      return row;
    }));
    popup.hidden = false;
    const rect = rectsFor(position, position)[0] ?? rectsFor(Math.max(0, position - 1), position)[0];
    const base = scroll.getBoundingClientRect(), parentRect = parent.getBoundingClientRect();
    if (rect) {
      const left = Math.min(base.left - parentRect.left + rect.left - scroll.scrollLeft + 2, parent.clientWidth - popup.offsetWidth - 8);
      popup.style.left = `${Math.max(0, left)}px`;
      const top = base.top - parentRect.top + rect.top + rect.height - scroll.scrollTop + 4;
      popup.style.top = `${top + popup.offsetHeight > parent.clientHeight ? top - rect.height - popup.offsetHeight - 6 : top}px`;
    }
  }
  function hideCompletion() { complete = null; popup.hidden = true; }
  function moveCompletion(delta) {
    if (!complete) return;
    const total = Math.min(complete.items.length, 60);
    complete.index = (complete.index + delta + total) % total;
    [...popup.children].forEach((row, index) => row.setAttribute('aria-selected', String(index === complete.index)));
    popup.children[complete.index]?.scrollIntoView({ block: 'nearest' });
  }
  function accept() {
    if (!complete) return;
    const item = complete.items[complete.index];
    const before = input.value.slice(0, complete.from), after = input.value.slice(complete.to);
    const insert = item.insert ?? item.label;
    const cursor = complete.from + (item.cursor ?? insert.length);
    setValue(before + insert + after, cursor, cursor, true);
    hideCompletion(); input.focus();
  }
  // ---- Find bar -------------------------------------------------------------------
  function openFind() {
    if (!findBar) {
      findBar = doc.createElement('div'); findBar.className = 'code-find';
      const field = doc.createElement('input'); field.type = 'search'; field.placeholder = 'Find…'; field.setAttribute('aria-label', 'Find in source');
      const count = doc.createElement('output'); const prev = doc.createElement('button'); prev.type = 'button'; prev.textContent = '↑'; const next = doc.createElement('button'); next.type = 'button'; next.textContent = '↓';
      const close = doc.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Close find');
      findBar.append(field, count, prev, next, close); parent.append(findBar);
      const search = (direction = 1, fromCursor = true) => {
        const needle = field.value; if (!needle) { count.value = ''; return; }
        const haystack = input.value.toLowerCase(), lower = needle.toLowerCase();
        const matches = []; let i = -1; while ((i = haystack.indexOf(lower, i + 1)) >= 0) matches.push(i);
        if (!matches.length) { count.value = '0'; return; }
        const start = fromCursor ? (direction > 0 ? input.selectionEnd : input.selectionStart - 1) : input.selectionStart;
        let hit = direction > 0 ? matches.find(m => m >= start) ?? matches[0] : [...matches].reverse().find(m => m < start) ?? matches.at(-1);
        input.setSelectionRange(hit, hit + needle.length); revealSelection();
        count.value = `${matches.indexOf(hit) + 1}/${matches.length}`;
      };
      field.addEventListener('input', () => search(1, false));
      field.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); search(event.shiftKey ? -1 : 1); } if (event.key === 'Escape') { closeFind(); input.focus(); } });
      prev.addEventListener('click', () => search(-1)); next.addEventListener('click', () => search(1)); close.addEventListener('click', () => { closeFind(); input.focus(); });
    }
    findBar.hidden = false;
    const field = findBar.querySelector('input');
    if (input.selectionEnd > input.selectionStart && input.selectionEnd - input.selectionStart < 100) field.value = input.value.slice(input.selectionStart, input.selectionEnd);
    field.focus(); field.select();
  }
  function closeFind() { if (findBar) findBar.hidden = true; }
  function revealSelection() {
    const rect = rectsFor(input.selectionStart, input.selectionStart)[0];
    if (!rect) return;
    const top = rect.top, viewTop = scroll.scrollTop, viewBottom = viewTop + scroll.clientHeight;
    if (top < viewTop + 20 || top + rect.height > viewBottom - 20) scroll.scrollTop = Math.max(0, top - scroll.clientHeight / 2);
  }
  // ---- Keys -------------------------------------------------------------------------
  input.addEventListener('keydown', event => {
    const mod = event.ctrlKey || event.metaKey;
    if (complete && !popup.hidden) {
      if (event.key === 'ArrowDown') { event.preventDefault(); moveCompletion(1); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); moveCompletion(-1); return; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); accept(); return; }
      if (event.key === 'Escape') { event.preventDefault(); hideCompletion(); return; }
    }
    if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) onRedo?.(); else onUndo?.(); return; }
    if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); onRedo?.(); return; }
    if (mod && event.key.toLowerCase() === 'f') { event.preventDefault(); openFind(); return; }
    if (mod && event.key === ' ') { event.preventDefault(); updateCompletion(); return; }
    if (event.key === 'Tab' && !mod) {
      event.preventDefault();
      const { selectionStart: start, selectionEnd: end } = input;
      if (start === end) { setValue(input.value.slice(0, start) + '  ' + input.value.slice(end), start + 2, start + 2, true); }
      else {
        // Indent or outdent selected lines.
        const lineStart = input.value.lastIndexOf('\n', start - 1) + 1;
        const block = input.value.slice(lineStart, end);
        const changed = event.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
        setValue(input.value.slice(0, lineStart) + changed + input.value.slice(end), lineStart, lineStart + changed.length, true);
      }
      return;
    }
    if (event.key === 'Enter' && !mod && !event.shiftKey) {
      // Keep indentation; continue list-like markers for choices and dialogue.
      const start = input.selectionStart, lineStart = input.value.lastIndexOf('\n', start - 1) + 1, line = input.value.slice(lineStart, start);
      const indent = /^\s*/.exec(line)[0];
      let prefix = indent;
      const marker = /^(\s*)([*>])\s(?:\[ \]\s)?/.exec(line);
      if (marker && line.trim().length > marker[0].trim().length) prefix = `${marker[1]}${marker[2]} `;
      if (prefix) { event.preventDefault(); setValue(input.value.slice(0, start) + '\n' + prefix + input.value.slice(input.selectionEnd), start + 1 + prefix.length, start + 1 + prefix.length, true); }
      return;
    }
    if (event.key === 'Escape' && findBar && !findBar.hidden) { closeFind(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (doc.activeElement !== input && !popup.contains(doc.activeElement)) hideCompletion(); }, 120));
  input.addEventListener('click', hideCompletion);

  function setValue(value, start = null, end = null, notify = false) {
    suppress = !notify;
    try {
      const changed = input.value !== value;
      if (changed) input.value = value;
      if (start !== null) input.setSelectionRange(start, end ?? start);
      if (changed) { render(); if (notify) onChange(value); }
    } finally { suppress = false; }
  }
  render();
  const control = {
    get value() { return input.value; },
    set value(value) {
      value = value.replace(/\r\n?/g, '\n');
      if (value === input.value) return;
      const anchor = Math.min(input.selectionStart, value.length);
      setValue(value, anchor, anchor, false);
    },
    get selectionStart() { return input.selectionStart; },
    get selectionEnd() { return input.selectionEnd; },
    focus() { input.focus(); },
    setSelectionRange(from, to = from) { input.setSelectionRange(Math.max(0, Math.min(from, input.value.length)), Math.max(0, Math.min(to, input.value.length))); revealSelection(); },
    replaceSelection(text, cursorOffset = null) {
      const { selectionStart: start, selectionEnd: end } = input;
      const cursor = start + (cursorOffset ?? text.length);
      setValue(input.value.slice(0, start) + text + input.value.slice(end), cursor, cursor, true); input.focus();
    },
    setDiagnostics(list) { diagnostics = list; drawSquiggles(); },
    refresh() { syncHeights(); },
    get element() { return input; }
  };
  parent.editor = control;
  return control;
}
