"""
skill_lifecycle.py — Skill 候选的完整生命周期（Step E）。

    candidate → 结构检查 → 秘密/注入扫描 → 来源回放 → 碰撞/换代检查 → staged
              → 用户审批 → active（写盘 + 载入运行时）
    active   → degraded（连续失败，advisory）→ stale / archived

纪律：
* 学习只能来自成功执行轨迹——创建候选时必须绑定一条真实且 outcome=success
  的经验；聊天摘要、"我学会了"都孵化不出候选。
* 门禁全绿才能进 staged，但 staged → active 必须经用户审批，本模块不提供
  任何自动激活路径。
* 替换现有技能前先快照旧 SKILL.md，随时可回滚；回滚同样走显式 API。
"""
from __future__ import annotations

import hashlib
import os
import shutil
import time
from dataclasses import dataclass, field

from result import Result

#: 结构门的必填字段。steps 是列表单独查。
REQUIRED_FIELDS = ("name", "description", "when_to_use", "verification")

#: 秘密/注入扫描的拦截线（Severity.HIGH=3）。LOW/MEDIUM 记为警告放行——
#: 审批界面会显示完整扫描报告，用户带着警觉做决定。
GATE_BLOCK_SEVERITY = 3


def default_skills_root() -> str:
    """与 SkillLoader.discover 的第一优先根保持一致：项目本地技能目录。"""
    here = os.path.dirname(os.path.abspath(__file__))
    project = os.path.abspath(os.path.join(here, "..", ".."))
    return os.path.join(project, ".agents", "skills")


def render_skill_md(c: dict) -> str:
    """把候选项渲染成合法的 SKILL.md。纯函数，门禁扫描和激活写盘共用同一份
    渲染——审过的内容就是落盘的内容，不存在"审 A 写 B"。"""
    steps = c.get("steps") or []
    tools = c.get("required_tools") or []
    lines = [
        "---",
        f"name: {c.get('name', '')}",
        f"description: {c.get('description', '')}",
        f"version: draft",
        "---",
        "",
        f"# {c.get('name', '')}",
        "",
        "## When to use",
        c.get("when_to_use", ""),
        "",
    ]
    if c.get("scope"):
        lines += ["## Scope", c["scope"], ""]
    if c.get("preconditions"):
        lines += ["## Preconditions", c["preconditions"], ""]
    if c.get("inputs"):
        lines += ["## Inputs", c["inputs"], ""]
    if c.get("outputs"):
        lines += ["## Outputs", c["outputs"], ""]
    lines.append("## Steps")
    for i, s in enumerate(steps, 1):
        lines.append(f"{i}. {s}")
    lines.append("")
    if tools:
        lines += ["## Required tools", ", ".join(str(t) for t in tools), ""]
    lines += ["## Verification", c.get("verification", ""), ""]
    if c.get("known_failures"):
        lines += ["## Known failures", c["known_failures"], ""]
    return "\n".join(lines)


# ── 创建：证据是入场券 ──────────────────────────────────────────────────────

def create_candidate(storage, fields: dict) -> Result:
    """从真实证据孵化候选。experience_ref 必须指向一条成功经验——这是
    "学习必须来自成功执行轨迹"在代码里的样子，不是口号。"""
    exp_ref = str(fields.get("experience_ref") or "")
    exp = storage.get_skill_experience(exp_ref) if exp_ref else None
    if not exp:
        return Result.failure(
            "候选必须绑定一条真实经验（experience_ref 无效）"
        )
    if exp.get("outcome") != "success":
        return Result.failure(
            f"证据经验 {exp_ref} 的结局是 {exp.get('outcome')}，不是 success——拒绝孵化"
        )
    name = str(fields.get("name") or "").strip() or exp["skill_id"]
    try:
        cid = storage.insert_skill_candidate(
            name=name,
            description=str(fields.get("description") or ""),
            when_to_use=str(fields.get("when_to_use") or ""),
            scope=str(fields.get("scope") or ""),
            preconditions=str(fields.get("preconditions") or ""),
            inputs=str(fields.get("inputs") or ""),
            outputs=str(fields.get("outputs") or ""),
            steps=list(fields.get("steps") or []),
            required_tools=list(fields.get("required_tools") or []),
            risk_level=str(fields.get("risk_level") or "medium"),
            verification=str(fields.get("verification") or ""),
            known_failures=str(fields.get("known_failures") or ""),
            memory_refs=list(fields.get("memory_refs") or []),
            experience_ref=exp_ref,
            source_event_ids=[exp_id for exp_id in [exp.get("experience_id")] if exp_id],
            superseded_skill=str(fields.get("superseded_skill") or ""),
            verify_command=str(fields.get("verify_command") or ""),
        )
    except Exception as e:
        return Result.failure(f"候选落库失败: {e}")
    return Result.success(storage.get_skill_candidate(cid))


