// Minimal ZIP reader/writer on native compression streams (deflate-raw). No Zip64.
const table = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
async function stream(bytes, Transformer, format) {
  if (typeof Transformer !== 'function') throw new Error('This browser lacks native compression streams');
  const blob = new Blob([bytes]).stream().pipeThrough(new Transformer(format));
  return new Uint8Array(await new Response(blob).arrayBuffer());
}
export const deflate = bytes => stream(bytes, globalThis.CompressionStream, 'deflate-raw');
export const inflate = bytes => stream(bytes, globalThis.DecompressionStream, 'deflate-raw');
export const encodeText = text => new TextEncoder().encode(text);
export const decodeText = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function dosTime(date) {
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() >> 1) & 31);
  const day = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { time, day };
}
// entries: iterable of [path, Uint8Array]. compress(path) decides deflate vs store.
export async function createZip(entries, { compress = () => true, date = new Date() } = {}) {
  const locals = [], centrals = []; let offset = 0;
  const { time, day } = dosTime(date);
  for (const [path, data] of entries) {
    const name = encodeText(path);
    if (name.length > 0xFFFF) throw new Error(`ZIP entry name too long: ${path}`);
    const method = compress(path) ? 8 : 0, payload = method === 8 ? await deflate(data) : data, crc = crc32(data);
    if (data.length > 0xFFFFFFFF || payload.length > 0xFFFFFFFF) throw new Error('ZIP entries over 4 GiB are unsupported');
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, method, true);
    local.setUint16(10, time, true); local.setUint16(12, day, true); local.setUint32(14, crc, true); local.setUint32(18, payload.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true); central.setUint16(8, 0x0800, true); central.setUint16(10, method, true);
    central.setUint16(12, time, true); central.setUint16(14, day, true); central.setUint32(16, crc, true); central.setUint32(20, payload.length, true); central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true); central.setUint32(42, offset, true);
    locals.push(new Uint8Array(local.buffer), name, payload); centrals.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + payload.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, locals.length / 3, true); end.setUint16(10, locals.length / 3, true); end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)], total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total); let position = 0;
  for (const part of parts) { result.set(part, position); position += part.length; }
  return result;
}
export function listZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xFFFF); i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a ZIP archive');
  const count = view.getUint16(eocd + 10, true), start = view.getUint32(eocd + 16, true);
  const entries = []; let position = start;
  for (let i = 0; i < count; i++) {
    if (position + 46 > bytes.length || view.getUint32(position, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const method = view.getUint16(position + 10, true), crc = view.getUint32(position + 16, true), compressed = view.getUint32(position + 20, true), size = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true), extraLength = view.getUint16(position + 30, true), commentLength = view.getUint16(position + 32, true), offset = view.getUint32(position + 42, true);
    const name = decodeText(bytes.subarray(position + 46, position + 46 + nameLength));
    entries.push({ name, method, crc, compressed, size, offset });
    position += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
export async function readZipEntry(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== 0x04034b50) throw new Error(`Corrupt ZIP entry ${entry.name}`);
  const nameLength = view.getUint16(entry.offset + 26, true), extraLength = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLength + extraLength, payload = bytes.subarray(start, start + entry.compressed);
  if (payload.length !== entry.compressed) throw new Error(`Truncated ZIP entry ${entry.name}`);
  let data;
  if (entry.method === 0) data = payload;
  else if (entry.method === 8) { try { data = await inflate(payload); } catch (error) { throw new Error(`ZIP entry ${entry.name} is corrupt (${error?.message || 'invalid compressed data'})`); } }
  else throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw new Error(`ZIP entry ${entry.name} failed its integrity check`);
  return data;
}
export async function extractZip(bytes, filter = () => true) {
  const result = new Map();
  for (const entry of listZip(bytes)) if (!entry.name.endsWith('/') && filter(entry.name)) result.set(entry.name, await readZipEntry(bytes, entry));
  return result;
}
