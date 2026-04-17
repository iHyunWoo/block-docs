import { describe, it, expect, beforeEach } from "vitest";
import { useBlockStore, flattenBlocks } from "@/store/block-store";

function seed() {
  useBlockStore.getState().loadSnapshot({
    docId: 1,
    blocks: [
      {
        blockId: "a",
        parentId: null,
        position: "c",
        depth: 0,
        type: "paragraph",
        content: {},
        version: 1,
      },
      {
        blockId: "b",
        parentId: null,
        position: "n",
        depth: 0,
        type: "paragraph",
        content: {},
        version: 1,
      },
    ],
    lastStreamId: "0-0",
  });
}

describe("block-store.insertBlock", () => {
  beforeEach(() => {
    seed();
  });

  it("inserts between two existing blocks in correct tree order", () => {
    const newId = useBlockStore.getState().insertBlock("paragraph", { afterId: "a" });
    const { blocks, rootOrder, childrenMap } = useBlockStore.getState();
    const order = flattenBlocks(rootOrder, childrenMap, blocks).map((b) => b.blockId);
    expect(order).toEqual(["a", newId, "b"]);
  });

  it("appends to end when afterId is the last block", () => {
    const newId = useBlockStore.getState().insertBlock("paragraph", { afterId: "b" });
    const { blocks, rootOrder, childrenMap } = useBlockStore.getState();
    const order = flattenBlocks(rootOrder, childrenMap, blocks).map((b) => b.blockId);
    expect(order).toEqual(["a", "b", newId]);
  });

  it("inserts at start when afterId is not supplied", () => {
    const newId = useBlockStore.getState().insertBlock("paragraph");
    const { blocks, rootOrder, childrenMap } = useBlockStore.getState();
    const order = flattenBlocks(rootOrder, childrenMap, blocks).map((b) => b.blockId);
    expect(order[0]).toBe(newId);
  });

  it("produces a pending op with insert_block", () => {
    useBlockStore.getState().insertBlock("paragraph", { afterId: "a" });
    const pending = useBlockStore.getState().pendingOps;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.ops[0]!.op).toBe("insert_block");
  });
});
