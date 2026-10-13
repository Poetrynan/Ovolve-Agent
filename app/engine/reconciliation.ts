/**
 * reconciliation.ts — 任务完成态 5D 自动收口与文档对齐中间件 (Phase 59 内化模块)。
 *
 * Ported from `app/backend/reconciliation.py` (152 lines).
 *
 * 从 neat-freak 技能提纯并硬内化为底层物理确定性代码：
 * 1. 自动扫描 Git 变更文件与受影响模块 (scan_git_mutations)；
 * 2. 5D 审计文档状态 (PROGRESS.md 等 6 大核心文档)；
 * 3. 自动扫描并物理清理工作区临时垃圾文件 (*.tmp, 孤儿调试脚本)；
 * 4. 输出零 Token 消耗的高确定性收口审计报告 (ReconciliationSummary)。
 *
 * RULEBOOK CITATIONS
 *   §1  node:child_process (git status --porcelain, timeout 5s) / node:fs。
 *   §2  `git status --porcelain` 输出解析逐字：前 2 字符状态码 + 第 3 字符起
 *       路径；"?" in status → added。fail-open（git 异常不中断主业务）。
 *   §2  os.walk → 手写递归（忽略 .git/node_modules/venv/.venv/__pycache__，
 *       与源的 any(ignored in root) 子串匹配语义一致）。
 *   §4  naming: reconciliation.py → reconciliation.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** 任务收口审计报告实体。 */
export interface ReconciliationSummary {
  timestamp: number;
  workspace: string;
  modified_files: string[];
  added_files: string[];
  cleaned_ephemeral_files: string[];
  docs_audited: string[];
  is_pristine: boolean;
  audit_notes: string[];
}

export function summary_to_dict(s: ReconciliationSummary): Record<string, unknown> {
  // Python asdict() = plain copy
  return { ...s };
}

/** 生产级任务完成态自动收口引擎。 */
export class PostTurnReconciliationEngine {
  static readonly EPHEMERAL_PATTERNS = ["*.tmp", "*.temp", "*~", ".DS_Store", "Thumbs.db"];

  static readonly DOC_TARGETS = [
    "Documents/PROGRESS.md",
    "Documents/升级与BUG修复清单_合并版.md",
    "Documents/技术答疑手册_合并版.md",
    "Documents/技术学习指南_合并版.md",
    "AGENTS.md",
    "MEMORY.md",
  ];

  /** 扫描工作区中发生修改和新增的文件。 */
  static scan_git_mutations(workspace: string): [string[], string[]] {
    if (!workspace || !fs.existsSync(workspace)) {
      return [[], []];
    }

    const modified: string[] = [];
    const added: string[] = [];
    try {
      // 运行 git status --porcelain
      const res = spawnSync("git", ["status", "--porcelain"], {
        cwd: workspace,
        encoding: "utf-8",
        timeout: 5000,
      });
      if (res.status === 0 && typeof res.stdout === "string") {
        for (const line0 of res.stdout.trim().split("\n")) {
          const line = line0.replace(/\r$/, "");
          if (!line || line.length < 3) {
            continue;
          }
          const status_code = line.slice(0, 2);
          const file_path = line.slice(3).trim().replace(/^"|"$/g, "");
          if (status_code.includes("?")) {
            added.push(file_path);
          } else {
            modified.push(file_path);
          }
        }
      }
    } catch {
      // fail-open: git 扫描异常不中断主业务
    }

    return [modified, added];
  }

  /** 安全扫描并清理临时调试文件。 */
  static cleanup_ephemeral_files(workspace: string): string[] {
    const cleaned: string[] = [];
    if (!workspace || !fs.existsSync(workspace)) {
      return cleaned;
    }

    try {
      // 仅在工作区清理已知临时后缀；os.walk 语义 = 递归 + 忽略目录子串匹配
      const IGNORED = [".git", "node_modules", "venv", ".venv", "__pycache__"];
      const walk = (root: string) => {
        if (IGNORED.some((ignored) => root.includes(ignored))) {
          return;
        }
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const full_p = path.join(root, e.name);
          if (e.isDirectory()) {
            walk(full_p);
            continue;
          }
          if (
            e.name.endsWith(".tmp") ||
            e.name.endsWith(".temp") ||
            e.name.startsWith("tmp_debug_")
          ) {
            try {
              fs.unlinkSync(full_p);
              cleaned.push(path.relative(workspace, full_p));
            } catch {
              // OSError: pass
            }
          }
        }
      };
      walk(workspace);
    } catch {
      // except Exception: pass
    }

    return cleaned;
  }

  /** 核对 6 大核心文档的物理存在与可读性。 */
  static audit_docs(workspace: string): string[] {
    const audited: string[] = [];
    if (!workspace || !fs.existsSync(workspace)) {
      return audited;
    }

    for (const doc_rel of PostTurnReconciliationEngine.DOC_TARGETS) {
      const full_p = path.join(workspace, doc_rel);
      if (fs.existsSync(full_p)) {
        audited.push(doc_rel);
      }
    }
    return audited;
  }

  /** 一键执行完整的 5D 收口对齐审计。 */
  static run_reconciliation(workspace: string): ReconciliationSummary {
    const [modified, added] = PostTurnReconciliationEngine.scan_git_mutations(workspace);
    const cleaned = PostTurnReconciliationEngine.cleanup_ephemeral_files(workspace);
    const audited = PostTurnReconciliationEngine.audit_docs(workspace);

    const notes: string[] = [];
    if (modified.length > 0 || added.length > 0) {
      notes.push(`检测到代码/工程变更: ${modified.length} 修改, ${added.length} 新增`);
    }
    if (cleaned.length > 0) {
      notes.push(`自动清理临时文件: ${cleaned.slice(0, 3).join(", ")}`);
    }
    notes.push(`核心文档对齐就绪: ${audited.length} 份核心文档状态正常`);

    return {
      timestamp: Date.now() / 1000,
      workspace,
      modified_files: modified,
      added_files: added,
      cleaned_ephemeral_files: cleaned,
      docs_audited: audited,
      is_pristine: cleaned.length === 0,
      audit_notes: notes,
    };
  }
}
