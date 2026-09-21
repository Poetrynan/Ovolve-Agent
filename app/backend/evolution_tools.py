"""evolution_tools.py - Ovolve self-evolution tools and draft manager.

Provides:
- EvolutionDraftManager: Manages 3-state proposal drafts (.ovolve/evolution/{pending,approved,rejected})
  with Payload-Hash and Content-Hash anti-tamper verification.
- propose_evolution_rule: Tool for Agent to actively propose evolution rules in chat.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from evolution import (
    EvolutionEngine,
    EvolutionStore,
    Proposal,
    ALLOWED_TARGETS,
    KIND_TARGET,
    format_rule_line,
    normalize_error,
)


class EvolutionDraftManager:
    """Manages 3-state evolution drafts on disk:
    .ovolve/evolution/pending/<id>.json
    .ovolve/evolution/approved/<id>.json
    .ovolve/evolution/rejected/<id>.json
    """

    def __init__(self, workspace_root: Optional[str] = None):
        self.workspace_root = workspace_root or os.getcwd()
        self.base_dir = os.path.join(self.workspace_root, ".ovolve", "evolution")
        self.pending_dir = os.path.join(self.base_dir, "pending")
        self.approved_dir = os.path.join(self.base_dir, "approved")
        self.rejected_dir = os.path.join(self.base_dir, "rejected")
        for d in (self.pending_dir, self.approved_dir, self.rejected_dir):
            os.makedirs(d, exist_ok=True)

    @staticmethod
    def compute_hashes(proposal_meta: dict, proposed_change: str) -> tuple[str, str]:
        """Compute Payload-Hash and Content-Hash for tamper detection."""
        meta_str = json.dumps(proposal_meta, sort_keys=True, ensure_ascii=False)
        payload_hash = hashlib.sha256(meta_str.encode("utf-8")).hexdigest()
        content_hash = hashlib.sha256(proposed_change.strip().encode("utf-8")).hexdigest()
        return payload_hash, content_hash

    def save_pending_draft(
        self,
        proposal: Proposal,
        trigger_type: str = "preference",
        confidence: str = "high",
        delivery_mode: str = "card",
    ) -> dict[str, Any]:
        """Save proposal draft to pending/ directory with dual hashes."""
        prop_meta = {
            "id": proposal.id,
            "signature": proposal.signature,
            "target": proposal.target_file,
            "trigger_type": trigger_type,
            "confidence": confidence,
            "tool": proposal.tool_name,
            "kind": proposal.kind,
        }
        payload_hash, content_hash = self.compute_hashes(prop_meta, proposal.draft)

        draft_data = {
            "proposal_id": proposal.id,
            "status": "pending",
            "signature": proposal.signature,
            "created_at": proposal.created_at,
            "target_file": proposal.target_file,
            "trigger_type": trigger_type,
            "confidence": confidence,
            "payload_hash": payload_hash,
            "content_hash": content_hash,
            "reason": proposal.rationale,
            "proposed_change": proposal.draft,
            "delivery_mode": delivery_mode,
            "user_title": getattr(proposal, "user_title", "") or getattr(proposal, "title", ""),
            "user_advice": getattr(proposal, "user_advice", "") or getattr(proposal, "advice", ""),
            "user_reason": getattr(proposal, "user_reason", "") or getattr(proposal, "reason", ""),
            "category": getattr(proposal, "category", "custom"),
        }

        path = os.path.join(self.pending_dir, f"{proposal.id}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(draft_data, f, indent=2, ensure_ascii=False)

        return draft_data

    def get_draft(self, proposal_id: str) -> Optional[dict]:
        """Read draft across pending, approved, or rejected."""
        for d in (self.pending_dir, self.approved_dir, self.rejected_dir):
            p = os.path.join(d, f"{proposal_id}.json")
            if os.path.isfile(p):
                try:
                    with open(p, "r", encoding="utf-8") as f:
                        return json.load(f)
                except Exception:
                    return None
        return None

    def mark_approved(self, proposal_id: str) -> bool:
        """Move draft from pending/ to approved/."""
        src = os.path.join(self.pending_dir, f"{proposal_id}.json")
        dst = os.path.join(self.approved_dir, f"{proposal_id}.json")
        if os.path.isfile(src):
            try:
                with open(src, "r", encoding="utf-8") as f:
                    data = json.load(f)
                data["status"] = "approved"
                data["decided_at"] = time.time()
                with open(dst, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
                os.remove(src)
                return True
            except Exception:
                return False
        return False

    def mark_rejected(self, proposal_id: str) -> bool:
        """Move draft from pending/ to rejected/."""
        src = os.path.join(self.pending_dir, f"{proposal_id}.json")
        dst = os.path.join(self.rejected_dir, f"{proposal_id}.json")
        if os.path.isfile(src):
            try:
                with open(src, "r", encoding="utf-8") as f:
                    data = json.load(f)
                data["status"] = "rejected"
                data["decided_at"] = time.time()
                with open(dst, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
                os.remove(src)
                return True
            except Exception:
                return False
        return False


def propose_evolution_rule(
    target: str,
    signature: str,
    trigger_type: str = "preference",
    confidence: str = "high",
    reason: str = "",
    proposed_change: str = "",
    delivery_mode: str = "card",
    workspace_root: Optional[str] = None,
    engine: Optional[EvolutionEngine] = None,
    session_id: str = "",
) -> dict[str, Any]:
    """Agent tool: actively propose an evolution rule with in-chat card delivery mode."""
    target_clean = (target or "").strip()
    if target_clean not in ALLOWED_TARGETS:
        return {
            "status": "error",
            "error": f"Target '{target}' is not in allowed targets: {sorted(ALLOWED_TARGETS)}",
        }

    ws_root = workspace_root or (engine.workspace_root if engine else os.getcwd())
    draft_mgr = EvolutionDraftManager(workspace_root=ws_root)

    # Initialize engine if not provided
    if engine is None:
        try:
            from storage import get_storage
            st = get_storage()
            engine = EvolutionEngine(workspace_root=ws_root, storage=st)
        except Exception:
            engine = EvolutionEngine(workspace_root=ws_root)

    sig = (signature or "").strip().lower()
    if not sig:
        sig = f"rule-{uuid.uuid4().hex[:8]}"

    # Check cooldown
    last_rej = engine.store.last_rejected_at(sig)
    if last_rej and (time.time() - last_rej) < 14 * 86400:
        return {
            "status": "skipped",
            "reason": f"Signature '{sig}' was rejected within 14-day cooldown window",
        }

    prop_id = f"evo-{time.strftime('%Y%m%d')}-{uuid.uuid4().hex[:6]}"
    formatted_change = proposed_change.strip()
    if not formatted_change.startswith("-"):
        formatted_change = f"- {formatted_change}"

    rule_line = format_rule_line(formatted_change, rule_id=prop_id, hits=1, last_date=time.strftime("%Y-%m-%d"))

    proposal = Proposal(
        id=prop_id,
        signature=sig,
        kind="user_correction" if trigger_type == "correction" else "learned_fact",
        tool_name="propose_evolution_rule",
        target_file=target_clean,
        draft=rule_line,
        rationale=reason or f"Agent proposed via {trigger_type}",
        hits=1,
        status="pending",
        created_at=time.time(),
        user_title=f"自进化规则：{sig}",
        user_advice=formatted_change,
        user_reason=reason or "根据会话交互总结出的持续规则",
        category="custom",
    )

    engine.store.insert_proposal(proposal)
    draft_info = draft_mgr.save_pending_draft(
        proposal,
        trigger_type=trigger_type,
        confidence=confidence,
        delivery_mode=delivery_mode,
    )

    # Broadcast on EventBus if available
    try:
        from event_bus import get_event_bus
        bus = get_event_bus()
        bus.emit_sync(
            "evolution_proposal",
            {
                "proposalId": prop_id,
                "proposal": draft_info,
                "sessionId": session_id,
                "deliveryMode": delivery_mode,
                "openCount": engine.store.count_open(),
            },
        )
    except Exception:
        pass

    return {
        "status": "proposed",
        "proposal_id": prop_id,
        "delivery_mode": delivery_mode,
        "payload_hash": draft_info["payload_hash"],
        "content_hash": draft_info["content_hash"],
        "target": target_clean,
        "signature": sig,
        "proposed_change": formatted_change,
        "reason": reason,
    }
