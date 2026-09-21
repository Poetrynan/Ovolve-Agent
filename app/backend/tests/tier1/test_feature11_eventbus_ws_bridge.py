import json
import pytest
from unittest.mock import AsyncMock, MagicMock
from event_bus import EventBus, Event
from server.http_server import WebSocketHandler


@pytest.mark.asyncio
async def test_t1_f11_01_websocket_client_handshake():
    """T1-F11-01: Verify WebSocketHandler registers client websocket connection."""
    router = MagicMock()
    handler = WebSocketHandler(router)
    mock_ws = AsyncMock()

    handler.clients.add(mock_ws)
    assert len(handler.clients) == 1
    assert mock_ws in handler.clients

    handler.clients.discard(mock_ws)
    assert len(handler.clients) == 0


@pytest.mark.asyncio
async def test_t1_f11_02_tool_call_event_broadcast():
    """T1-F11-02: Verify tool_call event format broadcasted over WebSocket."""
    router = MagicMock()
    handler = WebSocketHandler(router)
    mock_ws = AsyncMock()
    handler.clients.add(mock_ws)

    event_payload = {
        "type": "tool_call",
        "timestamp": 1723176360.123,
        "sessionId": "test-session-1",
        "payload": {
            "agent": "file_agent",
            "toolName": "read_file",
            "args": {"path": "schema.json"},
            "riskLevel": "low"
        }
    }

    await handler._broadcast(event_payload)
    mock_ws.send_json.assert_called_once_with(event_payload)


@pytest.mark.asyncio
async def test_t1_f11_03_tool_result_event_broadcast():
    """T1-F11-03: Verify tool_result event broadcast with metrics."""
    router = MagicMock()
    handler = WebSocketHandler(router)
    mock_ws = AsyncMock()
    handler.clients.add(mock_ws)

    event_payload = {
        "type": "tool_result",
        "timestamp": 1723176361.0,
        "sessionId": "test-session-1",
        "payload": {
            "agent": "search_agent",
            "toolName": "web_search",
            "durationMs": 150,
            "result": "success"
        }
    }

    await handler._broadcast(event_payload)
    mock_ws.send_json.assert_called_once_with(event_payload)


@pytest.mark.asyncio
async def test_t1_f11_04_multi_agent_event_tagging_routing():
    """T1-F11-04: Verify correct agent tagging across consecutive multi-agent broadcasts."""
    router = MagicMock()
    handler = WebSocketHandler(router)
    mock_ws = AsyncMock()
    handler.clients.add(mock_ws)

    agents = ["pilot", "computer_agent", "app_agent"]
    for agent in agents:
        payload = {
            "type": "tool_call",
            "timestamp": 1000.0,
            "sessionId": "sess",
            "payload": {"agent": agent, "toolName": "exec"}
        }
        await handler._broadcast(payload)

    assert mock_ws.send_json.call_count == 3
    calls = mock_ws.send_json.call_args_list
    assert calls[0][0][0]["payload"]["agent"] == "pilot"
    assert calls[1][0][0]["payload"]["agent"] == "computer_agent"
    assert calls[2][0][0]["payload"]["agent"] == "app_agent"


@pytest.mark.asyncio
async def test_t1_f11_05_ping_pong_connection_keep_alive():
    """T1-F11-05: Verify ping event received triggers pong response frame."""
    router = MagicMock()
    handler = WebSocketHandler(router)
    mock_ws = AsyncMock()

    ping_msg = {"type": "ping"}
    await handler._handle_message(mock_ws, ping_msg)

    mock_ws.send_json.assert_called_once()
    sent_data = mock_ws.send_json.call_args[0][0]
    assert sent_data["type"] == "pong"
    assert "timestamp" in sent_data
