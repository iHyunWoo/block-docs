"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { YjsRegistry } from "@/editor/yjs";
import {
  flattenBlocks,
  useBlockStore,
} from "@/store/block-store";
import type { Block, BlockType } from "@/lib/types";
import { BulletedList } from "@/components/blocks/BulletedList";
import { NumberedList } from "@/components/blocks/NumberedList";
import { Paragraph } from "@/components/blocks/Paragraph";
import { Heading } from "@/components/blocks/Heading";
import { TodoItem } from "@/components/blocks/TodoItem";
import { CodeBlock } from "@/components/blocks/CodeBlock";
import { Blockquote } from "@/components/blocks/Blockquote";
import { Divider } from "@/components/blocks/Divider";
import { Callout } from "@/components/blocks/Callout";
import { ImageBlock } from "@/components/blocks/ImageBlock";
import { SlashMenu } from "@/components/editor/SlashMenu";
import { Toolbar } from "@/components/editor/Toolbar";
import type { ContentEditableHandle } from "@/components/editor/ContentEditableBlock";
import type { MarkdownBlockTemplate } from "@/editor/paste-markdown";

interface Props {
  yjs: YjsRegistry;
  /** Called with a block id when the editor wants to focus it after mount. */
  requestFocusBlockId: string | null;
  clearRequestFocus: () => void;
}

