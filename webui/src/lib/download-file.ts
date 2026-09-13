// Trigger a browser download of an in-memory text file. Shared by the node-surface
// panels (mini-app / applet) so the blob + object-URL + temp-anchor dance and the
// filename slug rule live in one place.


/** Slugify a display name into a safe file base, falling back when it's empty. */
function slugifyFileBase(name: string, fallback: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  )
}


/**
 * Download `source` as `<slug(baseName)>.<ext>` with the given MIME type. No-op on
 * empty source. `fallback` names the file when `baseName` slugifies to nothing.
 */
export function downloadTextFile(
  baseName: string,
  source: string,
  opts: { ext: string; mime: string; fallback: string },
): void {
  if (!source.trim()) return
  const filename = `${slugifyFileBase(baseName, opts.fallback)}.${opts.ext}`
  const blob = new Blob([source], { type: opts.mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
