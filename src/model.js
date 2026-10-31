// Project model: the in-memory project (format 1) and its validation.
// Strict validation: unknown fields, reserved keys and oversize values are rejected.

export const FORMAT = 'storyline-project';
export const FORMAT_VERSION = 1;
export const LANGUAGE_VERSION = 1;
export const MACRO_API_VERSION = 1;

export const LIMITS = Object.freeze({
  json: 5 * 1024 * 1024, passages: 500, source: 20000, variables: 100, macros: 50, code: 50 * 1024,
  depth: 32, operations: 10000, output: 1024 * 1024, nodes: 10000, history: 100, historyBytes: 20 * 1024 * 1024,
  redirects: 32
});

const RESERVED = new Set(['__proto__', 'prototype', 'constructor', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);
export const bytes = text => new TextEncoder().encode(text).length;
export const clone = value => structuredClone(value);
export const jsonClone = value => JSON.parse(JSON.stringify(value));
export const fail = (where, message) => { throw new Error(`${where}: ${message}`); };

export function identifier(value, strict = false) {
  return typeof value === 'string' && (strict ? /^[A-Za-z_][A-Za-z0-9_]{0,79}$/ : /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/).test(value) && !RESERVED.has(value);
}
export const scalar = value => value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
export const safeKey = key => typeof key === 'string' && !RESERVED.has(key);

export function validateJson(value, where = 'value', { maxBytes = LIMITS.output, maxNodes = LIMITS.nodes, maxDepth = LIMITS.depth } = {}) {
  const seen = new WeakSet(); let count = 0;
  function visit(node, path, depth) {
    if (++count > maxNodes) fail(path, `JSON node limit exceeded (${maxNodes})`);
    if (depth > maxDepth) fail(path, `JSON nesting exceeds ${maxDepth}`);
    if (scalar(node)) return;
    if (!node || typeof node !== 'object') fail(path, 'expected JSON value');
    if (seen.has(node)) fail(path, 'cyclic JSON value');
    const array = Array.isArray(node);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(node))) fail(path, 'expected plain JSON object');
    if (array && Object.getPrototypeOf(node) !== Array.prototype) fail(path, 'expected plain JSON array');
    seen.add(node);
    const keys = Reflect.ownKeys(node).filter(key => !(array && key === 'length'));
    if (keys.length > LIMITS.nodes || (array && keys.length !== node.length)) fail(path, 'sparse or excessive JSON array');
    for (const key of keys) {
      if (!safeKey(key)) fail(path, 'reserved or invalid JSON key');
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= node.length)) fail(path, 'invalid JSON array property');
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(path, 'JSON properties must be enumerable data');
      visit(descriptor.value, `${path}[${JSON.stringify(key)}]`, depth + 1);
    }
    seen.delete(node);
  }
  visit(value, where, 0);
  if (bytes(JSON.stringify(value)) > maxBytes) fail(where, `JSON value exceeds ${maxBytes / (1024 * 1024)} MiB`);
  return value;
}
function exactObject(value, keys, where, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(where, 'expected object');
  for (const key of Object.keys(value)) if (!keys.includes(key) && !optional.includes(key)) fail(where, `unknown field ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(where, `missing field ${key}`);
}
function string(value, where, max = LIMITS.json) {
  if (typeof value !== 'string' || value.length > max) fail(where, `expected string of at most ${max} characters`);
}
function number(value, where) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(where, 'expected finite number');
}
export function jsonObject(value, where) {
  validateJson(value, where);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(where, 'expected a JSON object');
  return value;
}

// ---- Images -------------------------------------------------------------------
export function imageDimensions(binary, mime) {
  const byte = i => binary.charCodeAt(i), u16 = i => byte(i) * 256 + byte(i + 1), u32 = i => u16(i) * 65536 + u16(i + 2);
  if (mime === 'image/png') {
    if (binary.length < 45 || binary.slice(0, 8) !== '\x89PNG\r\n\x1a\n' || u32(8) !== 13 || binary.slice(12, 16) !== 'IHDR') throw new Error('Invalid PNG image');
    return { width: u32(16), height: u32(20) };
  }
  if (mime === 'image/jpeg' && binary.slice(0, 2) === '\xFF\xD8') {
    let i = 2;
    while (i + 4 <= binary.length && byte(i++) === 255) {
      while (byte(i) === 255) i++;
      const marker = byte(i++);
      if (marker === 218 || marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = u16(i);
      if (length < 2 || i + length > binary.length) break;
      if ([192, 193, 194].includes(marker) && length >= 8) return { width: u16(i + 5), height: u16(i + 3) };
      i += length;
    }
  }
  throw new Error('Invalid or unsupported raster image');
}
export function validateImageData(dataUrl) {
  if (typeof dataUrl !== 'string') throw new Error('Image data must be a string');
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4) throw new Error('Images must be embedded PNG/JPEG data; URLs and SVG are not allowed');
  let binary;
  try { binary = atob(match[2]); } catch { throw new Error('Invalid image base64 data'); }
  const dimensions = imageDimensions(binary, match[1]);
  if (![dimensions.width, dimensions.height].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Image dimensions must be positive integers');
  return dimensions;
}
export function validateImageMetadata(image, payload = 'dataUrl') {
  exactObject(image, ['id', 'name', payload, 'width', 'height', 'caption'], 'image');
  if (!identifier(image.id)) fail('image.id', 'invalid identifier');
  string(image.name, 'image.name', 200); string(image.caption, 'image.caption', 500);
  if (![image.width, image.height].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Image dimensions must be positive integers');
  return image;
}
const checkedPayloads = new WeakMap();
export function validateImage(image) {
  validateImageMetadata(image);
  const cached = checkedPayloads.get(image);
  const dimensions = cached && cached.dataUrl === image.dataUrl ? cached.dimensions : validateImageData(image.dataUrl);
  if (image.width !== dimensions.width || image.height !== dimensions.height) fail('image', 'stored dimensions do not match image data');
  checkedPayloads.set(image, { dataUrl: image.dataUrl, dimensions });
  return image;
}
export function cloneImage(image) {
  const copy = { ...image }, cached = checkedPayloads.get(image);
  if (cached && cached.dataUrl === copy.dataUrl) checkedPayloads.set(copy, cached);
  return copy;
}

// ---- Game state -----------------------------------------------------------------
export const DEFAULT_TRAITS = Object.freeze({ profanity: 0, sarcasm: 0, empathy: 0, curiosity: 0 });
export function validateVariables(variables, where = 'variables') {
  jsonObject(variables, where);
  if (Object.keys(variables).length > LIMITS.variables) fail(where, 'too many variables (100)');
  for (const key of Object.keys(variables)) if (!identifier(key, true)) fail(`${where}.${key}`, 'invalid or reserved identifier');
  return variables;
}
export function validateGameState(state, runtime = true) {
  jsonObject(state, 'gameState');
  if (Object.keys(state).length > LIMITS.variables + (runtime ? 1 : 0)) fail('gameState', 'too many top-level global variables (100)');
  for (const key of ['gameState', 'local']) if (Object.hasOwn(state, key)) fail('gameState', `${key} is a reserved namespace`);
  if (runtime) { if (!Array.isArray(state.observations)) fail('gameState.observations', 'expected observation history array'); }
  else if (Object.hasOwn(state, 'observations')) fail('initialGameState', 'observations is runtime-managed');
  for (const [key, value] of Object.entries(state)) {
    if (!identifier(key, true)) fail(`gameState.${key}`, 'invalid or reserved identifier');
    if (key !== 'observations' && value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'traits')) jsonObject(value.traits, `${key}.traits`);
  }
  return state;
}
export function mergeJson(base, over) {
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!object(base) || !object(over)) return jsonClone(over);
  const result = jsonClone(base);
  for (const [key, value] of Object.entries(over)) result[key] = Object.hasOwn(result, key) ? mergeJson(result[key], value) : jsonClone(value);
  return result;
}
export function createGameState(project) {
  const state = jsonClone(project.initialGameState);
  for (const actor of Object.values(state)) if (actor && typeof actor === 'object' && !Array.isArray(actor) && Object.hasOwn(actor, 'traits')) actor.traits = mergeJson(project.traitDefaults, actor.traits);
  state.observations = [];
  return validateGameState(state);
}

// ---- Project ---------------------------------------------------------------------
export function validateViewport(viewport) {
  exactObject(viewport, ['x', 'y', 'zoom'], 'viewport');
  for (const key of ['x', 'y', 'zoom']) number(viewport[key], `viewport.${key}`);
  if (viewport.zoom < 0.2 || viewport.zoom > 2.5) fail('viewport.zoom', 'expected 0.2–2.5');
  return viewport;
}
export function validateActLayout(layout, passageIds) {
  exactObject(layout, ['version', 'acts'], 'actLayout');
  if (layout.version !== 1) fail('actLayout.version', 'only version 1 is supported');
  if (!Array.isArray(layout.acts) || !layout.acts.length || layout.acts.length > passageIds.size) fail('acts', 'expected nonempty acts with at least one passage each');
  const ids = new Set(), assigned = new Set();
  for (const act of layout.acts) {
    exactObject(act, ['id', 'title', 'startPassageId', 'passageIds', 'viewport'], 'act');
    if (!identifier(act.id)) fail('act.id', 'invalid identifier');
    string(act.title, 'act.title', 200);
    if (!act.title.trim()) fail('act.title', 'expected a name');
    if (ids.has(act.id)) fail('act.id', 'duplicate act ID');
    ids.add(act.id); validateViewport(act.viewport);
    if (!Array.isArray(act.passageIds) || !act.passageIds.length) fail('act.passageIds', 'expected at least one passage');
    for (const id of act.passageIds) {
      if (!passageIds.has(id)) fail('act.passageIds', `unknown passage ${id}`);
      if (assigned.has(id)) fail('act.passageIds', `passage ${id} belongs to more than one act`);
      assigned.add(id);
    }
    if (!act.passageIds.includes(act.startPassageId)) fail('act.startPassageId', 'entry must belong to this act');
  }
  if (assigned.size !== passageIds.size) fail('act.passageIds', 'every passage must belong to an act');
  return layout;
}
export function validateProject(project) {
  exactObject(project, ['format', 'formatVersion', 'languageVersion', 'macroApiVersion', 'id', 'title', 'startPassageId', 'initialVariables', 'initialGameState', 'traitDefaults', 'passages', 'customMacros', 'editor'], 'project');
  if (project.format !== FORMAT) fail('format', 'unsupported format');
  if (project.formatVersion !== FORMAT_VERSION) fail('formatVersion', `expected project format ${FORMAT_VERSION}`);
  if (project.languageVersion !== LANGUAGE_VERSION) fail('languageVersion', `expected language ${LANGUAGE_VERSION}`);
  if (project.macroApiVersion !== MACRO_API_VERSION) fail('macroApiVersion', 'only version 1 is supported');
  if (!identifier(project.id)) fail('id', 'invalid identifier');
  string(project.title, 'title', 200);
  if (!identifier(project.startPassageId)) fail('startPassageId', 'invalid identifier');
  validateVariables(project.initialVariables, 'initialVariables');
  validateGameState(project.initialGameState, false);
  jsonObject(project.traitDefaults, 'traitDefaults');
  createGameState(project);
  if (!Array.isArray(project.passages) || !project.passages.length || project.passages.length > LIMITS.passages) fail('passages', 'expected 1–500 passages');
  const ids = new Set();
  for (const passage of project.passages) {
    exactObject(passage, ['id', 'title', 'position', 'source'], 'passage', ['image']);
    if (!identifier(passage.id)) fail('passage.id', 'invalid identifier');
    if (ids.has(passage.id)) fail(passage.id, 'duplicate passage ID');
    ids.add(passage.id);
    string(passage.title, `${passage.id}.title`, 200); string(passage.source, `${passage.id}.source`, LIMITS.source);
    exactObject(passage.position, ['x', 'y'], `${passage.id}.position`);
    number(passage.position.x, 'position.x'); number(passage.position.y, 'position.y');
    if (Object.hasOwn(passage, 'image')) validateImage(passage.image);
  }
  if (!ids.has(project.startPassageId)) fail('startPassageId', 'passage does not exist');
  if (!Array.isArray(project.customMacros) || project.customMacros.length > LIMITS.macros) fail('customMacros', 'expected at most 50 macros');
  const macroIds = new Set();
  for (const macro of project.customMacros) {
    exactObject(macro, ['id', 'code', 'targets'], 'macro');
    if (!identifier(macro.id)) fail('macro.id', 'invalid identifier');
    if (macroIds.has(macro.id)) fail(macro.id, 'duplicate macro ID');
    macroIds.add(macro.id);
    string(macro.code, `${macro.id}.code`);
    if (bytes(macro.code) > LIMITS.code) fail(macro.id, 'code exceeds 50 KiB');
    if (!Array.isArray(macro.targets) || macro.targets.length > LIMITS.passages || new Set(macro.targets).size !== macro.targets.length) fail(macro.id, 'invalid target list');
    for (const target of macro.targets) if (!identifier(target)) fail(`${macro.id}.target`, 'invalid identifier');
  }
  exactObject(project.editor, ['viewport'], 'editor', ['actLayout']);
  validateViewport(project.editor.viewport);
  if (Object.hasOwn(project.editor, 'actLayout')) validateActLayout(project.editor.actLayout, ids);
  return project;
}
export function cloneProject(project) {
  const { passages, ...metadata } = project;
  return { ...clone(metadata), passages: passages.map(passage => ({ ...passage, position: { ...passage.position }, ...(Object.hasOwn(passage, 'image') ? { image: cloneImage(passage.image) } : {}) })) };
}
export function sameProject(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameProject(left[key], right[key]));
}
function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
function projectSize(project) {
  let payload = 0;
  const text = JSON.stringify(project, function (key, value) {
    if (key === 'dataUrl' && typeof value === 'string') { payload += value.length; return ''; }
    return value;
  });
  return bytes(text) + payload;
}

// ---- Identifiers ------------------------------------------------------------------
export function newId(prefix = 'p') {
  const bytes16 = crypto.getRandomValues(new Uint8Array(16));
  bytes16[6] = (bytes16[6] & 15) | 64; bytes16[8] = (bytes16[8] & 63) | 128;
  return `${prefix}_${Array.from(bytes16, b => b.toString(16).padStart(2, '0')).join('')}`;
}
export function passageIdForTitle(title, passages = [], exceptId = null) {
  let base = title.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'Passage';
  if (!/^[A-Za-z_]/.test(base) || RESERVED.has(base)) base = `p_${base}`;
  base = base.slice(0, 80);
  const taken = new Set(passages.filter(p => p.id !== exceptId).map(p => p.id));
  let candidate = base, n = 2;
  while (taken.has(candidate)) { const suffix = `_${n++}`; candidate = base.slice(0, 80 - suffix.length) + suffix; }
  return candidate;
}

// ---- Factories --------------------------------------------------------------------
export function newProject() {
  const arrival = passageIdForTitle('Arrival'), gate = passageIdForTitle('The locked gate'), courtyard = passageIdForTitle('Courtyard');
  const passages = [
    { id: arrival, title: 'Arrival', position: { x: 80, y: 120 }, source: `# Arrival

## scene
EXT. CITY GATE — DUSK

## story

> Rain hangs in the air. A single lantern burns above the gate.

What should we call you? [?player.name:text Your name]

$player.gold += 1

- Gatekeeper: Evening, $player.name. Found a coin on the road, did you?

* I'll keep it. ($player.traits.sarcasm += 1)
* Here, take it. ($player.gold -= 1; $player.traits.empathy += 1)

---

[${gate}]` },
    { id: gate, title: 'The locked gate', position: { x: 440, y: 120 }, source: `# The locked gate

> The gate is locked. A slot in the iron waits for a coin.

? $player.gold >= 1
* Drop a coin in the slot ($player.gold -= 1) [${courtyard}]

? $player.gold < 1
You have no coin. The gatekeeper shrugs.
* Go back [${arrival}]` },
    { id: courtyard, title: 'Courtyard', position: { x: 800, y: 120 }, source: `# Courtyard

## environment
INT. COURTYARD — NIGHT
Lanterns, puddles, and the smell of bread.

### Mood
Tired, hopeful.

## story

> The gate swings open. Your journey continues.

+ You: That was easier than expected.

@awardCoin

[${arrival}]` }
  ];
  return validateProject({
    format: FORMAT, formatVersion: FORMAT_VERSION, languageVersion: LANGUAGE_VERSION, macroApiVersion: MACRO_API_VERSION,
    id: newId('project'), title: 'Untitled story', startPassageId: arrival,
    initialVariables: {},
    initialGameState: { player: { name: 'Traveler', gold: 0, traits: {} } },
    traitDefaults: clone(DEFAULT_TRAITS),
    passages,
    customMacros: [{ id: 'awardCoin', code: "ctx.set('player.gold', ctx.get('player.gold') + 1);\nctx.text('A coin glints in a puddle. You pocket it.');", targets: [] }],
    editor: { viewport: { x: 0, y: 0, zoom: 1 } }
  });
}
export function emptyProject(title = 'Untitled story') {
  const id = passageIdForTitle('Start');
  return validateProject({
    format: FORMAT, formatVersion: FORMAT_VERSION, languageVersion: LANGUAGE_VERSION, macroApiVersion: MACRO_API_VERSION,
    id: newId('project'), title, startPassageId: id, initialVariables: {}, initialGameState: { player: { traits: {} } },
    traitDefaults: clone(DEFAULT_TRAITS), passages: [{ id, title: 'Start', position: { x: 80, y: 120 }, source: '# Start\n\nWrite your story here.' }],
    customMacros: [], editor: { viewport: { x: 0, y: 0, zoom: 1 } }
  });
}
export function parseProject(text) { return validateProject(JSON.parse(text)); }

// ---- Undo history -----------------------------------------------------------------
export class History {
  constructor(project) { this.reset(project); }
  reset(project) {
    this.project = freezeDeep(cloneProject(validateProject(project)));
    this.undoStack = []; this.redoStack = []; this.sizes = new WeakMap();
    this.sizes.set(this.project, projectSize(this.project));
  }
  change(mutate, group = null) {
    const next = cloneProject(this.project);
    mutate(next); validateProject(next);
    if (sameProject(this.project, next)) return false;
    this.sizes.set(next, projectSize(next));
    return this.commit(next, group);
  }
  changeSource(id, source, group = null) {
    const index = this.project.passages.findIndex(passage => passage.id === id);
    if (index < 0) throw new Error(`Missing passage ${id}`);
    string(source, `${id}.source`, LIMITS.source);
    const previous = this.project.passages[index];
    if (source === previous.source) return false;
    const passages = this.project.passages.slice(); passages[index] = { ...previous, source };
    const next = { ...this.project, passages };
    this.sizes.set(next, this.sizes.get(this.project) - bytes(JSON.stringify(previous.source)) + bytes(JSON.stringify(source)));
    return this.commit(next, group);
  }
  // Replace the current snapshot without an undo step (viewports, cosmetic state).
  replaceQuietly(mutate) {
    const next = cloneProject(this.project);
    mutate(next); validateProject(next);
    this.sizes.set(next, projectSize(next));
    this.project = freezeDeep(next);
  }
  commit(next, group) {
    const top = this.undoStack.at(-1);
    if (!group || !top || top.group !== group || Date.now() - top.time > 1200) this.undoStack.push({ project: this.project, group, time: Date.now(), size: this.sizes.get(this.project) });
    else top.time = Date.now();
    this.redoStack = []; this.project = freezeDeep(next); this.trim(); return true;
  }
  trim() {
    while (this.undoStack.length + this.redoStack.length > 1 && (this.undoStack.length + this.redoStack.length > LIMITS.history || [...this.undoStack, ...this.redoStack].reduce((sum, entry) => sum + entry.size, 0) > LIMITS.historyBytes)) {
      if (this.undoStack.length) this.undoStack.shift(); else this.redoStack.shift();
    }
  }
  travel(from, to) {
    const entry = from.pop();
    if (!entry) return false;
    to.push({ project: this.project, group: null, time: 0, size: this.sizes.get(this.project) });
    this.project = entry.project;
    if (this.undoStack.length) this.undoStack.at(-1).group = null;
    this.trim(); return true;
  }
  undo() { return this.travel(this.undoStack, this.redoStack); }
  redo() { return this.travel(this.redoStack, this.undoStack); }
}
