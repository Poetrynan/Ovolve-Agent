/**
 * image_store.ts — 生成图片的落盘、取回、清理。
 *
 * Ported from `app/backend/image_store.py` (285 lines, wave-6, unit 156).
 *
 * ## 解决什么
 *
 * AI 生成的图片不能塞进消息内容：一张 1024×1024 PNG base64 之后约 1–2 MB，按
 * 4 字符 ≈ 1 token 估算就是 25–50 万 token，而 `router._build_history()` 会把
 * `session_messages.content` 原样重放进下一轮上下文。所以规矩是硬的：
 *
 *   · 图片字节 → 磁盘（本模块，`<workspace>/.ovolve/images/{id}.{ext}`）
 *   · `content` 列 → 只放 `placeholder()` 产出的短占位符（约 10 token）
 *   · `metadata` 列 → 只放 `save_*` 返回的轻量引用（id/mime/bytes/ext/name/path/url）
 *
 * 远程 URL 也走同一条路（下载后落盘）：生成器返回的 blob 链接约 1 小时过期，
 * 持久化记录里放会过期的链接，用户明天翻记录图片全裂。id 就是文件名主干，
 * 不需要额外索引表 —— 少一份需要同步的状态。
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/image_store.py -> app/engine/image_store.ts。公开
 *       python 名保持 snake_case 逐字不变：_EXT_BY_MIME、_MIME_BY_EXT、
 *       MAX_IMAGE_BYTES、DOWNLOAD_TIMEOUT、_SAFE_ID、SUBDIR、_dir_for、
 *       _ext_for_mime、mime_for_path、_strip_data_url、_new_id、_write_blob、
 *       _make_ref、save_bytes、save_base64、save_url、save_ref、resolve、
 *       delete、placeholder。（delete 是 JS 保留字，经 `export { delete_ as
 *       delete }` 别名导出，函数名经 defineProperty 保持 "delete"。）
 *   §2  每一个真值门都走 pyTruth / python 的 `or` 惯用法：`if not blob or
 *       len(blob) > MAX_IMAGE_BYTES` 里 bytes/Buffer 按长度判真值；`not payload`
 *       只对 "" 为假；`(mime or "")` 对 None/0/[]/{} 落到 ""，对 123/True 等
 *       真值非 str 保持原值然后在 `.strip()` 上炸 AttributeError（怪癖 §7/§9）。
 *   §2  异常身份：TypeErrorP / ValueErrorP / AttributeErrorP / BinasciiErrorP
 *       携带 python 的类名与逐字文案，探针按 [type, str(exc)] 比对。except 的
 *       收窄保持收窄：save_bytes 只吞 OSError 族，save_base64 只吞
 *       (binascii.Error, ValueError, TypeError)，save_url 只吞 (TimeoutError,
 *       aiohttp.ClientError, OSError)，其余原样上抛（怪癖 §14/§18）。
 *   §2  `asyncio.to_thread(fn, *args, **kw)` 建模为 to_thread 缝（默认同步直调、
 *       返回值 await）；`import aiohttp`（函数内 import）建模为 import_aiohttp
 *       缝；文件系统全部走 mkdir/writeBytes/unlink/resolve/glob/isFile 六缝 ——
 *       本模块在任何配置下都不直接触碰缝以外的真实世界。
 *   §2  pathlib 的字符串形状（str(Path(...)) / .suffix / .parent / Path ==）
 *       按本仓 ecosystem_skill_scanner 的自研先例在端口内重写：winPathParse
 *       统一分隔符、保留 ".."、丢弃空段与 "." 段；Windows 上 Path 相等是
 *       大小写不敏感 + 分隔符归一的（怪癖 §5）。
 *
 * QUIRKS PINNED BY THE PARITY PROBE
 *   §1  base64.b64decode(payload, validate=True) 走的是 CPython 3.13 的
 *       binascii.a2b_base64(strict_mode=True)，错误形态有六种，逐字文案由探针
 *       的 230 格决策网格钉死（对照机器上真实解释器逐格验证）：
 *         "Incorrect padding"                —— 尾段 2/3 字符且补齐不足
 *         "Invalid base64-encoded string: number of data characters (N) cannot
 *          be 1 more than a multiple of 4"   —— N = 已产出字节数//3*4+1
 *         "Only base64 data is allowed"      —— 严格模式遇非字母表字符
 *         "Leading padding not allowed"      —— 首字符即 '='
 *         "Excess padding not allowed"       —— 补号落在规范位置之外
 *         "Excess data after padding"        —— 补齐完成后又来数据字符
 *         "Discontinuous padding not allowed" —— 补齐未完成就来数据字符
 *       另：str 入参含非 ASCII → ValueError("string argument should contain
 *       only ASCII characters")；非 bytes/str 入参 → TypeError("argument
 *       should be a bytes-like object or ASCII string, not '<类名>'")。
 *       注意 3.13 连 validate=False 也拒绝"无补号"的 2/3 字符尾段
 *       （b64decode("aGVsbG8") 与 ("YQ") 在本机解释器上双双报 Incorrect
 *       padding —— 旧版 python 接受，这里以探针实测为准）。
 *   §2  源文件注释点名的坑照抄：validate 必须以关键字传递 —— b64decode 的第
 *       二个位置参数是 altchars，位置传 True 会静默变成"altchars=True"在
 *       base64 内部炸。端口把 validate 放进 to_thread 缝的关键字包，物理上
 *       不可能塌进位置槽；探针账本把 ["validate", true] 钉在每次调用上。
 *   §3  _SAFE_ID 的 `$` 允许在"结尾换行符之前"匹配：64 个合法字符 + 一个
 *       "\n" 能过正则（随后进入 glob），而 64 字符 + 两个 "\n" 不能；"a"*65
 *       不能。JS 的 `$`（无 m 标志）没有"尾换行前匹配"规则，端口用
 *       /^[A-Za-z0-9_-]{8,64}\n?$/ 精确复刻（等价性：类内前缀长 8..64 且
 *       其后至多一个作为末字符的 \n）。bytes id 是另一条臂：str 模式配
 *       bytes 实参 → TypeError("cannot use a string pattern on a bytes-like
 *       object")。
 *   §4  glob 的模式串由原始 id 拼接：f"{image_id}.*"。假 fs 上匹配与返回由
 *       探针剧本两侧同源驱动；默认缝按 Windows pathlib 的大小写不敏感 fnmatch
 *       实现，目录不存在时吞 OSError 返回空（python Path.glob 的行为）。
 *   §5  `real_p.parent == real_target` 在 Windows 上是大小写不敏感、分隔符归一
 *       的 Path 相等：resolve 缝返回 "D:\\WS\\.OVOLVE\\images" 下的文件依然
 *       判等放行。
 *   §6  suffix 规则 = 取最后一段、rfind(".")、0 < i < len-1 才有：".bashrc"→"",
 *       "x."→"", ".."→"", "x..."→"", "a.tar.gz"→".gz", "x..png"→".png"；再经
 *       lstrip(".") 与 .lower() 进表。_make_ref 的 ext 不 lower（落盘路径的
 *       ext 已由 _ext_for_mime 定死为小写）。
 *   §7  `_ext_for_mime` 的 `(mime or "").strip().lower()`：bytes 入参走
 *       bytes.strip/lower 后按 bytes 键查表 —— 表键全是 str，必 miss → "bin"；
 *       真值非 str 非 bytes（123/True/3.5）在 .strip 上 AttributeError
 *       ("'int' object has no attribute 'strip'" 等)。
 *   §8  save_bytes 的 `if not blob or len(blob) > MAX_IMAGE_BYTES`：b""/None/
 *       0/[]/"" 都直接 None（账本全空）；blob=5/True 走到 len() 抛
 *       TypeError("object of type 'int' has no len()")；blob="abc"（str）能过
 *       门（len("abc")==3），炸在 write_bytes 的
 *       "a bytes-like object is required, not 'str'" —— 且 mkdir 已经记完账
 *       （先 mkdir 后 write 的顺序由探针账本钉死）。
 *   §9  save_bytes 的 `_make_ref(..., mime.strip().lower(), ...)` 没有
 *       `or ""` 兜底：mime=None 时 ext 查表得 "bin"、文件照写，然后才在
 *       None.strip() 上 AttributeError —— 失败发生在写盘成功之后。
 *   §10 _make_ref 的引用形状与键序 {"id","mime","bytes","ext","name","path",
 *       "url"} 逐字钉住；name 为空/None 时回落 f"image{suffix}"，然后对 name
 *       做 [:120] —— 这是 python 的切片下标：str 按码位截断；list 切前 120 个
 *       元素（引用里躺着个 list！）；bytes 按字节切；int/bool/float 上炸
 *       "'int' object is not subscriptable"；dict 上炸 "unhashable type:
 *       'slice'"。
 *   §11 save_url 的 `url.startswith(("http://", "https://"))` 是大小写敏感的
 *       元组前缀匹配："HTTP://a.b" 直接 None；bytes url 报
 *       TypeError("a bytes-like object is required, not 'str'")；真值非 str
 *       报 AttributeError("'int' object has no attribute 'startswith'")。
 *   §12 `resp.status != 200`：status="200"/True/None 全都 ≠ 200 → None；
 *       status=200.0 与 200 相等 → 继续走。Content-Type 缺失按猜扩展名臂走。
 *   §13 Content-Type 通道：`(ct or "").split(";")[0].strip().lower()` —— bytes
 *       ct 在 split 上报 TypeError("a bytes-like object is required, not
 *       'str'")，真值非 str 报 AttributeError 'X' object has no attribute
 *       'split'；空/缺失 → 从 URL 尾猜：url.rsplit(".",1)[-1].split("?")[0]
 *       .lower() —— 没有扩展名时主机名里的点会漏进候选（"http://a.b/x" →
 *       "b/x"），查表 miss 后回落 "image/png"。
 *   §14 except (asyncio.TimeoutError, aiohttp.ClientError, OSError) 按身份收窄：
 *       aiohttp.ClientError 用 instanceof 判（名字相同但不同类的实例照样上
 *       抛），TimeoutError/OSError 按异常名判；RuntimeError/ValueError/
 *       TypeError 一律穿透（探针各钉一枚）。
 *   §15 placeholder 的 `(ref or {}).get("name") or "image"`：falsy ref（None/
 *       ""/0/[]/{}）→ "image"；真值非 dict（123/"s"/[1]/True）→
 *       AttributeError("'int' object has no attribute 'get'" 等)；命中值再过
 *       `or "image"`（""/0/False/None → "image"），f-string 用 str() 插值
 *       （list/dict/bytes/bool 按各自 repr/str 形态进占位符）；placeholder 不
 *       做 [:120] 截断（截断只发生在 _make_ref）。
 *   §16 save_ref 的 isinstance(item, dict) 只认字典：None/123/"s"/[1] → None，
 *       不炸不落盘。
 *   §17 _strip_data_url 的 partition(",") 取第一个逗号；mime = head[5:]
 *       .split(";")[0] or None（"data:"/"data:," 的 mime 是 None）；raw 真值
 *       非 str 在 .strip 上 AttributeError；raw falsy（None/0/""）→ ("", None)。
 *   §18 resolve()/delete()/save_bytes() 只吞 OSError 族（OSError/
 *       PermissionError/FileNotFoundError…，探针按异常名注入），其余异常原样
 *       上抛；resolve 的 glob 循环里 is_file 抛 OSError 也落进同一个 try →
 *       None。
 *
 * MIGRATION DECISIONS / DIVERGENCES (documented dispositions)
 *   DIVERGENCE(port, asyncio.to_thread 缝): python 把写盘/b64decode/unlink 挤
 *       出事件循环；TS 无线程池必要（Node 本身非阻塞），to_thread 缝默认同步
 *       直调并 await 返回值。调用次序、实参形状（含 validate 关键字包）由
 *       探针账本逐条比对，调度差异不可观察。
 *   DIVERGENCE(port, aiohttp 缝): python 在函数内 `import aiohttp`，装没装决
 *       定 save_url 能不能下载；端口把 import 建模为 import_aiohttp 缝，默认
 *       未接线 → ModuleNotFoundError("No module named 'aiohttp'") → 被除
 *       ImportError 同位的 catch 收下 → None，与"未安装 aiohttp 的 python"
 *       完全一致。生产接线由宿主注入 HTTP 客户端；探针两侧各钉"缺"与"假件"
 *       两臂。
 *   DIVERGENCE(port, fs 六缝): mkdir/writeBytes/unlink/resolve/glob/isFile 默认
 *       绑 node:fs（resolve 用 realpath 失败回落 win32.resolve，对应
 *       Path.resolve(strict=False) 的形状；glob 目录缺失吞成 []）。pathlib 的
 *       字符串面（suffix/parent/join/相等）按 es 单元先例自研，路径在本端口内
 *       以字符串表示。
 *   DIVERGENCE(port, OSError 家族): python 的 except OSError 按类层级收窄；
 *       端口按异常名集合（OSError/PermissionError/FileNotFoundError/
 *       FileExistsError/NotADirectoryError/IsADirectoryError）加 node fs 的
 *       E-码错误判定。探针以带名的假异常逐臂钉住，名字集合之外的异常照 python
 *       上抛。
 *   DIVERGENCE(port, 关键字实参): python 全部形参都是 positional-or-keyword，
 *       端口按位置接收；调用方 router_modules/dispatch.py:1718 的
 *       `name_hint=...` 关键字拼法在 TS 侧即第 3 个位置实参，可观察行为
 *       （实参值、默认值、arity 错误文案）不变。
 *   DIVERGENCE(port, number repr): JS 单一 number 类型，整值浮点按仓内惯例以
 *       int 样式渲染；本模块没有整值浮点进入可观察位置（status=200.0 的场景
 *       只影响分支走向），故不可观察。
 *   DIVERGENCE(port, uuid): _new_id 走 uuid4hex 缝，默认
 *       randomUUID().replace(/-/g,"") —— 32 位 hex，形态与 uuid.uuid4().hex
 *       一致；具体值由宿主/探针注入。
 *
 *   本文件无待移植项。
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";
import { randomUUID } from "node:crypto";

// ── python-semantics helpers (house style: file-local) ───────────────────────

class TypeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "TypeError"; }
}
class ValueErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "ValueError"; }
}
class AttributeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "AttributeError"; }
}
class BinasciiErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "binascii.Error"; }
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return "bytes";
    if (v instanceof Set) return "set";
    if (v instanceof Map) return "dict";
    if (typeof v === "function") return "function";
    if (typeof v === "object") {
        const ctor = (v as { constructor?: { name?: string } }).constructor;
        return ctor && ctor.name && ctor.name !== "Object" ? ctor.name : "dict";
    }
    return typeof v;
}

/** house predicate (same shape as memory_layer's): a value that IS a python
 *  dict — a plain or prototype-less object, not a class instance. */