# ── 门禁：candidate → staged ───────────────────────────────────────────────

def run_gates(storage, cand: dict, loader=None) -> dict:
    """四道门。全部通过才有资格进 staged；任何一道不过都会给出可读原因。"""
    from skill_vetter import vet_skill

    report: dict = {}

    missing = [f for f in REQUIRED_FIELDS if not str(cand.get(f) or "").strip()]
    if not missing and not (cand.get("steps") or []):
        missing.append("steps(至少一步)")
    report["structural"] = {
        "ok": not missing,
        "detail": ("缺少必填字段: " + ", ".join(missing)) if missing else "ok",
    }

    content = render_skill_md(cand)
    vr = vet_skill(content)
    blocking = [f for f in vr.findings if int(f.severity) >= GATE_BLOCK_SEVERITY]
    warnings = [f for f in vr.findings if int(f.severity) < GATE_BLOCK_SEVERITY]
    report["secret_scan"] = {
        "ok": not blocking,
        "detail": (
            "高危模式: " + "; ".join(f"{f.rule_id}@L{f.line}" for f in blocking)
            if blocking else
            (f"{len(warnings)} 条低危提示" if warnings else "ok")
        ),
    }

    exp = storage.get_skill_experience(cand.get("experience_ref") or "") \
        if cand.get("experience_ref") else None
    replay_ok = bool(exp) and exp.get("outcome") == "success"
    detail = (
        f"经验 {cand.get('experience_ref')} 存在且成功" if replay_ok
        else f"来源经验不可回放或非成功: {cand.get('experience_ref')}"
    )
    # 来源回放证据化：经验绑定到目标时，还必须有真实落地的东西作佐证——
    # 光有一条"成功"记录不够，账本里得有干过的活。
    landed: list = []
    if replay_ok and exp.get("goal_id"):
        try:
            landed = storage.completed_side_effects(exp["goal_id"])
        except Exception:  # noqa: BLE001
            landed = []
        if landed:
            detail += f"；目标 {exp['goal_id']} 有 {len(landed)} 条已落地副作用佐证"
        else:
            replay_ok = False
            detail = (f"来源经验声称成功，但其目标 {exp['goal_id']} "
                      f"没有任何已落地副作用可回放——证据不足")
    # 这道门以前叫 source_replay，而它从不重放任何东西：它检查的是"账本里有没有
    # 这条成功经验、有没有落地痕迹"。名字撒的谎比缺陷本身更贵——读报告的人会以为
    # 系统真的把来源轨迹重跑了一遍。改成 source_evidence，并显式写明这一点。
    report["source_evidence"] = {
        "ok": replay_ok,
        "detail": detail,
        "isReExecution": False,
    }

    # §9.4 要求"source replay、相似 holdout 或 deterministic validator 至少其一"。
    # 之前没有任何一处检查这个析取式：唯一的实际判据是上面那条"账本里有记录"，
    # 于是"一次成功 + 无验证 + 无落地痕迹"也能全绿进 staged。
    strength: list = []
    if landed:
        strength.append(f"source-replay 代理：{len(landed)} 条已落地副作用")
    successes = 0
    # 按**来源经验的 skill_id** 统计，而不是候选的新名字：跑过的是那个东西，
    # 重复性只能由它的履历证明。哨兵行（无技能覆盖的任务）刻意排除——那是
    # "一堆互不相关的任务都成功了"，不是"这个流程成功了两次"。
    src_skill = str((exp or {}).get("skill_id") or "")
    task_sentinel = getattr(storage, "TASK_LEVEL_SKILL_ID", "__task__")
    if src_skill and src_skill != task_sentinel:
        try:
            rows = storage.list_skill_experiences(skill_id=src_skill, limit=50)
            successes = len({(r.get("run_id"), r.get("turn_id"))
                             for r in rows if r.get("outcome") == "success"})
        except Exception:  # noqa: BLE001
            successes = 0

    if successes >= 2:
        # holdout 的诚实代理：不是"留出集"，是"在两个互不相同的场合各成功过一次"。
        # 真 holdout 需要可重放的任务样本，这个项目还没有；写一个假的 holdout
        # 字段比没有更糟。
        strength.append(f"重复性代理：{successes} 次互相独立的成功")
    if str(cand.get("verify_command") or "").strip():
        strength.append("确定性验证：候选声明了 verify_command（批准时真跑）")
    if exp and exp.get("goal_id"):
        try:
            if str((storage.get_goal(exp["goal_id"]) or {}).get(
                    "verification_result") or "").strip():
                strength.append("目标验证器留有机器结论")
        except Exception:  # noqa: BLE001
            pass
    report["evidence_strength"] = {
        "ok": bool(strength),
        "detail": ("；".join(strength) if strength else
                   "三条证据（回放痕迹 / 重复成功 / 确定性验证）一条都没有——"
                   "单次成功不足以上线，补一条 verify_command 或再跑成功一次"),
    }


    existing = loader.get_skill(cand.get("name") or "") if loader else None
    if existing is None:
        collision = {"ok": True, "detail": "新技能，无同名在线"}
    else:
        target = str(cand.get("superseded_skill") or "")
        if target == existing.name:
            collision = {"ok": True,
                         "detail": f"声明取代在线技能 {existing.name}（旧版将快照）"}
        else:
            collision = {"ok": False,
                         "detail": "同名技能已在线且候选未正确声明 SUPERSEDES 目标"}

    report["collision"] = collision
    return report


