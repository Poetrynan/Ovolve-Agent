/**
 * http_server_media.ts — 单元 218 `app/backend/server/http_server.py`（8819 源行）的 **段 S3**。
 * 分段方案 `tmp/w218_SEGMENTS.md` · 契约表 `tmp/w218_SURFACE.md` · 死路/seam 约定 `tmp/w218_S0_NOTES.md`。
 *
 * ⚠️ **这是草稿文件**（派发令硬规则：仓库级 `tsc` 正被别的段的门使用，engine 树里留半截 `.ts`
 * 会把所有人拖红）。落地时：把本文件复制成 `app/engine/server/http_server_media.ts`，
 * 并**删除 `tmp/w218_draft/http_server_keys.ts` 那份只读副本**（它只为隔离编译存在）。
 * 另注：`app/engine/server/http_server_s3.ts` 是**同一区间的前一次落地**（49462 字节），
 * 它比本文件少 8 处保真修正（见下面 §保真修正清单），落地时**必须整文件替换**，不能留双份。
 *
 * 覆盖源区间 **2839–3260**（只读 handler + 媒体/健康 + 路径准入门）：
 *   2839–2877  handle_health
 *   2880–2900  handle_confirm_goal_stopped   (POST /api/goals/{id}/confirm-stopped；goals 族在 S4，按行号归 S3)
 *   2903–2914  handle_migrations_status
 *   2917–2934  handle_migrations_retry
 *   2937–2956  handle_learning_bundles       (evolution 族在 S9，按行号归 S3)
 *   2959–2972  handle_tool_contracts
 *   2977–3007  handle_get_image
 *   3010–3036  段注释（安全姿态：白名单/双重遍历拦截/扩展名即 MIME/尺寸+频率帽）
 *   3040–3049  MEDIA_MIME_BY_EXT
 *   3054       MAX_MEDIA_FILE_BYTES
 *   3058       MEDIA_RATE_PER_MIN
 *   3062       _PCT_ESCAPE_RE
 *   3064       _file_req_times（模块级可变态）
 *   3067–3077  cua_shots_dir
 *   3080–3088  preview_allowed_roots
 *   3091–3099  _user_home
 *   3102–3193  resolve_local_media_path      ⚠️ 安全门：白名单语义逐字保留
 *   3196–3204  _media_file_rate_ok
 *   3207–3209  _reset_media_file_rate
 *   3212–3256  handle_get_file
 *
 * 本段**不注册路由**（S10 负责装配），只导出 handler 正文 + S3 私有 helper。
 * ROUTE_TABLE 里 `S3:preview_allowed_roots` / `S3:resolve_local_media_path` /
 * `S3:_media_file_rate_ok` / `S3:_reset_media_file_rate` 四个 seam 名 → 就是本文件的导出；
 * 别的段（S7 permissions/overview 读 preview_allowed_roots）跨段取用即 import 这里。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **保真修正清单**（相对 `app/engine/server/http_server_s3.ts`；全部是"更贴源"，没有一处是"改进源"）：
 *  F1 `os_path_join` 的不同盘符分支：CPython `ntpath.join` 在 `p_drive.lower() != result_drive.lower()`
 *    分支里是 **`continue`**（"Different drives => ignore the first path entirely"），**不**走后面的
 *    加分隔符 + `result_path + p_path`。前一版把它当 fallthrough，`join("c:\\ws","d:x.png")` 得到
 *    `"d:x.png\\x.png"` 而不是 `"d:x.png"`——正好砸在 S3-B14 那条门路径上。本文件逐字复刻 `continue`。
 *  F2 两条 `re.match` 的 `.` 必须译成 `[^
]`（CPython 的 `.` 只排除 `
`，JS 的 `.` 还排除 `
`/`U+2028`/`U+2029`）。
 *    后两者**能穿过** `ord(ch) < 32` 控制门（0x2028=8199），于是 `C:/a<UT2028>b.png` 在前一版里
 *    整条 `drive` 正则匹配失败 → `drive` 为 null → 冒号门拿**整串**判定 → 含盘符冒号 → **traversal(403)**；
 *    源里则匹配成功、group(2) 无冒号 → **继续走白名单**。安全门上的可达分歧，必修。
 *  F3 `py_unquote` 按 CPython 3.13 的 `_generate_unquoted_parts` **逐 ASCII 段独立解码**
 *    （`_asciire = re.compile('([\\x00-\\x7f]+)')`），非 ASCII 段原样透传。前一版把整串（含非 ASCII）
 *    编码成一条字节流再解码 → `%` 遇到非 ASCII 就错乱：`"%" + "é" + "%41"` 源给 `"%éA"`，前一版给 `"éA"`。
 *    顺带：lone surrogate 在源里**属于非 ASCII 段 → 原样穿过，unquote 永不抛错**，
 *    前一版用 TextEncoder 逐字符编码会把它替换成 U+FFFD（伪造出源没有的字节）。
 *  F4 `py_quote` 走 `str.encode('utf-8', 'strict')` 的语义：lone surrogate **抛 UnicodeEncodeError**
 *    （文案已复刻），而不是静默出 `%EF%BF%BD`。源 3247 的 RFC 5987 头因此可能冒出 handler。
 *  F5 `py_strip` 用 CPython `str.isspace()` 的**实测 29 码点全集**（本机解释器枚举所得）：
 *    0x09–0x0d、**0x1c–0x1f**、0x20、0x85、0xa0、0x1680、0x2000–0x200a、0x2028、0x2029、0x202f、0x205f、0x3000。
 *    前一版缺 0x1c–0x1f 等 → `"\x1cfoo.png"` 源里 strip 掉 FS 后**过控制门**，前一版**留在串里 → traversal**。
 *    注意 strip 在源 3118、控制门在源 3138：**先裁后判**，这是门的一部分。
 *  F6 `py_iter_list` 的 TypeError 文案用 `py_type_name(v)`（源会报实际类型），不再硬编码 `'NoneType'`。
 *  F7 `handle_health` 的 goals 臂求值次序改成源序：`import` → `get_goal_scheduler()` →
 *    `sched.active_count` → `int(MAX_WORKERS)`（dict 字面量按书写序求值）。前一版先算 `int(MAX_WORKERS)`，
 *    于是"active_count 缺属性"与"MAX_WORKERS 非数字"谁先炸的观测顺序反了。
 *  F8 `handle_confirm_goal_stopped`：`get_goal(...) is None` → `py_is_none`（`undefined` 也算 None）；
 *    `result.ok`/`result.error` 走属性访问（源是属性不是键，dict 假件应得到 AttributeError）。
 *  F9 `py_dict_get` 接受 `Map` 接收者（S0 用 Map 建模 dict）。
 *  F10 `handle_get_file` 的 workspace：源 3226 是 `getattr(...) or ""`，**没有 `str()`**；
 *    前一版套了 `py_str` 会把 Path/数字渲染成源永远不会产生的串。本文件保留对象身份，
 *    非 str 只可能在源真正报错的地方（`ntpath.join` 的 `_check_arg_types`）抛同一条 TypeError。
 *    对比：源 3075 `str(home_dir())` **确实**有 `str()`，`cua_shots_dir` 保留 `py_str`。
 *  F11 `MEDIA_MIME_BY_EXT[ext]`（源 3244）改成 `py_map_index`（缺键抛 KeyError），不再 `as string` 撒谎。
 *  F12 模块级限速窗口导出为 `_file_req_times`（源 3064 的模块全局，测试可见），保留数组身份。
 *  F13 `handle_get_image` 的 `path.name` / FileResponse 的 path 走属性/`fspath` 语义（源 3005 是
 *    pathlib.Path 的属性访问；str 假件在源里就是 AttributeError）。
 *  F14 `os.path.isabs`/`splitext`/`split`/`basename` 的入参在源里都先过 `os.fspath`；本文件的字符串
 *    实现只在**已确定为 str** 的路径上调用（见调用点注释），故无需复刻 fspath 抛错。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OS 假设（**本段地基，不是可选项**）：源用 `os.path`（Windows 上 = `ntpath`），探针两侧跑在
 * **同一台 Windows 机**（`tmp/dp_pyfile.mjs` 只重定向 HOME，不改 OS）。所以所有纯字符串路径运算
 * 逐字复刻 `Lib/ntpath.py`（本机 3.13 实测），**不是** POSIX、**不是** `node:path.win32`
 * （win32.normalize 会折叠 `..`、会规约 `//`、join 不实现 splitroot 的 UNC/device 规则，
 * 而 ntpath 不折叠且区分 `\\?\`；源在 Windows 上用的正是 ntpath，对齐 ntpath 才与源逐位相同）。
 * 真正触盘的四项（`real_path`/`is_within`/`isfile`/`getsize`）是 seam；时钟 `time.time()` 也是 seam
 * （S0 NOTES §1.2 明写"时间缝属于 S3 的 `_media_file_rate_ok`（源 3196–3211）"）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 源码自带死路/缺陷（**照抄不修**，供主控 §9 缺陷台账）：
 *
 * S3-B1 handle_confirm_goal_stopped（源 2886–2887）函数级 import **不在 try 里**，而紧接的
 *       `await ...confirm_stopped(...)` 只兜 `RuntimeError`。于是模块缺失（ImportError）与
 *       confirm_stopped 的任何**非 RuntimeError** 异常都冒出 handler（走装配层 render_uncaught）。
 *       源 2894 是**全文件唯一**的 `except RuntimeError`。端口：seam 默认抛 ModuleNotFound → 冒出；
 *       只有 `PyRuntimeErrorP` 被这一臂兜成 503。
 * S3-B2 resolve_local_media_path 源 3160–3161 `if drive: path = drive.group(1)+drive.group(2)` 是
 *       **恒等重写**（drive 就是按该模式匹配出来的，拼回去 = 原串）。看似漏了归一，其实什么都没做。逐字保留。
 * S3-B3 handle_migrations_retry 源 2927 已经把 `mig_id` 收成 str，源 2930 又写 `mig_id or ""`：
 *       第二层 `or` 永不改变值。保留这条冗余（探针可据此断言 seam 收到的永远是 str）。
 * S3-B4 handle_migrations_retry 源 2927 `(data or {}).get("id")` 的 `.get` **不在任何 try 里**
 *       （json 的 try 早在 2926 结束）：body 是 JSON 数组/字符串/数字时 `.get` 抛 AttributeError 冒出 handler。
 *       这是 S0 NOTES B4 家族在 S3 的实例。端口：`py_dict_get` 在非 dict 上抛 `PyAttributeError`，handler 不捕。
 * S3-B5 handle_health 源 2852 `body["instanceLock"].get("held")`：键**先赋值后校验**，
 *       若 `status()` 返回非 dict，`.get` 抛 AttributeError 被同一 try 吞 → 但 `instanceLock` 键**已经落进 body**，
 *       于是响应里出现"一个非 dict 的 instanceLock + status=ok"的半写状态。这与另两条臂（dict 字面量整体赋值，
 *       中途抛错则整键留不下）**不对称**。保留。
 * S3-B6 `cua_shots_dir`（源 3076–3077）的 `except Exception: return ""` 连 `home_dir()` 的语义错误一起吞；
 *       且它与 `_user_home`（源 3091）走**两个不同真相源**（user_dirs.home_dir = `~/.ovolve` 数据根，
 *       _user_home = 真实家目录）。源注释 3092–3098 专门解释这点。端口不改。
 * S3-B7 handle_get_image 源 2992/2994：import 与 `request.app[ROUTER_KEY]` 都**不在 try 里** →
 *       router 缺 `workspace` 属性、app 缺键、`resolve_image` 抛任何异常，都没有 500 兜底，直接冒出 handler。
 * S3-B8 `_media_file_rate_ok` 源 3199 窗口裁剪用 `> 60`（**严格大于**，恰好 60.000s 不裁），
 *       且命中上限时**不 append**（拒绝不给自己记账）→ 满窗后每一次请求继续被拒，直到最早那条滑出 60s。
 *       这是有意的"拒绝不续期"。两点都逐字保留。
 * S3-B9 `path == "~" or path.startswith("~/")`（源 3163）：`~user`（`~bob/x`）**不匹配**这一支，
 *       于是落到 `elif not isabs and workspace` → 变成 workspace 下一个名叫 `~bob/x` 的相对文件。保留，不扩到 `~user`。
 *       （顺带：`ntpath.expanduser` 自己是支持 `~user` 的，但源这里**根本没用** expanduser 走输入，只用它取 `~`。）
 * S3-B10 **源里没有任何 `..` 检查**。段注释 3027–3031 写着 "Traversal dies twice"，但第一层"raw-shape gates"
 *       实际只查 控制符/残留百分号/`//` 开头/冒号（ADS）四条，`../../Windows/win.ini` 这种纯相对形态
 *       **一路穿过到 `path_guard.real_path`**，只靠 3179 的 `is_within` 兜住。也就是说"两次拦截"在源码里
 *       只有**一次**是遍历拦截（另一次是 symlink 归一后的同一件事）。端口保留，不加 `..` 检查。
 * S3-B11 `path.startswith("file://")`（源 3121）**大小写敏感**：`FILE:///C:/x.png` 不进解码分支，
 *       直接撞上控制门之后的冒号门 → traversal。而浏览器/OS 的 file URI 大小写是不敏感的。保留（fail closed，安全方向）。
 * S3-B12 裸 `~`（源 3167 的 `rest` 为假分支）展开成**真实家目录**，而白名单根是 `~/.ovolve/cua_shots`；
 *       家目录本身不是根 → 除非家目录恰好被塞进 allowed_roots，否则裸 `~` 恒为 traversal。
 *       `~/.ovolve/cua_shots/x.png` 这种"聊天里真正会出现的写法"才走得通。保留。
 * S3-B13 `allowed_roots` 为空 ⇒ `any([])` ⇒ False ⇒ **一切输入都是 traversal**（包括确实在 workspace 里的合法文件）。
 *       `preview_allowed_roots("")` 且 `cua_shots_dir()` 返回 ""（user_dirs 未接线/抛错，见 S3-B6）就会得到空表。
 *       端口保留：seam 未接线的默认 `is_within → false` 与这条同源（都是 fail closed）。
 * S3-B14 **盘符相对输入会让 workspace 被整个丢弃，并由进程 CWD 接手**，与源注释相矛盾：
 *       `raw = "a:notes.png"`（workspace=`c:\\ws`）→ 无 `~/`、`ntpath.isabs("a:notes.png")` 为 False（isabs 只看前 3 字符）
 *       → 进 `os.path.join(workspace, path)`；`splitroot("a:notes.png")` 给出 drive=`a:`、root=`""`、path=`notes.png`，
 *       与 `c:` **不同盘** → ntpath 的 "Different drives => ignore the first path entirely" → 结果 **`"a:notes.png"`**，
 *       workspace 被丢掉。随后 `path_guard.real_path` 里的 `os.path.abspath` 会把盘符相对路径按**进程 CWD** 解析。
 *       源 3169–3170 的注释 "never the process cwd" 因此**不成立**。
 *       注意这**不是白名单绕过**：real_path 归一后再由 is_within 判定，落在 CWD 的白名单外照样 traversal；
 *       同盘不同大小写（`c:notes.png` + workspace `C:\\ws`）走 "Same drive in different case" 分支，
 *       结果 `C:\\ws\\notes.png`（root 仍来自第一段），这条是**符合注释**的。缺陷只在**异盘**。保留并登记。
 * S3-B15 两个 FileResponse 面的**转义不对称**：`handle_get_image`（源 3005）把 `path.name` **原样塞进双引号**
 *       （含 `"`/反斜杠/控制符的名字会破坏头，且没有任何 RFC 5987 变体），而 `handle_get_file`
 *       （源 3242–3248）做了 `32 < ord < 127` + 去 `"` `\` 的 ASCII 回退 + `filename*=UTF-8''`。
 *       另外 image 面无尺寸帽、无频率帽（getsize/413/429 都只在 files 面）。保留。
 * S3-B16 `handle_get_file` 的**限速在 app 状态读取之前**（源 3222 早于 3225）：被限流的请求不碰 router，
 *       于是 429 **优先于** 400/403（即使 `path` 缺失也回 429）。同时源 3228–3237 是一串**互斥 if**，
 *       `err` 为空串才落到成功支；若将来出现表外 reason，源的行为是**当成功处理**（继续走 MIME 查表）。保留顺序。
 * S3-B17 源 3125–3128 的 `except Exception: return None, "traversal"` **不可达**：
 *       `urllib.parse.unquote(str)` 在本机 3.13 的实现里对 str 输入永不抛错（非 ASCII 段原样透传、
 *       ASCII 段以 `errors='replace'` 解码）。这条臂只在 monkeypatch 时才生效。保留（不删防御代码）。
 * S3-B18 四臂把 `str(exc)` 直接写进 500 响应体（源 2914 / 2934 / 2956 / 2972）：子系统内部异常文案
 *       （含路径、SQL 片段）会回给前端。端口逐字保留，**不**做脱敏。
 *
 * DIVERGENCE(port):
 *  D1 `os.path.join/isabs/splitext/split/basename` 复刻 ntpath（3.13 源码逐行对照，见 §2）。
 *     与 `node:path.win32` 的差异是故意的；**这是安全门**，故不接受近似实现。F1 修的就是这条。
 *  D2 `time.time()` 是 seam（`now()`）：源 3198 直接调 `time.time()`，探针注入假时钟才能让限速窗口跨用例可控
 *     （红线：端口不把真时钟读进账本）。缺省实现 `Date.now()/1000` 只是"未接线时的合理缺省"，探针必须覆盖。
 *  D3 CPython `str(exc)`：本文件的异常类（`ModuleNotFoundErrorP`/`PyRuntimeErrorP`/`PyAttributeErrorP`/
 *     `PyOSErrorP`/`PyTypeErrorP`）的 `message` **就是** `str(exc)` 的同一份文案（不带类名前缀），
 *     `exc_str(exc)` 直接取 `message`。注意与 S0 的一处约定不同：`keys.ts` 的 `py_int`/`py_float` 抛的是
 *     JS `TypeError` 且 message **带** `"ValueError: "` 前缀（那属于 S0 已登记的约定）。在 S3 里这条只出现在
 *     `handle_health` 的 goals 臂（源 2873 `int(MAX_WORKERS)`），而该臂是 `except: pass`，**文案不外泄**，
 *     因此不影响任何响应体。
 *  D4 未捕获异常的最终状态码**不能从源码推出**（aiohttp 版本间 `request.json()`/未捕异常渲染不同），
 *     一律交装配层 `render_uncaught`（S0 NOTES B4、create.ts §C）。本段对 S3-B1/B4/B7 冒出的路径
 *     **不在端口编 400/500**，直接把异常抛出去。
 *  D5 正则语义：`re.match` → `^` 锚定的 `exec`；`re.search` → 非全局 `test`；`.` → `[^
]`（见 F2）；
 *     `$` 在 Python 允许尾随 `
`（JS 不允许），但控制门（源 3138）已在两条 `re.match` **之前**排除 `
`（ord 10 < 32），
 *     该差异不可达——这是"先解码后判控制符"这一顺序（源 3121–3139）带来的**附带安全收益**，记录以便复核。
 *  D6 `str.lower()`（源 3182/3184/3239 的扩展名归一）：JS `toLowerCase()` 实现 Final_Sigma 特殊条件
 *     （`"ΑΣ".toLowerCase()==="ας"`），CPython `str.lower()` 不实现（`"ας"`）。**已查且不影响判定**：
 *     扩展名只与 ASCII 键表 `MEDIA_MIME_BY_EXT` 做成员比较，任何非 ASCII 结果两侧都是 not-media。
 *  D7 seam 折叠：源里"函数级 import + 属性 + 调用"三步（如 `from storage import get_storage; get_storage().migration_status()`、
 *     `get_evolution_engine().store.bundles_for_goal(...)`）在端口折叠成**一臂**。源在缺模块时抛 ImportError、
 *     缺属性时抛 AttributeError，两者在端口都是 seam 默认抛 ModuleNotFound；**500 体文案因此不同**（S3-B18 的臂）。
 *     探针若要钉死文案，让对应 seam 抛 `PyAttributeErrorP("'X' object has no attribute 'store'")` 即可，端口不再包一层。
 *  D8 `str` 与 `os.PathLike`：端口把 pathlib 面建模为 `{ path, name }`（`PyPathLike`）或 `__fspath__` 假件，
 *     字符串型只允许在 CPython 真正读取它的那一步进入（`py_path_str` / `py_fspath_str`，两者都复刻
 *     `genericpath._check_arg_types` / `os.fspath` 的 TypeError 文案）。`Path.name` 与 `ntpath.basename`
 *     在尾随分隔符时不同（`Path("a/b/").name=="b"` 而 `basename("a/b/")==""`），故 `handle_get_image`
 *     用**属性**（seam 提供），`handle_get_file` 用 **basename**（源 3240 用的就是 ntpath.basename）。
 */

