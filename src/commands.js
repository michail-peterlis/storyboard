// Source-editing commands: rename with link updates, snippet insertion, link insertion, drag-to-link.
import { passageIdForTitle } from './model.js';
import { compilePassage, escapeText } from './compiler.js';

// Renames a passage; its ID follows the title and every link to it is rewritten.
export function renamePassage(project, id, title) {
  const passage = project.passages.find(p => p.id === id);
  if (!passage) throw new Error(`Missing passage ${id}`);
  const nextId = passageIdForTitle(title, project.passages, id), macrosToReview = [];
  const oldTitle = passage.title, cleanTitle = title.trim();
  // A title link stays a title link only when it still resolves to this passage alone.
  const clash = project.passages.some(p => p.id !== id && (p.id === cleanTitle || p.title.toLowerCase() === cleanTitle.toLowerCase()));
  const titleLink = cleanTitle && !clash && !/[\[\]\n]/.test(cleanTitle) && !cleanTitle.startsWith('?') ? cleanTitle : nextId;
  for (const other of project.passages) {
    const edges = compilePassage(project, other).edges.filter(edge => edge.kind === 'source' && edge.to === id && edge.targetRange).sort((a, b) => b.targetRange[0] - a.targetRange[0]);
    for (const edge of edges) {
      const [start, end] = edge.targetRange, text = other.source.slice(start, end).trim();
      if (text !== id && text !== oldTitle && text.toLowerCase() !== oldTitle.toLowerCase()) throw new Error('Cannot safely locate a link target; rename cancelled');
      other.source = other.source.slice(0, start) + (edge.targetEncoding === 'title' ? titleLink : nextId) + other.source.slice(end);
    }
  }
  // Title heading inside the passage itself (first content line).
  const lines = passage.source.split('\n'); let first = 0;
  while (first < lines.length && (!lines[first].trim() || lines[first].trimStart().startsWith('//'))) first++;
  const heading = /^(\s*#\s+)(.*)$/.exec(lines[first] ?? '');
  if (heading && heading[2].trim() !== title.trim()) { lines[first] = heading[1] + title; passage.source = lines.join('\n'); }
  if (nextId !== id) {
    if (project.startPassageId === id) project.startPassageId = nextId;
    for (const act of project.editor.actLayout?.acts ?? []) { act.passageIds = act.passageIds.map(p => p === id ? nextId : p); if (act.startPassageId === id) act.startPassageId = nextId; }
    for (const macro of project.customMacros) { if (macro.targets.includes(id) || macro.code.includes(id)) macrosToReview.push(macro.id); macro.targets = [...new Set(macro.targets.map(t => t === id ? nextId : t))]; }
  }
  passage.title = title; passage.id = nextId;
  return { id: nextId, oldId: id, macrosToReview };
}
export function appendLink(source, target, label = null) {
  const line = label ? `* ${escapeText(label)} [${target}]` : `[${target}]`;
  const trimmed = source.replace(/\s+$/, '');
  return `${trimmed}${trimmed ? '\n\n' : ''}${line}\n`;
}
export const SNIPPETS = {
  scene: { text: '## scene\nINT. LOCATION — TIME\n', select: [9, 29], block: true },
  environment: { text: '## environment\nRain taps the window.\n', select: [15, 36], block: true },
  description: { text: '> Something happens.\n', select: [2, 19], block: true },
  dialogue: { text: '- Name: Hello.\n+ You: Hi.\n', select: [2, 6], block: true },
  choice: { text: '* Yes ($local.answer = true)\n* No ($local.answer = false)\n', select: [2, 5], block: true },
  condition: { text: '? $local.answer == true\nShown only when the condition holds.\n', select: [2, 23], block: true },
  input: { text: '[?player.name:text Your name]', select: [2, 13], block: false },
  set: { text: '$player.gold += 1\n', select: [1, 12], block: true },
  rule: { text: '---\n', select: null, block: true }
};
export function insertSnippet(source, start, end, name) {
  const snippet = SNIPPETS[name];
  if (!snippet) throw new Error(`Unknown snippet ${name}`);
  const before = source.slice(0, start), after = source.slice(end);
  let prefix = '', suffix = '';
  if (snippet.block) {
    if (before && !/\n\n$/.test(before)) prefix = /\n$/.test(before) ? '\n' : '\n\n';
    if (after && !/^\n/.test(after)) suffix = '\n';
  }
  const text = prefix + snippet.text + suffix, cursor = before.length + prefix.length;
  return { source: before + text + after, selection: snippet.select ? snippet.select.map(n => n + cursor) : [cursor + text.length, cursor + text.length] };
}
