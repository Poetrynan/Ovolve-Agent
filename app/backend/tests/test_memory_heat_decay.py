# -*- coding: utf-8 -*-
import math
import time

import pytest
from memory_domain import MemoryItem, compute_time_decay_score


def test_heat_refresh_mitigates_decay():
    now = 1726480000  # fixed timestamp
    halflife = 30.0

    # Item 1: Created 60 days ago, never recalled since
    created_old = now - int(60 * 86400)
    item_untouched = MemoryItem(
        kind="entry",
        id="mem-old-untouched",
        root="/test",
        content="Old untouched fact",
        status="active",
        confidence=1.0,
        importance=1.0,
        created_at=created_old,
        last_accessed_at=created_old,
        hits=0,
    )
    score_untouched = compute_time_decay_score(item_untouched, halflife_days=halflife, now=now)

    # Item 2: Created 60 days ago, but recalled/refreshed 1 day ago, with 5 hits
    last_accessed_recent = now - int(1 * 86400)
    item_frequently_used = MemoryItem(
        kind="entry",
        id="mem-old-hot",
        root="/test",
        content="Old hot frequently recalled fact",
        status="active",
        confidence=1.0,
        importance=1.0,
        created_at=created_old,
        last_accessed_at=last_accessed_recent,
        hits=5,
    )
    score_hot = compute_time_decay_score(item_frequently_used, halflife_days=halflife, now=now)

    # Recalled item must have significantly higher score than untouched item
    assert score_hot > score_untouched
    # Verify the untouched item decayed to approximately 25% (2 half-lives)
    assert score_untouched == pytest.approx(0.25, abs=0.05)
    # Verify the hot item retains over 75% score
    assert score_hot > 0.75


def test_citation_bonus_scaling():
    now = 1726480000
    created = now - int(10 * 86400)

    # Identical creation and access age, but different hit counts
    item_0_hits = MemoryItem(
        kind="entry", id="m0", root="/test", content="fact", status="active",
        confidence=0.8, importance=0.8, created_at=created, last_accessed_at=created, hits=0
    )
    item_10_hits = MemoryItem(
        kind="entry", id="m10", root="/test", content="fact", status="active",
        confidence=0.8, importance=0.8, created_at=created, last_accessed_at=created, hits=10
    )

    s0 = compute_time_decay_score(item_0_hits, now=now)
    s10 = compute_time_decay_score(item_10_hits, now=now)

    assert s10 > s0


def test_decay_weight_in_memory_layer():
    from memory_layer import MemoryLayer
    layer = MemoryLayer()
    now = time.time()

    row_old = {
        "created_at": now - 60 * 86400,
        "accessed_at": now - 60 * 86400,
        "hits": 0,
    }
    row_hot = {
        "created_at": now - 60 * 86400,
        "accessed_at": now - 1 * 86400,
        "hits": 8,
    }

    w_old = layer._decay_weight(row_old)
    w_hot = layer._decay_weight(row_hot)

    assert w_hot > w_old