import {
  exc_str,
  file_response,
  json_response,
  make_headers,
  ModuleNotFoundErrorP,
  os_path_basename,
  os_path_isabs,
  os_path_join,
  os_path_splitext,
  py_any_control,
  py_dict_get,
  py_fspath_str,
  py_getattr,
  py_getattr_or,
  py_int,
  py_is_none,
  py_iter,
  py_join_map,
  py_lstrip_chars,
  py_map_index,
  py_or,
  py_path_str,
  py_quote,
  py_repr,
  py_str,
  py_strip,
  py_strip_or,
  py_truth,
  py_type_name,
  py_unquote,
  PyKeyError,
  PyOSErrorP,
  PyRuntimeErrorP,
  ROUTER_KEY,
  type JsonDict,
  type WebRequest,
  type WebResponse,
} from "./http_server_keys.js";

/* ──────────────────────────────────────────────────────────────────────────
 * §3 模块常量与模块态（源 3010–3064）
 * ──────────────────────────────────────────────────────────────────────── */

/** 源 3038–3049 `MEDIA_MIME_BY_EXT`：显式表，**不用 mimetypes.guess_type**（Windows 上会查注册表=用户可控输入决定我们的头）。键序照源。 */
export const MEDIA_MIME_BY_EXT: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mkv: "video/x-matroska", avi: "video/x-msvideo", m4v: "video/x-m4v",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  m4a: "audio/mp4", flac: "audio/flac",
};

