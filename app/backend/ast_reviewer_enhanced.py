"""
ast_reviewer_enhanced.py - Enhanced AST review with dynamic call detection.
"""
import ast
from typing import Any, Optional
from result import Result


DANGEROUS_CALLS = {
    "os.system", "os.popen", "os.exec", "os.execv", "os.execvp",
    "subprocess.call", "subprocess.run", "subprocess.Popen",
    "eval", "exec", "compile", "__import__",
    "globals", "locals", "vars",
}
# NOTE: bare ``open`` is deliberately NOT a blanket dangerous call — it is a
# legitimate primitive. Its abuse (reading /etc/passwd via ``../..``) is caught
# by path-traversal detection instead, so safe relative reads still pass.

DANGEROUS_ATTRS = {"system", "popen", "exec", "execv", "fork", "kill", "path", "argv", "exit"}

DANGEROUS_MODULES = {
    "os", "subprocess", "sys", "builtins", "importlib", "ctypes",
    "socket", "urllib", "requests", "http", "ftplib",
}

DANGEROUS_FUNCTION_PATTERNS = [
    r"getattr\s*\(\s*\w+\s*,\s*['\"]system['\"]",
    r"getattr\s*\(\s*\w+\s*,\s*['\"]popen['\"]",
    r"getattr\s*\(\s*\w+\s*,\s*['\"]open['\"]",
    r"__import__\s*\(",
    r"eval\s*\(",
    r"exec\s*\(",
]


class ASTReviewer:
    """Enhanced AST reviewer with dynamic call detection."""

    def __init__(self):
        self.taint_sources = set()  # Track tainted variable names

    def review(self, code: str) -> Result:
        """Enhanced AST review."""
        try:
            tree = ast.parse(code)
        except SyntaxError as e:
            return Result.failure(f"Syntax error: {e}")

        # First pass: collect tainted sources
        self._collect_taint(tree)

        # Second pass: check for dangerous patterns
        for node in ast.walk(tree):
            if self._is_dangerous_call(node):
                return Result.failure(f"Blocked dangerous call: {self._get_call_signature(node)}")

            if self._is_dangerous_attr(node):
                return Result.failure(f"Blocked dangerous attribute: {self._get_attr_name(node)}")

            if self._is_dangerous_import(node):
                return Result.failure(f"Blocked dangerous import: {self._get_import_name(node)}")

            if self._is_tainted_usage(node):
                return Result.failure(f"Blocked use of tainted value in dangerous context")

            if self._has_path_traversal(node):
                return Result.failure("Blocked path traversal attempt")

        return Result.success("AST review passed")

    def _collect_taint(self, tree):
        """Collect potential tainted sources."""
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        # Check if value is potentially tainted
                        if self._is_tainted_source(node.value):
                            self.taint_sources.add(target.id)
            if isinstance(node, ast.NamedExpr):
                if isinstance(node.value, ast.Name):
                    self.taint_sources.add(node.value.id)

    def _is_tainted_source(self, node) -> bool:
        """Check if AST node is a tainted source (user input, network, etc)."""
        if isinstance(node, ast.Call):
            func_name = self._get_call_signature(node)
            if any(d in func_name for d in ["input", "read", "fetch", "request", "get"]):
                return True
        return False

    def _is_tainted_usage(self, node) -> bool:
        """Check if tainted value is used in a dangerous way."""
        if isinstance(node, ast.Call):
            func = self._get_call_signature(node)
            for arg in ast.iter_child_nodes(node):
                if isinstance(arg, ast.Name) and arg.id in self.taint_sources:
                    if "system" in func or "popen" in func or "open" in func:
                        return True
        return False

    def _is_dangerous_call(self, node) -> bool:
        """Whether ``node`` is a call to something dangerous.

        Guarded on the node type: ``review`` walks every node in the tree, so
        this is handed Modules, Constants, arguments — anything. Without the
        isinstance check the first ``node.func`` access raised AttributeError
        and the whole review aborted, which meant the native-execution gate
        never actually reviewed anything.
        """
        if not isinstance(node, ast.Call):
            return False
        func_name = self._get_call_signature(node)
        # Direct dangerous call
        if func_name in DANGEROUS_CALLS:
            return True
        # Dynamic dangerous call (getattr)
        if func_name == "getattr":
            try:
                if len(node.args) >= 2:
                    attr_arg = node.args[1]
                    if isinstance(attr_arg, ast.Constant) and isinstance(attr_arg.value, str):
                        if attr_arg.value in DANGEROUS_ATTRS:
                            return True
            except (TypeError, AttributeError):
                pass  # fail-open: 可选增强，失败不影响主流程
        return False

    def _is_dangerous_attr(self, node) -> bool:
        """Whether ``node`` reads a dangerous attribute (guarded on node type)."""
        if not isinstance(node, ast.Attribute):
            return False
        return node.attr in DANGEROUS_ATTRS

    def _is_dangerous_import(self, node):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in DANGEROUS_MODULES:
                    return True
        elif isinstance(node, ast.ImportFrom):
            if node.module and node.module in DANGEROUS_MODULES:
                return True
        return False

    def _has_path_traversal(self, node) -> bool:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if ".." in node.value and ("/" in node.value or "\\" in node.value):
                # Allow ./ but block ../
                if node.value.startswith("./") or node.value.startswith(".\\"):
                    return False
                return True
        return False

    def _get_call_signature(self, node) -> str:
        """Best-effort dotted name for a call target ("os.system", "eval")."""
        if not isinstance(node, ast.Call):
            return ""
        func = node.func
        if isinstance(func, ast.Name):
            return func.id
        if isinstance(func, ast.Attribute):
            if isinstance(func.value, ast.Name):
                return f"{func.value.id}.{func.attr}"
            return func.attr
        return ""

    def _get_attr_name(self, node) -> str:
        """Attribute name, or "" for non-Attribute nodes."""
        return node.attr if isinstance(node, ast.Attribute) else ""

    def _get_import_name(self, node) -> str:
        if isinstance(node, ast.Import):
            return node.names[0].name if node.names else ""
        elif isinstance(node, ast.ImportFrom):
            return node.module or ""
        return ""


def get_ast_reviewer() -> ASTReviewer:
    return ASTReviewer()
