import { describe, expect, it } from "vitest"

import { appletDef } from "./def"


describe("applet node-type def", () => {
  it("declares type 'applet' with a React view and a placeholder", () => {
    expect(appletDef.type).toBe("applet")
    expect(typeof appletDef.view).toBe("function")
    expect(typeof appletDef.drawPlaceholder).toBe("function")
  })

  it("renders React above the LOD threshold, placeholder below", () => {
    expect(appletDef.lod?.minZoomForReact).toBeGreaterThan(appletDef.lod?.minZoomForPlaceholder ?? 0)
  })
})