function isPyDict(v: unknown): boolean {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    if (Buffer.isBuffer(v) || v instanceof Error) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (typeof v === "function") return true;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map || v instanceof Set) return v.size > 0;
    // A class instance is a python OBJECT: bool() is True whatever its own
    // fields are (nothing in this domain defines __bool__/__len__), so the
    // empty-container rule applies only to dict-shaped values.
    if (isPyDict(v)) return Object.keys(v as Record<string, unknown>).length > 0;
    if (typeof v === "object") return true;
    return true;
}

function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

/** python float repr for `str()`: integral values render int-style. */
function pyNumStr(v: number): string {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return String(v);
}

/** CPython bytes repr: printable ASCII (0x20-0x7E) verbatim, `\t \n \r \\` and
 *  the chosen quote escaped, every other byte `\xNN` (lowercase hex). Quote
 *  choice matches the str rule: `'` unless the bytes contain `'` and no `"`. */
function pyBytesRepr(v: Uint8Array): string {
    let hasSquote = false;
    let hasDquote = false;
    for (let i = 0; i < v.length; i++) {
        if (v[i] === 0x27) hasSquote = true;
        else if (v[i] === 0x22) hasDquote = true;
    }
    const quote = hasSquote && !hasDquote ? 0x22 : 0x27;
    let out = "b" + String.fromCharCode(quote);
    for (let i = 0; i < v.length; i++) {
        const c = v[i] as number;
        if (c === quote || c === 0x5c) out += "\\" + String.fromCharCode(c);
        else if (c === 0x09) out += "\\t";
        else if (c === 0x0a) out += "\\n";
        else if (c === 0x0d) out += "\\r";
        else if (c < 0x20 || c >= 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
        else out += String.fromCharCode(c);
    }
    return out + String.fromCharCode(quote);
}

/** python `repr(x)` for the string leaf. */
function pyRepr(v: unknown): string {
    if (typeof v === "string") {
        const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
        const esc = v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")
            .replaceAll("\r", "\\r").replaceAll("\t", "\\t");
        if (quote === "'") return "'" + esc.replaceAll("'", "\\'") + "'";
        return '"' + esc.replaceAll('"', '\\"') + '"';
    }
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return pyBytesRepr(v);
    return pyStr(v);
}

/** python `str(x)` (containers render through repr). */
function pyStr(v: unknown): string {
    if (typeof v === "string") return v;
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNumStr(v);
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return pyBytesRepr(v);
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    if (v instanceof Set) return "{" + Array.from(v).map(pyRepr).join(", ") + "}";
    if (v instanceof Map) {
        return "{" + Array.from(v.entries()).map(([k, x]) => pyRepr(k) + ": " + pyRepr(x)).join(", ") + "}";
    }
    if (typeof v === "object") {
        const o = v as Record<string, unknown>;
        return "{" + Object.keys(o).map((k) => pyRepr(k) + ": " + pyRepr(o[k])).join(", ") + "}";
    }
    return String(v);
}

/** python `str.strip()` with no args: strips isspace() chars. */
function pyStrip(s: string): string {
    return s.replace(/^[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/, "")
        .replace(/[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/, "");
}

/** python `bytes.strip()`: ASCII whitespace only (b" \t\n\r\x0b\f"). */
const BYTES_SPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);

function pyBytesStrip(b: Uint8Array): Uint8Array {
    let lo = 0;
    let hi = b.length;
    while (lo < hi && BYTES_SPACE.has(b[lo] as number)) lo++;
    while (hi > lo && BYTES_SPACE.has(b[hi - 1] as number)) hi--;
    return b.subarray(lo, hi);
}

/** python `bytes.lower()`: ASCII A-Z only. */
function pyBytesLower(b: Uint8Array): Uint8Array {
    const out = Buffer.from(b);
    for (let i = 0; i < out.length; i++) {
        const c = out[i] as number;
        if (c >= 0x41 && c <= 0x5a) out[i] = c + 0x20;
    }
    return out;
}

/** python `x.strip().lower()` on the str channel, the bytes channel, or the
 *  AttributeError arm (non-str truthy receiver). */
function pyStripLower(v: unknown): string | Buffer {
    if (typeof v === "string") return pyStrip(v).toLowerCase();
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
        return Buffer.from(pyBytesLower(pyBytesStrip(v)));
    }
    throw new AttributeErrorP(`'${pyTypeName(v)}' object has no attribute 'strip'`);
}

/** python len() — bytes by byte, str by code point. */
function pyLen(v: unknown): number {
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return v.length;
    if (typeof v === "string") return Array.from(v).length;
    if (Array.isArray(v)) return v.length;
    if (v instanceof Map || v instanceof Set) return v.size;
    throw new TypeErrorP(`object of type '${pyTypeName(v)}' has no len()`);
}

/** python `s.split(sep, maxsplit)` with maxsplit ≥ 0 (sep is 1+ chars). */
function pySplitMax(s: string, sep: string, maxsplit: number): string[] {
    const out: string[] = [];
    let i = 0;
    let cuts = 0;
    for (;;) {
        const at = s.indexOf(sep, i);
        if (at < 0 || cuts >= maxsplit) {
            out.push(s.slice(i));
            break;
        }
        out.push(s.slice(i, at));
        i = at + sep.length;
        cuts++;
    }
    return out;
}

/** python `s.rsplit(sep, maxsplit)` (sep is 1+ chars). */
function pyRSplitMax(s: string, sep: string, maxsplit: number): string[] {
    if (maxsplit <= 0) return pySplitMax(s, sep, 0);
    const out: string[] = [];
    let end = s.length;
    let cuts = 0;
    for (;;) {
        const at = s.lastIndexOf(sep, end - 1);
        if (at < 0 || cuts >= maxsplit) {
            out.unshift(s.slice(0, end));
            break;
        }
        out.unshift(s.slice(at + sep.length, end));
        end = at;
        cuts++;
    }
    return out;
}

/** python `s.partition(sep)` → [before, sep, after] (sep "" when absent). */
function pyPartition(s: string, sep: string): [string, string, string] {
    const i = s.indexOf(sep);
    return i < 0 ? [s, "", ""] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

/** python's "missing N required positional argument(s)" TypeError text:
 *  `'a'`, `'a' and 'b'`, `'a', 'b', and 'c'` — CPython's own join. */
function pyMissing(fname: string, names: readonly string[]): TypeErrorP {
    const q = names.map((s) => `'${s}'`);
    const list = q.length === 1
        ? (q[0] as string)
        : q.length === 2
            ? `${q[0]} and ${q[1]}`
            : q.slice(0, -1).join(", ") + ", and " + q[q.length - 1];
    const plural = names.length === 1 ? "positional argument" : "positional arguments";
    return new TypeErrorP(`${fname}() missing ${names.length} required ${plural}: ${list}`);
}

/** python's "takes <takes> positional argument(s) but N was/were given". */
function pyTooMany(fname: string, takes: string, given: number): TypeErrorP {
    const noun = takes === "1" ? "positional argument" : "positional arguments";
    const verb = given === 1 ? "was" : "were";
    return new TypeErrorP(`${fname}() takes ${takes} ${noun} but ${given} ${verb} given`);
}

/** Same, for signatures where some parameters have defaults: CPython 3.13
 *  reports the interval — "takes from MIN to MAX positional arguments". */
function pyTooManyRange(fname: string, min: number, max: number, given: number): TypeErrorP {
    const noun = max === 1 ? "positional argument" : "positional arguments";
    const verb = given === 1 ? "was" : "were";
    return new TypeErrorP(`${fname}() takes from ${min} to ${max} ${noun} but ${given} ${verb} given`);
}

function hasOwn(o: Record<string, unknown>, k: string): boolean {
    return Object.prototype.hasOwnProperty.call(o, k);
}

// ── pathlib surface (string-shaped; es-unit precedent) ───────────────────────

type WinPathParse = { anchor: string; root: string; names: string[] };

/** PureWindowsPath's decomposition: optional drive/UNC anchor, optional root
 *  separator, name components. Separators unified, empty and "." components
 *  dropped, ".." KEPT (pathlib never folds it). */
function winPathParse(raw: string): WinPathParse {
    const s = raw.replace(/\//g, "\\");
    let anchor = "";
    let root = "";
    let rest = s;
    if (s.startsWith("\\\\")) {
        const unc = /^\\\\[^\\]+\\[^\\]+/.exec(s);
        if (unc) {
            anchor = unc[0];
            rest = s.slice(anchor.length);
            root = "\\";
            if (rest.startsWith("\\")) rest = rest.slice(1);
        } else {
            rest = s.slice(2);
            const comps = rest.split("\\").filter((c) => c.length > 0 && c !== ".");
            return { anchor: "\\\\", root: "", names: comps };
        }
    } else {
        const drive = /^([A-Za-z]:)/.exec(s);
        if (drive) {
            anchor = drive[1] as string;
            rest = s.slice(anchor.length);
        } else if (s.startsWith("\\")) {
            root = "\\";
            rest = s.slice(1);
        }
    }
    if (rest.startsWith("\\")) {
        root = "\\";
        rest = rest.slice(1);
    }
    const names = rest.split("\\").filter((c) => c.length > 0 && c !== ".");
    return { anchor, root, names };
}

function winPathStr(p: WinPathParse): string {
    if (p.root !== "") return p.anchor + p.root + p.names.join("\\");
    if (p.anchor !== "") {
        // No root: the anchor stays glued to the first name ("C:rel/x").
        if (p.names.length === 0) return p.anchor;
        return p.anchor + p.names.join("\\");
    }
    const out = p.names.join("\\");
    return out === "" ? "." : out;
}

/** str(Path(x)) on Windows, with python's Path() TypeError text. */
function pyPathStr(raw: unknown): string {
    if (typeof raw !== "string" && !(raw instanceof String)) {
        if (typeof raw === "object" && raw !== null && "pyPath" in (raw as Record<string, unknown>)) {
            raw = String((raw as Record<string, unknown>).pyPath);
        } else {
            throw new TypeErrorP(
                `argument should be a str or an os.PathLike object where __fspath__ returns a str, not '${pyTypeName(raw)}'`);
        }
    }
    return winPathStr(winPathParse(String(raw)));
}

/** PurePath.name — "" when nothing is left after anchor and root. */
function pyPathName(p: string): string {
    const q = winPathParse(p);
    return q.names.length > 0 ? (q.names[q.names.length - 1] as string) : "";
}

/** PurePath.parent — drop the last name, or stay put on an anchor-only path. */
export function pyPathParent(p: string): string {
    const q = winPathParse(p);
    if (q.names.length === 0) return winPathStr(q);
    return winPathStr({ anchor: q.anchor, root: q.root, names: q.names.slice(0, q.names.length - 1) });
}

/** PurePath.suffix — rfind(".") with 0 < i < len(name)-1, else "". */
function pyPathSuffix(p: string): string {
    const name = pyPathName(p);
    const i = name.lastIndexOf(".");
    return i > 0 && i < name.length - 1 ? name.slice(i) : "";
}

/** Path(base) / seg1 / seg2 … — an absolute segment replaces the base. */
export function pyPathJoin(base: string, ...segs: string[]): string {
    let acc = winPathParse(pyPathStr(base));
    for (const seg of segs) {
        const q = winPathParse(pyPathStr(seg));
        if (q.anchor !== "" || q.root !== "") {
            acc = q;
        } else {
            acc = { anchor: acc.anchor, root: acc.root, names: [...acc.names, ...q.names] };
        }
    }
    return winPathStr(acc);
}

/** Windows Path.__eq__/__hash__ fold: separators unified, case-folded (quirk §5). */
function pyPathEq(a: string, b: string): boolean {
    return a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
}

/** python str-slice [:n] by code points. */
function pySliceTo(s: string, n: number): string {
    return Array.from(s).slice(0, n).join("");
}

// ── 常量（与 python 逐字对齐） ───────────────────────────────────────────────

/** MIME → 扩展名。未知类型当 bin 存，不猜；load 走 glob 匹配任意扩展名。 */
export const _EXT_BY_MIME: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
};

export const _MIME_BY_EXT: Record<string, string> = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "gif": "image/gif",
    "bmp": "image/bmp",
    "svg": "image/svg+xml",
};

/** 单张图片上限 32MB —— 超过基本不是正常生成结果，拒绝落盘避免磁盘被打满。 */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** 远程 URL 下载超时（秒）。生成器图片通常 <200KB，几秒足够。 */
export const DOWNLOAD_TIMEOUT = 15;

/** 只接受这个字符集的 id，防止 ``../..`` 之类的路径穿越。pattern 字符串与
 *  python 的 _SAFE_ID.pattern 逐字一致；实际匹配函数见 safeIdMatch —— python
 *  的 `$` 允许尾换行前匹配，JS 正则没有该规则，须显式补 \n?（怪癖 §3）。 */
export const _SAFE_ID = { pattern: "^[A-Za-z0-9_-]{8,64}$" } as const;

const SAFE_ID_RE = /^[A-Za-z0-9_-]{8,64}\n?$/;

/** str 正则 match 的同位：bytes 实参与其余非 str 实参在 python 是两种
 *  TypeError 文案（怪癖 §3）。 */
function safeIdMatch(s: unknown): boolean {
    if (typeof s === "string") return SAFE_ID_RE.test(s);
    if (Buffer.isBuffer(s) || s instanceof Uint8Array) {
        throw new TypeErrorP("cannot use a string pattern on a bytes-like object");
    }
    throw new TypeErrorP(`expected string or bytes-like object, got '${pyTypeName(s)}'`);
}

export const SUBDIR = ".ovolve\\images";

// ── 测试缝（本仓 *_SEAMS 标准做法） ──────────────────────────────────────────

export type AiohttpModule = {
    ClientTimeout: (kw: { total: unknown }) => unknown;
    ClientSession: new (kw: { timeout?: unknown }) => {
        __aenter__: () => Promise<unknown>;
        __aexit__: (t: unknown, v: unknown, tb: unknown) => Promise<unknown>;
        get: (url: unknown) => {
            __aenter__: () => Promise<unknown>;
            __aexit__: (t: unknown, v: unknown, tb: unknown) => Promise<unknown>;
        };
    };
    ClientError: new (...a: never[]) => Error;
};

/** python `except OSError` 的名字集合（含常用子类）；node fs 的 E-码错误也算。 */
const OS_ERROR_NAMES = new Set([
    "OSError", "PermissionError", "FileNotFoundError", "FileExistsError",
    "NotADirectoryError", "IsADirectoryError", "InterruptedError",
]);

function isOSError(e: unknown): boolean {
    if (!(e instanceof Error)) return false;
    if (OS_ERROR_NAMES.has(e.name)) return true;
    const code = (e as { code?: unknown }).code;
    return typeof code === "string" && /^E[A-Z]/.test(code);
}

/** asyncio.to_thread 的形状：fn、位置实参数组、关键字包（保持 validate 的
 *  关键字身份 —— 怪癖 §2）。`any` = 被缝转发的 python 可调用（fn.name 进
 *  探针账本），实参形状由各调用点决定（_write_blob/b64decode/unlink）。 */
export type ToThreadFn = (fn: (...a: any[]) => unknown, args: unknown[],
    kw?: Record<string, unknown>) => Promise<unknown>;

export const IMAGE_STORE_SEAMS = {
    /** python `Path.parent.mkdir(parents=True, exist_ok=True)`。 */
    mkdir: (p: string, _opts: { parents: boolean; exist_ok: boolean }): void => {
        fs.mkdirSync(p, { recursive: true });
    },
    /** python `Path.write_bytes(blob)`。 */
    writeBytes: (p: string, blob: Uint8Array): void => {
        fs.writeFileSync(p, blob);
    },
    /** python `Path.unlink()`。 */
    unlink: (p: string): void => {
        fs.unlinkSync(p);
    },
    /** python `Path.resolve()`（strict=False：解析失败回落 abspath）。 */
    resolve: (p: string): string => {
        try {
            return fs.realpathSync(p);
        } catch {
            return nodePath.win32.resolve(p);
        }
    },
    /** python `Path.glob(f"{image_id}.*")`：目录缺失吞 OSError 返回空；
     *  Windows pathlib 的大小写不敏感匹配。 */
    glob: (dir: string, pattern: string): string[] => {
        let names: string[];
        try {
            names = fs.readdirSync(dir);
        } catch {
            return [];
        }
        const re = globToRegExp(pattern);
        const out: string[] = [];
        for (const name of names) {
            if (re.test(name)) out.push(pyPathJoin(dir, name));
        }
        return out;
    },
    /** python `Path.is_file()`：stat 失败按 False。 */
    isFile: (p: string): boolean => {
        try {
            return fs.statSync(p).isFile();
        } catch {
            return false;
        }
    },
    /** python `base64.b64decode(s, validate=...)` —— 自研严格解码器（怪癖 §1）。 */
    b64decode: (s: unknown, kw?: { validate?: unknown }): Buffer =>
        b64decodeImpl(s, pyTruth(kw?.validate)),
    /** python `uuid.uuid4().hex`。 */
    uuid4hex: (): string => randomUUID().replace(/-/g, ""),
    /** python `asyncio.to_thread(fn, *args, **kw)` —— 默认同步直调（DIVERGENCE
     *  port, to_thread 缝）；关键字包作为下一个位置实参整体转发（JS 侧的关键字
     *  拼法即 options bag）—— 绝不把包拆散成位置实参，否则 b64decode 的
     *  validate 会塌进 altchars 槽（源文件注释点名的坑，怪癖 §2）。 */
    to_thread: (async (fn: (...a: any[]) => unknown, args: unknown[],
        kw?: Record<string, unknown>): Promise<unknown> => {
        const bag = kw !== undefined && kw !== null && Object.keys(kw).length > 0 ? [kw] : [];
        return await fn(...args, ...bag);
    }) as ToThreadFn,
    /** python `import aiohttp`（函数内 import）—— 默认未接线即"模块不存在"。 */
    import_aiohttp: (): AiohttpModule => {
        throw new Error("ModuleNotFoundError: No module named 'aiohttp'");
    },
};

/** 简版 fnmatch（`*` `?` 通配，其余字面），Windows 大小写不敏感；本端口的
 *  glob 模式恒为 `{id}.*`，id 已过 _SAFE_ID 白名单。 */
function globToRegExp(pattern: string): RegExp {
    let src = "";
    for (const ch of pattern) {
        if (ch === "*") src += "[^\\\\/]*";
        else if (ch === "?") src += "[^\\\\/]";
        else src += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp("^" + src + "$", "i");
}

// ── 严格 base64 解码器（CPython 3.13 binascii.a2b_base64 同构，怪癖 §1） ─────

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_TABLE = new Int16Array(256).fill(-1);
for (let i = 0; i < B64_ALPHABET.length; i++) {
    B64_TABLE[B64_ALPHABET.charCodeAt(i)] = i;
}

/** python `_bytes_from_decode_data`：str 走 ascii 编码（非 ASCII →
 *  ValueError），bytes 原样，其余 TypeError 带类名。 */
function bytesFromDecodeData(s: unknown): Uint8Array {
    if (typeof s === "string") {
        if (!/^[\x00-\x7f]*$/.test(s)) {
            throw new ValueErrorP("string argument should contain only ASCII characters");
        }
        return Buffer.from(s, "latin1");
    }
    if (Buffer.isBuffer(s) || s instanceof Uint8Array) return s;
    throw new TypeErrorP(
        `argument should be a bytes-like object or ASCII string, not '${pyTypeName(s)}'`);
}

/** binascii.a2b_base64 的决策网格实现（严格/宽松两模式；六种 strict 错误文案
 *  与"补齐不足"的 Incorrect padding 均逐字对齐，怪癖 §1）。 */
function b64decodeImpl(s: unknown, validate: boolean): Buffer {
    const data = bytesFromDecodeData(s);
    const strict = validate;
    let pads = 0;
    let qp = 0;
    let leftchar = 0;
    const out = Buffer.alloc(Math.ceil(data.length / 4) * 3);
    let n = 0;
    for (let i = 0; i < data.length; i++) {
        const ch = data[i] as number;
        if (ch === 0x3d /* '=' */) {
            pads++;
            if (qp >= 2 && qp + pads <= 4) continue;
            if (!strict) continue;
            if (qp === 1) break;                      // → 末尾 cannot-be-1-more
            throw new BinasciiErrorP(qp === 0 && i === 0
                ? "Leading padding not allowed"
                : "Excess padding not allowed");
        }
        const v = B64_TABLE[ch] as number;
        if (v < 0) {
            if (strict) throw new BinasciiErrorP("Only base64 data is allowed");
            continue;
        }
        if (pads !== 0 && strict) {
            throw new BinasciiErrorP(qp + pads === 4
                ? "Excess data after padding"
                : "Discontinuous padding not allowed");
        }
        pads = 0;
        if (qp === 0) {
            qp = 1;
            leftchar = v;
        } else if (qp === 1) {
            qp = 2;
            out[n++] = (leftchar << 2) | (v >> 4);
            leftchar = v & 0x0f;
        } else if (qp === 2) {
            qp = 3;
            out[n++] = (leftchar << 4) | (v >> 2);
            leftchar = v & 0x03;
        } else {
            qp = 0;
            out[n++] = (leftchar << 6) | v;
            leftchar = 0;
        }
    }
    if (qp === 1) {
        throw new BinasciiErrorP(
            "Invalid base64-encoded string: number of data characters (" +
            (Math.floor(n / 3) * 4 + 1) + ") cannot be 1 more than a multiple of 4");
    }
    if (qp !== 0 && qp + pads < 4) {
        throw new BinasciiErrorP("Incorrect padding");
    }
    return out.subarray(0, n);
}

// ── 模块函数 ─────────────────────────────────────────────────────────────────

/** `<workspace>/.ovolve/images` —— 存工作区而不是用户目录：AI 生成的图片通常
 *  跟当前项目相关，跟着项目走也方便用户在文件管理器里找到。 */
export function _dir_for(workspace: unknown): string {
    if (arguments.length === 0) throw pyMissing("_dir_for", ["workspace"]);
    if (arguments.length > 1) throw pyTooMany("_dir_for", "1", arguments.length);
    return pyPathJoin(pyPathStr(workspace), SUBDIR);
}

export function _ext_for_mime(mime: unknown): string {
    if (arguments.length === 0) throw pyMissing("_ext_for_mime", ["mime"]);
    if (arguments.length > 1) throw pyTooMany("_ext_for_mime", "1", arguments.length);
    const m = pyOr(mime, "");
    if (typeof m !== "string") {
        // bytes 通道：strip/lower 后按 bytes 键查表必 miss → "bin"（怪癖 §7）；
        // 真值非 str 非 bytes 在 .strip 上炸 AttributeError。
        if (Buffer.isBuffer(m) || m instanceof Uint8Array) return "bin";
        if (pyTruth(m)) throw new AttributeErrorP(`'${pyTypeName(m)}' object has no attribute 'strip'`);
        return "bin";                                  // falsy → ("") → miss
    }
    const key = pyStrip(m).toLowerCase();
    return hasOwn(_EXT_BY_MIME, key) ? (_EXT_BY_MIME[key] as string) : "bin";
}

/** 从文件名后缀反查 MIME，用于 HTTP 响应的 Content-Type。 */
export function mime_for_path(path: unknown): string {
    if (arguments.length === 0) throw pyMissing("mime_for_path", ["path"]);
    if (arguments.length > 1) throw pyTooMany("mime_for_path", "1", arguments.length);
    const ext = pyPathSuffix(pyPathStr(path)).replace(/^\.+/, "").toLowerCase();
    return hasOwn(_MIME_BY_EXT, ext) ? (_MIME_BY_EXT[ext] as string) : "application/octet-stream";
}

/** ``data:image/png;base64,XXXX`` → ``("XXXX", "image/png")``。 */
export function _strip_data_url(raw: unknown): [string, string | null] {
    if (arguments.length === 0) throw pyMissing("_strip_data_url", ["raw"]);
    if (arguments.length > 1) throw pyTooMany("_strip_data_url", "1", arguments.length);
    if (!pyTruth(raw)) return ["", null];
    if (typeof raw !== "string") {
        throw new AttributeErrorP(`'${pyTypeName(raw)}' object has no attribute 'strip'`);
    }
    const s = pyStrip(raw);
    if (!s.startsWith("data:")) return [s, null];
    const parts = pyPartition(s, ",");
    const mime = (pySplitMax(parts[0].slice(5), ";", 1)[0] ?? "") || null;
    return [parts[2] ?? "", mime];
}

/** 32 位 uuid hex。id 不可变、内容不可变，配合 Cache-Control immutable 可放心
 *  长缓存。 */
export function _new_id(): string {
    if (arguments.length > 0) throw pyTooMany("_new_id", "0", arguments.length);
    return IMAGE_STORE_SEAMS.uuid4hex();
}

/** 真正的写盘操作，python 侧跑在线程池里（to_thread 缝的 fn 实参）。 */
export function _write_blob(path: string, blob: Uint8Array): void {
    IMAGE_STORE_SEAMS.mkdir(pyPathParent(path), { parents: true, exist_ok: true });
    IMAGE_STORE_SEAMS.writeBytes(path, blob);
}

/** python `x[:120]` 的切片下标同位（怪癖 §10）：str 按码位、bytes 按字节、
 *  list 按元素；dict 是 "unhashable type: 'slice'"，其余标量
 *  "'int' object is not subscriptable"。 */
function pySlice120(v: unknown): unknown {
    if (typeof v === "string") return pySliceTo(v, 120);
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return v.subarray(0, 120);
    if (Array.isArray(v)) return v.slice(0, 120);
    if (isPyDict(v)) throw new TypeErrorP("unhashable type: 'slice'");
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not subscriptable`);
}

/** 统一的引用形状 —— 不带图片数据本身。键序是探针钉住的事实（怪癖 §10）。 */
export function _make_ref(image_id: string, path: string, mime: unknown, size: number,
    name: unknown): Record<string, unknown> {
    const suffix = pyPathSuffix(path);
    return {
        "id": image_id,
        "mime": mime,
        "bytes": size,
        "ext": suffix.replace(/^\.+/, ""),
        "name": pySlice120(pyTruth(name) ? name : "image" + suffix),
        "path": path,
        "url": "/api/images/" + image_id,
    };
}

/** 把字节直接写进工作区。失败返回 None（绝不抛 OSError 以外的异常）。 */
export async function save_bytes(
    blob: unknown,
    mime?: unknown,
    workspace?: unknown,
    name_hint?: unknown,
): Promise<Record<string, unknown> | null> {
    if (arguments.length === 0) throw pyMissing("save_bytes", ["blob"]);
    if (arguments.length > 4) throw pyTooManyRange("save_bytes", 1, 4, arguments.length);
    const m = arguments.length >= 2 ? mime : "image/png";
    const ws = arguments.length >= 3 ? workspace : ".";
    const nh = arguments.length >= 4 ? name_hint : "";
    if (!pyTruth(blob) || pyLen(blob) > MAX_IMAGE_BYTES) {
        return null;
    }
    const image_id = _new_id();
    const ext = _ext_for_mime(m);
    const path = pyPathJoin(_dir_for(ws), `${image_id}.${ext}`);
    try {
        await IMAGE_STORE_SEAMS.to_thread(_write_blob, [path, blob]);
    } catch (e) {
        if (isOSError(e)) return null;
        throw e;
    }
    return _make_ref(image_id, path, pyStripLower(m), pyLen(blob), nh);
}

/** 把 base64 图片写进工作区。可接受带 ``data:`` 前缀的输入。 */
export async function save_base64(
    data: unknown,
    mime?: unknown,
    workspace?: unknown,
    name_hint?: unknown,
): Promise<Record<string, unknown> | null> {
    if (arguments.length === 0) throw pyMissing("save_base64", ["data"]);
    if (arguments.length > 4) throw pyTooManyRange("save_base64", 1, 4, arguments.length);
    const m = arguments.length >= 2 ? mime : "image/png";
    const ws = arguments.length >= 3 ? workspace : ".";
    const nh = arguments.length >= 4 ? name_hint : "";
    const payloadPair = _strip_data_url(data);
    const payload = payloadPair[0];
    const embedded_mime = payloadPair[1];
    if (!pyTruth(payload)) {
        return null;
    }
    let blob: unknown = undefined;
    try {
        // validate 必须以关键字传递（怪癖 §2）—— 这里是缝的关键字包。
        blob = await IMAGE_STORE_SEAMS.to_thread(b64decode, [payload], { validate: true });
    } catch (e) {
        const name = e instanceof Error ? e.name : "";
        if (name === "binascii.Error" || name === "ValueError" || name === "TypeError") {
            // 模型偶尔会返回被截断的 base64。丢掉这张图，不写坏文件让前端显示成碎图。
            return null;
        }
        throw e;
    }
    return await save_bytes(
        blob,
        pyOr(embedded_mime, pyOr(m, "image/png")),
        ws,
        nh,
    );
}

/** python `base64.b64decode(payload, validate=True)` 的 fn 侧（to_thread 缝
 *  记账用 fn.name === "b64decode"）。 */
function b64decode(s: unknown, kw?: { validate?: unknown }): Buffer {
    return IMAGE_STORE_SEAMS.b64decode(s, kw);
}

/** save_url 的 mime 消解：优先信任 Content-Type，其次从 URL 尾端猜（怪癖 §13）。 */
function _mime_from_response(ct: unknown, url: string): string {
    let mime: string;
    if (typeof ct === "string") {
        mime = pyStrip(pySplitMax(ct, ";", 1)[0] ?? "").toLowerCase();
    } else if (Buffer.isBuffer(ct) || ct instanceof Uint8Array) {
        throw new TypeErrorP("a bytes-like object is required, not 'str'");
    } else if (pyTruth(ct)) {
        throw new AttributeErrorP(`'${pyTypeName(ct)}' object has no attribute 'split'`);
    } else {
        mime = "";
    }
    if (!mime.startsWith("image/")) {
        const ext = pySplitMax(pyRSplitMax(url, ".", 1)[1] ?? "", "?", 1)[0] ?? "";
        const low = ext.toLowerCase();
        mime = hasOwn(_MIME_BY_EXT, low) ? (_MIME_BY_EXT[low] as string) : "image/png";
    }
    return mime;
}

/** 下载远程 URL 图片并落盘。失败返回 None —— 调用方决定是丢弃还是保留一个
 *  已知会失效的原始 URL 引用。 */
export async function save_url(
    url: unknown,
    workspace?: unknown,
    name_hint?: unknown,
): Promise<Record<string, unknown> | null> {
    if (arguments.length === 0) throw pyMissing("save_url", ["url"]);
    if (arguments.length > 3) throw pyTooManyRange("save_url", 1, 3, arguments.length);
    const ws = arguments.length >= 2 ? workspace : ".";
    const nh = arguments.length >= 3 ? name_hint : "";
    if (!pyTruth(url) || !pyStartsWithScheme(url)) {
        return null;
    }
    let aiohttp: AiohttpModule;
    try {
        aiohttp = IMAGE_STORE_SEAMS.import_aiohttp();
    } catch (e) {
        const name = e instanceof Error ? e.name : "";
        if (name === "ImportError" || name === "ModuleNotFoundError") return null;
        throw e;
    }
    const urlStr = url as string;
    let blob: unknown = undefined;
    let mime: unknown = undefined;
    type AsyncCM = {
        __aenter__: () => Promise<unknown>;
        __aexit__: (t: unknown, v: unknown, tb: unknown) => Promise<unknown>;
    };
    let session: AsyncCM | undefined;
    let cm: AsyncCM | undefined;
    let sessionEntered = false;
    let respEntered = false;
    try {
        const timeout = aiohttp.ClientTimeout({ total: DOWNLOAD_TIMEOUT });
        session = new aiohttp.ClientSession({ timeout });
        const s = await session.__aenter__() as {
            get: (url: unknown) => AsyncCM;
        };
        sessionEntered = true;
        try {
            cm = s.get(urlStr);
            const resp = await (cm as AsyncCM).__aenter__() as {
                status: unknown;
                headers: { get: (k: string) => unknown };
                read: () => Promise<unknown>;
            };
            respEntered = true;
            if (resp.status !== 200) {
                return null;                           // 怪癖 §12
            }
            mime = _mime_from_response(resp.headers.get("Content-Type"), urlStr);
            blob = await resp.read();
        } finally {
            if (respEntered) await (cm as AsyncCM).__aexit__(null, null, null);
        }
    } catch (e) {
        const name = e instanceof Error ? e.name : "";
        if (name === "TimeoutError" || isOSError(e) ||
            e instanceof (aiohttp.ClientError as new (...a: never[]) => Error)) {
            return null;
        }
        throw e;
    } finally {
        if (sessionEntered) await (session as AsyncCM).__aexit__(null, null, null);
    }
    return await save_bytes(blob, mime, ws, nh);
}

/** python `url.startswith(("http://", "https://"))`：大小写敏感的元组前缀
 *  匹配；bytes url → TypeError；真值非 str → AttributeError（怪癖 §11）。 */
function pyStartsWithScheme(url: unknown): boolean {
    if (typeof url === "string") {
        return url.startsWith("http://") || url.startsWith("https://");
    }
    if (Buffer.isBuffer(url) || url instanceof Uint8Array) {
        throw new TypeErrorP("a bytes-like object is required, not 'str'");
    }
    throw new AttributeErrorP(`'${pyTypeName(url)}' object has no attribute 'startswith'`);
}

/** 入口：接收 ``image_extract`` 吐出的引用，走 base64 或 url 分支。这一层让
 *  router 只用调一次，无需关心图片来源。 */
export async function save_ref(
    item: unknown,
    workspace: unknown,
    name_hint?: unknown,
): Promise<Record<string, unknown> | null> {
    if (arguments.length < 2) {
        throw pyMissing("save_ref", (["item", "workspace"] as const).slice(arguments.length));
    }
    if (arguments.length > 3) throw pyTooManyRange("save_ref", 2, 3, arguments.length);
    if (!isPyDict(item)) {
        return null;
    }
    const d = item as Record<string, unknown>;
    const kind = d["kind"] === undefined ? null : d["kind"];
    const mime = pyOr(d["mime"] === undefined ? null : d["mime"], "");
    const name = pyOr(d["name"] === undefined ? null : d["name"],
        name_hint === undefined ? "" : name_hint);
    if (kind === "base64") {
        return await save_base64(d["data"] === undefined ? null : d["data"],
            mime, workspace, name);
    }
    if (kind === "url") {
        return await save_url(d["url"] === undefined ? null : d["url"], workspace, name);
    }
    return null;
}

/** 按 id 找回文件路径。id 非法或文件不存在返回 None。id 走白名单正则 ——
 *  HTTP 路径参数是不可信输入，不校验就是路径穿越漏洞。resolve() 后二次确认
 *  真实路径仍在目标目录内（Windows 上是大小写不敏感的相等，怪癖 §5）。 */
export function resolve(image_id: unknown, workspace?: unknown): string | null {
    if (arguments.length === 0) throw pyMissing("resolve", ["image_id"]);
    if (arguments.length > 2) throw pyTooManyRange("resolve", 1, 2, arguments.length);
    const ws = arguments.length >= 2 ? workspace : ".";
    if (!pyTruth(image_id) || !safeIdMatch(image_id)) {
        return null;
    }
    const target_dir = _dir_for(ws);
    let real_target: string;
    try {
        real_target = IMAGE_STORE_SEAMS.resolve(target_dir);
    } catch (e) {
        if (isOSError(e)) return null;
        throw e;
    }
    try {
        const entries = IMAGE_STORE_SEAMS.glob(target_dir, `${image_id as string}.*`);
        for (const p of entries) {
            if (IMAGE_STORE_SEAMS.isFile(p)) {
                const real_p = IMAGE_STORE_SEAMS.resolve(p);
                // 确认真实路径的父目录就是我们指定的目录，防 symlink 逃逸。
                if (pyPathEq(pyPathParent(real_p), real_target)) {
                    return real_p;
                }
            }
        }
    } catch (e) {
        if (isOSError(e)) return null;
        throw e;
    }
    return null;
}

/** delete 是 JS 保留字：本体叫 delete_，经 export 别名与 defineProperty 保持
 *  python 的函数名（DIVERGENCE port, 保留字）。 */
export async function delete_(image_id: unknown, workspace?: unknown): Promise<boolean> {
    if (arguments.length === 0) throw pyMissing("delete", ["image_id"]);
    if (arguments.length > 2) throw pyTooManyRange("delete", 1, 2, arguments.length);
    const ws = arguments.length >= 2 ? workspace : ".";
    const path = resolve(image_id, ws);
    if (!path) {
        return false;
    }
    try {
        // python 侧是 `path.unlink` 绑定方法：fn 无位置实参、path 已绑定
        // （to_thread 账本记 fn.name === "unlink"、零实参）。
        const boundUnlink = function unlink(): void {
            IMAGE_STORE_SEAMS.unlink(path);
        };
        await IMAGE_STORE_SEAMS.to_thread(boundUnlink, []);
        return true;
    } catch (e) {
        if (isOSError(e)) return false;
        throw e;
    }
}
Object.defineProperty(delete_, "name", { value: "delete", configurable: true });
export { delete_ as delete };

/** 给 ``session_messages.content`` 用的短占位符。模型在后续轮次需要知道"我
 *  上一轮生成过一张图"，否则用户说"把刚那张图改成蓝色"时它一脸茫然。但这句
 *  话必须极短 —— 它会被每一轮历史重放带上。 */
export function placeholder(ref: unknown): string {
    if (arguments.length === 0) throw pyMissing("placeholder", ["ref"]);
    if (arguments.length > 1) throw pyTooMany("placeholder", "1", arguments.length);
    const d = pyOr(ref, {});
    if (!isPyDict(d)) {
        // python: (ref or {}).get("name") —— 真值非字典在此 AttributeError。
        throw new AttributeErrorP(`'${pyTypeName(d)}' object has no attribute 'get'`);
    }
    const name = pyOr((d as Record<string, unknown>)["name"] === undefined
        ? null : (d as Record<string, unknown>)["name"], "image");
    return `[图片: ${pyStr(name)}]`;
}

// PORT STATUS: confidence=high todos=[0]