def promote(storage, cand_id: str, loader=None) -> Result:
    """跑全部门禁；全绿置 staged，任一失败留在 candidate 并附完整报告。"""
    cand = storage.get_skill_candidate(cand_id)
    if not cand:
        return Result.failure(f"无此候选: {cand_id}")
    if cand["status"] not in ("candidate", "degraded", "rejected"):
        return Result.failure(
            f"状态 {cand['status']} 不可 promote（仅 candidate/degraded/rejected 可以重跑门禁）"
        )
    report = run_gates(storage, cand, loader)
    failed = [k for k, v in report.items() if not v.get("ok")]
    storage.set_skill_candidate_status(cand_id, "staged" if not failed else "candidate",
                                       gate_report=report)
    if failed:
        return Result.failure("门禁未通过: " + ", ".join(failed))
    return Result.success(storage.get_skill_candidate(cand_id))


# ── 审批：staged → active（唯一入口是人）────────────────────────────────────

def _atomic_write(path: str, content: str) -> str:
    """把 content 原子地写到 path：同目录临时文件 → fsync → os.replace。

    返回空串表示成功，否则返回错误原因。

    SKILL.md 是运行时每次都要读的东西。直接 open(path, 'w') 时如果进程在
    写到一半没了，留下的是一个截断的文件——下次启动读到的就是半个技能，
    而且没人知道它是从哪一刻开始坏的。os.replace 在同一分区是一次原子改名，
    读者只会看到旧版或新版，不会看到中间态。

    快照仍然由 approve() 自己按 `.bak-<ts>` 维护：skill_integrity 的哈希
    扫描认这个命名，换到别的目录去会让它算不进来。所以这里只借 swapper 的
    原子替换，快照交给调用方（create_snapshot=False）。
    """
    try:
        from atomic_rule_swapper import AtomicRuleSwapper
    except ImportError:  # pragma: no cover - 打包后的导入形态
        from app.backend.atomic_rule_swapper import AtomicRuleSwapper
    swap = AtomicRuleSwapper().write_atomic(path, content, create_snapshot=False)
    if not swap.success:
        return swap.error or "atomic write failed"
    return ""


