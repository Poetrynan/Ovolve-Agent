"""
evolution_review.py — 后台 EvolutionReviewRun 的最小实现（Phase 5 收口）。

总指令 §10：review 由 idle/turn-settled 触发、前台优先、有预算。这里的实现
刻意保守：

* 定时扫最近完成的目标，只补"还没被观察过"的那批——不重复立项；
* 前台优先的代理信号：存在 running/queued 目标时整轮跳过；
* 复用既有的 build_goal_observation + observe + 关系落边，不建第二套管线；
* 任何失败只打日志，绝不影响前台。
"""
import asyncio
import time
import logging

logger = logging.getLogger("evolution_review")

_SCAN_LIMIT = 20
#: 单轮 sweep 的墙钟预算。observe() 内部可能触发 GEPA 离线优化（多次模型
#: 调用），一批 20 个目标串行处理可能让一轮跑远超预期——超预算就收手，
#: 剩余未观察目标下一轮自然继续（本就只补"还没被观察过"的那批）。
#: 这是后台学习任务，必须永远不与前台争预算。
_SWEEP_TIME_BUDGET_S = 120.0
#: 单轮 sweep 的估算 token 预算（墙钟之外的第二个维度）。observe 内部的
#: GEPA 优化会把观察体积折算进 prompt——按「观察证据包字符数 ÷ 2.5」
#: 粗估输入 token（中英混排保守值），累计超限即收手。估算是代理指标：
#: 它回答的是"这轮会不会失控烧钱"，不是精确计费。
_SWEEP_TOKEN_BUDGET = 60_000
_CHARS_PER_TOKEN_EST = 2.5
_interval_s = 900.0
_task: asyncio.Task | None = None


def _busy(storage) -> bool:
    """前台优先的代理信号：还有目标在跑/排队，就不占后台预算。"""
    try:
        row = storage._db("goals").execute(
            "SELECT COUNT(*) AS c FROM goals WHERE status IN ('running','queued')"
        ).fetchone()
        return bool(row and row["c"])
    except Exception:
        return True  # 查不清就当忙——宁可不跑后台


def _reconcile_boot_lease(storage) -> None:
    """Boot-time reconciliation: detect and recover broken/orphaned leases and hanging operations (P1-3 & P1-8)."""
    try:
        now_ts = int(time.time())
        row = storage._db("cron").execute(
            "SELECT status, running_since FROM cron_jobs WHERE id='job_evolution_review'"
        ).fetchone()
        if row and (row["status"] == "running" or (row["running_since"] and now_ts - row["running_since"] > 1800)):
            storage._db("cron").execute(
                "UPDATE cron_jobs SET status='idle', running_since=0, last_error='Recovered from previous process restart/stale lease' WHERE id='job_evolution_review'"
            )
            storage._db("cron").commit()
            logger.info("[evolution_review] reconciled orphaned background review lease on boot")
    except Exception as exc:
        logger.warning(f"[evolution_review] boot lease reconciliation ignored: {exc}")

    # Reconcile any in-flight mutation operations
    try:
        from learning_service import reconcile_learning_item_operations
        reconcile_learning_item_operations(storage)
    except Exception as op_exc:
        logger.warning(f"[evolution_review] boot operation reconciliation failed: {op_exc}")


