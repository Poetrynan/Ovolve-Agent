"""tool_search.py — 超限工具与技能动态语义检索与按需激活引擎 

当系统注册的工具与技能数量超过阈值（如 >30 个）时，将所有工具的完整 Schema 常驻在
主 System Prompt 会极大消耗上下文 Token（占用数万 Token）。

ToolSearch 提供：
1. ToolRegistryIndex: 基于倒排索引与 BM25 / N-gram 相似度的本地轻量级工具检索器
2. tool_search 工具: 模型可主动根据任务描述调用该工具，搜索并动态激活匹配的工具 Schema
3. DynamicToolCatalog: 支持按需热加载与单轮上下文动态扩展
"""
from __future__ import annotations

import re
import math
from dataclasses import dataclass, field
from typing import Any, Optional, Sequence


@dataclass
class ToolMeta:
    name: str
    description: str
    parameters: dict[str, Any] = field(default_factory=dict)
    category: str = "general"
    tags: list[str] = field(default_factory=list)
    is_core: bool = False  # 核心工具始终常驻，不参与检索剔除


@dataclass
class ToolSearchResult:
    name: str
    description: str
    category: str
    score: float
    parameters_summary: str = ""
    is_active: bool = False


def _tokenize(text: str) -> list[str]:
    """分词与小写归一化（支持中英文混合与下划线命名，并对中文生成字词级与 2-gram 切分）"""
    if not text:
        return []
    s = re.sub(r'([a-z])([A-Z])', r'\1 \2', text)
    raw_tokens = re.findall(r'[a-zA-Z0-9_-]+|[\u4e00-\u9fa5]+', s.lower())
    tokens: list[str] = []
    for tok in raw_tokens:
        if any('\u4e00' <= c <= '\u9fa5' for c in tok):
            tokens.append(tok)
            if len(tok) >= 2:
                for i in range(len(tok) - 1):
                    tokens.append(tok[i:i+2])
            for c in tok:
                tokens.append(c)
        else:
            if len(tok) > 1:
                tokens.append(tok)
    return tokens


