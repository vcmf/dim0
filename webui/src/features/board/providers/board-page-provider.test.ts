import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { asNodeId } from "@canvas-harness/core"
import type { IconProperty } from "@/features/newsfeed/types/properties"
import { addNode, freshStore, resetIdb } from "@/test/canvas"
import { getLocalStores } from "@/features/local-stores"
import { BoardPersistence } from "../persist/local/board-persistence"
import { setBoardPersistenceRef } from "../persist/local/board-persistence-ref"
import { setBoardSyncRef } from "../harness/sync/board-sync-ref"
import { setCanvasStoreRef } from "../harness/canvas-store-ref"
import { useBoardAppStore } from "../harness/store/board-app-store"
import { noteToNode } from "../harness/convert/note-to-node"
import { listLocalBoardContents } from "../api/list-local-board-contents"
import { createDefaultNote, type Note } from "../types/note"
import { createBoardPageProvider, noteToPage } from "./board-page-provider"


type IconValue = NonNullable<IconProperty["icon"]>

const STAR: IconValue = { type: "phosphor", name: "Star", color: null }


function note(opts: { label?: string; icon?: IconValue; markdown?: string }): Note {
  const n = createDefaultNote({ boardId: "b", nodeType: "sheet" })
  if (opts.label !== undefined) n.label = { markdown: opts.label }
  if (opts.icon !== undefined) n.properties.iconData = { type: "icon", icon: opts.icon }
  if (opts.markdown !== undefined) n.content = { markdown: opts.markdown }
  return n
}


describe("noteToPage", () => {
  it("carries the note's custom icon onto the page (the chip-icon fix)", () => {
    expect(noteToPage(note({ label: "Doc", icon: STAR })).icon).toEqual(STAR)
  })

  it("returns a null icon when the note has none (chip falls back to default)", () => {
    expect(noteToPage(note({ label: "Doc" })).icon).toBeNull()
  })

  it("uses the note's label as the title", () => {
    expect(noteToPage(note({ label: "My page" })).title).toBe("My page")
  })

  it("falls back to 'Untitled' for a blank label", () => {
    expect(noteToPage(note({ label: "   " })).title).toBe("Untitled")
    expect(noteToPage(note({})).title).toBe("Untitled")
  })

  it("derives a one-line snippet from the body markdown", () => {
    const page = noteToPage(note({ label: "x", markdown: "# Heading\n\n- bullet one\n- bullet two" }))
    expect(page.snippet).toBe("Heading bullet one bullet two")
  })

  it("passes through id and parentId", () => {
    const n = note({ label: "child" })
    n.parentId = "parent-1"
    const page = noteToPage(n)
    expect(page.id).toBe(n.id)
    expect(page.parentId).toBe("parent-1")
  })
})


