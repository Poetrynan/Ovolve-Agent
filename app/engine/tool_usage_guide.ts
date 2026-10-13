/**
 * tool_usage_guide.ts — 工具使用指南（注入 system prompt）
 *
 * Ported from `app/backend/tool_usage_guide.py` (66 lines).
 *
 * 模型在 20+ 工具中挑选时经常选错（"读 README.md" 选成 search_code）。
 * 本模块生成一段简洁的工具使用指南注入 system prompt，明确"什么时候用
 * 什么工具"。设计原则：精简（8-10 个工具）/ 明确（何时用/何时不用的边界）/
 * 示例（具体使用场景）。
 *
 * RULEBOOK CITATIONS
 *   §1  零依赖。
 *   §4  naming: tool_usage_guide.py → tool_usage_guide.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

/** 生成工具使用指南（注入 system prompt 的 TOOLS 层）。 */
export function get_tool_usage_guide(): string {
  return `
## 工具选择规则（必须遵守）

### 文件操作
| 工具 | 何时使用 | 何时不使用 |
|------|----------|------------|
| \`read_text\` | 需要知道文件**内容**时（读代码、读文档） | 只需要知道文件是否存在/大小时 → 用 \`get_file_info\` |
| \`write_file\` | **新建**文件，或**完整替换**已有文件 | 只修改文件的一部分 → 用 \`edit_file\` |
| \`edit_file\` | **修改**已有文件的某一行/某段 | 创建新文件 → 用 \`write_file\` |
| \`find_files\` | 按文件名/模式查找文件（如 "src/**/*.py"） | 按内容查找 → 用 \`search_code\` |
| \`search_code\` | 按**内容**搜索代码（如找 "TODO" 或函数定义） | 按文件名查找 → 用 \`find_files\` |
| \`get_file_info\` | 查看文件大小、权限、修改时间 | 需要文件内容 → 用 \`read_text\` |

### Git 操作
| 工具 | 何时使用 | 何时不使用 |
|------|----------|------------|
| \`git_status\` | 查看哪些文件被修改/新增/删除 | 查看文件内容 → 用 \`read_text\` |
| \`git_diff\` | 查看文件的具体改动内容 | 查看提交历史 → 用 \`git_log\` |
| \`git_log\` | 查看提交历史 | 查看当前状态 → 用 \`git_status\` |

### 命令执行
| 工具 | 何时使用 | 何时不使用 |
|------|----------|------------|
| \`run_command\` | 运行构建/测试/包管理命令（npm, pytest, cargo） | 读/写文件 → 用 \`read_text\`/\`write_file\` |

### 快速决策流程
\`\`\`
用户问："读 README.md"
  → 用 read_text(path="README.md")

用户问："搜索所有 TODO"
  → 用 search_code(query="TODO")

用户问："创建一个 utils.py"
  → 用 write_file(path="utils.py", content="...")

用户问："修改 login.py 的第 42 行"
  → 先用 read_text(path="login.py") 读取
  → 再用 edit_file(path="login.py", old_string="...", new_string="...")

用户问："git 状态"
  → 用 git_status()

用户问："运行测试"
  → 用 run_command(command="pytest" 或 "npm test")
\`\`\`

### 黄金法则
1. **先读后改**：编辑文件前必须先用 read_text 读取内容
2. **精确匹配**：能用具体工具（read_text/write_file）就不用通用工具（run_command）
3. **权限最小**：低风险任务用低风险工具（read_text 而不是 run_command）
`;
}
