"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type FormEvent,
  type KeyboardEvent,
  type ClipboardEvent,
} from "react";
import * as Y from "yjs";
import {
  getSelectionOffset,
  placeCaret,
  renderInlineNodes,
  setSelectionOffset,
} from "@/editor/inline-renderer";
import { readInlineNodes, type YjsRegistry } from "@/editor/yjs";
import {
  isLikelyMarkdown,
  markdownToBlocks,
  type MarkdownBlockTemplate,
} from "@/editor/paste-markdown";
import type { Block, InlineNode } from "@/lib/types";

// ========================================
// ContentEditableBlock — a contentEditable region wired to one block's Y.Text.
//
// Local keystrokes: captured via beforeinput → translated to yText.insert/
// .delete/.format. The browser's native DOM update proceeds; we DON'T re-run
// the inline renderer on local updates (would fight selection / IME).
//
// Remote updates: the parent wires the YjsRegistry.subscribe callback to
// call `handleRemoteChange`, which re-renders the DOM with cursor preserved.
// ========================================

export interface ContentEditableHandle {
  focus(where?: "start" | "end"): void;
  /** Apply a mark (bold/italic/strike/code) to current selection. */
  toggleMark(mark: "bold" | "italic" | "strike" | "code"): void;
}

interface Props {
  block: Block;
  yjs: YjsRegistry;
  placeholder?: string;
  className?: string;
  /** Dispatched when user presses Enter at end of block. */
  onEnter?: () => void;
  /** Backspace at position 0 of an empty block. */
  onBackspaceAtEmpty?: () => void;
  /** Backspace at position 0 of a non-empty block (request merge with prev). */
  onBackspaceAtStart?: () => void;
  /** User typed '/' at start — caller may show slash menu. */
  onSlash?: () => void;
  /** User pastes text; caller may replace current block with resulting blocks. */
  onMarkdownPaste?: (templates: MarkdownBlockTemplate[]) => void;
  /** ArrowUp at first row. */
  onArrowUp?: () => void;
  /** ArrowDown at last row. */
  onArrowDown?: () => void;
}

