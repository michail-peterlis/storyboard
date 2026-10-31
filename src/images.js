import { validateImage, validateImageData, newId } from './model.js';
const readDataUrl = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read the selected image')); reader.onabort = () => reject(new Error('Image read cancelled')); reader.readAsDataURL(file); });
const decode = url => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('Could not decode image; choose a valid PNG, JPEG, WebP or GIF')); image.src = url; });
// PNG/JPEG keep their bytes; WebP/GIF become PNG stills at their original size.
export async function processImage(file) {
  if (!file || file.size <= 0) throw new Error('Choose a nonempty image file');
  const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  const mime = file.type || types[file.name.split('.').at(-1).toLowerCase()];
  if (!Object.values(types).includes(mime)) throw new Error('Choose PNG, JPEG, WebP or GIF. SVG and other formats are not supported');
  const dataUrl = await readDataUrl(file.type ? file : new Blob([file], { type: mime })), image = await decode(dataUrl);
  let canvas;
  try {
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('Could not decode image dimensions');
    if (mime === 'image/png' || mime === 'image/jpeg') return validateImage({ id: newId('image'), name: file.name.slice(0, 200), caption: '', dataUrl, ...validateImageData(dataUrl) });
    canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d'); if (!context) throw new Error('This browser cannot convert this image');
    context.drawImage(image, 0, 0);
    const png = canvas.toDataURL('image/png');
    if (!png.startsWith('data:image/png;base64,')) throw new Error('This browser could not convert the image');
    return validateImage({ id: newId('image'), name: file.name.slice(0, 200), caption: '', dataUrl: png, width: canvas.width, height: canvas.height });
  } finally { image.src = ''; if (canvas) canvas.width = canvas.height = 0; }
}
