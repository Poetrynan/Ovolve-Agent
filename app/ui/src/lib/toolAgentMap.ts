import type { AgentRole } from '@apptypes/index'

/** Map tool names → owning sub-agent (router AGENT_ROLES alignment). */
const FILE = new Set([
  'read_text', 'read_file', 'write_file', 'edit_file', 'delete_file',
  'search_code', 'find_files', 'list_dir', 'convert_file',
  'git_status', 'git_add', 'git_commit', 'git_push', 'git_pull',
  'git_diff', 'git_log', 'git_show', 'git_branch', 'git_checkout',
])
const COMPUTER = new Set([
  'shell_executor', 'bash', 'python_executor', 'native_action_chain',
  'action_search', 'system_info', 'process_list', 'process_kill',
  'disk_usage', 'network_interfaces', 'env_get', 'diagnose',
])
const APP = new Set([
  'operate_app', 'ui_automation', 'ui_screenshot', 'app_list', 'app_install', 'app_uninstall',
  'app_launch', 'app_close', 'app_focus',
  'computer_screenshot', 'computer_click', 'computer_move_cursor',
  'computer_type', 'computer_press_key', 'computer_drag', 'computer_scroll',
])
const BROWSER = new Set(['navigate', 'snapshot', 'click', 'fill', 'evaluate', 'web_fetch'])
const SEARCH = new Set([
  'academic_search', 'standard_search', 'web_search', 'semantic_search',
  'credibility_check', 'recommend',
])

export function toolToAgent(toolName: string): AgentRole {
  if (FILE.has(toolName)) return 'file_agent'
  if (COMPUTER.has(toolName)) return 'computer_agent'
  if (APP.has(toolName)) return 'app_agent'
  if (BROWSER.has(toolName)) return 'browser_agent'
  if (SEARCH.has(toolName)) return 'search_agent'
  return 'pilot'
}

export const AGENT_LABELS: Record<AgentRole, string> = {
  pilot: 'Ovolve',
  file_agent: 'Chronos',
  computer_agent: 'Engine',
  app_agent: 'Matrix',
  browser_agent: 'Voyager',
  search_agent: 'Oracle',
}

export const DOMAIN_SUBTITLES: Record<AgentRole, string> = {
  pilot: '主控中枢 · 任务编排',
  file_agent: '文件 · 代码 · Git',
  computer_agent: '系统 · 终端 · 进程',
  app_agent: '桌面 · 应用 · 视觉',
  browser_agent: '浏览器 · 网页交互',
  search_agent: '全网检索 · 知识挖掘',
}

export const SUBAGENT_METADATA: Record<string, { label: string; desc: string; color: string }> = {
  explore: {
    label: 'Explore 探索者',
    desc: '只读搜索 · 符号定位 · 架构调查',
    color: '#06B6D4', // cyan
  },
  planner: {
    label: 'Planner 规划师',
    desc: '只读拆解 · 依赖分析 · 验收标准',
    color: '#8B5CF6', // violet
  },
  reviewer: {
    label: 'Reviewer 审查员',
    desc: '3-State 严格验证 · 缺陷捕获',
    color: '#EC4899', // pink
  },
  coder: {
    label: 'Coder 工程师',
    desc: 'Worktree 隔离 · 完整编码交付',
    color: '#10B981', // emerald
  },
}

/** Per-role accent colors. Lives here next to the labels because both are the
 *  identity of a role, not of any one surface that draws it. */
export const ROLE_THEME_COLORS: Record<AgentRole, string> = {
  pilot: '#DC2626',          // crimson
  file_agent: '#9333EA',     // purple
  computer_agent: '#F59E0B', // orange
  app_agent: '#EAB308',      // amber
  browser_agent: '#10B981',  // emerald
  search_agent: '#3B82F6',   // blue
}
