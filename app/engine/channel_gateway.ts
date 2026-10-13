/**
 * channel_gateway.ts — 通用 HMAC webhook 渠道网关（Ovolve 开放约定层）。
 *
 * Ported from `app/backend/channel_gateway.py` (335 lines, wave 5 TS).
 * Provides an open HMAC-SHA256 webhook gateway allowing any IM bot or external
 * automation system to interface with Ovolve without vendor-specific SDK bindings.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/channel_gateway.py -> app/engine/channel_gateway.ts
 *   §2  exact CPython semantics for HMAC signature validation, constant-time compare,
 *       replay window check, secret unsealing/sealing, and audit logging.
 *
 * MIGRATION DECISIONS / DIVERGENCES
 *   http client: Python urllib.request.urlopen in asyncio.to_thread mapped to fetch / GATEWAY_SEAMS.httpPost.
 *   mailbox: mailbox.py is unported wave-5 Rust; delegated to GATEWAY_SEAMS.mailboxSend fail-open.
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import { EventType } from "./event_types.js";
import { TraceGateway, OBSERVATIONAL } from "./trace_gateway.js";
import { resolve_secret } from "./mcp_oauth.js";
import { CredentialCipher } from "./model_registry_impl.js";
import { get_storage } from "./storage.js";

/** 签名时间窗（秒）。窗口外的请求按重放拒绝。 */
export const SIGNATURE_MAX_AGE_S = 300;

/** 渠道配置在 config.json 里的顶层键。 */
const _CHANNELS_KEY = "channels";

const _TRUST_LEVELS = ["trusted", "untrusted"] as const;

export const GATEWAY_SEAMS = {
    now: (): number => Date.now() / 1000,
    configPath: (): string => {
        const dir = path.dirname(url.fileURLToPath(import.meta.url));
        return path.resolve(dir, "..", "config.json");
    },
    httpPost: async (targetUrl: string, headers: Record<string, string>, body: string): Promise<void> => {
        const resp = await fetch(targetUrl, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(10000),
        });
        await resp.arrayBuffer();
    },
    mailboxSend: (_storage: any, _to: string, _fromSender: string, _kind: string, _payload: any): void => {
        // Fallback / hookable seam for mailbox dispatch
    },
};

export function _resolve_secret(stored: string): string {
    /**
     * 解封渠道 secret（enc: / env: / plain: / legacy 明文）。
     * 复用 mcp_oauth 的同一套解析 —— 全系统的密封凭证走同一条解封路径，
     * 而不是每个模块各写一份。解封失败返回空串：验证会以 mismatch 拒绝
     * （可审计），而不是崩溃。
     */
    const s = String(stored ?? "").trim();
    if (!s) {
        return "";
    }
    if (s.startsWith("enc:") || s.startsWith("env:") || s.startsWith("plain:")) {
        try {
            return resolve_secret(s);
        } catch {
            return "";
        }
    }
    return s;
}

// ---------------------------------------------------------------------------
// 配置管理
// ---------------------------------------------------------------------------

function _config_path(): string {
    return GATEWAY_SEAMS.configPath();
}

export function load_channels(): Record<string, any> {
    /** config.json 的 channels 块。坏块按空处理——渠道故障不能拖垮启动。 */
    try {
        const p = _config_path();
        const content = fs.readFileSync(p, "utf-8");
        const parsed = JSON.parse(content);
        const raw = parsed?.[_CHANNELS_KEY];
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
            return raw;
        }
        return {};
    } catch {
        return {};
    }
}

export function _persist_channels(channels: Record<string, any>): void {
    const filePath = _config_path();
    let cfg: Record<string, any> = {};
    try {
        const content = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            cfg = parsed;
        }
    } catch {}
    cfg[_CHANNELS_KEY] = channels;
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf-8");
    fs.renameSync(tmp, filePath); // 原子替换，与 _persist_config 同款纪律
}

