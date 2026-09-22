// Small canvas ⇄ blob/image helpers shared across the harness (thumbnail capture, image
// export). Kept dependency-free so importing them pulls nothing heavy onto any bundle.


/**
 * Encode a canvas to a PNG `Blob`. Rejects if `toBlob` returns null (some browsers do under
 * privacy/quota pressure, or for a tainted canvas).
 */
export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob returned null (tainted or blocked)"))), "image/png")
  })
}


/** Decode an image `Blob` to a drawable `HTMLImageElement`, or null on failure. */
export function blobToImage(blob: Blob): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}