/** 源 3051–3054 `MAX_MEDIA_FILE_BYTES = 64 * 1024 * 1024`（预览天花板；Range 请求在帽下照常）。 */
export const MAX_MEDIA_FILE_BYTES = 64 * 1024 * 1024;

/** 源 3056–3058 `MEDIA_RATE_PER_MIN = 240`。 */
export const MEDIA_RATE_PER_MIN = 240;

/** 源 3060–3062 `_PCT_ESCAPE_RE = re.compile(r"%[0-9a-fA-F]{2}")`：单解之后仍残留 = 双编码企图 → 403，不再解第二次。 */
const _PCT_ESCAPE_RE = /%[0-9a-fA-F]{2}/;

/** 源 3152 `lead = re.match(r"^/([A-Za-z]:)(/.*)?$", path)`；`.` 译成 `[^
]`（F2）。 */
const RE_LEAD = /^\/([A-Za-z]:)(\/[^\n]*)?$/;

/** 源 3157 `drive = re.match(r"^([A-Za-z]:)(.*)$", path)`；同上（F2）。 */
const RE_DRIVE = /^([A-Za-z]:)([^\n]*)$/;

/** 源 3064 `_file_req_times: "list[float]" = []` —— 模块级可变态，测试可见（F12：保留数组身份，`_reset_media_file_rate` 走 in-place 清空）。 */
export const _file_req_times: number[] = [];

