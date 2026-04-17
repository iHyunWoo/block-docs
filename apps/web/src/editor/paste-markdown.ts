"use client";

import { Lexer, type Token, type Tokens } from "marked";
import type {
  Block,
  BlockType,
  BlockContent,
  InlineNode,
  Mark,
} from "@/lib/types";
import { newBlockId } from "@/lib/uuid";

// ========================================
// Markdown paste — produce a list of template blocks (without parentId/
// position/version/depth wire values). Caller (BlockEditor) attaches those
// as part of batched insert_block ops.
// ========================================

export interface MarkdownBlockTemplate {
  blockId: string;
  type: BlockType;
  content: BlockContent;
  /** Nesting hint: 0 = root, 1 = child of previous root block, etc. */
  parentIndex?: number;
}

export function isLikelyMarkdown(text: string): boolean {
  if (!text) return false;
  const markers = [/^#{1,6}\s/m, /^[-*+]\s/m, /^\d+\.\s/m, /^>\s/m, /^```/m, /\*\*.+\*\*/m, /\[[^\]]+\]\([^)]+\)/m];
  return markers.some((re) => re.test(text));
}

export function markdownToBlocks(md: string): MarkdownBlockTemplate[] {
  const lexer = new Lexer();
  const tokens = lexer.lex(md);
  const out: MarkdownBlockTemplate[] = [];
  for (const tok of tokens) {
    pushToken(tok, out, 0);
  }
  return out;
}

function pushToken(tok: Token, out: MarkdownBlockTemplate[], parentIndex: number): void {
  switch (tok.type) {
    case "heading": {
      const h = tok as Tokens.Heading;
      out.push({
        blockId: newBlockId(),
        type: "heading",
        content: {
          attrs: { level: h.depth },
          children: inlineFromTokens(h.tokens ?? [], []),
        },
        parentIndex,
      });
      return;
    }
    case "paragraph": {
      const p = tok as Tokens.Paragraph;
      out.push({
        blockId: newBlockId(),
        type: "paragraph",
        content: { children: inlineFromTokens(p.tokens ?? [], []) },
        parentIndex,
      });
      return;
    }
    case "code": {
      const c = tok as Tokens.Code;
      out.push({
        blockId: newBlockId(),
        type: "code",
        content: {
          attrs: c.lang ? { language: c.lang } : {},
          children: [{ type: "text", text: c.text }],
        },
        parentIndex,
      });
      return;
    }
    case "blockquote": {
      const bq = tok as Tokens.Blockquote;
      out.push({
        blockId: newBlockId(),
        type: "blockquote",
        content: { children: [] },
        parentIndex,
      });
      const parentIdx = out.length - 1;
      for (const child of bq.tokens ?? []) {
        pushToken(child, out, parentIdx);
      }
      return;
    }
    case "hr": {
      out.push({
        blockId: newBlockId(),
        type: "divider",
        content: {},
        parentIndex,
      });
      return;
    }
    case "list": {
      const list = tok as Tokens.List;
      const listType: BlockType = list.ordered ? "numbered_list" : "bulleted_list";
      for (const item of list.items) {
        // Each list item becomes its own block (the reference design models
        // lists as a sequence of sibling list blocks, indentation via parent).
        const it = item as Tokens.ListItem & { task?: boolean; checked?: boolean };
        const isTask = typeof it.task === "boolean" && it.task;
        const itemType: BlockType = isTask ? "todo" : listType;

        // Build text from first paragraph / text tokens at this list item's top.
        const firstText = it.tokens?.find((t) => t.type === "text") as Tokens.Text | undefined;
        const firstPara = it.tokens?.find((t) => t.type === "paragraph") as Tokens.Paragraph | undefined;
        const inlineTokens = firstPara?.tokens ?? firstText?.tokens ?? [];
        const children = inlineFromTokens(inlineTokens, []);

        const content: BlockContent = isTask
          ? { attrs: { checked: !!it.checked }, children }
          : { children };
        out.push({
          blockId: newBlockId(),
          type: itemType,
          content,
          parentIndex,
        });
        const parentIdx = out.length - 1;
        // Nested lists.
        for (const sub of it.tokens ?? []) {
          if (sub.type === "list") pushToken(sub, out, parentIdx);
        }
      }
      return;
    }
    case "html":
    case "space":
      return;
    case "table": {
      // Fallback: flatten rows as paragraphs.
      const t = tok as Tokens.Table;
      const header = t.header.map((c) => c.text).join(" | ");
      out.push({
        blockId: newBlockId(),
        type: "paragraph",
        content: { children: [{ type: "text", text: header }] },
        parentIndex,
      });
      for (const row of t.rows) {
        const line = row.map((c) => c.text).join(" | ");
        out.push({
          blockId: newBlockId(),
          type: "paragraph",
          content: { children: [{ type: "text", text: line }] },
          parentIndex,
        });
      }
      return;
    }
    default: {
      // Swallow unknown block tokens.
      const anyTok = tok as { raw?: string };
      if (anyTok.raw) {
        out.push({
          blockId: newBlockId(),
          type: "paragraph",
          content: { children: [{ type: "text", text: anyTok.raw }] },
          parentIndex,
        });
      }
    }
  }
}

// ========================================
// Inline token → InlineNode[]
// ========================================

function inlineFromTokens(tokens: Token[], marks: Mark[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const tok of tokens) walkInline(tok, marks, out);
  return mergeAdjacentText(out);
}

function walkInline(tok: Token, marks: Mark[], out: InlineNode[]): void {
  switch (tok.type) {
    case "text": {
      const t = tok as Tokens.Text & { tokens?: Token[] };
      if (t.tokens && t.tokens.length > 0) {
        for (const c of t.tokens) walkInline(c, marks, out);
      } else {
        out.push({ type: "text", text: t.text, ...(marks.length ? { marks: [...marks] } : {}) });
      }
      return;
    }
    case "strong": {
      const s = tok as Tokens.Strong;
      for (const c of s.tokens ?? []) walkInline(c, [...marks, { type: "bold" }], out);
      return;
    }
    case "em": {
      const e = tok as Tokens.Em;
      for (const c of e.tokens ?? []) walkInline(c, [...marks, { type: "italic" }], out);
      return;
    }
    case "del": {
      const d = tok as Tokens.Del;
      for (const c of d.tokens ?? []) walkInline(c, [...marks, { type: "strike" }], out);
      return;
    }
    case "codespan": {
      const c = tok as Tokens.Codespan;
      out.push({ type: "text", text: c.text, marks: [...marks, { type: "code" }] });
      return;
    }
    case "link": {
      const l = tok as Tokens.Link;
      const next: Mark[] = [...marks, { type: "link", attrs: { href: l.href } }];
      if (l.tokens && l.tokens.length > 0) {
        for (const c of l.tokens) walkInline(c, next, out);
      } else {
        out.push({ type: "text", text: l.text, marks: next });
      }
      return;
    }
    case "br": {
      out.push({ type: "text", text: "\n", ...(marks.length ? { marks: [...marks] } : {}) });
      return;
    }
    case "image": {
      const im = tok as Tokens.Image;
      out.push({ type: "text", text: im.text || "", ...(marks.length ? { marks: [...marks] } : {}) });
      return;
    }
    case "escape":
    case "html": {
      const anyTok = tok as { text?: string; raw?: string };
      const text = anyTok.text ?? anyTok.raw ?? "";
      if (text) out.push({ type: "text", text, ...(marks.length ? { marks: [...marks] } : {}) });
      return;
    }
    default: {
      const anyTok = tok as { text?: string; raw?: string; tokens?: Token[] };
      if (anyTok.tokens) {
        for (const c of anyTok.tokens) walkInline(c, marks, out);
      } else if (anyTok.text) {
        out.push({ type: "text", text: anyTok.text, ...(marks.length ? { marks: [...marks] } : {}) });
      }
    }
  }
}

function marksEqual(a?: Mark[], b?: Mark[]): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((m, i) => {
    const other = b[i]!;
    if (m.type !== other.type) return false;
    return JSON.stringify(m.attrs ?? null) === JSON.stringify(other.attrs ?? null);
  });
}

function mergeAdjacentText(nodes: InlineNode[]): InlineNode[] {
  if (nodes.length === 0) return nodes;
  const out: InlineNode[] = [nodes[0]!];
  for (let i = 1; i < nodes.length; i++) {
    const prev = out[out.length - 1]!;
    const cur = nodes[i]!;
    if (prev.type === "text" && cur.type === "text" && marksEqual(prev.marks, cur.marks)) {
      const merged: InlineNode = { type: "text", text: prev.text + cur.text };
      if (prev.marks) merged.marks = prev.marks;
      out[out.length - 1] = merged;
    } else {
      out.push(cur);
    }
  }
  return out;
}
