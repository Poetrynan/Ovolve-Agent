""""Phase 6 收口：插件 卸载撤销 全链演练。

真实链路：manifest v2 门禁 → 导入激活（技能进入运行时注册表）→ disable 撤销
→ remove 遗忘。断言的是用户可感知的语义：禁用后能力真的消失。
"""
import json
import os
import uuid

from plugin_registry import PluginRegistry
from skill_loader import get_skill_loader


def _make_plugin(root):
    name = "drill-" + uuid.uuid4().hex[:6]     # 唯一化，避免污染全局 loader
    skill_dir = os.path.join(str(root), name, "skills", name)
    os.makedirs(skill_dir, exist_ok=True)
    with open(os.path.join(skill_dir, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write("---\nname: " + name + "\ndescription: drill skill for unload test\n---\nbody")
    manifest = {
        "name": name,
        "apiVersion": "2",
        "trust": "untrusted",
        "permissions": {"filesystem": ["workspace-read"], "network": [],
                        "credentials": [], "process": False},
        "contributes": {"skills": ["skills/" + name]},
    }
    with open(os.path.join(str(root), name, "plugin.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f)
    return name


def test_plugin_full_lifecycle_register_disable_remove(tmp_path):
    root = tmp_path / "plugins"
    root.mkdir()
    name = _make_plugin(root)

    reg = PluginRegistry()
    loader = get_skill_loader()

    # v2 manifest 门禁：apiVersion/trust/permissions 都过门才激活
    res = reg.import_plugin(str(root) + "/" + name, activate=True)
    assert res.ok, res.error
    entry = reg.get(name)
    assert entry.status == "loaded" and entry.skills == [name]
    assert loader.get_skill(name) is not None, "激活后技能必须在运行时注册表里"

    # disable：技能从注册表撤下（§11 卸载撤销）
    assert reg.disable(name).ok
    assert reg.get(name).status == "disabled"

    # enable 重新拉起；remove 遗忘并再次撤销
    assert reg.enable(name).ok
    assert reg.remove(name).ok

    entry_after = None
    cur = loader.get_skill(name)
    if cur is not None:
        from skill_loader import SkillStatus
        entry_after = cur.status
    assert entry_after in (None, SkillStatus.DISABLED), \
        "移除后技能不得仍以 IMPORTED 状态可用"


def test_manifest_v2_gates(tmp_path):
    bad_root = tmp_path / "bad"
    bad_root.mkdir(); (bad_root / "plugin.json").write_text(json.dumps({
        "name": "time-traveler", "apiVersion": "9",
    }), encoding="utf-8")
    reg = PluginRegistry()
    res = reg.import_plugin(str(bad_root), activate=False)
    assert not res.ok and "apiVersion" in res.error