/* ──────────────────────────────────────────────────────────────────────────
 * §4 接缝（红线 5：本段唯一的对外触碰面；探针在此插假件）
 * ──────────────────────────────────────────────────────────────────────── */

/** 源 2893 `confirm_stopped()` 返回对象的属性面（源用 `.ok`/`.error` **属性**，不是键 → F8）。 */
export interface ConfirmResult {
  readonly ok: unknown;
  readonly error: unknown;
}

/** 源 2889 `get_goal_manager().storage` 在本案面。 */
export interface GoalStorage {
  get_goal(goal_id: unknown): unknown;
}

/** 源 2952–2953 `engine.store` 的 bundles 面（折叠成方法臂，见 §DIVERGENCE 7）。 */
export interface BundlesStore {
  bundles_for_goal(goal_id: string): unknown;
  list_bundles(opts: { limit: number }): unknown;
}

/** 源里 `image_store.resolve` 返回 `Optional[pathlib.Path]`：`.name` 是属性，FileResponse 吃 Path 本身（D8）。 */
export interface PyPathLike {
  readonly path?: string;
  readonly name?: unknown;
  readonly __str__?: () => string;
  readonly __fspath__?: () => string;
}

export interface HttpS3Seams {
  /** 源 2850–2851 `import instance_lock` + `instance_lock.status()`。 */
  instance_lock_status: () => unknown;
  /** 源 2857–2858 `from storage import get_storage; get_storage().migration_status()`。 */
  storage_migration_status: () => unknown;
  /** 源 2869–2870 `from goal_scheduler import get_goal_scheduler` + `sched = get_goal_scheduler()`。 */
  goal_scheduler_for_health: () => unknown;
  /** 源 2869 同一 import 带进来的模块常量 `MAX_WORKERS`（求值序见 F7）。 */
  goal_scheduler_max_workers: () => unknown;
  /** 源 2886–2889 `from goal_manager import get_goal_manager` + `.storage`。 */
  goal_manager_storage: () => GoalStorage;
  /** 源 2887/2893 `await get_goal_scheduler().confirm_stopped(id)`；调度器没跑时源抛 RuntimeError → 端口抛 `PyRuntimeErrorP`。 */
  goal_scheduler_confirm_stopped: (goal_id: string) => Promise<ConfirmResult>;
  /** 源 2887/2900 `from goal_scheduler import goal_view` + `goal_view(goal)`。 */
  goal_view: (goal: unknown) => unknown;
  /** 源 2929–2930 `get_storage().retry_deferred_migration(mig_id)`。 */
  storage_retry_deferred_migration: (mig_id: string) => unknown;
  /** 源 2949–2952 `from evolution import get_evolution_engine` + `engine.store`（折叠臂，D7）。 */
  evolution_engine_store: () => BundlesStore;
  /** 源 2968–2970 `from tools import get_tool_registry` + `.execution_contracts()`。 */
  tool_registry_execution_contracts: () => unknown;
  /** 源 2992/2996 `from image_store import resolve` + `resolve_image(id, workspace)` → `Optional[Path]`。 */
  resolve_image: (image_id: string, workspace: unknown) => PyPathLike | null;
  /** 源 2992/3003 `from image_store import mime_for_path` + `mime_for_path(path)`。 */
  mime_for_path: (image: PyPathLike) => unknown;
  /** 源 3113/3178 `import path_guard` + `path_guard.real_path(path)` == `normcase(realpath(abspath(p)))`（symlink/junction 感知）。 */
  path_guard_real_path: (p: string) => string;
  /** 源 3179 `path_guard.is_within(real, root)`（两侧都再归一一次 ⇒ 大小写不敏感与兄弟前缀安全都在 path_guard 那个单元里，不在 S3）。 */
  path_guard_is_within: (real: string, root: unknown) => boolean;
  /** 源 3185 `os.path.isfile(real)`。 */
  file_isfile: (p: string) => boolean;
  /** 源 3188 `os.path.getsize(real)`（失败抛 `PyOSErrorP` 族 → 3189 兜成 not-found）。 */
  file_getsize: (p: string) => number;
  /** 源 3074–3075 `from user_dirs import home_dir` + `str(home_dir())`（= `~/.ovolve` 数据根）。 */
  user_home_dir: () => unknown;
  /** 源 3099 `os.path.expanduser("~")`（=**真实**家目录，与上面不同真相源，见 S3-B6）。 */
  expanduser_home: () => string;
  /** 源 3198 `time.time()`（时钟缝，§DIVERGENCE 2）。 */
  now: () => number;
}

