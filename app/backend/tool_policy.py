"""
tool_policy.py - Composable multi-layer tool authorization pipeline (B4).

Ends the "permission combination explosion" problem: instead of one big
if/else in RiskController, authorization walks an ordered pipeline of small,
labelled layers. Each layer returns allow / ask / deny (or abstains). The
first layer that returns a non-allow verdict wins, and every step is recorded
in an audit trail so we can answer "why was this blocked?".

Layer order (least-specific → most-specific, first non-allow wins):
    profile → provider-profile → global → global-provider → agent →
    agent-provider → group → sender → sandbox → subagent → inherited

Each layer is a small callable ``(request) -> PolicyDecision | None``. Returning
None (or an ``ALLOW``) means "I have no objection, ask the next layer". A layer
that wants to stop the walk returns ``ask`` or ``deny``. ``deny`` is terminal;
``ask`` can still be upgraded to ``deny`` by a later, stricter layer but never
downgraded back to ``allow`` — strictness only ratchets up.

The pipeline is intentionally provider-agnostic and side-effect free: it never
touches the event bus, never prompts the user, never runs a tool. RiskController
owns those concerns and consults this pipeline for the verdict.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Optional


class PolicyLayer(str, Enum):
    """The ordered authorization layers. String values double as audit labels."""

    PROFILE = "profile"
    PROVIDER_PROFILE = "provider-profile"
    GLOBAL = "global"
    GLOBAL_PROVIDER = "global-provider"
    AGENT = "agent"
    AGENT_PROVIDER = "agent-provider"
    GROUP = "group"
    SENDER = "sender"
    SANDBOX = "sandbox"
    SUBAGENT = "subagent"
    INHERITED = "inherited"


#: Canonical evaluation order. The pipeline walks layers in this sequence.
LAYER_ORDER: tuple[PolicyLayer, ...] = (
    PolicyLayer.PROFILE,
    PolicyLayer.PROVIDER_PROFILE,
    PolicyLayer.GLOBAL,
    PolicyLayer.GLOBAL_PROVIDER,
    PolicyLayer.AGENT,
    PolicyLayer.AGENT_PROVIDER,
    PolicyLayer.GROUP,
    PolicyLayer.SENDER,
    PolicyLayer.SANDBOX,
    PolicyLayer.SUBAGENT,
    PolicyLayer.INHERITED,
)


class PolicyAction(str, Enum):
    """A single layer's verdict. Strictness order: ALLOW < ASK < DENY.

    CLEAR is special: it explicitly cancels a prior ASK (but not DENY), used by
    the "granted-permission" layer so an earlier ask can be overridden by a later
    explicit allow. The pipeline must only treat CLEAR as lowering ASK→ALLOW; it
    cannot touch DENY.
    """

    ALLOW = "allow"
    ASK = "ask"
    DENY = "deny"
    CLEAR = "clear"


#: Numeric strictness so we can ratchet: a later layer may raise but not lower.
_STRICTNESS = {PolicyAction.ALLOW: 0, PolicyAction.ASK: 1, PolicyAction.DENY: 2, PolicyAction.CLEAR: -1}


@dataclass
class PolicyRequest:
    """Everything a layer needs to make a decision. Read-only by convention."""

    tool_name: str
    args: dict = field(default_factory=dict)
    context: dict = field(default_factory=dict)
    risk_level: str = ""  # low / medium / high, as classified upstream
    provider: str = ""    # llm provider id, for provider-scoped layers
    agent: str = ""       # owning agent role, for agent-scoped layers

    def flag(self, key: str, default: Any = None) -> Any:
        """Read a context flag (session_id, is_remote, is_subagent, ...)."""
        return self.context.get(key, default)


@dataclass
class PolicyDecision:
    """A layer's verdict plus the label/reason that produced it (for audit)."""

    action: PolicyAction
    layer: PolicyLayer
    label: str = ""
    reason: str = ""

    @property
    def is_allow(self) -> bool:
        return self.action == PolicyAction.ALLOW

    def to_dict(self) -> dict:
        return {
            "action": self.action.value,
            "layer": self.layer.value,
            "label": self.label,
            "reason": self.reason,
        }


#: A layer is any callable that inspects a request and optionally objects.
#: Return None to abstain (equivalent to allowing and deferring to later layers).
PolicyLayerFn = Callable[[PolicyRequest], Optional[PolicyDecision]]


