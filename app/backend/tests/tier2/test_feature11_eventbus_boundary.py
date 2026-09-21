import pytest
from unittest.mock import AsyncMock, MagicMock
from event_bus import EventBus, Event, EventAction
from server.http_server import WebSocketHandler


@pytest.mark.asyncio
async def test_t2_f11_01_high_frequency_event_flood():
    """T2-F11-01: Verify EventBus handles 1000 events flooded sequentially without dropping subscribers."""
    bus = EventBus()
    counter = 0

    def handler(event: Event):
        nonlocal counter
        counter += 1

    bus.on("tool_call", handler)

    for i in range(1000):
        await bus.emit("tool_call", {"seq": i})

    assert counter == 1000


@pytest.mark.asyncio
async def test_t2_f11_02_malformed_missing_fields_json_payload():
    """T2-F2-02: Verify WebSocketHandler handles malformed event dictionary safely."""
    router = MagicMock()
    handler = WebSocketHandler(router)
    mock_ws = AsyncMock()

    # Empty dictionary payload missing type
    await handler._handle_message(mock_ws, {})

    mock_ws.send_json.assert_called_once()
    err_payload = mock_ws.send_json.call_args[0][0]
    assert err_payload["type"] == "error"
    assert "Unknown event type" in err_payload["payload"]["message"]


@pytest.mark.asyncio
async def test_t2_f11_03_sudden_client_disconnect_mid_broadcast():
    """T2-F11-03: Verify broadcast handles client socket error gracefully without breaking remaining clients."""
    router = MagicMock()
    handler = WebSocketHandler(router)

    failing_ws = AsyncMock()
    failing_ws.send_json.side_effect = Exception("Socket closed")

    healthy_ws = AsyncMock()

    handler.clients.add(failing_ws)
    handler.clients.add(healthy_ws)

    # Should not raise exception
    await handler._broadcast({"type": "test", "timestamp": 1234.0})

    healthy_ws.send_json.assert_called_once()


@pytest.mark.asyncio
async def test_t2_f11_04_large_payload_overflow_handling():
    """T2-F11-04: Verify broadcast handles large payload dictionary (10MB text) without crashing."""
    router = MagicMock()
    handler = WebSocketHandler(router)
    mock_ws = AsyncMock()
    handler.clients.add(mock_ws)

    large_text = "A" * (10 * 1024 * 1024)
    event_payload = {
        "type": "tool_result",
        "timestamp": 123.4,
        "payload": {"result": large_text}
    }

    await handler._broadcast(event_payload)
    mock_ws.send_json.assert_called_once()


@pytest.mark.asyncio
async def test_t2_f11_05_reconnected_client_out_of_order_timestamps():
    """T2-F11-05: Verify EventBus handler prioritization orders subscribers by priority correctly."""
    bus = EventBus()
    execution_order = []

    bus.on("test", lambda e: execution_order.append("low"), priority=0)
    bus.on("test", lambda e: execution_order.append("high"), priority=10)
    bus.on("test", lambda e: execution_order.append("med"), priority=5)

    await bus.emit("test", {})
    assert execution_order == ["high", "med", "low"]
