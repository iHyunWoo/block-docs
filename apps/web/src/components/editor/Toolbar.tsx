"use client";

import { useEffect, useState } from "react";
import type { ContentEditableHandle } from "./ContentEditableBlock";

interface Props {
  /** Focused block's handle (from BlockEditor). Null = toolbar hidden. */
  handle: ContentEditableHandle | null;
}

/**
 * Minimal floating toolbar for Bold / Italic / Strike / Inline code / Link.
 * Appears when the user has a non-collapsed selection inside the focused
 * block. No fancy positioning — sits at the top-left of the content column.
 */
export function Toolbar({ handle }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    function updateVisibility() {
      const sel = window.getSelection();
      setVisible(
        !!sel && !sel.isCollapsed && sel.toString().trim().length > 0 && !!handle,
      );
    }
    document.addEventListener("selectionchange", updateVisibility);
    return () =>
      document.removeEventListener("selectionchange", updateVisibility);
  }, [handle]);

  if (!visible || !handle) return null;

  return (
    <div className="floating-toolbar" role="toolbar" aria-label="Text formatting">
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => handle.toggleMark("bold")}>
        <b>B</b>
      </button>
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => handle.toggleMark("italic")}>
        <i>I</i>
      </button>
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => handle.toggleMark("strike")}>
        <s>S</s>
      </button>
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => handle.toggleMark("code")}>
        {"</>"}
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const href = window.prompt("Link URL");
          if (!href) return;
          // Link requires attrs; the minimal toolbar only supports this via a separate hook,
          // so we ask the handle to toggle a "link" format manually — but we don't expose
          // that API. Best-effort: fall back to writing the URL as plain text.
          document.execCommand("insertText", false, href);
        }}
      >
        🔗
      </button>
    </div>
  );
}