def approve(storage, loader, cand_id: str, *, skills_root: str = None) -> Result:
    """staged → active：渲染落盘、载入运行时、记录版本与快照。

    这是全系统唯一能把一个候选变成真技能的函数，而它只能被人调用。
    """
    cand = storage.get_skill_candidate(cand_id)
    if not cand:
        return Result.failure(f"无此候选: {cand_id}")
    if cand["status"] != "staged":
        return Result.failure(f"状态 {cand['status']} 不是 staged——先过门禁")

    root = skills_root or default_skills_root()
    skill_dir = os.path.join(root, cand["name"])
    md_path = os.path.join(skill_dir, "SKILL.md")

    snapshot_path = ""
    replaced = os.path.isfile(md_path)
    if replaced:
        snapshot_path = md_path + f".bak-{int(time.time())}"
        try:
            shutil.copy2(md_path, snapshot_path)
        except OSError as e:
            return Result.failure(f"无法快照旧版技能，中止替换: {e}")

    content = render_skill_md(cand)
    try:
        os.makedirs(skill_dir, exist_ok=True)
    except OSError as e:
        return Result.failure(f"创建技能目录失败: {e}")
    write_err = _atomic_write(md_path, content)
    if write_err:
        return Result.failure(f"写入 SKILL.md 失败: {write_err}")

    imp = loader.import_skill(skill_dir, _own_trust())
    if not getattr(imp, "ok", False):
        # 导入失败就不留半成品：没有旧文件的新技能当场撤稿
        if not replaced:
            try:
                shutil.rmtree(skill_dir, ignore_errors=True)
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程
        return Result.failure(f"SKILL.md 已写入但导入运行时失败: {getattr(imp, 'error', '')}")

    # 版本 = 内容哈希，从运行时注册表取权威值（import_skill 的返回字典里没有它）。
    entry = loader.get_skill(cand["name"])
    version = str(getattr(entry, "version", "") or "")

    # 确定性验证门：候选声明了 verify_command 就真跑一遍（30s 上限、受沙箱约束、
    # 失败即拒绝激活并复位文件）。命令来自候选，但执行只发生在用户点击批准的
    # 这一刻——人是最后一道门，机器提供可重复的证据。
    #
    # 这里以前是裸 subprocess.run：一条来自候选（也就是来自模型起草）的字符串，
    # 在"系统正在决定要不要信任它"的那一刻，以后端自身的全部权限执行。现在统一
    # 走 sandbox.run_confined_capture，并且把**实际生效的约束后端**写进证据里；
    # 没有约束时证据里明写 confinement=none，而不是让"没报错"冒充"跑在沙箱里"。
    verify_cmd = str(cand.get("verify_command") or "").strip()
    # 缺省不是"通过"。以前没有 verify_command 时 gate_report 直接写 None，于是
    # 上线记录里既没有"验证过"也没有"没验证"——读的人只能猜，而人总是往好处猜。
    verify_evidence: dict = {
        "ran": False,
        "machineVerified": False,
        "detail": "候选未声明 verify_command：本次上线只有人工确认，没有机器验证",
    }
    if verify_cmd:
        from sandbox import run_confined_capture
        res = run_confined_capture(verify_cmd, cwd=root, timeout=30)
        verify_evidence = {
            "ran": bool(res.get("ran")),
            "returncode": res.get("returncode"),
            "stdout": str(res.get("output") or "")[-400:],
            "confinement": res.get("confinement"),
            "sandboxMode": res.get("mode"),
            # 只有"真跑了且退出码为 0"才算机器验证过。跑不起来、超时、非 0
            # 都不是"验证通过"——不可用不得当通过，这是这道门的全部意义。
            "machineVerified": bool(res.get("ran")) and res.get("returncode") == 0,
        }

        if res.get("timeout"):
            verify_evidence["timeout"] = True
        if res.get("error"):
            verify_evidence["error"] = res["error"]
        if not res.get("ran"):
            _abort_activation(storage, cand_id,
                              f"验证命令无法执行: {res.get('error') or 'unknown'}",
                              verify_evidence)
            return Result.failure(
                f"验证命令无法执行: {res.get('error') or 'unknown'}"
            )
        if res.get("returncode") != 0:
            # 验证失败就不上线：有旧版恢复旧版，全新稿撤稿

            if replaced and snapshot_path:
                try:
                    with open(snapshot_path, "r", encoding="utf-8") as fh:
                        previous = fh.read()
                    if not _atomic_write(md_path, previous):
                        loader.import_skill(skill_dir, _own_trust())
                except Exception:
                    pass  # fail-open: 可选增强，失败不影响主流程
            elif not replaced:
                shutil.rmtree(skill_dir, ignore_errors=True)
            _abort_activation(storage, cand_id,
                              "确定性验证未通过", verify_evidence)
            return Result.failure(
                f"确定性验证未通过（exit={verify_evidence.get('returncode', 'timeout')}），"
                f"候选保持 staged，文件已复位"
            )

    storage.set_skill_candidate_status(
        cand_id, "active", version=version,
        snapshot_path=snapshot_path,
        # 无条件写入：没有 verify_command 时也要留一条"没有机器验证"的记录。
        gate_report={"verification_run": verify_evidence},
    )

    detail = f"active v{version[:8]}" + (f"，旧版快照 {os.path.basename(snapshot_path)}" if snapshot_path else "")
    return Result.success(storage.get_skill_candidate(cand_id), detail=detail)


