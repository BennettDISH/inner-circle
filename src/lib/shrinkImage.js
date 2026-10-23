// Shrinks a photo in the browser before it is uploaded: longest side at most 2048 px, saved as
// WebP at 0.85. A phone photo of about 4 MB comes out near 300 KB, which keeps the upload
// quick and the bucket small without an image library on the server.
export const MAX_SIDE = 2048;
export const QUALITY = 0.85;

/** The size that fits `max` on its longest side, never enlarged. */
export function fitWithin(width, height, max = MAX_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const toBlob = (canvas, type) => new Promise((resolve) => canvas.toBlob(resolve, type, QUALITY));

/** A Blob of the picture, as WebP (or JPEG in a browser that cannot encode WebP). */
export async function shrinkImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file); // upright, whatever the camera's orientation tag says
  } catch {
    throw new Error('That file is not a picture this browser can read');
  }
  const { width, height } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  let blob = await toBlob(canvas, 'image/webp');
  if (blob?.type !== 'image/webp') {
    // a browser that cannot encode WebP hands back a PNG: JPEG is much smaller, on white
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    blob = await toBlob(canvas, 'image/jpeg');
  }
  if (!blob) throw new Error('The picture could not be shrunk');
  return blob;
}
