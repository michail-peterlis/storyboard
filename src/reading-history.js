import { bytes } from './model.js';

// Reading history belongs to this player session, never to the runtime or saves.
export function createReadingHistory(doc, { maxEntries = 50, maxBytes = 2 * 1024 * 1024, maxNodes = 20000 } = {}) {
  const entries = [];
  let totalBytes = 0, totalNodes = 0, trimmed = false;
  function archive(title, fragment, decision = '') {
    if (!fragment.hasChildNodes() && !decision) return;
    const section = doc.createElement('section'); section.className = 'history-entry';
    const heading = doc.createElement('h3'); heading.textContent = title; section.append(heading, fragment);
    if (decision) {
      const note = doc.createElement('p'); note.className = 'history-decision'; note.textContent = `→ ${decision}`; section.append(note);
    }
    const size = bytes(section.textContent) + [...section.querySelectorAll('img')].reduce((sum, image) => sum + bytes(image.getAttribute('src') ?? ''), 0), walker = doc.createTreeWalker(section);
    let nodes = 1;
    while (walker.nextNode()) nodes++;
    entries.push({ section, size, nodes }); totalBytes += size; totalNodes += nodes;
    // A single large illustration must not erase the latest passage transcript.
    while (entries.length > 1 && (entries.length > maxEntries || totalBytes > maxBytes || totalNodes > maxNodes)) {
      const old = entries.shift(); old.section.remove(); totalBytes -= old.size; totalNodes -= old.nodes; trimmed = true;
    }
  }
  function render(root) { root.replaceChildren(...entries.map(entry => entry.section)); }
  function clear() { entries.length = 0; totalBytes = totalNodes = 0; trimmed = false; }
  function truncate(count) { while (entries.length > count) { const old = entries.pop(); old.section.remove(); totalBytes -= old.size; totalNodes -= old.nodes; } }
  return { archive, render, clear, truncate, state: () => ({ entries: entries.length, trimmed, bytes: totalBytes, nodes: totalNodes }) };
}
