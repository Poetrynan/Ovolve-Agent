// channelsApi.ts — 渠道网关的类型化客户端。
//
// 对应后端 /api/channels* 路由（channel_gateway.py）。独立成域客户端而非
// 塞进 api.ts：渠道是自己的领域（配置 CRUD + 入站事件），工具函数放共享层
// 会把"领域知识"稀释成一把万能钥匙。类型与后端载荷一一对应，字段改名即
// 编译期报错——REST 合同靠类型钉死，不靠口头约定。

import { apiGet, apiPost, sendJson } from './api'

/** 一个已配置的入站渠道（secret 永不下发，只有"是否受保护"标记）。 */
export interface ChannelInfo {
  id: string
  /** trusted = 消息直接驱动会话；untrusted = 消息只入队等审批 */
  trust: 'trusted' | 'untrusted'
  enabled: boolean
  /** 回信 webhook；空串 = 不回信 */
  replyUrl: string
  /** 绑定的会话 id；空 = 自动派生 `channel::<id>` */
  session: string
  /** 渠道会话的工作区；空 = 用默认工作区 */
  workspace: string
  /** 落盘的 secret 是否已是受保护形态（enc:/env:/plain:） */
  secretProtected: boolean
}

export interface ChannelUpsert {
  id: string
  /** 明文传入即可——后端落盘前加密（enc:），已带前缀的值原样保留 */
  secret: string
  trust: 'trusted' | 'untrusted'
  enabled?: boolean
  replyUrl?: string
  session?: string
  workspace?: string
}

export interface ChannelListResult {
  channels: ChannelInfo[]
}

export interface ChannelUpsertResult {
  id: string
  ok: boolean
}

export interface ChannelRemoveResult {
  id: string
  removed: boolean
}

/** 渠道清单（secret 永不出现在响应里）。 */
export function listChannels(): Promise<ChannelListResult> {
  return apiGet<ChannelListResult>('/api/channels')
}

/** 新增/更新渠道。secret 明文提交，服务端密封落盘。 */
export function upsertChannel(body: ChannelUpsert): Promise<ChannelUpsertResult> {
  return apiPost<ChannelUpsertResult>('/api/channels', body)
}

/** 删除渠道。 */
export function removeChannel(id: string): Promise<ChannelRemoveResult> {
  return sendJson<ChannelRemoveResult>(`/api/channels/${encodeURIComponent(id)}`, 'DELETE')
}
