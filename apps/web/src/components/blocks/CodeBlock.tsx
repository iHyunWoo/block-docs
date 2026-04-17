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

/**
 * Simple code block: contentEditable with monospaced font. Language can be
 * edited via attrs. Enter inserts line break, not a new block.
 */
export const CodeBlock = forwardRef<ContentEditableHandle, Props>(function CodeBlock(
  props,
  ref,
) {
  const updateAttrs = useBlockStore((s) => s.updateAttrs);
  const language =
    ((props.block.content.attrs as { language?: string } | undefined)?.language) ?? "";

  return (
    <div className="block code-block">
      <input
        className="code-language"
        value={language}
        placeholder="language"
        onChange={(e) => updateAttrs(props.block.blockId, { language: e.target.value })}
      />
      <pre className="code-pre">
        <ContentEditableBlock
          ref={ref}
          block={props.block}
          yjs={props.yjs}
          className="ce-inline code-body"
          // Enter inside code = new line; we don't call onEnter. Backspace at
          // start still removes the block.
          onBackspaceAtEmpty={props.onBackspaceAtEmpty}
          onBackspaceAtStart={props.onBackspaceAtStart}
          onArrowUp={props.onArrowUp}
          onArrowDown={props.onArrowDown}
          onMarkdownPaste={props.onMarkdownPaste}
        />
      </pre>
    </div>
  );
});
