import { LIMITS, safeKey, scalar } from './model.js';
import { readVariable, getVariable } from './paths.js';

const precedence = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

export function parseExpression(source) {
  let pos = 0, current, count = 0;
  const error = message => { throw new Error(`Expression column ${pos + 1}: ${message}`); };
  function next() {
    while (pos < source.length && /\s/.test(source[pos])) pos++;
    if (++count > LIMITS.operations) error('too many tokens');
    if (pos === source.length) return current = { type: 'end' };
    const tail = source.slice(pos);
    let match;
    if (tail[0] === '"') {
      match = /^"(?:[^"\\\r\n]|\\.)*"/.exec(tail); if (!match) error('unterminated string');
      pos += match[0].length; let value;
      try { value = JSON.parse(match[0]); } catch { error('invalid string escape'); }
      return current = { type: 'literal', value };
    }
    if (tail[0] === "'") {
      match = /^'(?:[^'\\\r\n]|\\.)*'/.exec(tail); if (!match) error('unterminated string');
      pos += match[0].length;
      return current = { type: 'literal', value: match[0].slice(1, -1).replace(/\\(.)/g, (_, ch) => ({ n: '\n', t: '\t' })[ch] ?? ch) };
    }
    if ((match = /^(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(tail))) {
      pos += match[0].length; const value = Number(match[0]); if (!Number.isFinite(value)) error('nonfinite number');
      return current = { type: 'literal', value };
    }
    if (tail[0] === '$') {
      const variable = readVariable(tail); pos += variable.end;
      return current = { type: 'variable', name: variable.name, root: variable.path[0] };
    }
    if ((match = /^(true|false|null)\b/.exec(tail))) { pos += match[0].length; return current = { type: 'literal', value: JSON.parse(match[0]) }; }
    if ((match = /^(\|\||&&|==|!=|<=|>=|[(){}\[\],:+*/%<>!\-])/.exec(tail))) { pos += match[0].length; return current = { type: match[0] }; }
    error(`unexpected ${JSON.stringify(tail.slice(0, 12))}`);
  }
  function expression(min = 0, depth = 0) {
    if (depth > LIMITS.depth) error('expression nesting exceeds 32');
    let left; const token = current; next();
    if (token.type === 'literal' || token.type === 'variable') left = token;
    else if (token.type === '{' || token.type === '[') {
      const object = token.type === '{', close = object ? '}' : ']', items = [], keys = new Set();
      if (current.type !== close) while (true) {
        let key;
        if (object) {
          if (current.type !== 'literal' || typeof current.value !== 'string') error('object keys must be quoted strings');
          key = current.value;
          if (!safeKey(key) || keys.has(key)) error('reserved or duplicate object key');
          keys.add(key); next();
          if (current.type !== ':') error('expected : after object key');
          next();
        }
        const value = expression(0, depth + 1); items.push(object ? { key, value } : value);
        if (current.type !== ',') break;
        next();
      }
      if (current.type !== close) error(`expected ${close}`);
      next(); left = { type: object ? 'object' : 'array', items };
    }
    else if (token.type === '(') { left = expression(0, depth + 1); if (current.type !== ')') error('expected )'); next(); }
    else if (['!', '-', '+'].includes(token.type)) left = { type: 'unary', op: token.type, child: expression(7, depth + 1) };
    else if (token.type === 'end') error('expected a value');
    else error(`unexpected ${token.type}`);
    while ((precedence[current.type] ?? -1) >= min) {
      const op = current.type; next(); const right = expression(precedence[op] + 1, depth + 1);
      left = { type: 'binary', op, left, right };
    }
    return left;
  }
  next(); const result = expression(); if (current.type !== 'end') error('unexpected trailing token'); return result;
}
export function variableNames(ast, found = new Set()) {
  const pending = [ast];
  while (pending.length) {
    const node = pending.pop();
    if (node.type === 'variable') found.add(node.name);
    if (node.items) pending.push(...node.items.map(item => node.type === 'object' ? item.value : item));
    if (node.child) pending.push(node.child);
    if (node.left) pending.push(node.left, node.right);
  }
  return found;
}
export function boolean(value) { if (typeof value !== 'boolean') throw new Error(`Expected true or false, got ${JSON.stringify(value)}`); return value; }
function number(value) { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Expected a number, got ${JSON.stringify(value)}`); return value; }
export function evaluate(ast, variables, tick = () => {}, depth = 0) {
  tick(); if (depth > 256) throw new Error('Expression evaluation depth exceeds 256');
  const visit = node => evaluate(node, variables, tick, depth + 1);
  if (ast.type === 'literal') return ast.value;
  if (ast.type === 'variable') return getVariable(variables, ast.name);
  if (ast.type === 'array') return ast.items.map(visit);
  if (ast.type === 'object') return Object.fromEntries(ast.items.map(item => [item.key, visit(item.value)]));
  if (ast.type === 'unary') { const value = visit(ast.child); return ast.op === '!' ? !boolean(value) : ast.op === '-' ? -number(value) : number(value); }
  const left = visit(ast.left);
  if (ast.op === '&&') return boolean(left) && boolean(visit(ast.right));
  if (ast.op === '||') return boolean(left) || boolean(visit(ast.right));
  const right = visit(ast.right); let result;
  switch (ast.op) {
    case '==': return left === right;
    case '!=': return left !== right;
    case '<': return number(left) < number(right);
    case '<=': return number(left) <= number(right);
    case '>': return number(left) > number(right);
    case '>=': return number(left) >= number(right);
    case '+': if (typeof left === 'string' || typeof right === 'string') return String(left) + String(right); result = number(left) + number(right); break;
    case '-': result = number(left) - number(right); break;
    case '*': result = number(left) * number(right); break;
    case '/': if (number(right) === 0) throw new Error('Division by zero'); result = number(left) / right; break;
    case '%': if (number(right) === 0) throw new Error('Division by zero'); result = number(left) % right; break;
    default: throw new Error('Unsupported expression operator');
  }
  if (!scalar(result)) throw new Error('Nonfinite arithmetic result'); return result;
}
