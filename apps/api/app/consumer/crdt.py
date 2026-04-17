"""pycrdt helpers for the OperationConsumer.

We use pycrdt (the Python binding for y-crdt) to apply deltas produced by
the browser's Yjs library, then extract a DB-friendly JSON view of the
text content.

The root Y.Text lives at the key "root" in the Y.Doc. This convention must
match the frontend — both sides use a fixed key rather than naming the
text slot by blockId, because a block's identity is already implied by the
row it belongs to.

Content extraction — IMPORTANT CAVEAT
=====================================
`Y.Text.diff()` returns `[(chunk_text, attributes_dict_or_None), ...]` which
is enough to reconstruct basic `InlineNode[]` with `bold` / `italic` marks.
However pycrdt does NOT currently expose Yjs "embeds" (for mentions) in a
way that's uniformly documented across versions. For the demo we therefore:

  * map every chunk to a {type:"text", text, marks} InlineNode
  * translate attrs keys {bold, italic, strike, code} to the canonical
    `Mark` shape
  * drop unknown attrs

If you need mentions or link marks with attributes (e.g. href), extend
`diff_to_inline_nodes` accordingly. The Y.Text format is authoritative —
the DB JSON is a derived view, so lossy extraction here is recoverable by
re-running the consumer after a fix.
"""

from __future__ import annotations

from typing import Any

from pycrdt import Doc, Text


ROOT_TEXT_KEY = "root"


# Known Yjs format attribute names that map directly to our Mark types.
_SIMPLE_MARKS = ("bold", "italic", "strike", "code")


def make_doc(state: bytes | None) -> tuple[Doc, Text]:
    """Build a fresh Y.Doc and root Y.Text, optionally hydrated from state.

    Caller is responsible for discarding both once they're done — the whole
    point of the consumer is that we don't hold Y.Docs in memory.
    """
    doc = Doc()
    text = Text()
    doc[ROOT_TEXT_KEY] = text
    if state:
        doc.apply_update(state)
    return doc, text


def apply_delta(doc: Doc, delta: bytes) -> None:
    """Apply a Yjs update frame. Idempotent via Yjs's own logic."""
    doc.apply_update(delta)


def encode_state(doc: Doc) -> bytes:
    """Return a full state update — the canonical form to store in BYTEA."""
    return doc.get_update()


def diff_to_inline_nodes(diff: list[tuple[Any, dict[str, Any] | None]]) -> list[dict[str, Any]]:
    """Convert Y.Text.diff() output into our wire InlineNode[] shape."""
    nodes: list[dict[str, Any]] = []
    for chunk, attrs in diff:
        # Non-string chunks (embeds) — pass through as-is but tagged. The
        # frontend today doesn't emit embeds through the CRDT channel, but
        # this keeps forward-compat if it ever does.
        if not isinstance(chunk, str):
            nodes.append({"type": "embed", "value": chunk})
            continue
        node: dict[str, Any] = {"type": "text", "text": chunk}
        if attrs:
            marks: list[dict[str, Any]] = []
            for name in _SIMPLE_MARKS:
                if attrs.get(name):
                    marks.append({"type": name})
            href = attrs.get("link") or attrs.get("href")
            if href:
                marks.append({"type": "link", "attrs": {"href": href}})
            comment_id = attrs.get("comment") or attrs.get("commentId")
            if comment_id:
                marks.append({"type": "comment", "attrs": {"commentId": comment_id}})
            if marks:
                node["marks"] = marks
        nodes.append(node)
    return nodes


def extract_content(text: Text) -> dict[str, Any]:
    """Return the `content` JSONB payload for this block.

    Keeps the shape compatible with `Block.content`: `{ children: [...] }`.
    Attrs on the block (e.g. `{ level: 2 }` for headings) are owned by
    `update_attrs` operations and NOT by the CRDT layer — don't touch them
    here.
    """
    diff = text.diff()
    return {"children": diff_to_inline_nodes(diff)}
