// Line highlighters for the code editor. Input is a raw line; output is HTML.
const span = (cls, text, esc) => text ? `<span class="${cls}">${esc(text)}</span>` : '';

export function highlightInline(text, esc) {
  let out = '', i = 0, pending = '';
  const flush = () => { out += esc(pending); pending = ''; };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) { flush(); out += span('tok-escape', text.slice(i, i + 2), esc); i += 2; continue; }
    if (ch === '`') { const end = text.indexOf('`', i + 1); if (end > i) { flush(); out += span('tok-code', text.slice(i, end + 1), esc); i = end + 1; continue; } }
    if (ch === '$') {
      let match;
      if (text[i + 1] === '{') { let depth = 0, end = -1; for (let j = i + 1; j < text.length; j++) { if (text[j] === '{') depth++; else if (text[j] === '}' && --depth === 0) { end = j; break; } } if (end > 0) { flush(); out += span('tok-variable', text.slice(i, end + 1), esc); i = end + 1; continue; } }
      else if ((match = /^\$[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\s*(?:"[^"]*"|\d+)\s*\])*/.exec(text.slice(i)))) { flush(); out += span('tok-variable', match[0], esc); i += match[0].length; continue; }
    }
    if (ch === '[') {
      const end = text.indexOf(']', i + 1);
      if (end > 0 && !text.slice(i + 1, end).includes('[')) { flush(); out += span(text[i + 1] === '?' ? 'tok-input' : 'tok-link', text.slice(i, end + 1), esc); i = end + 1; continue; }
    }
    if (ch === '*' || ch === '_') {
      const marker = text[i + 1] === ch ? ch + ch : ch;
      const close = text.indexOf(marker, i + marker.length);
      if (close > i + marker.length && /\S/.test(text[i + marker.length] ?? '')) { flush(); out += `<span class="${marker.length === 2 ? 'tok-strong' : 'tok-em'}">${esc(marker)}${highlightInline(text.slice(i + marker.length, close), esc)}${esc(marker)}</span>`; i = close + marker.length; continue; }
    }
    pending += ch; i++;
  }
  flush();
  return out;
}
export function highlightStoryLine(line, esc) {
  const indent = /^\s*/.exec(line)[0], body = line.slice(indent.length);
  const lead = esc(indent);
  let match;
  if (!body) return lead;
  if (body.startsWith('//')) return lead + span('tok-comment', body, esc);
  if (/^-{3,}\s*$/.test(body)) return lead + span('tok-rule', body, esc);
  if ((match = /^(#{1,6})(\s*)(.*)$/.exec(body))) {
    if (match[1].length === 2 && /^(environment|scene|notes|story)\s*$/i.test(match[3])) return lead + span('tok-marker', match[1] + match[2], esc) + span('tok-keyword', match[3], esc);
    return lead + span('tok-marker', match[1] + match[2], esc) + `<span class="tok-heading">${highlightInline(match[3], esc)}</span>`;
  }
  if ((match = /^(>\s?)(.*)$/.exec(body))) return lead + span('tok-marker', match[1], esc) + highlightInline(match[2], esc);
  if ((match = /^([+-]\s+)((?:\\.|[^:\\])+?:\s+)?(.*)$/s.exec(body)) && /^[+-]\s/.test(body)) return lead + span('tok-marker', match[1], esc) + span(body[0] === '+' ? 'tok-player' : 'tok-speaker', match[2] ?? '', esc) + highlightInline(match[3], esc);
  if ((match = /^(\*\s+)(\[[ x]\]\s*)?((?:thought|dialogue|action):\s*)?(.*)$/.exec(body))) {
    let rest = match[4], out = lead + span('tok-marker', match[1], esc) + span('tok-input', match[2] ?? '', esc) + span('tok-type', match[3] ?? '', esc);
    const target = /(^|[^\\])(\[[^\[\]]*\]\s*)$/.exec(rest); let tail = '';
    if (target && !target[2].startsWith('[?')) { tail = span('tok-link', target[2], esc); rest = rest.slice(0, target.index + target[1].length); }
    const parens = /\((?:[^()"']|"[^"]*"|'[^']*'|\([^()]*\))*\)\s*$/.exec(rest); let effects = '';
    if (parens && rest[parens.index - 1] !== '\\') { effects = span('tok-expr', parens[0], esc); rest = rest.slice(0, parens.index); }
    return out + highlightInline(rest, esc) + effects + tail;
  }
  if ((match = /^(\?\s*)(.*?)(\[[^\[\]]*\]\s*)?$/.exec(body))) return lead + span('tok-keyword', match[1], esc) + span('tok-expr', match[2], esc) + span('tok-link', match[3] ?? '', esc);
  if ((match = /^(@[A-Za-z_][A-Za-z0-9_-]*)(.*)$/.exec(body))) return lead + span('tok-macro', match[1], esc) + esc(match[2]);
  if ((match = /^(\$[A-Za-z_][A-Za-z0-9_.\[\]"']*)(\s*(?:\+=|-=|=)(?!=)\s*)(.*)$/.exec(body))) return lead + span('tok-variable', match[1], esc) + esc(match[2]) + span('tok-expr', match[3], esc);
  return lead + highlightInline(body, esc);
}
const JS_KEYWORDS = new Set('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield await async of static get set true false null undefined'.split(' '));
export function highlightJsLine(line, esc) {
  let out = '', i = 0;
  const pattern = /\/\/.*$|\/\*.*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b|\.[A-Za-z_$][\w$]*/g;
  let match;
  while ((match = pattern.exec(line))) {
    out += esc(line.slice(i, match.index));
    const token = match[0];
    if (token.startsWith('//') || token.startsWith('/*')) out += span('tok-comment', token, esc);
    else if (/^["'`]/.test(token)) out += span('tok-string', token, esc);
    else if (/^\d/.test(token)) out += span('tok-number', token, esc);
    else if (token.startsWith('.')) out += '.' + span('tok-property', token.slice(1), esc);
    else if (JS_KEYWORDS.has(token)) out += span('tok-js-keyword', token, esc);
    else out += esc(token);
    i = match.index + token.length;
  }
  return out + esc(line.slice(i));
}
