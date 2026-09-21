"""Step E 切片：Skill candidate → validate → active 完整生命周期。

最小验证预算：证据入场券与门禁拦截、真实文件系统的 promote→approve→
snapshot→rollback 全流程、连续失败自动降级。
"""
import os

from result import Result
from skill_lifecycle import (approve, create_candidate, promote, reject,
                             render_skill_md, rollback)
from skill_loader import SkillLoader
from storage import Storage


GOOD_FIELDS = dict(
    description="部署前检查清单：编译、测试、敏感信息扫描",
    when_to_use="用户要求部署或发布之前",
    steps=["运行测试套件", "检查环境变量无明文密钥", "确认回滚路径可用"],
    verification="测试全绿且回滚路径确认可用后才允许部署",
)


def make_storage(tmp_path):
    return Storage(db_dir=str(tmp_path / "db"))


def write_skill(root, name, body):
    d = os.path.join(str(root), name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write(body)
    return d


# ── 证据是入场券；门禁不过就留在 candidate ──────────────────────────────────

def test_creation_requires_success_evidence_and_gates_block(tmp_path):
    st = make_storage(tmp_path)
    try:
        # 无经验 / 失败经验：都孵不出候选
        r0 = create_candidate(st, {**GOOD_FIELDS, "experience_ref": "nope"})
        assert not r0.ok
        bad_exp = st.record_skill_experience(
            "deploy-check", outcome="failure", failure_class="timeout")
        r1 = create_candidate(st, {**GOOD_FIELDS, "experience_ref": bad_exp})
        assert not r1.ok, "失败经验不是学习来源"

        ok_exp = st.record_skill_experience(
            "deploy-check", outcome="success", steps_attempted=3, steps_succeeded=3)
        r2 = create_candidate(st, {**GOOD_FIELDS, "experience_ref": ok_exp})
        assert r2.ok and r2.value["status"] == "candidate"
        assert r2.value["experience_ref"] == ok_exp

        # 字段残缺：promote 必须被结构门拦下，且给出可读原因，状态原地不动
        weak = create_candidate(st, {
            "experience_ref": ok_exp, "name": "half-baked",
            "description": "只有一句话", "when_to_use": "", "steps": [], "verification": "",
        })
        assert weak.ok
        p = promote(st, weak.value["id"], loader=SkillLoader())
        assert not p.ok and "structural" in p.error
        assert st.get_skill_candidate(weak.value["id"])["status"] == "candidate"
        assert st.get_skill_candidate(weak.value["id"])["gate_report"]["structural"]["ok"] is False

        # 完整候选：门禁全绿进 staged。
        # 两条成功经验不是凑数：evidence_strength 门要求 §9.4 的三条证据至少
        # 一条（落地副作用 / 重复成功 / 确定性验证），单次成功不再够。
        st.record_skill_experience(
            "deploy-check", run_id="run-2", turn_id="turn-2",
            outcome="success", steps_attempted=3, steps_succeeded=3)
        full = create_candidate(st, {**GOOD_FIELDS, "experience_ref": ok_exp,
                                     "name": "deploy-checklist"})
        p2 = promote(st, full.value["id"], loader=SkillLoader())
        assert p2.ok, p2.error
        assert p2.value["status"] == "staged"
        assert all(g["ok"] for g in p2.value["gate_report"].values())
        # 这道门以前叫 source_replay 却什么都不重放；名字必须与行为一致
        assert p2.value["gate_report"]["source_evidence"]["isReExecution"] is False
    finally:
        st.close()


# ── 全流程：approve 真落盘 + 快照旧版 + rollback 复位 ───────────────────────

def test_approve_writes_file_snapshots_and_rolls_back(tmp_path):
    st = make_storage(tmp_path)
    root = tmp_path / "skills"
    old_body = "---\nname: deploy-check\ndescription: old\n---\nold body"
    skill_dir = write_skill(root, "deploy-check", old_body)
    loader = SkillLoader()
    assert loader.import_skill(str(skill_dir)).ok
    old_version = loader.get_skill("deploy-check").version

    try:
        exp = st.record_skill_experience("deploy-check", run_id="r1",
                                         turn_id="t1", outcome="success")
        # 第二次成功 = evidence_strength 的重复性代理（§9.4 三选一）
        st.record_skill_experience("deploy-check", run_id="r2",
                                   turn_id="t2", outcome="success")
        cand = create_candidate(st, {
            **GOOD_FIELDS, "experience_ref": exp, "name": "deploy-check",
            "superseded_skill": "deploy-check",
        })
        assert promote(st, cand.value["id"], loader=loader).ok

        ap = approve(st, loader, cand.value["id"], skills_root=str(root))
        assert ap.ok, ap.error
        assert ap.value["status"] == "active"
        assert ap.value["version"] and ap.value["version"] != old_version

        new_body = open(os.path.join(str(root), "deploy-check", "SKILL.md"),
                        encoding="utf-8").read()
        assert "## Verification" in new_body and "old body" not in new_body
        assert loader.get_skill("deploy-check").version == ap.value["version"]

        snap = ap.value["snapshot_path"]
        assert snap and os.path.isfile(snap) and old_body in open(snap, encoding="utf-8").read()

        rb = rollback(st, loader, cand.value["id"], skills_root=str(root))
        assert rb.ok and rb.value["status"] == "archived"
        restored = open(os.path.join(str(root), "deploy-check", "SKILL.md"),
                        encoding="utf-8").read()
        assert restored == old_body, "回滚后磁盘必须精确回到旧版"
        assert loader.get_skill("deploy-check").version == old_version
    finally:
        st.close()


# ── 连续失败自动降级：一次失败只记经验，三次才降 ────────────────────────────

def test_repeated_failures_degrade_active_candidate(tmp_path):
    st = make_storage(tmp_path)
    try:
        exp = st.record_skill_experience("deploy-check", outcome="success")
        cand = create_candidate(st, {**GOOD_FIELDS, "experience_ref": exp})
        st.set_skill_candidate_status(cand.value["id"], "active", version="abc")

        # 窗口 5：2 成功 + 3 连续失败 = 达到阈值
        st.record_skill_experience("deploy-check", outcome="success")
        for _ in range(3):
            st.record_skill_experience("deploy-check", outcome="failure",
                                       failure_class="timeout")
        assert st.get_skill_candidate(cand.value["id"])["status"] == "degraded", \
            "窗口内 3 次失败必须降级"

        # 单次失败不动 active
        cand2 = create_candidate(st, {**GOOD_FIELDS, "experience_ref": exp,
                                      "name": "other-skill"})
        st.set_skill_candidate_status(cand2.value["id"], "active", version="def")
        st.record_skill_experience("other-skill", outcome="failure",
                                   failure_class="network")
        assert st.get_skill_candidate(cand2.value["id"])["status"] == "active", \
            "一次失败只记经验，绝不降级"
    finally:
        st.close()


# ── 确定性验证门：批准时真跑命令，退出码非 0 不上线 ─────────────────────────

def test_verify_command_gates_activation(tmp_path):
    import sys
    st = make_storage(tmp_path)
    root = tmp_path / "skills"
    loader = SkillLoader()
    try:
        exp = st.record_skill_experience("v-check", outcome="success")

        # 通过：exit 0 → active，且执行证据落进门禁报告
        ok_cand = create_candidate(st, {
            **GOOD_FIELDS, "experience_ref": exp, "name": "v-ok",
            "verify_command": f"\"{sys.executable}\" -c \"print('v-ok')\"",
        })
        assert promote(st, ok_cand.value["id"], loader=loader).ok
        ap = approve(st, loader, ok_cand.value["id"], skills_root=str(root))
        assert ap.ok and ap.value["status"] == "active", ap.error
        ev = (ap.value.get("gate_report") or {}).get("verification_run") or {}
        assert ev.get("ran") and ev.get("returncode") == 0, "机器验证证据必须在案"
        assert os.path.isfile(os.path.join(str(root), "v-ok", "SKILL.md"))

        # 失败：exit 3 → 拒绝激活、保持 staged、全新稿撤稿不留半成品
        bad = create_candidate(st, {
            **GOOD_FIELDS, "experience_ref": exp, "name": "v-bad",
            "verify_command": f'"{sys.executable}" -c "raise SystemExit(3)"',
        })
        assert promote(st, bad.value["id"], loader=loader).ok
        ap2 = approve(st, loader, bad.value["id"], skills_root=str(root))
        assert not ap2.ok and "验证" in ap2.error
        assert st.get_skill_candidate(bad.value["id"])["status"] == "staged"
        assert not os.path.isdir(os.path.join(str(root), "v-bad")), \
            "验证失败的全新稿必须撤干净"
    finally:
        st.close()


# ── 门禁名副其实：单次成功不够、高熵密钥拦得住、没验证不许冒充验证过 ─────────

def test_single_success_without_verification_cannot_stage(tmp_path):
    """§9.4 的析取式必须真的成立：三条证据一条都没有就不许进 staged。

    这是"门禁虚"的核心：以前唯一的实际判据是"账本里有一条成功记录"，
    于是"跑对过一次、没有落地痕迹、没有验证命令"也能全绿。
    """
    st = make_storage(tmp_path)
    try:
        exp = st.record_skill_experience("once-only", run_id="r1", turn_id="t1",
                                         outcome="success")
        cand = create_candidate(st, {**GOOD_FIELDS, "experience_ref": exp,
                                     "name": "once-only"})
        p = promote(st, cand.value["id"], loader=SkillLoader())
        assert not p.ok and "evidence_strength" in p.error, p.error
        row = st.get_skill_candidate(cand.value["id"])
        assert row["status"] == "candidate"
        assert row["gate_report"]["evidence_strength"]["ok"] is False
        # 来源那道门仍然是绿的——它检查的只是"账本里有这条成功经验"
        assert row["gate_report"]["source_evidence"]["ok"] is True

        # 补一条确定性验证命令即可放行（三选一里的第三条）
        with_verify = create_candidate(st, {
            **GOOD_FIELDS, "experience_ref": exp, "name": "once-only-verified",
            "verify_command": "python -c \"pass\"",
        })
        p2 = promote(st, with_verify.value["id"], loader=SkillLoader())
        assert p2.ok, p2.error
    finally:
        st.close()


def test_high_entropy_secret_blocks_the_scan_gate(tmp_path):
    """没有厂商前缀的随机密钥必须被拦下——正则认不出的那一半才是常见泄露。"""
    st = make_storage(tmp_path)
    try:
        exp = st.record_skill_experience("leaky", run_id="r1", turn_id="t1",
                                         outcome="success")
        st.record_skill_experience("leaky", run_id="r2", turn_id="t2",
                                   outcome="success")
        cand = create_candidate(st, {
            **GOOD_FIELDS, "experience_ref": exp, "name": "leaky",
            "steps": ["调用内部接口，token 用 aB3xK9mQ7pL2wE5rT8yU1iO4"],
        })
        p = promote(st, cand.value["id"], loader=SkillLoader())
        assert not p.ok and "secret_scan" in p.error, p.error
        detail = st.get_skill_candidate(
            cand.value["id"])["gate_report"]["secret_scan"]["detail"]
        assert "SECRET_HIGH_ENTROPY" in detail, detail
    finally:
        st.close()


def test_activation_without_verify_command_records_that_fact(tmp_path):
    """没有机器验证时，记录里必须明写"没有"，不能是一片空白让人往好处猜。"""
    st = make_storage(tmp_path)
    root = tmp_path / "skills"
    loader = SkillLoader()
    try:
        exp = st.record_skill_experience("manual-only", run_id="r1",
                                         turn_id="t1", outcome="success")
        st.record_skill_experience("manual-only", run_id="r2", turn_id="t2",
                                   outcome="success")
        cand = create_candidate(st, {**GOOD_FIELDS, "experience_ref": exp,
                                     "name": "manual-only"})
        assert promote(st, cand.value["id"], loader=loader).ok
        ap = approve(st, loader, cand.value["id"], skills_root=str(root))
        assert ap.ok, ap.error
        ev = (ap.value.get("gate_report") or {}).get("verification_run") or {}
        assert ev.get("ran") is False
        assert ev.get("machineVerified") is False
        assert "没有机器验证" in str(ev.get("detail") or "")
    finally:
        st.close()