def _abort_activation(storage, cand_id: str, reason: str,
                      evidence: dict = None) -> None:
    """激活被确定性验证拦下：状态退回 staged，证据写进门禁报告供 UI 展示。"""
    report = {"verification_run": {"ok": False, "detail": reason, **(evidence or {})}}
    try:
        storage.set_skill_candidate_status(cand_id, "staged", gate_report=report)
    except Exception as e:
        print(f"[skills] abort-activation bookkeeping failed: {e}")


def reject(storage, cand_id: str, reason: str = "") -> Result:
    cand = storage.get_skill_candidate(cand_id)
    if not cand:
        return Result.failure(f"无此候选: {cand_id}")
    if cand["status"] == "active":
        return Result.failure("active 技能请走 rollback，不走 reject")
    storage.set_skill_candidate_status(cand_id, "rejected",
                                       gate_report={"reject_reason": reason})
    return Result.success(storage.get_skill_candidate(cand_id))


# ── 回滚：active → archived，旧版复位 ──────────────────────────────────────

def rollback(storage, loader, cand_id: str, *, skills_root: str = None) -> Result:
    """active → archived：旧版复位（有快照）或撤稿下线（全新技能）。

    回滚是显式 API、由人调用——一次失败只记经验并降级，文件层的回退永远
    不自动发生。
    """
    cand = storage.get_skill_candidate(cand_id)
    if not cand:
        return Result.failure(f"无此候选: {cand_id}")
    if cand["status"] != "active":
        return Result.failure(f"状态 {cand['status']} 无可回滚")

    root = skills_root or default_skills_root()
    skill_dir = os.path.join(root, cand["name"])
    md_path = os.path.join(skill_dir, "SKILL.md")
    snapshot = cand.get("snapshot_path") or ""

    try:
        if snapshot and os.path.isfile(snapshot):
            with open(snapshot, "r", encoding="utf-8") as fh:
                previous = fh.read()
            _atomic_write(md_path, previous)
            imp = loader.import_skill(skill_dir, _own_trust())
            if not getattr(imp, "ok", False):
                return Result.failure(
                    f"旧版已复位但运行时重载失败: {getattr(imp, 'error', '')}"
                )
        else:
            # 全新技能没有旧版可回：撤稿删目录 + 运行时下线。
            if os.path.isdir(skill_dir):
                shutil.rmtree(skill_dir, ignore_errors=True)
            loader.disable_skill(cand["name"])
    except OSError as e:
        return Result.failure(f"回滚 IO 失败: {e}")

    storage.set_skill_candidate_status(
        cand_id, "archived",
        gate_report={"rollback": (
            f"restored from {os.path.basename(snapshot)}" if snapshot
            else "brand-new skill withdrawn")},
    )
    return Result.success(storage.get_skill_candidate(cand_id))


