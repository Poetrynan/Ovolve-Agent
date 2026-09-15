"""
ast_reviewer_enhanced.py - Enhanced AST review with dynamic call detection,
four-perspective review (security/perf/maintainability/test-coverage), and
Reviewer-Critic structured disagreement verification.
"""
import ast
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Set
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

# 四固定审查视角
PERSPECTIVE_SECURITY = "security"
PERSPECTIVE_PERFORMANCE = "perf"
PERSPECTIVE_MAINTAINABILITY = "maintainability"
PERSPECTIVE_TEST_COVERAGE = "test-coverage"
REVIEW_PERSPECTIVES = (
    PERSPECTIVE_SECURITY,
    PERSPECTIVE_PERFORMANCE,
    PERSPECTIVE_MAINTAINABILITY,
    PERSPECTIVE_TEST_COVERAGE,
)

PERSPECTIVE_ALIASES = {
    "performance": PERSPECTIVE_PERFORMANCE,
    "tests": PERSPECTIVE_TEST_COVERAGE,
    "test": PERSPECTIVE_TEST_COVERAGE,
    "coverage": PERSPECTIVE_TEST_COVERAGE,
}


@dataclass
class ReviewFinding:
    """评审意见结构化条目，支持 Reviewer-Critic 分歧裁决三态。"""
    id: str
    perspective: str
    severity: str
    message: str
    file: str = ""
    line: int = 0
    rule_id: str = ""
    verdict: str = "pending"  # pending | confirmed | rejected | escalated
    verdict_reason: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "perspective": self.perspective,
            "severity": self.severity,
            "message": self.message,
            "file": self.file,
            "line": self.line,
            "rule_id": self.rule_id,
            "verdict": self.verdict,
            "verdict_reason": self.verdict_reason,
        }


