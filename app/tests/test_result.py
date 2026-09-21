"""Test Result type and pattern compliance."""
import pytest
from result import Result, try_result


def test_result_success():
    """Test success Result creation."""
    r = Result.success("test value", key="metadata")
    assert r.ok == True
    assert r.value == "test value"
    assert r.meta["key"] == "metadata"


def test_result_failure():
    """Test failure Result creation."""
    r = Result.failure("error message")
    assert r.ok == False
    assert r.error == "error message"


def test_result_map():
    """Result.map: transform on success."""
    r = Result.success(5)
    r2 = r.map(lambda x: x * 2)
    assert r2.ok == True
    assert r2.value == 10


def test_result_map_failure_passthrough():
    """Result.map on failure: transparently passes through."""
    r = Result.failure("nope")
    r2 = r.map(lambda x: x * 2)
    assert r2.ok == False
    assert r2.error == "nope"


def test_result_and_then():
    """Result.and_then: chain Results."""
    def double(x):
        return Result.success(x * 2)

    r = Result.success(5)
    r2 = r.and_then(double)
    assert r2.ok == True
    assert r2.value == 10


def test_result_or_else():
    """Result.or_else: default on failure."""
    r = Result.failure("error")
    assert r.or_else("default") == "default"

    r = Result.success("value")
    assert r.or_else("default") == "value"


def test_try_result():
    """try_result: wrap exceptions into Result."""
    def safe_div(a, b):
        return a / b

    r = try_result(safe_div, 10, 2)
    assert r.ok == True
    assert r.value == 5.0

    r = try_result(safe_div, 10, 0)
    assert r.ok == False
    assert "division" in r.error.lower()


def test_result_bool():
    """Result bool conversion: True on success, False on failure."""
    assert bool(Result.success("x")) == True
    assert bool(Result.failure("x")) == False