/**
 * 缺省即"未接线 = 安全失败"：
 *  · 触盘四项保守（`is_within → false` ⇒ 一切 traversal，与 S3-B13 同源；`isfile → false` ⇒ not-found）；
 *  · 子系统臂抛 `ModuleNotFoundError`（对应源里那些**在 try 内**的 import 被吞成降级/500，
 *    以及那些**不在 try 内**的 import 冒出 handler —— S3-B1/B7，S0 NOTES 的 B2 先例）；
 *  · `now()` 是唯一"合理缺省"（`Date.now()/1000`），源里它总会被调用且不是安全门；探针必须覆盖；
 *  · `expanduser_home()` 复刻 `ntpath.expanduser` 取家的顺序：`USERPROFILE` →（否则）`HOMEDRIVE+HOMEPATH` join →
 *    两者都没有时**原样返回 `"~"`**（ntpath 3.13 的 `elif 'HOMEPATH' not in os.environ: return path`）；
 *    Windows 上 `os.environ` 的键大小写不敏感（`os.py::encodekey` 把键转大写），所以这里做大小写不敏感查找。
 */
export const HTTP_S3_SEAMS: HttpS3Seams = {
  instance_lock_status(): unknown {
    throw new ModuleNotFoundErrorP("instance_lock");
  },
  storage_migration_status(): unknown {
    throw new ModuleNotFoundErrorP("storage");
  },
  goal_scheduler_for_health(): unknown {
    throw new ModuleNotFoundErrorP("goal_scheduler");
  },
  goal_scheduler_max_workers(): unknown {
    throw new ModuleNotFoundErrorP("goal_scheduler");
  },
  goal_manager_storage(): GoalStorage {
    throw new ModuleNotFoundErrorP("goal_manager");
  },
  async goal_scheduler_confirm_stopped(_goal_id: string): Promise<ConfirmResult> {
    throw new ModuleNotFoundErrorP("goal_scheduler");
  },
  goal_view(goal: unknown): unknown {
    return goal;
  },
  storage_retry_deferred_migration(_mig_id: string): unknown {
    throw new ModuleNotFoundErrorP("storage");
  },
  evolution_engine_store(): BundlesStore {
    throw new ModuleNotFoundErrorP("evolution");
  },
  tool_registry_execution_contracts(): unknown {
    throw new ModuleNotFoundErrorP("tools");
  },
  resolve_image(_image_id: string, _workspace: unknown): PyPathLike | null {
    throw new ModuleNotFoundErrorP("image_store");
  },
  mime_for_path(_image: PyPathLike): unknown {
    throw new ModuleNotFoundErrorP("image_store");
  },
  path_guard_real_path(p: string): string {
    // 未接线的 real_path 不做解析：原样返回，交给 is_within 的保守缺省挡掉（默认全拒）。
    return p;
  },
  path_guard_is_within(_real: string, _root: unknown): boolean {
    return false;                                       // 安全缺省：未接线一律"不在白名单内"→ traversal→403
  },
  file_isfile(_p: string): boolean {
    return false;
  },
  file_getsize(p: string): number {
    throw new PyOSErrorP(`[WinError 2] The system cannot find the file specified: ${py_repr(p)}`);
  },
  user_home_dir(): unknown {
    throw new ModuleNotFoundErrorP("user_dirs");
  },
  expanduser_home(): string {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    const key = (name: string): string | undefined => {
      for (const k of Object.keys(env)) if (k.toUpperCase() === name) return env[k];
      return undefined;
    };
    const has = (name: string): boolean => key(name) !== undefined;
    if (has("USERPROFILE")) return key("USERPROFILE") as string;
    if (!has("HOMEPATH")) return "~";
    return os_path_join(key("HOMEDRIVE") ?? "", key("HOMEPATH") as string);
  },
  now(): number {
    return Date.now() / 1000;
  },
};

/* ──────────────────────────────────────────────────────────────────────────
 * §5 GET /api/health（源 2839–2877）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Health + honest system state（docstring 2842–2846：诊断失败**绝不能**让 health 本身失败）。
 * 三条 best-effort 臂各一只 `try/except Exception: pass`，键按**插入顺序**落进 body：
 *   status, version, [instanceLock], [migrations], [goals]（源 2848 起手，三臂按源序补，响应体逐字节相关）。
 * 未 held（2852–2853）或 recoveryMode 非空（2864–2865）→ status 降级 "degraded"。
 * S3-B5：第一臂**先赋键后校验**（半写状态），后两臂是 dict 字面量（中途抛错整键留不下）——不对称但照源。
 * F7：第三臂求值序 = import → get_goal_scheduler() → `active_count` → `int(MAX_WORKERS)`。
 */
export async function handle_health(
  request: WebRequest,
  seams: HttpS3Seams = HTTP_S3_SEAMS,
): Promise<WebResponse> {
  void request;
  const body: JsonDict = { status: "ok", version: "2.0.0" };
  try {
    const inst_lock = seams.instance_lock_status();
    body["instanceLock"] = inst_lock;                  // 源 2851：键先落
    if (!py_truth(py_dict_get(inst_lock, "held"))) {   // 源 2852：非 dict 在这里 AttributeError → 被同一 try 吞
      body["status"] = "degraded";
    }
  } catch {
    // except Exception: pass（源 2854–2855）
  }
  try {
    const ms = seams.storage_migration_status();
    const pending = py_iter(py_or(py_dict_get(ms, "pending"), [])).map((p) => py_dict_get(p, "id"));
    const migrations: JsonDict = {
      pending,
      deferred: py_or(py_dict_get(ms, "deferred"), []),
      recoveryMode: py_or(py_dict_get(ms, "recoveryMode"), ""),
    };
    body["migrations"] = migrations;                   // dict 字面量：上面任何一步抛错 → 整键留不下
    if (py_truth(migrations["recoveryMode"])) {        // 源 2864 是对刚建的那个 dict 下标
      body["status"] = "degraded";
    }
  } catch {
    // except Exception: pass（源 2866–2867）
  }
  try {
    const sched = seams.goal_scheduler_for_health();   // 源 2870
    const active = py_getattr(sched, "active_count");  // 源 2872（dict 字面量第一个值）
    const max_workers = py_int(seams.goal_scheduler_max_workers());  // 源 2873 int(MAX_WORKERS)：坏值抛 → 整臂落空
    body["goals"] = { active, maxWorkers: max_workers };
  } catch {
    // except Exception: pass（源 2875–2876）
  }
  return json_response(body);
}

/* ──────────────────────────────────────────────────────────────────────────
 * §6 POST /api/goals/{id}/confirm-stopped（源 2880–2900）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * `stop_timeout` 回到 paused（进而回到可认领）的**唯一**受许可出口（docstring 2881–2884）。
 * S3-B1：函数级 import（2886–2887）不在 try；`await confirm_stopped` **只**兜 `RuntimeError` → 503
 * （源 2894 是全文件唯一的 `except RuntimeError`）。
 * 顺序即语义：404（`get_goal is None`）→ confirm_stopped → `not result.ok` → 409（带 `result.error`）→ 200。
 * 源 2890 与 2900 **两次**读 `get_goal`（TOCTOU：中间状态可能已变），端口同样调两次同一个 seam，忠实。
 */