def start_background_review(router, interval_s: float = 900.0) -> bool:
    """启动周期扫描任务。已在跑则幂等返回 False。"""
    global _task, _interval_s
    if _task is not None and not _task.done():
        return False
    _interval_s = float(interval_s)

    async def _sweep() -> None:
        from evolution import (
            build_goal_observation,
            get_evolution_engine,
            record_goal_validation_edges,
        )
        from storage import get_storage
        from learning_service import reconcile_learning_item_operations

        # Boot reconciliation
        try:
            st_init = get_storage()
            _reconcile_boot_lease(st_init)
        except Exception:
            pass

        while True:
            await asyncio.sleep(_interval_s)
            try:
                engine = get_evolution_engine()
                if not engine.enabled():
                    continue
                st = get_storage()
                if _busy(st):
                    continue

                # Durable lease and status record keeping in cron db
                try:
                    now_ts = int(time.time())
                    st._db("cron").execute(
                        "INSERT INTO cron_jobs (id, name, cron_expr, prompt, status, next_run_at, running_since, last_error) "
                        "VALUES ('job_evolution_review', 'Evolution Background Review', '*/15 * * * *', 'Review completed goals and idle episodes', 'running', ?, ?, '') "
                        "ON CONFLICT(id) DO UPDATE SET running_since=excluded.running_since, status='running', next_run_at=excluded.next_run_at",
                        (now_ts + int(_interval_s), now_ts)
                    )
                    st._db("cron").commit()
                except Exception:
                    pass

                # Reconcile any hanging operations (P1-3)
                try:
                    reconcile_learning_item_operations(st)
                except Exception as _r_e:
                    logger.warning(f"[evolution_review] periodic operation reconcile failed: {_r_e}")

                # 自动检查并封存静默超过 30 分钟的无 Goal 普通对话片段（Phase 4 & 24）
                try:
                    from episode_manager import get_episode_manager
                    em = get_episode_manager(st)
                    sealed_ep_ids = em.check_idle_episodes(idle_timeout_s=1800.0)
                    if sealed_ep_ids:
                        print(f"[evolution] background review sealed {len(sealed_ep_ids)} idle episode(s): {sealed_ep_ids}")
                except Exception as _ep_e:
                    print(f"[evolution] idle episode sweep failed: {_ep_e}")

                rows = st._db("goals").execute(
                    "SELECT id FROM goals WHERE status = 'completed'"
                    " ORDER BY updated_at DESC LIMIT ?",
                    (_SCAN_LIMIT,),
                ).fetchall()
                have = {o.get("goalId")
                        for o in engine.store.list_observations(limit=200)}
                n = 0
                _t0 = time.monotonic()
                _tokens_spent = 0
                _budget_hit = ""
                for r in rows:
                    gid = r["id"]
                    if gid in have:
                        continue
                    # 时间预算帽：超了就收手，剩余目标下轮再处理。
                    if time.monotonic() - _t0 > _SWEEP_TIME_BUDGET_S:
                        _budget_hit = "time"
                        break
                    obs = build_goal_observation(gid, st)
                    if obs is None:
                        continue
                    # token 账本：按观察证据包体积估算本轮 observe 的输入
                    # 开销（GEPA 会把它折进 prompt），累计超限即收手。
                    try:
                        import json as _json
                        _obs_size = len(_json.dumps(obs.to_dict(), ensure_ascii=False, default=str))
                        _tokens_spent += int(_obs_size / _CHARS_PER_TOKEN_EST)
                    except Exception:
                        pass  # 估算失败只跳过记账，不阻塞本轮
                    if _tokens_spent > _SWEEP_TOKEN_BUDGET:
                        _budget_hit = "tokens"
                        break
                    engine.observe(obs)
                    try:
                        record_goal_validation_edges(obs, st)
                    except Exception:
                        pass  # fail-open: 可选增强，失败不影响主流程
                    n += 1
                if _budget_hit:
                    logger.info(
                        "[evolution_review] sweep %s budget hit after %d goal(s) "
                        "(~%d est. tokens); remaining targets deferred to next cycle",
                        _budget_hit, n, _tokens_spent,
                    )
                if n:
                    print(f"[evolution] background review observed {n} goal(s)")
                    try:
                        from mailbox import send as _msend
                        _msend(st, "system:evolution", "evolution-review",
                               kind="info", payload={"observed_goals": n})
                    except Exception as e:
                        print(f"[evolution] mailbox notify failed: {e}")

                try:
                    st._db("cron").execute(
                        "UPDATE cron_jobs SET status='idle', running_since=0, last_error='' WHERE id='job_evolution_review'"
                    )
                    st._db("cron").commit()
                except Exception:
                    pass
            except Exception as e:
                print(f"[evolution] review sweep failed: {e}")
                try:
                    st._db("cron").execute(
                        "UPDATE cron_jobs SET status='idle', running_since=0, last_error=? WHERE id='job_evolution_review'",
                        (str(e)[:200],)
                    )
                    st._db("cron").commit()
                except Exception:
                    pass

    _task = asyncio.get_event_loop().create_task(_sweep())
    return True