export function BlockEditor({
  yjs,
  requestFocusBlockId,
  clearRequestFocus,
}: Props) {
  const blocks = useBlockStore((s) => s.blocks);
  const rootOrder = useBlockStore((s) => s.rootOrder);
  const childrenMap = useBlockStore((s) => s.childrenMap);
  const insertBlock = useBlockStore((s) => s.insertBlock);
  const deleteBlock = useBlockStore((s) => s.deleteBlock);
  const setFocusedBlockId = useBlockStore((s) => s.setFocusedBlockId);

  const ordered = useMemo(
    () => flattenBlocks(rootOrder, childrenMap, blocks),
    [rootOrder, childrenMap, blocks],
  );

  const handles = useRef(new Map<string, ContentEditableHandle>());
  const [toolbarHandle, setToolbarHandle] = useState<ContentEditableHandle | null>(null);
  const [slashFor, setSlashFor] = useState<string | null>(null);

  const focusBlock = useCallback((blockId: string, where: "start" | "end" = "end") => {
    setFocusedBlockId(blockId);
    const h = handles.current.get(blockId);
    if (h) {
      h.focus(where);
      setToolbarHandle(h);
    }
  }, [setFocusedBlockId]);

  // ---- Focus after programmatic insert ----
  useEffect(() => {
    if (!requestFocusBlockId) return;
    // Wait a tick for the new block to mount.
    const id = requestAnimationFrame(() => {
      focusBlock(requestFocusBlockId, "end");
      clearRequestFocus();
    });
    return () => cancelAnimationFrame(id);
  }, [requestFocusBlockId, focusBlock, clearRequestFocus]);

  // ---- Derived handlers per block ----
  const makeHandlers = useCallback(
    (block: Block, index: number) => ({
      onEnter: () => {
        const newId = insertBlock(
          block.type === "bulleted_list" || block.type === "numbered_list" || block.type === "todo"
            ? block.type
            : "paragraph",
          { afterId: block.blockId, parentId: block.parentId },
        );
        requestAnimationFrame(() => focusBlock(newId, "start"));
      },
      onBackspaceAtEmpty: () => {
        const prev = ordered[index - 1];
        deleteBlock(block.blockId);
        if (prev) focusBlock(prev.blockId, "end");
      },
      onBackspaceAtStart: () => {
        // MVP: merge behavior omitted; just focus previous block.
        const prev = ordered[index - 1];
        if (prev) focusBlock(prev.blockId, "end");
      },
      onSlash: () => setSlashFor(block.blockId),
      onArrowUp: () => {
        const prev = ordered[index - 1];
        if (prev) focusBlock(prev.blockId, "end");
      },
      onArrowDown: () => {
        const next = ordered[index + 1];
        if (next) focusBlock(next.blockId, "start");
      },
      onMarkdownPaste: (templates: MarkdownBlockTemplate[]) => {
        // Replace current block with the first template; insert rest after.
        if (templates.length === 0) return;
        const rootTemplates = templates.filter((t) => (t.parentIndex ?? 0) === 0);
        let afterId: string = block.blockId;
        // First template: if current block is empty, we can reuse its spot.
        // MVP: always insert after and delete current (simpler).
        const newIds: string[] = [];
        for (const t of rootTemplates) {
          const id = insertBlock(t.type, {
            afterId,
            parentId: block.parentId,
            content: t.content,
            blockId: t.blockId,
          });
          newIds.push(id);
          afterId = id;
        }
        // Delete the current block if it was empty (i.e. user pasted into empty).
        const bd = yjs.get(block.blockId);
        if (bd && bd.text.length === 0) {
          deleteBlock(block.blockId);
        }
        if (newIds.length > 0) {
          const firstId = newIds[0]!;
          requestAnimationFrame(() => focusBlock(firstId, "end"));
        }
      },
    }),
    [ordered, insertBlock, deleteBlock, focusBlock, yjs],
  );

  const registerRef = (block: Block) => (h: ContentEditableHandle | null) => {
    if (h) handles.current.set(block.blockId, h);
    else handles.current.delete(block.blockId);
  };

  // ---- Empty doc: offer a starter block ----
  if (ordered.length === 0) {
    return (
      <div className="block-editor-empty" data-testid="block-editor">
        <button
          className="empty-start-button"
          onClick={() => {
            const id = insertBlock("paragraph");
            requestAnimationFrame(() => focusBlock(id, "end"));
          }}
        >
          Start writing…
        </button>
      </div>
    );
  }

  return (
    <div className="block-editor" data-testid="block-editor">
      <Toolbar handle={toolbarHandle} />
      {ordered.map((block, i) => {
        const handlers = makeHandlers(block, i);
        const refCb = registerRef(block);
        return (
          <div
            key={block.blockId}
            className="block-wrap"
            data-testid="block"
            data-block-id={block.blockId}
            data-block-type={block.type}
            onFocus={() => {
              const h = handles.current.get(block.blockId);
              setFocusedBlockId(block.blockId);
              setToolbarHandle(h ?? null);
            }}
          >
            {renderBlockByType(block, i, yjs, refCb, handlers)}
          </div>
        );
      })}
      <SlashMenu
        open={!!slashFor}
        anchor={slashFor ? { blockId: slashFor } : null}
        onClose={() => setSlashFor(null)}
        onPick={(type: BlockType, options?: { level?: number }) => {
          const anchorId = slashFor;
          if (!anchorId) return;
          const content =
            type === "heading"
              ? { attrs: { level: options?.level ?? 1 }, children: [] }
              : type === "todo"
                ? { attrs: { checked: false }, children: [] }
                : { children: [] };
          const newId = insertBlock(type, { afterId: anchorId, content });
          setSlashFor(null);
          requestAnimationFrame(() => focusBlock(newId, "end"));
        }}
      />
    </div>
  );
}

interface BlockHandlers {
  onEnter: () => void;
  onBackspaceAtEmpty: () => void;
  onBackspaceAtStart: () => void;
  onSlash: () => void;
  onArrowUp: () => void;
  onArrowDown: () => void;
  onMarkdownPaste: (templates: MarkdownBlockTemplate[]) => void;
}

function renderBlockByType(
  block: Block,
  index: number,
  yjs: YjsRegistry,
  refCb: (h: ContentEditableHandle | null) => void,
  h: BlockHandlers,
) {
  const common = { block, yjs, ref: refCb, ...h };
  switch (block.type) {
    case "paragraph":
      return <Paragraph {...common} />;
    case "heading":
      return <Heading {...common} />;
    case "bulleted_list":
      return <BulletedList {...common} />;
    case "numbered_list":
      return <NumberedList {...common} index={index} />;
    case "todo":
      return <TodoItem {...common} />;
    case "code":
      return <CodeBlock {...common} />;
    case "blockquote":
      return <Blockquote {...common} />;
    case "divider":
      return <Divider />;
    case "callout":
      return <Callout {...common} />;
    case "image":
      return <ImageBlock block={block} />;
    default:
      return <Paragraph {...common} />;
  }
}
