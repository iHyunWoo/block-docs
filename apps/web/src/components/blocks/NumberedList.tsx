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
  index?: number;
  yjs: YjsRegistry;
  onEnter?: () => void;
  onBackspaceAtEmpty?: () => void;
  onBackspaceAtStart?: () => void;
  onSlash?: () => void;
  onMarkdownPaste?: (t: MarkdownBlockTemplate[]) => void;
  onArrowUp?: () => void;
  onArrowDown?: () => void;
}

export const NumberedList = forwardRef<ContentEditableHandle, Props>(
  function NumberedList({ index, ...props }, ref) {
    return (
      <div className="block numbered-list">
        <span className="list-marker" aria-hidden>
          {(index ?? 0) + 1}.
        </span>
        <ContentEditableBlock ref={ref} {...props} className="ce-inline list-body" />
      </div>
    );
  },
);