export function _seal_secret(entry: Record<string, any>): Record<string, any> {
    /** 明文 secret 落盘前加密（enc: 前缀，同 model_registry 主密钥体系）。 */
    const secret = String(entry?.secret ?? "");
    if (secret && !secret.startsWith("enc:") && !secret.startsWith("env:") && !secret.startsWith("plain:")) {
        try {
            return { ...entry, secret: new CredentialCipher().encrypt(secret) };
        } catch {
            // 加密不可用 → 原样落盘（fail-open），审计可见
        }
    }
    return entry;
}

export function upsert_channel(channel_id: string, entry: any): string | null {
    /**
     * 新增/更新一个渠道。返回错误信息，null 为成功。
     *
     * secret 语义：新建必须提供；更新时留空 = 保留原密钥——编辑表单和
     * 启停开关都不该强迫用户重输密钥（重输一次就多一次泄露面）。
     */
    const cid = String(channel_id ?? "").trim();
    if (!cid || cid.includes("/") || cid.includes("\\") || cid === "." || cid === "..") {
        return "illegal channel id";
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return "invalid: object expected";
    }
    const trust = String(entry.trust ?? "untrusted").trim().toLowerCase();
    if (trust !== "trusted" && trust !== "untrusted") {
        return `illegal trust '${trust}' (expected trusted|untrusted)`;
    }
    const channels = load_channels();
    const existing = channels[cid];
    let secret = String(entry.secret ?? "").trim();
    if (!secret && existing) {
        secret = String(existing.secret ?? ""); // 更新留空 → 沿用原密封值
    }
    if (!secret) {
        return "secret required";
    }
    channels[cid] = _seal_secret({
        ...entry,
        secret,
        trust,
        enabled: Boolean(entry.enabled ?? true),
        reply_url: String(entry.reply_url ?? "").trim(),
        session: String(entry.session ?? "").trim(),
        workspace: String(entry.workspace ?? "").trim(),
    });
    _persist_channels(channels);
    return null;
}

export function remove_channel(channel_id: string): boolean {
    const channels = load_channels();
    if (!Object.prototype.hasOwnProperty.call(channels, channel_id)) {
        return false;
    }
    delete channels[channel_id];
    _persist_channels(channels);
    return true;
}

export function list_channels(): Array<{
    id: string;
    trust: string;
    enabled: boolean;
    replyUrl: string;
    session: string;
    workspace: string;
    secretProtected: boolean;
}> {
    /** 给 REST 的渠道清单 —— secret 只回显保护形态标记，绝不回原文。 */
    const out: Array<{
        id: string;
        trust: string;
        enabled: boolean;
        replyUrl: string;
        session: string;
        workspace: string;
        secretProtected: boolean;
    }> = [];
    const entries = Object.entries(load_channels()).sort(([a], [b]) => a.localeCompare(b));
    for (const [cid, e] of entries) {
        const secret = String(e?.secret ?? "");
        out.push({
            id: cid,
            trust: e?.trust ?? "untrusted",
            enabled: Boolean(e?.enabled ?? true),
            replyUrl: e?.reply_url ?? "",
            session: e?.session ?? "",
            workspace: e?.workspace ?? "",
            secretProtected: secret.startsWith("enc:") || secret.startsWith("env:") || secret.startsWith("plain:"),
        });
    }
    return out;
}

// ---------------------------------------------------------------------------
// 签名校验
// ---------------------------------------------------------------------------