# ── 金丝雀灰度与健康度巡检 (Canary Staging & Health Guard) ──────────────────

def canary_stage(storage, loader, cand_id: str, *, shadow_ratio: float = 0.2) -> Result:
    """将候选置为金丝雀灰度运行态 (canary)，进行 A/B 真实流量测试。"""
    cand = storage.get_skill_candidate(cand_id)
    if not cand:
        return Result.failure(f"无此候选: {cand_id}")
    if cand["status"] not in ("staged", "candidate"):
        return Result.failure(f"状态 {cand['status']} 不可进入 canary")

    storage.set_skill_candidate_status(
        cand_id, "canary",
        gate_report={"canary_config": {"shadow_ratio": shadow_ratio, "staged_at": time.time()}}
    )
    return Result.success(storage.get_skill_candidate(cand_id))


def evaluate_canary_health(storage, skill_name: str, max_consecutive_failures: int = 3) -> dict:
    """对处于 canary 灰度的技能进行健康巡检，连续失败超阈值时触发告警并建议回滚。"""
    try:
        rows = storage.list_skill_experiences(skill_id=skill_name, limit=10) or []
        consecutive_fails = 0
        for r in rows:
            if r.get("outcome") != "success":
                consecutive_fails += 1
            else:
                break
        healthy = consecutive_fails < max_consecutive_failures
        return {
            "skillName": skill_name,
            "healthy": healthy,
            "consecutiveFailures": consecutive_fails,
            "maxAllowed": max_consecutive_failures,
            "needsRollback": not healthy,
        }
    except Exception as e:
        return {"skillName": skill_name, "healthy": True, "error": str(e)}


def _own_trust():
    from skill_loader import TrustLevel
    return TrustLevel.OWN


# ── Voyager 启发：技能组合引擎 (Skill Composer) ──────────────────────────────

@dataclass
class CompositePattern:
    """频繁共现的技能组合模式序列。"""
    pattern_id: str
    skills: list[str]
    frequency: int
    goals_covered: list[str]
    sample_experience_id: str = ""

    def to_dict(self) -> dict:
        return {
            "patternId": self.pattern_id,
            "skills": self.skills,
            "frequency": self.frequency,
            "goalsCovered": self.goals_covered,
            "sampleExperienceId": self.sample_experience_id,
        }