@dataclass
class PipelineResult:
    """Final verdict of a full pipeline walk, with the complete audit trail."""

    action: PolicyAction
    decision: Optional[PolicyDecision]  # the winning (strictest) decision
    trail: list[dict] = field(default_factory=list)

    @property
    def allowed(self) -> bool:
        return self.action == PolicyAction.ALLOW

    @property
    def reason(self) -> str:
        return self.decision.reason if self.decision else ""

    @property
    def label(self) -> str:
        return self.decision.label if self.decision else ""


class ToolPolicyPipeline:
    """Ordered, composable set of authorization layers.

    Register a callable against a :class:`PolicyLayer`; ``evaluate`` walks the
    layers in :data:`LAYER_ORDER`, collecting every non-abstaining verdict into
    an audit trail and returning the strictest one. ``deny`` short-circuits the
    walk (nothing can override a hard deny); ``ask`` keeps walking in case a
    later layer escalates to ``deny``.
    """

    def __init__(self) -> None:
        # layer -> ordered list of (label, fn). Multiple fns per layer are
        # allowed; they run in registration order and the strictest wins.
        self._layers: dict[PolicyLayer, list[tuple[str, PolicyLayerFn]]] = {}

    def register(self, layer: PolicyLayer, fn: PolicyLayerFn, label: str = "") -> None:
        """Attach a decision function to a layer.

        Args:
            layer: Which pipeline stage this function belongs to.
            fn: ``(request) -> PolicyDecision | None``. None = abstain.
            label: Short human tag for the audit trail (defaults to layer name).
        """
        self._layers.setdefault(layer, []).append((label or layer.value, fn))

    def clear(self, layer: Optional[PolicyLayer] = None) -> None:
        """Remove all functions for a layer, or the whole pipeline when None."""
        if layer is None:
            self._layers.clear()
        else:
            self._layers.pop(layer, None)

    def evaluate(self, request: PolicyRequest) -> PipelineResult:
        """Walk every layer in order and return the strictest verdict.

        A ``deny`` from any layer terminates the walk immediately. A ``CLEAR``
        from a later layer downgrades a prior ``ASK`` back to ``ALLOW`` (but
        cannot rescue a ``DENY``). Otherwise the strictest verdict across all
        layers wins; ties keep the earliest layer.
        """
        trail: list[dict] = []
        winner: Optional[PolicyDecision] = None

        for layer in LAYER_ORDER:
            for label, fn in self._layers.get(layer, []):
                try:
                    decision = fn(request)
                except Exception as exc:  # a broken layer must fail safe (deny)
                    decision = PolicyDecision(
                        action=PolicyAction.DENY,
                        layer=layer,
                        label=label,
                        reason=f"policy layer error: {exc}",
                    )
                if decision is None:
                    continue
                # Normalize the label/layer so callers always see consistent data.
                decision.layer = layer
                decision.label = decision.label or label
                trail.append(decision.to_dict())

                if decision.action == PolicyAction.CLEAR:
                    # CLEAR downgrades an earlier ASK → ALLOW. Has no effect if
                    # no prior ASK exists, or if the prior was DENY (untouchable).
                    if winner is not None and winner.action == PolicyAction.ASK:
                        winner = None
                    continue

                if decision.is_allow:
                    continue  # explicit allow is just an abstain that got logged

                # First non-allow, or a stricter verdict than what we have.
                if winner is None or _STRICTNESS[decision.action] > _STRICTNESS[winner.action]:
                    winner = decision

                if decision.action == PolicyAction.DENY:
                    # Hard deny is terminal — stop the whole walk.
                    return PipelineResult(action=PolicyAction.DENY, decision=winner, trail=trail)

        action = winner.action if winner else PolicyAction.ALLOW
        return PipelineResult(action=action, decision=winner, trail=trail)


# --------------------------------------------------------------------------- #
# Built-in layer factories                                                    #
# --------------------------------------------------------------------------- #