export function verify_signature(
    secret: string,
    header: string,
    body: Buffer | Uint8Array | string,
    now?: number | null,
): [boolean, string] {
    /** 校验 X-Ovolve-Signature。返回 (ok, 原因)。常量时间比较，无信息泄露。 */
    const current_now = now !== null && now !== undefined ? now : GATEWAY_SEAMS.now();
    const parsed: Record<string, string> = {};
    for (const part of String(header ?? "").split(",")) {
        const idx = part.indexOf("=");
        if (idx >= 0) {
            const k = part.slice(0, idx).trim();
            const v = part.slice(idx + 1).trim();
            parsed[k] = v;
        } else {
            parsed[part.trim()] = "";
        }
    }
    const ts_raw = parsed["t"] ?? "";
    const sig = parsed["v1"] ?? "";
    if (!ts_raw || !sig) {
        return [false, "missing signature fields"];
    }
    const ts = parseFloat(ts_raw);
    if (Number.isNaN(ts)) {
        return [false, "bad timestamp"];
    }
    if (Math.abs(current_now - ts) > SIGNATURE_MAX_AGE_S) {
        return [false, `timestamp outside ±${SIGNATURE_MAX_AGE_S}s window (replay?)`];
    }

    let bodyText = "";
    if (typeof body === "string") {
        bodyText = body;
    } else {
        bodyText = Buffer.from(body).toString("utf-8");
    }
    const message = `${ts_raw}.${bodyText}`;
    const expected = crypto.createHmac("sha256", Buffer.from(String(secret), "utf-8"))
        .update(Buffer.from(message, "utf-8"))
        .digest("hex");

    if (expected.length !== sig.length) {
        return [false, "signature mismatch"];
    }
    const bufExpected = Buffer.from(expected);
    const bufSig = Buffer.from(sig);
    if (!crypto.timingSafeEqual(bufExpected, bufSig)) {
        return [false, "signature mismatch"];
    }
    return [true, ""];
}

// ---------------------------------------------------------------------------
// 入站派发
// ---------------------------------------------------------------------------

