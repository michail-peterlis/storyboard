// Disk layout (project format 1): story.json overview + acts/<id>-<hash>.json + images/<hash>.(png|jpg).
import { clone, cloneProject, cloneImage, validateProject, validateImage, validateImageMetadata, validateViewport, identifier, LIMITS, FORMAT, FORMAT_VERSION } from './model.js';
import { ensureActs } from './acts.js';
import { createZip, extractZip, listZip, readZipEntry, encodeText, decodeText } from './zip.js';

export const manifestName = 'story.json';
export const ACT_FORMAT_VERSION = 1;
export function validateOverviewName(name) {
  if (typeof name !== 'string' || !/^[^/\\\0]+\.json$/i.test(name)) throw new Error('Choose a JSON filename in the project folder, without a path.');
  return name;
}
const safeImagePath = /^images\/[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g)$/i;
const safeActPath = /^acts\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/i;
export function validateAssetPath(path) { if (typeof path !== 'string' || !safeImagePath.test(path)) throw new Error('Image path must be a relative PNG/JPEG file inside images/'); return path; }
export function validateActPath(path) { if (typeof path !== 'string' || !safeActPath.test(path)) throw new Error('Act path must be a relative JSON file inside acts/'); return path; }
const validateFilePath = path => typeof path === 'string' && path.startsWith('acts/') ? validateActPath(path) : validateAssetPath(path);
function exact(object, keys, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).length !== keys.length || !keys.every(key => Object.hasOwn(object, key))) throw new Error(`Invalid ${label} fields`);
}
export function imageBytes(dataUrl) {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function toBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
const imageData = (bytes, path) => `data:image/${/\.png$/i.test(path) ? 'png' : 'jpeg'};base64,${toBase64(bytes)}`;
async function digest(bytes) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function loadInBatches(values, work) {
  let index = 0, failure = null;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (!failure && index < values.length) { const value = values[index++]; try { await work(value); } catch (error) { failure = error; } }
  }));
  if (failure) throw failure;
}
async function readBytes(readFile, path) {
  let bytes;
  try { bytes = await readFile(path); } catch (error) { throw new Error(`Could not load ${path}: ${error.message}`); }
  if (!(bytes instanceof Uint8Array)) throw new Error(`Missing ${path.startsWith('acts/') ? 'act' : 'image'} file: ${path}`);
  return bytes;
}
const folderRequired = message => { const error = new Error(`${message} Open the project folder or its ZIP instead.`); error.code = 'ASSET_FOLDER_REQUIRED'; return error; };