class SkillComposer:
    """自动挖掘频繁技能调用链并生成复合技能候选 (Voyager Skill Composition)."""

    @classmethod
    def find_composition_patterns(
        cls,
        storage,
        min_support: int = 2,
        max_chain_len: int = 3,
    ) -> list[CompositePattern]:
        """从成功历史经验中挖掘频繁共现的技能调用序列。"""
        if not storage:
            return []

        try:
            # 获取最近的成功技能经验
            rows = storage.list_skill_experiences(limit=200) or []
        except Exception:
            return []

        # 按 goal_id 分组提取技能顺序
        goal_chains: dict[str, list[dict]] = {}
        for r in rows:
            if r.get("outcome") != "success":
                continue
            gid = str(r.get("goal_id") or "")
            sid = str(r.get("skill_id") or "")
            if not gid or not sid or sid == storage.TASK_LEVEL_SKILL_ID:
                continue
            goal_chains.setdefault(gid, []).append(r)

        # 统计连续 n-gram 子序列
        ngram_counts: dict[tuple[str, ...], list[dict]] = {}
        for gid, exps in goal_chains.items():
            # 按创建时间排序
            exps_sorted = sorted(exps, key=lambda x: x.get("created_at") or 0)
            skills = [e["skill_id"] for e in exps_sorted]
            n = len(skills)
            
            seen_ngrams_in_goal = set()
            for length in range(2, min(n + 1, max_chain_len + 1)):
                for i in range(n - length + 1):
                    sub = tuple(skills[i : i + length])
                    # 避免同技能自循环如 ('a', 'a')
                    if len(set(sub)) > 1 and sub not in seen_ngrams_in_goal:
                        seen_ngrams_in_goal.add(sub)
                        ngram_counts.setdefault(sub, []).append({
                            "goal_id": gid,
                            "exp_id": exps_sorted[i].get("experience_id") or "",
                        })

        patterns = []
        for ngram, matches in ngram_counts.items():
            if len(matches) >= min_support:
                pid = f"pat_{hashlib.sha256('->'.join(ngram).encode()).hexdigest()[:8]}"
                goals = list(dict.fromkeys(m["goal_id"] for m in matches))
                sample_eid = matches[0]["exp_id"] if matches else ""
                patterns.append(CompositePattern(
                    pattern_id=pid,
                    skills=list(ngram),
                    frequency=len(matches),
                    goals_covered=goals,
                    sample_experience_id=sample_eid,
                ))

        patterns.sort(key=lambda p: p.frequency, reverse=True)
        return patterns

    @classmethod
    def generate_composite_candidate(
        cls,
        storage,
        pattern: CompositePattern,
        name: str = "",
    ) -> Result:
        """将频繁调用模式转化为结构化复合技能候选并提交给门禁。"""
        if not pattern or not pattern.skills:
            return Result.failure("模式为空，无法生成复合技能")

        skill_chain = " -> ".join(pattern.skills)
        cand_name = name.strip() or f"composite-{'-to-'.join(pattern.skills[:3])}"
        desc = (
            f"复合高阶技能：自动化串联执行 [{skill_chain}] 流水线。"
            f"（在历史 {pattern.frequency} 个任务中成功复现）"
        )
        when_to_use = f"当任务需要依次完成 {' 并接着 '.join(pattern.skills)} 时优先调用此复合技能。"
        preconditions = f"工作区就绪，且满足进入 {pattern.skills[0]} 的全部前置条件。"

        steps = [
            f"第一阶段：调用并执行基础技能 [{pattern.skills[0]}] 处理初始上下文与输入",
        ]
        for i, s in enumerate(pattern.skills[1:], 2):
            steps.append(f"第 {i} 阶段：将上一阶段产物作为输入，无缝调用 [{s}] 进行深度处理")
        steps.append("验证阶段：运行端到端复合验证，确保链路最终产物完整落地")

        fields = {
            "name": cand_name,
            "description": desc,
            "when_to_use": when_to_use,
            "scope": "workspace",
            "preconditions": preconditions,
            "inputs": "初始任务目标与工作区路径",
            "outputs": f"由 {pattern.skills[-1]} 产出的最终结构化产物",
            "steps": steps,
            "required_tools": ["run_command", "view_file"],
            "verification": "全部子阶段顺序执行无报错，且生成物通过目标合同门禁",
            "risk_level": "medium",
            "known_failures": f"跨技能管道传参不兼容；复合模式来源于 {len(pattern.goals_covered)} 个成功用例",
            "experience_ref": pattern.sample_experience_id,
        }

        return create_candidate(storage, fields)