export async function handle_confirm_goal_stopped(
  request: WebRequest,
  seams: HttpS3Seams = HTTP_S3_SEAMS,
): Promise<WebResponse> {
  const goal_id = request.match_info.get("id", "");
  const storage = seams.goal_manager_storage();        // 未接线 → ModuleNotFound 冒出 handler（S3-B1，无 try）
  if (py_is_none(storage.get_goal(goal_id))) {         // 源 2890 `is None`（F8）
    return json_response({ error: "Goal not found" }, 404);
  }
  let result: ConfirmResult;
  try {
    result = await seams.goal_scheduler_confirm_stopped(goal_id);
  } catch (exc) {
    if (exc instanceof PyRuntimeErrorP) {              // except RuntimeError:（源 2894）——**只这一类**
      return json_response({ error: "Goal scheduler is not running on this server" }, 503);
    }
    throw exc;                                         // 其他异常冒出 handler（S3-B1 / §DIVERGENCE 4）
  }
  if (!py_truth(py_getattr(result, "ok"))) {           // 源 2898 属性访问（F8）
    return json_response({ error: py_getattr(result, "error") }, 409);
  }
  return json_response({ ok: true, goal: seams.goal_view(storage.get_goal(goal_id)) });
}

/* ──────────────────────────────────────────────────────────────────────────
 * §7 GET / POST /api/system/migrations（源 2903–2934）
 * ──────────────────────────────────────────────────────────────────────── */

/** GET：整函数一只 try，except → `{"error": str(exc)}` 500（源 2910–2914；S3-B18 直回异常文案）。 */
export async function handle_migrations_status(
  request: WebRequest,
  seams: HttpS3Seams = HTTP_S3_SEAMS,
): Promise<WebResponse> {
  void request;
  try {
    return json_response(seams.storage_migration_status());
  } catch (exc) {
    return json_response({ error: exc_str(exc) }, 500);
  }
}

/**
 * POST：`except Exception: data = {}`（2923–2926）之后，`.get`/`str` 全在 try **之外**（S3-B4 → 冒出 handler）。
 * retry 结果在第二只 try 内；`res.get("ok")` 决定 200/409；except → `{"ok": False, "error": str(exc)}` 500（2928–2934）。
 * S3-B3：`mig_id` 已是 str，源 2930 还写 `mig_id or ""`（冗余，逐字保留）。
 */
