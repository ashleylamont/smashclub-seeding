export const RESULT_PORTRAIT_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];

export function validateResultPortrait(file: File) {
  if (!RESULT_PORTRAIT_TYPES.includes(file.type))
    throw new Error('Choose a PNG, JPEG or WebP portrait.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Choose a portrait under 5 MB.');
}

export async function readResultPortrait(
  file: File,
  retainedEdge = 1024,
): Promise<HTMLCanvasElement> {
  validateResultPortrait(file);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error('This file could not be opened as an image.');
    }
    const longestEdge = Math.max(image.naturalWidth, image.naturalHeight);
    if (longestEdge > 4096) throw new Error('Choose a portrait up to 4096 pixels on each side.');
    // Keep only the pixels a single panel can use, including the double-scale export.
    const scale = Math.min(1, retainedEdge / longestEdge);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser could not prepare the portrait.');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}