// ---- Writing ----------------------------------------------------------------------
export async function createProjectFiles(project) {
  validateProject(project);
  const working = cloneProject(project), files = new Map(), cache = new Map();
  const acts = ensureActs(working);
  for (const passage of working.passages) {
    if (!passage.image) continue;
    const { dataUrl, ...metadata } = passage.image;
    let path = cache.get(dataUrl);
    if (!path) {
      const bytes = imageBytes(dataUrl);
      path = `images/${await digest(bytes)}.${dataUrl.startsWith('data:image/png;') ? 'png' : 'jpg'}`;
      files.set(path, bytes); cache.set(dataUrl, path);
    }
    passage.image = { ...metadata, path };
  }
  const { passages, ...manifest } = working;
  delete manifest.editor.actLayout;
  manifest.formatVersion = FORMAT_VERSION;
  manifest.passageOrder = passages.map(passage => passage.id);
  manifest.acts = [];
  const byId = new Map(passages.map(passage => [passage.id, passage]));
  for (const act of acts) {
    const body = { format: 'storyline-act', formatVersion: ACT_FORMAT_VERSION, id: act.id, viewport: act.viewport, passages: act.passageIds.map(id => byId.get(id)) };
    const bytes = encodeText(JSON.stringify(body, null, 2));
    const path = `acts/${act.id}-${(await digest(bytes)).slice(0, 16)}.json`;
    files.set(path, bytes);
    manifest.acts.push({ id: act.id, title: act.title, startPassageId: act.startPassageId, path });
  }
  validateManifest(manifest);
  files.set(manifestName, encodeText(JSON.stringify(manifest, null, 2)));
  return { manifest, files };
}
export function validateManifest(manifest) {
  if (manifest?.format !== FORMAT || manifest.formatVersion !== FORMAT_VERSION) throw new Error(`Expected a Storyline project overview (format ${FORMAT_VERSION})`);
  const { acts, passageOrder, ...working } = clone(manifest);
  if (!Array.isArray(passageOrder) || !passageOrder.length || passageOrder.length > LIMITS.passages || passageOrder.some(id => !identifier(id)) || new Set(passageOrder).size !== passageOrder.length) throw new Error('Invalid passageOrder: expected unique passage IDs');
  if (!Array.isArray(acts) || !acts.length || acts.length > passageOrder.length) throw new Error('Expected at least one act with passages');
  const ids = new Set(), paths = new Set();
  for (const act of acts) {
    exact(act, ['id', 'title', 'startPassageId', 'path'], 'act descriptor');
    if (!identifier(act.id) || ids.has(act.id)) throw new Error('Invalid or duplicate act ID');
    if (typeof act.title !== 'string' || !act.title.trim() || act.title.length > 200) throw new Error('Invalid act title');
    if (!passageOrder.includes(act.startPassageId)) throw new Error('Act entry passage does not exist');
    validateActPath(act.path);
    if (paths.has(act.path)) throw new Error('Duplicate act file path');
    ids.add(act.id); paths.add(act.path);
  }
  working.passages = passageOrder.map(id => ({ id, title: '', source: '', position: { x: 0, y: 0 } }));
  return validateProject(working);
}
async function resolveOverview(manifest, readFile) {
  const working = validateManifest(manifest);
  if (!readFile) throw folderRequired('This overview references separate act files.');
  const passages = new Map(), acts = [], bodies = new Map();
  await loadInBatches(manifest.acts, async descriptor => bodies.set(descriptor.id, JSON.parse(decodeText(await readBytes(readFile, descriptor.path)))));
  for (const descriptor of manifest.acts) {
    const body = bodies.get(descriptor.id);
    exact(body, ['format', 'formatVersion', 'id', 'viewport', 'passages'], 'act file');
    if (body.format !== 'storyline-act' || body.formatVersion !== ACT_FORMAT_VERSION) throw new Error(`Unsupported act file format: ${descriptor.path}`);
    if (body.id !== descriptor.id) throw new Error(`Act ID mismatch: ${descriptor.path}`);
    validateViewport(body.viewport);
    if (!Array.isArray(body.passages) || !body.passages.length || body.passages.length > LIMITS.passages) throw new Error(`Act must contain passages: ${descriptor.path}`);
    for (const passage of body.passages) {
      if (!passage || !identifier(passage.id)) throw new Error('Invalid passage ID in act file');
      if (passages.has(passage.id)) throw new Error(`Duplicate passage ${passage.id} across acts`);
      passages.set(passage.id, passage);
    }
    acts.push({ id: descriptor.id, title: descriptor.title, startPassageId: descriptor.startPassageId, passageIds: body.passages.map(p => p.id), viewport: body.viewport });
  }
  if (passages.size !== manifest.passageOrder.length || manifest.passageOrder.some(id => !passages.has(id))) throw new Error('Act passages do not match overview passageOrder');
  const references = manifest.passageOrder.map(id => passages.get(id));
  working.passages = references.map(passage => { const { image, ...rest } = passage; if (image !== undefined) validateAssetPath(validateImageMetadata(image, 'path').path); return { ...clone(rest), source: String(rest.source ?? '').replace(/\r\n?/g, '\n') }; });
  working.editor.actLayout = { version: 1, acts };
  validateProject(working);
  const unique = new Map();
  for (const passage of references) if (passage.image && !unique.has(passage.image.path)) unique.set(passage.image.path, passage.image);
  const loaded = new Map();
  await loadInBatches([...unique], async ([path, reference]) => {
    const { path: ignored, ...metadata } = reference;
    loaded.set(path, validateImage({ ...metadata, dataUrl: imageData(await readBytes(readFile, path), path) }));
  });
  references.forEach((passage, index) => { if (passage.image) { const { path, ...metadata } = passage.image; working.passages[index].image = validateImage(Object.assign(cloneImage(loaded.get(path)), metadata)); } });
  return validateProject(working);
}
// ---- Entry points ------------------------------------------------------------------
export async function resolveProject(text, readFile = null) {
  const json = JSON.parse(text);
  if (json?.format !== FORMAT) throw new Error('Not a Storyline project file');
  if (json.formatVersion === FORMAT_VERSION && Array.isArray(json.acts)) return resolveOverview(json, readFile);
  throw new Error(`Unsupported project format ${json.formatVersion}; this editor reads story.json overviews of format ${FORMAT_VERSION} with their acts/ and images/ folders`);
}
export async function createProjectZip(project) {
  const { files } = await createProjectFiles(project);
  return createZip(files, { compress: path => path.endsWith('.json') });
}
export async function readProjectZip(bytes) {
  const entries = listZip(bytes), manifest = entries.find(entry => entry.name === manifestName);
  if (!manifest) throw new Error('Project ZIP must contain story.json at its root');
  const text = decodeText(await readZipEntry(bytes, manifest));
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  return resolveProject(text, async path => { const entry = byName.get(validateFilePath(path)); return entry ? readZipEntry(bytes, entry) : undefined; });
}
export async function readProjectFile(file) {
  if (/\.zip$/i.test(file.name ?? '')) return readProjectZip(new Uint8Array(await file.arrayBuffer()));
  return resolveProject(await file.text());
}
export function findProjectOverview(fileList, name = null) {
  if (name !== null) validateOverviewName(name);
  const files = [...fileList], relative = file => file.webkitRelativePath || file.name;
  const roots = files.filter(file => relative(file).split('/').length <= 2 && /\.json$/i.test(file.name));
  const candidates = roots.filter(file => file.name === (name ?? manifestName));
  const json = candidates.length === 1 ? candidates[0] : candidates.length || name !== null ? null : roots.length === 1 ? roots[0] : null;
  if (!json) throw new Error('Select one project folder containing story.json, acts/ and images/');
  return json;
}
export async function readProjectFolder(fileList, { name = null } = {}) {
  const files = [...fileList], relative = file => file.webkitRelativePath || file.name;
  const json = findProjectOverview(files, name), prefix = relative(json).slice(0, -json.name.length), byPath = new Map();
  for (const file of files) byPath.set(relative(file), file);
  return resolveProject(await json.text(), async path => { const file = byPath.get(prefix + validateFilePath(path)); return file ? new Uint8Array(await file.arrayBuffer()) : undefined; });
}
export async function readProjectDirectory(directory, name = manifestName) {
  validateOverviewName(name);
  const handle = await directory.getFileHandle(name), file = await handle.getFile(), text = await file.text(), folders = new Map();
  const project = await resolveProject(text, async path => {
    const [folder, filename] = validateFilePath(path).split('/');
    if (!folders.has(folder)) folders.set(folder, directory.getDirectoryHandle(folder));
    const target = await (await folders.get(folder)).getFileHandle(filename);
    return new Uint8Array(await (await target.getFile()).arrayBuffer());
  });
  return { project, handle, name, text };
}
async function writeFile(handle, bytes) {
  let stream;
  try { stream = await handle.createWritable(); await stream.write(bytes); await stream.close(); }
  catch (error) { try { await stream?.abort(); } catch { /* keep the write failure */ } throw error; }
}
export async function writeProjectFolder(directory, project, name = manifestName) {
  validateOverviewName(name);
  let existing;
  try { existing = await directory.getFileHandle(name); } catch (error) { if (error.name !== 'NotFoundError') throw error; }
  if (existing) {
    let previous;
    try { previous = JSON.parse(await (await existing.getFile()).text()); } catch { throw new Error(`This folder already has an unreadable ${name}. Choose a different filename or folder.`); }
    if (previous.format !== FORMAT || previous.id !== project.id) throw new Error(`${name} belongs to a different project. Choose a different filename or folder.`);
  }
  const bundle = await createProjectFiles(project);
  for (const [path, bytes] of bundle.files) {
    if (path === manifestName) continue;
    const [folderName, file] = validateFilePath(path).split('/');
    const folder = await directory.getDirectoryHandle(folderName, { create: true });
    await writeFile(await folder.getFileHandle(file, { create: true }), bytes);
  }
  await writeFile(await directory.getFileHandle(name, { create: true }), bundle.files.get(manifestName));
  return bundle.manifest;
}
export async function writeProjectArchive(handle, project) { await writeFile(handle, await createProjectZip(project)); }
export const suggestedName = project => `${project.title.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 80) || 'story'}`;
export const archivePickerOptions = { types: [{ description: 'Storyline project (ZIP)', accept: { 'application/zip': ['.zip'] } }] };
export const openPickerOptions = { types: [{ description: 'Storyline project', accept: { 'application/json': ['.json'], 'application/zip': ['.zip'] } }] };
