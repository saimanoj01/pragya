export interface CompressedImageResult {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  fileName: string;
}

function replaceExt(name: string, ext: string): string {
  const clean = (name || 'capture').replace(/\.[^.]+$/, '');
  return `${clean || 'capture'}.${ext}`;
}

function loadImageElement(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to decode image'));
    };
    img.src = url;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number
): Promise<Blob | null> {
  return new Promise(resolve => {
    canvas.toBlob(blob => resolve(blob), type, quality);
  });
}

export async function compressImageToWebp(
  file: File | Blob,
  maxDimension = 1600,
  quality = 0.82
): Promise<CompressedImageResult> {
  const originalName = 'name' in file && typeof file.name === 'string' ? file.name : 'capture.webp';

  let srcWidth = 0;
  let srcHeight = 0;
  let drawable: CanvasImageSource;
  let cleanup: (() => void) | undefined;

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    srcWidth = bitmap.width;
    srcHeight = bitmap.height;
    drawable = bitmap;
    cleanup = () => bitmap.close();
  } else {
    const img = await loadImageElement(file);
    srcWidth = img.naturalWidth || img.width;
    srcHeight = img.naturalHeight || img.height;
    drawable = img;
  }

  try {
    const longest = Math.max(srcWidth, srcHeight);
    const scale = longest > maxDimension && longest > 0 ? maxDimension / longest : 1;
    const targetWidth = Math.max(1, Math.round(srcWidth * scale));
    const targetHeight = Math.max(1, Math.round(srcHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas 2D context unavailable');
    }
    ctx.drawImage(drawable, 0, 0, targetWidth, targetHeight);

    const webpBlob = await canvasToBlob(canvas, 'image/webp', quality);
    if (webpBlob && webpBlob.type === 'image/webp') {
      return {
        blob: webpBlob,
        mimeType: 'image/webp',
        width: targetWidth,
        height: targetHeight,
        fileName: replaceExt(originalName, 'webp'),
      };
    }

    const jpegBlob = await canvasToBlob(canvas, 'image/jpeg', quality);
    if (jpegBlob) {
      return {
        blob: jpegBlob,
        mimeType: jpegBlob.type || 'image/jpeg',
        width: targetWidth,
        height: targetHeight,
        fileName: replaceExt(originalName, 'jpg'),
      };
    }

    return {
      blob: file,
      mimeType: file.type || 'image/webp',
      width: targetWidth,
      height: targetHeight,
      fileName: originalName,
    };
  } finally {
    cleanup?.();
  }
}
