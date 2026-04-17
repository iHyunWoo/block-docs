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

export const Callout = forwardRef<ContentEditableHandle, Props>(function Callout(
  props,
  ref,
) {
  const attrs = props.block.content.attrs as
    | { icon?: string; color?: string }
    | undefined;
  return (
    <div className="block callout" data-color={attrs?.color ?? "blue"}>
      <span className="callout-icon" aria-hidden>
        {attrs?.icon ?? "💡"}
      </span>
      <ContentEditableBlock ref={ref} {...props} className="ce-inline callout-body" />
    </div>
  );
});
