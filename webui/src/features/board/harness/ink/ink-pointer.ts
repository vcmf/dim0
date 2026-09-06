const PALM_CONTACT_MIN_SIZE = 32


/** Palm contacts are substantially wider than a Pencil tip or a normal fingertip. */
export const isLikelyPalmContact = (width: number, height: number): boolean =>
  Math.max(width, height) >= PALM_CONTACT_MIN_SIZE


/** Pointer Events reserves button 5 / buttons bit 32 for a pen eraser. */
export const isPenEraserContact = (event: Pick<PointerEvent, "pointerType" | "button" | "buttons">): boolean =>
  event.pointerType === "pen" && (event.button === 5 || (event.buttons & 32) !== 0)
