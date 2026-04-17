"use client";

import { forwardRef } from "react";
import {
  ContentEditableBlock,
  type ContentEditableHandle,
} from "@/components/editor/ContentEditableBlock";
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

export const Heading = forwardRef<ContentEditableHandle, Props>(function Heading(
  props,
  ref,
) {
  const level = ((props.block.content.attrs as { level?: number } | undefined)?.level ?? 1) as 1 | 2 | 3;
  return (
    <div className={`block heading heading-${level}`} data-level={level}>
      <ContentEditableBlock
        ref={ref}
        {...props}
        className={`ce-inline heading-${level}`}
      />
    </div>
  );
});
