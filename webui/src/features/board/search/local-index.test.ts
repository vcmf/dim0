import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { asBatchId, asNodeId } from "@canvas-harness/core"
import type { Node, NodeId } from "@canvas-harness/core"
import { addNode, freshStore } from "@/test/canvas"
import { LocalSearchIndex } from "./local-index"


const richNode = (id: string, label: string, content = ""): Node =>
  ({
    id: id as NodeId, type: "rect", x: 0, y: 0, w: 100, h: 50, angle: 0, z: 0, groups: [],
    content, data: { label: { markdown: label }, meta: { v: 1, createdAt: 0, updatedAt: 0 } },
  }) as unknown as Node


describe("LocalSearchIndex", () => {
  it("finds a node by its title", async () => {
    const store = freshStore("c")
    const index = new LocalSearchIndex()
    index.attach(store)

    addNode(store, "n1", "hello world")
    await index.idle()

    expect(await index.query("hello")).toContain("n1")
    expect(await index.query("nonexistent")).toHaveLength(0)
  })


  it("indexes the PRODUCTION title shape (data.label is a RichText object)", async () => {
    // Regression: production stores `data.label` as `{ markdown }`, not a string,
    // so the index used to read every title as empty — titles were unsearchable.
    const store = freshStore("c")
    const index = new LocalSearchIndex()
    index.attach(store)

    addNode(store, "n1")
    store.updateNode(asNodeId("n1"), {
      data: { label: { markdown: "Napoleon" } as unknown as string, meta: { v: 1, createdAt: 0, updatedAt: 0 } },
    })
    await index.idle()

    expect(await index.query("Napoleon")).toContain("n1") // title is searchable
  })


  it("does not crash when a node's label is neither string nor RichText", async () => {
    const store = freshStore("c")
    const index = new LocalSearchIndex()
    index.attach(store)

    addNode(store, "n1", "ok")
    await index.idle()
    expect(await index.query("ok")).toContain("n1")

    // A stray non-string, non-RichText label must not reject the insert (which
    // would otherwise poison the whole update queue).
    store.updateNode(asNodeId("n1"), {
      data: { label: 42 as unknown as string, meta: { v: 1, createdAt: 0, updatedAt: 0 } },
    })
    await index.idle()

    expect(index.count()).toBe(1) // still indexed, just no usable title text
    expect(await index.query("ok")).toHaveLength(0) // old title dropped on upsert

    // The queue still works for later nodes.
    addNode(store, "n2", "later")
    await index.idle()
    expect(await index.query("later")).toContain("n2")
  })


  it("reflects updates: changed body becomes searchable, old text does not", async () => {
    const store = freshStore("c")
    const index = new LocalSearchIndex()
    index.attach(store)

    addNode(store, "n1")
    store.updateNode(asNodeId("n1"), { content: "alpha" })
    await index.idle()
    expect(await index.query("alpha")).toContain("n1")

    store.updateNode(asNodeId("n1"), { content: "beta" })
    await index.idle()
    expect(await index.query("alpha")).toHaveLength(0)
    expect(await index.query("beta")).toContain("n1")
  })


  it("removes a node from the index", async () => {
    const store = freshStore("c")
    const index = new LocalSearchIndex()
    index.attach(store)

    addNode(store, "n1", "findme")
    await index.idle()
    expect(index.count()).toBe(1)

    store.removeNode(asNodeId("n1"))
    await index.idle()
    expect(index.count()).toBe(0)
    expect(await index.query("findme")).toHaveLength(0)
  })


  it("INV-9 fuzz: index id-set always equals the store's, incremental == rebuild", async () => {
    await fc.assert(
      fc.asyncProperty(arbActions(), async (actions) => {
        const store = freshStore("c")
        const index = new LocalSearchIndex()
        index.attach(store)
        const ids: string[] = []
        let counter = 0

        for (const a of actions) {
          if (a.kind === "add") {
            const id = `n${counter++}`
            addNode(store, id, a.label)
            ids.push(id)
          } else if (a.kind === "update" && ids.length > 0) {
            store.updateNode(asNodeId(ids[a.idx % ids.length]!), { content: a.text })
          } else if (a.kind === "remove" && ids.length > 0) {
            const i = a.idx % ids.length
            store.removeNode(asNodeId(ids[i]!))
            ids.splice(i, 1)
          }
        }
        await index.idle()

        // incremental index matches the store exactly
        expect(index.count()).toBe(store.getAllNodes().length)
        for (const id of ids) expect(index.has(id)).toBe(true)

        // a full rebuild produces the same id-set
        await index.rebuildFromStore(store)
        expect(index.count()).toBe(store.getAllNodes().length)
        for (const id of ids) expect(index.has(id)).toBe(true)
      }),
      { numRuns: 40 },
    )
  })


  it("indexNodes seeds the whole board (all layers) so search spans folders", async () => {
    // Nodes from DIFFERENT layers — never all present in the layer-scoped store at once.
    const index = new LocalSearchIndex()
    await index.indexNodes([richNode("root", "root note"), richNode("deep", "buried in a folder")])
    expect(await index.query("root")).toContain("root")
    expect(await index.query("buried")).toContain("deep") // a note in another folder is findable
  })


  it("ignores a remote layer-switch batch so other layers aren't evicted", async () => {
    const store = freshStore("c")
    const index = new LocalSearchIndex()
    index.attach(store)
    addNode(store, "keep", "findme") // a live LOCAL edit → indexed
    await index.idle()
    expect(await index.query("findme")).toContain("keep")

    // A layer switch reloads the store as a `remote` hydrate batch (removes the
    // current layer). The index must NOT evict — those nodes live in another layer.
    const node = store.getNode(asNodeId("keep")) as Node
    store.applyBatch({ id: asBatchId("local-hydrate"), clientId: store.clientId, ts: 1, origin: "remote", ops: [{ type: "node.remove", node }] })
    await index.idle()
    expect(await index.query("findme")).toContain("keep") // still searchable across the switch
  })


  it("DOES process a genuine remote batch (collab) — only the hydrate id is skipped", async () => {
    const store = freshStore("c")
    const index = new LocalSearchIndex()
    index.attach(store)
    addNode(store, "n1", "collabword")
    await index.idle()
    expect(await index.query("collabword")).toContain("n1")

    // A collaborator's delete arrives as a remote batch with its OWN id (not the
    // hydrate id) — it must update the index (else search returns a stale id).
    const node = store.getNode(asNodeId("n1")) as Node
    store.applyBatch({ id: asBatchId("peer-op-1"), clientId: store.clientId, ts: 1, origin: "remote", ops: [{ type: "node.remove", node }] })
    await index.idle()
    expect(await index.query("collabword")).toHaveLength(0) // evicted — collab edit applied
  })
})


const arbActions = () =>
  fc.array(
    fc.oneof(
      fc.record({ kind: fc.constant("add" as const), label: fc.string() }),
      fc.record({ kind: fc.constant("update" as const), idx: fc.nat(), text: fc.string() }),
      fc.record({ kind: fc.constant("remove" as const), idx: fc.nat() }),
    ),
    { maxLength: 40 },
  )
