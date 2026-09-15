"""Memory list API: type filter and dream tier."""
from memory_layer import Memory, MemoryLayer, MemoryType, MemoryTier
from memory_tiers import normalize_tier
from storage import get_storage


def test_list_entries_filters_by_mem_type():
    storage = get_storage()
    layer = MemoryLayer()
    root = "/tmp/test-mem-type-filter"

    for i, mtype in enumerate(("fact", "dream", "preference")):
        mem = Memory(
            content=f"entry-{i}-{mtype}",
            mem_type=mtype,
            root_dir=root,
            tier=MemoryTier.DREAMING.value if mtype == "dream" else MemoryTier.SEMANTIC.value,
        )
        layer.store(mem)

    dreams = layer.list_entries(root=root, mem_type="dream", limit=50)
    assert len(dreams) == 1
    assert dreams[0]["type"] == "dream"
    assert dreams[0]["tier"] == MemoryTier.DREAMING.value

    assert layer.count_entries(root=root, mem_type="dream") == 1
    assert layer.count_entries(root=root, mem_type="fact") == 1


def test_dream_store_uses_dreaming_tier():
    layer = MemoryLayer()
    root = "/tmp/test-dream-tier"
    mem = Memory(
        content="consolidated insight",
        mem_type=MemoryType.DREAM,
        root_dir=root,
        tier=MemoryTier.DREAMING.value,
    )
    layer.store(mem)
    row = layer.list_entries(root=root, mem_type="dream", limit=10)[0]
    assert normalize_tier(row["tier"]).value == MemoryTier.DREAMING.value
