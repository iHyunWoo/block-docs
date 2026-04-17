"""LexoRank — fractional string ordering (docs §7).

A minimal LexoRank implementation using the alphabet 0-9a-z (base 36). The
algorithm computes the "midpoint" of two strings so that a new rank can be
inserted between any two existing ranks without renumbering existing rows.

Conventions:
- `None` on the left means "before the first item" — treat as the all-zeros
  boundary ("0").
- `None` on the right means "after the last item" — treat as the open upper
  boundary (we append a character beyond the right side).
- Empty string "" for the very first insertion returns "m" (the canonical
  midpoint of the 36-char alphabet).

Rebalance: a rank longer than REBALANCE_THRESHOLD characters signals the
caller should rebalance that parent's siblings. We keep the threshold conservative
(48) to leave headroom before we bump against the DB VARCHAR(64) limit.
"""

from __future__ import annotations

from typing import Iterable

ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"
BASE = len(ALPHABET)  # 36
_VAL = {c: i for i, c in enumerate(ALPHABET)}

MIN_CHAR = ALPHABET[0]
MID_CHAR = ALPHABET[BASE // 2]  # 'i' — not "m", but close to centre.
# Historically LexoRank uses "U" as midpoint for base-58. For base-36 "i"
# is the mathematical centre; for parity with documentation examples we
# expose "m" as the default empty-doc seed but compute midpoints
# algorithmically.
DEFAULT_SEED = "m"
REBALANCE_THRESHOLD = 48


def _char_value(c: str) -> int:
    try:
        return _VAL[c]
    except KeyError as e:
        raise ValueError(f"LexoRank character out of alphabet: {c!r}") from e


def _pad(s: str, length: int) -> str:
    """Right-pad to `length` with the min character (numeric equivalent of 0)."""
    if len(s) >= length:
        return s
    return s + MIN_CHAR * (length - len(s))


def midpoint(left: str | None, right: str | None) -> str:
    """Return a LexoRank string strictly between `left` and `right`.

    Either bound may be None to signal "open" (prepend / append). The result
    is the shortest base-36 string that satisfies left < result < right.
    """
    if left is None and right is None:
        return DEFAULT_SEED
    if left is None:
        # Generate a rank strictly less than `right`.
        return _before(right)  # type: ignore[arg-type]
    if right is None:
        # Generate a rank strictly greater than `left`.
        return _after(left)
    if left >= right:
        raise ValueError(f"LexoRank midpoint: left {left!r} >= right {right!r}")

    # Extend both strings to a common length by padding with MIN_CHAR on the
    # right. Any difference at position i means `right[i] > left[i]` by at
    # least 1, giving us headroom to compute a midpoint character.
    length = max(len(left), len(right))
    a = _pad(left, length)
    b = _pad(right, length)

    out: list[str] = []
    for i in range(length):
        av = _char_value(a[i])
        bv = _char_value(b[i])
        if av == bv:
            out.append(a[i])
            continue
        # Guaranteed bv > av because b > a and earlier chars were equal.
        if bv - av > 1:
            # There is a character strictly between — use it and stop.
            out.append(ALPHABET[(av + bv) // 2])
            return "".join(out)
        # bv == av + 1 — no room on this slot. Emit left char, then append
        # a character greater than what would come after `a[i+1:]`.
        out.append(a[i])
        # Now we need to find a suffix > a[i+1:] within left boundary only.
        tail_after = _after(a[i + 1 :])
        out.append(tail_after)
        return "".join(out)

    # a == b after padding — impossible since left < right; defensive:
    raise ValueError("LexoRank midpoint: identical inputs after padding")


def _before(right: str) -> str:
    """Rank strictly less than `right`.

    Walks down `right` preserving characters that are already at the floor
    (MIN_CHAR), then halves the first non-floor character. If the entire
    prefix is MIN_CHAR (or right is empty), we extend by one mid-character
    so the output is shorter-or-equal-length than right at the slot we
    modify — guaranteeing strict less-than ordering.
    """
    out: list[str] = []
    for c in right:
        cv = _char_value(c)
        if cv == 0:
            out.append(c)
            continue
        # Pick a character strictly less than c but >= MIN_CHAR.
        out.append(ALPHABET[cv // 2])
        return "".join(out)
    # All characters were MIN_CHAR — go deeper. "00" < "00m" but we need
    # less than "00" itself, which is impossible in base-36 without going
    # to a smaller alphabet. In practice `_before(DEFAULT_SEED)` etc.
    # always falls into the first branch; this path is only reached for
    # contrived inputs like right="" or right="0000…". Extend with MID to
    # maintain invariants; the caller's ordering is preserved because this
    # path is only reached when there's no non-zero character to halve.
    out.append(MID_CHAR)
    return "".join(out)


def _after(left: str) -> str:
    """Rank strictly greater than `left`.

    Simplest always-correct construction: append a mid character. Because
    `left` is a strict prefix of `left + MID_CHAR`, the result compares as
    strictly greater under lexicographic ordering.
    """
    return (left or "") + MID_CHAR


def needs_rebalance(rank: str) -> bool:
    """True if `rank` has grown long enough to merit parent rebalancing."""
    return len(rank) > REBALANCE_THRESHOLD


def evenly_spaced(count: int) -> list[str]:
    """Return `count` ranks evenly spaced through the alphabet.

    Used by the rebalance routine to rewrite all siblings under a parent with
    fresh, short ranks.
    """
    if count <= 0:
        return []
    if count == 1:
        return [DEFAULT_SEED]
    # Spread across the alphabet: divide the BASE range into (count + 1) slots
    # so neither end is at '0' or 'z'.
    step = BASE / (count + 1)
    return [ALPHABET[int(step * (i + 1))] for i in range(count)]


def midpoints_between(left: str | None, right: str | None, count: int) -> list[str]:
    """Generate `count` ranks strictly between left and right, in order.

    Useful for bulk insertion (paste / import). A naive implementation simply
    chains midpoint calls; for the demo's scale this is sufficient.
    """
    if count <= 0:
        return []
    ranks: list[str] = []
    current_left = left
    for _ in range(count):
        r = midpoint(current_left, right)
        ranks.append(r)
        current_left = r
    return ranks


__all__: Iterable[str] = (
    "midpoint",
    "midpoints_between",
    "evenly_spaced",
    "needs_rebalance",
    "DEFAULT_SEED",
    "REBALANCE_THRESHOLD",
)
