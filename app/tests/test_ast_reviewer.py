"""Test enhanced AST reviewer."""
import pytest
from result import Result
from ast_reviewer_enhanced import get_ast_reviewer


@pytest.fixture
def reviewer():
    return get_ast_reviewer()


def test_safe_code(reviewer):
    """Safe code passes review."""
    code = """
import math

def calculate(x, y):
    return x + y

result = calculate(10, 20)
"""
    r = reviewer.review(code)
    assert r.ok


def test_dangerous_system(reviewer):
    """Direct system call is blocked."""
    code = """
os.system("rm -rf /")
"""
    r = reviewer.review(code)
    assert not r.ok
    assert "Blocked dangerous call" in r.error


def test_dangerous_popen(reviewer):
    """Subprocess popen is blocked."""
    code = """
subprocess.Popen(["rm", "-rf", "/"])
"""
    r = reviewer.review(code)
    assert not r.ok
    assert "Blocked dangerous call" in r.error


def test_dangerous_getattr(reviewer):
    """Dynamic dangerous call is blocked."""
    code = """
dangerous = getattr(os, 'system')
dangerous('rm -rf /')
"""
    r = reviewer.review(code)
    assert not r.ok
    assert "Blocked dangerous call" in r.error


def test_path_traversal(reviewer):
    """Path traversal is blocked."""
    code = """
path = '../../../etc/passwd'
with open(path) as f:
    content = f.read()
"""
    r = reviewer.review(code)
    assert not r.ok
    assert "Blocked path traversal" in r.error


def test_safe_relative_path(reviewer):
    """Relative path within directory is allowed."""
    code = """
path = './config.json'
with open(path) as f:
    content = f.read()
"""
    r = reviewer.review(code)
    assert r.ok


def test_dangerous_import(reviewer):
    """Importing dangerous modules is blocked."""
    code = """
import os
import subprocess
"""
    r = reviewer.review(code)
    assert not r.ok
    assert "Blocked dangerous import" in r.error
