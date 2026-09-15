"""P0-4 切片：记忆层抽取的项目上下文必须走审批，不得直写 AGENTS.md。

为什么值得单独一个切片：AGENTS.md 每轮都注入模型，写进去的不是笔记而是常驻
指令；而抽取内容来自"用户刚编辑的那个文件"。旧路径是裸 open(...,"w")、默认
开启、无审批、无痕迹——等于"编辑一个含有敌意文本的文件"就能永久改写系统提示。
所以这里断言的不是功能，是一条安全不变量：这条路径**永远不写盘**。

沿用其它切片的裸对象绑定法：MemoryLayer 的构造函数会拉起嵌入模型和整个存储
世界，而被测的三个方法只用到 _root_dir 和 storage 两个协作者。
"""
import evolution
from memory_layer import Memory, MemoryLayer
from storage import Storage


class _BareLayer(MemoryLayer):
    """只绑被测方法真正依赖的两个协作者。"""

    def __init__(self, root, storage):  # noqa: D107 - 刻意不调 super
        self._root_dir = str(root)
        self.storage = storage


def _mems():
    return [
        Memory(content="项目用 pnpm 而不是 npm", mem_type="fact"),
        Memory(content="用户偏好中文回复", mem_type="preference"),
    ]


def test_extraction_never_writes_agents_md_and_queues_for_approval(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    agents = ws / "AGENTS.md"
    agents.write_text("# 项目约定\n\n人写的内容不许动。\n", encoding="utf-8")
    before = agents.read_text(encoding="utf-8")

    engine = evolution.reset_for_tests(
        db_path=str(tmp_path / "evo.db"), mode=evolution.MODE_ACTIVE,
        workspace_root=str(ws),
    )
    st = Storage(db_dir=str(tmp_path / "db"))
    try:
        _BareLayer(ws, st)._update_agents_md(_mems())

        assert agents.read_text(encoding="utf-8") == before, \
            "抽取路径一个字节都不许写进 AGENTS.md"

        pending = engine.store.open_proposals()
        assert len(pending) == 2, [p.draft for p in pending]
        assert all(p.target_file == "AGENTS.md" for p in pending)
        assert all(p.status == "pending" and p.applied == 0 for p in pending)
        assert any("pnpm" in p.draft for p in pending)

        # 同一批再抽一次不得重复立项（签名去重）
        _BareLayer(ws, st)._update_agents_md(_mems())
        assert engine.store.count_open() == 2
    finally:
        st.close()
        engine.store.close()


def test_evolution_off_means_no_write_and_no_queue(tmp_path):
    """off 档不是"退回直写"，是"什么都不发生"——并且日志说清楚了。"""
    ws = tmp_path / "ws"
    ws.mkdir()
    agents = ws / "AGENTS.md"
    agents.write_text("# 项目约定\n", encoding="utf-8")

    engine = evolution.reset_for_tests(
        db_path=str(tmp_path / "evo.db"), mode=evolution.MODE_OFF,
        workspace_root=str(ws),
    )
    st = Storage(db_dir=str(tmp_path / "db"))
    try:
        _BareLayer(ws, st)._update_agents_md(_mems())
        assert agents.read_text(encoding="utf-8") == "# 项目约定\n"
        assert engine.store.count_open() == 0
        # 记忆本体仍然进了索引：关掉的是写引导文件，不是记忆功能
        row = st._db("memory").execute(
            "SELECT index_content FROM project_memory_index WHERE root_dir=?",
            (str(ws),),
        ).fetchone()
        assert row is not None and "pnpm" in row["index_content"]

    finally:
        st.close()
        engine.store.close()


def test_lines_already_on_disk_are_not_proposed_again(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "AGENTS.md").write_text(
        "## Project Context\n- [fact] 项目用 pnpm 而不是 npm\n", encoding="utf-8",
    )
    engine = evolution.reset_for_tests(
        db_path=str(tmp_path / "evo.db"), mode=evolution.MODE_ACTIVE,
        workspace_root=str(ws),
    )
    st = Storage(db_dir=str(tmp_path / "db"))
    try:
        _BareLayer(ws, st)._update_agents_md(_mems())
        drafts = [p.draft for p in engine.store.open_proposals()]
        assert len(drafts) == 1, drafts
        assert "中文回复" in drafts[0], "盘上已有的行不该再问一遍"
    finally:
        st.close()
        engine.store.close()