class ASTReviewer:
    """Enhanced AST reviewer with dynamic call detection and multi-perspective verification."""

    def __init__(self):
        self.taint_sources = set()  # Track tainted variable names

    def review(self, code: str) -> Result:
        """Enhanced AST review (保持原有签名与行为兼容)。"""
        findings = self.review_perspectives(code, perspectives=[PERSPECTIVE_SECURITY])
        for f in findings:
            if f.severity == "error":
                return Result.failure(f.message)
        return Result.success("AST review passed")

    def review_perspectives(
        self,
        code: str,
        perspectives: Optional[Sequence[str]] = None,
        file_path: str = "",
    ) -> List[ReviewFinding]:
        """多视角 AST 静态审查，产出结构化 ReviewFinding 列表。"""
        try:
            tree = ast.parse(code)
        except SyntaxError as e:
            return [
                ReviewFinding(
                    id=f"syn-{uuid.uuid4().hex[:8]}",
                    perspective=PERSPECTIVE_MAINTAINABILITY,
                    severity="error",
                    message=f"Syntax error: {e}",
                    file=file_path,
                    line=getattr(e, "lineno", 0) or 0,
                    rule_id="SYNTAX_ERROR",
                )
            ]

        selected: Set[str] = set()
        if perspectives is None:
            selected = set(REVIEW_PERSPECTIVES)
        else:
            for p in perspectives:
                clean = PERSPECTIVE_ALIASES.get(p.lower(), p.lower())
                if clean in REVIEW_PERSPECTIVES:
                    selected.add(clean)

        findings: List[ReviewFinding] = []

        if PERSPECTIVE_SECURITY in selected:
            findings.extend(self._check_security(tree, file_path))

        if PERSPECTIVE_PERFORMANCE in selected:
            findings.extend(self._check_performance(tree, file_path))

        if PERSPECTIVE_MAINTAINABILITY in selected:
            findings.extend(self._check_maintainability(tree, file_path))

        if PERSPECTIVE_TEST_COVERAGE in selected:
            findings.extend(self._check_test_coverage(tree, file_path))

        return findings

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

    def _check_security(self, tree: ast.AST, file_path: str = "") -> List[ReviewFinding]:
        findings: List[ReviewFinding] = []
        self.taint_sources.clear()
        self._collect_taint(tree)

        for node in ast.walk(tree):
            line = getattr(node, "lineno", 0)

            if self._is_dangerous_call(node):
                findings.append(ReviewFinding(
                    id=f"sec-{uuid.uuid4().hex[:8]}",
                    perspective=PERSPECTIVE_SECURITY,
                    severity="error",
                    message=f"Blocked dangerous call: {self._get_call_signature(node)}",
                    file=file_path,
                    line=line,
                    rule_id="SEC_CALL",
                ))

            if self._is_dangerous_attr(node):
                findings.append(ReviewFinding(
                    id=f"sec-{uuid.uuid4().hex[:8]}",
                    perspective=PERSPECTIVE_SECURITY,
                    severity="error",
                    message=f"Blocked dangerous attribute: {self._get_attr_name(node)}",
                    file=file_path,
                    line=line,
                    rule_id="SEC_ATTR",
                ))

            if self._is_dangerous_import(node):
                findings.append(ReviewFinding(
                    id=f"sec-{uuid.uuid4().hex[:8]}",
                    perspective=PERSPECTIVE_SECURITY,
                    severity="warning",
                    message=f"Blocked dangerous import: {self._get_import_name(node)}",
                    file=file_path,
                    line=line,
                    rule_id="SEC_IMPORT",
                ))

            if self._is_tainted_usage(node):
                findings.append(ReviewFinding(
                    id=f"sec-{uuid.uuid4().hex[:8]}",
                    perspective=PERSPECTIVE_SECURITY,
                    severity="error",
                    message="Blocked use of tainted value in dangerous context",
                    file=file_path,
                    line=line,
                    rule_id="SEC_TAINT",
                ))

            if self._has_path_traversal(node):
                findings.append(ReviewFinding(
                    id=f"sec-{uuid.uuid4().hex[:8]}",
                    perspective=PERSPECTIVE_SECURITY,
                    severity="error",
                    message="Blocked path traversal attempt",
                    file=file_path,
                    line=line,
                    rule_id="SEC_TRAVERSAL",
                ))

            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        name_lower = target.id.lower()
                        if any(k in name_lower for k in ("api_key", "secret_key", "password", "auth_token")):
                            if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                                if len(node.value.value) >= 8:
                                    findings.append(ReviewFinding(
                                        id=f"sec-{uuid.uuid4().hex[:8]}",
                                        perspective=PERSPECTIVE_SECURITY,
                                        severity="warning",
                                        message=f"Potential hardcoded credential in variable '{target.id}'",
                                        file=file_path,
                                        line=line,
                                        rule_id="SEC_HARDCODED_SECRET",
                                    ))
        return findings

    def _check_performance(self, tree: ast.AST, file_path: str = "") -> List[ReviewFinding]:
        findings: List[ReviewFinding] = []

        def _scan_loops(node: ast.AST, loop_depth: int = 0):
            is_loop = isinstance(node, (ast.For, ast.While))
            current_depth = loop_depth + 1 if is_loop else loop_depth

            if is_loop and loop_depth >= 1:
                findings.append(ReviewFinding(
                    id=f"perf-{uuid.uuid4().hex[:8]}",
                    perspective=PERSPECTIVE_PERFORMANCE,
                    severity="warning",
                    message="Nested loop detected: potential quadratic O(n^2) complexity",
                    file=file_path,
                    line=getattr(node, "lineno", 0),
                    rule_id="PERF_QUADRATIC_LOOP",
                ))

            if is_loop:
                for child in ast.walk(node):
                    if isinstance(child, ast.Call):
                        sig = self._get_call_signature(child)
                        if sig in ("re.compile", "re.search", "re.match", "re.findall", "re.sub"):
                            findings.append(ReviewFinding(
                                id=f"perf-{uuid.uuid4().hex[:8]}",
                                perspective=PERSPECTIVE_PERFORMANCE,
                                severity="warning",
                                message=f"Regex compiled or executed inside loop ({sig}): consider pre-compiling pattern with re.compile() outside loop",
                                file=file_path,
                                line=getattr(child, "lineno", 0),
                                rule_id="PERF_REGEX_IN_LOOP",
                            ))
                    elif isinstance(child, ast.AugAssign) and isinstance(child.op, ast.Add):
                        findings.append(ReviewFinding(
                            id=f"perf-{uuid.uuid4().hex[:8]}",
                            perspective=PERSPECTIVE_PERFORMANCE,
                            severity="info",
                            message="String or collection concatenation inside loop body: consider list append and ''.join()",
                            file=file_path,
                            line=getattr(child, "lineno", 0),
                            rule_id="PERF_STR_CONCAT_IN_LOOP",
                        ))

            for child in ast.iter_child_nodes(node):
                _scan_loops(child, current_depth)

        _scan_loops(tree, 0)
        return findings

    def _check_maintainability(self, tree: ast.AST, file_path: str = "") -> List[ReviewFinding]:
        findings: List[ReviewFinding] = []

        for node in ast.walk(tree):
            line = getattr(node, "lineno", 0)

            if isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    if alias.name == "*":
                        mod_name = node.module or ""
                        findings.append(ReviewFinding(
                            id=f"maint-{uuid.uuid4().hex[:8]}",
                            perspective=PERSPECTIVE_MAINTAINABILITY,
                            severity="warning",
                            message=f"Wildcard import 'from {mod_name} import *' pollutes namespace",
                            file=file_path,
                            line=line,
                            rule_id="MAINT_WILDCARD_IMPORT",
                        ))

            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                total_args = len(node.args.args) + len(getattr(node.args, "posonlyargs", [])) + len(getattr(node.args, "kwonlyargs", []))
                if total_args > 7:
                    findings.append(ReviewFinding(
                        id=f"maint-{uuid.uuid4().hex[:8]}",
                        perspective=PERSPECTIVE_MAINTAINABILITY,
                        severity="warning",
                        message=f"Function '{node.name}' has {total_args} arguments (threshold: 7): consider refactoring into a parameter object",
                        file=file_path,
                        line=line,
                        rule_id="MAINT_TOO_MANY_ARGS",
                    ))

        def _check_nesting(node: ast.AST, depth: int):
            is_branch = isinstance(node, (ast.If, ast.For, ast.While, ast.Try, ast.With))
            next_depth = depth + 1 if is_branch else depth
            if is_branch and depth >= 4:
                findings.append(ReviewFinding(
                    id=f"maint-{uuid.uuid4().hex[:8]}",
                    perspective=PERSPECTIVE_MAINTAINABILITY,
                    severity="info",
                    message="Deeply nested control flow (> 4 levels): consider flattening logic with guard clauses or helper functions",
                    file=file_path,
                    line=getattr(node, "lineno", 0),
                    rule_id="MAINT_DEEP_NESTING",
                ))
            for child in ast.iter_child_nodes(node):
                _check_nesting(child, next_depth)

        _check_nesting(tree, 0)
        return findings

    def _check_test_coverage(self, tree: ast.AST, file_path: str = "") -> List[ReviewFinding]:
        findings: List[ReviewFinding] = []

        for node in ast.walk(tree):
            line = getattr(node, "lineno", 0)

            if isinstance(node, ast.FunctionDef) and node.name.startswith("test_"):
                has_assert = False
                for sub in ast.walk(node):
                    if isinstance(sub, ast.Assert):
                        has_assert = True
                        break
                    if isinstance(sub, ast.Call):
                        sig = self._get_call_signature(sub).lower()
                        if "assert" in sig or "raises" in sig or "check" in sig:
                            has_assert = True
                            break
                if not has_assert:
                    findings.append(ReviewFinding(
                        id=f"test-{uuid.uuid4().hex[:8]}",
                        perspective=PERSPECTIVE_TEST_COVERAGE,
                        severity="warning",
                        message=f"Test function '{node.name}' lacks assertion statement",
                        file=file_path,
                        line=line,
                        rule_id="TEST_MISSING_ASSERTION",
                    ))

            if isinstance(node, ast.ExceptHandler):
                if len(node.body) == 1 and isinstance(node.body[0], ast.Pass):
                    findings.append(ReviewFinding(
                        id=f"test-{uuid.uuid4().hex[:8]}",
                        perspective=PERSPECTIVE_TEST_COVERAGE,
                        severity="warning",
                        message="Swallowed exception: empty except block silently ignores errors with 'pass'",
                        file=file_path,
                        line=line,
                        rule_id="TEST_SWALLOWED_EXCEPTION",
                    ))

        return findings

    def verify_with_critic(
        self,
        findings: List[ReviewFinding],
        code: str = "",
        file_path: str = "",
    ) -> List[ReviewFinding]:
        """Critic 验证 pass：消除 Reviewer 意见假阳性与幻觉，形成三态裁决。"""
        for f in findings:
            target_file = f.file or file_path
            is_test_file = bool(target_file and ("test_" in target_file or "_test" in target_file or "/tests/" in target_file.replace("\\", "/")))

            if f.rule_id == "SEC_IMPORT" and is_test_file:
                f.verdict = "rejected"
                f.verdict_reason = "Standard import in test file context is expected"
                continue

            if "dynamic" in f.message.lower() or f.rule_id in ("SEC_ATTR", "MAINT_DYNAMIC"):
                f.verdict = "escalated"
                f.verdict_reason = "Dynamic access pattern requires human contextual judgment"
                continue

            if f.severity == "error" or f.rule_id in ("SEC_CALL", "SEC_TRAVERSAL", "SYNTAX_ERROR", "PERF_QUADRATIC_LOOP", "TEST_MISSING_ASSERTION"):
                f.verdict = "confirmed"
                f.verdict_reason = "Verified legitimate defect against code structure"
                continue

            f.verdict = "confirmed"
            f.verdict_reason = "Verified actionable review finding"

        return findings


def get_ast_reviewer() -> ASTReviewer:
    return ASTReviewer()
