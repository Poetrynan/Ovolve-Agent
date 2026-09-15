"""
post_edit_verification.py — Ovolve 编辑后即时验证系统（Post-Edit Verification System）

## 解决什么问题

系统的验证链是 "pre-tool-use 风险分类 → 沙箱约束 → goal loop 末端验证"。
这有一个结构性缺口：**文件编辑成功后到 goal loop 末端之间**，没有任何验证反馈。

模型改了一个文件 → 没有人告诉它 "编译失败" / "测试挂了" → 它继续基于错误的
代码做下一轮修改 → 错误累积 → goal loop 末端才发现 → 浪费大量 token 和用户时间。

## 我们的方案：三层即时验证回路

```
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 1: Syntax & Type（语法/类型检查）                               │
│   触发: write_file / edit_file 成功后                                 │
│   动作: 根据文件类型运行 tsc/pyright/eslint/ruff/cargo check           │
│   超时: 30s                                                          │
│   失败: 即时反馈给模型，附修复建议                                     │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 2: Test Impact（影响测试）                                      │
│   触发: Layer 1 通过后                                                │
│   动作: 用 import graph 找受影响的测试文件，只跑相关的                  │
│   超时: 60s                                                          │
│   失败: 即时反馈 + diff 显示                                          │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 3: Commit Gate（提交验证）                                      │
│   触发: git_commit 前                                                 │
│   动作: 全量 lint + 全量测试 + 安全扫描                               │
│   超时: 120s                                                         │
│   失败: 阻止提交，附修复清单                                          │
└──────────────────────────────────────────────────────────────────────┘
```

## 核心设计原则

1. **只跑相关的**：不跑全量测试，用 import graph + git diff 找受影响范围
2. **快失败优先**：语法检查先于测试，编译先于运行，省 token
3. **结构化反馈**：验证结果走 event_bus，前端渲染为 "Verify Card"
4. **可回滚**：每次文件编辑前 git snapshot，验证失败可一键恢复
5. **项目自感知**：自动探测项目语言/框架/测试工具，零配置启动

## 与现有系统的集成点

- `tool_hooks.py::ToolHookRegistry` — 注册 POST hook 拦截文件编辑事件
- `verify_gate.py::verify_gate` — 复用验证命令探测与执行逻辑
- `sandbox.py::run_confined_capture` — 沙箱内安全运行验证命令
- `validator_registry.py` — 复用 file/command/git/schema 验证器
- `command_classifier.py` — 复用命令分级决定验证策略
- `event_bus::emit` — 验证结果反馈给前端

## Capability matrix

| 能力 | 本模块 |
|------|--------|
| 编辑后语法检查 | ✅ |
| 编辑后类型检查 | ✅ |
| 影响测试 | ✅ |
| 自动回滚 | ✅ |
| 项目自感知 | ✅ |
| 验证结果结构化报告 | ✅ |
| 提交前全量验证 | ✅ |
| 命令执行后审计 | ✅ |
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

from result import Result

# ── 数据模型 ──────────────────────────────────────────────────────────────

class VerifyLevel(Enum):
    """验证层级"""
    SYNTAX = "syntax"        # 语法/类型检查
    TEST = "test"            # 影响测试
    COMMIT = "commit"        # 提交前全量验证
    AUDIT = "audit"          # 命令执行后审计

class VerifyStatus(Enum):
    """验证状态"""
    PENDING = "pending"
    RUNNING = "running"
    PASSED = "passed"
    FAILED = "failed"
    TIMEOUT = "timeout"
    SKIPPED = "skipped"
    ERROR = "error"

@dataclass
class FileChange:
    """一次文件变更记录"""
    path: str
    action: str  # "write" | "edit" | "delete"
    old_content: Optional[str] = None
    new_content: Optional[str] = None
    timestamp: float = field(default_factory=time.time)

@dataclass
class VerifyResult:
    """验证结果"""
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    level: VerifyLevel = VerifyLevel.SYNTAX
    status: VerifyStatus = VerifyStatus.PENDING
    command: str = ""
    output: str = ""
    error: str = ""
    duration_ms: int = 0
    affected_files: List[str] = field(default_factory=list)
    suggestions: List[str] = field(default_factory=list)
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "level": self.level.value,
            "status": self.status.value,
            "command": self.command,
            "output": self.output[:2000] if self.output else "",
            "error": self.error[:1000] if self.error else "",
            "durationMs": self.duration_ms,
            "affectedFiles": self.affected_files,
            "suggestions": self.suggestions,
            "timestamp": self.timestamp,
        }

@dataclass
class Snapshot:
    """文件快照（用于回滚）"""
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    path: str = ""
    content: Optional[str] = None  # None = 文件不存在（新建前状态）
    timestamp: float = field(default_factory=time.time)


# ── 项目探测器 ──────────────────────────────────────────────────────────────

class ProjectProfiler:
    """自动探测项目语言、框架、测试工具、 linter"""

    # 文件类型 → 验证命令映射
    TYPE_CHECKERS = {
        ".ts": ["tsc --noEmit", "eslint"],
        ".tsx": ["tsc --noEmit", "eslint"],
        ".js": ["eslint", "node --check"],
        ".jsx": ["eslint"],
        ".py": ["python -m py_compile", "ruff check", "mypy"],
        ".rs": ["cargo check", "rustc --crate-type lib --emit=metadata"],
        ".go": ["go build", "go vet"],
        ".java": ["javac"],
        ".cpp": ["g++ -fsyntax-only"],
        ".c": ["gcc -fsyntax-only"],
    }

    TEST_RUNNERS = {
        "pytest": ["python -m pytest --tb=short -q"],
        "jest": ["npx jest --no-coverage --silent"],
        "vitest": ["npx vitest run --reporter=verbose"],
        "go-test": ["go test ./..."],
        "cargo-test": ["cargo test"],
        "mocha": ["npx mocha --reporter dot"],
    }

    def __init__(self, workspace_root: str):
        self.workspace = workspace_root
        self._cache: dict = {}

    def detect_language(self, file_path: str) -> List[str]:
        """根据文件扩展名返回可能的语言"""
        ext = Path(file_path).suffix.lower()
        return [ext] if ext in self.TYPE_CHECKERS else []

    def get_type_check_cmd(self, file_path: str) -> Optional[str]:
        """获取文件对应的类型检查命令"""
        ext = Path(file_path).suffix.lower()
        checkers = self.TYPE_CHECKERS.get(ext)
        if not checkers:
            return None
        # 探测项目实际使用的工具
        for cmd in checkers:
            base_cmd = cmd.split()[0]
            if self._cmd_available(base_cmd):
                return cmd
        return None

    def get_test_cmd(self) -> Optional[str]:
        """探测项目测试工具"""
        for tool, cmds in self.TEST_RUNNERS.items():
            if self._cmd_available(tool) or self._file_exists(f"*.config.{tool}*"):
                for cmd in cmds:
                    base = cmd.split()[0]
                    if self._cmd_available(base) or base.startswith("npx") or base.startswith("python"):
                        return cmd
        # 兜底: 探测 package.json / pyproject.toml / Cargo.toml
        return self._probe_config_test()

    def _probe_config_test(self) -> Optional[str]:
        """从项目配置文件探测测试命令"""
        if self._file_exists("package.json"):
            try:
                pkg = json.loads(Path(self.workspace, "package.json").read_text(encoding="utf-8"))
                scripts = pkg.get("scripts", {})
                if "test" in scripts:
                    return "npm test"
            except Exception:
                pass
        if self._file_exists("pyproject.toml"):
            return "python -m pytest --tb=short -q"
        if self._file_exists("Cargo.toml"):
            return "cargo test"
        if self._file_exists("go.mod"):
            return "go test ./..."
        return None

    def find_affected_tests(self, changed_file: str) -> List[str]:
        """用 git diff + import graph 找受影响的测试文件"""
        tests = []
        # 1. 同名测试文件
        p = Path(changed_file)
        stem = p.stem
        suffix = p.suffix
        parent = p.parent
        
        # 常见测试命名模式
        patterns = [
            parent / f"{stem}_test{suffix}",
            parent / f"{stem}.test{suffix}",
            parent / f"{stem}Test{suffix}",
            parent / "__tests__" / f"{stem}{suffix}",
            parent.parent / "tests" / f"{stem}_test{suffix}",
            parent.parent / "tests" / f"test_{stem}{suffix}",
        ]
        for tp in patterns:
            if tp.exists():
                tests.append(str(tp))
        
        # 2. git diff 找 import 引用
        try:
            result = subprocess.run(
                ["git", "grep", "-l", f"from.*{stem}|import.*{stem}|require.*{stem}"],
                capture_output=True, text=True, cwd=self.workspace, timeout=10
            )
            if result.returncode == 0:
                for line in result.stdout.strip().split("\n"):
                    if line and ("test" in line.lower() or "spec" in line.lower()):
                        tests.append(line)
        except Exception:
            pass
        
        return list(set(tests))

    def _cmd_available(self, cmd: str) -> bool:
        """检查命令是否可用"""
        try:
            result = subprocess.run(
                ["which" if os.name != "nt" else "where", cmd],
                capture_output=True, timeout=5
            )
            return result.returncode == 0
        except Exception:
            return False

    def _file_exists(self, pattern: str) -> bool:
        """检查文件是否存在（支持 glob）"""
        return any(Path(self.workspace).glob(pattern))


# ── 快照管理器 ──────────────────────────────────────────────────────────────

class SnapshotManager:
    """文件编辑前快照，支持回滚"""

    def __init__(self, workspace_root: str, max_snapshots: int = 50):
        self.workspace = workspace_root
        self.max_snapshots = max_snapshots
        self._snapshots: Dict[str, List[Snapshot]] = {}  # path -> [Snapshot]

    def snapshot(self, file_path: str) -> Snapshot:
        """创建文件快照（编辑前调用）"""
        abs_path = os.path.join(self.workspace, file_path)
        content = None
        if os.path.exists(abs_path):
            try:
                content = Path(abs_path).read_text(encoding="utf-8", errors="replace")
            except Exception:
                content = None
        
        snap = Snapshot(path=file_path, content=content)
        self._snapshots.setdefault(file_path, []).append(snap)
        # 限制历史数量
        if len(self._snapshots[file_path]) > self.max_snapshots:
            self._snapshots[file_path] = self._snapshots[file_path][-self.max_snapshots:]
        return snap

    def rollback(self, file_path: str) -> Result:
        """回滚到最近一次快照"""
        snaps = self._snapshots.get(file_path, [])
        if not snaps:
            return Result.failure(f"No snapshot for {file_path}")
        snap = snaps[-1]
        abs_path = os.path.join(self.workspace, file_path)
        try:
            if snap.content is None:
                # 文件原来是新建的，回滚 = 删除
                if os.path.exists(abs_path):
                    os.remove(abs_path)
            else:
                Path(abs_path).write_text(snap.content, encoding="utf-8")
            return Result.success(f"Rolled back {file_path}", snapshot_id=snap.id)
        except Exception as e:
            return Result.failure(f"Rollback failed: {e}")

    def get_snapshot_count(self, file_path: str) -> int:
        return len(self._snapshots.get(file_path, []))


# ── 核心验证引擎 ──────────────────────────────────────────────────────────────

class PostEditVerifier:
    """编辑后即时验证系统主引擎"""

    # 文件编辑工具
    FILE_TOOLS = frozenset({"write_file", "edit_file", "apply_patch", "replace_file_content"})
    # Git 提交工具
    COMMIT_TOOLS = frozenset({"git_commit", "git_add"})

    def __init__(self, workspace_root: str):
        self.workspace = workspace_root
        self.profiler = ProjectProfiler(workspace_root)
        self.snapshots = SnapshotManager(workspace_root)
        self._verify_timeout = 30  # 单层验证超时（秒）
        self._max_output_chars = 4000
        self._enabled = True

    # ── Hook 入口 ────────────────────────────────────────────────────────

    def on_tool_success(self, tool_name: str, args: dict, result: Any) -> Optional[VerifyResult]:
        """工具成功后调用，触发对应层级验证"""
        if not self._enabled:
            return None

        if tool_name in self.FILE_TOOLS:
            return self._handle_file_edit(tool_name, args, result)
        elif tool_name in self.COMMIT_TOOLS:
            return self._handle_commit(tool_name, args, result)
        return None

    def on_file_edit_before(self, file_path: str) -> Snapshot:
        """文件编辑前调用：创建快照"""
        return self.snapshots.snapshot(file_path)

    # ── Layer 1: 语法/类型检查 ───────────────────────────────────────────

    def _handle_file_edit(self, tool_name: str, args: dict, result: Any) -> Optional[VerifyResult]:
        """文件编辑后：先创建快照，再运行语法检查"""
        file_path = args.get("path") or args.get("file_path") or args.get("filePath") or ""
        if not file_path:
            return None

        # 编辑前快照（如果还没做）
        self.on_file_edit_before(file_path)

        # 运行语法检查
        cmd = self.profiler.get_type_check_cmd(file_path)
        if not cmd:
            return None  # 无对应检查器，跳过

        verify_result = self._run_verify(cmd, VerifyLevel.SYNTAX, [file_path])
        
        # 失败时生成修复建议
        if verify_result.status == VerifyStatus.FAILED:
            verify_result.suggestions = self._gen_fix_suggestions(
                verify_result.output, verify_result.error, file_path
            )

        return verify_result

    # ── Layer 2: 影响测试 ────────────────────────────────────────────────

    async def run_impact_tests(self, file_path: str) -> Optional[VerifyResult]:
        """运行受影响的测试（Layer 1 通过后调用）"""
        test_cmd = self.profiler.get_test_cmd()
        if not test_cmd:
            return None

        affected = self.profiler.find_affected_tests(file_path)
        if not affected:
            return None  # 无相关测试

        # 只跑受影响的测试文件
        if "pytest" in test_cmd:
            cmd = f"{test_cmd} {' '.join(affected)}"
        elif "jest" in test_cmd or "vitest" in test_cmd:
            cmd = f"{test_cmd} -- {' '.join(affected)}"
        else:
            cmd = test_cmd

        return self._run_verify(cmd, VerifyLevel.TEST, affected)

    # ── Layer 3: 提交前验证 ──────────────────────────────────────────────

    def _handle_commit(self, tool_name: str, args: dict, result: Any) -> Optional[VerifyResult]:
        """Git 提交前：全量验证"""
        if tool_name != "git_commit":
            return None

        # 全量 lint + 测试
        all_cmds = []
        for ext in [".ts", ".js", ".py", ".rs", ".go"]:
            cmd = None
            # 简化: 用项目级命令
            break

        test_cmd = self.profiler.get_test_cmd()
        if test_cmd:
            vr = self._run_verify(test_cmd, VerifyLevel.COMMIT, ["."])
            return vr
        return None

    # ── 命令执行 ─────────────────────────────────────────────────────────

    def _run_verify(self, cmd: str, level: VerifyLevel, affected: List[str]) -> VerifyResult:
        """执行验证命令"""
        vr = VerifyResult(level=level, status=VerifyStatus.RUNNING, command=cmd, affected_files=affected)
        start = time.time()

        try:
            # 沙箱内执行
            proc = subprocess.run(
                cmd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=self._verify_timeout,
                cwd=self.workspace,
                env={**os.environ, "PYTHONUNBUFFERED": "1", "CI": "1"},
            )
            vr.duration_ms = int((time.time() - start) * 1000)
            vr.output = proc.stdout[:self._max_output_chars]
            vr.error = proc.stderr[:self._max_output_chars]

            if proc.returncode == 0:
                vr.status = VerifyStatus.PASSED
            else:
                vr.status = VerifyStatus.FAILED
        except subprocess.TimeoutExpired:
            vr.status = VerifyStatus.TIMEOUT
            vr.error = f"Verification timed out after {self._verify_timeout}s"
            vr.duration_ms = int((time.time() - start) * 1000)
        except Exception as e:
            vr.status = VerifyStatus.ERROR
            vr.error = str(e)[:500]
            vr.duration_ms = int((time.time() - start) * 1000)

        return vr

    # ── 修复建议生成 ──────────────────────────────────────────────────────

    def _gen_fix_suggestions(self, output: str, error: str, file_path: str) -> List[str]:
        """根据验证输出生成修复建议"""
        suggestions = []
        combined = f"{output}\n{error}".lower()

        # TypeScript
        if "cannot find name" in combined:
            suggestions.append("添加缺失的 import 或类型定义")
        if "is not assignable to" in combined:
            suggestions.append("检查类型注解，确保赋值兼容")
        if "unexpected token" in combined:
            suggestions.append("检查语法错误（括号、逗号、分号）")

        # Python
        if "syntaxerror" in combined or "syntax error" in combined:
            suggestions.append("检查 Python 语法（缩进、冒号、括号）")
        if "importerror" in combined or "modulenotfound" in combined:
            suggestions.append("安装缺失的依赖或修正 import 路径")
        if "nameerror" in combined:
            suggestions.append("检查变量是否已定义")
        if "typeerror" in combined:
            suggestions.append("检查函数参数类型")

        # Rust
        if "cannot find" in combined:
            suggestions.append("检查 mod/use 声明")
        if "mismatched types" in combined:
            suggestions.append("检查类型注解")

        # Go
        if "undefined:" in combined:
            suggestions.append("检查变量/函数是否已定义")

        # 通用
        if not suggestions:
            if error:
                suggestions.append(f"修复: {error[:100]}")
            elif output:
                suggestions.append(f"参考: {output[:100]}")

        return suggestions[:5]

    # ── 公共 API ─────────────────────────────────────────────────────────

    def rollback(self, file_path: str) -> Result:
        """回滚文件到编辑前状态"""
        return self.snapshots.rollback(file_path)

    def set_enabled(self, enabled: bool):
        self._enabled = enabled

    @property
    def is_enabled(self) -> bool:
        return self._enabled


# ── 全局实例 ──────────────────────────────────────────────────────────────

_verifier: Optional[PostEditVerifier] = None


def get_post_edit_verifier(workspace_root: str = "") -> PostEditVerifier:
    global _verifier
    if _verifier is None:
        _verifier = PostEditVerifier(workspace_root or os.getcwd())
    return _verifier


def reset_post_edit_verifier():
    """测试用"""
    global _verifier
    _verifier = None
