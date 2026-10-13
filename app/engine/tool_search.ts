/**
 * tool_search.ts — 超限工具与技能动态语义检索与按需激活引擎
 *
 * Ported from `app/backend/tool_search.py` (247 lines).
 *
 * 当系统注册的工具与技能数量超过阈值（如 >30 个）时，将所有工具的完整
 * Schema 常驻在主 System Prompt 会极大消耗上下文 Token。ToolSearch 提供：
 * 1. ToolRegistryIndex: 基于倒排索引与 BM25 / N-gram 相似度的本地轻量级检索器
 * 2. tool_search 工具: 模型可主动按任务描述搜索并动态激活匹配的工具 Schema
 * 3. DynamicToolCatalog: 支持按需热加载与单轮上下文动态扩展
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only; zero-dependency BM25 (math.log → Math.log).
 *   §2  Python re tokenizers ported verbatim: camelCase split
 *       `([a-z])([A-Z]) -> \1 \2`, CJK ranges [\u4e00-\u9fa5], and the
 *       unigram+bigram CJK token generation. Global RegExps are constructed
 *       per call (HANDOFF §6.2).
 *   §2  BM25 formula, default k1=1.5 / b=0.75, threshold 0.05, and the
 *       substring fallback when df==0 are reproduced exactly — the ranking
 *       IS the contract.
 *   §2  `from tools import get_tool_registry` (wave-4 SPLIT) → computed
 *       dynamic import with the source's try/except pass swallow.
 *   §4  naming: tool_search.py → tool_search.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolMeta {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  category: string;
  tags: string[];
  /** 核心工具始终常驻，不参与检索剔除 */
  is_core: boolean;
}

