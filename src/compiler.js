// Story language compiler: line-oriented syntax → AST, edges, diagnostics.
import { LIMITS } from './model.js';
import { parseExpression, variableNames } from './expression.js';
import { readVariable, hasVariable } from './paths.js';
import { parseInline, parseInputSpec, walkInline, inlineText } from './inline.js';

export const PERSONALITY_TYPES = ['thought', 'dialogue', 'action'];
export const SECTIONS = ['story', 'environment', 'scene', 'notes'];
const ASSIGNMENT = /^(\$[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\s*(?:"(?:[^"\\]|\\.)*"|\d+)\s*\])*)\s*(\+=|-=|=)(?!=)\s*(.*)$/s;

export function escapeText(text) { return text.replace(/[\\*_`$\[\]]/g, '\\$&'); }
export function linkSource(target) { return `[${target}]`; }

// Resolve a link target against passages: ID, exact title, case-insensitive title.
export function resolveTarget(text, passages) {
  const target = text.trim();
  const byId = passages.find(p => p.id === target);
  if (byId) return { id: byId.id, encoding: 'id', candidates: [byId] };
  const exact = passages.filter(p => p.title === target);
  if (exact.length === 1) return { id: exact[0].id, encoding: 'title', candidates: exact };
  if (exact.length > 1) return { id: null, encoding: 'title', candidates: exact };
  const loose = passages.filter(p => p.title.toLowerCase() === target.toLowerCase());
  if (loose.length === 1) return { id: loose[0].id, encoding: 'title', candidates: loose };
  return { id: null, encoding: 'title', candidates: loose };
}

function splitLines(source) {
  const lines = []; let start = 0;
  for (let i = 0; i <= source.length; i++) {
    if (i === source.length || source[i] === '\n') {
      let text = source.slice(start, i); if (text.endsWith('\r')) text = text.slice(0, -1);
      lines.push({ text, start, end: i });
      start = i + 1;
    }
  }
  return lines;
}
// Splits "a; b; $c = 1" at top-level semicolons (quotes and brackets respected).
export function splitItems(text) {
  const items = []; let depth = 0, quote = null, current = '', from = 0; const ranges = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { current += ch; if (ch === '\\') { current += text[++i] ?? ''; } else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--;
    if (ch === ';' && depth === 0) { items.push(current); ranges.push([from, i]); current = ''; from = i + 1; continue; }
    current += ch;
  }
  items.push(current); ranges.push([from, text.length]);
  return items.map((item, index) => ({ text: item, range: ranges[index] }));
}
// Finds a trailing "(...)" group in `text`; returns {inner, start, end} or null.
function trailingParens(text) {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(')')) return null;
  let depth = 0, quote = null;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const ch = trimmed[i];
    if (quote) { if (ch === quote && trimmed[i - 1] !== '\\') quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ')') depth++;
    else if (ch === '(') { depth--; if (depth === 0) { if (trimmed[i - 1] === '\\') return null; return { inner: trimmed.slice(i + 1, trimmed.length - 1), start: i, end: trimmed.length }; } }
  }
  return null;
}
function trailingTarget(text) {
  const match = /(^|[^\\])\[([^\[\]\n]*)\]\s*$/.exec(text);
  if (!match) return null;
  const inner = match[2];
  if (!inner.trim() || inner.startsWith('?') || inner.trim() === 'x') return null;
  const start = match.index + match[1].length;
  return { target: inner.trim(), raw: inner, start, end: start + inner.length + 2, targetStart: start + 1 };
}

export function compilePassage(project, passage, { assignedElsewhere = null } = {}) {
  const source = passage.source, lines = splitLines(source);
  const diagnostics = [], edges = [], ast = [], reads = [], assigned = new Set();
  const macros = new Map(project.customMacros.map(m => [m.id, m]));
  let title = null, titleRange = null, groupCount = 0, section = 'story';
  const inlineOptions = () => section === 'story' ? {} : { allowLinks: false, allowInputs: false };
  const locate = (lineIndex, column = 0, length = 0) => {
    const line = lines[Math.min(lineIndex, lines.length - 1)] ?? { start: 0, end: 0, text: '' };
    const start = line.start + column, end = length ? start + length : line.end;
    return { passageId: passage.id, line: lineIndex + 1, column: column + 1, range: [start, Math.max(start, end)] };
  };
  const report = (lineIndex, message, severity = 'error', column = 0, length = 0) => diagnostics.push({ ...locate(lineIndex, column, length), message, severity });
  const warn = (lineIndex, message, column, length) => report(lineIndex, message, 'warning', column, length);
  function expression(text, lineIndex, column) {
    const expr = parseExpression(text);
    for (const name of variableNames(expr)) reads.push({ name, line: lineIndex, column });
    return expr;
  }
  function inline(text, lineIndex, column, options = {}, condition = null) {
    const parsed = parseInline(text, options);
    for (const error of parsed.errors) report(lineIndex, error.message, 'error', column + error.offset, 1);
    walkInline(parsed.nodes, node => {
      if (node.type === 'interp') for (const name of variableNames(node.expression)) reads.push({ name, line: lineIndex, column });
      if (node.type === 'link') {
        const resolved = link(node.raw, lineIndex, column + node.offset, condition);
        node.target = resolved; delete node.raw; delete node.offset; delete node.end;
      }
      if (node.type === 'input') { reads.push({ name: node.name, line: lineIndex, column: column + (node.offset ?? 0), input: true }); delete node.offset; delete node.end; }
    });
    return parsed.nodes;
  }
  const conditionStack = [];
  function link(raw, lineIndex, column, extraCondition = null) {
    const resolved = resolveTarget(raw, project.passages);
    const branches = [...conditionStack, ...(extraCondition && extraCondition !== conditionStack.at(-1) ? [extraCondition] : [])];
    const range = [lines[lineIndex].start + column, lines[lineIndex].start + column + raw.length];
    if (!resolved.id) {
      if (resolved.candidates.length > 1) report(lineIndex, `Ambiguous link “${raw.trim()}”: ${resolved.candidates.map(p => `[${p.id}]`).join(', ')} share this title. Use the ID.`, 'error', column, raw.length);
      else report(lineIndex, `Missing passage “${raw.trim()}”`, 'error', column, raw.length);
    }
    edges.push({ from: passage.id, to: resolved.id ?? raw.trim(), kind: 'source', macroId: null, range, targetRange: range, targetEncoding: resolved.encoding, conditional: branches.length > 0, label: branches.join(' › '), broken: !resolved.id });
    return resolved.id ?? raw.trim();
  }
  function assignment(text, lineIndex, column, where = null) {
    const match = ASSIGNMENT.exec(text.trim());
    if (!match) throw new Error('Assignment syntax: $variable = expression, += or -=');
    const variable = readVariable(match[1]);
    if (variable.end !== match[1].length) throw new Error(`Invalid variable path ${match[1]}`);
    if (!match[3].trim()) throw new Error('Assignment needs a value');
    if (where === 'personality' && (variable.path[0] === 'local')) throw new Error('Personality choices change global values only');
    const reserved = variable.path[0] === 'observations' || (variable.path[0] === 'gameState' && (variable.path.length < 2 || ['observations', 'local', 'gameState'].includes(variable.path[1]))) || (variable.path[0] === 'local' && variable.path.length < 2);
    if (reserved) throw new Error(`$${variable.name} is runtime-managed or a namespace and cannot be assigned`);
    assigned.add(variable.name);
    const node = { type: 'set', name: variable.name, operator: match[2], expression: expression(match[3], lineIndex, column + text.indexOf(match[3])), text: text.trim() };
    if (match[2] !== '=') reads.push({ name: variable.name, line: lineIndex, column, compound: true });
    return node;
  }
  function choiceLine(text, lineIndex, markerColumn) {
    let body = text, offset = markerColumn;
    const multiple = /^\[( |x)\]\s*/.exec(body);
    if (multiple) { body = body.slice(multiple[0].length); offset += multiple[0].length; }
    let personalityType = null;
    const typed = /^(thought|dialogue|action):\s*/.exec(body);
    if (typed) { personalityType = typed[1]; body = body.slice(typed[0].length); offset += typed[0].length; }
    let target = null, targetEncoding = 'id', targetSpan = null;
    const tail = trailingTarget(body);
    if (tail) { targetSpan = tail; body = body.slice(0, tail.start); }
    const conditions = [], effects = [];
    const parens = trailingParens(body);
    if (parens) {
      for (const item of splitItems(parens.inner)) {
        const itemText = item.text.trim(); if (!itemText) continue;
        const column = offset + parens.start + 1 + item.range[0] + (item.text.length - item.text.trimStart().length);
        try {
          if (ASSIGNMENT.test(itemText)) {
            if (personalityType && itemText.startsWith('$local')) throw new Error('Personality choices change global values only');
            effects.push(assignment(itemText, lineIndex, column));
          } else conditions.push({ text: itemText, expression: expression(itemText, lineIndex, column) });
        } catch (error) { report(lineIndex, `${error.message} — items in ( ) are conditions or $assignments; to keep parentheses in the label write \\( \\)`, 'error', column, itemText.length); }
      }
      body = body.slice(0, parens.start);
    }
    const label = body.trim();
    if (!label) report(lineIndex, 'Choice needs a label', 'error', markerColumn, 1);
    if (/(^|[^\\])\((?:[^)]*$)/.test(label) && /[=;$]/.test(label.slice(label.lastIndexOf('(')))) report(lineIndex, 'Unclosed ( in the choice; close the (condition; effect) list or escape it as \\(', 'error', offset + label.lastIndexOf('('), 1);
    const conditionText = conditions.map(c => c.text).join(' && ') || null;
    if (targetSpan) { target = link(targetSpan.raw, lineIndex, offset + targetSpan.targetStart, conditionText); targetEncoding = resolveTarget(targetSpan.raw, project.passages).encoding; }
    const labelNodes = inline(label, lineIndex, offset, { allowLinks: false, allowInputs: false });
    return { multiple: !!multiple, personalityType, label: inlineText(labelNodes) || label, labelNodes, conditions, effects, target, targetEncoding, location: locate(lineIndex, markerColumn) };
  }
  // ---- Block parsing -------------------------------------------------------------
  let index = 0, firstContent = true;
  const blank = line => !line || !line.text.trim();
  const marker = text => {
    const t = text.trimStart();
    if (/^-{3,}\s*$/.test(t)) return 'rule';
    if (/^\/\//.test(t)) return 'comment';
    if (/^#{1,6}(\s|$)/.test(t)) return 'heading';
    if (/^>(\s|$)/.test(t)) return 'description';
    if (/^\*\s/.test(t)) return 'choice';
    if (/^[+-]\s/.test(t)) return 'dialogue';
    if (/^\?(\s|$)/.test(t)) return 'condition';
    if (/^@[A-Za-z_]/.test(t)) return 'run';
    if (ASSIGNMENT.test(t)) return 'set';
    if (/^\[[^\[\]\n]*\S[^\[\]\n]*\]\s*$/.test(t) && !t.startsWith('[?')) return 'link';
    return 'text';
  };
  function parseBlock(container, stopAtCondition) {
    const line = lines[index], text = line.text, indent = text.length - text.trimStart().length, body = text.trimStart();
    const kind = marker(text);
    if (kind === 'comment') { index++; return; }
    // Author notes are skipped until the next section header.
    if (section === 'notes' && !/^##(?!#)/.test(body)) { index++; return; }
    const before = container.length;
    parseBlockInner(container, stopAtCondition, line, text, indent, body, kind);
    for (let i = before; i < container.length; i++) container[i].section = section;
  }
  function parseBlockInner(container, stopAtCondition, line, text, indent, body, kind) {
    if (kind === 'rule') { container.push({ type: 'rule', location: locate(index, indent) }); index++; return; }
    if (kind === 'heading') {
      const match = /^(#{1,6})\s*(.*)$/.exec(body), level = match[1].length, content = match[2].trim();
      if (level === 1 && firstContent) {
        title = content.replace(/\\(.)/g, '$1'); titleRange = [line.start + indent + match[0].length - match[2].length, line.end];
        if (!title) warn(index, 'Empty title; the passage keeps its current title', indent, 1);
        index++; return;
      }
      if (level === 2) {
        const name = content.toLowerCase();
        if (SECTIONS.includes(name)) { section = name; index++; return; }
        if (content) warn(index, `Unknown section “${content}”: sections are ## environment, ## scene, ## notes and ## story. Use ### for headings inside a section`, indent, body.length);
        else report(index, 'Section needs a name: ## environment, ## scene, ## notes or ## story', 'error', indent, body.length);
      }
      container.push({ type: 'heading', level: Math.max(2, level), inline: inline(content, index, indent + match[0].length - match[2].length, inlineOptions()), location: locate(index, indent) });
      index++; return;
    }
    if (kind === 'description') {
      const parts = []; const startLine = index;
      while (index < lines.length && marker(lines[index].text) === 'description') {
        const l = lines[index], col = l.text.indexOf('>') + 1, content = l.text.slice(col).trim();
        if (content) parts.push(...inline(content, index, col + (l.text.slice(col).length - l.text.slice(col).trimStart().length)), { type: 'break' });
        index++;
      }
      parts.pop();
      container.push({ type: 'description', inline: parts, location: locate(startLine) });
      return;
    }
    if (kind === 'dialogue') {
      const startLine = index; let previous = null;
      while (index < lines.length && marker(lines[index].text) === 'dialogue') {
        const l = lines[index], col = l.text.length - l.text.trimStart().length, t = l.text.trimStart();
        const side = t[0] === '+' ? 'player' : 'other';
        const rest = t.slice(1).trimStart(), restColumn = col + (t.length - rest.length);
        const named = /^((?:\\.|[^:\\\n])+?):\s+(.*)$/s.exec(rest);
        const speaker = named ? named[1].replace(/\\(.)/g, '$1').trim() : null;
        const content = named ? named[2] : rest;
        const contentColumn = restColumn + (named ? named[0].length - named[2].length : 0);
        const nodes = inline(content, index, contentColumn);
        if (previous && previous.side === side && (speaker === null || speaker === previous.speaker)) previous.inline.push({ type: 'break' }, ...nodes);
        else { previous = { type: 'dialogue', side, speaker, inline: nodes, location: locate(index, col) }; container.push(previous); }
        index++;
      }
      return;
    }
    if (kind === 'choice') {
      const options = [], startLine = index; let multiple = null, personalityType = null, mixedTypes = false, mixedModes = false;
      while (index < lines.length && marker(lines[index].text) === 'choice') {
        const l = lines[index], col = l.text.indexOf('*') + 2, rest = l.text.slice(col).trim();
        const option = choiceLine(rest, index, col + (l.text.slice(col).length - l.text.slice(col).trimStart().length));
        if (multiple === null) multiple = option.multiple; else if (multiple !== option.multiple) mixedModes = true;
        if (options.length === 0) personalityType = option.personalityType; else if (personalityType !== option.personalityType) mixedTypes = true;
        options.push(option); index++;
      }
      groupCount++;
      const id = `${personalityType ?? 'choice'}_${groupCount}`;
      if (mixedModes) warn(startLine, 'Mix of [ ] and plain options; the whole group is multi-select');
      if (mixedTypes) report(startLine, 'All options in a group must share one type (thought, dialogue or action)');
      const anyMultiple = options.some(o => o.multiple);
      if (anyMultiple && new Set(options.map(o => o.target).filter(Boolean)).size > 1) report(startLine, 'Multi-select options must share one target or all continue locally');
      const node = { type: 'choiceGroup', id, mode: anyMultiple ? 'multiple' : 'single', personalityType, location: locate(startLine),
        options: options.map((o, i) => ({ id: `${id}:${i + 1}`, label: o.label, inline: o.labelNodes, conditions: o.conditions, effects: o.effects, target: o.target, location: o.location })) };
      container.push(node);
      return;
    }
    if (kind === 'condition') {
      const col = indent + 1, rest = body.slice(1).trim(), restColumn = indent + (body.length - body.slice(1).trimStart().length);
      const tail = trailingTarget(rest);
      const conditionText = (tail ? rest.slice(0, tail.start) : rest).trim();
      let expr = null;
      if (!conditionText) report(index, 'Condition needs an expression, e.g. ? $gold >= 1', 'error', indent, body.length);
      else try { expr = expression(conditionText, index, restColumn); } catch (error) { report(index, error.message, 'error', restColumn, conditionText.length); }
      if (tail) {
        const target = link(tail.raw, index, restColumn + tail.targetStart, conditionText);
        container.push({ type: 'redirect', condition: conditionText, expression: expr, target, location: locate(index, indent) });
        index++; return;
      }
      const node = { type: 'if', condition: conditionText, expression: expr, children: [], location: locate(index, indent) };
      container.push(node); index++;
      if (conditionStack.length >= LIMITS.depth) { report(index - 1, 'Conditions nest too deeply'); return; }
      conditionStack.push(conditionText);
      const outerSection = section;
      while (index < lines.length && !blank(lines[index])) {
        const next = marker(lines[index].text);
        if (next === 'condition' || next === 'rule') break;
        parseBlock(node.children, true);
      }
      conditionStack.pop(); section = outerSection;
      return;
    }
    if (kind === 'run') {
      const match = /^@([A-Za-z_][A-Za-z0-9_-]*)\s*(.*)$/.exec(body);
      if (match[2]) report(index, 'Macro calls take no arguments', 'error', indent + match[0].length - match[2].length, match[2].length);
      if (!macros.has(match[1])) report(index, `Unknown macro @${match[1]}; create it in Macros`, 'error', indent, match[1].length + 1);
      else for (const target of macros.get(match[1]).targets) edges.push({ from: passage.id, to: target, kind: 'macro', macroId: match[1], range: [line.start + indent, line.end], targetRange: null, targetEncoding: 'id', conditional: conditionStack.length > 0, label: conditionStack.join(' › ') || `macro ${match[1]}`, broken: !project.passages.some(p => p.id === target) });
      container.push({ type: 'run', id: match[1], location: locate(index, indent) });
      index++; return;
    }
    if (kind === 'set') {
      try { container.push({ ...assignment(body, index, indent), location: locate(index, indent) }); }
      catch (error) { report(index, error.message, 'error', indent, body.length); }
      index++; return;
    }
    if (kind === 'link') {
      const raw = body.slice(1, body.lastIndexOf(']'));
      const target = link(raw, index, indent + 1, conditionStack.at(-1) ?? null);
      container.push({ type: 'link', target, location: locate(index, indent) });
      index++; return;
    }
    // Paragraph: consecutive text lines join with soft breaks.
    const parts = []; const startLine = index;
    while (index < lines.length && !blank(lines[index]) && marker(lines[index].text) === 'text') {
      const l = lines[index], col = l.text.length - l.text.trimStart().length;
      parts.push(...inline(l.text.trim(), index, col, inlineOptions()), { type: 'break' });
      index++;
    }
    parts.pop();
    container.push({ type: 'paragraph', inline: parts, location: locate(startLine) });
  }
  while (index < lines.length) {
    if (blank(lines[index])) { index++; continue; }
    if (marker(lines[index].text) === 'comment') { index++; continue; }
    parseBlock(ast, false);
    firstContent = false;
  }
  // Section pass: paragraphs and headings inside environment/scene become section nodes; notes vanish.
  const retag = nodes => {
    const result = [];
    for (const node of nodes) {
      const where = node.section ?? 'story'; delete node.section;
      if (node.type === 'if') { node.children = retag(node.children); result.push(node); continue; }
      if (where === 'story') { result.push(node); continue; }
      if (where === 'notes') continue;
      if (node.type === 'paragraph' || node.type === 'heading') result.push({ type: where, level: node.type === 'heading' ? node.level : 0, inline: node.inline, location: node.location });
      else report(node.location.line - 1, `Only text, ### headings and ? conditions belong in a ${where} section; add ## story before this line`);
    }
    return result;
  };
  const tagged = retag(ast); ast.length = 0; ast.push(...tagged);
  let contentSeen = false;
  const warnRedirects = nodes => {
    for (const node of nodes) {
      if (node.type === 'redirect') { if (contentSeen) warn(node.location.line - 1, 'Text before a conditional jump is skipped when the jump fires; put routing at the top of the passage'); }
      else if (node.type === 'if') warnRedirects(node.children);
      else if (!['set', 'run', 'rule', 'environment', 'scene'].includes(node.type)) contentSeen = true;
    }
  };
  warnRedirects(ast);
  // Unknown-variable warnings: not in defaults and not assigned anywhere in the project.
  const scopeKnown = name => {
    const path = readVariable('$' + name).path;
    if (path[0] === 'local') return path.length === 1 || hasVariable({ local: project.initialVariables }, name);
    if (path[0] === 'gameState') return path.length === 1 || hasVariable({ gameState: project.initialGameState }, name) || path[1] === 'observations';
    if (path[0] === 'observations') return true;
    return hasVariable(project.initialGameState, name) || (path.length === 1 && Object.hasOwn(project.initialGameState, path[0]));
  };
  const assignedAnywhere = assignedElsewhere ?? assigned;
  const prefixAssigned = name => [...assignedAnywhere].some(a => a === name || a.startsWith(name + '.') || a.startsWith(name + '[') || name.startsWith(a + '.') || name.startsWith(a + '['));
  for (const read of reads) {
    if (scopeKnown(read.name) || prefixAssigned(read.name)) continue;
    const message = read.input ? `Input $${read.name} needs a starting value in Variables` : `$${read.name} is never set and has no default in Variables; reading it will fail at play time`;
    warn(read.line, message, read.column, read.name.length + 1);
  }
  diagnostics.sort((a, b) => a.range[0] - b.range[0] || (a.severity === 'error' ? -1 : 1));
  return { ast, edges, diagnostics, title, titleRange, reads, assigned, errors: diagnostics.filter(d => d.severity === 'error').length };
}

export function compileProject(project) {
  // Two passes: collect assignments project-wide so unknown-variable warnings are precise.
  const first = new Map(project.passages.map(passage => [passage.id, compilePassage(project, passage)]));
  const assigned = new Set();
  for (const result of first.values()) for (const name of result.assigned) assigned.add(name);
  return new Map(project.passages.map(passage => [passage.id, compilePassage(project, passage, { assignedElsewhere: assigned })]));
}

// Collects variable paths available for autocomplete.
export function knownVariables(project, compiled = null) {
  const names = new Set();
  const walk = (value, prefix) => {
    names.add(prefix);
    if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, child] of Object.entries(value)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) walk(child, `${prefix}.${key}`);
  };
  for (const [key, value] of Object.entries(project.initialGameState)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) walk(value, key);
  for (const [key, value] of Object.entries(project.initialVariables)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) walk(value, `local.${key}`);
  for (const key of Object.keys(project.traitDefaults)) names.add(`player.traits.${key}`);
  if (compiled) for (const result of compiled.values()) for (const name of result.assigned) names.add(name);
  return [...names].sort();
}