export const ContentEditableBlock = forwardRef<ContentEditableHandle, Props>(
  function ContentEditableBlock(
    {
      block,
      yjs,
      placeholder,
      className,
      onEnter,
      onBackspaceAtEmpty,
      onBackspaceAtStart,
      onSlash,
      onMarkdownPaste,
      onArrowUp,
      onArrowDown,
    },
    ref,
  ) {
    const domRef = useRef<HTMLDivElement | null>(null);
    const isComposingRef = useRef(false);

    // Ensure the Doc/Text exists and seed with content on first mount.
    const entry = yjs.ensure(block.blockId, block.content.children ?? []);
    const yText = entry.text;

    // ---- Initial render of DOM from Y.Text state ----
    useEffect(() => {
      const root = domRef.current;
      if (!root) return;
      const nodes = readInlineNodes(yText);
      renderInlineNodes(root, nodes);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ---- Subscribe to remote updates ----
    useEffect(() => {
      return yjs.subscribe(block.blockId, () => {
        const root = domRef.current;
        if (!root) return;
        if (isComposingRef.current) return; // don't fight IME
        const prevOffset = getSelectionOffset(root);
        const nodes = readInlineNodes(yText);
        renderInlineNodes(root, nodes);
        if (prevOffset != null) {
          setSelectionOffset(root, Math.min(prevOffset, root.textContent?.length ?? 0));
        }
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [block.blockId, yjs]);

    useImperativeHandle(ref, () => ({
      focus(where = "end") {
        const root = domRef.current;
        if (!root) return;
        placeCaret(root, where);
      },
      toggleMark(mark) {
        const root = domRef.current;
        if (!root) return;
        const start = getSelectionOffset(root);
        const sel = window.getSelection();
        if (start == null || !sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        if (range.collapsed) return;
        const preRange = document.createRange();
        preRange.selectNodeContents(root);
        preRange.setEnd(range.startContainer, range.startOffset);
        const s = preRange.toString().length;
        const len = range.toString().length;
        // Decide toggle: if all chars in range currently have the mark, clear it.
        const currentFormat = yText.toDelta() as Array<{
          insert: string | Record<string, unknown>;
          attributes?: Record<string, unknown>;
        }>;
        let pos = 0;
        let allHave = true;
        for (const op of currentFormat) {
          const size = typeof op.insert === "string" ? op.insert.length : 1;
          const overlap = Math.min(pos + size, s + len) - Math.max(pos, s);
          if (overlap > 0) {
            const has = op.attributes && op.attributes[mark] === true;
            if (!has) {
              allHave = false;
              break;
            }
          }
          pos += size;
        }
        const fmtVal: boolean | null = allHave ? null : true;
        yText.format(s, len, { [mark]: fmtVal });
        // Re-render to reflect formatting locally.
        const offset = getSelectionOffset(root);
        renderInlineNodes(root, readInlineNodes(yText));
        if (offset != null) setSelectionOffset(root, offset);
      },
    }));

    // ---- Input handler ----
    const handleBeforeInput = (e: FormEvent<HTMLDivElement>) => {
      const ev = e.nativeEvent as InputEvent;
      if (isComposingRef.current) return; // let IME composition finish
      const root = domRef.current;
      if (!root) return;
      const offset = getSelectionOffset(root);
      if (offset == null) return;

      // Handle non-collapsed selection = delete range + insert.
      const sel = window.getSelection();
      let selStart = offset;
      let selEnd = offset;
      if (sel && sel.rangeCount > 0 && !sel.getRangeAt(0).collapsed) {
        const range = sel.getRangeAt(0);
        const preStart = document.createRange();
        preStart.selectNodeContents(root);
        preStart.setEnd(range.startContainer, range.startOffset);
        selStart = preStart.toString().length;
        selEnd = selStart + range.toString().length;
      }

      switch (ev.inputType) {
        case "insertText": {
          e.preventDefault();
          if (selEnd > selStart) yText.delete(selStart, selEnd - selStart);
          const txt = ev.data ?? "";
          yText.insert(selStart, txt);
          const root2 = domRef.current!;
          renderInlineNodes(root2, readInlineNodes(yText));
          setSelectionOffset(root2, selStart + txt.length);
          return;
        }
        case "insertParagraph": {
          e.preventDefault();
          onEnter?.();
          return;
        }
        case "deleteContentBackward": {
          e.preventDefault();
          if (selEnd > selStart) {
            yText.delete(selStart, selEnd - selStart);
            const root2 = domRef.current!;
            renderInlineNodes(root2, readInlineNodes(yText));
            setSelectionOffset(root2, selStart);
            return;
          }
          if (selStart === 0) {
            if (yText.length === 0) onBackspaceAtEmpty?.();
            else onBackspaceAtStart?.();
            return;
          }
          yText.delete(selStart - 1, 1);
          const root2 = domRef.current!;
          renderInlineNodes(root2, readInlineNodes(yText));
          setSelectionOffset(root2, selStart - 1);
          return;
        }
        case "deleteContentForward": {
          e.preventDefault();
          if (selEnd > selStart) {
            yText.delete(selStart, selEnd - selStart);
          } else if (selStart < yText.length) {
            yText.delete(selStart, 1);
          }
          const root2 = domRef.current!;
          renderInlineNodes(root2, readInlineNodes(yText));
          setSelectionOffset(root2, selStart);
          return;
        }
        case "formatBold": {
          e.preventDefault();
          toggleMarkRange(yText, selStart, selEnd, "bold");
          const root2 = domRef.current!;
          renderInlineNodes(root2, readInlineNodes(yText));
          setSelectionOffset(root2, selEnd);
          return;
        }
        case "formatItalic": {
          e.preventDefault();
          toggleMarkRange(yText, selStart, selEnd, "italic");
          const root2 = domRef.current!;
          renderInlineNodes(root2, readInlineNodes(yText));
          setSelectionOffset(root2, selEnd);
          return;
        }
        case "insertFromPaste": {
          e.preventDefault();
          // paste handler below handles both plain + markdown
          return;
        }
        case "insertLineBreak": {
          e.preventDefault();
          if (selEnd > selStart) yText.delete(selStart, selEnd - selStart);
          yText.insert(selStart, "\n");
          const root2 = domRef.current!;
          renderInlineNodes(root2, readInlineNodes(yText));
          setSelectionOffset(root2, selStart + 1);
          return;
        }
        default: {
          // Unhandled: let the browser do its thing (IME will fall here too).
          return;
        }
      }
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      const root = domRef.current;
      if (!root) return;
      if (e.key === "/" && yText.length === 0) {
        e.preventDefault();
        onSlash?.();
        return;
      }
      if (e.key === "ArrowUp") {
        // Let browser handle; upgrade to move-to-prev only on boundary.
        const offset = getSelectionOffset(root) ?? 0;
        if (offset === 0) {
          e.preventDefault();
          onArrowUp?.();
        }
        return;
      }
      if (e.key === "ArrowDown") {
        const offset = getSelectionOffset(root) ?? 0;
        if (offset === yText.length) {
          e.preventDefault();
          onArrowDown?.();
        }
        return;
      }
    };

    const handlePaste = (e: ClipboardEvent<HTMLDivElement>) => {
      const clipboard = e.clipboardData;
      if (!clipboard) return;
      const root = domRef.current;
      if (!root) return;
      const mdText = clipboard.getData("text/markdown");
      const text = mdText || clipboard.getData("text/plain");
      if (!text) return;

      // If it looks like markdown (heading, list, fenced code, etc), transform.
      const treatAsMd = !!mdText || isLikelyMarkdown(text);
      if (treatAsMd) {
        e.preventDefault();
        const templates = markdownToBlocks(text);
        if (templates.length > 0) {
          onMarkdownPaste?.(templates);
          return;
        }
      }
      // Plain text paste — insert at selection.
      e.preventDefault();
      const offset = getSelectionOffset(root) ?? yText.length;
      const sel = window.getSelection();
      let selStart = offset;
      let selEnd = offset;
      if (domRef.current && sel && sel.rangeCount > 0 && !sel.getRangeAt(0).collapsed) {
        const range = sel.getRangeAt(0);
        const pre = document.createRange();
        pre.selectNodeContents(domRef.current);
        pre.setEnd(range.startContainer, range.startOffset);
        selStart = pre.toString().length;
        selEnd = selStart + range.toString().length;
      }
      if (selEnd > selStart) yText.delete(selStart, selEnd - selStart);
      yText.insert(selStart, text);
      const root2 = domRef.current!;
      renderInlineNodes(root2, readInlineNodes(yText));
      setSelectionOffset(root2, selStart + text.length);
    };

    const dataPlaceholder =
      placeholder ?? (block.type === "paragraph" ? "Type '/' for commands" : "");

    return (
      <div
        ref={domRef}
        className={className ?? "ce-block"}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        data-block-id={block.blockId}
        data-placeholder={dataPlaceholder}
        onBeforeInput={handleBeforeInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onCompositionEnd={(e) => {
          isComposingRef.current = false;
          // Flush composed text into Y.Text.
          const root = domRef.current;
          if (!root) return;
          const composed = e.data || "";
          const offset = getSelectionOffset(root);
          if (offset == null) return;
          const insertAt = Math.max(0, offset - composed.length);
          yText.insert(insertAt, composed);
          // Re-render + restore caret.
          renderInlineNodes(root, readInlineNodes(yText));
          setSelectionOffset(root, insertAt + composed.length);
        }}
      />
    );
  },
);

// ---- helpers ----

function toggleMarkRange(
  yText: Y.Text,
  start: number,
  end: number,
  mark: "bold" | "italic" | "strike" | "code",
): void {
  if (end <= start) return;
  const currentFormat = yText.toDelta() as Array<{
    insert: string | Record<string, unknown>;
    attributes?: Record<string, unknown>;
  }>;
  let pos = 0;
  let allHave = true;
  for (const op of currentFormat) {
    const size = typeof op.insert === "string" ? op.insert.length : 1;
    const overlap = Math.min(pos + size, end) - Math.max(pos, start);
    if (overlap > 0 && !(op.attributes && op.attributes[mark] === true)) {
      allHave = false;
      break;
    }
    pos += size;
  }
  const fmtVal: boolean | null = allHave ? null : true;
  yText.format(start, end - start, { [mark]: fmtVal });
}

// Not exported directly, but useful for unit tests.
export { toggleMarkRange as __toggleMarkRangeForTest };

// Suppress unused import warning — InlineNode/Tokens used only as types above
export type __InlineNode = InlineNode;