describe("createBoardPageProvider (on-device store)", () => {
  // Wire a live board over the shared local engine, so the provider's local
  // read/write paths run end-to-end (no REST).
  const setup = async (boardId = "b", currentLayer: string | null = null) => {
    const { engine } = await getLocalStores()
    const persistence = new BoardPersistence(boardId, { engine })
    const store = freshStore("live")
    persistence.attach(store)
    setBoardPersistenceRef(persistence)
    setCanvasStoreRef(store)
    setBoardSyncRef(null) // no relay — persistence-only is sync-correct locally
    useBoardAppStore.setState({ rootId: currentLayer })
    return { persistence, store }
  }

  const sheetNote = (boardId: string, id: string, label: string): Note => {
    const n = createDefaultNote({ boardId, nodeType: "sheet" })
    n.id = id
    n.label = { markdown: label }
    n.content = { markdown: "" }
    return n
  }

  beforeEach(() => resetIdb())
  afterEach(() => {
    setBoardPersistenceRef(null)
    setCanvasStoreRef(null)
    setBoardSyncRef(null)
    useBoardAppStore.setState({ rootId: null })
  })

  it("list() returns the board's sheets and excludes non-sheet nodes", async () => {
    const { persistence, store } = await setup()
    store.addNode(noteToNode(sheetNote("b", "s1", "Alpha")))
    store.addNode(noteToNode(sheetNote("b", "s2", "Beta")))
    addNode(store, "r1", "a rectangle") // not a sheet
    await persistence.flush()

    const pages = await createBoardPageProvider({ boardId: "b" }).list()
    expect(pages.map((p) => p.title).sort()).toEqual(["Alpha", "Beta"])
  })

  it("list(query) filters sheets by title", async () => {
    const { persistence, store } = await setup()
    store.addNode(noteToNode(sheetNote("b", "s1", "Photosynthesis")))
    store.addNode(noteToNode(sheetNote("b", "s2", "Mitosis")))
    await persistence.flush()

    const pages = await createBoardPageProvider({ boardId: "b" }).list("photo")
    expect(pages.map((p) => p.title)).toEqual(["Photosynthesis"])
  })

  it("get() resolves a page (title + snippet) from the whole-board replica", async () => {
    const { engine } = await getLocalStores()
    const persistence = new BoardPersistence("b", { engine })
    const seed = freshStore("seed")
    const unsub = persistence.attach(seed)
    const n = createDefaultNote({ boardId: "b", nodeType: "sheet" })
    n.id = "s1"
    n.label = { markdown: "Deep Page" }
    n.content = { markdown: "# Title\n\nsome body text" }
    seed.addNode(noteToNode(n))
    await persistence.flush()
    unsub()
    // No live store → the whole-board replica path must resolve it.
    setBoardPersistenceRef(null)
    setCanvasStoreRef(null)

    const page = await createBoardPageProvider({ boardId: "b" }).get("s1")
    expect(page?.title).toBe("Deep Page")
    expect(page?.snippet).toContain("some body text")
    expect(await createBoardPageProvider({ boardId: "b" }).get("nope")).toBeNull()
  })

  it("create() adds a top-level sheet in the current layer and lists it", async () => {
    const { persistence, store } = await setup("b", null) // viewing root
    const provider = createBoardPageProvider({ boardId: "b" })
    const page = await provider.create({ title: "New Page" })
    // In-scene: rendered in the visible store, empty body (not seeded from title).
    expect(store.getNode(asNodeId(page.id))?.type).toBe("sheet")
    expect(store.getNode(asNodeId(page.id))?.content).toBe("")
    await persistence.flush()
    expect((await provider.list()).map((p) => p.title)).toContain("New Page")
  })

  it("create() with a parent writes the subpage off-scene, durable + listable without a manual flush", async () => {
    const { store } = await setup("b", null) // viewing root
    const provider = createBoardPageProvider({ boardId: "b" })
    const page = await provider.create({ title: "Child", parentId: "parent-note" })
    // Off-scene: a child layer, so it must NOT land in the visible store.
    expect(store.getNode(asNodeId(page.id))).toBeUndefined()
    // create() flushed before returning, so the page is already durable + listable
    // (no store 'change' fired for the off-scene write — the flush is the guard).
    expect((await provider.list()).map((p) => p.title)).toContain("Child")
    const items = await listLocalBoardContents("b")
    expect(items.find((it) => it.id === page.id)?.parentId).toBe("parent-note")
  })

  it("get() returns null for a non-sheet node (a page is a sheet)", async () => {
    const { store } = await setup("b", null)
    addNode(store, "rect1", "a rectangle") // not a sheet, in the live store
    const page = await createBoardPageProvider({ boardId: "b" }).get("rect1")
    expect(page).toBeNull()
  })

  it("create() throws (no dangling chip) when there is no live board to write into", async () => {
    await setup("b", null)
    setCanvasStoreRef(null) // simulate no mounted board
    await expect(createBoardPageProvider({ boardId: "b" }).create({ title: "X" })).rejects.toThrow()
  })
})
