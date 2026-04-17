"use client";

import { forwardRef } from "react";
import {
  ContentEditableBlock,
  type ContentEditableHandle,
} from "@/components/editor/ContentEditableBlock";
import { useBlockStore } from "@/store/block-store";
import type { Block } from "@/lib/types";
import type { YjsRegistry } from "@/editor/yjs";
import type { MarkdownBlockTemplate } from "@/editor/paste-markdown";

interface Props {
  block: Block;
  yjs: YjsRegistry;
  onEnter?: () => void;
  onBackspaceAtEmpty?: () => void;
  onBackspaceAtStart?: () => void;
  onSlash?: () => void;
  onMarkdownPaste?: (t: MarkdownBlockTemplate[]) => void;
  onArrowUp?: () => void;
  onArrowDown?: () => void;
}

export const TodoItem = forwardRef<ContentEditableHandle, Props>(function TodoItem(
  props,
  ref,
) {
  const updateAttrs = useBlockStore((s) => s.updateAttrs);
  const checked = !!(props.block.content.attrs as { checked?: boolean } | undefined)?.checked;

  return (
    <div className={`block todo ${checked ? "todo-checked" : ""}`}>
      <input
        type="checkbox"
        className="todo-checkbox"
        checked={checked}
        onChange={(e) => updateAttrs(props.block.blockId, { checked: e.target.checked })}
      />
      <ContentEditableBlock ref={ref} {...props} className="ce-inline todo-body" />
    </div>
  );
});
