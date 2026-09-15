"""
episode_manager.py — 会话主题片段 (ConversationEpisode) 管理器。

§13.4 & §13.5:
1. 一个 Session 是一个独立的对话世界；
2. 同一 Session 内部按主题、意图、事件边界、Goal 切换或显式换题，划分为多个相互独立的 Episode；
3. 每个 Episode 独立追踪关联的 Turn 列表，封存 (seal) 后触发独立 LearningItem 观察与证据束物化；
4. 严格杜绝使用每条用户消息前 50 字切分主题，依据 last_activity_at 计算超时，支持 session+branch 隔离。
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional
from storage import get_storage


EPISODE_IDLE_TIMEOUT_SEC = 1800.0  # 30 minutes of inactivity -> new episode


def detect_topic_shift(prompt: str, current_topic: str = "") -> Optional[str]:
    """Lightweight, local interpretable topic shift detection without external dependencies (P1-7)."""
    p = str(prompt or "").strip()
    if not p:
        return None
    lower_p = p.lower()

    # Explicit switch cues
    shift_markers = ("换个话题", "新建主题", "另外问一个", "另外讨论", "新的任务", "切换到", "/newtopic", "reset topic", "new topic:")
    for marker in shift_markers:
        if marker in lower_p:
            cleaned = p.split(marker)[-1].strip(" :：，,。")
            return cleaned[:40] if cleaned else "New Topic"

    # Domain tag prefix cues, e.g. [Frontend] or [Database]
    if p.startswith("[") and "]" in p:
        tag = p[1:p.index("]")].strip()
        if tag and tag.lower() != (current_topic or "").lower():
            return tag

    return None


class EpisodeManager:
    """Session-level conversation episode manager with hard session & branch isolation."""

    def __init__(self, storage=None):
        self._storage = storage or get_storage()

    def get_or_create_active_episode(self, session_id: str, topic: str = "",
                                     goal_id: str = "", branch_id: str = "",
                                     prompt: str = "") -> dict:
        """Get current active episode or create a fresh one."""
        if not session_id:
            return {}
        ep = self._storage.get_active_episode(session_id, branch_id or "")
        now = time.time()

        # P1-7: Check for interpretable topic shift from prompt if active episode exists
        inferred_topic = topic
        if ep and prompt and not topic:
            detected = detect_topic_shift(prompt, ep.get("topic", ""))
            if detected:
                inferred_topic = detected

        if ep:
            last_act = float(ep.get("last_activity_at") or ep.get("started_at") or now)
            # Check if idle timeout exceeded on last activity
            if (now - last_act) > EPISODE_IDLE_TIMEOUT_SEC and not ep.get("goal_id"):
                self.seal_episode_once(ep["episode_id"], reason="idle_timeout")
                ep = None
            elif goal_id and ep.get("goal_id") and ep.get("goal_id") != goal_id:
                # Goal changed -> switch episode
                self.seal_episode_once(ep["episode_id"], reason="goal_switch")
                ep = None
            elif inferred_topic and ep.get("topic") and inferred_topic.lower() != ep.get("topic", "").lower() and inferred_topic != "General Dialogue":
                # Explicit topic shift
                self.seal_episode_once(ep["episode_id"], reason="topic_shift")
                ep = None

        if not ep:
            eid = self._storage.create_episode(
                session_id=session_id,
                topic=topic or "General Dialogue",
                goal_id=goal_id or "",
                branch_id=branch_id or "",
                metadata={"created_reason": "active_demand"}
            )
            ep = self._storage.get_episode(eid)
            # Emit episode.started event
            try:
                from event_types import EventType
                es = self._storage.get_event_store()
                es.append(
                    event_type=EventType.EPISODE_STARTED.value,
                    session_id=session_id,
                    payload={"episode_id": eid, "topic": topic or "General Dialogue", "goal_id": goal_id, "branch_id": branch_id or ""},
                    branch_id=branch_id or None,
                    goal_id=goal_id or None,
                )
            except Exception:
                pass

        return ep or {}

    def record_turn(self, session_id: str, turn_id: str, topic: str = "",
                    goal_id: str = "", branch_id: str = "", prompt: str = "") -> str:
        """Ensure turn is bound to an active episode, returns episode_id."""
        if not (session_id and turn_id):
            return ""
        ep = self.get_or_create_active_episode(session_id, topic=topic, goal_id=goal_id, branch_id=branch_id, prompt=prompt)
        eid = str(ep.get("episode_id") or "")
        if eid:
            self._storage.append_turn_to_episode(eid, turn_id)
        return eid

    def seal_episode_once(self, episode_id: str, reason: str = "", event_id: str = "") -> bool:
        """Seal an episode once (idempotent), record reason, emit event, and trigger learning loop."""
        if not episode_id:
            return False
        ep = self._storage.get_episode(episode_id)
        if not ep or ep.get("status") == "sealed":
            return True

        ok = self._storage.seal_episode(episode_id, reason=reason or "manual", event_id=event_id)
        if ok:
            sid = str(ep.get("session_id") or "")
            bid = str(ep.get("branch_id") or "")
            try:
                from event_types import EventType
                es = self._storage.get_event_store()
                es.append(
                    event_type=EventType.EPISODE_SEALED.value,
                    session_id=sid,
                    payload={
                        "episode_id": episode_id,
                        "branch_id": bid,
                        "reason": reason,
                        "turn_count": len(ep.get("turn_ids", [])),
                        "generation": ep.get("generation", 1),
                    },
                    branch_id=bid or None,
                    goal_id=ep.get("goal_id") or None,
                )
            except Exception:
                pass
            # Trigger learning observation for sealed episode if evolution engine is enabled
            try:
                import evolution
                engine = evolution.get_evolution_engine()
                if engine and engine.enabled():
                    # Refresh episode record with sealed status
                    sealed_ep = self._storage.get_episode(episode_id) or ep
                    engine.observe_episode_completion(sealed_ep)
            except Exception as _obs_e:
                print(f"[episode_manager] observe_episode_completion failed: {_obs_e}")
        return ok

    def seal_episode(self, episode_id: str, reason: str = "") -> bool:
        """Alias for seal_episode_once."""
        return self.seal_episode_once(episode_id, reason=reason)

    def check_idle_episodes(self, idle_timeout_s: float = EPISODE_IDLE_TIMEOUT_SEC) -> list[str]:
        """Check all active episodes across sessions and seal any that have been idle for > idle_timeout_s."""
        now = time.time()
        sealed_ids = []
        try:
            active_eps = self._storage.list_active_episodes(limit=100)
            for ep in active_eps:
                last_act = float(ep.get("last_activity_at") or ep.get("started_at") or now)
                if (now - last_act) > idle_timeout_s and not ep.get("goal_id"):
                    eid = ep.get("episode_id")
                    if eid and self.seal_episode_once(eid, reason="idle_timeout"):
                        sealed_ids.append(eid)
        except Exception as e:
            print(f"[episode_manager] check_idle_episodes error: {e}")
        return sealed_ids


_episode_manager = None

def get_episode_manager(storage=None) -> EpisodeManager:
    global _episode_manager
    if _episode_manager is None:
        _episode_manager = EpisodeManager(storage)
    return _episode_manager