def make_global_risk_layer(classify: Callable[[str, dict], str],
                           needs_approval: Callable[[str, dict], bool]) -> PolicyLayerFn:
    """Build the GLOBAL layer from RiskController's existing risk table.

    Keeps the least-privilege table as the baseline policy: low risk allows,
    anything needing approval asks. This lets RiskController delegate its core
    logic to the pipeline without changing behavior.

    Args:
        classify: ``(tool_name, args) -> "low"|"medium"|"high"``.
        needs_approval: ``(tool_name, args) -> bool`` from the active mode.
    """
    def _layer(req: PolicyRequest) -> Optional[PolicyDecision]:
        level = classify(req.tool_name, req.args)
        if not needs_approval(req.tool_name, req.args):
            return None  # abstain — baseline is fine with it
        return PolicyDecision(
            action=PolicyAction.ASK,
            layer=PolicyLayer.GLOBAL,
            label=f"risk:{level}",
            reason=f"{req.tool_name} is {level}-risk and needs confirmation",
        )
    return _layer


def make_denylist_layer(layer: PolicyLayer,
                        is_denied: Callable[[PolicyRequest], bool],
                        label: str = "denylist",
                        reason: str = "") -> PolicyLayerFn:
    """Build a hard-deny layer from a predicate (e.g. remote-session denylist)."""
    def _layer(req: PolicyRequest) -> Optional[PolicyDecision]:
        if is_denied(req):
            return PolicyDecision(
                action=PolicyAction.DENY,
                layer=layer,
                label=label,
                reason=reason or f"'{req.tool_name}' denied by {label}",
            )
        return None
    return _layer


#: The context flag the SANDBOX layer gates on.
SANDBOX_READONLY_FLAG = "sandbox_readonly"

#: Subsystems that have declared they can turn `sandbox_readonly` on.
#:
#: Why this exists: the SANDBOX layer below is registered in the pipeline and
#: reads like a working confinement layer, but nothing in the tree ever sets its
#: flag — `run_confined` has zero call sites and `sandbox.py` is imported by
#: nobody. A security layer that can never fire is worse than an absent one,
#: because the pipeline listing it makes everyone (including the next reader of
#: this file) believe confinement exists. Rather than hardcode "off" — which
#: would go stale the moment someone implements it — the flag's writer registers
#: itself here, and `sandbox_layer_status()` tells the truth either way.
_sandbox_flag_writers: set[str] = set()


def declare_sandbox_flag_writer(who: str) -> None:
    """Declare that ``who`` sets ``sandbox_readonly`` on tool contexts.

    Call this from whatever finally implements confinement (e.g. the module that
    runs tools inside a restricted interpreter). Once anything registers, the
    startup warning and the settings-page notice disappear on their own.
    """
    if who:
        _sandbox_flag_writers.add(who)


def sandbox_layer_status() -> dict:
    """Whether the SANDBOX policy layer can actually deny anything."""
    writers = sorted(_sandbox_flag_writers)
    return {
        "registered": True,          # the layer is always installed
        "effective": bool(writers),  # …but only decides if someone raises the flag
        "flag": SANDBOX_READONLY_FLAG,
        "writers": writers,
        "note": (
            "沙箱只读层已注册但当前不生效：没有任何代码设置 "
            f"`{SANDBOX_READONLY_FLAG}` 标志。工具的实际约束来自权限档位、"
            "danger_classifier 与 path_guard，不要把这一层算进防护。"
            if not writers else
            "沙箱只读层生效中。"
        ),
    }


def make_sandbox_layer(readonly_tools: set[str]) -> PolicyLayerFn:
    """SANDBOX layer: in a read-only sandbox, only whitelisted reads pass.

    Currently inert — see ``sandbox_layer_status``. Kept registered so the
    pipeline's shape does not change when confinement lands.
    """
    def _layer(req: PolicyRequest) -> Optional[PolicyDecision]:
        if not req.flag(SANDBOX_READONLY_FLAG):
            return None
        if req.tool_name in readonly_tools or req.risk_level == "low":
            return None
        return PolicyDecision(
            action=PolicyAction.DENY,
            layer=PolicyLayer.SANDBOX,
            label="sandbox:readonly",
            reason="sandbox is read-only; only read operations are allowed",
        )
    return _layer



def make_subagent_layer(denied_tools: set[str]) -> PolicyLayerFn:
    """SUBAGENT layer: subagents can't dispatch further or touch fenced tools."""
    def _layer(req: PolicyRequest) -> Optional[PolicyDecision]:
        if not req.flag("is_subagent"):
            return None
        if req.tool_name in denied_tools:
            return PolicyDecision(
                action=PolicyAction.DENY,
                layer=PolicyLayer.SUBAGENT,
                label="subagent:fenced",
                reason=f"subagents may not call '{req.tool_name}'",
            )
        return None
    return _layer
