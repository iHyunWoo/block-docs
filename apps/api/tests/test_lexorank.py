"""Unit tests for LexoRank midpoint / rebalance helpers.

These are pure-Python — no DB, no Redis. Safe to run anywhere.
"""

from __future__ import annotations

import pytest

from app.lexorank import (
    DEFAULT_SEED,
    REBALANCE_THRESHOLD,
    evenly_spaced,
    midpoint,
    midpoints_between,
    needs_rebalance,
)


def test_empty_document_returns_seed():
    assert midpoint(None, None) == DEFAULT_SEED


def test_prepend_before_first():
    # Must be strictly less than the right bound.
    r = midpoint(None, "m")
    assert r < "m"


def test_append_after_last():
    r = midpoint("m", None)
    assert r > "m"


def test_between_simple():
    r = midpoint("a", "z")
    assert "a" < r < "z"


def test_between_adjacent_adds_a_character():
    r = midpoint("a", "b")
    # No single-char rank strictly between 'a' and 'b' exists, so the
    # midpoint should extend by at least one character.
    assert len(r) > 1
    assert "a" < r < "b"


def test_midpoint_is_deterministic_and_idempotent():
    # Same inputs always produce the same output.
    assert midpoint("abc", "abz") == midpoint("abc", "abz")
    assert midpoint(None, "m") == midpoint(None, "m")


def test_bulk_between_is_sorted():
    ranks = midpoints_between("a", "z", 20)
    assert ranks == sorted(ranks)
    assert all("a" < r < "z" for r in ranks)
    assert len(set(ranks)) == 20  # all distinct


def test_bulk_between_with_none_right():
    ranks = midpoints_between("a", None, 5)
    assert ranks == sorted(ranks)
    assert all(r > "a" for r in ranks)
    assert len(set(ranks)) == 5


def test_invalid_order_raises():
    with pytest.raises(ValueError):
        midpoint("z", "a")


def test_equal_inputs_raise():
    with pytest.raises(ValueError):
        midpoint("abc", "abc")


def test_evenly_spaced_returns_n_ranks_in_order():
    ranks = evenly_spaced(5)
    assert len(ranks) == 5
    assert ranks == sorted(ranks)
    assert len(set(ranks)) == 5


def test_evenly_spaced_single():
    assert evenly_spaced(1) == [DEFAULT_SEED]


def test_needs_rebalance_triggers_on_long_chain():
    # Simulate the worst case: repeatedly inserting between two adjacent
    # ranks. Each iteration forces a new midpoint, and because the gap
    # keeps shrinking, the resulting rank grows. Run enough iterations to
    # exceed REBALANCE_THRESHOLD.
    left = "a"
    r = midpoint(left, "b")
    # base-36 halving shrinks gap ~5x per character; we need enough
    # iterations to push above REBALANCE_THRESHOLD chars.
    for _ in range(REBALANCE_THRESHOLD * 6):
        r = midpoint(left, r)
    assert needs_rebalance(r), f"expected rebalance trigger, got {len(r)}-char rank {r!r}"


def test_needs_rebalance_false_for_short():
    assert not needs_rebalance("abc")
    assert not needs_rebalance(DEFAULT_SEED)