export async function handle_inbound(
    host: any,
    channel_id: string,
    headers: Record<string, string>,
    body: Buffer | Uint8Array | string,
): Promise<[number, Record<string, any>]> {
    /**
     * 渠道入站入口（http_server 的 route handler 只做参数搬运）。
     *
     * 返回 [http_status, payload]。整条链路留审计：
     * received / rejected / held / dispatched / replied 在事件链里都可回答。
     */
    const session_id = String(load_channels()?.[channel_id]?.session ?? "").trim()
        || `channel::${channel_id}`;
    const gateway = new TraceGateway();

    const _audit = (event_type: any, extra: Record<string, any> = {}): void => {
        try {
            gateway.append({
                session_id,
                event_type,
                payload: { channel: channel_id, ...extra },
                importance: OBSERVATIONAL,
            });
        } catch {
            // 审计失败不影响派发决策本身
        }
    };

    const cfg = load_channels()?.[channel_id];
    if (cfg === undefined || cfg === null) {
        return [404, { error: "unknown channel" }];
    }
    if (!cfg.enabled && cfg.enabled !== undefined) {
        return [503, { error: "channel disabled" }];
    }

    // 落盘的 secret 是密封形态（enc:/env:/plain:）——验证前先解封。
    const secret = _resolve_secret(String(cfg.secret ?? ""));

    const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    _audit(EventType.CHANNEL_MESSAGE_RECEIVED, { chars: bodyBuf.length });

    const sigHeader = headers["X-Ovolve-Signature"] ?? headers["x-ovolve-signature"] ?? "";
    const [ok, reason] = verify_signature(secret, sigHeader, bodyBuf, GATEWAY_SEAMS.now());
    if (!ok) {
        _audit(EventType.CHANNEL_MESSAGE_REJECTED, { reason });
        return [401, { error: `signature rejected: ${reason}` }];
    }

    let payload: any;
    try {
        const textBody = bodyBuf.toString("utf-8");
        payload = JSON.parse(textBody);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw new Error("object expected");
        }
    } catch (exc: any) {
        _audit(EventType.CHANNEL_MESSAGE_REJECTED, { reason: `bad json: ${exc?.message ?? exc}` });
        return [400, { error: "invalid JSON body" }];
    }

    const text = String(payload.text ?? payload.message ?? "").trim();
    const message_id = String(payload.id ?? "");
    if (!text) {
        _audit(EventType.CHANNEL_MESSAGE_REJECTED, { reason: "empty text" });
        return [400, { error: "text required" }];
    }

    const trust = String(cfg.trust ?? "untrusted");
    const workspace = String(cfg.workspace ?? "").trim();

    if (trust !== "trusted") {
        // 安装≠信任的渠道版：untrusted 渠道的消息不执行，落操作员邮箱待审。
        _audit(EventType.CHANNEL_MESSAGE_HELD, { messageId: message_id, preview: text.slice(0, 200) });
        try {
            const storage = get_storage();
            GATEWAY_SEAMS.mailboxSend(storage, "mailbox::operator", "channel_gateway", "warn", {
                event: "channel_message_held",
                channel: channel_id,
                messageId: message_id,
                preview: text.slice(0, 200),
            });
        } catch {}
        return [202, { status: "held_for_approval", channel: channel_id }];
    }

    // 派发为该渠道会话的一个回合 —— 与 WS 聊天/厂商 bot 同一条 Router.handle。
    let reply = "";
    let ok_reply = false;
    try {
        const router = host.get_or_create(session_id, workspace);
        const ctx = {
            session_id,
            workspace_root: workspace || (host as any)?._default_workspace || "",
            source: `channel:${channel_id}`,
        };
        const result = await router.handle(text, ctx);
        ok_reply = Boolean(result?.ok);
        if (ok_reply) {
            reply = String(result?.value ?? "");
        } else {
            reply = String(result?.error ?? "turn failed");
        }
    } catch (exc: any) {
        const excName = exc?.constructor?.name ?? exc?.name ?? "Error";
        const excMsg = String(exc?.message ?? exc);
        _audit(EventType.CHANNEL_MESSAGE_REJECTED, { reason: `dispatch failed: ${excName}: ${excMsg}` });
        return [500, { error: "turn dispatch failed" }];
    }

    _audit(EventType.CHANNEL_MESSAGE_DISPATCHED, { messageId: message_id, ok: ok_reply });

    // 回信：POST 到 reply_url（同样带 HMAC 签名）。
    const reply_url = String(cfg.reply_url ?? "").trim();
    if (reply_url) {
        try {
            await _post_reply(channel_id, secret, reply_url, {
                channel: channel_id,
                id: message_id,
                text: reply.slice(0, 8000),
                ok: ok_reply,
            });
            _audit(EventType.CHANNEL_REPLY_SENT, { to: reply_url });
        } catch (exc: any) {
            const excName = exc?.constructor?.name ?? exc?.name ?? "Error";
            const excMsg = String(exc?.message ?? exc);
            _audit(EventType.CHANNEL_REPLY_FAILED, { error: `${excName}: ${excMsg}` });
        }
    }

    return [200, { status: "dispatched", session: session_id, ok: ok_reply }];
}

export function sign_payload(secret: string, body: string, now?: number | null): string {
    /** 出站方向的同款签名头（回信/未来出站 webhook 共用）。 */
    const current_now = now !== null && now !== undefined ? now : GATEWAY_SEAMS.now();
    const t = String(Math.floor(current_now));
    const sig = crypto.createHmac("sha256", Buffer.from(String(secret), "utf-8"))
        .update(Buffer.from(`${t}.${body}`, "utf-8"))
        .digest("hex");
    return `t=${t},v1=${sig}`;
}

export async function _post_reply(channel_id: string, secret: string, targetUrl: string, payload: any): Promise<void> {
    /** 回信 POST。短超时：渠道回信慢不能占着事件循环。 */
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Ovolve-Signature": sign_payload(secret, body),
    };
    await GATEWAY_SEAMS.httpPost(targetUrl, headers, body);
}

// PORT STATUS: confidence=high todos=[0]
