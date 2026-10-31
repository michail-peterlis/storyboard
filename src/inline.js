// Inline syntax: \escapes, **strong**, *em*, _em_, `code`, $path, ${expr}, [target], [?var:type Label].
import { parseExpression } from './expression.js';
import { readVariable } from './paths.js';

export const INPUT_TYPES = ['text', 'number', 'checkbox'];

export function parseInputSpec(body) {
  // body: "var", "var:type", "var:type Label", "var Label"
  const match = /^([A-Za-z_][A-Za-z0-9_.\[\]"]*)(?::(text|number|checkbox))?(?:\s+(.*))?$/s.exec(body.trim());
  if (!match) throw new Error('Input syntax: [?variable], [?variable:type] or [?variable:type Label]');
  const variable = readVariable('$' + match[1]);
  if (variable.end !== match[1].length + 1) throw new Error(`Invalid variable path ${match[1]}`);
  const label = match[3]?.trim() || humanize(variable.path.at(-1));
  return { name: variable.name, inputType: match[2] ?? null, label };
}
export function humanize(key) {
  const text = String(key).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : 'Value';
}

// Returns { nodes, errors:[{message, offset}] }. Offsets are relative to `text`.
export function parseInline(text, { allowLinks = true, allowInputs = true } = {}) {
  const errors = [];
  const root = { children: [] }, stack = [root];
  let pending = '';
  const flush = () => { if (pending) { stack.at(-1).children.push({ type: 'text', text: pending }); pending = ''; } };
  const openMark = (type, marker, offset) => { flush(); const node = { type, marker, offset, children: [] }; stack.at(-1).children.push(node); stack.push(node); };
  const closeMark = marker => {
    const index = stack.findLastIndex(node => node.marker === marker);
    if (index < 1) return false;
    flush();
    // Any marks opened after this one are unterminated: dissolve them into text.
    while (stack.length - 1 > index) dissolve(stack.pop());
    stack.pop();
    return true;
  };
  function dissolve(node) {
    const parent = stack.at(-1);
    const position = parent.children.indexOf(node);
    parent.children.splice(position, 1, { type: 'text', text: node.marker }, ...node.children);
  }
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) { pending += text[i + 1]; i += 2; continue; }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) { flush(); stack.at(-1).children.push({ type: 'code', text: text.slice(i + 1, end) }); i = end + 1; continue; }
      pending += ch; i++; continue;
    }
    if (ch === '*' || ch === '_') {
      const double = text[i + 1] === ch, marker = double ? ch + ch : ch;
      const before = text[i - 1] ?? ' ', after = text[i + marker.length] ?? ' ';
      if (ch === '_' && /\w/.test(before) && /\w/.test(after)) { pending += ch; i++; continue; } // snake_case stays text
      if (closeMark(marker)) { i += marker.length; continue; }
      if (/\S/.test(after)) { openMark(double ? 'strong' : 'em', marker, i); i += marker.length; continue; }
      pending += marker; i += marker.length; continue;
    }
    if (ch === '$') {
      if (text[i + 1] === '{') {
        let depth = 0, end = -1;
        for (let j = i + 1; j < text.length; j++) { if (text[j] === '{') depth++; else if (text[j] === '}' && --depth === 0) { end = j; break; } }
        if (end < 0) { errors.push({ message: 'Unclosed ${ expression }', offset: i }); pending += text.slice(i); break; }
        const source = text.slice(i + 2, end);
        flush();
        try { stack.at(-1).children.push({ type: 'interp', expression: parseExpression(source), text: source }); }
        catch (error) { errors.push({ message: error.message, offset: i + 2 }); stack.at(-1).children.push({ type: 'text', text: text.slice(i, end + 1) }); }
        i = end + 1; continue;
      }
      if (/[A-Za-z_]/.test(text[i + 1] ?? '')) {
        try {
          const variable = readVariable(text.slice(i));
          flush(); stack.at(-1).children.push({ type: 'interp', expression: { type: 'variable', name: variable.name, root: variable.path[0] }, text: '$' + variable.name });
          i += variable.end; continue;
        } catch (error) { errors.push({ message: error.message, offset: i }); }
      }
      pending += ch; i++; continue;
    }
    if (ch === '[') {
      const end = text.indexOf(']', i + 1);
      const body = end > 0 ? text.slice(i + 1, end) : null;
      if (body !== null && !body.includes('[') && !body.includes('\n')) {
        if (body.startsWith('?')) {
          if (!allowInputs) errors.push({ message: 'Inputs are not allowed here', offset: i });
          else try { flush(); stack.at(-1).children.push({ type: 'input', ...parseInputSpec(body.slice(1)), offset: i, end: end + 1 }); i = end + 1; continue; }
          catch (error) { errors.push({ message: error.message, offset: i }); }
        } else if (body.trim() && body.trim() !== 'x') {
          if (!allowLinks) { errors.push({ message: 'Links are not allowed here; move the [target] outside', offset: i }); }
          else { flush(); stack.at(-1).children.push({ type: 'link', target: body.trim(), raw: body, offset: i + 1, end }); i = end + 1; continue; }
        } else errors.push({ message: 'Empty brackets; write \\[ \\] for literal brackets', offset: i });
      } else errors.push({ message: 'Unmatched [ — write \\[ for a literal bracket or close the link', offset: i });
      pending += ch; i++; continue;
    }
    if (ch === ']') { errors.push({ message: 'Unmatched ] — write \\] for a literal bracket', offset: i }); pending += ch; i++; continue; }
    pending += ch; i++;
  }
  flush();
  while (stack.length > 1) dissolve(stack.pop());
  return { nodes: strip(root.children), errors };
}
function strip(nodes) {
  // Merge adjacent text nodes and drop editor-only fields.
  const result = [];
  for (const node of nodes) {
    const clean = { ...node }; delete clean.marker; delete clean.end;
    if (clean.type !== 'link' && clean.type !== 'input') delete clean.offset;
    if (clean.children) clean.children = strip(clean.children);
    if (clean.type === 'text' && result.at(-1)?.type === 'text') result.at(-1).text += clean.text;
    else result.push(clean);
  }
  return result;
}
export function inlineText(nodes) {
  return nodes.map(node => node.type === 'text' || node.type === 'code' ? node.text : node.type === 'interp' ? node.text : node.children ? inlineText(node.children) : node.type === 'link' ? node.label ?? node.target : node.type === 'input' ? `[${node.label}]` : '').join('');
}
export function walkInline(nodes, visit) {
  for (const node of nodes) { visit(node); if (node.children) walkInline(node.children, visit); }
}
