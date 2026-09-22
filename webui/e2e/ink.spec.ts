import { test, expect, type Page } from "@playwright/test"
import type { CanvasStore } from "@canvas-harness/core"


/** Read committed strokes from the real mounted board, without creating test nodes. */
const strokes = (page: Page) => page.evaluate(async () => {
  const path = "/src/features/board/harness/canvas-store-ref.ts"
  const { getCanvasStoreRef } = await import(/* @vite-ignore */ path) as { getCanvasStoreRef: () => CanvasStore | null }
  return getCanvasStoreRef()?.getAllNodes().filter((node) => node.type === "ink") ?? []
})


test("official pen and eraser support undo and reload persistence", async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto("/local")
  await page.getByRole("list", { name: "On this device" }).getByText("New Board").click()
  await expect(page).toHaveURL(/\/local\/.+/)
  await page.getByRole("button", { name: "Pen", exact: true }).click()
  await page.mouse.move(400, 300)
  await page.mouse.down()
  await page.mouse.move(520, 350, { steps: 16 })
  expect(await strokes(page)).toHaveLength(0)
  await page.mouse.up()
  await expect.poll(async () => (await strokes(page)).length).toBe(1)
  const original = (await strokes(page))[0]
  expect(original.data?.ink).toBeTruthy()

  await page.getByRole("button", { name: "Eraser", exact: true }).click()
  await page.mouse.move(430, 312)
  await page.mouse.down()
  await page.mouse.move(490, 338, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await strokes(page)).length).toBe(0)
  await page.keyboard.press("Control+z")
  await expect.poll(async () => (await strokes(page)).length).toBe(1)

  await page.evaluate(async () => {
    const path = "/src/features/board/persist/local/board-persistence-ref.ts"
    const { getBoardPersistenceRef } = await import(/* @vite-ignore */ path)
    await getBoardPersistenceRef()?.flush()
  })
  await page.reload()
  await expect.poll(async () => (await strokes(page)).length).toBe(1)
  expect((await strokes(page))[0].data?.ink).toEqual(original.data?.ink)
})
