import { LIMITS, identifier, safeKey, validateJson, jsonClone } from './model.js';

// Reads `$name.prop[0]["key"]` from the start of `source`.
export function readVariable(source) {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(source);
  if (!match || !identifier(match[1], true)) throw new Error('Invalid or reserved variable name');
  let end = match[0].length;
  const path = [match[1]];
  while (source[end] === '.' || source[end] === '[') {
    if (source[end] === '.') {
      const property = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(end));
      if (!property) break; // `$name.` followed by punctuation: stop before the dot.
      if (!safeKey(property[1])) throw new Error('Invalid or reserved property name');
      path.push(property[1]); end += property[0].length;
    } else {
      const bracket = /^\[\s*("(?:[^"\\\r\n]|\\.)*"|0|[1-9][0-9]*)\s*\]/.exec(source.slice(end));
      if (!bracket) break;
      const key = JSON.parse(bracket[1]);
      if (typeof key === 'number' ? !Number.isSafeInteger(key) || key >= LIMITS.nodes : !safeKey(key)) throw new Error('Invalid, reserved or excessive property/index');
      path.push(key); end += bracket[0].length;
    }
    if (path.length > LIMITS.depth + 1) throw new Error('Variable path nesting exceeds 32');
  }
  return { name: source.slice(1, end), path, end };
}
export function parseVariablePath(name) {
  if (typeof name !== 'string') throw new Error('Variable name must be a string');
  const parsed = readVariable('$' + name);
  if (parsed.end !== name.length + 1) throw new Error(`Invalid variable path ${name}`);
  return parsed.path;
}
function checkContainer(container, key, name) {
  if (!container || typeof container !== 'object') throw new Error(`$${name}: cannot traverse a scalar or null`);
  if (Array.isArray(container)) {
    if (typeof key !== 'number') throw new Error(`$${name}: use a numeric array index`);
    if (key > container.length) throw new Error(`$${name}: sparse array indexes are not allowed`);
  } else if (typeof key !== 'string') throw new Error(`$${name}: numeric indexes require an array`);
}
export function hasVariable(variables, name) {
  let value = variables;
  for (const key of parseVariablePath(name)) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return false;
    value = value[key];
  }
  return true;
}
export function getVariable(variables, name) {
  let value = variables;
  for (const key of parseVariablePath(name)) {
    checkContainer(value, key, name);
    if (!Object.hasOwn(value, key)) throw new Error(`Unknown variable or missing property $${name}`);
    value = value[key];
  }
  return value;
}
export function setVariable(variables, name, value, { declare = true } = {}) {
  const path = parseVariablePath(name);
  validateJson(value, `$${name}`);
  if (!Object.hasOwn(variables, path[0])) {
    if (!declare) throw new Error(`Unknown variable $${name}`);
    if (Object.keys(variables).length >= LIMITS.variables) throw new Error('Runtime variable limit exceeded (100)');
  }
  const pending = Object.create(null);
  if (Object.hasOwn(variables, path[0])) pending[path[0]] = jsonClone(variables[path[0]]);
  let container = pending;
  for (let index = 0; index < path.length; index++) {
    const key = path[index]; checkContainer(container, key, name);
    const exists = Object.hasOwn(container, key);
    if (!exists && !declare) throw new Error(`Unknown variable or missing property $${name}`);
    if (index === path.length - 1) container[key] = jsonClone(value);
    else {
      if (!exists) container[key] = typeof path[index + 1] === 'number' ? [] : {};
      container = container[key];
    }
  }
  validateJson(pending[path[0]], `$${path[0]}`);
  variables[path[0]] = pending[path[0]];
}
// Reading scope: globals at the root plus the `gameState` and `local` namespaces.
export function variableScope(scope) {
  return Object.assign(Object.create(null), scope.gameState, { gameState: scope.gameState, local: scope.local });
}
export function scopedVariable(name) {
  const path = parseVariablePath(name);
  if (path[0] === 'local') return { name, path, local: true };
  return path[0] === 'gameState' ? { name, path, local: false } : { name: `gameState.${name}`, path: ['gameState', ...path], local: false };
}
export function setScopedVariable(scope, name, value, declare = true) {
  const variable = scopedVariable(name);
  if (variable.path.length < 2) throw new Error(`$${variable.path[0]} is a namespace; assign a property such as $${variable.path[0]}.value`);
  if (!variable.local && ['observations', 'gameState', 'local'].includes(variable.path[1])) throw new Error(`$${variable.path[1]} is runtime-managed or reserved`);
  setVariable(scope, variable.name, value, { declare });
}
export function formatValue(value) { return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value); }
export function formatPath(path) {
  return path.map((key, index) => typeof key === 'number' ? `[${key}]` : /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${index ? '.' : ''}${key}` : `[${JSON.stringify(key)}]`).join('');
}
// Flatten JSON into leaf paths for the Variables window.
export function flattenJson(value, prefix = []) {
  const rows = [];
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
    for (const [key, child] of Object.entries(value)) rows.push(...flattenJson(child, [...prefix, key]));
  } else rows.push({ path: formatPath(prefix), value });
  return rows;
}
export function unflattenRows(rows) {
  const result = {};
  for (const row of rows) {
    const path = parseVariablePath(row.path);
    let container = result;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (!Object.hasOwn(container, key) || typeof container[key] !== 'object' || container[key] === null || Array.isArray(container[key])) container[key] = {};
      container = container[key];
    }
    container[path.at(-1)] = jsonClone(row.value);
  }
  return result;
}
