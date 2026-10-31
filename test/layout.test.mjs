import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoLayout, CARD_WIDTH } from '../src/layout.js';
import { createZip, extractZip, encodeText, decodeText, crc32 } from '../src/zip.js';

test('auto-layout places linked passages in successive columns without overlap', () => {
  const passages = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, position: { x: 0, y: 0 } }));
  const edges = [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['d', 'a'], ['d', 'e'], ['e', 'e']].map(([from, to]) => ({ from, to }));
  const positions = autoLayout(passages, edges, { startId: 'a', cardHeight: () => 100 });
  assert.equal(positions.size, 5);
  assert.ok(positions.get('b').x > positions.get('a').x && positions.get('d').x > positions.get('b').x && positions.get('e').x > positions.get('d').x);
  assert.equal(positions.get('b').x, positions.get('c').x);
  const list = [...positions.values()];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    assert.ok(a.x + CARD_WIDTH <= b.x || b.x + CARD_WIDTH <= a.x || a.y + 100 <= b.y || b.y + 100 <= a.y, 'cards overlap');
  }
});
test('zip round trip with store and deflate, crc check', async () => {
  const big = new Uint8Array(100000).map((_, i) => i % 251);
  const zip = await createZip([['story.json', encodeText('{"ok":true}')], ['images/b.bin', big]], { compress: p => p.endsWith('.json') });
  const back = await extractZip(zip);
  assert.equal(decodeText(back.get('story.json')), '{"ok":true}');
  assert.deepEqual(back.get('images/b.bin'), big);
  assert.equal(crc32(encodeText('123456789')), 0xCBF43926);
  await assert.rejects(extractZip(zip.slice(0, -30)), /Not a ZIP archive/);
  const corrupt = zip.slice(); corrupt[40] ^= 0xFF; // flip a payload byte of the first entry
  await assert.rejects(extractZip(corrupt), /integrity|ZIP/);
});
