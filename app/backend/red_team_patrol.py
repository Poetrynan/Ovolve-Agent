"""red_team_patrol.py — 学习产物红队巡逻（Phase 36）

## 它守什么

自进化系统会把「学到的规则」写进引导文件（AGENTS.md / MEMORY.md 的
Learned Rules 小节）、孵化技能（skills/*/SKILL.md）。这些产物会逐轮注
入模型上下文——**它们一旦被投毒，等于每轮都在给模型喂攻击**。进化管
线的挖掘端有签名归一化与秘密拦截，但防线不能只有一道：本模块是独立
的第二道闸，定期用 red_team 的注入/越权模式库反向扫描这些学习产物。

## 怎么巡逻

1. 收集审计目标：workspace 引导文件的 Learned Rules 小节逐条 + 技能描述；
2. 对每条跑 `RedTeam.scan` + `is_injection`，命中即记 findings；
3. findings 写 mailbox（system:redteam 通道）并广播 `red_team_alert`
   事件，前端可弹出告警；
4. 全程 fail-open：巡逻自己出任何问题只打日志，绝不影响主流程；
5. 前台优先：有目标在跑/排队时整轮跳过（与 evolution_review 同纪律）。

## 节奏

默认 6 小时一轮。红队巡逻是防线的"体检"，不是实时闸门——实时闸门
在进化管线的挖掘端（_SECRET_HINT / 白名单 / 人工审批）。
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time

logger = logging.getLogger("red_team_patrol")

_PATROL_INTERVAL_S = 6 * 3600.0
#: 单条审计样本长度上限。规则条目可能很长，截断后再扫——注入特征
#: 几乎总是出现在条目头部。
_SAMPLE_CAP = 1200
#: 引导文件里自进化产物的小节标题（与 evolution.EVOLUTION_HEADING 一致）。
_EVOLUTION_HEADING = "## Learned Rules (evolution)"

_task: asyncio.Task | None = None


def _extract_learned_rules(path: str) -> list[str]:
    """从引导文件里抽 Learned Rules 小节的逐条规则（每行一条）。"""
    try:
        text = open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return []
    out: list[str] = []
    in_section = False
    for line in text.splitlines():
        if line.strip().startswith("## "):
            in_section = line.strip().startswith(_EVOLUTION_HEADING)
            continue
        if in_section and line.strip().startswith("- "):
            out.append(line.strip()[2:])
    return out


def _audit_targets(router) -> list[tuple[str, str]]:
    """收集本轮审计目标：[(来源标签, 样本文本), ...]。"""
    targets: list[tuple[str, str]] = []
    ws = getattr(router, "workspace", "") or ""
    if ws:
        for name in ("AGENTS.md", "MEMORY.md", "SOUL.md"):
            p = os.path.join(ws, name)
            for rule in _extract_learned_rules(p):
                targets.append((f"{name}#learned", rule[:_SAMPLE_CAP]))
    try:
        loader = getattr(router, "skills", None)
        for entry in (loader.list_skills() or []) if loader else []:
            desc = str(getattr(entry, "description", "") or "")
            if desc:
                targets.append((f"skill:{getattr(entry, 'name', '?')}", desc[:_SAMPLE_CAP]))
    except Exception:
        pass  # 技能清单不可用不阻塞巡逻
    return targets


def _run_scan(router) -> list[dict]:
    """跑一轮扫描，返回 findings 列表。"""
    from red_team import get_red_team

    rt = get_red_team()
    findings: list[dict] = []
    for source, sample in _audit_targets(router):
        if not sample.strip():
            continue
        try:
            hits = rt.scan(sample)
            if rt.is_injection(sample) and not hits:
                hits = [{"category": "injection", "matched": "is_injection"}]
        except Exception as exc:  # noqa: BLE001 — 单条失败不阻塞整轮
            logger.warning("[red_team_patrol] scan error on %s: %s", source, exc)
            continue
        for h in hits or []:
            findings.append({"source": source, "sample": sample[:160], "hit": h})
    return findings


def start_red_team_patrol(router, interval_s: float = _PATROL_INTERVAL_S) -> bool:
    """启动周期巡逻。已在跑则幂等返回 False。"""
    global _task
    if _task is not None and not _task.done():
        return False

    async def _patrol() -> None:
        while True:
            await asyncio.sleep(interval_s)
            started = time.monotonic()
            try:
                # 前台优先：有目标在跑就不巡逻（与 evolution_review 同纪律）
                from evolution_review import _busy
                from storage import get_storage

                st = get_storage()
                if _busy(st):
                    continue
                # Durable lease in cron DB (mirrors evolution_review)
                try:
                    now_ts = int(time.time())
                    st._db("cron").execute(
                        "INSERT INTO cron_jobs (id, name, cron_expr, prompt, status, next_run_at, running_since, last_error) "
                        "VALUES ('job_red_team_patrol', 'Red Team Learned Rules Patrol', '0 */6 * * *', "
                        "'Scan learned rules and skill descriptions for injection patterns', 'running', ?, ?, '') "
                        "ON CONFLICT(id) DO UPDATE SET running_since=excluded.running_since, status='running', next_run_at=excluded.next_run_at",
                        (now_ts + int(interval_s), now_ts),
                    )
                    st._db("cron").commit()
                except Exception:
                    pass
                findings = _run_scan(router)
                elapsed = time.monotonic() - started
                if findings:
                    logger.warning(
                        "[red_team_patrol] %d finding(s) in %.1fs: %s",
                        len(findings), elapsed,
                        [f["source"] for f in findings[:5]],
                    )
                    try:
                        from mailbox import send as _msend
                        _msend(st, "system:redteam", "red-team-patrol",
                               kind="warning", payload={"findings": findings[:20]})
                    except Exception as exc:
                        logger.warning("[red_team_patrol] mailbox notify failed: %s", exc)
                    try:
                        await router.bus.emit("red_team_alert", {
                            "session_id": router.session_id,
                            "count": len(findings),
                            "sources": [f["source"] for f in findings[:10]],
                            "findings": findings[:10],
                        })
                    except Exception:
                        pass
                else:
                    logger.info("[red_team_patrol] sweep clean in %.1fs", elapsed)
                try:
                    st._db("cron").execute(
                        "UPDATE cron_jobs SET status='idle', running_since=0, last_error='' WHERE id='job_red_team_patrol'"
                    )
                    st._db("cron").commit()
                except Exception:
                    pass
            except Exception as exc:  # noqa: BLE001 — 巡逻绝不影响主流程
                logger.warning("[red_team_patrol] sweep failed: %s", exc)

    _task = asyncio.get_event_loop().create_task(_patrol())
    logger.info("[red_team_patrol] started, interval=%.0fs", interval_s)
    return True