export async function handle_migrations_retry(
  request: WebRequest,
  seams: HttpS3Seams = HTTP_S3_SEAMS,
): Promise<WebResponse> {
  let data: unknown;
  try {
    data = await request.json();
  } catch {
    data = {};
  }
  // str((data or {}).get("id") or "") —— .get 在非 dict 上 AttributeError，**不在任何 try 里**（S3-B4）
  const mig_id = py_str(py_or(py_dict_get(py_or(data, {}), "id"), ""));
  try {
    const res = seams.storage_retry_deferred_migration(py_or(mig_id, "") as string);  // S3-B3 冗余；值恒等于 mig_id
    const status = py_truth(py_dict_get(res, "ok")) ? 200 : 409;
    return json_response(res, status);
  } catch (exc) {
    return json_response({ ok: false, error: exc_str(exc) }, 500);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * §8 GET /api/evolution/bundles（源 2937–2956）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * `?goalId=` 真值走 `bundles_for_goal(goal_id)`，否则 `list_bundles(limit=100)`（源 2951–2953）；
 * 整函数一只 try，except → `{"error": str(exc)}` 500（S3-B18）。
 * docstring 2938–2946 的两类生产者（每完成 goal 一行 / 每 Dream 整合一行，Dream 行**故意没有** `goalId`）
 * 属于 evolution 单元，本段只搬运。
 */
export async function handle_learning_bundles(
  request: WebRequest,
  seams: HttpS3Seams = HTTP_S3_SEAMS,
): Promise<WebResponse> {
  try {
    const store = seams.evolution_engine_store();      // 折叠 get_evolution_engine().store（D7）
    const goal_id = request.query.get("goalId", "");
    const rows = py_truth(goal_id)
      ? store.bundles_for_goal(goal_id)
      : store.list_bundles({ limit: 100 });
    return json_response({ bundles: rows });
  } catch (exc) {
    return json_response({ error: exc_str(exc) }, 500);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * §9 GET /api/tools/contracts（源 2959–2972）
 * ──────────────────────────────────────────────────────────────────────── */

/** 诚实停止面：哪些工具真能死、哪些只是"请求了停止"（docstring 2960–2965）；except → 500 带 str(exc)（S3-B18）。 */
export async function handle_tool_contracts(
  request: WebRequest,
  seams: HttpS3Seams = HTTP_S3_SEAMS,
): Promise<WebResponse> {
  void request;
  try {
    return json_response({ contracts: seams.tool_registry_execution_contracts() });
  } catch (exc) {
    return json_response({ error: exc_str(exc) }, 500);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * §10 GET /api/images/{image_id}（源 2977–3007）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Serve a model-generated image from disk by id。docstring 2978–2990 的四条设计选择全部保留：
 * workspace **来自服务端不来自请求**；用 `web.FileResponse`（sendfile + Range，不整图进内存）；
 * `immutable` 安全因为 id 每次 save 是新 uuid；id 校验与 symlink 逃逸检查交给 `image_store.resolve`，本 handler 保持笨。
 * S3-B7：import 与 `request.app[ROUTER_KEY]` 都不在 try → 缺键 KeyError / 缺属性 AttributeError 直接冒出（无 500）。
 * S3-B15：`Content-Disposition` 把 `path.name` **原样**塞进双引号（files 面才做 ASCII 清洗），且无尺寸/频率帽。
 */
export async function handle_get_image(
  request: WebRequest,
  seams: HttpS3Seams = HTTP_S3_SEAMS,
): Promise<WebResponse> {
  const router = request.app.state.require(ROUTER_KEY);          // 源 2994 `request.app[ROUTER_KEY]`
  const image_id = request.match_info.get("image_id", "");
  const path = seams.resolve_image(image_id, py_getattr(router, "workspace"));  // 源 2996 裸属性（无默认）
  if (py_is_none(path) || !py_truth(path)) {                   // 源 2997 `if not path:`：Path 实例恒真 ⇒ 只有 None/假对象才 404
    return json_response({ error: "image not found" }, 404);
  }
  const img = path as PyPathLike;                              // 走过 404 支后必非 None（D8：仍是 pathlib 面，不是 str）
  const headers = make_headers([
    ["Content-Type", py_str(seams.mime_for_path(img))],
    ["Cache-Control", "public, max-age=31536000, immutable"],
    ["Content-Disposition", `inline; filename="${py_str(py_getattr(img, "name"))}"`],   // 源 3005 f-string
  ]);
  return file_response(py_fspath_str(img), headers);           // 源 3000：FileResponse 吃 Path 本身
}

/* ──────────────────────────────────────────────────────────────────────────
 * §11 路径准入门（源 3067–3193）—— ⚠️ 安全门，白名单语义逐字保留
 * ──────────────────────────────────────────────────────────────────────── */

/** 源 3067–3077 `cua_shots_dir`（= `~/.ovolve/cua_shots`）。保持函数而非常量以便测试重定向；S3-B6：except 吞成 ""。 */
export function cua_shots_dir(seams: HttpS3Seams = HTTP_S3_SEAMS): string {
  try {
    return os_path_join(py_str(seams.user_home_dir()), "cua_shots");   // 源 3075 **确实**有 str()
  } catch {
    return "";
  }
}

/** 源 3080–3088 `preview_allowed_roots`：只从**服务端态**派生，永不读请求。顺序 = [workspace, shots]。 */
export function preview_allowed_roots(
  workspace: unknown,
  seams: HttpS3Seams = HTTP_S3_SEAMS,
): unknown[] {
  const roots: unknown[] = [];
  if (py_truth(workspace)) roots.push(workspace);
  const shots = cua_shots_dir(seams);
  if (py_truth(shots)) roots.push(shots);
  return roots;                                                  // 空表 ⇒ S3-B13：一切皆 traversal
}

/** 源 3091–3099 `_user_home`：**真实**家目录（不是 `~/.ovolve` 数据根）；注释 3092–3098 专述此别（S3-B6）。 */
export function _user_home(seams: HttpS3Seams = HTTP_S3_SEAMS): string {
  return seams.expanduser_home();                                // 源 3099 os.path.expanduser("~")
}

/** resolve_local_media_path 的返回面（python 的 `tuple` → `[real|null, reason]`）。 */
export type ResolveMediaResult = [string | null, string];

/**
 * 源 3102–3193 `resolve_local_media_path`。返回 `(real, "")` 或 `(None, reason)`，
 * reason ∈ `empty` / `traversal` / `not-media` / `not-found` / `too-large`（docstring 3109–3111）。
 * 纯字符串/FS 逻辑、不碰 request，所以探针直接打这里。
 *
 * **判定顺序即语义**（一条都不能挪、不能加、不能"顺手补强"）：
 *   1. `path = (raw or "").strip()` —— 按 CPython isspace 裁两端（F5：0x1c–0x1f 也裁）；裁后为空 → `empty`。
 *   2. `startswith("file://")`（**大小写敏感**，S3-B11）→ 先 unquote **恰好一次**，让下面的形状门跑在解码后的字节上
 *      （`%00` 不能当文本溜过去）；那条 except 在 CPython 里不可达（S3-B17）。
 *   3. `any(ord(ch) < 32)` → `traversal`。
 *   4. 残留 `%XX`（`_PCT_ESCAPE_RE.search`）→ `traversal`：**永不解第二次**（双编码 fail closed，3141–3146）。
 *   5. `\`→`/` 全量归一；`startswith("//")`（UNC `\\server\share`、设备路径 `\\.\PhysicalDrive0`）→ `traversal`。
 *   6. `/D:/x` → `D:/x`（源 3152–3154，`lead.group(2) or "/"`）；必须在冒号门**之前**，否则盘符冒号被当 ADS 冒号。
 *   7. 源 3157–3159：`^([A-Za-z]:)(.*)$` 匹配后，`group(2)`（未匹配时是**整串**）里**任何**冒号 → `traversal`
 *      （NTFS ADS `shot.png:ads` 死在这）。随后 3160–3161 是一次**恒等重写**（S3-B2）。
 *   8. `~` / `~/…` → `_user_home()` 展开（`~user` 不展开，S3-B9；裸 `~` 出白名单，S3-B12）；
 *      `elif not isabs and workspace` → 相对 workspace（源注释 3169–3170；异盘输入会让这条承诺失效，见 S3-B14）。
 *   9. `path_guard.real_path`（symlink/junction 归一，与写守卫共用）→ 对**真实路径**重做 `is_within` 白名单（3178–3180）。
 *      空 roots ⇒ `any([])` ⇒ False ⇒ 全拒（S3-B13）。大小写不敏感与"兄弟前缀不算内含"都在 path_guard 那个单元里。
 *  10. `splitext(...)[1].lstrip(".").lower()` 成员检查（3182–3184）→ `not-media`。
 *  11. `isfile`（3185）→ `not-found`；`getsize`（OSError 族 → `not-found`，3187–3190）；`size > cap` → `too-large`。
 *  12. 成功返回 **`real`**（解析后的真实路径，不是入参）。
 *
 * ⚠️ 没有 `..` 检查（S3-B10）：不要"补"一条，源的遍历拦截全部落在第 9 步。
 */
export function resolve_local_media_path(
  raw: unknown,
  workspace: unknown,
  allowed_roots_in?: unknown[] | null,
  seams: HttpS3Seams = HTTP_S3_SEAMS,
): ResolveMediaResult {
  const allowed_roots: unknown[] = py_is_none(allowed_roots_in)
    ? preview_allowed_roots(workspace, seams)
    : (allowed_roots_in as unknown[]);

  let path = py_strip_or(raw);
  if (!py_truth(path)) return [null, "empty"];
  if (path.startsWith("file://")) {
    try {
      path = py_unquote(path.slice("file://".length));   // 源 3126：一次，且只一次
    } catch {
      return [null, "traversal"];                        // 源 3127–3128：不可达臂（S3-B17）
    }
  }
  if (py_any_control(path)) return [null, "traversal"];
  if (_PCT_ESCAPE_RE.test(path)) return [null, "traversal"];
  path = path.split("\\").join("/");
  if (path.startsWith("//")) return [null, "traversal"];
  // /D:/x → D:/x（在冒号门之前）
  const lead = RE_LEAD.exec(path);
  if (lead) {
    path = (lead[1] as string) + (py_truth(lead[2]) ? (lead[2] as string) : "/");
  }
  // 单盘符冒号之外的任何冒号（ADS）→ 拒
  const drive = RE_DRIVE.exec(path);
  const colon_scope = drive ? (drive[2] as string) : path;
  if (colon_scope.includes(":")) return [null, "traversal"];
  if (drive) {
    path = (drive[1] as string) + (drive[2] as string);   // S3-B2：恒等重写，逐字保留
  }

  if (path === "~" || path.startsWith("~/")) {
    const rest = py_lstrip_chars(path.slice(1), "/");
    path = py_truth(rest) ? os_path_join(_user_home(seams), rest) : _user_home(seams);
  } else if (!os_path_isabs(path) && py_truth(workspace)) {
    path = os_path_join(py_path_str(workspace, "join"), path);   // F10/F1：异盘 ⇒ 丢弃 workspace（S3-B14）
  }

  const real = seams.path_guard_real_path(path);
  if (!allowed_roots.some((root) => seams.path_guard_is_within(real, root))) {
    return [null, "traversal"];                          // any([]) == False（S3-B13）
  }

  const ext = py_lstrip_chars(os_path_splitext(real)[1], ".").toLowerCase();
  // 用 hasOwnProperty 而非 JS `in`：`in` 会命中原型链，`constructor`/`toString` 会被当成白名单扩展名（源是 dict 成员检查）
  if (!Object.prototype.hasOwnProperty.call(MEDIA_MIME_BY_EXT, ext)) return [null, "not-media"];
  if (!seams.file_isfile(real)) return [null, "not-found"];
  let size: number;
  try {
    size = seams.file_getsize(real);
  } catch (exc) {
    if (exc instanceof PyOSErrorP) return [null, "not-found"];  // except OSError（族捕获，子类也算）
    throw exc;
  }
  if (size > MAX_MEDIA_FILE_BYTES) return [null, "too-large"];
  return [real, ""];
}

/* ──────────────────────────────────────────────────────────────────────────
 * §12 媒体限速（源 3196–3209）
 * ──────────────────────────────────────────────────────────────────────── */

/** 源 3196–3204：滑动窗口每分钟帽；事件循环单线程 → 无锁（docstring 3197）。S3-B8：`> 60` 严格 + 拒绝不记账。 */
export function _media_file_rate_ok(seams: HttpS3Seams = HTTP_S3_SEAMS): boolean {
  const now = seams.now();
  while (_file_req_times.length > 0 && now - (_file_req_times[0] as number) > 60) {
    _file_req_times.shift();                             // 源 pop(0)
  }
  if (_file_req_times.length >= MEDIA_RATE_PER_MIN) return false;   // 命中上限 ⇒ **不 append**
  _file_req_times.push(now);
  return true;
}

/** 源 3207–3209 `_reset_media_file_rate`：测试钩子，`list.clear()` 的 in-place 清空（保留数组身份，F12）。 */
export function _reset_media_file_rate(): void {
  _file_req_times.length = 0;
}

/* ──────────────────────────────────────────────────────────────────────────
 * §12b 探针用的纯函数出口（不参与业务逻辑；只为把 §2 的 ntpath/urllib 复刻
 *      与 CPython 逐字对拍 —— 差分脚本 tmp/w218_s3_diff.mjs 消费这一段）
 * ──────────────────────────────────────────────────────────────────────── */

/** `ntpath.join(a, b)`（F1 的回归面）。 */
export function ntpath_join_for_probe(a: string, b: string): string { return os_path_join(a, b); }
/** `ntpath.isabs(s)`。 */
export function ntpath_isabs_for_probe(s: string): boolean { return os_path_isabs(s); }
/** `ntpath.splitext(p)` → `[root, ext]`。 */
export function ntpath_splitext_for_probe(p: string): [string, string] { return os_path_splitext(p); }
/** `ntpath.basename(p)`。 */
export function ntpath_basename_for_probe(p: string): string { return os_path_basename(p); }
/** `str.strip()`（CPython isspace 全集，F5）。 */
export function py_strip_for_probe(s: string): string { return py_strip(s); }
/** `urllib.parse.unquote(s)`（逐 ASCII 段解码，F3）。 */
export function py_unquote_for_probe(s: string): string { return py_unquote(s); }
/** `urllib.parse.quote(s)`（strict 编码，lone surrogate 抛 UnicodeEncodeError，F4）。 */
export function py_quote_for_probe(s: string): string { return py_quote(s); }

/** 只给探针：与 `_file_req_times` 同一对象（源里测试直接看模块全局；端口 const 不可重绑，只能 mutate）。 */
export function media_file_rate_window_for_probe(): readonly number[] {
  return _file_req_times;
}

/* ──────────────────────────────────────────────────────────────────────────
 * §13 GET /api/files（源 3212–3256）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Serve a whitelisted local media file for inline preview（docstring 3213–3221）。
 * 只读构造（GET via web.get，无 POST/PUT）、token 门与其他 /api 路由一致、全部
 * 白名单/遍历/扩展/尺寸决策都在 `resolve_local_media_path` 里 —— 本 handler **只把 reason 映射成状态码**，
 * 形状跟随 `handle_get_image`。错误体从不回显解析后的路径（3220）。
 *
 * 判定顺序即语义（S3-B16）：
 *   · 限速先跑（3222）→ 429，**在碰 router 之前**：被限流的请求不读 app 状态，429 也压过 400。
 *   · `request.app[ROUTER_KEY]`（3225，缺键 → KeyError 冒出 handler，无 500 兜底）。
 *   · `workspace = getattr(router, "workspace", "") or ""`（3226，**有默认**，与 §10 的裸属性不同；F10 不 str()）。
 *   · resolve（不传 allowed_roots ⇒ 源 3115–3116 走 `preview_allowed_roots(workspace)`）。
 *   · reason 映射：empty→400、traversal→403、not-media→403、not-found→404、too-large→413；
 *     源是一串互斥 `if`，`err == ""` 才落到成功支。
 *   · 成功：ASCII 回退名 + RFC 5987 双 filename；svg 额外叠 CSP 沙盒（只管直接导航那一例，`<img>` 忽略 document-CSP）。
 */
export async function handle_get_file(
  request: WebRequest,
  seams: HttpS3Seams = HTTP_S3_SEAMS,
): Promise<WebResponse> {
  if (!_media_file_rate_ok(seams)) {
    return json_response({ error: "too many file requests" }, 429);
  }

  const router = request.app.state.require(ROUTER_KEY);
  const workspace = py_or(py_getattr_or(router, "workspace", ""), "");   // 源 3226：不 str()（F10）
  const [resolved, err] = resolve_local_media_path(request.query.get("path", ""), workspace, null, seams);
  if (err === "empty") return json_response({ error: "path query parameter required" }, 400);
  if (err === "traversal") return json_response({ error: "path outside allowed roots" }, 403);
  if (err === "not-media") return json_response({ error: "file type not previewable" }, 403);
  if (err === "not-found") return json_response({ error: "file not found" }, 404);
  if (err === "too-large") return json_response({ error: "file too large to preview" }, 413);

  const p = py_fspath_str(resolved);                     // 成功支里 resolved 必为 str（见 §11 第 12 步）
  const ext = py_lstrip_chars(os_path_splitext(p)[1], ".").toLowerCase();
  const name = os_path_basename(p);                      // 源 3240：ntpath.basename（≠ Path.name，见 D8）
  // ASCII 回退 + RFC 5987：聊天文件名常非 ASCII（源 3241–3248）。
  // 逐码点（F4/代理对安全）：`32 < ord < 127 且不是 " 或 \` 才保留，否则一个 "_"。
  const safe_ascii = py_join_map(name, (ch, cp) => (cp > 32 && cp < 127 && ch !== '"' && ch !== "\\" ? ch : "_"));
  const header_pairs: Array<[string, string]> = [
    ["Content-Type", py_map_index(MEDIA_MIME_BY_EXT, ext) as string],       // F11：源 3244 是 dict 下标
    ["Content-Disposition", `inline; filename="${safe_ascii}"; filename*=UTF-8''${py_quote(name)}`],
    ["Cache-Control", "private, max-age=300"],
    ["X-Content-Type-Options", "nosniff"],
  ];
  if (ext === "svg") {
    header_pairs.push(["Content-Security-Policy", "default-src 'none'; sandbox"]);
  }
  return file_response(p, make_headers(header_pairs));
}

// PORT STATUS: 本文件无 TODO(port)。