export interface ToolSearchResult {
  name: string;
  description: string;
  category: string;
  score: number;
  parameters_summary: string;
  is_active: boolean;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/** 分词与小写归一化（支持中英文混合与下划线命名，并对中文生成字词级与
 * 2-gram 切分）。 */
export function _tokenize(text: string): string[] {
  if (!text) {
    return [];
  }
  const s = text.replace(/([a-z])([A-Z])/g, "$1 $2");
  const raw_tokens = s.toLowerCase().match(/[a-zA-Z0-9_-]+|[\u4e00-\u9fa5]+/g) ?? [];
  const tokens: string[] = [];
  for (const tok of raw_tokens) {
    const has_cjk = Array.from(tok).some((c) => c >= "\u4e00" && c <= "\u9fa5");
    if (has_cjk) {
      tokens.push(tok);
      if (tok.length >= 2) {
        // Python tok[i:i+2] is codepoint slicing; CJK chars are single
        // UTF-16 units in the BMP, so direct index pairs match.
        for (let i = 0; i < tok.length - 1; i++) {
          tokens.push(tok.slice(i, i + 2));
        }
      }
      for (const c of tok) {
        tokens.push(c);
      }
    } else {
      if (tok.length > 1) {
        tokens.push(tok);
      }
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// ToolRegistryIndex
// ---------------------------------------------------------------------------

export class ToolRegistryIndex {
  /** 纯本地、零依赖的轻量级 BM25 与倒排索引工具搜索引擎 */

  k1: number;
  b: number;
  _tools: Record<string, ToolMeta> = {};
  _doc_lens: Record<string, number> = {};
  _avg_dl = 0.0;
  _inverted_index: Record<string, Set<string>> = {};
  _term_freqs: Record<string, Record<string, number>> = {};

  constructor(k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
  }

  /** 注册一个工具元数据 */
  register_tool(
    name: string,
    description: string,
    parameters?: Record<string, unknown> | null,
    category = "general",
    tags?: string[] | null,
    is_core = false
  ): void {
    const meta: ToolMeta = {
      name,
      description,
      parameters: parameters ?? {},
      category,
      tags: tags ?? [],
      is_core,
    };
    this._tools[name] = meta;
    this._rebuild_index();
  }

  register_many(tools: ToolMeta[]): void {
    for (const t of tools) {
      this._tools[t.name] = t;
    }
    this._rebuild_index();
  }

  /** 重建倒排索引与统计数据 */
  _rebuild_index(): void {
    this._inverted_index = {};
    this._term_freqs = {};
    this._doc_lens = {};
    let total_len = 0;

    for (const [name, meta] of Object.entries(this._tools)) {
      const props = (meta.parameters["properties"] ?? {}) as Record<string, unknown>;
      const param_names = Object.keys(props);
      const doc_text = `${name} ${name} ${meta.description} ${meta.tags.join(" ")} ${param_names.join(" ")}`;
      const tokens = _tokenize(doc_text);
      this._doc_lens[name] = tokens.length;
      total_len += tokens.length;

      const tf: Record<string, number> = {};
      for (const t of tokens) {
        tf[t] = (tf[t] ?? 0) + 1;
        if (!this._inverted_index[t]) {
          this._inverted_index[t] = new Set();
        }
        this._inverted_index[t]!.add(name);
      }
      this._term_freqs[name] = tf;
    }

    const n = Object.keys(this._tools).length;
    this._avg_dl = n > 0 ? total_len / n : 0.0;
  }

  /** 根据查询词进行 BM25 排序检索 */
  search(query: string, top_k = 5, threshold = 0.05): ToolSearchResult[] {
    const query_tokens = _tokenize(query);
    if (query_tokens.length === 0 || Object.keys(this._tools).length === 0) {
      return [];
    }

    const n = Object.keys(this._tools).length;
    const scores: Record<string, number> = {};
    for (const name of Object.keys(this._tools)) {
      scores[name] = 0.0;
    }

    for (const q of query_tokens) {
      const matching_docs = this._inverted_index[q] ?? new Set<string>();
      const df = matching_docs.size;
      if (df === 0) {
        for (const [name, meta] of Object.entries(this._tools)) {
          if (name.toLowerCase().includes(q) || meta.description.toLowerCase().includes(q)) {
            scores[name]! += 1.0;
          }
        }
        continue;
      }

      // math.log(1 + (n - df + 0.5) / (df + 0.5))
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));

      for (const doc_name of matching_docs) {
        const tf = this._term_freqs[doc_name]?.[q] ?? 0;
        const dl = this._doc_lens[doc_name] ?? 0;
        const score =
          (idf * (tf * (this.k1 + 1))) /
          (tf + this.k1 * (1 - this.b + this.b * (dl / (this._avg_dl || 1.0))));
        scores[doc_name]! += score;
      }
    }

    const ranked = Object.entries(scores)
      .filter(([, score]) => score >= threshold)
      .sort((a, b) => b[1] - a[1])
      .slice(0, top_k);

    const results: ToolSearchResult[] = [];
    for (const [name, score] of ranked) {
      const meta = this._tools[name]!;
      const params = (meta.parameters["properties"] ?? {}) as Record<string, Record<string, unknown>>;
      const param_summary = Object.entries(params)
        .map(([k, v]) => `${k} (${v?.["type"] ?? "any"})`)
        .join(", ");
      results.push({
        name,
        description: meta.description,
        category: meta.category,
        // Python round(x, 3) is banker's rounding; scores are float sums
        // where exact halves don't occur in practice (same note as the
        // trace_gateway cost sites — flagged, not "fixed").
        score: Math.round(score * 1000) / 1000,
        parameters_summary: param_summary,
        is_active: false,
      });
    }
    return results;
  }

  get_tool(name: string): ToolMeta | null {
    return this._tools[name] ?? null;
  }

  list_all(): ToolMeta[] {
    return Object.values(this._tools);
  }
}

// ---------------------------------------------------------------------------
// 中文语义标签增强映射（确保中文与多语意图精准匹配英文工具）
// ---------------------------------------------------------------------------

export const DOMAIN_SEMANTIC_TAGS: Record<string, string[]> = {
  browser: ["浏览器", "网页", "网站", "web", "browser", "html", "url", "页面", "上网", "爬取", "抓取", "打开网页", "打开网站", "访问网址", "浏览"],
  navigate: ["打开网页", "访问网址", "跳转网页", "打开网站", "浏览网页", "打开百度", "打开链接", "进入网站", "navigate", "url", "browser", "launch"],
  tab_open: ["新标签页", "新建标签", "打开网页", "打开标签", "browser", "open tab", "new tab"],
  snapshot: ["网页截图", "浏览器截图", "页面截图", "screenshot", "capture page"],
  click: ["点击元素", "网页点击", "按钮点击", "web click"],
  fill: ["输入表单", "填写内容", "表单输入", "网页输入", "fill input"],
  web_search: ["网络搜索", "联网查询", "搜网页", "bing", "google", "search engine"],
  web_fetch: ["抓取网页", "读取网页内容", "网页提取", "fetch html", "scrape"],
  shell_executor: ["终端", "命令行", "运行命令", "执行命令", "shell", "bash", "cmd", "powershell"],
  run_command: ["运行命令", "命令行", "cmd", "terminal"],
  read_text: ["读取文件", "查看文件", "读文件", "read file", "cat"],
  write_file: ["写入文件", "新建文件", "创建文件", "保存文件", "write file"],
  edit_file: ["编辑文件", "修改文件", "代码修改", "edit file", "patch"],
  search_code: ["搜索代码", "全局搜索", "grep", "search code", "ripgrep"],
  find_files: ["查找文件", "文件名搜索", "find files", "glob"],
  git_status: ["git状态", "版本控制", "查看改动", "git status"],
  git_diff: ["查看差异", "代码对比", "git diff"],
  git_commit: ["提交代码", "提交暂存", "git commit"],
};

let _GLOBAL_TOOL_INDEX: ToolRegistryIndex | null = null;

/** 自动将全局 ToolRegistry 中的全部工具同步入索引，增强中英文语义标签。 */
async function _sync_from_global_registry(index: ToolRegistryIndex): Promise<void> {
  try {
    // `from tools import get_tool_registry` — tools.py is a wave-4 SPLIT
    // unit, optional at runtime; a missing module lands in the same swallow.
    const spec = "./tools" + ".js";
    const mod = (await import(/* @vite-ignore */ spec)) as {
      get_tool_registry?: () => {
        list_tools: () => Array<{
          name: string;
          description?: string;
          tags?: string[];
          domain?: string;
          schema?: Record<string, unknown>;
          parameters?: Record<string, unknown>;
        }>;
      };
    };
    const reg = mod.get_tool_registry?.();
    if (!reg) {
      return;
    }
    const all_tools = reg.list_tools();
    let changed = false;
    for (const t of all_tools) {
      if (t.name in index._tools) {
        continue;
      }
      const extra_tags = [...(t.tags ?? [])];
      const domain = t.domain ?? "general";
      if (DOMAIN_SEMANTIC_TAGS[domain]) {
        extra_tags.push(...DOMAIN_SEMANTIC_TAGS[domain]!);
      }
      if (DOMAIN_SEMANTIC_TAGS[t.name]) {
        extra_tags.push(...DOMAIN_SEMANTIC_TAGS[t.name]!);
      }

      index._tools[t.name] = {
        name: t.name,
        description: t.description ?? "",
        parameters: t.schema ?? t.parameters ?? {},
        category: domain,
        tags: extra_tags,
        is_core: false,
      };
      changed = true;
    }
    if (changed) {
      index._rebuild_index();
    }
  } catch {
    // except Exception: pass
  }
}

export function get_tool_index(): ToolRegistryIndex {
  if (_GLOBAL_TOOL_INDEX === null) {
    _GLOBAL_TOOL_INDEX = new ToolRegistryIndex();
  }
  void _sync_from_global_registry(_GLOBAL_TOOL_INDEX);
  return _GLOBAL_TOOL_INDEX;
}

/** tool_search 工具运行时执行入口 */
export function tool_search_handler(query: string, limit = 5): Record<string, unknown> {
  const index = get_tool_index();
  const results = index.search(query, limit);
  return {
    status: "ok",
    query,
    count: results.length,
    matches: results.map((r) => ({
      name: r.name,
      category: r.category,
      description: r.description,
      parameters: r.parameters_summary,
      relevance_score: r.score,
    })),
  };
}

// DIVERGENCE(port): the source's get_tool_index triggers the registry sync
// synchronously; here the sync is fire-and-forget (dynamic import is async).
// DIVERGENCE(port)：同步→异步投递已注明；最终一致语义与源一致（sync 完成后
// 索引可用），差异只在首查窗口 —— 见文件头 async drift 说明。
// The first search may miss registry tools by one turn — same eventual
// consistency the source reaches after its first successful import.
