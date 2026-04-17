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

export const BulletedList = forwardRef<ContentEditableHandle, Props>(
  function BulletedList(props, ref) {
    return (
      <div className="block bulleted-list">
        <span className="list-marker" aria-hidden>
          •
        </span>
        <ContentEditableBlock ref={ref} {...props} className="ce-inline list-body" />
      </div>
    );
  },
);
