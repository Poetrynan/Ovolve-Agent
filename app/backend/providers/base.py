"""providers/base.py - IMProvider abstract base class."""
from abc import ABC, abstractmethod
from typing import Any, AsyncGenerator


class IMProvider(ABC):
    """Abstract base class for IM platform providers."""

    @abstractmethod
    async def start_listening(self, controller: Any) -> None:
        """Start listening for incoming messages."""
        ...

    @abstractmethod
    async def stop_listening(self) -> None:
        """Stop listening for incoming messages."""
        ...

    @abstractmethod
    async def send_message(self, user_id: str, content: str) -> bool:
        """Send a text message to a user."""
        ...

    @abstractmethod
    async def send_streaming_card(
        self, user_id: str, content_stream: AsyncGenerator[str, None]
    ) -> bool:
        """Send a streaming message (typewriter effect)."""
        ...

    @abstractmethod
    def get_platform_id(self) -> str:
        """Return the platform identifier string."""
        ...

    def is_configured(self) -> bool:
        """Check if this provider has valid credentials."""
        return True
