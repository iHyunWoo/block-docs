"use client";

import type { InlineNode, Mark } from "@/lib/types";

// ========================================
// Inline renderer — InlineNode[] <-> DOM
//
// Used by ContentEditableBlock to reconcile the DOM with the Y.Text state
// ONLY when a remote or init-origin update lands. Local keystrokes are
// reflected by the browser's native input behavior; applying the inline
// renderer on every local keystroke would fight the browser selection.
// ========================================

const MARK_TAG: Record<string, string> = {
  bold: "strong",
  italic: "em",
  strike: "s",
  code: "code",
};

/** Build the DOM for one InlineNode. */
function buildInlineNode(node: InlineNode): Node {
  if (node.type === "mention") {
    const span = document.createElement("span");
    span.className = "mention";
    span.dataset.userId = String(node.attrs.userId);
    span.contentEditable = "false";
    span.textContent = node.attrs.label;
    return span;
  }

  // text node
  let el: Node = document.createTextNode(node.text);
  if (!node.marks || node.marks.length === 0) return el;

  // Wrap in mark tags; link/comment get anchor/span wrappers.
  for (const mark of node.marks) {
    el = wrapMark(el, mark);
  }
  return el;
}

function wrapMark(child: Node, mark: Mark): Node {
  if (mark.type === "link") {
    const a = document.createElement("a");
    const attrs = mark.attrs as { href?: string } | undefined;
    if (attrs?.href) a.href = attrs.href;
    a.target = "_blank";
    a.rel = "noreferrer noopener";
    a.appendChild(child);
    return a;
  }
  if (mark.type === "comment") {
    const span = document.createElement("span");
    span.className = "comment-anchor";
    const attrs = mark.attrs as { commentId?: string } | undefined;
    if (attrs?.commentId) span.dataset.commentId = attrs.commentId;
    span.appendChild(child);
    return span;
  }
  const tag = MARK_TAG[mark.type];
  if (!tag) return child;
  const el = document.createElement(tag);
  el.appendChild(child);
  return el;
}

/**
 * Replace `root` children with the DOM derived from `nodes`.
 *
 * Caller is responsible for cursor save/restore if needed.
 */
export function renderInlineNodes(root: HTMLElement, nodes: InlineNode[]): void {
  while (root.firstChild) root.removeChild(root.firstChild);
  if (nodes.length === 0) {
    // Keep the element selectable.
    root.appendChild(document.createElement("br"));
    return;
  }
  for (const n of nodes) root.appendChild(buildInlineNode(n));
}

// ========================================
// Selection offset helpers (for cursor preservation on remote re-render)
// ========================================

/** Linear text offset within root (ignoring mark wrappers). */
export function getSelectionOffset(root: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.endContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString().length;
}

/** Place the caret at `offset` characters into root. */
export function setSelectionOffset(root: HTMLElement, offset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let target: Text | null = null;
  let targetOffset = 0;
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    const len = t.data.length;
    if (remaining <= len) {
      target = t;
      targetOffset = remaining;
      break;
    }
    remaining -= len;
  }
  const range = document.createRange();
  if (target) {
    range.setStart(target, targetOffset);
    range.setEnd(target, targetOffset);
  } else {
    // Fallback: end of root.
    range.selectNodeContents(root);
    range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Current caret offset within root (null if not inside root). */
export function getCaretOffset(root: HTMLElement): number | null {
  return getSelectionOffset(root);
}

/** Place caret at start or end of the root element. */
export function placeCaret(root: HTMLElement, where: "start" | "end"): void {
  root.focus();
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(where === "start");
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Read the total length of the (rendered) content in characters. */
export function contentLength(root: HTMLElement): number {
  return root.textContent?.length ?? 0;
}