class ToolRegistryIndex:
    """纯本地、零依赖的轻量级 BM25 与倒排索引工具搜索引擎"""

    def __init__(self, k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self._tools: dict[str, ToolMeta] = {}
        self._doc_lens: dict[str, int] = {}
        self._avg_dl: float = 0.0
        self._inverted_index: dict[str, set[str]] = {}
        self._term_freqs: dict[str, dict[str, int]] = {}

    def register_tool(
        self,
        name: str,
        description: str,
        parameters: Optional[dict[str, Any]] = None,
        category: str = "general",
        tags: Optional[list[str]] = None,
        is_core: bool = False,
    ) -> None:
        """注册一个工具元数据"""
        meta = ToolMeta(
            name=name,
            description=description,
            parameters=parameters or {},
            category=category,
            tags=tags or [],
            is_core=is_core,
        )
        self._tools[name] = meta
        self._rebuild_index()

    def register_many(self, tools: Sequence[ToolMeta]) -> None:
        for t in tools:
            self._tools[t.name] = t
        self._rebuild_index()

    def _rebuild_index(self) -> None:
        """重建倒排索引与统计数据"""
        self._inverted_index.clear()
        self._term_freqs.clear()
        self._doc_lens.clear()
        total_len = 0

        for name, meta in self._tools.items():
            param_names = list(meta.parameters.get("properties", {}).keys())
            doc_text = f"{name} {name} {meta.description} {' '.join(meta.tags)} {' '.join(param_names)}"
            tokens = _tokenize(doc_text)
            self._doc_lens[name] = len(tokens)
            total_len += len(tokens)

            tf: dict[str, int] = {}
            for t in tokens:
                tf[t] = tf.get(t, 0) + 1
                if t not in self._inverted_index:
                    self._inverted_index[t] = set()
                self._inverted_index[t].add(name)
            self._term_freqs[name] = tf

        n = len(self._tools)
        self._avg_dl = (total_len / n) if n > 0 else 0.0

    def search(self, query: str, top_k: int = 5, threshold: float = 0.05) -> list[ToolSearchResult]:
        """根据查询词进行 BM25 排序检索"""
        query_tokens = _tokenize(query)
        if not query_tokens or not self._tools:
            return []

        n = len(self._tools)
        scores: dict[str, float] = {name: 0.0 for name in self._tools}

        for q in query_tokens:
            matching_docs = self._inverted_index.get(q, set())
            df = len(matching_docs)
            if df == 0:
                for name, meta in self._tools.items():
                    if q in name.lower() or q in meta.description.lower():
                        scores[name] += 1.0
                continue

            idf = math.log(1 + (n - df + 0.5) / (df + 0.5))

            for doc_name in matching_docs:
                tf = self._term_freqs[doc_name].get(q, 0)
                dl = self._doc_lens[doc_name]
                score = idf * (tf * (self.k1 + 1)) / (tf + self.k1 * (1 - self.b + self.b * (dl / (self._avg_dl or 1.0))))
                scores[doc_name] += score

        ranked = sorted(
            [(name, score) for name, score in scores.items() if score >= threshold],
            key=lambda x: x[1],
            reverse=True,
        )[:top_k]

        results = []
        for name, score in ranked:
            meta = self._tools[name]
            params = meta.parameters.get("properties", {})
            param_summary = ", ".join(f"{k} ({v.get('type', 'any')})" for k, v in params.items())
            results.append(
                ToolSearchResult(
                    name=name,
                    description=meta.description,
                    category=meta.category,
                    score=round(score, 3),
                    parameters_summary=param_summary,
                    is_active=False,
                )
            )
        return results

    def get_tool(self, name: str) -> Optional[ToolMeta]:
        return self._tools.get(name)

    def list_all(self) -> list[ToolMeta]:
        return list(self._tools.values())


# 常规工具与意图的中文语义标签增强映射（确保中文与多语意图精准匹配英文工具）
DOMAIN_SEMANTIC_TAGS: dict[str, list[str]] = {
    "browser": ["浏览器", "网页", "网站", "web", "browser", "html", "url", "页面", "上网", "爬取", "抓取", "打开网页", "打开网站", "访问网址", "浏览"],
    "navigate": ["打开网页", "访问网址", "跳转网页", "打开网站", "浏览网页", "打开百度", "打开链接", "进入网站", "navigate", "url", "browser", "launch"],
    "tab_open": ["新标签页", "新建标签", "打开网页", "打开标签", "browser", "open tab", "new tab"],
    "snapshot": ["网页截图", "浏览器截图", "页面截图", "screenshot", "capture page"],
    "click": ["点击元素", "网页点击", "按钮点击", "web click"],
    "fill": ["输入表单", "填写内容", "表单输入", "网页输入", "fill input"],
    "web_search": ["网络搜索", "联网查询", "搜网页", "bing", "google", "search engine"],
    "web_fetch": ["抓取网页", "读取网页内容", "网页提取", "fetch html", "scrape"],
    "shell_executor": ["终端", "命令行", "运行命令", "执行命令", "shell", "bash", "cmd", "powershell"],
    "run_command": ["运行命令", "命令行", "cmd", "terminal"],
    "read_text": ["读取文件", "查看文件", "读文件", "read file", "cat"],
    "write_file": ["写入文件", "新建文件", "创建文件", "保存文件", "write file"],
    "edit_file": ["编辑文件", "修改文件", "代码修改", "edit file", "patch"],
    "search_code": ["搜索代码", "全局搜索", "grep", "search code", "ripgrep"],
    "find_files": ["查找文件", "文件名搜索", "find files", "glob"],
    "git_status": ["git状态", "版本控制", "查看改动", "git status"],
    "git_diff": ["查看差异", "代码对比", "git diff"],
    "git_commit": ["提交代码", "提交暂存", "git commit"],
}


_GLOBAL_TOOL_INDEX: Optional[ToolRegistryIndex] = None


def _sync_from_global_registry(index: ToolRegistryIndex) -> None:
    """自动将全局 ToolRegistry 中的全部工具同步入索引，增强中英文语义标签。"""
    try:
        from tools import get_tool_registry
        reg = get_tool_registry()
        all_tools = reg.list_tools()
        changed = False
        for t in all_tools:
            if t.name not in index._tools:
                extra_tags = list(getattr(t, "tags", []) or [])
                domain = getattr(t, "domain", "general") or "general"
                if domain in DOMAIN_SEMANTIC_TAGS:
                    extra_tags.extend(DOMAIN_SEMANTIC_TAGS[domain])
                if t.name in DOMAIN_SEMANTIC_TAGS:
                    extra_tags.extend(DOMAIN_SEMANTIC_TAGS[t.name])

                meta = ToolMeta(
                    name=t.name,
                    description=t.description or "",
                    parameters=getattr(t, "schema", {}) or getattr(t, "parameters", {}) or {},
                    category=domain,
                    tags=extra_tags,
                    is_core=False,
                )
                index._tools[t.name] = meta
                changed = True
        if changed:
            index._rebuild_index()
    except Exception:
        pass


def get_tool_index() -> ToolRegistryIndex:
    global _GLOBAL_TOOL_INDEX
    if _GLOBAL_TOOL_INDEX is None:
        _GLOBAL_TOOL_INDEX = ToolRegistryIndex()
    _sync_from_global_registry(_GLOBAL_TOOL_INDEX)
    return _GLOBAL_TOOL_INDEX


def tool_search_handler(query: str, limit: int = 5) -> dict[str, Any]:
    """tool_search 工具运行时执行入口"""
    index = get_tool_index()
    results = index.search(query=query, top_k=limit)
    return {
        "status": "ok",
        "query": query,
        "count": len(results),
        "matches": [
            {
                "name": r.name,
                "category": r.category,
                "description": r.description,
                "parameters": r.parameters_summary,
                "relevance_score": r.score,
            }
            for r in results
        ],
    }
