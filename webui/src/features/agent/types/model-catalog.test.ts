import { describe, expect, it } from "vitest"
import { modelSupportsVision, type PublicModel } from "./model-catalog"


const model = (id: string, vision: boolean): PublicModel => ({
  id,
  label: id,
  family: "x",
  vision,
  routes: [{ via: "openrouter", model: `x/${id}` }],
})


describe("modelSupportsVision", () => {
  it("reads a concrete model's vision flag", () => {
    const catalog = [model("a", true), model("b", false)]
    expect(modelSupportsVision(catalog, "a")).toBe(true)
    expect(modelSupportsVision(catalog, "b")).toBe(false)
  })


  it("an unknown id is not vision-capable", () => {
    expect(modelSupportsVision([model("a", true)], "nope")).toBe(false)
  })


  it("'auto' is vision only when EVERY model is vision (server picks the concrete one)", () => {
    expect(modelSupportsVision([model("a", true), model("b", true)], "auto")).toBe(true)
    expect(modelSupportsVision([model("a", true), model("b", false)], "auto")).toBe(false)
    expect(modelSupportsVision([], "auto")).toBe(false)
  })
})
