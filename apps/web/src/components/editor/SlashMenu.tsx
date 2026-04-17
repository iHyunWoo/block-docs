"use client";

import { useEffect, useState } from "react";
import type { BlockType } from "@/lib/types";

export interface SlashOption {
  key: BlockType;
  label: string;
  hint: string;
}

const OPTIONS: SlashOption[] = [
  { key: "paragraph", label: "Text", hint: "Plain paragraph" },
  { key: "heading", label: "Heading 1", hint: "Large section heading" },
  { key: "bulleted_list", label: "Bulleted list", hint: "• item" },
  { key: "numbered_list", label: "Numbered list", hint: "1. item" },
  { key: "todo", label: "To-do", hint: "Checkbox" },
  { key: "code", label: "Code block", hint: "Monospace" },
  { key: "blockquote", label: "Quote", hint: "| quote" },
  { key: "callout", label: "Callout", hint: "Highlight" },
  { key: "divider", label: "Divider", hint: "---" },
  { key: "image", label: "Image", hint: "Upload / URL" },
];

interface Props {
  open: boolean;
  anchor: { blockId: string } | null;
  onPick: (type: BlockType, options?: { level?: number }) => void;
  onClose: () => void;
}

export function SlashMenu({ open, anchor, onPick, onClose }: Props) {
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    if (!open) return;
    setCursor(0);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => (c + 1) % OPTIONS.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => (c - 1 + OPTIONS.length) % OPTIONS.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const opt = OPTIONS[cursor]!;
        onPick(opt.key, opt.key === "heading" ? { level: 1 } : undefined);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, cursor, onPick, onClose]);

  if (!open || !anchor) return null;
  return (
    <div className="slash-menu" role="listbox" data-testid="slash-menu">
      {OPTIONS.map((opt, i) => (
        <button
          key={opt.key}
          className={`slash-item ${i === cursor ? "slash-item-active" : ""}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() =>
            onPick(opt.key, opt.key === "heading" ? { level: 1 } : undefined)
          }
          role="option"
          aria-selected={i === cursor}
        >
          <span className="slash-label">{opt.label}</span>
          <span className="slash-hint">{opt.hint}</span>
        </button>
      ))}
    </div>
  );
}
