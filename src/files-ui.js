// File menu: open (picker / folder / ZIP), save back to the opened folder or ZIP, download ZIP,
// recent projects (remembered File System Access handles).
import { readProjectFile, readProjectZip, readProjectFolder, readProjectDirectory, writeProjectFolder, writeProjectArchive, createProjectZip, suggestedName, archivePickerOptions, openPickerOptions, validateOverviewName, manifestName } from './project-folder.js';
import { recentProjects, ensurePermission } from './storage.js';

export function createFileActions(document, { loadProject, getProject, confirmDiscard, confirm, status, markSaved, prompt, onTargetChange = () => {} }) {
  const byId = id => document.getElementById(id);
  let busy = false, directory = null, overviewName = manifestName, zipHandle = null;
  const hasDirectoryPicker = typeof window.showDirectoryPicker === 'function', hasFilePicker = typeof window.showSaveFilePicker === 'function', hasOpenPicker = typeof window.showOpenFilePicker === 'function';
  async function guard(work) {
    if (busy) return;
    busy = true; status('Working…');
    try { await work(); }
    catch (error) { if (error?.name === 'AbortError') status('Cancelled; project unchanged.'); else status(`Error: ${error.message}`); }
    finally { busy = false; }
  }
  const setTarget = (nextDirectory, nextZip, name) => { directory = nextDirectory; zipHandle = nextZip; overviewName = name ?? manifestName; onTargetChange(targetDescription()); };
  const targetDescription = () => directory ? { kind: 'folder', name: `${directory.name}/${overviewName}` } : zipHandle ? { kind: 'zip', name: zipHandle.name } : null;
  async function remember(kind, handle, name) {
    if (!handle) return;
    await recentProjects.remember({ key: `${kind}:${name}`, kind, name, title: getProject().title, handle, overviewName });
    renderRecent();
  }
  async function accept(project, { name, directoryHandle = null, zip = null, message }) {
    if (!(await confirmDiscard())) { status('Open cancelled; current project kept.'); return false; }
    setTarget(directoryHandle, zip, name);
    loadProject(project, { saved: !!(directoryHandle || zip), message });
    await remember(directoryHandle ? 'folder' : 'zip', directoryHandle ?? zip, directoryHandle ? directoryHandle.name : zip?.name);
    return true;
  }
  async function openFile(file, handle = null) {
    let project;
    try { project = await readProjectFile(file); }
    catch (error) {
      if (error.code !== 'ASSET_FOLDER_REQUIRED' || !hasDirectoryPicker) throw error;
      if (!(await confirm('Choose the project folder', `${file.name} references separate act and image files. Choose the folder that contains it to open the whole project.`, 'Choose folder…'))) return;
      const folder = await window.showDirectoryPicker({ mode: 'readwrite', id: 'storyline-project' });
      const loaded = await readProjectDirectory(folder, validateOverviewName(file.name));
      await accept(loaded.project, { name: file.name, directoryHandle: folder, message: `Opened ${file.name}. Save writes back to its folder.` });
      return;
    }
    const zip = handle && /\.zip$/i.test(file.name) ? handle : null;
    await accept(project, { name: file.name, zip, message: zip ? `Opened ${file.name}. Save writes back to it.` : `Opened ${file.name}.` });
  }
  byId('open').addEventListener('click', () => {
    if (hasOpenPicker) return guard(async () => { const [handle] = await window.showOpenFilePicker({ ...openPickerOptions, multiple: false, id: 'storyline-project' }); if (handle) await openFile(await handle.getFile(), handle); });
    byId('file-input').click();
  });
  byId('file-input').addEventListener('change', () => { const file = byId('file-input').files[0]; byId('file-input').value = ''; if (file) guard(() => openFile(file)); });
  byId('open-folder').addEventListener('click', () => {
    if (hasDirectoryPicker) return guard(async () => {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'storyline-project' });
      const loaded = await readProjectDirectory(handle);
      await accept(loaded.project, { name: loaded.name, directoryHandle: handle, message: 'Opened project folder. Save writes back to it.' });
    });
    byId('folder-input').click();
  });
  byId('folder-input').addEventListener('change', () => {
    const files = [...byId('folder-input').files]; byId('folder-input').value = '';
    if (files.length) guard(async () => { const project = await readProjectFolder(files); await accept(project, { message: `Opened project folder. ${hasDirectoryPicker ? 'Use Save to choose a writable folder.' : 'Use Download ZIP to save changes in this browser.'}` }); });
  });
  async function openRecent(entry) {
    if (!(await ensurePermission(entry.handle, 'readwrite'))) { status(`Permission for ${entry.name} was not granted.`); return; }
    if (entry.kind === 'folder') {
      const loaded = await readProjectDirectory(entry.handle, entry.overviewName ?? manifestName);
      await accept(loaded.project, { name: loaded.name, directoryHandle: entry.handle, message: `Reopened ${entry.name}. Save writes back to it.` });
    } else {
      const file = await entry.handle.getFile();
      const project = await readProjectZip(new Uint8Array(await file.arrayBuffer()));
      await accept(project, { name: file.name, zip: entry.handle, message: `Reopened ${file.name}. Save writes back to it.` });
    }
  }
  async function renderRecent() {
    const list = byId('recent-list'); if (!list) return;
    const entries = (await recentProjects.list()).filter(entry => entry.handle);
    list.replaceChildren(...entries.map(entry => {
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem');
      button.textContent = `${entry.title || entry.name} — ${entry.kind === 'folder' ? 'folder' : 'ZIP'} ${entry.name}`;
      button.addEventListener('click', () => guard(() => openRecent(entry)));
      return button;
    }));
    byId('recent-group').hidden = !entries.length;
  }
  async function saveToFolder(handle, name) {
    if (!(await ensurePermission(handle, 'readwrite'))) throw new Error('Write permission was not granted; the project is unsaved.');
    await writeProjectFolder(handle, getProject(), name);
    setTarget(handle, null, name); markSaved(); status(`Saved ${name}, acts/ and images/ to ${handle.name}.`);
    await remember('folder', handle, handle.name);
  }
  async function saveToZip(handle) {
    if (!(await ensurePermission(handle, 'readwrite'))) throw new Error('Write permission was not granted; the project is unsaved.');
    await writeProjectArchive(handle, getProject());
    setTarget(null, handle, manifestName); markSaved(); status(`Saved ${handle.name}.`);
    await remember('zip', handle, handle.name);
  }
  async function save() {
    if (directory) return saveToFolder(directory, overviewName);
    if (zipHandle) return saveToZip(zipHandle);
    if (hasDirectoryPicker) { const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'storyline-project' }); return saveToFolder(handle, manifestName); }
    if (hasFilePicker) return saveZipAs();
    return download();
  }
  async function saveZipAs() {
    const handle = await window.showSaveFilePicker({ ...archivePickerOptions, suggestedName: `${suggestedName(getProject())}.zip` });
    await saveToZip(handle);
  }
  async function download() {
    const bytes = await createProjectZip(getProject());
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' })), link = document.createElement('a');
    link.href = url; link.download = `${suggestedName(getProject())}.zip`; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status('ZIP download started (the browser does not confirm downloads; keep story.json, acts/ and images/ together).');
  }
  byId('save-json').addEventListener('click', () => guard(save));
  byId('save-folder').addEventListener('click', () => guard(async () => {
    const name = await prompt('Save to folder as', 'Overview filename', overviewName);
    if (name === null) return;
    validateOverviewName(name);
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'storyline-project' });
    await saveToFolder(handle, name);
  }));
  byId('native-save').addEventListener('click', () => guard(saveZipAs));
  byId('download').addEventListener('click', () => guard(download));
  byId('save-folder').hidden = !hasDirectoryPicker; byId('native-save').hidden = !hasFilePicker;
  byId('save-json').title = hasDirectoryPicker ? 'Save story.json, acts/ and images/ back to the project folder (or ZIP)' : hasFilePicker ? 'Save the project as a ZIP' : 'Download the project as a ZIP';
  renderRecent();
  return {
    save: () => guard(save),
    reset() { setTarget(null, null, manifestName); },
    openRecent: entry => guard(() => openRecent(entry)),
    get target() { return targetDescription(); },
    get busy() { return busy; }
  };
}
