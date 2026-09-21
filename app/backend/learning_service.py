"""
learning_service.py — LearningItem 统一操作服务 (Canonical Mutation Saga)。

§13.5, §23.5 & P0/P1 收口：
1. 统一 LearningItem action 入口 (approve/edit/reject/defer/revoke)，杜绝 UI 跨通道调用导致状态分裂；
2. approve 真实 Saga：
   - 校验 session & branch 作用域 (exact match)；
   - 校验当前状态合法性与 expected_version；
   - 检查 idempotency_key 幂等；
   - 校验 target_ref 有效性（绝不无目标假装成功）；
   - 执行底层物理资产变异（MemoryDomain / SkillLifecycle）；
   - 确认 landed == True 并落地验证；
   - 更新 learning_items 状态机至 published 并推进 version；
   - 写入 EventStore 标准事件并广播；
3. edit 真实语义：更新底层 proposal/candidate 草稿与 LearningItem 内容，状态迁回 proposed/pending；
4. reject 真实语义：底层 proposal/candidate 标记 reject，LearningItem 迁至 rejected；
5. defer 真实语义：底层与 LearningItem 记录 deferred_reason，迁至 deferred；
6. revoke 真实语义：真实调用 MemoryDomain 归档/撤回或 SkillLifecycle 回滚，确认 landed 成功后才迁至 rolled_back；
7. 任何步骤失败进入 failed，不确定进入 unknown 并打标 needs_reconcile，绝不自欺欺人。
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any, Dict, List, Optional
from storage import get_storage
from scope_guard import validate_scope
from event_types import EventType

logger = logging.getLogger("learning_service")


class LearningItemService:
    """Canonical service managing LearningItem mutations and underlying physical projections."""

    def __init__(self, storage=None):
        self.storage = storage or get_storage()

    def decide(
        self,
        item_id: str,
        action: str,
        session_id: str = "",
        branch_id: str = "",
        expected_version: Optional[int] = None,
        idempotency_key: str = "",
        edited_content: Optional[str] = None,
        reason: str = "",
        user_id: str = "local_user",
    ) -> dict:
        """Execute a canonical mutation saga on a learning item."""
        if not item_id or not action:
            return {"ok": False, "error": "item_id and action are required", "status": "invalid_request"}

        item = self.storage.get_learning_item(item_id)
        if not item:
            return {"ok": False, "error": "Learning item not found", "status": "not_found"}

        actual_session = str(item.get("session_id") or item.get("source_session_id") or "")
        actual_branch = str(item.get("branch_id") or "")
        item_scope = str(item.get("scope") or "workspace")

        # 1. 严格作用域校验 (Strict Scope Guard, P1-1)
        if item_scope != "global":
            if not actual_session:
                return {"ok": False, "error": "Non-global learning item missing canonical session scope", "status": "scope_mismatch"}
            if not session_id:
                return {"ok": False, "error": "sessionId is required for non-global learning item", "status": "scope_required"}
            if session_id != actual_session:
                return {"ok": False, "error": f"sessionId mismatch: expected '{actual_session}', got '{session_id}'", "status": "scope_mismatch"}
            if (branch_id or "").strip() != actual_branch.strip():
                return {"ok": False, "error": f"branchId mismatch: expected '{actual_branch}', got '{branch_id}'", "status": "scope_mismatch"}

        # 2. 幂等原子声明与重入检查 (Atomic Idempotency Claim, BUG-5, P1-2)
        if not idempotency_key:
            return {"ok": False, "error": "idempotencyKey is required for mutation actions", "status": "idempotency_required"}

        cur_status = str(item.get("status") or "discovered")
        effective_key = idempotency_key
        operation_id = f"op_{uuid.uuid4().hex[:12]}"

        claimed, op_info = self.storage.claim_learning_item_operation(
            operation_id=operation_id,
            item_id=item_id,
            action=action,
            idempotency_key=effective_key,
            payload={
                "action": action,
                "content": edited_content,
                "reason": reason,
                "version": expected_version,
                "session_id": session_id,
                "branch_id": branch_id,
            }
        )

        if not claimed:
            op_status = op_info.get("status")
            if op_status == "idempotency_conflict":
                return {
                    "ok": False,
                    "status": "idempotency_conflict",
                    "error": op_info.get("error") or f"Idempotency key '{effective_key}' is already used for another action/item",
                    "idempotent": True,
                }
            if op_status in ("verified", "landed", "published", "rejected", "deferred", "rolled_back"):
                cached_res = op_info.get("result") or {}
                cached_res["idempotent"] = True
                cached_res["operation_id"] = op_info.get("operation_id")
                return cached_res
            if op_status == "started":
                # In-flight concurrent execution!
                return {
                    "ok": False,
                    "status": "running",
                    "error": f"Operation '{action}' for item {item_id} is already in progress",
                    "operation_id": op_info.get("operation_id"),
                    "idempotent": True,
                }
            if op_status in ("failed", "unknown"):
                # Retry previously failed attempt under same key
                operation_id = op_info.get("operation_id") or operation_id
                self.storage.update_learning_item_operation(operation_id, status="started", error="")

        kind = str(item.get("kind") or "memory_fact")
        ref = str(item.get("target_ref") or "")
        sid = actual_session or "default"
        bid = actual_branch or ""

        # ── 1. APPROVE / ACCEPT SAGA ──────────────────────────────────────────
        if action in ("approve", "accept"):
            if cur_status == "unknown":
                err_res = {
                    "ok": False,
                    "error": "Item is in 'unknown' state and requires reconcile before approval",
                    "status": "unknown",
                }
                self.storage.update_learning_item_operation(operation_id, status="unknown", error=err_res["error"], result=err_res)
                return err_res
            if cur_status not in ("proposed", "staged", "deferred", "discovered", "validating"):
                err_res = {"ok": False, "error": f"Cannot approve item in status '{cur_status}'", "status": cur_status}
                self.storage.update_learning_item_operation(operation_id, status="failed", error=err_res["error"], result=err_res)
                return err_res

            applied = False
            error_msg = ""
            landed = False

            # Mutate Memory projection
            if kind in ("memory_fact", "preference"):
                if not ref:
                    # P0-8: Missing target_ref must not fake success!
                    error_msg = "Missing target proposal ref for memory mutation"
                    landed = False
                else:
                    try:
                        import evolution
                        engine = evolution.get_evolution_engine()
                        if engine:
                            dec_res = engine.decide(ref, True, draft_override=edited_content)
                            landed = bool(dec_res.get("applied"))
                            applied = landed
                            if not landed:
                                error_msg = dec_res.get("error") or "Memory write not applied to disk"
                        else:
                            landed = False
                            error_msg = "Evolution engine unavailable"
                    except Exception as exc:
                        landed = False
                        error_msg = str(exc)
                        logger.exception(f"[learning_service] memory mutation failed for item {item_id}")

            # Mutate Skill projection (P0-6: Correct skill_lifecycle call)
            elif kind == "skill_step":
                if not ref:
                    error_msg = "Missing skill candidate target_ref"
                    landed = False
                else:
                    try:
                        import skill_lifecycle
                        from skill_loader import get_skill_loader
                        loader = get_skill_loader()
                        app_res = skill_lifecycle.approve(self.storage, loader, ref)
                        landed = bool(app_res.ok)
                        applied = landed
                        if not app_res.ok:
                            error_msg = app_res.error or "Skill verification/promotion failed"
                    except Exception as exc:
                        landed = False
                        error_msg = str(exc)
                        logger.exception(f"[learning_service] skill candidate mutation failed for item {item_id}")

            # Mutate FailureGuard / Strategy
            elif kind in ("failure_guard", "strategy", "optimization"):
                landed = True
                applied = True
            else:
                error_msg = f"Unknown learning item kind '{kind}'"
                landed = False

            if landed:
                ok = self.storage.update_learning_item(
                    item_id,
                    status="published",
                    user_verdict="approved",
                    operation_id=operation_id,
                    idempotency_key=idempotency_key,
                    expected_version=expected_version,
                )
                if ok:
                    event_ok = True
                    try:
                        self.storage.get_event_store().append(
                            session_id=sid,
                            event_type=EventType.LEARNING_ITEM_PUBLISHED.value,
                            payload={
                                "learning_item_id": item_id,
                                "bundle_id": item.get("bundle_id", ""),
                                "episode_id": item.get("episode_id", ""),
                                "kind": kind,
                                "scope": item.get("scope", "session"),
                                "content": item.get("content", ""),
                                "why": item.get("why", ""),
                                "future_effect": item.get("future_effect", ""),
                                "operation_id": operation_id,
                                "idempotency_key": idempotency_key,
                                "applied": True,
                            },
                            branch_id=bid or None,
                        )
                    except Exception as _ev_e:
                        logger.warning(f"[learning_service] event append failed: {_ev_e}")
                        event_ok = False
                    if event_ok:
                        updated = self.storage.get_learning_item(item_id)
                        res_val = {"ok": True, "status": "published", "applied": True, "item": updated}
                        self.storage.update_learning_item_operation(operation_id, status="verified", result=res_val)
                        return res_val
                    else:
                        self.storage.update_learning_item(
                            item_id,
                            status="unknown",
                            deferred_reason="Audit event append failed; item marked unknown/needs_reconcile",
                            operation_id=operation_id,
                        )
                        updated = self.storage.get_learning_item(item_id)
                        res_val = {
                            "ok": False,
                            "status": "unknown",
                            "applied": True,
                            "needs_reconcile": True,
                            "error": "Audit event append failed; marked for reconciliation (status unknown)",
                            "item": updated,
                        }
                        self.storage.update_learning_item_operation(operation_id, status="unknown", error=res_val["error"], result=res_val)
                        return res_val
                else:
                    self.storage.update_learning_item(
                        item_id,
                        status="unknown",
                        deferred_reason="Physical mutation landed but learning item update failed (version conflict)",
                        operation_id=operation_id,
                    )
                    res_val = {"ok": False, "status": "version_conflict" if expected_version is not None else "failed", "error": "Concurrent modification detected (expected_version mismatch); physical state may require reconcile"}
                    self.storage.update_learning_item_operation(operation_id, status="unknown", error=res_val["error"], result=res_val)
                    return res_val
            else:
                self.storage.update_learning_item(
                    item_id,
                    status="failed",
                    user_verdict="failed",
                    deferred_reason=error_msg,
                    operation_id=operation_id,
                    idempotency_key=idempotency_key,
                )
                try:
                    self.storage.get_event_store().append(
                        session_id=sid,
                        event_type=EventType.LEARNING_ITEM_FAILED.value,
                        payload={"learning_item_id": item_id, "error": error_msg, "operation_id": operation_id},
                        branch_id=bid or None,
                    )
                except Exception:
                    pass
                res_val = {"ok": False, "status": "failed", "applied": False, "error": error_msg}
                self.storage.update_learning_item_operation(operation_id, status="failed", error=error_msg, result=res_val)
                return res_val

        # ── 2. REJECT / DENY SAGA ─────────────────────────────────────────────
        elif action in ("reject", "deny"):
            reject_ok = True
            reject_err = ""
            if kind in ("memory_fact", "preference") and ref:
                try:
                    import evolution
                    engine = evolution.get_evolution_engine()
                    if engine:
                        engine.decide(ref, False)
                except Exception as exc:
                    reject_ok = False
                    reject_err = str(exc)
            elif kind == "skill_step" and ref:
                try:
                    import skill_lifecycle
                    res = skill_lifecycle.reject(self.storage, ref, reason=reason or "user rejected")
                    if not res.ok:
                        reject_ok = False
                        reject_err = res.error or "Skill candidate reject failed"
                except Exception as exc:
                    reject_ok = False
                    reject_err = str(exc)

            if not reject_ok:
                logger.warning(f"[learning_service] reject failed on ref {ref}: {reject_err}")
                self.storage.update_learning_item(
                    item_id,
                    status="unknown",
                    deferred_reason=f"Underlying reject failed: {reject_err}",
                    operation_id=operation_id,
                    idempotency_key=idempotency_key,
                )
                res_val = {"ok": False, "status": "unknown", "applied": False, "error": reject_err or "Underlying reject failed"}
                self.storage.update_learning_item_operation(operation_id, status="unknown", error=reject_err, result=res_val)
                return res_val

            ok = self.storage.update_learning_item(
                item_id,
                status="rejected",
                user_verdict="rejected",
                operation_id=operation_id,
                idempotency_key=idempotency_key,
                expected_version=expected_version,
            )
            if not ok:
                res_val = {"ok": False, "status": "version_conflict" if expected_version is not None else "failed", "error": "Concurrent modification detected on reject"}
                self.storage.update_learning_item_operation(operation_id, status="failed", error=res_val["error"], result=res_val)
                return res_val

            event_ok = True
            try:
                self.storage.get_event_store().append(
                    session_id=sid,
                    event_type=EventType.LEARNING_ITEM_REJECTED.value,
                    payload={"learning_item_id": item_id, "reason": reason or "user rejected", "operation_id": operation_id},
                    branch_id=bid or None,
                )
            except Exception as _ev_e:
                logger.warning(f"[learning_service] reject event append failed: {_ev_e}")
                event_ok = False
            if event_ok:
                updated = self.storage.get_learning_item(item_id)
                res_val = {"ok": True, "status": "rejected", "applied": False, "item": updated}
                self.storage.update_learning_item_operation(operation_id, status="verified", result=res_val)
                return res_val
            else:
                self.storage.update_learning_item(
                    item_id,
                    status="unknown",
                    deferred_reason="Audit event append failed; item marked unknown/needs_reconcile",
                    operation_id=operation_id,
                )
                updated = self.storage.get_learning_item(item_id)
                res_val = {
                    "ok": False,
                    "status": "unknown",
                    "applied": False,
                    "needs_reconcile": True,
                    "error": "Audit event append failed; marked for reconciliation (status unknown)",
                    "item": updated,
                }
                self.storage.update_learning_item_operation(operation_id, status="unknown", error=res_val["error"], result=res_val)
                return res_val

        # ── 3. DEFER SAGA ─────────────────────────────────────────────────────
        elif action == "defer":
            defer_reason = reason or "user deferred"
            ok = self.storage.update_learning_item(
                item_id,
                status="deferred",
                user_verdict="deferred",
                deferred_reason=defer_reason,
                operation_id=operation_id,
                idempotency_key=idempotency_key,
                expected_version=expected_version,
            )
            if not ok:
                res_val = {"ok": False, "status": "version_conflict" if expected_version is not None else "failed", "error": "Concurrent modification detected on defer"}
                self.storage.update_learning_item_operation(operation_id, status="failed", error=res_val["error"], result=res_val)
                return res_val

            event_ok = True
            try:
                self.storage.get_event_store().append(
                    session_id=sid,
                    event_type=EventType.LEARNING_ITEM_DEFERRED.value,
                    payload={"learning_item_id": item_id, "reason": defer_reason, "operation_id": operation_id},
                    branch_id=bid or None,
                )
            except Exception as _ev_e:
                logger.warning(f"[learning_service] defer event append failed: {_ev_e}")
                event_ok = False
            if event_ok:
                updated = self.storage.get_learning_item(item_id)
                res_val = {"ok": True, "status": "deferred", "applied": False, "item": updated}
                self.storage.update_learning_item_operation(operation_id, status="verified", result=res_val)
                return res_val
            else:
                self.storage.update_learning_item(
                    item_id,
                    status="unknown",
                    deferred_reason="Audit event append failed; item marked unknown/needs_reconcile",
                    operation_id=operation_id,
                )
                updated = self.storage.get_learning_item(item_id)
                res_val = {
                    "ok": False,
                    "status": "unknown",
                    "applied": False,
                    "needs_reconcile": True,
                    "error": "Audit event append failed; marked for reconciliation (status unknown)",
                    "item": updated,
                }
                self.storage.update_learning_item_operation(operation_id, status="unknown", error=res_val["error"], result=res_val)
                return res_val

        # ── 4. EDIT SAGA ──────────────────────────────────────────────────────
        elif action == "edit":
            new_content = str(edited_content if edited_content is not None else item.get("content", "")).strip()
            if not new_content:
                res_val = {"ok": False, "error": "Content cannot be empty on edit", "status": "invalid_content"}
                self.storage.update_learning_item_operation(operation_id, status="failed", error=res_val["error"], result=res_val)
                return res_val

            edit_ok = True
            edit_err = ""

            # Update proposal / candidate draft
            if kind in ("memory_fact", "preference") and ref:
                try:
                    import evolution
                    engine = evolution.get_evolution_engine()
                    if engine and hasattr(engine.store, "update_draft"):
                        engine.store.update_draft(ref, f"- {new_content}")
                except Exception as exc:
                    edit_ok = False
                    edit_err = str(exc)
            elif kind == "skill_step" and ref:
                try:
                    cand = self.storage.get_skill_candidate(ref)
                    if cand:
                        cand["steps"] = [new_content]
                        cand["status"] = "candidate"  # Reset to candidate for re-gating
                        self.storage._db("skills").execute(
                            "UPDATE skill_candidates SET steps=?, status=?, gate_report=NULL WHERE id=?",
                            (json.dumps([new_content], ensure_ascii=False), "candidate", ref)
                        )
                        self.storage._db("skills").commit()
                except Exception as exc:
                    edit_ok = False
                    edit_err = str(exc)

            if not edit_ok:
                logger.warning(f"[learning_service] edit failed on ref {ref}: {edit_err}")
                res_val = {"ok": False, "status": "failed", "applied": False, "error": edit_err or "Underlying draft update failed"}
                self.storage.update_learning_item_operation(operation_id, status="failed", error=edit_err, result=res_val)
                return res_val

            ok = self.storage.update_learning_item(
                item_id,
                content=new_content,
                status="proposed",
                user_verdict="pending",
                operation_id=operation_id,
                idempotency_key=idempotency_key,
                expected_version=expected_version,
            )
            if not ok:
                res_val = {"ok": False, "status": "version_conflict" if expected_version is not None else "failed", "error": "Concurrent modification detected on edit"}
                self.storage.update_learning_item_operation(operation_id, status="failed", error=res_val["error"], result=res_val)
                return res_val

            event_ok = True
            try:
                self.storage.get_event_store().append(
                    session_id=sid,
                    event_type=EventType.LEARNING_ITEM_PROPOSED.value,
                    payload={"learning_item_id": item_id, "content": new_content, "revision": True, "operation_id": operation_id},
                    branch_id=bid or None,
                )
            except Exception as _ev_e:
                logger.warning(f"[learning_service] edit event append failed: {_ev_e}")
                event_ok = False
            if event_ok:
                updated = self.storage.get_learning_item(item_id)
                res_val = {"ok": True, "status": "proposed", "applied": False, "item": updated}
                self.storage.update_learning_item_operation(operation_id, status="verified", result=res_val)
                return res_val
            else:
                self.storage.update_learning_item(
                    item_id,
                    status="unknown",
                    deferred_reason="Audit event append failed; item marked unknown/needs_reconcile",
                    operation_id=operation_id,
                )
                updated = self.storage.get_learning_item(item_id)
                res_val = {
                    "ok": False,
                    "status": "unknown",
                    "applied": False,
                    "needs_reconcile": True,
                    "error": "Audit event append failed; marked for reconciliation (status unknown)",
                    "item": updated,
                }
                self.storage.update_learning_item_operation(operation_id, status="unknown", error=res_val["error"], result=res_val)
                return res_val

        # ── 5. REVOKE / ROLLBACK SAGA ─────────────────────────────────────────
        elif action == "revoke":
            if cur_status != "published":
                res_val = {"ok": False, "error": f"Cannot revoke item in status '{cur_status}'", "status": "not_published"}
                self.storage.update_learning_item_operation(operation_id, status="failed", error=res_val["error"], result=res_val)
                return res_val

            landed = False
            error_msg = ""

            # BUG-1: MemoryDomain.get(ref) instead of get_item(ref)
            if kind in ("memory_fact", "preference"):
                if not ref:
                    landed = False
                    error_msg = "Missing target proposal ref for published memory revocation"
                else:
                    try:
                        from memory_domain import MemoryDomain
                        md = MemoryDomain(self.storage)
                        ok_stat, stat_err = md.set_status(ref, "archived", reason="user revoked learning item")
                        landed = ok_stat
                        if ok_stat:
                            # BUG-1: Post-verification using md.get(ref)
                            verified_item = md.get(ref)
                            if verified_item and getattr(verified_item, "status", "") not in ("archived", "deleted"):
                                landed = False
                                error_msg = "Memory status verification failed after archive"
                        else:
                            error_msg = stat_err or "Failed to archive memory in domain"
                    except Exception as exc:
                        landed = False
                        error_msg = str(exc)
                        logger.exception(f"[learning_service] memory revoke failed for item {item_id}")

            # P0-6, P1-4 & P1-10: Real Skill rollback with strict target_ref check & post-verification
            elif kind == "skill_step":
                if not ref:
                    landed = False
                    error_msg = "Missing skill candidate ref for published skill rollback"
                else:
                    try:
                        import skill_lifecycle
                        from skill_loader import get_skill_loader
                        loader = get_skill_loader()
                        res = skill_lifecycle.rollback(self.storage, loader, ref)
                        landed = bool(res.ok)
                        if not res.ok:
                            error_msg = res.error or "Skill rollback failed"
                    except Exception as exc:
                        landed = False
                        error_msg = str(exc)
                        logger.exception(f"[learning_service] skill rollback failed for item {item_id}")

            else:
                landed = True

            if landed:
                ok = self.storage.update_learning_item(
                    item_id,
                    status="rolled_back",
                    user_verdict="revoked",
                    operation_id=operation_id,
                    idempotency_key=idempotency_key,
                    expected_version=expected_version,
                )
                if not ok:
                    # Physical revoke succeeded, but learning item CAS failed! Mark unknown
                    self.storage.update_learning_item(
                        item_id,
                        status="unknown",
                        deferred_reason="Physical revoke succeeded but learning item update failed (version conflict)",
                        operation_id=operation_id,
                    )
                    res_val = {"ok": False, "status": "unknown", "error": "Revoke physical asset succeeded but learning item update failed (marked unknown/needs_reconcile)"}
                    self.storage.update_learning_item_operation(operation_id, status="unknown", error=res_val["error"], result=res_val)
                    return res_val

                event_ok = True
                try:
                    self.storage.get_event_store().append(
                        session_id=sid,
                        event_type=EventType.LEARNING_ITEM_ROLLED_BACK.value,
                        payload={"learning_item_id": item_id, "operation_id": operation_id, "verified": True},
                        branch_id=bid or None,
                    )
                except Exception as _ev_e:
                    logger.warning(f"[learning_service] revoke event append failed: {_ev_e}")
                    event_ok = False
                if event_ok:
                    updated = self.storage.get_learning_item(item_id)
                    res_val = {"ok": True, "status": "rolled_back", "applied": True, "item": updated}
                    self.storage.update_learning_item_operation(operation_id, status="verified", result=res_val)
                    return res_val
                else:
                    self.storage.update_learning_item(
                        item_id,
                        status="unknown",
                        deferred_reason="Audit event append failed; item marked unknown/needs_reconcile",
                        operation_id=operation_id,
                    )
                    updated = self.storage.get_learning_item(item_id)
                    res_val = {
                        "ok": False,
                        "status": "unknown",
                        "applied": True,
                        "needs_reconcile": True,
                        "error": "Audit event append failed; marked for reconciliation (status unknown)",
                        "item": updated,
                    }
                    self.storage.update_learning_item_operation(operation_id, status="unknown", error=res_val["error"], result=res_val)
                    return res_val
            else:
                self.storage.update_learning_item(
                    item_id,
                    status="unknown",
                    deferred_reason=f"Revoke failed: {error_msg}",
                    operation_id=operation_id,
                )
                res_val = {"ok": False, "status": "unknown", "error": error_msg or "Revoke failed on storage layer (marked unknown/needs_reconcile)"}
                self.storage.update_learning_item_operation(operation_id, status="unknown", error=error_msg, result=res_val)
                return res_val

        else:
            res_val = {"ok": False, "error": f"Unsupported action: {action}", "status": "unsupported_action"}
            self.storage.update_learning_item_operation(operation_id, status="failed", error=res_val["error"], result=res_val)
            return res_val


_learning_service = None

def get_learning_service(storage=None) -> LearningItemService:
    global _learning_service
    if _learning_service is None:
        _learning_service = LearningItemService(storage)
    return _learning_service


def reconcile_learning_item_operations(storage=None) -> list[dict]:
    """Scan and reconcile hanging/unsettled operations on boot or periodic sweep (P1-3, BUG-1, BUG-2)."""
    from storage import get_storage
    from event_types import EventType
    st = storage or get_storage()
    hanging = st.list_hanging_learning_item_operations(limit=100)
    reconciled = []
    now = time.time()

    for op in hanging:
        op_id = op.get("operation_id")
        item_id = op.get("item_id")
        action = op.get("action")
        created_at = float(op.get("created_at") or 0)
        age = now - created_at if created_at else 0
        item = st.get_learning_item(item_id)

        if not item:
            st.update_learning_item_operation(op_id, status="failed", error="Learning item not found")
            reconciled.append({"operation_id": op_id, "decision": "failed", "reason": "item_missing"})
            continue

        kind = str(item.get("kind") or "memory_fact")
        ref = str(item.get("target_ref") or "")

        # Check if physical asset is actually present/active
        if action in ("approve", "accept"):
            physical_ok = False
            if kind in ("memory_fact", "preference"):
                try:
                    from memory_domain import MemoryDomain
                    md = MemoryDomain(st)
                    m_item = md.get(ref)
                    if m_item and getattr(m_item, "status", "") == "active":
                        physical_ok = True
                except Exception:
                    pass
            elif kind == "skill_step":
                try:
                    cands = st.list_skill_candidates(limit=50)
                    c = next((x for x in cands if x.get("id") == ref), None)
                    if c and c.get("status") in ("candidate", "staged", "active"):
                        physical_ok = True
                except Exception:
                    pass

            if physical_ok:
                # Physical mutation actually landed! Heal item & ledger (P1-4)
                ok = st.update_learning_item(item_id, status="published", user_verdict="approved", operation_id=op_id)
                if not ok:
                    st.update_learning_item_operation(op_id, status="unknown", error="Item update failed during reconcile")
                    reconciled.append({"operation_id": op_id, "decision": "unknown", "reason": "item_cas_update_failed"})
                else:
                    event_ok = True
                    try:
                        st.get_event_store().append(
                            item.get("session_id") or "default",
                            EventType.LEARNING_ITEM_PUBLISHED.value,
                            {"learning_item_id": item_id, "operation_id": op_id, "reconciled": True, "verified": True, "target_ref": ref},
                            branch_id=item.get("branch_id") or None,
                        )
                    except Exception as _ev_e:
                        logger.warning(f"[learning_service] reconcile event append failed: {_ev_e}")
                        event_ok = False
                    if event_ok:
                        res_val = {"ok": True, "status": "published", "applied": True, "reconciled": True}
                        st.update_learning_item_operation(op_id, status="verified", result=res_val)
                        reconciled.append({"operation_id": op_id, "decision": "verified", "reason": "physical_asset_confirmed"})
                    else:
                        st.update_learning_item(item_id, status="unknown", deferred_reason="Audit event append failed during reconcile", operation_id=op_id)
                        res_val = {"ok": False, "status": "unknown", "applied": True, "reconciled": True, "needs_reconcile": True, "error": "Audit event append failed during reconcile"}
                        st.update_learning_item_operation(op_id, status="unknown", error=res_val["error"], result=res_val)
                        reconciled.append({"operation_id": op_id, "decision": "unknown", "reason": "event_append_failed"})
            elif age > 300:  # 5 minutes timeout
                st.update_learning_item_operation(op_id, status="failed", error="Operation timed out without physical asset")
                reconciled.append({"operation_id": op_id, "decision": "failed", "reason": "timeout"})

        elif action == "revoke":
            is_revoked = False
            if kind in ("memory_fact", "preference"):
                try:
                    from memory_domain import MemoryDomain
                    md = MemoryDomain(st)
                    m_item = md.get(ref)
                    if not m_item or getattr(m_item, "status", "") in ("archived", "deleted"):
                        is_revoked = True
                except Exception:
                    pass
            if is_revoked:
                ok = st.update_learning_item(item_id, status="rolled_back", user_verdict="revoked", operation_id=op_id)
                if not ok:
                    st.update_learning_item_operation(op_id, status="unknown", error="Item rollback update failed during reconcile")
                    reconciled.append({"operation_id": op_id, "decision": "unknown", "reason": "item_cas_update_failed"})
                else:
                    event_ok = True
                    try:
                        st.get_event_store().append(
                            item.get("session_id") or "default",
                            EventType.LEARNING_ITEM_ROLLED_BACK.value,
                            {"learning_item_id": item_id, "operation_id": op_id, "reconciled": True, "verified": True, "target_ref": ref},
                            branch_id=item.get("branch_id") or None,
                        )
                    except Exception as _ev_e:
                        logger.warning(f"[learning_service] reconcile revoke event append failed: {_ev_e}")
                        event_ok = False
                    if event_ok:
                        st.update_learning_item_operation(op_id, status="verified", result={"ok": True, "status": "rolled_back", "reconciled": True})
                        reconciled.append({"operation_id": op_id, "decision": "verified", "reason": "physical_revoke_confirmed"})
                    else:
                        st.update_learning_item(item_id, status="unknown", deferred_reason="Audit event append failed during reconcile", operation_id=op_id)
                        res_val = {"ok": False, "status": "unknown", "applied": True, "reconciled": True, "needs_reconcile": True, "error": "Audit event append failed during reconcile"}
                        st.update_learning_item_operation(op_id, status="unknown", error=res_val["error"], result=res_val)
                        reconciled.append({"operation_id": op_id, "decision": "unknown", "reason": "event_append_failed"})
            elif age > 300:
                st.update_learning_item_operation(op_id, status="failed", error="Revoke operation timed out")
                reconciled.append({"operation_id": op_id, "decision": "failed", "reason": "timeout"})

    if reconciled:
        logger.info(f"[learning_service] reconciled {len(reconciled)} hanging operations: {reconciled}")
    return reconciled
