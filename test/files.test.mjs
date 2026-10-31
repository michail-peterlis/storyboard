import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newProject, validateImage } from '../src/model.js';
import { resolveProject, createProjectZip, readProjectZip, createProjectFiles, validateManifest } from '../src/project-folder.js';
import { addAct } from '../src/acts.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('project round trip keeps passages, acts, images and viewports', async () => {
  const project = newProject();
  project.passages[1].image = validateImage({ id: 'image_1', name: 'x.png', caption: 'c', dataUrl: PNG, width: 1, height: 1 });
  addAct(project, 'Act 2');
  const back = await readProjectZip(await createProjectZip(project));
  assert.deepEqual(back.passages.map(p => p.source), project.passages.map(p => p.source));
  assert.equal(back.passages[1].image.caption, 'c'); assert.equal(back.editor.actLayout.acts.length, 2);
  assert.deepEqual(back.initialGameState, project.initialGameState);
});
test('project files are content-addressed and the manifest validates', async () => {
  const { manifest, files } = await createProjectFiles(newProject());
  assert.equal(manifest.formatVersion, 1); assert.equal(manifest.languageVersion, 1); assert.ok(!('storyFormatVersion' in manifest));
  assert.ok([...files.keys()].every(path => path === 'story.json' || /^acts\/act_[^/]+-[0-9a-f]{16}\.json$/.test(path)));
  validateManifest(manifest);
});
test('other formats are rejected clearly', async () => {
  await assert.rejects(resolveProject(JSON.stringify({ format: 'storyline-project', formatVersion: 6, storyFormatVersion: 4 })), /Unsupported project format 6/);
  await assert.rejects(resolveProject(JSON.stringify({ format: 'storyline-project', formatVersion: 1, languageVersion: 1, passages: [] })), /Unsupported project format 1/);
  await assert.rejects(resolveProject(JSON.stringify({ format: 'something-else' })), /Not a Storyline project/);
  await assert.rejects(readProjectZip(new Uint8Array([80, 75, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), /story.json/);
});
test('an overview without its act files asks for the folder', async () => {
  const { manifest } = await createProjectFiles(newProject());
  await assert.rejects(resolveProject(JSON.stringify(manifest)), error => error.code === 'ASSET_FOLDER_REQUIRED');
});
