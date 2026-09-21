"""providers package - IM platform providers for bot remote control.

Concrete providers are imported lazily so that a missing optional dependency
(e.g. aiohttp) or an unconfigured platform never breaks the package import.

Adding a platform means two edits here plus the provider module itself:
register the id in ``_REGISTRY`` and, if it takes inbound webhooks, add a route
in ``server/http_server.py``. Everything downstream — controller dispatch,
message logging, the settings UI status list — reads off this registry.
"""
from providers.base import IMProvider

__all__ = ["IMProvider", "get_provider", "available_providers"]


#: platform id -> (module, class name). Lazy on purpose: importing every
#: provider up front would drag optional deps into the boot path of a user who
#: only ever configures one platform.
_REGISTRY: dict[str, tuple[str, str]] = {
    "telegram": ("providers.telegram_provider", "TelegramProvider"),
    "feishu": ("providers.feishu_provider", "FeishuProvider"),
    "dingtalk": ("providers.dingtalk_provider", "DingTalkProvider"),
    "wecom": ("providers.wecom_provider", "WeComProvider"),
    "slack": ("providers.slack_provider", "SlackProvider"),
    "discord": ("providers.discord_provider", "DiscordProvider"),
}


def available_providers() -> list[str]:
    """List the platform ids this package can construct.

    Order is the display order in the UI: the two platforms that shipped first
    stay first so an existing user's tab does not move under them.
    """
    return list(_REGISTRY.keys())


def get_provider(platform: str, **kwargs) -> IMProvider:
    """Construct a provider by platform id.

    Args:
        platform: One of ``available_providers()``.
        **kwargs: Forwarded to the provider constructor.

    Returns:
        An IMProvider instance.

    Raises:
        ValueError: If the platform id is unknown.
    """
    entry = _REGISTRY.get((platform or "").lower())
    if entry is None:
        raise ValueError(f"Unknown IM platform: {platform}")
    module_name, class_name = entry
    module = __import__(module_name, fromlist=[class_name])
    return getattr(module, class_name)(**kwargs)
