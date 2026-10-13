/**
 * http_server_s6.ts — 单元 218 `app/backend/server/http_server.py`（8819 源行）的 **段 S6**。
 * 分段方案 `tmp/w218_SEGMENTS.md` · 契约表 `tmp/w218_SURFACE.md`（本段 = 其 §S6 的 29 行）·
 * 镜像层单一来源 keys.ts §M（上收符号以 `node tmp/lead_mirror_single_source_check.mjs s6` 现查为准，
 *   本文件**全部 import，零私有副本**）。
 * 风格母版：已落地的 S3（`http_server_s3.ts`）与 lead 验收过的 S5 草稿（`tmp/w218_s5_draft/http_server_s5.ts`）——
 *   seam 对象 + fail-closed 缺省 + CPython 异常镜像**从 keys.ts import**（本段**不带**任何镜像层副本）。
 *
 * 覆盖源区间 **4577–5547**（设置 / 模型 / 工具 / subagent / 回滚 / 检查点 / 事件 / 会话日志 / 用量 handler 簇）：
 *   4577–4581  _config_path                （模块级 helper，读 SERVER_STATE._CONFIG_PATH）
 *   4584–4590  _persist_config             （模块级 helper，open+json.dump+os.replace ⇒ FS seam）
 *   4593–4609  _redact                     （模块级 helper，copy.deepcopy + 掩码）
 *   4612–4617  handle_get_settings         GET    /api/settings                #66
 *   4620–4648  handle_permission_rules_list GET   /api/permissions/rules        #68
 *   4652–4679  handle_permission_rule_create POST  /api/permissions/rules        #69  (except Exception -> 400 invalid json)
 *   4682–4685  handle_permission_rule_delete DELETE /api/permissions/rules/{rule_id} #70 (match_info **下标** = KeyError)
 *   4688–4696  handle_models_list          GET    /api/models                  #76
 *   4699–4711  handle_models_resolve       GET    /api/models/resolve          #77
 *   4714–4757  handle_models_sync_providers POST  /api/models/providers         #78  (except JSONDecodeError -> 400)
 *   4760–4945  handle_update_settings      PUT    /api/settings                #67  (B4 家族：except JSONDecodeError)  ← S6b 已落地
 *   4948–4967  handle_get_tools            GET    /api/tools                   #79  ← S6c 已落地
 *   4980–5033  handle_subagents_list       GET    /api/subagents               #83  ← S6c 已落地
 *   5036–5057  handle_subagent_kill        POST   /api/subagents/{id}/kill      #87  ← S6c 已落地
 *   5060–5087  handle_subagents_kill_all   POST   /api/subagents/kill-all       #86  ← S6c 已落地
 *   5090–5097  handle_subagent_types       GET    /api/subagents/types          #84  ← S6c 已落地
 *   5101–5212  handle_subagent_type_update PATCH  /api/subagents/types/{name}   #85  ← S6c 已落地 (yaml/tempfile/os.replace FS)
 *   5224–5235  handle_rollback_list        GET    /api/rollback                 #88  ← S6d 已落地
 *   5238–5251  handle_rollback_apply       POST   /api/rollback                 #89  ({**report} 解包)  ← S6d 已落地
 *   5262–5296  handle_checkpoints          GET    /api/checkpoints              #90  ← S6d 已落地
 *   5299–5311  handle_checkpoint_preview   GET    /api/checkpoints/preview      #91  ← S6d 已落地
 *   5314–5327  handle_checkpoint_label     POST   /api/checkpoints/label        #92  ← S6d 已落地
 *   5332–5345  handle_get_events           GET    /api/events/{sessionId}       #93  ← S6d 已落地
 *   5348–5355  handle_verify_event_chain   GET    /api/events/{sessionId}/verify #94 ({**res} 解包)  ← S6d 已落地
 *   5358–5367  handle_get_projected_state  GET    /api/events/{sessionId}/state #95  ← S6d 已落地
 *   5370–5390  handle_fork_at_seq          POST   /api/sessions/fork_at_seq     #96  (uuid4 seam)  ← S6d 已落地
 *   5393–5400  handle_get_session_log      GET    /api/sessions/{sessionId}/log #98  (web.Response text/plain)  ← S6d 已落地
 *   5403–5410  handle_get_session_transcript GET  /api/sessions/{sessionId}/transcript #99  ← S6d 已落地
 *   5413–5420  handle_get_session_log_info GET    /api/sessions/{sessionId}/log_info #100  ← S6e 已落地
 *   5430–5437  handle_artifacts            GET    /api/artifacts                #101  ← S6e 已落地
 *   5446–5452  _parse_range_days           （模块级 helper）                         ← S6e 已落地
 *   5455–5478  handle_usage_stats          GET    /api/usage/stats              #102  ← S6e 已落地
 *   5481–5534  handle_token_analytics      GET    /api/token-analytics          #103  ← S6e 已落地
 *
 * **计数**：29 条注册 / 29 个 handler（`handle_*`），另 4 个模块级 helper（`_config_path`/`_persist_config`/
 * `_redact`/`_parse_range_days`）。本段**不注册任何路由**（S10 装配）；SURFACE §S6 的 29 行 → 就是本文件的 29 个导出。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 源码自带死路 / 不一致：逐字复制、只标注不修（RULEBOOK §2 BUG 规则）。编号 S6-Bn：
 * S6-B1  4684 `request.match_info["rule_id"]` 是**下标**（缺键 KeyError），不是段内其余处的 `.get`。
 *        经路由注册该键必在 ⇒ 死路；端口 `match_info.index` 复刻（抛 PyKeyError）。
 * S6-B2  4660 "invalid json"（小写 j）vs 4735 "invalid JSON"（大写 J）——同类坏 body 两种文案，照抄。
 * S6-B3  函数级 import 位置一族两种姿势：#69（4654）import 在 json-try **之前**、#78（4744）import 在
 *        验参**之后**。端口 seam getter 各随其源 import 行放置（§D1），不统一。
 * S6-B4  4659 `except Exception` 把 request.json() 的**一切**异常吞成 400（无族过滤），而 #78（4734）
 *        只兜 JSONDecodeError——keys.ts B4 记录的"两套姿势并存"在 S6a 的实例。
 * S6-B5  4597 `model = safe.get("model") or {}`：falsy 支下 4600–4601 的改写落进临时 {} 即丢
 *        （该支下 `model.get("api_key")` 必为假值 ⇒ 改写不可达）。语义 no-op，照抄。
 * S6-B6  4602–4604 `entry.get("api_key")`：models 列表元素非 dict → AttributeError 冒出
 *        GET /api/settings（全函数无 try）。
 * S6-B7  4709 `dict(resolved.value)` 在任何 try 之外：value 非 mapping → TypeError 逃逸。
 * S6-B8  4661 toolName 双键收（toolName/tool_name），4671/4674/4675/4677 的 pattern/workspaceRoot/
 *        sessionId/note **只收 camel**；4676 `source="user"` 写死、body 的 source 被无视。键面不一致是源事实。
 * S6-B9  4768 `patch = await request.json()` 后**没有任何 isinstance 闸**：4774/4816/4840/4855/4909/4917/
 *        4928/4933 八处 `patch.get(...)` 落在 body 是 JSON 数组/字符串时 → AttributeError 冒出
 *        PUT /api/settings（全函数只有 4767/4788/4794/4801/4842/4862/4868/4878/4884/4896/4940 十一只 try，
 *        这些 `.get` 全在 try 之外）。同段 #78（4737）却先 `isinstance(body, dict)` ——两姿势并存（keys B4 家族）。
 * S6-B10 4817/4830/4841/4860/4876/4910/4923 的 `"k" in patch_x` **不校验类型**：patch_x 是 str 时 `in` 走
 *        **子串**、是 list 时走**成员**，紧接着 4823/4832/4843/4861/4911/4925 的 `patch_x["k"]` **下标**
 *        在 str/list 上是 TypeError（`string indices must be integers` / `list indices must be integers
 *        or slices, not str`）；4777 `model_patch.items()` 同理是 AttributeError。in-then-subscript 一族，
 *        源只在 dict 假设下写，端口照抄（py_contains + py_dict_index 复刻两侧文案）。
 * S6-B11 分支逐个 mutate 全局 `_CONFIG`（4776/4827/4833/4846/4857/4912/4919/4930/4937）且**无回滚**：
 *        后一分支坏掉（或 4941 落盘失败）时，前面分支的写入已经留在内存里且**不回滚**，而响应是 400/500
 *        而非"部分成功"——源没有事务。端口同位 mutate `SERVER_STATE._CONFIG`。
 * S6-B12 4778 只挡 `api_key` 一个键：GET /api/settings 回的是 `_redact` 产物（含 4601 写的
 *        `api_key_set: true`），UI 原样 PUT 回来 ⇒ 4780 把 `api_key_set` **写进** `_CONFIG["model"]`
 *        并在 4941 落盘。round-trip 只保住 api_key，没保住"不污染 config"这句 docstring 的语义。
 * S6-B13 4794–4797 的 `except TypeError` 只兜 TypeError ⇒ 4795 里 `llm.call` 的 **AttributeError**
 *        （llm 对象没有 `.call`）不被兜住、直接冒出 handler；反过来 getter 内部真抛的 TypeError 会被一起
 *        吞掉（宽度和"签名不匹配"这个本意不等价）。
 * S6-B14 4801–4808 的 `except Exception: pass` 罩住整条场景回调臂（4802 调用、4803/4804 下标、
 *        `.call` 取属性、`._llm=` 赋值），随后 4809–4813 的 router 改写与 4814 的 `applied.append("model")`
 *        **照常执行** ⇒ 响应报 "model 已应用"，但三个后台模块的场景回调没换。fail-open 面比"可选增强"更宽。
 * S6-B15 4888–4895 的 `r.compactor.<attr> = ...`（5 次属性写，floor_set 时 6 次；源里每条语句各自重新
 *        求值 `r.compactor`）在**任何 try 之外**：router 假件里
 *        `compactor` 缺失/为 None → AttributeError 冒出，此时 4857 起的 compaction 写入已落进 `_CONFIG`（S6-B11）。
 *        端口同样逐条重新 py_getattr（不缓存成一次读）⇒ getattr 次数与源一致（§D13）。
 * S6-B16 4884–4887 的 else 支把 `fl` 算出来（含 int() 与 try/except）**却从不使用**——floor_set 为假时
 *        4894/4904 两处都不写它。源里的死计算，照抄（它唯一的副作用是"坏值时把 fl 归 0"，同样不可观察）。
 * S6-B17 4898–4904 每条赋值语句**各自**调用 `get_compactor()`（5 次，floor_set 时 6 次），而 4889–4895
 *        的每-router 臂是每属性一次 `r.compactor` 读；单例获取**次数**是探针可观察面 ⇒ 照抄不合并。
 * S6-B18 同一件事两种容错：4896–4906 的全局 compactor 臂有 `except Exception: pass`，4888–4895 的
 *        per-router 臂完全没有（S6-B15）。
 * S6-B19 4919/4930/4937 的 `dict.update(patch_x)`：patch_x 非 mapping（list/str/int）→ CPython 抛
 *        ValueError/AttributeError，三支都在 try **之外** ⇒ 逃逸（4937 的实参是 4936 seam 的返回值，
 *        类型由 shadow_config 假件决定，端口同样交给 py_dict_update 抛）。
 * S6-B20 `applied` 的去重只做了一处：4835 的 `if "permissions" not in applied`。4814/4829/4850/4907/
 *        4915/4926/4931/4938 八个分支一律**无条件 append** ⇒ 同一分支若可达两次就会重复（本函数每分支
 *        只走一次，所以今天不炸）；不一致是源事实，端口不补 Set。
 * S6-B21 4942 `except OSError as e` 是**窄兜**：4941 `_persist_config()` 里 `json.dump` 对不可序列化值抛
 *        TypeError/ValueError、`os.replace` 抛的非 OSError（如 PermissionError 之外的 RuntimeError）都会
 *        冒出 handler，不会变成 500 "could not persist"。500 那支只覆盖 OSError 族本身。
 * S6-B22 5111 `from storage import get_storage` 导入后**整函数从不使用**（源注释 noqa F401 明说：只为
 *        触发 app boot 的副作用）。端口同位调用 seam `storage_module()` 并丢弃返回值——getter 调用
 *        **次数**是探针可观察面，不省这一句。
 * S6-B23 5136–5149 的 `override` dict 全程构建（三处键写、含 5147 的 `max(1, int(max_turns))` 校验）
 *        却**从未被读过**——真正落盘的 `doc` 在 5163–5185 由 cur + patch 重新拼。`override` 唯一可观察
 *        效果是构建过程中的 422 早退。死计算照抄（5147 与 5185 是**两次** int() 求值，不合并）。
 * S6-B24 5122 `except Exception` **无族过滤**（request.json() 的一切异常都吞）但 400 文案是
 *        "invalid JSON"（大写 J）——#69 姿势（4659 全吞 + 小写 "invalid json"）与 #78 文案（4734 只兜
 *        解码族 + 大写 J）的**第三种混合**，S6-B2/S6-B4 家族的续支。端口照抄：catch-all ⇒ 400 "invalid JSON"。
 * S6-B25 5140（override 支）与 5183（doc 支）**各算一次** `str(model_policy).strip().lower()`——源不复用
 *        5140 的 `policy` 变量，5185 重算一遍。str/strip/lower 的**求值次数**是探针可观察面 ⇒ 两处照抄。
 * S6-B26 5224–5327 这一族里同一个 400 文案 "seq must be an integer" 由**两种不同判定**到达：
 *        query 侧（5229–5232 rollback_list、5303–5306 preview）走 `int()` + `except (TypeError, ValueError)`
 *        ⇒ `?seq=5` 合法；body 侧（5247–5248 rollback_apply、5323–5324 label）走 `isinstance(seq, int)`
 *        且**无 try** ⇒ `{"seq":"5"}` 直接 400、而 `{"seq": true}` **能过闸**（CPython bool ⊂ int）。
 *        两种姿势并存是源事实，端口不统一（bool 面见 §D24）。
 * S6-B27 5251 `{**report}`、5355 `{**res}`：report/res 非 mapping →
 *        `TypeError: argument after ** must be a mapping, not X`（两处都在任何 try **之外** ⇒ 冒 handler）；
 *        是 mapping 时其键**覆盖**左侧写死的 ok/sessionId/seq（CPython 与 JS 展开都是右侧胜、位置保持）。
 * S6-B28 四处 catch-all 无日志：5243–5244（apply）、5319–5320（label）、5375–5376（fork）的
 *        `except Exception: data = {}`（坏 body 连 400 都不给，静默按"没传字段"，S6-B24 同族）；
 *        5270–5271 的 `except Exception: turns = []` 把**整个 storage 侧**吞成空列表 ⇒ 时间线只剩孤儿快照。
 * S6-B29 5268–5272 容错**不对称**：只有 5269 `list_user_turns` 在 try 里；5272
 *        `get_snapshot_store().checkpoints(sid)` 与同行 `int(c["seq"])` 的**下标**都在 try 之外
 *        ——盘上快照侧坏掉直接冒 500，会话历史侧坏掉静默回空时间线。
 * S6-B30 5275 `by_seq.pop(...) or {}` 之后，同一个 snap 在一张字面量里有**三种取法**并存：
 *        5283–5285 用 `or 0`/`or []`/`or ""`、5288–5289 用 `bool(...) if snap else False`（对 snap 再判一次
 *        真值）。后果：快照行是**空 dict** 时 recoverable/folded 恒 False、files 恒 0（snap 已被换成 {}）。
 * S6-B31 5294–5295 的 orphans 行内：`int(s["seq"])` 是**下标**（缺键 KeyError 冒，无 try），
 *        `s.get("files")` 是 .get（缺键 → 0）——同一行两种键取法；整支在 turns 循环之后裸奔。
 * S6-B32 5338/5340/5342/5365/5384 的 `int(...)` **全在 try 之外** ⇒ `?to_seq=abc`、`?limit=x`、
 *        `?at_seq=` 直接 ValueError 冒 handler（对照 5230 的兜 400）——隔一行注释的同一族端点两种容错。
 * S6-B33 5340/5342/5365 用 `... is not None` 判定"有没有传"，而 5337/5353/5363/5379 用**真值**判定：
 *        `?to_seq=`（传了空串）在源里过 `is not None` ⇒ `int("")` 炸；`sessionId` 空串则被 or 判成"没传"。
 *        端口必须区分这两类（§D22 的 query 缺失哨兵面就是为 5339/5341/5364 三条建的）。
 * S6-B34 5379 `if not source_sid or fork_seq is None`：同一行里 source_sid 用真值（"" 非法）、
 *        fork_seq 用 `is None`（**0 合法**）；过闸的 fork_seq 到 5384 才 `int()`，坏类型 ⇒ 冒。
 * S6-B35 5389 `"forkPointSeq": fork_seq` 回填 **body 原值**（字符串 "3" 原样进响应），
 *        喂给存储层的却是 5384 的 `int(fork_seq)` ⇒ 响应值与写入值可以不同型（S6-B1 家族续支）。
 * S6-B36 键面一族两姿势：本批 query/match_info 一律 **camel** `sessionId`（5227/5265/5302/5335…）、
 *        body 一律 **snake** `session_id`/`source_session_id`/`new_session_id`/`from_seq`/`to_seq`/`at_seq`，
 *        响应却又 camel（`sessionId`/`forkPointSeq`）；对照 5071 kill-all 的 body 用 snake `session_id`。
 *        照抄不统一（S6-B8 家族续支）。
 * S6-B37 5419–5420：`info = get_storage().get_session_log_info(sid)` 之后 `web.json_response(info)`
 *        把 store 返回值**原样**当整个响应体——本段唯一"响应体不是 handler 构造的 dict"的一处
 *        （None/list/str 都会成为 JSON 顶层）；源不验形状、不验 None。同函数与 #98/#99 同姿势：
 *        5415 的 import 在 sid 判定**之前** ⇒ 400 也先吃一次 storage 模块 import。
 * S6-B38 5430–5437 一族三处不一致：① 5433 的 sid 是本段唯一的 query **snake→camel→router** 三级
 *        or 链（对照 5227 只有 query+router 两级）；② 400 文案 "no session" 是 S6 第三种
 *        （对照 5418 的 "sessionId is required"、5380 的长文案）；③ 5436 的 `artifact_index`
 *        import 在 400 闸**之后**（对照 5415 在之前）⇒ 同一段里 import 位置两姿势（S6-B3 家族续支）。
 * S6-B39 5437/5458/5513 用的是 `router.storage`（router **属性**面），而段内其余八处 storage 走
 *        `get_storage()` 模块单例（4996/5111/5267/5334/5350/5360/5372/5395/5405/5415）⇒ 同一份存储
 *        两条取用路径并存。端口同一个 `StorageApi` 类型、两条访问路径（缝 getter vs py_getattr），
 *        故"走了哪条"在探针里仍是可观察面。
 * S6-B40 5446–5452 `_parse_range_days` 三种坏输入三种结果：缺键或 `abc` ⇒ 30（5451 兜）、
 *        `9999` ⇒ 365、`-5` ⇒ 1（5452 钳位）。且 5450 只兜 (TypeError, ValueError) ⇒ 传入非
 *        str/int 时 `int()` 的 TypeError 也在兜内；但 query 值恒为 str，实际只有 ValueError 可达。
 * S6-B41 5455–5478 `handle_usage_stats` **整函数零 try**：5456 的 app 下标、5458 的 router.storage、
 *        5459/5474/5475/5477 的存储调用、5467 的 by_model 迭代、5468 的 `m.get`、5469 的 `src[k]=v`
 *        任一坏 ⇒ 直接冒 handler；对照 5495–5533 的整块 catch-all ⇒ 同一"Usage analytics"横幅下
 *        两种容错姿势（#102 全裸、#103 全兜）。
 * S6-B42 5465–5466 是"能力探测"式弱依赖：`getattr(router.models, "provider_label", None)` 的默认值
 *        只兜**第二个**名字 ⇒ models 没有 provider_label 时整条标签臂**静默跳过**（响应里根本
 *        没有 provider_label 键，客户端各自兜），而 `router.models` 本身缺失是 AttributeError 直冒。
 *        `if callable(_label)` 是第二道闸：属性在但不可调（例如被写成字符串）同样整支跳过。
 * S6-B43 5468 与 5470 的 `m.get("sources") or []` 在**同一个 m** 上算两次（源不复用循环变量，
 *        S6-B25 同族）；5469 把标签写进**元素** src、5471 才把首个元素的标签写到 **m** 上，
 *        并且**只在 len(sources) == 1 时**（多 provider 给空串）⇒ 单源才有顶层标签。
 * S6-B44 5471 是 `sources[0]["provider_label"]` 两层下标（列表 0 + dict 键）：len==1 保证 0 存在，
 *        但元素若非 dict，前一行 5469 的 `src[k]=v` 已经先死（S6-B10 的 in-then-subscript 家族）。
 * S6-B45 5477 的 `limit=30` 写死、`days` 用钳位后的值，与 5459/5474/5475 共用同一个 days
 *        （钳位一次、四处共用）⇒ `_parse_range_days` 只被调用**一次**（5457），是探针面。
 * S6-B46 5493 的 `await _router_for_request(request)` 在 try **之外**（try 从 5495 起）⇒ router
 *        解析自身失败直接冒 handler；同函数 5495–5533 却是 catch-all fail-open（B41 的另一半）。
 * S6-B47 5488–5489 的 `get_token_analytics()` 先于 5493 ⇒ router 解析冒错时单例**已被取过一次**
 *        （模块 getter + 单例调用的次数都是可观察面，端口保持）。
 * S6-B48 5513 的 `hasattr(router, "storage")` 与紧随其后的 `router.storage` 是**两次**属性读；
 *        hasattr 只吞 AttributeError ⇒ storage 若是 property 且内部抛别的异常，异常照冒
 *        （在 5495 的 try 内 ⇒ 又被整支吞掉，fail-open 把形状问题洗成"没变化"）。
 * S6-B49 5514 的两条件 or：`getattr(m, "role", "") == "user"` 对 **dict 行恒假**（dict 没有 .role
 *        属性 ⇒ 走默认 ""），第二条 `isinstance(m, dict) and m.get("role") == "user"` 才对 dict 生效
 *        ⇒ 整句是"对象行 or 字典行"两种存储形状并存，写成 or 而非分支。
 * S6-B50 5524 的 `snap.get("breakdown", {})` 默认值**只在缺键时**生效：快照里写过
 *        `"breakdown": null` ⇒ `.get("tools")` 抛 AttributeError → 被 5532 吞 ⇒ else 支整个 update
 *        不执行（数据形状问题被静默）。
 * S6-B51 5524 的括号是 `(not tools and tool_tokens > 0) or used == 0` ⇒ `used == 0` **单独**就能
 *        触发 update（哪怕 breakdown.tools 已有值）；反过来 tools 有值且 used≠0 时**永不** update
 *        ⇒ system_prompt 变化后缓存不再刷新（源注释 5505–5507 只解释了空会话那一半）。
 * S6-B52 5532–5533 `except Exception: pass`（源注释自陈 fail-open），而 5508–5512 的源注释自己写明
 *        这就是历史上 popover 恒读 0 的成因（旧代码调了不存在的 `storage.get_session_messages`）；
 *        5534 无论成败都回一个 snapshot ⇒ 失败支回的是全零快照。照抄不修。
 * S6-B53 源 5440–5445 的横幅注释自称 "One endpoint, one payload"，可同一横幅下面挂了 **两条**
 *        路由（#102 usage/stats 与 #103 token-analytics），且 #103 的 docstring 又自带一套
 *        "dashboards want everything at once" 的理由 ⇒ 注释与实际路由数不符是源事实，照抄不修。
 * （S6 段五批到此结束：B1…B53 已全部落盘。）
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DIVERGENCE(port): 见文件尾 §D。
 */

import {
  json_response,
  text_response,
  py_int,
  py_float,
  py_or,
  py_str,
  py_truth,
  py_type_name,
  py_is_none,
  py_repr,
  py_dict_get,
  py_getattr,
  py_getattr_or,
  py_iter,
  py_map_index,
  py_strip,
  py_strip_or,
  py_path_str,
  os_path_join,
  os_path_split,
  exc_str,
  PyExcP,
  ModuleNotFoundErrorP,
  PyKeyError,
  PyAttributeErrorP,
  PyTypeErrorP,
  PyOSErrorP,
  SERVER_STATE,
  ROUTER_KEY,
  SESSION_HOST_KEY,
  type JsonDict,
  type WebRequest,
  type WebResponse,
} from "./http_server_keys.js";

/* ──────────────────────────────────────────────────────────────────────────
 * §0 私有 helper（keys.ts §M **未提供**的那部分；全部登记为"私有镜像候选"，
 *     STATE 文件逐条给理由。绝不与 §M 的上收符号重名/重实现（计数现查，见文件头）。）
 * ──────────────────────────────────────────────────────────────────────── */

/** 端口侧的"python dict"：非 null 的对象，且不是 list / bytes / Set。 */
function is_pydict(v: unknown): v is JsonDict | Map<unknown, unknown> {
  if (v === null || v === undefined) return false;
  if (typeof v !== "object") return false;
  if (Array.isArray(v) || v instanceof Uint8Array || v instanceof Set) return false;
  return true;
}

/** `isinstance(x, dict)`（源 4737/4739/4740/4741 —— sync_providers 的类型闸门）。 */
function py_isinstance_dict(v: unknown): boolean {
  return is_pydict(v);
}

/** `len(s)`（str 按码点）。源 4600 `len(key) > 12`。 */
function py_len(v: unknown): number {
  if (typeof v === "string") return Array.from(v).length;
  if (Array.isArray(v)) return v.length;
  if (v instanceof Map || v instanceof Set) return v.size;
  if (v instanceof Uint8Array) return v.length;
  if (is_pydict(v)) return Object.keys(v as JsonDict).length;
  throw new PyTypeErrorP(`object of type '${py_type_name(v)}' has no len()`);
}

/** `s[:n]`（码点前缀）。源 4600 `key[:6]`。 */
function py_head(s: string, n: number): string {
  return Array.from(s).slice(0, n).join("");
}

/** `s[-n:]`（码点后缀）。源 4600 `key[-4:]`。 */
function py_tail(s: string, n: number): string {
  const cp = Array.from(s);
  return cp.slice(cp.length - n).join("");
}

/** `"…" in str(value)`（源 4778）——按码点子串。 */
function py_substr(haystack: string, needle: string): boolean {
  return haystack.indexOf(needle) !== -1;
}

/** `d.items()`：非 dict → AttributeError（文案里是 'items'）。源 4777 `model_patch.items()`。 */
function py_dict_items(target: unknown): Array<[string, unknown]> {
  if (!is_pydict(target)) throw new PyAttributeErrorP(target, "items");
  if (target instanceof Map) {
    return [...target.entries()].map(([k, v]) => [k, v] as [string, unknown]);
  }
  const out: Array<[string, unknown]> = [];
  for (const k of Object.keys(target)) out.push([k, (target as JsonDict)[k]]);
  return out;
}

/** `list(d)` / `for k in d`：dict→键、其余走 py_iter（与 §M 的 py_iter 组合，本 helper 只补"键快照"面）。 */
function py_dict_keys(target: unknown): string[] {
  if (target instanceof Map) return [...target.keys()].map((k) => String(k));
  if (is_pydict(target)) return Object.keys(target as JsonDict);
  return py_iter(target).map((k) => String(k));
}

/** `dict(resolved.value)` / `{**report}` 解包：非 mapping → `TypeError: ... mapping required`。 */
function py_dict_copy(value: unknown): JsonDict {
  if (value === null || value === undefined) {
    throw new PyTypeErrorP(`argument after ** must be a mapping, not NoneType`);
  }
  if (!is_pydict(value)) {
    throw new PyTypeErrorP(`argument after ** must be a mapping, not ${py_type_name(value)}`);
  }
  const out: JsonDict = {};
  for (const [k, v] of py_dict_items(value)) out[String(k)] = v;
  return out;
}

/** `sorted(rows, key=fn)`：**稳定**排序（python 的 sorted 稳定；JS sort 亦稳定，见 STATE D3）。 */
function py_sorted<T>(rows: readonly T[], key: (t: T) => readonly (string | number)[]): T[] {
  const idx = rows.map((_, i) => i);
  const decorated = idx.map((i) => [key(rows[i] as T), i] as [readonly (string | number)[], number]);
  decorated.sort((a, b) => {
    const ka = a[0];
    const kb = b[0];
    const n = Math.max(ka.length, kb.length);
    for (let j = 0; j < n; j += 1) {
      const x = ka[j];
      const y = kb[j];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return a[1] - b[1];
  });
  return decorated.map(([, i]) => rows[i] as T);
}

/** 一次 except 族判定要用的 python 类名集合（同 S5 D5 的 `py_exc_classes`，本段自带一份）。 */
function py_exc_classes(exc: unknown): string[] {
  const out: string[] = [];
  if (exc instanceof Error) {
    if (exc.name) out.push(exc.name);
    const lead = /^([A-Za-z_]*Error)\b/.exec(exc.message ?? "");
    if (lead && lead[1] !== undefined) out.push(lead[1]);
  }
  return out;
}

/** `except (A, B):` —— 族判定按 python 类名（对 keys.ts 跨模块异常同样有效）。 */
function catches_classes(exc: unknown, classes: readonly string[]): boolean {
  return py_exc_classes(exc).some((g) => classes.includes(g));
}

const VALUE_OR_TYPE_ERROR: readonly string[] = ["ValueError", "TypeError"];

/**
 * `json.JSONDecodeError`（源 4734/4769 用它兜 `await request.json()`）：
 * CPython 里它是 **ValueError 的子类**；族判定因此必须同时认出 "JSONDecodeError" 与 "ValueError"，
 * 否则 keys.ts/探针把解析失败装在 ValueError 文案里时本段兜不住（见 STATE D5）。
 */
class PyJSONDecodeErrorP extends PyExcP {
  constructor(message: string) {
    super("JSONDecodeError", message);
  }
}
const JSON_DECODE_OR_VALUE: readonly string[] = ["JSONDecodeError", "ValueError"];

/**
 * `ValueError`（keys.ts §M **没有**这一类；与 S5 同法自带一份——见 STATE"私有镜像候选"。
 * keys.ts 的 py_int/py_float 把 ValueError 装在 JS TypeError 的**文案前缀**里，族判定认前缀即可）。
 */
class PyValueErrorP extends PyExcP {
  constructor(message: string) {
    super("ValueError", message);
  }
}

/** `NameError`（自由名求值失败；S5 用镜像类，S6 若源有同类死路则复刻）。 */
class PyNameErrorP extends PyExcP {
  constructor(name: string) {
    super("NameError", `name '${name}' is not defined`);
  }
}

/**
 * `obj.attr = value`（setattr）：源 4810/4813 `router.llm = llm` / `router._base_llm = llm`、
 * 4848–4849 / 4889–4895 对每个 session router 的属性赋值、4914 `get_telemetry().enabled = val`、
 * 4898–4904 `get_compactor().threshold = ...`。端口侧这些接收者都是探针/装配注入的普通 JS 对象，
 * 直接赋值即可；keys.ts 无 setattr ⇒ 本段自带（STATE"私有镜像候选"）。
 */
function py_setattr(obj: unknown, name: string, value: unknown): void {
  if (py_is_none(obj) || (typeof obj !== "object" && typeof obj !== "function")) {
    throw new PyAttributeErrorP(obj, name);
  }
  (obj as JsonDict)[name] = value;
}

/** `d[k] = value`（dict 下标写）：源 4600/4604/4607–4608（_redact 就地改 safe）、4780 `current[key]=value`。 */
function py_dict_set(target: unknown, key: string, value: unknown): void {
  if (target instanceof Map) {
    target.set(key, value);
    return;
  }
  if (py_is_none(target) || typeof target !== "object" || Array.isArray(target)) {
    throw new PyAttributeErrorP(target, "__setitem__");
  }
  (target as JsonDict)[key] = value;
}

/**
 * `d.setdefault(k, {})`：缺键则写入默认并返回，**存在则原样返回**（源 4776/4827/4833/4846/4857/4912/
 * 4919/4930/4937 的 `setdefault("model"/"permissions"/"agent"/...` 全用 `{}` 当默认）。
 * keys.ts 无此面 ⇒ 本段自带（STATE"私有镜像候选"）。
 */
function py_setdefault(target: unknown, key: string, dflt: unknown): unknown {
  if (target instanceof Map) {
    if (!target.has(key)) target.set(key, dflt);
    return target.get(key);
  }
  if (py_is_none(target) || typeof target !== "object" || Array.isArray(target)) {
    throw new PyAttributeErrorP(target, "setdefault");
  }
  const rec = target as JsonDict;
  if (!Object.prototype.hasOwnProperty.call(rec, key)) rec[key] = dflt;
  return rec[key];
}

/**
 * `d.update(other)`：**按 other 的迭代顺序**把键写入 d（源 4919/4930/4937 memory/workspace/shadow）。
 * other 是 mapping ⇒ 逐键 py_dict_set（写入是**渐进**的：中途抛错时前面的键已落，与 CPython 同）。
 * other 不是 mapping ⇒ CPython 走"sequence of pairs"那条路：
 *   - 不可迭代（int/float/None）→ `ValueError: 'int' object is not a mapping`；
 *   - 可迭代但元素不是 2 元（str ⇒ 元素是单字符）→ `ValueError: dictionary update sequence
 *     element #0 has length 1; 2 is required`（S6-B19 的实测文案）。
 * keys.ts 无 update 面 ⇒ 本段自带（STATE"私有镜像候选"）。S6b 是它在本段的第一个消费者，
 * 两支文案按 4919/4930/4937 的可达输入补齐（tmp/w218_s6_typecheck/smoke/run_a.mjs 的 F7 钉住）。
 */
function py_dict_update(target: unknown, other: unknown): void {
  if (is_pydict(other)) {
    for (const [k, v] of py_dict_items(other)) py_dict_set(target, String(k), v);
    return;
  }
  let seq: readonly unknown[];
  try {
    seq = py_iter(other); // 非可迭代 ⇒ 走 "not a mapping" 文案（CPython 3.13 的 dict.update(1)）
  } catch {
    throw new PyValueErrorP(`'${py_type_name(other)}' object is not a mapping`);
  }
  for (let i = 0; i < seq.length; i += 1) {
    const el = seq[i];
    let n: number;
    try {
      n = py_len(el);
    } catch {
      n = -1;
    }
    if (n !== 2) {
      throw new PyValueErrorP(`dictionary update sequence element #${i} has length ${n}; 2 is required`);
    }
    const pair = py_iter(el);
    py_dict_set(target, py_str(pair[0]), pair[1]); // 元素是 str/bytes 时键走 str()（CPython 收任意 hashable，端口只到 str 面）
  }
}

/**
 * `copy.deepcopy(cfg)`（源 4596 _redact）：**递归**深拷贝，dict/list 逐层复制，标量原样。
 * 非容器原返回值（python 对 int/str/bool/None 返回同对象）。keys.ts 无 deepcopy ⇒
 * 本段自带（STATE"私有镜像候选"）。
 */
function py_deepcopy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => py_deepcopy(x));
  if (v instanceof Map) {
    const out = new Map<unknown, unknown>();
    for (const [k, val] of v.entries()) out.set(k, py_deepcopy(val));
    return out;
  }
  if (v instanceof Set) return new Set([...v].map((x) => py_deepcopy(x)));
  if (v instanceof Uint8Array) return v.slice();
  if (is_pydict(v)) {
    const out: JsonDict = {};
    for (const [k, val] of py_dict_items(v)) out[String(k)] = py_deepcopy(val);
    return out;
  }
  return v;
}

/**
 * `json.dump(cfg, f, indent=2, ensure_ascii=False)`（源 4589）：缩进 2、非 ASCII 原样。
 * keys.ts 只有无缩进的 `py_json_dumps`（且它未 export 到 §M 名单外时不可依赖），故本段自带 indent 版；
 * 序列化结果只在 seam `fs_write_text` 的观察面里出现，探针比对磁盘内容时用它。
 */
function py_json_dump_indent2(v: unknown): string {
  const seen = new WeakSet<object>();
  const enc = (x: unknown, ind: number): string => {
    const pad = " ".repeat(ind);
    const pad2 = " ".repeat(ind + 2);
    if (x === null || x === undefined) return "null";
    if (typeof x === "boolean") return x ? "true" : "false";
    if (typeof x === "number") {
      if (!Number.isFinite(x)) throw new PyValueErrorP(`${py_float_repr_local(x)} is not JSON serializable`);
      return Number.isInteger(x) ? String(x) : py_float_repr_local(x);
    }
    if (typeof x === "string") return json_quote_false_ascii(x);
    if (typeof x === "object") {
      if (seen.has(x as object)) throw new PyValueErrorP("Circular reference detected");
      seen.add(x as object);
      let out: string;
      if (Array.isArray(x)) {
        if (x.length === 0) return "[]";
        out = "[\n" + x.map((e) => pad2 + enc(e, ind + 2)).join(",\n") + "\n" + pad + "]";
      } else {
        const entries: Array<[string, unknown]> = py_dict_items(x);
        if (entries.length === 0) return "{}";
        out = "{\n" + entries.map(([k, val]) => pad2 + json_quote_false_ascii(k) + ": " + enc(val, ind + 2)).join(",\n") + "\n" + pad + "}";
      }
      seen.delete(x as object);
      return out;
    }
    return json_quote_false_ascii(py_str(x));
  };
  return enc(v, 0);
}

/** ensure_ascii=False 的字符串字面量（控制字符转义，其余原样）。 */
function json_quote_false_ascii(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

/** `repr(float)` 的极简面（只在 JSON 数字序列化里用；整数走 String，小数走最短十进制）。 */
function py_float_repr_local(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  return String(x);
}

/**
 * `os.path.dirname(p)` = `os_path_split(p)[0]`（keys.ts 有 os_path_split，无 dirname ⇒ 用一行组合，
 * 不算重实现 ntpath，STATE 里归为"对 §M 的组合"而非新镜像）。
 */
function os_path_dirname(p: string): string {
  return os_path_split(p)[0];
}

/** 把 `unknown` 当普通 JS 对象做属性赋值（router/单例在端口侧都是探针注入的对象）。 */
function as_settable(obj: unknown): JsonDict {
  return obj as JsonDict;
}

/**
 * `key in container`（CPython 的 `__contains__` 分派）：dict→**键**、list/tuple→**成员**、
 * str→**子串**、Set→成员；其余 TypeError（`argument of type 'X' is not iterable`）。
 * S6-B10 那条 "in-then-subscript 一族" 的可执行面就在这里：源里 4817/4830/4841/4860/4876/4910/4923
 * 七处 `in` 全部**不带 isinstance 闸**，所以 patch 值是 str/list 时判定结论也要按源的语言出。
 * §M 无此面 ⇒ 本段自带（STATE"私有镜像候选"，同 S5 的 py_contains 形状）。
 */
function py_contains(container: unknown, key: unknown): boolean {
  if (Array.isArray(container)) return container.some((el) => el === key);
  if (container instanceof Set) return [...(container as Set<unknown>)].some((el) => el === key);
  if (is_pydict(container)) {
    if (container instanceof Map) {
      for (const k of container.keys()) if (k === key) return true;
      return false;
    }
    return Object.prototype.hasOwnProperty.call(container, String(key));
  }
  if (typeof container === "string") {
    if (typeof key !== "string") {
      throw new PyTypeErrorP(`'in <string>' requires string as left operand, not ${py_type_name(key)}`);
    }
    return py_substr(container, key); // 子串面复用 §0 的码点实现，不另起一份 includes 语义
  }
  throw new PyTypeErrorP(`argument of type '${py_type_name(container)}' is not iterable`);
}

/**
 * `d[k]`（**下标读**，不是 `.get`）：dict 缺键 → `KeyError(repr(k))`（§M 的 PyKeyError）；
 * str → `TypeError: string indices must be integers, not 'str'`；list →
 * `TypeError: list indices must be integers or slices, not str`；其余 → not subscriptable。
 * 源 4823/4832/4843/4861/4911/4925 与 4803/4804/4805/4806 都是下标面（S6-B10/S6-B14），
 * §M 的 py_map_index 只建模 dict（F11），**不认 str/list 的 TypeError 文案** ⇒ 本段自带
 * （STATE"私有镜像候选"，同 S5 的 py_dict_index 形状，键面改用 §M 的 PyKeyError/py_repr）。
 */
function py_dict_index(target: unknown, key: string): unknown {
  if (is_pydict(target)) {
    if (target instanceof Map) {
      for (const [k, v] of target.entries()) if (k === key) return v;
      throw new PyKeyError(py_repr(key));
    }
    if (!Object.prototype.hasOwnProperty.call(target, key)) throw new PyKeyError(py_repr(key));
    return (target as JsonDict)[key];
  }
  if (typeof target === "string") throw new PyTypeErrorP("string indices must be integers, not 'str'");
  if (Array.isArray(target)) throw new PyTypeErrorP("list indices must be integers or slices, not str");
  throw new PyTypeErrorP(`'${py_type_name(target)}' object is not subscriptable`);
}

/**
 * `d.values()`：非 dict → `AttributeError: 'X' object has no attribute 'values'`。
 * 源 4847/4888 的 `..._sessions.values()`；迭代顺序 = dict 插入顺序（**不是** sorted，坑 2 口径）。
 * §M 的 py_iter 对 dict 给的是**键** ⇒ 本段自带 values 面（STATE"私有镜像候选"）。
 */
function py_dict_values(target: unknown): unknown[] {
  if (!is_pydict(target)) throw new PyAttributeErrorP(target, "values");
  if (target instanceof Map) return [...target.values()];
  const rec = target as JsonDict;
  return Object.keys(rec).map((k) => rec[k]);
}

/**
 * `except OSError as e:`（源 4942）——**OSError 及其子类**都算（PermissionError/FileNotFoundError/…）。
 * §M 的 `catches_classes` 只看类名字符串，认不出继承关系；keys.ts 里 `PyPermissionErrorP extends
 * PyOSErrorP` 是真继承 ⇒ 本段先 `instanceof PyOSErrorP`（子类天然命中），再按文案前缀兜住
 * "假件用普通 Error 装 `OSError: ...`" 的情形。keys.ts 无此面 ⇒ 自带（STATE"私有镜像候选"，见 §D12）。
 */
function catches_oserror(exc: unknown): boolean {
  return exc instanceof PyOSErrorP || catches_classes(exc, ["OSError"]);
}

/**
 * `obj.name()`——**零参绑定方法调用**的统一面：先 §M `py_getattr`（缺属性 → 与 CPython 同面的
 * AttributeError），再 callable 判定（属性在但不可调 → TypeError `'X' object is not callable`，
 * CPython 同类文案，端口近似面见 §D20），最后 `.call(obj)` 把接收者绑进去（python 绑定方法的
 * this 语义）。源 5096/5210/5211 的 `d.to_public()` 是本段唯一消费者——def 对象来自 seam、
 * 类型面是 unknown，没有既有接口可挂方法。keys.ts 无此面 ⇒ 自带（STATE"私有镜像候选"）。
 */
function py_call0(obj: unknown, name: string): unknown {
  const fn = py_getattr(obj, name);
  if (typeof fn !== "function") {
    throw new PyTypeErrorP(`'${py_type_name(fn)}' object is not callable`);
  }
  return (fn as (this: unknown) => unknown).call(obj);
}

/**
 * `d.pop(key, default)`：**读 + 删**（源 5275 `by_seq.pop(int(turn["seq"]), None)`）。
 * 键在 ⇒ 删掉并返回原值；键不在 ⇒ 有默认返回默认、**无默认抛 KeyError(repr(key))**
 * （源里没这一档，但 helper 按 CPython 的两面建，S6e 复用）。
 * 删除**保持剩余键的插入顺序**（CPython dict 与 JS Map 都是这个面）⇒ 这是本段
 * 把 `by_seq` 建成 Map 的理由之一（§D23）。§M 无 pop 面 ⇒ 自带（STATE"私有镜像候选"）。
 */
function py_dict_pop(target: unknown, key: string, dflt?: unknown): unknown {
  if (target instanceof Map) {
    if (!target.has(key)) {
      if (dflt === undefined) throw new PyKeyError(py_repr(key));
      return dflt;
    }
    const got = target.get(key);
    target.delete(key);
    return got;
  }
  if (!is_pydict(target)) throw new PyAttributeErrorP(target, "pop");
  const rec = target as JsonDict;
  if (!Object.prototype.hasOwnProperty.call(rec, key)) {
    if (dflt === undefined) throw new PyKeyError(py_repr(key));
    return dflt;
  }
  const got = rec[key];
  delete rec[key];
  return got;
}

/**
 * `isinstance(x, int)`（源 5247/5323 的 seq 闸门）。§M 只有 `py_is_none`，无 int 面 ⇒ 自带。
 * CPython 的两条要点都建模在这里：
 *  - **bool 是 int 的子类** ⇒ `isinstance(True, int)` 为真（S6-B26 尾注；端口同结论，见 §D24）；
 *  - float **不算** int（`isinstance(2.0, int)` 为假）——端口侧 JSON 数字不区分 int/float，
 *    只能按 `Number.isInteger` 近似，差异登记于 §D24（端口不可达支）。
 */
function py_isinstance_int(v: unknown): boolean {
  if (typeof v === "boolean") return true; // bool ⊂ int（CPython 继承关系）
  return typeof v === "number" && Number.isInteger(v);
}

/**
 * `request.query.get(name)`——**无默认**的那一面（源 5339/5341/5364）：CPython 的 MultiDict
 * 缺键回 `None`，而 §M 的 `QueryView.get(name, fallback?)` 把缺键折成 `""`（keys.ts 453 行
 * `fallback ?? ""`），于是端口分不出"没传"和"传了空串"——**恰恰是 5340/5342/5365 的
 * `is not None` 判定唯一依赖的区别**（S6-B33）。
 * 端口用"缺键回显哨兵"这个既有面把它还原回来：`get(name, SENTINEL)` 只在**缺键**时返回哨兵
 * （§M 契约 + S3/S5/探针假件都是这个面），因此
 *   哨兵 ⇒ null（= CPython None）、其它 ⇒ 原字符串（传了空串就是 ""）。
 * 不新增对 request 的取数面（§M 的 WebRequest 是穷尽实测表，keys.ts 383–390 行注释）。§D22。
 */
const QUERY_ABSENT = "\u0000__query_key_absent__";
function py_query_get(query: WebRequest["query"], name: string): string | null {
  const got = query.get(name, QUERY_ABSENT);
  return got === QUERY_ABSENT ? null : got;
}

/* ── S6e（源 5413–5547）新增的 §0 私有 helper：全部是 §M **没有**的面（闸二机器判定 dup=0）。 ── */

/**
 * `callable(x)`（源 5466 的 `if callable(_label):`）：CPython 认函数/方法/类，以及带 `__call__`
 * 的实例。§M 无此面 ⇒ 本段自带（STATE"私有镜像候选"，§D30）。
 */
function py_callable(v: unknown): boolean {
  if (typeof v === "function") return true;
  if (v === null || v === undefined || typeof v !== "object") return false;
  return typeof (v as { __call__?: unknown }).__call__ === "function";
}

/**
 * `f(*args)`——把**已经取到的可调用值**当函数调用（源 5469 的 `_label(...)`）。
 * 不绑接收者：`_label` 在源里是 `getattr(router.models, "provider_label", None)` 的产物，
 * 端口按 §D13 的"函数当值"口径调用（§D31 登记与 CPython 绑定方法的边界）。
 * 非可调用 → `TypeError: 'X' object is not callable`（CPython 同类文案）。
 */
function py_invoke(fn: unknown, args: readonly unknown[]): unknown {
  if (typeof fn === "function") return (fn as (...a: readonly unknown[]) => unknown)(...args);
  if (fn !== null && typeof fn === "object") {
    const call = (fn as { __call__?: unknown }).__call__;
    if (typeof call === "function") {
      return (call as (this: unknown, ...a: unknown[]) => unknown).call(fn, ...args);
    }
  }
  throw new PyTypeErrorP(`'${py_type_name(fn)}' object is not callable`);
}

/**
 * `obj.name(arg)`——py_call0 的**单参版**（同一族的自带面，理由同 §D20 末段：接收者来自
 * `request.app[ROUTER_KEY]`，类型面是 unknown，没有既有接口可挂方法）。
 * 先 §M `py_getattr`（缺属性 → 与 CPython 同面的 AttributeError），再 callable 判定，
 * 最后 `.call(obj, arg)` 绑接收者（python 绑定方法的 this 语义）。源 5496 的唯一消费者。
 */
function py_call1(obj: unknown, name: string, arg: unknown): unknown {
  const fn = py_getattr(obj, name);
  if (typeof fn !== "function") {
    throw new PyTypeErrorP(`'${py_type_name(fn)}' object is not callable`);
  }
  return (fn as (this: unknown, a: unknown) => unknown).call(obj, arg);
}

/**
 * `hasattr(obj, name)`（源 5513 的 `if hasattr(router, "storage")`）：**只吞 AttributeError**，
 * 其余异常照冒（CPython 3.x 面：描述符/getter 抛 ValueError 时 hasattr 不兜）。
 * 判定完全走 §M `py_getattr` ⇒ 与源同一套属性面（含 `__getattr__` 由假件自仿）。§M 无此面 ⇒ 自带（§D30）。
 */
function py_hasattr(obj: unknown, name: string): boolean {
  try {
    py_getattr(obj, name);
  } catch (exc) {
    if (!catches_classes(exc, ["AttributeError"])) throw exc;
    return false;
  }
  return true;
}

/**
 * `a + b`（源 5526 的 `sp_tokens + tool_tokens + skill_tokens`）。**不用 JS 原生 `+`**：
 * 原生会把 CPython 的 TypeError（`int + str`）静默换算成字符串拼接，从而**多出一次
 * update_from_usage 调用**（探针可观察面）。数/布尔按数值，str 与 str、list 与 list 按同类拼接，
 * 其余一律 `TypeError: unsupported operand type(s) for +: 'A' and 'B'`。§M 无算术面 ⇒ 自带（§D33）。
 */
function py_add(a: unknown, b: unknown): unknown {
  const num = (v: unknown): v is number => typeof v === "number" || typeof v === "boolean";
  if (num(a) && num(b)) return (Number(a) + Number(b)) as number;
  if (typeof a === "string" && typeof b === "string") return a + b;
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  throw new PyTypeErrorP(
    `unsupported operand type(s) for +: '${py_type_name(a)}' and '${py_type_name(b)}'`,
  );
}

/**
 * `a > b`（源 5524 的 `tool_tokens > 0`）。同理不用原生 `>`（JS 会把 `'5' > 0` 判真、
 * 把 CPython 的 TypeError 面洗掉）。数/布尔比数值，str 与 str 比码点序（JS 的 UTF-16 单元序
 * 与码点序在同域内同结论，登记近似），其余 TypeError（§D33）。
 */
function py_gt(a: unknown, b: unknown): boolean {
  const num = (v: unknown): v is number => typeof v === "number" || typeof v === "boolean";
  if (num(a) && num(b)) return Number(a) > Number(b);
  if (typeof a === "string" && typeof b === "string") return a > b;
  throw new PyTypeErrorP(
    `'>' not supported between instances of '${py_type_name(a)}' and '${py_type_name(b)}'`,
  );
}

/**
 * `x == <int 字面量>`（源 5524 的 `snap.get("used", 0) == 0`）。JS 的 `==` 会把 `null == 0`、
 * `'0' == 0` 判真，CPython 两者都是**假**；`True == 1` 在 CPython 是**真**。故自带（§D33）：
 * 只认 number（含 bool 换算 0/1）等值，其余一律假（None/str/dict/list 与 int 比较在 CPython
 * 走 `__eq__` 的默认假面；自定义 `__eq__` 的端口面由假件自己返回布尔结果，不经此 helper）。
 */
function py_eq_int(a: unknown, b: number): boolean {
  if (typeof a === "number") return a === b;
  if (typeof a === "boolean") return (a ? 1 : 0) === b;
  return false;
}


/* ══════════════════════════════════════════════════════════════════════════
 * §S6a/S6b/S6c 接缝（源 4577–4757、4760–4945 与 4948–5212 的外部世界）。
 *   S6d–S6e 的 seam 由后续批次**就地扩写本接口**（不再另立第二个 seams 对象）。
 *   函数级 `from M import f` 的建模：本段把"模块面"整体做成 getter——
 *   未接线即在被"import"的那一行抛 ModuleNotFoundErrorP，抛出点与源 import 语句同位
 *   （与 S5 D7 的"首用处放缝"是同一原则的两种落法：本段源 import 与首用**不同位**，
 *   缝按 import 行放置，见各 handler 注释与文末 §D1）。
 * ═════════════════════════════════════════════════════════════════════════ */

/** `get_permission_rules()` 单例的三面（源 4632 list / 4669 add / 4684 remove）。 */
export interface PermissionRuleApi {
  /** `.list(workspace_root=ws, session_id=sid)` → Rule 对象列表（属性面 id/tool_name/…/created_at）。 */
  list(opts: { workspace_root: string; session_id: string }): readonly unknown[];
  /** `.add(PermissionRule(...))` → **持久化后的 rule**（响应只读它的 `.id`，源 4679）。 */
  add(rule: unknown): unknown;
  /** `.remove(rule_id)` → bool（源 4684；假值 ⇒ 404）。 */
  remove(rule_id: string): unknown;
}

/** 源 4654–4656 `from permission_rules import PermissionRule, RuleBehavior, RuleScope, get_permission_rules`。 */
export interface PermissionRulesModule {
  get_permission_rules(): PermissionRuleApi;
  /** `PermissionRule(tool_name=…, pattern=…, …)`（源 4669–4678，kwargs 顺序照抄）。 */
  PermissionRule(opts: {
    tool_name: string;
    pattern: string;
    behavior: unknown;
    scope: unknown;
    workspace_root: string;
    session_id: string;
    source: string;
    note: string;
  }): unknown;
  /** `RuleBehavior(str)`（源 4665）：非法值 → ValueError（CPython Enum 调用文案，经 exc_str 出 400）。 */
  RuleBehavior(value: string): unknown;
  /** `RuleScope(str)`（源 4666）：同上。 */
  RuleScope(value: string): unknown;
}

/** 源 4690/4701/4744 `from model_registry import get_model_registry` → reg 的调用面。 */
export interface ModelRegistryApi {
  /** `reg.resolve()`（源 4692，**无参**）/ `reg.resolve(model)`（源 4706）→ 带 ok/value/error 的结果对象。 */
  resolve(model?: string): unknown;
  /** 源 4694。 */
  list_providers(): unknown;
  /** 源 4710。 */
  thinking_capability(model: string): unknown;
  /** 源 4748 → 带 ok/error 的结果对象。 */
  upsert_provider(provider_id: string, spec: unknown): unknown;
  /** 源 4753 `reg.prune_providers(synced)` → 被剪掉的 id 列表。 */
  prune_providers(kept: readonly unknown[]): unknown;
  /** 源 4790 `reg.seed_from_config(_CONFIG.get("model", {}))`（S6b 新增；在 try/except Exception 里，失败即 fail-open）。 */
  seed_from_config(model_cfg: unknown): void;
}

/**
 * 源 4793 那个 tuple 的成员类型：`(get_memory_layer, get_goal_manager, get_commit_message_generator)`
 * 在 python 里是**函数对象本身**进元组，随后 `getter(llm_callback=llm.call)` 统一按关键字调用。
 * 端口把"函数当值传"建模成函数类型**属性**（不是方法）——python 的模块函数没有 this 语义，
 * 用方法声明会让端口侧多出一层 `this` 绑定假设（S6b §D13）。
 * `opts` 整个参数**可选**（坑 1）：源 4804/4805/4806/4924 是 `get_memory_layer()` **零参**调用，
 * 端口同样省略实参，而不是传 `{}`/`undefined`——测"有没有回调"的行为面必须靠省略 key 触发。
 */
export type LlmCallbackGetter = (opts?: { llm_callback?: unknown }) => unknown;

/** 源 4925 `get_memory_layer().set_enabled(bool(...))`——源里是 async 方法，端口返回 promise 或非 promise（§D14）。 */
export interface MemoryLayerApi {
  set_enabled(enabled: boolean): unknown | Promise<unknown>;
}

/** 源 4782 `from llm_client import reset_llm_client, get_llm_client`。 */
export interface LlmClientModule {
  reset_llm_client(): void;
  /** `get_llm_client(_CONFIG)`（源 4787）：返回值只要带一个 `.call` 属性（4795/4804 消费）。 */
  get_llm_client(config: unknown): unknown;
}

/** 源 4783/4924 `from memory_layer import get_memory_layer`（**两条** import 语句 ⇒ 两次 getter）。 */
export interface MemoryLayerModule {
  get_memory_layer: (opts?: { llm_callback?: unknown }) => MemoryLayerApi;
}

/** 源 4784 `from goal_manager import get_goal_manager`（4805 只写 `._llm`，无方法面 ⇒ unknown）。 */
export interface GoalManagerModule {
  get_goal_manager: LlmCallbackGetter;
}

/** 源 4785 `from git_trust import get_commit_message_generator`（4806 同上）。 */
export interface GitTrustModule {
  get_commit_message_generator: LlmCallbackGetter;
}

/** 源 4818/4831/4951 `from risk_control import get_risk_controller, coerce_permission`。 */
export interface RiskControllerApi {
  /** 源 4828 `set_mode(mode)`——收的是 `coerce_permission` 的**枚举对象**（不是 `.value` 字符串）。 */
  set_mode(mode: unknown): void;
  /** 源 4834 `set_auto_confirm_low_risk(val)`，val 是 `bool(...)` 的结果。 */
  set_auto_confirm_low_risk(val: boolean): void;
  /** 源 4959 `classify_risk(t.name, {})` → 带 `.value` 的枚举（第二实参是**字面空 dict**，照抄）。
   *  S6c 新增臂面（接口就地扩写，不另立第二份 controller）。 */
  classify_risk(tool_name: unknown, ctx: unknown): unknown;
}

/** risk_control 模块面（4826 `coerce_permission(raw)` 的返回对象只被读 `.value`，见 4827）。 */
export interface RiskControlModule {
  get_risk_controller(): RiskControllerApi;
  coerce_permission(raw: unknown): unknown;
}

/** 源 4897 `from context_compactor import get_compactor`：返回的对象只被 setattr（4898–4904）⇒ unknown。 */
export interface ContextCompactorModule {
  get_compactor(): unknown;
}

/** 源 4913 `from telemetry import get_telemetry`：返回的对象只被 `enabled =` 赋值 ⇒ unknown。 */
export interface TelemetryModule {
  get_telemetry(): unknown;
}

/** 源 4935 `from shadow_config import apply_patch as apply_shadow_patch`（**带别名**，端口只换调用名）。 */
export interface ShadowConfigModule {
  apply_patch(patch: unknown): unknown;
}

/* ── S6c（源 4948–5212，tools / subagents 六 handler）新增的模块面。 ── */

/** 源 4950 `from tools import get_tool_registry` → reg 的调用面。 */
export interface ToolRegistryApi {
  /** 源 4954–4961 的 `registry.list_tools()` → Tool 对象列表（属性面 name/domain/description）。 */
  list_tools(): readonly unknown[];
}

/** 源 4993–4995 `from subagent_runtime import (MAX_CONCURRENT_SUBAGENTS, get_max_children_per_agent, get_subagent_runtime)`。 */
export interface SubagentRuntimeApi {
  /** 源 4999 `runtime.list_sessions(session_id)` → 内存态记录（dict 形状，含 `subagentId`/`status` 键）。 */
  list_sessions(session_id: string): readonly unknown[];
  /** 源 5051 `runtime.kill(id)` → bool（假 ⇒ 404；**只请求取消**，终态由子代自己写，源 docstring 5042–5045）。 */
  kill(subagent_id: string): unknown;
  /** 源 5086 `runtime.kill_all(session_id)` → 数量（同步面）。 */
  kill_all(session_id: string): unknown;
  /** 源 5078 `await runtime.kill_all_graceful(session_id)` → 带 killed/requested/request_id 的 dict（源是协程，§D14 同法）。 */
  kill_all_graceful(session_id: string): unknown | Promise<unknown>;
}

/** subagent_runtime 模块面：`MAX_CONCURRENT_SUBAGENTS` 是**数据常量**（from-import 在源里即刻绑值，端口在 import 位点读属性，§D18）。 */
export interface SubagentRuntimeModule {
  readonly MAX_CONCURRENT_SUBAGENTS: unknown;
  get_max_children_per_agent(): unknown;
  get_subagent_runtime(): SubagentRuntimeApi;
}

/** 源 4996/5111 `from storage import get_storage`。5111 那次是**死 import**（S6-B22）。 */
export interface StorageApi {
  /** 源 5003 `get_storage().list_subagent_runs(session_id)` → 账本行（snake 键 dict）。 */
  list_subagent_runs(session_id: string): readonly unknown[];
  /* ── S6d（源 5269/5344/5354/5366/5384/5399/5409）就地扩写同一接口，不另立第二个 storage。
   *    形参一律 `unknown`：这些实参在源里是 `query/match_info/router.session_id` 的 or 链产物，
   *    端口不做"它一定是 str"的假定性收窄（§D16 同口径；null 侧由 S6-B9/B36 的 or 闸挡掉）。 ── */
  /** 源 5269 `list_user_turns(sid)` → 用户轮次行（`seq`/`ordinal`/`preview`/`created_at` 四键；在 try 里，炸 ⇒ []）。 */
  list_user_turns(session_id: unknown): readonly unknown[];
  /** 源 5344 `get_events(sid, from_seq=…, to_seq=…, limit=…)`：三个关键字实参收进 opts（§D25，None 显式传）。 */
  get_events(session_id: unknown, opts: { from_seq: unknown; to_seq: unknown; limit: unknown }): readonly unknown[];
  /** 源 5354 `verify_event_chain(sid)` → dict（被 `{**res}` 解包，S6-B27）。 */
  verify_event_chain(session_id: unknown): unknown;
  /** 源 5366 `project_session_state(sid, at_seq=…)` → 带 `.to_dict()` 的状态对象。 */
  project_session_state(session_id: unknown, opts: { at_seq: unknown }): unknown;
  /** 源 5384 `fork_at_seq(source_sid, int(fork_seq), new_sid, title=title)`：前三个位置参 + title 关键字参。 */
  fork_at_seq(source_session_id: unknown, fork_point_seq: unknown, new_session_id: unknown, opts: { title: unknown }): unknown;
  /** 源 5399 `get_session_log(sid)` → **str**（直接进 `web.Response(text=…)`，非 str 面见 §D27）。 */
  get_session_log(session_id: unknown): string;
  /** 源 5409 `get_session_transcript(sid)` → JSONL 步骤列表（响应原样）。 */
  get_session_transcript(session_id: unknown): unknown;
  /* ── S6e（源 5419/5459/5474/5475/5477/5513）就地扩写同一接口，仍不另立第二个 storage。 ── */
  /** 源 5419 `get_session_log_info(sid)` → dict，**原样**当整个响应体（S6-B37）。 */
  get_session_log_info(session_id: unknown): unknown;
  /**
   * 源 5459 `router.storage.usage_by_model(days)` → 每模型一行（含 `sources` 列表）。
   * **注意取用路径**：#102/#103 用的是 `router.storage`（router 属性），而本接口其余方法在源里
   * 走 `get_storage()` 模块单例 ⇒ 同一存储两条路径（S6-B39），缝/属性调用次数因此可分。
   */
  usage_by_model(days: number): unknown;
  /** 源 5474 `usage_summary(days)`（响应字面量里**第二个**求值的存储调用）。 */
  usage_summary(days: number): unknown;
  /** 源 5475 `usage_daily(days)`（**第三个**）。 */
  usage_daily(days: number): unknown;
  /** 源 5477 `usage_recent_turns(limit=30, days=days)`：两个关键字实参收进 opts（§D25，总是传）。 */
  usage_recent_turns(opts: { limit: number; days: number }): unknown;
  /** 源 5513 `get_messages(router.session_id, limit=1000)` → 消息行（对象行/dict 行两种形状并存，S6-B49）。 */
  get_messages(session_id: unknown, opts: { limit: number }): unknown;
}

/**
 * 源 5233/5249/5266/5307/5325 `from snapshot_store import get_snapshot_store` 的单例调用面。
 * 五个方法与源一一对应；返回类型全 unknown（形状由 store 决定，本段只做 dict/list 面消费）。
 */
export interface SnapshotStoreApi {
  /** 源 5234 `list_since(sid, seq)` → 快照行列表（响应原样，不逐个加工）。 */
  list_since(session_id: unknown, seq: number): unknown;
  /** 源 5250 `rollback_since(sid, seq)` → report dict（`{**report}` 解包，S6-B27）。 */
  rollback_since(session_id: unknown, seq: unknown): unknown;
  /** 源 5272 `checkpoints(sid)` → 每行含 `seq`（**下标**读，缺键 KeyError，S6-B29）。 */
  checkpoints(session_id: unknown): readonly unknown[];
  /** 源 5310 `paths_at(sid, seq)` → 路径列表（响应原样）。 */
  paths_at(session_id: unknown, seq: number): unknown;
  /** 源 5326 `label_checkpoint(sid, seq, label)` → 被更新的行数（进响应的 `updated`）。 */
  label_checkpoint(session_id: unknown, seq: unknown, label: string): unknown;
}

/**
 * 源 5092/5110/5203 `from subagent_registry import (reload_subagent_defs,) get_subagent_registry`。
 * registry 单例在端口建模成 **name→def 的普通 dict**（§D20）：源的三个用面 `in registry` /
 * `registry.get(name)` / `registry.values()` 都是纯 dict 语义，正好由 §0 的 py_contains /
 * py_dict_get / py_dict_values 覆盖，不需要另造接口方法。
 */
export interface SubagentRegistryModule {
  reload_subagent_defs(): void;
  get_subagent_registry(): JsonDict;
}

/**
 * 源 5436 `from artifact_index import build_index` 的模块面。
 * 三个实参在源里全是**位置参**（storage / sid / workspace），返回什么由 artifact_index 决定
 * ——本段只负责把它原样交给 `web.json_response`（端口不验形状，同 S6-B37 的姿势）。
 */
export interface ArtifactIndexModule {
  build_index(storage: unknown, session_id: unknown, workspace: string): unknown;
}

/**
 * 源 5488 `from token_analytics import get_token_analytics` 的单例面。
 * 三个方法在源里**只用关键字实参**调用（5516–5521 / 5525–5531），端口按 §D25 的既定口径把
 * 关键字实参收进 opts 对象：**键总是出现**（不是省略），探针按"键存在"断言。
 * `snapshot()` 是**零参**方法，且源 5523 与 5534 是**两个不同位点**的调用（次数是探针面）。
 */
export interface TokenAnalyticsApi {
  /** 源 5516–5521 `reset_session(system_prompt_tokens=, tool_def_tokens=, skill_tokens=, context_window=)`。 */
  reset_session(opts: {
    system_prompt_tokens: unknown;
    tool_def_tokens: unknown;
    skill_tokens: unknown;
    context_window: unknown;
  }): unknown;
  /** 源 5523 与 5534 两处 `snapshot()`。 */
  snapshot(): unknown;
  /** 源 5525–5531 `update_from_usage(context_tokens=, context_window=, system_prompt_tokens=, tool_def_tokens=, skill_tokens=)`。 */
  update_from_usage(opts: {
    context_tokens: unknown;
    context_window: unknown;
    system_prompt_tokens: unknown;
    tool_def_tokens: unknown;
    skill_tokens: unknown;
  }): unknown;
}

/** token_analytics 模块面（唯一出口是 `get_token_analytics()` 单例调用）。 */
export interface TokenAnalyticsModule {
  get_token_analytics(): TokenAnalyticsApi;
}

export interface HttpS6Seams {
  /** 源 4579 `os.path.abspath(__file__)`——`_config_path` 兜底支的唯一外部输入（backend 模块文件的绝对路径）。 */
  abspath_module_file(): string;
  /** 源 4588–4589 `open(tmp, "w", encoding="utf-8")` + `json.dump(_CONFIG, f, indent=2, ensure_ascii=False)` 的整写面。**闸规：seam 不得真写盘**，探针捕获 (path, content) 比对。 */
  fs_write_text(path: string, content: string): void;
  /** 源 4590 `os.replace(tmp, path)`（原子换名）。 */
  os_replace(src: string, dst: string): void;
  /** 源 4627/4654/4683 `import permission_rules` 模块面。 */
  permission_rules_module(): PermissionRulesModule;
  /** 源 4628 `from tool_policy import sandbox_layer_status`。 */
  tool_policy_module(): { sandbox_layer_status(): unknown };
  /** 源 4629 `from sandbox import confinement_status`。 */
  sandbox_module(): { confinement_status(workspace_root: string): unknown };
  /** 源 4690/4701/4744 `from model_registry import get_model_registry`。 */
  model_registry_module(): { get_model_registry(): ModelRegistryApi };
  /* ── S6b（源 4760–4945 handle_update_settings）新增的九臂；S6c–e 继续在此之后扩写。 ── */
  /** 源 4782 `from llm_client import reset_llm_client, get_llm_client`（4786 调用、4787 取值，均在 try 之外）。 */
  llm_client_module(): LlmClientModule;
  /** 源 4783 与 4924 **两条** `from memory_layer import get_memory_layer` ⇒ 本 getter 每次 import 语句调一次（§D1）。 */
  memory_layer_module(): MemoryLayerModule;
  /** 源 4784 `from goal_manager import get_goal_manager`。 */
  goal_manager_module(): GoalManagerModule;
  /** 源 4785 `from git_trust import get_commit_message_generator`。 */
  git_trust_module(): GitTrustModule;
  /** 源 4818（两个名字）与 4831（一个名字）、4951（一个名字 `get_risk_controller`）`from risk_control import ...` ⇒ 每次 import 语句一个 getter。 */
  risk_control_module(): RiskControlModule;
  /** 源 4897 `from context_compactor import get_compactor`——**在** `except Exception: pass` 里面，未接线即被吞（§D13）。 */
  context_compactor_module(): ContextCompactorModule;
  /** 源 4913 `from telemetry import get_telemetry`（在 4912 写完 config **之后**才 import，顺序照抄）。 */
  telemetry_module(): TelemetryModule;
  /** 源 4935 `from shadow_config import apply_patch as apply_shadow_patch`。 */
  shadow_config_module(): ShadowConfigModule;
  /**
   * 源 4802 `_wire_scene_callbacks(llm)`：它是**本文件自己的模块级 helper**（源 7491，属 S9 段），
   * 本段不能 import（跨段 import 要说明理由，宁可不用）⇒ 以接缝臂承接，装配层把 S9 的真函数接进来。
   * 缺省抛错会被源自己的 `except Exception: pass`（4807）吞掉，与"该 helper 缺失 ⇒ fail-open"同结论（§D9）。
   */
  wire_scene_callbacks(llm: unknown): unknown;
  /* ── S6c（源 4948–5212，tools / subagents 六 handler）新增的十臂；S6d–e 继续在此之后扩写。 ── */
  /** 源 4950 `from tools import get_tool_registry`。 */
  tools_module(): { get_tool_registry(): ToolRegistryApi };
  /** 源 4993–4995 / 5047 / 5066 / 5076 的 `from subagent_runtime import ...`——每条 import 语句一次 getter（§D1）。 */
  subagent_runtime_module(): SubagentRuntimeModule;
  /** 源 4996 与 5111 两条 `from storage import get_storage`；5111 那条的返回值被丢弃（S6-B22）。 */
  storage_module(): { get_storage(): StorageApi };
  /** 源 5092、5110、5203 **三条** `from subagent_registry import ...` ⇒ 本 getter 在源里被调三处（§D1）。 */
  subagent_registry_module(): SubagentRegistryModule;
  /** 源 5158 `os.makedirs(subs_dir, exist_ok=True)`。**闸规：seam 不得真碰盘**。 */
  fs_makedirs(dir: string): void;
  /** 源 5156 `os.path.abspath(...)`（对 join 结果的纯路径归一化，不碰盘）。 */
  os_path_abspath(p: string): string;
  /** 源 5187–5188 `tempfile.mkstemp(dir=subs_dir, suffix=".yaml")` → `(fd, path)` 元组。 */
  mkstemp(dir: string, suffix: string): readonly [number, string];
  /** 源 5190–5191 `with os.fdopen(fd, "w", encoding="utf-8") as f: f.write(...)` 的整体（写+关 fd，§D19）。 */
  fd_write_text(fd: number, text: string): void;
  /** 源 5195 `os.unlink(tmp)`（清理半截临时文件；失败按 5196 `except OSError: pass` 窄兜）。 */
  os_unlink(path: string): void;
  /**
   * 源 5191 `yaml.safe_dump(doc, f, allow_unicode=True, sort_keys=False)` 的**序列化面**：
   * PyYAML 是第三方库、端口不带 YAML 序列化器 ⇒ 缝出文本、文件句柄写入面折进 fd_write_text（§D19）。
   */
  yaml_dump(doc: unknown): string;
  /* ── S6d（源 5224–5410，rollback / checkpoints / events / sessions 十一 handler）新增的两臂。 ── */
  /** 源 5233/5249/5266/5307/5325 五条 `from snapshot_store import get_snapshot_store` ⇒ 每条 import 一次 getter（§D1）。 */
  snapshot_store_module(): { get_snapshot_store(): SnapshotStoreApi };
  /**
   * 源 5382 `str(uuid4())`——`uuid4` 是**模块顶层** import（源 17 行 `from uuid import uuid4`），
   * 但**取值点**只有 5382 一处 ⇒ 观察面放在调用行（与 §D19 的 stdlib 折法同族）。
   * 返回值建模为 unknown：源的 `str()` 面在端口同位由 §M `py_str` 承担（假件给字符串时是恒等，
   * 给带 `__str__` 的对象时与 CPython 的 UUID 对象同位）。§D26。
   */
  uuid4(): unknown;
  /* S6e 是本段最后一批（源 5413–5547）：三臂之下不再有 seam，S6 接口到此定形。 */
  /* ── S6e（源 5413–5547，log_info / artifacts / usage / token-analytics）新增的三臂。 ── */
  /**
   * 源 5436 `from artifact_index import build_index`——它在源里位于 **400 闸之后**（对照 5415 的
   * "import 在 sid 判定之前"）⇒ 未接线时 `?session_id=` 那一档拿 400、**不触**本缝（S6-B38，§D1）。
   */
  artifact_index_module(): ArtifactIndexModule;
  /** 源 5488 `from token_analytics import get_token_analytics`（**函数最顶上**，先于 router 解析，S6-B47）。 */
  token_analytics_module(): TokenAnalyticsModule;
  /**
   * 源 5493 `await _router_for_request(request)`：这个名字是**本文件 6707 行的别名**
   * （`_router_for_request = _git_router`，定义属 S8 段）⇒ 与 §D9 同族：不跨段 import，
   * 由缝臂承接，装配层把 S8 落地后的真函数接进来。
   * 与 D9 的关键差别：源 5493 **不在** 5495 起的 catch-all 里面 ⇒ 未接线时 NameError 直接冒
   * handler（那处 wire_scene_callbacks 是被源自己吞掉的），§D37。
   */
  router_for_request(request: WebRequest): unknown | Promise<unknown>;
}

/** 源 4667 `except ValueError as e:` **只兜 ValueError**（#69 的枚举报错面；与 VALUE_OR_TYPE_ERROR 不同族）。 */
const VALUE_ERROR_ONLY: readonly string[] = ["ValueError"];

/** 源 4796 `except TypeError:`（#67 的 llm_callback 签名面）——**只兜 TypeError**，S6-B13 的执行者。 */
const TYPE_ERROR_ONLY: readonly string[] = ["TypeError"];

/** 本段函数级 import 的模块名（缺省臂 ModuleNotFoundError 文案来源，同 S5 的 MOD）。 */
const MOD = {
  permission_rules: "permission_rules",
  tool_policy: "tool_policy",
  sandbox: "sandbox",
  model_registry: "model_registry",
  llm_client: "llm_client",
  memory_layer: "memory_layer",
  goal_manager: "goal_manager",
  git_trust: "git_trust",
  risk_control: "risk_control",
  context_compactor: "context_compactor",
  telemetry: "telemetry",
  shadow_config: "shadow_config",
  tools: "tools",
  subagent_runtime: "subagent_runtime",
  storage: "storage",
  subagent_registry: "subagent_registry",
  snapshot_store: "snapshot_store",
  artifact_index: "artifact_index",
  token_analytics: "token_analytics",
} as const;

function module_not_found(name: string): ModuleNotFoundErrorP {
  return new ModuleNotFoundErrorP(name);
}

/**
 * 缺省 = 未接线 = fail-closed（S3/S5 同族）：模块面抛 CPython 的 ModuleNotFoundError，
 * fs/路径面抛 PyNameErrorP（"seam is not wired"）。任何一臂都不许悄悄成功。
 */
export const HTTP_S6_SEAMS: HttpS6Seams = {
  abspath_module_file(): string {
    throw new PyNameErrorP("abspath_module_file seam is not wired (fail closed)");
  },
  fs_write_text(_path: string, _content: string): void {
    throw new PyNameErrorP("fs_write_text seam is not wired (fail closed)");
  },
  os_replace(_src: string, _dst: string): void {
    throw new PyNameErrorP("os_replace seam is not wired (fail closed)");
  },
  permission_rules_module(): PermissionRulesModule {
    throw module_not_found(MOD.permission_rules);
  },
  tool_policy_module(): { sandbox_layer_status(): unknown } {
    throw module_not_found(MOD.tool_policy);
  },
  sandbox_module(): { confinement_status(workspace_root: string): unknown } {
    throw module_not_found(MOD.sandbox);
  },
  model_registry_module(): { get_model_registry(): ModelRegistryApi } {
    throw module_not_found(MOD.model_registry);
  },
  /* ── S6b 新增九臂：一律 fail-closed（模块面抛 ModuleNotFoundError，同文件 helper 面抛 NameError）。 ── */
  llm_client_module(): LlmClientModule {
    throw module_not_found(MOD.llm_client);
  },
  memory_layer_module(): MemoryLayerModule {
    throw module_not_found(MOD.memory_layer);
  },
  goal_manager_module(): GoalManagerModule {
    throw module_not_found(MOD.goal_manager);
  },
  git_trust_module(): GitTrustModule {
    throw module_not_found(MOD.git_trust);
  },
  risk_control_module(): RiskControlModule {
    throw module_not_found(MOD.risk_control);
  },
  context_compactor_module(): ContextCompactorModule {
    throw module_not_found(MOD.context_compactor);
  },
  telemetry_module(): TelemetryModule {
    throw module_not_found(MOD.telemetry);
  },
  shadow_config_module(): ShadowConfigModule {
    throw module_not_found(MOD.shadow_config);
  },
  wire_scene_callbacks(_llm: unknown): unknown {
    // 源 4802 的接收者是本文件 7491 行的私有 helper（S9 段）；未接线 ⇒ NameError 形状，
    // 恰好被源的 `except Exception: pass` 吞掉 ⇒ 与"helper 缺失即 fail-open"同结论（§D9）。
    throw new PyNameErrorP("wire_scene_callbacks seam is not wired (fail closed)");
  },
  /* ── S6c 新增十臂：模块面抛 ModuleNotFoundError，FS/路径/序列化面抛 NameError（一律 fail-closed）。 ── */
  tools_module(): { get_tool_registry(): ToolRegistryApi } {
    throw module_not_found(MOD.tools);
  },
  subagent_runtime_module(): SubagentRuntimeModule {
    throw module_not_found(MOD.subagent_runtime);
  },
  storage_module(): { get_storage(): StorageApi } {
    throw module_not_found(MOD.storage);
  },
  subagent_registry_module(): SubagentRegistryModule {
    throw module_not_found(MOD.subagent_registry);
  },
  fs_makedirs(_dir: string): void {
    throw new PyNameErrorP("fs_makedirs seam is not wired (fail closed)");
  },
  os_path_abspath(_p: string): string {
    throw new PyNameErrorP("os_path_abspath seam is not wired (fail closed)");
  },
  mkstemp(_dir: string, _suffix: string): readonly [number, string] {
    throw new PyNameErrorP("mkstemp seam is not wired (fail closed)");
  },
  fd_write_text(_fd: number, _text: string): void {
    throw new PyNameErrorP("fd_write_text seam is not wired (fail closed)");
  },
  os_unlink(_path: string): void {
    throw new PyNameErrorP("os_unlink seam is not wired (fail closed)");
  },
  yaml_dump(_doc: unknown): string {
    throw new PyNameErrorP("yaml_dump seam is not wired (fail closed)");
  },
  /* ── S6d 新增两臂：模块面抛 ModuleNotFoundError，随机值面抛 NameError（一律 fail-closed，不静默成功）。 ── */
  snapshot_store_module(): { get_snapshot_store(): SnapshotStoreApi } {
    throw module_not_found(MOD.snapshot_store);
  },
  uuid4(): unknown {
    // 源 5382 的 `str(uuid4())`：随机源不可复现 ⇒ 必须由假件供给；未接线**不**回退成固定串
    // （那会让"忘了接线"看起来像成功）。
    throw new PyNameErrorP("uuid4 seam is not wired (fail closed)");
  },
  /* ── S6e 新增三臂：两个模块面抛 ModuleNotFoundError，同文件跨段 helper 别名抛 NameError。 ── */
  artifact_index_module(): ArtifactIndexModule {
    throw module_not_found(MOD.artifact_index);
  },
  token_analytics_module(): TokenAnalyticsModule {
    throw module_not_found(MOD.token_analytics);
  },
  router_for_request(_request: WebRequest): unknown {
    // 源 6707 行 `_router_for_request = _git_router` 是本文件的模块级 helper（属 S8 段），
    // 本段不跨段 import（§D9 同族）。**但这里源没有 catch-all 兜它**（try 从 5495 起）
    // ⇒ 未接线即冒 NameError，绝不让它悄悄当成"没有 router"走 5494 的假支（§D37）。
    throw new PyNameErrorP("router_for_request seam is not wired (fail closed)");
  },
};

/** 本段全部接缝名（S10/探针核对"少接一臂"用；顺序 = 字段名字典序，与源行号无关）。 */
export const HTTP_S6_SEAM_KEYS: readonly string[] = Object.keys(HTTP_S6_SEAMS).sort();

/* ──────────────────────────────────────────────────────────────────────────
 * §S6a-1 模块级 helper 三件套（源 4577–4609）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 源 4577–4581 `_config_path()`：`_CONFIG_PATH or os.path.join(dirname(abspath(__file__)), "..", "..", "config.json")`。
 * `_CONFIG_PATH` 是模块全局（keys.ts SERVER_STATE，源 4574）；`or` 短路 ⇒ 非空时**不**触碰 seam
 * （端口同序：先真值判断，后 abspath）。多参 `os.path.join` 拆成三次二元 `os_path_join`（§M）。
 * 名字保留下划线 = 源名；export 是给 S6b–e 与探针复用，不是扩面。
 */
export function _config_path(seams: HttpS6Seams = HTTP_S6_SEAMS): string {
  if (py_truth(SERVER_STATE._CONFIG_PATH)) return SERVER_STATE._CONFIG_PATH;
  const dir = os_path_dirname(seams.abspath_module_file());
  return os_path_join(os_path_join(os_path_join(dir, ".."), ".."), "config.json");
}

/**
 * 源 4584–4590 `_persist_config()`：`tmp = f"{path}.tmp"` → open+json.dump(indent=2, ensure_ascii=False)
 * → `os.replace(tmp, path)`。盘 IO 全走 seam（闸规：探针观察、不真写盘）。
 * open/dump/replace 任一步失败（OSError 族）在源与本段同样**冒出调用方**——此函数无 try。
 */
export function _persist_config(seams: HttpS6Seams = HTTP_S6_SEAMS): void {
  const path = _config_path(seams);
  const tmp = `${path}.tmp`; // f"{path}.tmp"（源 4587，等价拼接见 §D7）
  seams.fs_write_text(tmp, py_json_dump_indent2(SERVER_STATE._CONFIG)); // 源 4588–4589（§D4）
  seams.os_replace(tmp, path); // 源 4590
}

/**
 * 源 4593–4609 `_redact(cfg)`：`copy.deepcopy` + 三段掩码。逐字面：
 *  - 4597 `model = safe.get("model") or {}`：S6-B5（falsy 支的改写落进临时 {} 即丢，源里实际
 *    不可达为改写——照抄，不"顺手修"）；
 *  - 4600 `f"{key[:6]}…{key[-4:]}" if len(key) > 12 else "***"`：省略号是 U+2026 单字符；
 *    `len` 先算再切（非 str 值先死在 py_len，与 CPython 同位，§D3）；
 *  - 4602 `for entry in safe.get("models") or []`：S6-B6 元素非 dict → `entry.get` 抛
 *    AttributeError 冒出 GET /api/settings（全函数无 try）；
 *  - 4606–4608 `for k in list(bot): if bot[k]: bot[k] = "***"`：**快照迭代**（list(bot)）+
 *    只遮真值——falsy（""/0/false）原样回显，是源行为，保留。
 * 键名掩码面严格按源：model.api_key / models[*].api_key / bot 全部真值键；**不多遮任何一个**。
 */
export function _redact(cfg: unknown): unknown {
  const safe = py_deepcopy(cfg); // 源 4595–4596（import copy 是 stdlib，缝折入 §0 py_deepcopy，§D8）
  const model = py_or(py_dict_get(safe, "model", null), {});
  if (py_truth(py_dict_get(model, "api_key", null))) {
    const key = py_map_index(model as JsonDict, "api_key"); // 源 4599 下标（刚证真值，键必在）
    py_dict_set(
      model,
      "api_key",
      py_len(key) > 12 ? `${py_head(key as string, 6)}…${py_tail(key as string, 4)}` : "***",
    );
    py_dict_set(model, "api_key_set", true);
  }
  for (const entry of py_iter(py_or(py_dict_get(safe, "models", null), []))) {
    if (py_truth(py_dict_get(entry, "api_key", null))) {
      py_dict_set(entry, "api_key", "***"); // 列表项整遮，无省略号支（与 model 支不一致是源事实）
    }
  }
  const bot = py_or(py_dict_get(safe, "bot", null), {});
  for (const k of py_dict_keys(bot)) {
    if (py_truth(py_map_index(bot as JsonDict, k))) {
      py_dict_set(bot, k, "***");
    }
  }
  return safe;
}

/* ──────────────────────────────────────────────────────────────────────────
 * §S6a-2 GET /api/settings #66（源 4612–4617）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 源 4612–4617：纯内存面——`_redact(_CONFIG)` + 写死的四态列表。无任何外部世界
 * （seam 参数只为 S10 装配签名统一而存在，本 handler 不调用它）。
 */
export async function handle_get_settings(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  void request;
  void seams;
  return json_response({
    settings: _redact(SERVER_STATE._CONFIG),
    permissionModes: ["confirm", "auto", "plan", "full"],
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * §S6a-3 permission rules 三件套（源 4620–4685）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/permissions/rules（源 4620–4648）#68。
 * docstring 4623–4625 原话：「allowlist grown from 「以后都允许」 replies stays inspectable and
 * revocable」——规则不存在"看不见"这一档。三条函数级 import（4627–4629）在 query 读取**之前**、
 * 且全函数**无 try** ⇒ 未接线 ModuleNotFoundError 冒出 handler（端口 import 同位，§D1）。
 * rule 序列化十键顺序照抄；`r.behavior.value`/`r.scope.value` 是枚举双层属性（缺属性 →
 * AttributeError 逃逸，源无 try）；`int(r.created_at)`（4639）走 §M py_int。
 */
export async function handle_permission_rules_list(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const prModule = seams.permission_rules_module(); // 源 4627
  const tpModule = seams.tool_policy_module(); // 源 4628
  const sbModule = seams.sandbox_module(); // 源 4629
  const ws = request.query.get("workspace", "");
  const sid = request.query.get("session", "");
  const rules = prModule.get_permission_rules().list({ workspace_root: ws, session_id: sid });
  const out: JsonDict[] = [];
  for (const r of py_iter(rules)) {
    out.push({
      id: py_getattr(r, "id"),
      toolName: py_getattr(r, "tool_name"),
      pattern: py_getattr(r, "pattern"),
      behavior: py_getattr(py_getattr(r, "behavior"), "value"),
      scope: py_getattr(py_getattr(r, "scope"), "value"),
      workspaceRoot: py_getattr(r, "workspace_root"),
      sessionId: py_getattr(r, "session_id"),
      source: py_getattr(r, "source"),
      note: py_getattr(r, "note"),
      createdAt: py_int(py_getattr(r, "created_at")),
    });
  }
  return json_response({
    rules: out,
    // 源 4645：policy-pipeline SANDBOX 层（readonly-tool flag），历史惰性，保留给页面报"该层为空"。
    sandbox: tpModule.sandbox_layer_status(),
    // 源 4647：内核级限制 + 路径策略文件——"the real gate"。
    confinement: sbModule.confinement_status(ws),
  });
}

/**
 * POST /api/permissions/rules（源 4652–4679）#69。
 *  - import（4654–4656）在 `await request.json()` 的 try **之外**且在前（S6-B3：与 #78 的
 *    "先验参后 import"同族不同姿势，端口各随其源）；
 *  - `except Exception`（4659）把 request.json() 的**一切**异常吞成 400 "invalid json"
 *    （小写 j——与 #78 的 "invalid JSON" 大写 J 只差在大小写，S6-B2/S6-B4，逐字保留）；
 *  - 4661 toolName 双键收（camel `toolName` / snake `tool_name`），其余字段（pattern/
 *    workspaceRoot/sessionId/note）**只收 camel**——键面不一致是源事实（S6-B8）；
 *  - 4665–4666 `RuleBehavior(str(...).lower())`：构造非法值抛 ValueError 被 4667 兜 400，
 *    文案 = `str(e)`（枚举报错由 seam 侧给出）；该 try **只兜 ValueError**（族判定同文件私有）。
 */
export async function handle_permission_rule_create(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const prModule = seams.permission_rules_module(); // 源 4654–4656：先于 json-try（S6-B3）
  let body: JsonDict;
  try {
    body = await request.json();
  } catch (exc) {
    void exc; // except Exception（4659）：无族过滤，一切吞成 400（S6-B4）
    return json_response({ error: "invalid json" }, 400);
  }
  const tool = py_strip(
    py_str(
      py_or(
        py_or(py_dict_get(body, "toolName", null), py_dict_get(body, "tool_name", null)),
        "",
      ),
    ),
  );
  if (!py_truth(tool)) {
    return json_response({ error: "toolName is required" }, 400);
  }
  let behavior: unknown;
  let scope: unknown;
  try {
    behavior = prModule.RuleBehavior(py_str(py_or(py_dict_get(body, "behavior", null), "allow")).toLowerCase());
    scope = prModule.RuleScope(py_str(py_or(py_dict_get(body, "scope", null), "workspace")).toLowerCase());
  } catch (e) {
    if (!catches_classes(e, VALUE_ERROR_ONLY)) throw e; // except ValueError as e（4667）
    return json_response({ error: exc_str(e) }, 400);
  }
  const rule = prModule.get_permission_rules().add(
    prModule.PermissionRule({
      tool_name: tool,
      pattern: py_str(py_or(py_dict_get(body, "pattern", null), "")),
      behavior,
      scope,
      workspace_root: py_str(py_or(py_dict_get(body, "workspaceRoot", null), "")),
      session_id: py_str(py_or(py_dict_get(body, "sessionId", null), "")),
      source: "user", // 4676：写死，body 里的 source 被无视（源事实）
      note: py_str(py_or(py_dict_get(body, "note", null), "")),
    }),
  );
  return json_response({ ok: true, id: py_getattr(rule, "id") });
}

/**
 * DELETE /api/permissions/rules/{rule_id}（源 4682–4685）#70。
 * S6-B1：`request.match_info["rule_id"]` 是**下标**（KeyError 面），不是段内其余 60+ 处的
 * `.get(...)`——经路由注册该键必在，端口用 `match_info.index` 复刻（缺键抛 PyKeyError）。
 * 响应体 `{"ok": removed}` 回填**原值**（不 py_truth 化）；状态码才做真值判断（200/404）。
 */
export async function handle_permission_rule_delete(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const prModule = seams.permission_rules_module(); // 源 4683（无 try）
  const removed = prModule.get_permission_rules().remove(request.match_info.index("rule_id"));
  return json_response({ ok: removed }, py_truth(removed) ? 200 : 404);
}

/* ──────────────────────────────────────────────────────────────────────────
 * §S6a-4 models 三件套（源 4688–4757）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/models（源 4688–4696）#76。
 * `reg.resolve()` **无参**调用（4692）= "当前默认"面；`info.value if info.ok else None`（4695）
 * ——条件先判 ok。import 在体首（4690），端口同位。
 */
export async function handle_models_list(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  void request;
  const reg = seams.model_registry_module().get_model_registry(); // 源 4690–4691
  const info = reg.resolve();
  return json_response({
    providers: reg.list_providers(),
    active: py_truth(py_getattr(info, "ok")) ? py_getattr(info, "value") : null,
  });
}

/**
 * GET /api/models/resolve（源 4699–4711）#77。
 * query `model` 单参 `.get` → `or ""` → `.strip()`（D2 折叠同 S5）。缺 → 400。
 * `resolved.error or "not found"`（4708）→ 404；`dict(resolved.value)`（4709）在**任何 try 之外**
 * （S6-B7：value 非 mapping → TypeError 逃逸，端口 py_dict_copy 同抛）。
 * 4710 给副本挂 `thinkingCapability` 再回——**不回** registry 的原始对象。
 */
export async function handle_models_resolve(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const moduleFace = seams.model_registry_module(); // 源 4701
  const model = py_strip_or(request.query.get("model")); // (query.get("model") or "").strip()（§M py_strip_or 组合面）
  if (!py_truth(model)) {
    return json_response({ error: "model query parameter required" }, 400);
  }
  const reg = moduleFace.get_model_registry();
  const resolved = reg.resolve(model);
  if (!py_truth(py_getattr(resolved, "ok"))) {
    return json_response({ error: py_or(py_getattr(resolved, "error"), "not found") }, 404);
  }
  const body = py_dict_copy(py_getattr(resolved, "value"));
  body["thinkingCapability"] = reg.thinking_capability(model);
  return json_response(body);
}

/**
 * POST /api/models/providers（源 4714–4757）#78。
 * docstring（4715–4731）要点（都是源话，注释转述）：Electron 侧 providers.json 后端从不读，
 * 本路由是 UI→backend 的单向同步；apiKey 经 CredentialCipher 存储、缺省/空串**不动**已存值；
 * `prune: true` 使 payload 成为权威（UI 已删的 provider 才会真消失）。
 * 行为面逐点：
 *  - `except json.JSONDecodeError`（4734）→ 400 **"invalid JSON"**（大写 J，S6-B2），族判定用
 *    §0 的 JSON_DECODE_OR_VALUE（设计理由见 §0 注释与 §D5）；非解码类异常照 §0 语义归缝。
 *  - 4737–4741 三段 isinstance：prune 只在 body 是 dict 时读；providers 优先 body["providers"]，
 *    不是 dict 则**回落整 body**（"bare mapping 便利支"），仍非 dict 或为空 → 400。
 *  - 4744 import 在验参**之后**（与 #69 相反，S6-B3）；spec 非 dict → 传 `{}` 给 upsert（4748）。
 *  - 迭代按 providers 的**书写顺序**（py_dict_items），部分成功如实回：
 *    `ok = not failed`（4756，空 dict 假值 ⇒ 全成才 true），failed 是 pid→error 映射。
 */
export async function handle_models_sync_providers(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  let body: JsonDict;
  try {
    body = await request.json();
  } catch (exc) {
    if (!catches_classes(exc, JSON_DECODE_OR_VALUE)) throw exc; // 源 4734
    return json_response({ error: "invalid JSON" }, 400);
  }
  const prune = py_isinstance_dict(body) ? py_truth(py_dict_get(body, "prune", null)) : false;
  let providers: unknown = py_isinstance_dict(body) ? py_dict_get(body, "providers", null) : null;
  if (!py_isinstance_dict(providers)) {
    providers = py_isinstance_dict(body) ? body : null; // 4740：bare mapping 便利支
  }
  if (!py_isinstance_dict(providers) || py_len(providers) === 0) {
    return json_response({ error: "providers must be a non-empty object" }, 400);
  }
  const reg = seams.model_registry_module().get_model_registry(); // 源 4744–4745：验参后才 import（S6-B3）
  const synced: unknown[] = [];
  const failed: JsonDict = {};
  for (const [pid, spec] of py_dict_items(providers)) {
    const r = reg.upsert_provider(pid, py_isinstance_dict(spec) ? spec : {}); // 4748
    if (py_truth(py_getattr(r, "ok"))) {
      synced.push(pid);
    } else {
      py_dict_set(failed, pid, py_getattr(r, "error"));
    }
  }
  const pruned = prune ? reg.prune_providers(synced) : []; // 4753
  // 4756–4757：部分成功就是诚实答案——一条坏 spec 不清掉已同步的其余 provider。
  return json_response({ ok: !py_truth(failed), synced, failed, pruned });
}

/* ──────────────────────────────────────────────────────────────────────────
 * §S6b PUT /api/settings #67（源 4760–4945，单函数 186 源行）
 *
 * docstring（源 4761–4766）原话转述：「Patch settings and hot-apply the ones that
 * support it. Body accepts any subset of ``model`` / ``permissions`` / ``memory``.
 * An ``api_key`` of "" or the masked placeholder is ignored so a GET->PUT round trip
 * cannot wipe the stored key.」——"任意子集"＋"掩码值不写回"是这条路由的对外承诺；
 * 端口把"掩码"判成 4778 那三个条件（假值 / 含 U+2026 / 恰为 "***"），**只有 api_key 一个键**
 * 受此保护（S6-B12：`api_key_set` 会被原样写回并落盘）。
 *
 * 分节（源行号 → 端口行为面，逐条不省）：
 *   4767–4770 body 解析：`except json.JSONDecodeError` → 400 **"invalid JSON"**（大写 J，
 *          与 #69 的 "invalid json" 相对，S6-B2；族判定用 §0 的 JSON_DECODE_OR_VALUE，同 §D5）；
 *          解析成功**不验类型** ⇒ S6-B9。
 *   4772     `applied: list[str] = []`——响应里的数组，顺序 = 分支执行顺序。
 *   4774–4814 model 臂：4774 `patch.get("model") or {}`（§M py_or/py_dict_get）→ 4775 真值闸 →
 *          4776 `setdefault("model", {})` → 4777 `.items()` **书写顺序**迭代（不是 sorted，坑 2）→
 *          4778 掩码三条件 continue → 4780 `current[key] = value`；
 *          4782–4785 四条 import（在合并循环**之后**，端口 seam getter 同位，§D1）→
 *          4786 `reset_llm_client()` → 4787 `get_llm_client(_CONFIG)`；
 *          4788–4792 `try: model_registry.seed_from_config(_CONFIG.get("model", {})) except Exception: pass`；
 *          4793–4797 三元组逐元素 `getter(llm_callback=llm.call)`，每元素**各自**一只 `except TypeError`（S6-B13）；
 *          4801–4808 场景回调臂（`_wire_scene_callbacks` 是 S9 段的同文件 helper ⇒ seam 臂，§D9；
 *          整臂被 `except Exception: pass` 吞，S6-B14）；
 *          4809–4813 `request.app[ROUTER_KEY]` 下标 + `router.llm` / `router._base_llm` 两次 setattr
 *          （源注释 4811–4812：per-turn 绑定派生自 `_base_llm`，只刷 `llm` 会让下一轮从**旧凭据**重建）；
 *          4814 append("model")。
 *   4816–4836 permissions 臂：4816 `or {}`；4817 `"mode" in perm_patch`（无类型闸，S6-B10）；
 *          4818 import（两个名字）；4823 **下标**取 raw；4824 `not raw or not str(raw).strip()` → 400
 *          "empty permission mode"（源注释 4819–4822：coerce_permission 不抛，非法值回落默认 ⇒ 只拒真空输入）；
 *          4826 `coerce_permission(raw)`；4827 `_CONFIG.setdefault("permissions", {})["mode"] = mode.value`
 *          ——CPython 的 `a[k] = v` 先求 a、k 再求 v ⇒ 端口把 setdefault 与 `mode.value` 的 getattr
 *          **分成两句**保持该顺序（value 缺失时 AttributeError 逃逸，但 permissions 键**已**被建出来，S6-B11）；
 *          4828 `set_mode(mode)`（传枚举对象，不是字符串）；4829 append；
 *          4830 第二个键闸；4831 **第二条** import 语句（同模块再 import ⇒ 端口再调一次 getter，§D1）；
 *          4832 `bool(...)`（§M py_truth，不另造 py_bool，§D10）；4833 再次 setdefault（复用 4827 建的键）；
 *          4834 `set_auto_confirm_low_risk(val)`；4835–4836 **全函数唯一**一处 applied 去重（S6-B20）。
 *   4840–4850 agent 臂：4841 键闸；4842–4845 `max(0, int(...))` 用 §M py_int + JS Math.max
 *          （操作数恒为 CPython int，两侧逐位同结论，§D11；S5 同法）；坏值 → 400
 *          "invalid max_steps_per_turn"（族 (TypeError, ValueError)，§0 VALUE_OR_TYPE_ERROR）；
 *          4846 setdefault 写 steps；4847–4849 **第二次**读 `app[SESSION_HOST_KEY]._sessions.values()`
 *          （键身份判定：`AppKey` 相等是对象身份，§M），每个 router 写 `max_agent_steps` 与
 *          `soft_landing_step = max(1, steps-2) if steps > 0 else -1`；4850 append("agent")。
 *   4855–4907 compaction 臂：4855 `or {}` → 4856 真值闸 → 4857 setdefault；
 *          4858–4861 六键**元组书写顺序**逐个 `in` 判定后下标搬运（不是 sorted，坑 2）；
 *          4862–4867 th/em 双钳位 `[0.50,0.95]` 与 `[th,0.98]`，坏值整支回落 0.80/0.90；
 *          4868–4874 cd/mx/mt 三钳位（>=0.0 / >=1 / >=8000），坏值整支回落 15.0/5/80000；
 *          4867 与 4874 是**元组赋值** ⇒ 端口按书写顺序逐个 py_dict_set；
 *          4876 `floor_set`（"只有显式传入才写"，源注释 4875）；4877–4882 显式支把 fl 钳到
 *          `[0, mt // 2]`（地板除：mt 恒为非负 int ⇒ Math.floor 与 // 同结论，§D11）后写盘；
 *          4883–4887 else 支算 fl 却**从不使用**（S6-B16 死计算，照抄）；
 *          4888–4895 第二次遍历 sessions，对每个 `r.compactor` 做 5 次（floor_set 时 6 次）属性写，
 *          每条语句各自重新求值 `r.compactor`；**整支无 try**（S6-B15）；
 *          4896–4906 全局 `get_compactor()` 臂：每条赋值各自再取一次单例（S6-B17）＋
 *          `except Exception: pass`（S6-B18 两种容错并存）；4907 append("compaction")。
 *   4909–4915 telemetry 臂：4910 键闸 → 4911 `bool(下标)` → 4912 setdefault 写 → **4913 才 import**
 *          （源把 import 放在 config 写之后，端口同位）→ 4914 `.enabled =` setattr → 4915 append。
 *   4917–4926 memory 臂：4918 真值闸 → 4919 `setdefault("memory", {}).update(memory_patch)`
 *          （§0 py_dict_update：按 other 迭代顺序写；非 mapping 抛，S6-B19）→
 *          4923 键闸 → 4924 **第二条** memory_layer import → 4925 `await ...set_enabled(bool(...))`
 *          （§D14）→ 4926 append。源注释 4920–4922：master switch 现在运行期生效，
 *          关掉它会停掉 dreamer + 待处理的防抖抽取并停止 recall 注入。
 *   4928–4931 workspace 臂：`or {}` → 真值闸 → setdefault+update → append。
 *   4933–4938 shadow 臂：真值闸 → 4935 import（带别名 `apply_shadow_patch`）→
 *          4936 `normalized = apply_patch(shadow_patch)`（返回值不再验类型）→ 4937 setdefault+update → append。
 *   4940–4943 落盘：`_persist_config()`（S6a 的 helper，缝原样复用，零真写盘）；
 *          `except OSError as e` **窄兜**（S6-B21）→ 500 `f"could not persist: {e}"`（`{e}` 是
 *          `str(e)` 不是 repr ⇒ §M exc_str，§D15）。
 *   4945     200 `{"applied": applied, "settings": _redact(_CONFIG)}`——S6a 的 `_redact` 复用，
 *          掩码面与 GET 完全一致（同一份实现 ⇒ 不存在"两处掩码不同步"）。
 * ──────────────────────────────────────────────────────────────────────── */

/** 源 4858–4859 的六个 compaction 键：元组**书写顺序**迭代（4860 的 `in` 判定按此序，不是 sorted）。 */
const COMP_KEYS: readonly string[] = [
  "max_tokens",
  "threshold",
  "emergency_threshold",
  "cooldown_s",
  "max_consecutive",
  "reserve_tokens_floor",
];

export async function handle_update_settings(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  let patch: JsonDict;
  try {
    patch = await request.json(); // 源 4768
  } catch (exc) {
    if (!catches_classes(exc, JSON_DECODE_OR_VALUE)) throw exc; // 源 4769（S6-B9：只兜解码族）
    return json_response({ error: "invalid JSON" }, 400); // 源 4770（大写 J，S6-B2）
  }

  const applied: string[] = []; // 源 4772

  /* ── 1) model（源 4774–4814）：合并 + 重建客户端 + 重接回调 + 刷 router 两个字段 ── */
  const model_patch = py_or(py_dict_get(patch, "model", null), {}); // 源 4774（S6-B9/S6-B10：不验类型）
  if (py_truth(model_patch)) {
    // 源 4776：直接写全局 _CONFIG（无副本、无回滚，S6-B11）。
    const current = py_setdefault(SERVER_STATE._CONFIG, "model", {});
    for (const [key, value] of py_dict_items(model_patch)) {
      // 源 4777 `.items()` ⇒ model_patch 非 dict 在这里 AttributeError（S6-B10）。
      // 源 4778：三个条件任一命中就跳过 api_key——"" 与掩码占位（含 U+2026 / 恰为 "***"）都不回写。
      if (key === "api_key" && (!py_truth(value) || py_substr(py_str(value), "…") || value === "***")) {
        continue; // 源 4779 注释：UI 带回来的掩码值 ⇒ 保留真 key
      }
      py_dict_set(current, key, value); // 源 4780（S6-B12：api_key_set 也走这一句）
    }
    const llmModule = seams.llm_client_module(); // 源 4782（四条 import 都在合并循环之后，§D1）
    const memoryModule = seams.memory_layer_module(); // 源 4783
    const goalModule = seams.goal_manager_module(); // 源 4784
    const gitTrustModule = seams.git_trust_module(); // 源 4785
    llmModule.reset_llm_client(); // 源 4786（无 try ⇒ 未接线/抛错冒出 handler）
    const llm = llmModule.get_llm_client(SERVER_STATE._CONFIG); // 源 4787
    try {
      seams.model_registry_module().get_model_registry().seed_from_config(
        py_dict_get(SERVER_STATE._CONFIG, "model", {}), // 源 4790（4776 已保证键存在）
      );
    } catch (exc) {
      void exc; // 源 4791–4792 `except Exception: pass`：fail-open，连 import 失败一起吞
    }
    // 源 4793：三元组**书写顺序**；元素是函数对象本身（端口用函数类型属性建模，§D13）。
    const llm_getters: readonly LlmCallbackGetter[] = [
      memoryModule.get_memory_layer,
      goalModule.get_goal_manager,
      gitTrustModule.get_commit_message_generator,
    ];
    for (const getter of llm_getters) {
      try {
        // 源 4795：`llm.call` 每轮**重新取一次**属性，且取属性就在 try 里
        // ⇒ AttributeError 不被 TypeError 闸兜住（S6-B13）。实参含 llm_callback 键。
        getter({ llm_callback: py_getattr(llm, "call") });
      } catch (exc) {
        if (!catches_classes(exc, TYPE_ERROR_ONLY)) throw exc; // 源 4796–4797
      }
    }
    try {
      const scene = seams.wire_scene_callbacks(llm); // 源 4802（同文件 S9 helper ⇒ 缝，§D9）
      const clients = py_dict_index(scene, "clients"); // 源 4803 下标（缺键 KeyError）
      // 源 4804–4806：每臂各自 `get_xxx()` **零参**调用（坑 1：省略实参，不传 undefined）后写 `._llm`；
      // 场景客户端用下标取（缺键 KeyError）再读 `.call`；整臂被 4807 吞（S6-B14）。
      py_setattr(
        memoryModule.get_memory_layer(),
        "_llm",
        py_getattr(py_dict_index(clients, "memory"), "call"),
      );
      py_setattr(
        goalModule.get_goal_manager(),
        "_llm",
        py_getattr(py_dict_index(clients, "goal"), "call"),
      );
      py_setattr(
        gitTrustModule.get_commit_message_generator(),
        "_llm",
        py_getattr(py_dict_index(clients, "commit"), "call"),
      );
    } catch (exc) {
      void exc; // 源 4807–4808 `except Exception: pass`
    }
    const router = request.app.state.require(ROUTER_KEY); // 源 4809 `request.app[ROUTER_KEY]`（缺键 KeyError）
    py_setattr(router, "llm", llm); // 源 4810
    py_setattr(router, "_base_llm", llm); // 源 4813（源注释：只刷 llm 会让下一轮从旧凭据重建）
    applied.push("model"); // 源 4814
  }

  /* ── 2) permissions（源 4816–4836）：mode 与 auto_confirm_low_risk 两个独立键闸 ── */
  const perm_patch = py_or(py_dict_get(patch, "permissions", null), {}); // 源 4816
  if (py_contains(perm_patch, "mode")) {
    // 源 4817 无类型闸：str 走子串、list 走成员，随后 4823 下标在两者上都是 TypeError（S6-B10）。
    const rcModule = seams.risk_control_module(); // 源 4818（两个名字一条 import）
    const raw = py_dict_index(perm_patch, "mode"); // 源 4823
    if (!py_truth(raw) || !py_truth(py_strip(py_str(raw)))) {
      return json_response({ error: "empty permission mode" }, 400); // 源 4824–4825
    }
    const mode = rcModule.coerce_permission(raw); // 源 4826（源注释 4819–4822：永不抛，非法值回落默认）
    // 源 4827 的求值顺序：CPython `a[k] = v` 先取 a、k 再取 v ⇒ setdefault 的副作用先于 `.value` 读。
    const perms_cfg = py_setdefault(SERVER_STATE._CONFIG, "permissions", {});
    py_dict_set(perms_cfg, "mode", py_getattr(mode, "value"));
    rcModule.get_risk_controller().set_mode(mode); // 源 4828（收枚举对象本身）
    applied.push("permissions"); // 源 4829
  }
  if (py_contains(perm_patch, "auto_confirm_low_risk")) {
    const rcModule2 = seams.risk_control_module(); // 源 4831：**第二条** import 语句 ⇒ 再调一次 getter（§D1）
    const val = py_truth(py_dict_index(perm_patch, "auto_confirm_low_risk")); // 源 4832 bool()（§D10）
    const perms_cfg2 = py_setdefault(SERVER_STATE._CONFIG, "permissions", {}); // 源 4833（键多半已存在）
    py_dict_set(perms_cfg2, "auto_confirm_low_risk", val);
    rcModule2.get_risk_controller().set_auto_confirm_low_risk(val); // 源 4834
    if (!py_contains(applied, "permissions")) {
      applied.push("permissions"); // 源 4835–4836：全函数唯一的 applied 去重（S6-B20）
    }
  }

  /* ── 3) agent（源 4840–4850）：每轮步数上限，热应用到所有存活 router ── */
  const agent_patch = py_or(py_dict_get(patch, "agent", null), {}); // 源 4840
  if (py_contains(agent_patch, "max_steps_per_turn")) {
    let steps: number;
    try {
      // 源 4843 `max(0, int(...))`：int 走 §M py_int（ValueError 装在 TypeError 文案里），
      // 两个操作数恒为 CPython int ⇒ JS Math.max 同结论（§D11）。
      steps = Math.max(0, py_int(py_dict_index(agent_patch, "max_steps_per_turn")));
    } catch (exc) {
      if (!catches_classes(exc, VALUE_OR_TYPE_ERROR)) throw exc; // 源 4844 (TypeError, ValueError)
      return json_response({ error: "invalid max_steps_per_turn" }, 400); // 源 4845
    }
    py_dict_set(
      py_setdefault(SERVER_STATE._CONFIG, "agent", {}), // 源 4846
      "max_steps_per_turn",
      steps,
    );
    // 源 4847：第二次 `app[SESSION_HOST_KEY]` 下标 + `._sessions.values()`（键身份=对象身份）。
    for (const r of py_dict_values(
      py_getattr(request.app.state.require(SESSION_HOST_KEY), "_sessions"),
    )) {
      py_setattr(r, "max_agent_steps", steps); // 源 4848
      // 源 4849：steps>0 时软着陆点是 max(1, steps-2)，否则 -1（"没有软着陆"的哨兵）。
      py_setattr(r, "soft_landing_step", steps > 0 ? Math.max(1, steps - 2) : -1);
    }
    applied.push("agent"); // 源 4850
  }

  /* ── 4) compaction（源 4855–4907）：折叠水位/阈值热应用，钳位口径与 boot 时一致 ── */
  const comp_patch = py_or(py_dict_get(patch, "compaction", null), {}); // 源 4855
  if (py_truth(comp_patch)) {
    const cur = py_setdefault(SERVER_STATE._CONFIG, "compaction", {}); // 源 4857
    for (const key of COMP_KEYS) {
      // 源 4858–4861：六键按元组顺序 `in` 判定后**下标**搬运（键不存在时 py_dict_index 不会走到）。
      if (py_contains(comp_patch, key)) {
        py_dict_set(cur, key, py_dict_index(comp_patch, key));
      }
    }
    let th: number;
    let em: number;
    try {
      // 源 4863–4864：th ∈ [0.50, 0.95]，em ∈ [th, 0.98]（emergency 永远不低于 threshold）。
      th = Math.min(0.95, Math.max(0.5, py_float(py_dict_get(cur, "threshold", 0.8))));
      em = Math.min(0.98, Math.max(th, py_float(py_dict_get(cur, "emergency_threshold", 0.9))));
    } catch (exc) {
      if (!catches_classes(exc, VALUE_OR_TYPE_ERROR)) throw exc; // 源 4865
      th = 0.8;
      em = 0.9; // 源 4866 元组回落 th, em = 0.80, 0.90
    }
    // 源 4867 元组赋值 ⇒ 两个写按书写顺序落。
    py_dict_set(cur, "threshold", th);
    py_dict_set(cur, "emergency_threshold", em);
    let cd: number;
    let mx: number;
    let mt: number;
    try {
      // 源 4869–4871：cd >= 0.0、mx >= 1、mt >= 8000（坏值整支回落 15.0 / 5 / 80000，源 4872–4873）。
      cd = Math.max(0.0, py_float(py_dict_get(cur, "cooldown_s", 15.0)));
      mx = Math.max(1, py_int(py_dict_get(cur, "max_consecutive", 5)));
      mt = Math.max(8000, py_int(py_dict_get(cur, "max_tokens", 80000)));
    } catch (exc) {
      if (!catches_classes(exc, VALUE_OR_TYPE_ERROR)) throw exc;
      cd = 15.0;
      mx = 5;
      mt = 80000;
    }
    py_dict_set(cur, "cooldown_s", cd);
    py_dict_set(cur, "max_consecutive", mx);
    py_dict_set(cur, "max_tokens", mt); // 源 4874 三元组赋值
    const floor_set = py_contains(comp_patch, "reserve_tokens_floor"); // 源 4876（显式传入才写，4875 注释）
    let fl: number;
    if (floor_set) {
      try {
        // 源 4879：fl = max(0, min(int(...), mt // 2))——地板除到"半窗"；
        // mt 恒为 >= 8000 的非负 int ⇒ Math.floor 与 CPython // 同结论（§D11）。
        fl = Math.max(0, Math.min(py_int(py_dict_get(cur, "reserve_tokens_floor", 0)), Math.floor(mt / 2)));
      } catch (exc) {
        if (!catches_classes(exc, VALUE_OR_TYPE_ERROR)) throw exc; // 源 4880
        fl = 0; // 源 4881
      }
      py_dict_set(cur, "reserve_tokens_floor", fl); // 源 4882
    } else {
      try {
        // 源 4884–4887：else 支把 fl 算出来却**从不使用**（S6-B16 死计算，照抄不删）。
        fl = py_int(py_dict_get(cur, "reserve_tokens_floor", 0));
      } catch (exc) {
        if (!catches_classes(exc, VALUE_OR_TYPE_ERROR)) throw exc; // 源 4886
        fl = 0; // 源 4887
      }
    }
    // 源 4888–4895：**整支无 try**（S6-B15）——第三次读 app 状态（每次循环重新 require，
    // 每条属性写重新 getattr，与源每轮重新求值 `r.compactor` 同位）。
    for (const r of py_dict_values(
      py_getattr(request.app.state.require(SESSION_HOST_KEY), "_sessions"),
    )) {
      // 源 4889–4895 每条语句**各自**重新求值 `r.compactor`（5 次，floor_set 时 6 次）⇒ 端口用 cp()
      // 逐条取，绝不把结果缓存成一次读取（单例/描述符的 getattr 次数是探针可观察面，同 S6-B17）。
      const cp = (): unknown => py_getattr(r, "compactor");
      py_setattr(cp(), "threshold", th);
      py_setattr(cp(), "emergency_threshold", em);
      py_setattr(cp(), "cooldown_s", cd);
      py_setattr(cp(), "max_consecutive", mx);
      py_setattr(cp(), "max_tokens", mt);
      if (floor_set) {
        py_setattr(cp(), "reserve_tokens_floor", fl); // 源 4894–4895
      }
    }
    try {
      // 源 4896–4904：每条赋值**各自**再取一次全局单例（S6-B17：观察面是 get_compactor() 的次数）。
      const ccModule = seams.context_compactor_module(); // 源 4897（import 在这只 try 里面）
      py_setattr(ccModule.get_compactor(), "threshold", th);
      py_setattr(ccModule.get_compactor(), "emergency_threshold", em);
      py_setattr(ccModule.get_compactor(), "cooldown_s", cd);
      py_setattr(ccModule.get_compactor(), "max_consecutive", mx);
      py_setattr(ccModule.get_compactor(), "max_tokens", mt);
      if (floor_set) {
        py_setattr(ccModule.get_compactor(), "reserve_tokens_floor", fl); // 源 4903–4904
      }
    } catch (exc) {
      void exc; // 源 4905–4906 `except Exception: pass`（与 S6-B15 的无兜底并存，S6-B18）
    }
    applied.push("compaction"); // 源 4907
  }

  /* ── 5) telemetry（源 4909–4915）── */
  const telemetry_patch = py_or(py_dict_get(patch, "telemetry", null), {}); // 源 4909
  if (py_contains(telemetry_patch, "enabled")) {
    const val = py_truth(py_dict_index(telemetry_patch, "enabled")); // 源 4911 bool()（§D10）
    py_dict_set(
      py_setdefault(SERVER_STATE._CONFIG, "telemetry", {}), // 源 4912（先写 config）
      "enabled",
      val,
    );
    const telemetryModule = seams.telemetry_module(); // 源 4913（import 在 config 写**之后**，§D1）
    py_setattr(telemetryModule.get_telemetry(), "enabled", val); // 源 4914 setattr（§D13）
    applied.push("telemetry"); // 源 4915
  }

  /* ── 6) memory（源 4917–4926）：整段 update + master switch 运行期生效 ── */
  const memory_patch = py_or(py_dict_get(patch, "memory", null), {}); // 源 4917
  if (py_truth(memory_patch)) {
    py_dict_update(py_setdefault(SERVER_STATE._CONFIG, "memory", {}), memory_patch); // 源 4919（S6-B19）
    if (py_contains(memory_patch, "enabled")) {
      const memoryModule2 = seams.memory_layer_module(); // 源 4924：**第二条** memory_layer import
      // 源 4925：零参 get_memory_layer()（坑 1）→ set_enabled(bool(...)) → await（§D14）。
      await memoryModule2.get_memory_layer().set_enabled(py_truth(py_dict_index(memory_patch, "enabled")));
    }
    applied.push("memory"); // 源 4926
  }

  /* ── 7) workspace（源 4928–4931）：纯 config 合并，无任何热应用臂 ── */
  const workspace_patch = py_or(py_dict_get(patch, "workspace", null), {}); // 源 4928
  if (py_truth(workspace_patch)) {
    py_dict_update(py_setdefault(SERVER_STATE._CONFIG, "workspace", {}), workspace_patch); // 源 4930
    applied.push("workspace"); // 源 4931
  }

  /* ── 8) shadow（源 4933–4938）：归一化交 shadow_config，再合并 ── */
  const shadow_patch = py_or(py_dict_get(patch, "shadow", null), {}); // 源 4933
  if (py_truth(shadow_patch)) {
    const apply_shadow_patch = seams.shadow_config_module().apply_patch; // 源 4935（import 别名）
    const normalized = apply_shadow_patch(shadow_patch); // 源 4936（返回值不验类型，S6-B19）
    py_dict_update(py_setdefault(SERVER_STATE._CONFIG, "shadow", {}), normalized); // 源 4937
    applied.push("shadow"); // 源 4938
  }

  /* ── 9) 落盘与响应（源 4940–4945）── */
  try {
    _persist_config(seams); // 源 4941（S6a helper 复用：open+dump+replace 全走缝，零真写盘）
  } catch (exc) {
    if (!catches_oserror(exc)) throw exc; // 源 4942 `except OSError as e`（窄兜，S6-B21；§D12）
    return json_response({ error: `could not persist: ${exc_str(exc)}` }, 500); // 源 4943（`{e}`=str(e)，§D15）
  }
  // 源 4945：applied 是分支顺序数组；settings 走 S6a 的 _redact（与 GET 同一份掩码实现）。
  return json_response({ applied, settings: _redact(SERVER_STATE._CONFIG) });
}

/* ══════════════════════════════════════════════════════════════════════════
 * §S6c tools / subagents 六 handler（源 4948–5212）
 *
 * 源 4970–4978 的段落横幅注释（Sub-agents 一节）随本批一并移植，放在
 * handle_subagents_list 之前——它解释的是"为什么这些端点在 HTTP 而不在 WS"：
 * 流只带状态迁移、不带当前态，晚连接/中途 reload 的客户端需要一个"现在有什么在跑"
 * 的快照面，外加一个"掐掉失控子代但不 abort 父轮"的动作面。
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * GET /api/tools #79（源 4948–4967）。
 * 把工具目录 + 风险等级摊给设置页：4950–4951 两条函数级 import 在体首（无 try，未接线
 * ModuleNotFoundError 冒出 handler，§D1）；4954–4962 的列表推导逐工具建四键 dict——
 * **`t.name` 读两次**（4956 的 "name" 键、4959 的 classify_risk 实参），getattr 次数是
 * 探针可观察面 ⇒ 端口不缓存成一次读（S6-B17 同法）；`classify_risk(t.name, {})` 的第二
 * 实参是**字面空 dict**。4964 `sorted(tools, key=lambda x: (x["domain"], x["name"]))` 是
 * 元组键稳定排序（§0 py_sorted）；4965 `controller.mode.value` 双层属性；4966 `len(tools)`。
 */
export async function handle_get_tools(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  void request;
  const toolsModule = seams.tools_module(); // 源 4950
  const rcModule = seams.risk_control_module(); // 源 4951
  const registry = toolsModule.get_tool_registry(); // 源 4952
  const controller = rcModule.get_risk_controller(); // 源 4953
  const tools: JsonDict[] = [];
  for (const t of py_iter(registry.list_tools())) {
    // 源 4954–4962：dict 字面量四键，**书写顺序** name/domain/description/riskLevel。
    tools.push({
      name: py_getattr(t, "name"), // 第 1 次读 t.name（源 4956）
      domain: py_getattr(t, "domain"), // 源 4957
      description: py_getattr(t, "description"), // 源 4958
      // 源 4959：第 2 次读 t.name；`.value` 是枚举双层属性（缺失 → AttributeError 冒出，无 try）。
      riskLevel: py_getattr(controller.classify_risk(py_getattr(t, "name"), {}), "value"),
    });
  }
  return json_response({
    // 源 4964：键元组 (x["domain"], x["name"])——**下标**面（刚建的 dict，键必在）。
    tools: py_sorted(tools, (x) => [
      py_map_index(x, "domain") as string,
      py_map_index(x, "name") as string,
    ]),
    mode: py_getattr(py_getattr(controller, "mode"), "value"), // 源 4965
    count: py_len(tools), // 源 4966（§0 py_len：list 面）
  });
}

/* ─── Sub-agents (the ``task`` tool's control surface) ───────────（源 4970–4978）
 * WS 已经在流 `subagent_state` 迁移，够**渲染**进度；这些端点存在是为了流做不到的两件事：
 *   · 给晚连接/中途 reload 的客户端回答"现在到底有什么在跑"（流只带迁移、不带当前态）
 *   · 对运行中的子代**动手**——掐掉一个失控的 explorer 而不 abort 整个父轮
 * 留在 HTTP 而不是 WS，是为了让 CLI 或测试假件也能直接驱动它们。（源注释转述）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/subagents #83（源 4980–5033）。
 * 双源合并名册：内存 runtime 是活体的真相，盘上账本（storage ledger）补齐已过期/上一进程
 * 遗留的运行记录；**id 撞车时内存记录永远赢**（docstring 4989–4991 原话：它不会比账本更旧）。
 * 逐点：
 *  - 4993–4996 两条 import 在体首；`MAX_CONCURRENT_SUBAGENTS` 是 from-import **值绑定**，
 *    端口在 import 位点读属性存本地（§D18）。
 *  - 5000 `seen = {r["subagentId"] for r in live}` 在 try **之外**：live 记录缺键 → KeyError
 *    冒出 handler（账本兜底 5024 罩不到它）。
 *  - 5003–5023 账本合并整支被 5024 `except Exception: pass` 罩住（"读账本失败不能把活体
 *    名册抹白"）⇒ 支内一切异常（含 5004 下标的 KeyError、5019 py_int 的 ValueError 面）
 *    都中止合并、保留已 append 的部分行——源行为，逐字保留。
 *  - 5019 `int(((finished or base) - base) * 1000) if base else 0`：非数值账本值在源是
 *    TypeError、在端口 NaN 死在 py_int——**同一行**冒进同一只 except，结论同位（§D21）。
 *  - 5026 `rows.sort(key=..., reverse=True)`：§0 py_sorted 取负键升序模拟（§D21）。
 *  - 5029 `r["status"]` 是**下标**且在 try 之外——活体/自建行都保证有该键，缺即冒。
 */
export async function handle_subagents_list(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const saModule = seams.subagent_runtime_module(); // 源 4993–4995（一条 import 三个名字 ⇒ 一次 getter）
  const maxConcurrent = saModule.MAX_CONCURRENT_SUBAGENTS; // 源 4994 的值绑定位（§D18）
  const storageModule = seams.storage_module(); // 源 4996
  const runtime = saModule.get_subagent_runtime(); // 源 4997
  const session_id = request.query.get("session_id", ""); // 源 4998
  const live = runtime.list_sessions(session_id); // 源 4999
  const seen = new Set<unknown>(); // 源 5000 set 推导
  for (const r of py_iter(live)) {
    seen.add(py_map_index(r as JsonDict, "subagentId")); // **下标**读（try 之外，缺键即冒）
  }
  const rows: JsonDict[] = live.slice() as JsonDict[]; // 源 5001 list(live) 浅拷贝（live 的 dict 形状由 runtime 契约保证）
  try {
    for (const r of py_iter(storageModule.get_storage().list_subagent_runs(session_id))) {
      const row = r as JsonDict;
      if (seen.has(py_dict_index(row, "subagent_id"))) {
        continue; // 源 5004–5005：内存记录赢（id 撞车跳账本行）
      }
      const started = py_or(py_dict_get(row, "started_at", null), 0); // 源 5006
      const finished = py_or(py_dict_get(row, "finished_at", null), 0); // 源 5007
      const base = py_or(started, py_or(py_dict_get(row, "created_at", null), 0)); // 源 5008
      const fob = py_or(finished, base); // 源 5019 内层 `(finished or base)`
      rows.push({
        subagentId: py_dict_index(row, "subagent_id"), // 源 5010 下标
        subagentType: py_or(py_dict_get(row, "subagent_type", null), ""), // 源 5011
        // 源 5012：label 回落 subagent_type 再回落 ""（两级 or）。
        label: py_or(py_dict_get(row, "label", null), py_or(py_dict_get(row, "subagent_type", null), "")),
        parentSessionId: py_or(py_dict_get(row, "parent_session_id", null), ""), // 源 5013
        childSessionId: py_or(py_dict_get(row, "child_session_id", null), ""), // 源 5014
        status: py_or(py_dict_get(row, "status", null), ""), // 源 5015
        createdAt: py_or(py_dict_get(row, "created_at", null), 0), // 源 5016
        startedAt: py_or(started, null), // 源 5017 `started or None`（0 ⇒ None）
        finishedAt: py_or(finished, null), // 源 5018
        // 源 5019：base 为假整支 0；`(finished or base) - base` 的数值强制面见 §D21。
        elapsedMs: py_truth(base) ? py_int(((fob as number) - (base as number)) * 1000) : 0,
        resultChars: py_or(py_dict_get(row, "result_chars", null), 0), // 源 5020
        error: py_or(py_dict_get(row, "error", null), ""), // 源 5021
        persisted: true, // 源 5022（注释：来自账本而非活体 map）
      });
    }
  } catch (exc) {
    void exc; // 源 5024–5025 `except Exception: pass`（noqa BLE001）
  }
  // 源 5026：createdAt 降序、等键保持先入序（list.sort 稳定；reverse=True 不翻等键）。
  const sortedRows = py_sorted(rows, (r) => [
    -(py_or(py_dict_get(r, "createdAt", null), 0) as number),
  ]);
  let active = 0; // 源 5029 sum(1 for ...)：元组 ("spawning","running") 成员判定走 §0 py_contains
  for (const r of py_iter(sortedRows)) {
    if (py_contains(["spawning", "running"], py_map_index(r as JsonDict, "status"))) {
      active += 1;
    }
  }
  return json_response({
    subagents: sortedRows,
    active,
    maxConcurrent, // 源 5030
    // 源 5031–5032：单父会话子代上限（设置页可调），面板据此显示「活跃 X / 上限 Y」。
    maxChildrenPerAgent: saModule.get_max_children_per_agent(),
  });
}

/**
 * POST /api/subagents/{id}/kill #87（源 5036–5057）。
 * docstring 5038–5045 两条源承诺：① 幂等向——杀**已完成**的子代回 404 而不是假成功，
 * 双击的 UI 因此能学到"活已经干完了"；② 状态**不在这里**翻——`SubagentRuntime.kill` 只
 * 请求取消，终态由子代自己的 except 分支写；终态单写者 ⇒ `subagent_state` 流与本端点
 * 永不打架。端口照做：只转发 kill 的返回值做真值判定，不写任何状态。
 */
export async function handle_subagent_kill(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const saModule = seams.subagent_runtime_module(); // 源 5047
  const subagent_id = request.match_info.get("id", ""); // 源 5048（.get 面，非 4684 的下标面）
  if (!py_truth(subagent_id)) {
    return json_response({ error: "id required" }, 400); // 源 5050
  }
  const killed = saModule.get_subagent_runtime().kill(subagent_id); // 源 5051
  if (!py_truth(killed)) {
    // 源 5053–5055：f-string 里是**单引号裹 id**，文案逐字。
    return json_response(
      { error: `sub-agent '${subagent_id}' is unknown or already finished` },
      404,
    );
  }
  return json_response({ ok: true, subagentId: subagent_id }); // 源 5057
}

/**
 * POST /api/subagents/kill-all #86（源 5060–5087）。
 * docstring 5061–5064：一键停掉**一个父会话**的全部活体子代（"明显跑歪了的扇出"的停止钮）；
 * `session_id` 必填——进程级 kill 开关会让一个窗口 abort 另一个窗口的活。逐点：
 *  - 5067–5070 `except Exception: data = {}`（**无族过滤**、解析失败回落空 dict——#69 的
 *    吞面 + 这里连 400 都不给，坏 body 静默按"没传字段"处理；与 S6-B24 同族，文案面无）。
 *  - 5071 session_id 三级 or 链（body→query→""）后 strip；5074 graceful 四级链
 *    （body→query→"1"）经 `str().strip().lower()`——**默认优雅**。
 *  - 5075 `not in ("0","false","no")`：元组成员判定（§0 py_contains）。
 *  - 5078 `await runtime.kill_all_graceful(...)` 是协程 ⇒ 端口统一 await（§D14 同法）；
 *    `killed`/`requested` 的 .get 带默认 0，**request_id 不带默认**（缺 ⇒ null 进响应，源 5084）。
 *  - 5086–5087 非优雅支：同步 kill_all 计数直接回。
 */
export async function handle_subagents_kill_all(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const saModule = seams.subagent_runtime_module(); // 源 5066（在 json-try **之前**，与 #69 同侧）
  let data: JsonDict;
  try {
    data = await request.json(); // 源 5068
  } catch (exc) {
    void exc; // 源 5069–5070 except Exception：**一切**异常吞成 {}（不验类型面同 D16，query 缺省 None/"" 皆假值 ⇒ 结论同）
    data = {};
  }
  // 源 5071 三级 or 链后 strip：§M py_strip_or 就是 `(v or "").strip()` 的组合面
  // （非 str 值 → AttributeError，与源 `(123).strip` 同面；query 缺省 None/"" 皆假值 ⇒ 结论同）。
  const session_id = py_strip_or(
    py_or(py_dict_get(data, "session_id", null), request.query.get("session_id")),
  );
  if (!py_truth(session_id)) {
    return json_response({ error: "session_id required" }, 400); // 源 5073
  }
  const graceful = py_strip(
    py_str(py_or(py_or(py_dict_get(data, "graceful", null), request.query.get("graceful")), "1")),
  ).toLowerCase(); // 源 5074（.lower() → toLowerCase，D2 同理论证）
  const use_graceful = !py_contains(["0", "false", "no"], graceful); // 源 5075
  const runtime = saModule.get_subagent_runtime(); // 源 5076
  if (use_graceful) {
    const result = (await runtime.kill_all_graceful(session_id)) as JsonDict; // 源 5078（§D14）
    return json_response({
      ok: true,
      graceful: true,
      killed: py_dict_get(result, "killed", 0), // 源 5082
      requested: py_dict_get(result, "requested", 0), // 源 5083
      requestId: py_dict_get(result, "request_id", null), // 源 5084（**无默认** → None → null）
    });
  }
  const n = runtime.kill_all(session_id); // 源 5086
  return json_response({ ok: true, graceful: false, killed: n }); // 源 5087
}

/**
 * GET /api/subagents/types #84（源 5090–5097）。
 * docstring：给 UI 选择器/文档页看的可用子代人设清单。**每次请求先 reload**（5093）——
 * 用户手写的 YAML 立刻可见。一条 import 两个名字 ⇒ 一次 getter（§D1）；
 * `registry.values()` 走 §0 py_dict_values（registry 建模成 name→def 普通 dict，§D20），
 * 每个 def 的 `to_public()` 走 §0 py_call0（绑定方法面）。
 */
export async function handle_subagent_types(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  void request;
  const registryModule = seams.subagent_registry_module(); // 源 5092
  registryModule.reload_subagent_defs(); // 源 5093
  const registry = registryModule.get_subagent_registry(); // 源 5094
  const types: unknown[] = [];
  for (const d of py_dict_values(registry)) {
    types.push(py_call0(d, "to_public")); // 源 5096
  }
  return json_response({ types });
}

/**
 * PATCH /api/subagents/types/{name} #85（源 5101–5212，本段最大单函数，112 源行）。
 * docstring 5102–5108 原话要点：把人设级的 model 覆盖（和/或 max_turns）持久化到 YAML——
 * registry 在 boot 时把用户 YAML 合进内置人设，写 `app/backend/subagents/_ui_overrides.yaml`
 * （源注释这么写，实际路径见 5159：**每 persona 一个文件** `_ui_override_{name}.yaml`）
 * 让"coder 用模型 X"这种选择跨重启存活、且出现在每个选择器里而不用重编预设表；
 * `model` 传 null/空串 ⇒ **清掉**覆盖（回落 inherit-parent）。
 * 死路一族（照抄，S6-B22/B23/B24/B25）：storage 死 import、`override` 全程没人读、
 * except-Exception-但-大写-JSON 文案、model_policy 的 lower() 算两遍。
 * 逐段（源行号）：
 *  - 5110 import registry 模块面；5111 **死 import** storage（S6-B22：getter 照调、值丢弃）；
 *    5112–5113 `import os` / `import yaml` 与 5187 `import tempfile` 是模块面无副作用，其**调用行**各自同位走缝（§D19）。
 *  - 5115–5118：match_info 的 name；`name not in registry` → 404 f"unknown persona: {name}"。
 *  - 5120–5123：json try（except Exception → 400 "invalid JSON"，S6-B24）。
 *  - 5126–5132：model 给了**且不是空串**才校验——5128 才 import model_registry（同位），
 *    `reg.resolve(model).ok` 假 → 422 f"unknown model: {model}"（`{model}` 是 str 面 ⇒ py_str）。
 *  - 5133–5134：max_turns；model_policy 双键收（snake 优先 camel，or 链）。
 *  - 5136–5149：`override` 构建——**S6-B23 死计算**，但 5140–5143 的 422（policy 枚举面）与
 *    5146–5149 的 422（int 面）是它唯一的可观察效果，校验顺序/文案逐字。
 *  - 5155–5198 写盘大 try：5156–5157 目录面 = abspath(join(dirname(__file__), "..", "subagents"))
 *    （__file__ 面复用 S6a 的 abspath_module_file seam，§D19 登记近似）；5158 makedirs；
 *    5163–5178 doc 从**活体 def** 播种（每个属性读在条件与赋值处**各读一次**，源的 getattr
 *    次数面，S6-B17 同法不合并）；5180–5185 patch 覆盖层（5183 重算 lower，S6-B25；
 *    5185 的 int() 与 5147 是**第二次**求值，S6-B23 尾注）；5187–5198 tmp+rename 原子面：
 *    mkstemp → fd 写 yaml → os.replace，任一步炸 ⇒ unlink 清理（except OSError **窄兜** pass，
 *    非 OSError 的清理失败**替换**原异常——CPython 在 except 块内抛新的即弃旧，照抄）→ bare raise。
 *  - 5199–5200：外层 `except Exception as e` → 500 f"could not persist: {e}"（`{e}`=str(e)，
 *    与 S6b 4943 同款文案；但这里是**宽兜**——连 py_int/序列化/NameError 形状全进 500，
 *    与 S6-B21 的窄兜并存，两种容错姿势同族再现）。
 *  - 5203–5212：**第二条** registry import 语句（只要 reload_subagent_defs）⇒ 第二次 getter
 *    （§D1）；reload 后**重新取**单例（5206，用的是 5110 的绑定名），响应三键
 *    ok/type/types——type 是 updated.to_public() if updated else None（updated 已被 reload
 *    换掉也无妨：源就是这么写的，读的是**新** registry 的行）。
 */
export async function handle_subagent_type_update(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const registryModule = seams.subagent_registry_module(); // 源 5110
  seams.storage_module(); // 源 5111：死 import（S6-B22）——getter 照调、绑定名从不使用
  // 源 5112–5113 `import os` / `import yaml`：无副作用的模块面；调用行 5156–5195 各自同位走缝。
  const name = request.match_info.get("name", ""); // 源 5115
  const registry = registryModule.get_subagent_registry(); // 源 5116（第 1 次 get_subagent_registry）
  if (!py_contains(registry, name)) {
    // 源 5117 `name not in registry`（dict 键面，§0 py_contains）→ 404。
    return json_response({ error: `unknown persona: ${name}` }, 404); // 源 5118
  }
  let patch: JsonDict;
  try {
    patch = await request.json(); // 源 5121
  } catch (exc) {
    void exc; // except Exception（5122）无族过滤，文案却用大写 J —— S6-B24
    return json_response({ error: "invalid JSON" }, 400); // 源 5123
  }

  // 源 5126–5132：给了 model 且**不是空串**才对着 provider 目录验（空串是"清除"指令，不验）。
  const model = py_dict_get(patch, "model", null); // 源 5126（patch 非 dict 的面同 D16）
  if (!py_is_none(model) && model !== "") {
    const reg = seams.model_registry_module().get_model_registry(); // 源 5128–5129（校验通过前不 import，§D1）
    if (!py_truth(py_getattr(reg.resolve(model as string), "ok"))) {
      return json_response({ error: `unknown model: ${py_str(model)}` }, 422); // 源 5131–5132
    }
  }
  const max_turns = py_dict_get(patch, "max_turns", null); // 源 5133
  const model_policy = py_or(
    py_dict_get(patch, "model_policy", null),
    py_dict_get(patch, "modelPolicy", null),
  ); // 源 5134：snake 优先、camel 兜底（or 链）

  /* 源 5136–5149：`override` 全程构建却从未被读（S6-B23）——只有其中的 422 早退可观察。 */
  const override: JsonDict = { name: name }; // 源 5136 `override: dict = {"name": name}`
  if (!py_is_none(model)) {
    py_dict_set(override, "model", py_truth(model) ? model : null); // 源 5137–5138（"" ⇒ None 清除）
  }
  if (!py_is_none(model_policy)) {
    const policy = py_strip(py_str(model_policy)).toLowerCase(); // 第 1 次 lower 面（源 5140，与 5183 各算一次，S6-B25）
    if (!py_contains(["main", "economy"], policy)) {
      return json_response({ error: "model_policy must be main or economy" }, 422); // 源 5142–5143
    }
    py_dict_set(override, "model_policy", policy); // 源 5144
  }
  if (!py_is_none(max_turns)) {
    try {
      py_dict_set(override, "max_turns", Math.max(1, py_int(max_turns))); // 源 5147（第 1 次 int 面）
    } catch (exc) {
      if (!catches_classes(exc, VALUE_OR_TYPE_ERROR)) throw exc; // 源 5148 (TypeError, ValueError)
      return json_response({ error: "max_turns must be an integer" }, 422); // 源 5149
    }
  }

  /* 源 5155–5200：写盘 + 原子换名大 try（外层 except Exception → 500，宽兜，见函数头注）。 */
  try {
    // 源 5156–5157：os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "subagents"))。
    // __file__ 面复用 S6a 的 abspath_module_file()（dirname(abspath(f)) ≡ abspath 归一后的
    // dirname(f) 目录，端口近似登记 §D19）；多参 join 拆二元（§M os_path_join，同 _config_path）。
    const subs_dir = seams.os_path_abspath(
      os_path_join(
        os_path_join(os_path_dirname(seams.abspath_module_file()), ".."),
        "subagents",
      ),
    );
    seams.fs_makedirs(subs_dir); // 源 5158（exist_ok=True）
    const path = os_path_join(subs_dir, `_ui_override_${name}.yaml`); // 源 5159（f-string 等价拼接，D7 同法）

    // 源 5162：cur = registry.get(name)（5117 的 in 闸保证命中；reload 竞态下源可回 None ⇒ 走 else）。
    const cur = py_dict_get(registry, name, null);
    // 源 5163–5167 doc 播种（`_parse_yaml_def` 要求单文件是一个带 system_prompt 的完整 dict，
    // 5151–5154 源注释原话）：三键**书写顺序**。
    const doc: JsonDict = {
      name: name,
      description: py_truth(cur) ? py_getattr(cur, "description") : "",
      system_prompt: py_truth(cur) ? py_getattr(cur, "system_prompt") : "",
    };
    // 源 5168–5169：allowed_tools 存在且**非空**才写，且写 sorted() 副本（两次 getattr，S6-B17 同法）。
    if (py_truth(cur) && py_truth(py_getattr(cur, "allowed_tools"))) {
      py_dict_set(
        doc,
        "allowed_tools",
        py_sorted(py_iter(py_getattr(cur, "allowed_tools")), (x) => [x as string]), // 源 5169 sorted(...)
      );
    }
    if (py_truth(cur) && py_truth(py_getattr(cur, "permission"))) {
      py_dict_set(doc, "permission", py_getattr(cur, "permission")); // 源 5170–5171（原样引用，不拷贝——同 CPython）
    }
    if (py_truth(cur) && py_truth(py_getattr(cur, "handoffs"))) {
      py_dict_set(
        doc,
        "handoffs",
        py_sorted(py_iter(py_getattr(cur, "handoffs")), (x) => [x as string]), // 源 5172–5173
      );
    }
    // 源 5174–5178：`if cur:` 罩里的两个条件写——model **is not None** 才写（写 None 是有意的
    // "显式继承"面），model_policy 走真值。属性在条件与赋值处各读一次（getattr 次数面）。
    if (py_truth(cur)) {
      if (!py_is_none(py_getattr(cur, "model"))) {
        py_dict_set(doc, "model", py_getattr(cur, "model"));
      }
      if (py_truth(py_getattr(cur, "model_policy"))) {
        py_dict_set(doc, "model_policy", py_getattr(cur, "model_policy"));
      }
    }
    // 源 5180–5185：patch 覆盖层叠在播种之上（5179 源注释）。
    if (!py_is_none(model)) {
      py_dict_set(doc, "model", py_truth(model) ? model : null); // 源 5180–5181（"" ⇒ None：清除落盘）
    }
    if (!py_is_none(model_policy)) {
      // 源 5182–5183：**重算** str().strip().lower()，不复用 5140 的 policy（S6-B25）。
      py_dict_set(doc, "model_policy", py_strip(py_str(model_policy)).toLowerCase());
    }
    if (!py_is_none(max_turns)) {
      // 源 5184–5185：**第二次** max(1, int(...))（S6-B23 尾注）——这里炸了没有窄 try，
      // 直接进外层 except Exception → 500（源可达面：5147 验过 ⇒ 实际不可达，照抄不删）。
      py_dict_set(doc, "max_turns", Math.max(1, py_int(max_turns)));
    }

    // 源 5187–5188：tempfile.mkstemp(dir=subs_dir, suffix=".yaml") → (fd, path) 元组。
    const [fd, tmpPath] = seams.mkstemp(subs_dir, ".yaml");
    try {
      // 源 5190–5191：os.fdopen(fd,"w",encoding="utf-8") + yaml.safe_dump(doc, f,
      // allow_unicode=True, sort_keys=False) ⇒ 序列化面走缝 yaml_dump、句柄面折进 fd_write_text（§D19）。
      seams.fd_write_text(fd, seams.yaml_dump(doc));
      seams.os_replace(tmpPath, path); // 源 5192（原子换名，S6a 同臂复用）
    } catch (writeError) {
      // 源 5193 `except BaseException:`——JS 无 Exception/BaseException 分层，catch 全收即端口面
      // （KeyboardInterrupt 深支在端口不可达，登记 §D19）；清理 + bare raise（5198）。
      let cleanupError: unknown;
      let cleanupFailed = false;
      try {
        seams.os_unlink(tmpPath); // 源 5195
      } catch (e2) {
        if (!catches_oserror(e2)) {
          // 源 5196–5197 `except OSError: pass` **窄兜**：非 OSError 的清理失败替换原异常往外抛。
          cleanupError = e2;
          cleanupFailed = true;
        }
      }
      if (cleanupFailed) throw cleanupError;
      throw writeError; // 源 5198 bare raise
    }
  } catch (e) {
    // 源 5199–5200：外层 except Exception as e → 500。`{e}` 是 str(e)（§M exc_str，D15 同法）。
    return json_response({ error: `could not persist: ${exc_str(e)}` }, 500);
  }

  // 源 5203：**第二条** subagent_registry import 语句（只要 reload_subagent_defs）⇒ 第二次 getter。
  const registryModule2 = seams.subagent_registry_module();
  registryModule2.reload_subagent_defs(); // 源 5204
  const registry2 = registryModule.get_subagent_registry(); // 源 5206（5110 的绑定名，第二次取单例——reload 后的新世界）
  const updated = py_dict_get(registry2, name, null); // 源 5207 registry.get(name)
  // 源 5208–5212：dict 字面量**按书写序**求值 ⇒ `type` 的 to_public()（5210）先于
  // `types` 的列表推导（5211）——to_public 的**调用顺序**是探针可观察面，故端口把 5210
  // 单独提在循环之前求值，而不是先建数组再回填（S6-B17 同法：不重排、不合并）。
  const publicType = py_truth(updated) ? py_call0(updated, "to_public") : null; // 源 5210
  const types: unknown[] = [];
  for (const d of py_dict_values(registry2)) {
    types.push(py_call0(d, "to_public")); // 源 5211
  }
  return json_response({ ok: true, type: publicType, types });
}

/* ══════════════════════════════════════════════════════════════════════════
 * §S6d rollback / checkpoint / events / session-log 十一 handler（源 5224–5410）
 *
 * 源 5216–5222 的段落横幅（Rollback 一节）随本批移植，见 handle_rollback_list 之前；
 * 源 5254–5260（Session timeline / UB1）与 5330（Event-Sourced Runtime）各在其节首。
 * 三段共同的设计意图（源注释原话转述）：**HTTP 侧只读 / 只回滚文件**，
 * 聊天历史的回退留在 WS（`session_truncate`），这样"一次撤销"的两半共用同一个形状、
 * 只在**一个地方**发生；`seq` 是两半共用的检查点键。
 * ══════════════════════════════════════════════════════════════════════════ */

/* ─── Rollback (per-step file snapshots) ────────────────────────（源 5216–5222）
 * 列出并还原 `snapshot_store` 在**每个会改文件的工具跑之前**抓的前像（pre-image）。
 * 聊天历史那一半留在 WS（`session_truncate`），好让一次原子撤销的两半共用同一个形状；
 * HTTP 这一半放在这里，是为了让外部工具（CLI、测试假件）**不带 WS 会话**也能查看和回滚。
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/rollback #88（源 5224–5235）。
 * docstring：列出某会话 **seq 之后**（含）的快照；seq 省略 ⇒ 全部。逐点：
 *  - 5226 `request.app[ROUTER_KEY]` 是**下标**（缺键 KeyError 冒出，无 try）；
 *  - 5227 的 `or` 短路：query 给了 sessionId 就**不读** `router.session_id`（§D22）；
 *  - 5228 的 `.get("seq", "0")` 默认值是**字符串** "0"（与 5338 的 int 0 不同，见 §D25 旁注）；
 *  - 5229–5232 只兜 `(TypeError, ValueError)` ⇒ 400 "seq must be an integer"（S6-B26 的 query 侧姿势）；
 *  - 5233 的 import 在 seq 验完**之后** ⇒ 坏 seq 的 400 **不触** snapshot_store 缝（§D1，探针面）；
 *  - 5234–5235 `list_since(sid, seq)` 的返回值**原样**进响应（不逐个加工、不验形状）。
 */
export async function handle_rollback_list(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const router = request.app.state.require(ROUTER_KEY); // 源 5226（下标面：缺键 KeyError）
  const qSid = request.query.get("sessionId"); // 源 5227 左操作数
  const sid = py_truth(qSid) ? qSid : py_getattr(router, "session_id"); // or 短路（§D22）
  const seq_raw = request.query.get("seq", "0"); // 源 5228（**带默认** "0"）
  let seq: number;
  try {
    seq = py_int(seq_raw); // 源 5230
  } catch (exc) {
    if (!catches_classes(exc, VALUE_OR_TYPE_ERROR)) throw exc; // 源 5231 (TypeError, ValueError)
    return json_response({ error: "seq must be an integer" }, 400); // 源 5232
  }
  const rows = seams.snapshot_store_module().get_snapshot_store().list_since(sid, seq); // 源 5233–5234
  return json_response({ sessionId: sid, seq, snapshots: rows }); // 源 5235（seq 是 int() 之后的值）
}

/**
 * POST /api/rollback #89（源 5238–5251）。
 * docstring：把某会话 seq 之后（含）的**全部**快照按**由新到旧**还原（还原顺序由 store 决定，本函数不参与）。
 *  - 5241–5244 `except Exception: data = {}`（**坏 body 连 400 都不给**，S6-B28；与 #69 的"吞成 400"又不同）；
 *  - 5245 的 sid 读的是 **body 的 camel 键** `sessionId`（对照 5071 的 snake `session_id`，S6-B36），
 *    同样是 or 短路（§D22）；
 *  - 5247–5248 的验法是 `isinstance(seq, int)`、**无 try** ⇒ `{"seq":"5"}` 400、`{"seq":true}` **过闸**（S6-B26/§D24）；
 *  - 5249 import 在验参之后（§D1）；5251 的 `{**report}` 解包见 S6-B27（非 mapping ⇒ TypeError 冒出）。
 */
export async function handle_rollback_apply(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const router = request.app.state.require(ROUTER_KEY); // 源 5240
  let data: JsonDict;
  try {
    data = await request.json(); // 源 5242
  } catch (exc) {
    void exc; // 源 5243–5244 except Exception：**一切**异常吞成 {}（S6-B28）
    data = {};
  }
  const bodySid = py_dict_get(data, "sessionId", null); // 源 5245 左操作数
  const sid = py_truth(bodySid) ? bodySid : py_getattr(router, "session_id"); // or 短路（§D22）
  const seq = py_dict_get(data, "seq", null); // 源 5246
  if (!py_isinstance_int(seq)) {
    return json_response({ error: "seq must be an integer" }, 400); // 源 5247–5248（isinstance 面，§D24）
  }
  const report = seams.snapshot_store_module().get_snapshot_store().rollback_since(sid, seq); // 源 5249–5250
  // 源 5251：四键字面量，前三键写死、第四键是 `**report`（后展开的赢同键，位置保持在后）。
  return json_response({ ok: true, sessionId: sid, seq: seq, ...py_dict_copy(report) });
}

/* ─── Session timeline / checkpoint tree (UB1) ──────────────（源 5254–5260）
 * 时间轴轴的**读侧**。`seq` 是共用的检查点键：快照存储按它归组前像、`session_messages`
 * 按它给用户轮次编号、`session_truncate` 用对应的序数来寻址。这些端点**只读**——
 * 回到某个检查点这件事留在 WS，于是"历史 + 文件"的原子撤销继续只发生在一个地方。
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/checkpoints #90（源 5262–5296，本批最大单函数，35 源行）。
 * docstring：时间轴——每个用户轮次一个节点，标注它改动了什么。逐点（源行号）：
 *  - 5264–5265 同 #88 的 app 下标 + or 短路；
 *  - 5266–5267 **两条** import 先于任何取数（snapshot_store 在前、storage 在后 ⇒ 缝调用次序是探针面）；
 *  - 5268–5271 只有 5269 那一行 `get_storage().list_user_turns(sid)` 在 catch-all 里
 *    ⇒ 历史侧坏了（含 `get_storage()` 自身抛的）就回空时间轴（S6-B28）；两条 import 行（5266/5267）
 *    都在 try **之外** ⇒ 未接线的 ModuleNotFoundError 照样冒（§D1 的放置面）；
 *  - 5272 `checkpoints(sid)` 与 `int(c["seq"])` 的**下标**在 try **之外**（S6-B29）；
 *    字典推导的键是 **int**，端口按 §D23 建 Map（保插入序 + 同键后写赢但位置保持在先）；
 *  - 5274–5290 逐轮建**九键**节点（书写顺序照抄）；snap 的三种取法并存（S6-B30）；
 *  - 5294–5295 剩下没被 pop 掉的即孤儿（源注释：被"只收聊天"的 withdraw 把消息折走了的那些轮
 *    ——不丢、单独报，它们是"用户走回头路走过的那条分支"的记录）；
 *  - 5296 响应三键 sessionId/nodes/orphans。
 */
export async function handle_checkpoints(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const router = request.app.state.require(ROUTER_KEY); // 源 5264
  const qSid = request.query.get("sessionId"); // 源 5265 左操作数
  const sid = py_truth(qSid) ? qSid : py_getattr(router, "session_id"); // or 短路（§D22）
  const ssModule = seams.snapshot_store_module(); // 源 5266（try 之外 ⇒ 未接线即冒，S6-B29）
  const storageModule = seams.storage_module(); // 源 5267（**在** try 之外，import 行自身裸奔）
  let turns: readonly unknown[];
  try {
    turns = storageModule.get_storage().list_user_turns(sid); // 源 5269
  } catch (exc) {
    void exc; // 源 5270–5271 except Exception: turns = []（S6-B28）
    turns = [];
  }
  const by_seq = new Map<string, unknown>(); // 源 5272 的 int 键 dict（§D23）
  for (const c of py_iter(ssModule.get_snapshot_store().checkpoints(sid))) {
    py_dict_set(by_seq, String(py_int(py_dict_index(c, "seq"))), c); // **下标**读 + int()，都在 try 外
  }
  const nodes: JsonDict[] = []; // 源 5273
  for (const turn of py_iter(turns)) {
    // 源 5275：pop 之后 `or {}` —— 键不在（或值本身是假值，如 None/{}）都回落成新空 dict。
    const snap = py_or(
      py_dict_pop(by_seq, String(py_int(py_dict_index(turn, "seq"))), null),
      {},
    );
    // 源 5276–5290：九键 dict 字面量，**书写顺序** = 响应顺序（不是 sorted，坑 2 口径）。
    nodes.push({
      seq: py_dict_index(turn, "seq"), // 源 5277（原值，不 int）
      ordinal: py_dict_index(turn, "ordinal"), // 源 5280（session_truncate 的把手）
      preview: py_dict_index(turn, "preview"), // 源 5281
      createdAt: py_dict_index(turn, "created_at"), // 源 5282（snake→camel 改名，源事实）
      files: py_int(py_or(py_dict_get(snap, "files", null), 0)), // 源 5283
      tools: py_or(py_dict_get(snap, "tools", null), []), // 源 5284
      label: py_or(py_dict_get(snap, "label", null), ""), // 源 5285
      // 源 5288–5289：`bool(...) if snap else False`——对 snap **再判一次真值**（S6-B30）。
      recoverable: py_truth(snap) ? py_truth(py_dict_get(snap, "recoverable", null)) : false,
      folded: py_truth(snap) ? py_truth(py_dict_get(snap, "folded", null)) : false,
    });
  }
  // 源 5294–5295 孤儿行：`int(s["seq"])` 下标（缺键 KeyError 冒，无 try，S6-B31）+ `.get` 两键。
  const orphans: JsonDict[] = [];
  for (const s of py_dict_values(by_seq)) {
    orphans.push({
      seq: py_int(py_dict_index(s, "seq")),
      files: py_int(py_or(py_dict_get(s, "files", null), 0)),
      folded: py_truth(py_dict_get(s, "folded", null)),
    });
  }
  return json_response({ sessionId: sid, nodes, orphans }); // 源 5296
}

/**
 * GET /api/checkpoints/preview #91（源 5299–5311）。
 * docstring：单个检查点动过哪些路径。**只读**，从不还原任何东西。
 *  - 5304 的 `.get("seq", "")` 默认是**空串** ⇒ 省略 seq 时 `int("")` 抛 ValueError → 兜成 400
 *    （与 #88 的 "0" 默认不同：那里省略 seq 是合法的"全部"）；
 *  - 5307 的 import 在验参**之后**（§D1）；
 *  - 5308–5311 响应三键，`paths` 是 seam 返回值原样（dict 字面量按书写序求值 ⇒ sessionId/seq 先、paths 后）。
 */
export async function handle_checkpoint_preview(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const router = request.app.state.require(ROUTER_KEY); // 源 5301
  const qSid = request.query.get("sessionId"); // 源 5302 左操作数
  const sid = py_truth(qSid) ? qSid : py_getattr(router, "session_id"); // or 短路（§D22）
  let seq: number;
  try {
    seq = py_int(request.query.get("seq", "")); // 源 5304（默认 **空串**）
  } catch (exc) {
    if (!catches_classes(exc, VALUE_OR_TYPE_ERROR)) throw exc; // 源 5305
    return json_response({ error: "seq must be an integer" }, 400); // 源 5306
  }
  return json_response({
    sessionId: sid, // 源 5309
    seq: seq,
    paths: seams.snapshot_store_module().get_snapshot_store().paths_at(sid, seq), // 源 5307–5310
  });
}

/**
 * POST /api/checkpoints/label #92（源 5314–5327）。
 * docstring：给检查点起个名（源注释原文就写着中文「这里是好状态」）；**空 label 把它清回自动**。
 *  - 5317–5320 又是 `except Exception: data = {}`（S6-B28 第三处）；
 *  - 5323–5324 的 seq 验法与 #89 同侧（isinstance、无 try，S6-B26）；
 *  - 5326 `str(data.get("label") or "")`：缺失/空/假值一律空串（"清回自动"就是这条面），
 *    `str(...)` 面走 §M `py_str`（枚举/数字 label 会被换算成字符串再入库）；
 *  - 响应 `updated` 是 store 的返回值**原样**（源不 int、不验型）。
 */
export async function handle_checkpoint_label(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const router = request.app.state.require(ROUTER_KEY); // 源 5316
  let data: JsonDict;
  try {
    data = await request.json(); // 源 5318
  } catch (exc) {
    void exc; // 源 5319–5320 except Exception（S6-B28）
    data = {};
  }
  const bodySid = py_dict_get(data, "sessionId", null); // 源 5321 左操作数（body 的 camel 键）
  const sid = py_truth(bodySid) ? bodySid : py_getattr(router, "session_id"); // or 短路（§D22）
  const seq = py_dict_get(data, "seq", null); // 源 5322
  if (!py_isinstance_int(seq)) {
    return json_response({ error: "seq must be an integer" }, 400); // 源 5323–5324
  }
  const n = seams
    .snapshot_store_module()
    .get_snapshot_store()
    .label_checkpoint(sid, seq, py_str(py_or(py_dict_get(data, "label", null), ""))); // 源 5325–5326
  return json_response({ ok: true, sessionId: sid, seq: seq, updated: n }); // 源 5327
}

/* ─── Event-Sourced Agent Runtime & Time Travel ──────────────────（源 5330）
 * 事件溯源运行时与时间旅行：把 session 的不可变事件流当真相，读它、验链、投影状态、
 * 在任意 seq 上 fork 出新会话。 ───────────────────────────────────────────────── */

/**
 * GET /api/events/{sessionId} #93（源 5332–5345）。
 * docstring：事件溯源流——按会话返回**原始不可变** AgentEvent 列表。逐点：
 *  - 5334 的 import 在**函数最顶上**（连 sid 判定都在它之后）⇒ 未接线时 400 也拿不到，
 *    先冒 ModuleNotFoundError（§D1，与 #78 的"验完再 import"相反）；
 *  - 5335 的 sid 是 `match_info or query`（两侧都**无默认**，S6-B36 的 camel 面）；
 *  - 5338 的默认值是 **int 0**（§D25：端口回显 "0" 给 `get`，两侧同结论）；
 *  - 5339–5342 的"有没有传"用 `is not None` 判 ⇒ 端口必须能区分缺键与空串（S6-B33，§D22）；
 *  - 5338/5340/5342 三只 `int()` **全在 try 之外**（S6-B32）；
 *  - 5344 的三个关键字实参**总是传**（没传时是 None，不是省略）⇒ 端口 opts 里显式 null（§D25）；
 *  - 5345 的 `[e.to_dict() for e in events]` 走 §0 `py_call0`（源 5344 在推导**之前**求值完）。
 */
export async function handle_get_events(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const storageModule = seams.storage_module(); // 源 5334（**最顶上**，早于 sid 的 400 闸）
  const miSid = request.match_info.get("sessionId"); // 源 5335 左操作数
  const sid = py_truth(miSid) ? miSid : request.query.get("sessionId"); // or 短路（§D22）
  if (!py_truth(sid)) {
    return json_response({ error: "sessionId is required" }, 400); // 源 5336–5337
  }
  const from_seq = py_int(request.query.get("from_seq", "0")); // 源 5338（§D25）
  const to_seq_str = py_query_get(request.query, "to_seq"); // 源 5339（is-not-None 面）
  const to_seq = py_is_none(to_seq_str) ? null : py_int(to_seq_str); // 源 5340
  const limit_str = py_query_get(request.query, "limit"); // 源 5341
  const limit = py_is_none(limit_str) ? null : py_int(limit_str); // 源 5342
  const events = storageModule.get_storage().get_events(sid as string, { from_seq, to_seq, limit }); // 源 5344（§D25）
  const out: unknown[] = []; // 源 5345 列表推导
  for (const e of py_iter(events)) {
    out.push(py_call0(e, "to_dict"));
  }
  return json_response({ sessionId: sid, events: out });
}

/**
 * GET /api/events/{sessionId}/verify #94（源 5348–5355）。
 * docstring：SHA-256 事件链完整性的密码学校验。
 *  - 与 #93 同构：import 在顶上（§D1）、sid 两级 or、400 文案同一句；
 *  - 5355 `{sessionId, **res}` 解包（S6-B27）：res 非 mapping ⇒ `TypeError: argument after **
 *    must be a mapping, not X` 冒出 handler（try 之外）；是 mapping ⇒ 其键**覆盖** sessionId
 *    （源把 sessionId 写在左边，同键由右侧胜、位置保持在左）。
 */
export async function handle_verify_event_chain(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const storageModule = seams.storage_module(); // 源 5350
  const miSid = request.match_info.get("sessionId"); // 源 5351
  const sid = py_truth(miSid) ? miSid : request.query.get("sessionId");
  if (!py_truth(sid)) {
    return json_response({ error: "sessionId is required" }, 400); // 源 5352–5353
  }
  const res = storageModule.get_storage().verify_event_chain(sid as string); // 源 5354
  return json_response({ sessionId: sid, ...py_dict_copy(res) }); // 源 5355（**res 解包）
}

/**
 * GET /api/events/{sessionId}/state #95（源 5358–5367）。
 * docstring：重放到可选 `at_seq` 把状态物化出来。
 *  - 5364–5365 又是 `is not None` + try 外的 int()（S6-B32/B33）；
 *  - 5366 的 `at_seq` 关键字参同样**总是传**（§D25）；
 *  - 5367 `state.to_dict()` 走 §0 py_call0（state 是 store 返回的对象，缺方法 ⇒ AttributeError 冒）。
 */
export async function handle_get_projected_state(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const storageModule = seams.storage_module(); // 源 5360
  const miSid = request.match_info.get("sessionId"); // 源 5361
  const sid = py_truth(miSid) ? miSid : request.query.get("sessionId");
  if (!py_truth(sid)) {
    return json_response({ error: "sessionId is required" }, 400); // 源 5362–5363
  }
  const at_seq_str = py_query_get(request.query, "at_seq"); // 源 5364
  const at_seq = py_is_none(at_seq_str) ? null : py_int(at_seq_str); // 源 5365
  const state = storageModule.get_storage().project_session_state(sid as string, { at_seq }); // 源 5366
  return json_response({ sessionId: sid, state: py_call0(state, "to_dict") }); // 源 5367
}

/**
 * POST /api/sessions/fork_at_seq #96（源 5370–5390）。
 * docstring：时间旅行分叉——把新会话精确 fork 到某个事件序号。逐点：
 *  - 5372 import 在顶上（§D1）；5373–5376 `except Exception: data = {}`（S6-B28 第四处）；
 *  - 5379 一行里两种判定：source_sid 用**真值**、fork_seq 用 `is None`（**0 合法**，S6-B34）；
 *  - 5382 `data.get("new_session_id") or str(uuid4())`：右操作数**有副作用**（缝调用）⇒
 *    端口不能用 §M 的 `py_or`（它两侧 eager 求值），改用显式短路（§D22，S6a `_config_path` 同法）；
 *    传空串也照样新造 uuid（S6-B36 的"空串表达不了我要空 id"）；
 *  - 5384 `int(fork_seq)` 在 try **之外**（S6-B32），且 `title=title` 是关键字参（**总是传**，§D25）；
 *  - 5389 响应回填 **body 原值** fork_seq（与喂给 store 的 int 版可以不同型，S6-B35）。
 */
export async function handle_fork_at_seq(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const storageModule = seams.storage_module(); // 源 5372
  let data: JsonDict;
  try {
    data = await request.json(); // 源 5374
  } catch (exc) {
    void exc; // 源 5375–5376 except Exception（S6-B28）
    data = {};
  }
  const source_sid = py_dict_get(data, "source_session_id", null); // 源 5377（snake 键）
  const fork_seq = py_dict_get(data, "fork_point_seq", null); // 源 5378
  if (!py_truth(source_sid) || py_is_none(fork_seq)) {
    // 源 5380：一句长文案，两个键名都点名。
    return json_response({ error: "source_session_id and fork_point_seq are required" }, 400);
  }
  const explicitNew = py_dict_get(data, "new_session_id", null); // 源 5382 左操作数
  const new_sid = py_truth(explicitNew) ? explicitNew : py_str(seams.uuid4()); // or 右侧有副作用 ⇒ 短路（§D22）
  const title = py_dict_get(data, "title", null); // 源 5383
  const state = storageModule
    .get_storage()
    .fork_at_seq(source_sid, py_int(fork_seq), new_sid, { title }); // 源 5384（int 面在 try 外）
  return json_response({
    sessionId: new_sid, // 源 5386
    sourceSessionId: source_sid, // 源 5387
    forkPointSeq: fork_seq, // 源 5388（**原值**，S6-B35）
    state: py_call0(state, "to_dict"), // 源 5389
  });
}

/**
 * GET /api/sessions/{sessionId}/log #98（源 5393–5400）。
 * docstring：返回该会话 session.log 的**人类可读文本**。
 *  - 5395 import 在顶上（§D1）；5396–5398 的 sid/400 与 #93 同构；
 *  - 5400 是本批**唯一**的非 JSON 响应：`web.Response(text=..., content_type="text/plain", charset="utf-8")`
 *    ⇒ §M `text_response`（与源 3857/3864 同面）；**没有 status= 参** ⇒ 200；
 *  - `text=` 对非 str 由 aiohttp 自己抛（端口在 StorageApi 接口上钉成 string，§D27）。
 */
export async function handle_get_session_log(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const storageModule = seams.storage_module(); // 源 5395
  const miSid = request.match_info.get("sessionId"); // 源 5396
  const sid = py_truth(miSid) ? miSid : request.query.get("sessionId");
  if (!py_truth(sid)) {
    return json_response({ error: "sessionId is required" }, 400); // 源 5397–5398
  }
  const log_text = storageModule.get_storage().get_session_log(sid as string); // 源 5399
  return text_response({ text: log_text, contentType: "text/plain", charset: "utf-8" }); // 源 5400
}

/**
 * GET /api/sessions/{sessionId}/transcript #99（源 5403–5410）。
 * docstring：返回该会话的**机器可读 JSONL** 转写事件流。
 * 与 #98 逐行同构，只有两处不同：5409 的取数方法名、5410 的响应把结果放在 `steps` 键
 * （源不解析 JSONL、不验形状 ⇒ 缝返回什么就回什么）。
 */
export async function handle_get_session_transcript(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const storageModule = seams.storage_module(); // 源 5405
  const miSid = request.match_info.get("sessionId"); // 源 5406
  const sid = py_truth(miSid) ? miSid : request.query.get("sessionId");
  if (!py_truth(sid)) {
    return json_response({ error: "sessionId is required" }, 400); // 源 5407–5408
  }
  const transcript = storageModule.get_storage().get_session_transcript(sid as string); // 源 5409
  return json_response({ sessionId: sid, steps: transcript }); // 源 5410
}

/* ══════════════════════════════════════════════════════════════════════════
 * S6e 批次（源 5413–5547）：log_info #100 / artifacts #101 / usage/stats #102 /
 * token-analytics #103 + 模块级 helper `_parse_range_days`。5413 之前一字未动，
 * 5547 是段 S6 的段尾（5548 起归 S7）。
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * GET /api/sessions/{sessionId}/log_info #100（源 5413–5420）。
 * docstring：返回 session log 的**文件系统路径与体积统计**。逐点（源行号）：
 *  - 5415 的 import 在 sid 判定**之前**（与 #93/#98/#99 同姿势，对照 #101 的 5436 在之后）
 *    ⇒ 未接线时连 400 都拿不到，先冒 ModuleNotFoundError（§D1，探针面）；
 *  - 5416 的 sid 是 `match_info or query`，两侧都**无默认**（camel 键，S6-B36）；短路面见 §D22；
 *  - 5419–5420 是本段唯一"响应体 = store 返回值原样"的一处（S6-B37）：源不包壳、不验形状。
 */
export async function handle_get_session_log_info(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const storageModule = seams.storage_module(); // 源 5415
  const miSid = request.match_info.get("sessionId"); // 源 5416 左操作数
  const sid = py_truth(miSid) ? miSid : request.query.get("sessionId"); // or 短路（§D22）
  if (!py_truth(sid)) {
    return json_response({ error: "sessionId is required" }, 400); // 源 5417–5418
  }
  const info = storageModule.get_storage().get_session_log_info(sid as string); // 源 5419
  return json_response(info); // 源 5420（**原样**当整个响应体，S6-B37）
}

/* ─── Session artifacts ─────────────────────────────────────────（源 5422–5429）
 * 一个只读端点。并集逻辑留在 artifact_index.py 里，因为它横跨三个互不知晓的存储；
 * 见那个模块的文件头注释。
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/artifacts #101（源 5430–5437）。
 * docstring：某会话产出的一切（图片 + 文件）的**扁平、由新到旧**索引。逐点：
 *  - 5432 `request.app[ROUTER_KEY]` 是**下标**（缺键 KeyError 冒，无 try）；
 *  - 5433 三级 or 链，键面是 **snake 先、camel 后**（对照 5416/5227 的纯 camel，S6-B38）；
 *    端口逐档短路（§D22）⇒ 第一档命中时**不调**第二次 query.get、更不读 router.session_id；
 *  - 5434–5435 的 400 文案是 "no session"（S6 第三种，S6-B38）；
 *  - 5436 的 import 在 400 闸**之后** ⇒ 400 那一档一个 artifact_index 调用都不吃（§D1）；
 *  - 5437 三个实参按左→右求值：`router.storage`（属性面，S6-B39）→ sid → `router.workspace or ""`。
 */
export async function handle_artifacts(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const router = request.app.state.require(ROUTER_KEY); // 源 5432（下标面）
  let sid: unknown = request.query.get("session_id"); // 源 5433 第一档
  if (!py_truth(sid)) sid = request.query.get("sessionId"); // 第二档（短路后才求）
  if (!py_truth(sid)) sid = py_getattr(router, "session_id"); // 第三档
  if (!py_truth(sid)) {
    return json_response({ error: "no session" }, 400); // 源 5434–5435
  }
  const artifactModule = seams.artifact_index_module(); // 源 5436（在 400 闸之后，S6-B38）
  const rstorage = py_getattr(router, "storage"); // 源 5437 实参 1（属性面，S6-B39）
  const workspace = py_or(py_getattr(router, "workspace"), ""); // 实参 3（右操作数是字面量 ⇒ py_or 安全）
  return json_response(artifactModule.build_index(rstorage, sid, workspace as string)); // 源 5437
}

/* ─── Usage analytics ──────────────────────────────────────────（源 5440–5445）
 * 一个端点、一个负载 —— 面板要一次拿全，且查询量很小（SQLite + GROUP BY）。
 * 把 summary/daily/model 拆成三条路由，在这个规模下只会把往返次数翻三倍而没有收益。
 * 【端口注记】源注释说"一个端点"，可横幅下面实际挂了 #102 与 #103 两条（S6-B53），照抄。
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * 模块级 helper `_parse_range_days`（源 5446–5452，带 `-> int` 注解）。
 *  - 5447 的默认值是**字符串** "30"（§D25 同族：端口靠 QueryView 的 fallback 面还原，
 *    探针必须用**省掉 days 这个 key**的方式测默认档 ⇒ 陷阱 #1 口径）；
 *  - 5448–5451 只兜 (TypeError, ValueError) ⇒ 坏串回落 30（与"缺键 → '30' → 30"是同一条路径的
 *    两种来源，但**只有一条** int() 求值）；
 *  - 5452 钳位 `max(1, min(n, 365))` ⇒ 9999 → 365、-5 → 1（S6-B40 的三种坏输入三种结果）。
 */
export function _parse_range_days(request: WebRequest): number {
  const raw = request.query.get("days", "30"); // 源 5447
  let n: number;
  try {
    n = py_int(raw); // 源 5449
  } catch (exc) {
    if (!catches_classes(exc, VALUE_OR_TYPE_ERROR)) throw exc; // 源 5450 (TypeError, ValueError)
    n = 30; // 源 5451
  }
  return Math.max(1, Math.min(n, 365)); // 源 5452（§D34：操作数已被 py_int 钉成有限整数）
}

/**
 * GET /api/usage/stats #102（源 5455–5478）。
 *  - 5456 app 下标 → 5457 `days`（**只算一次**，S6-B45）→ 5458 `router.storage` 属性面；
 *  - 5459 `usage_by_model(days)` 先取，然后 5465 的能力探测（S6-B42）：
 *    `getattr(router.models, "provider_label", None)` + `if callable(_label)` 双闸；
 *  - 5467–5471 标签填充：逐模型 → 逐 source 写 `provider_label`（5469），再按
 *    "只有一个 source 才把首个 source 的标签提到模型层"写 m 的键（5470–5471，S6-B43/B44）；
 *  - 5472–5478 响应字面量**按书写序求值** ⇒ 存储调用次序是 `usage_summary` → `usage_daily` →
 *    `usage_recent_turns`（`byModel` 只是变量回填，坑 2 口径）；
 *  - **整函数零 try**（S6-B41）：以上任何一面坏掉都直接冒 handler。
 */
export async function handle_usage_stats(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  void seams; // 本函数不碰任何模块缝（storage 走 router.storage，S6-B39）；参数只为 S10 签名统一
  const router = request.app.state.require(ROUTER_KEY); // 源 5456
  const days = _parse_range_days(request); // 源 5457
  const storage = py_getattr(router, "storage") as StorageApi; // 源 5458（属性面，S6-B39/B41）
  const by_model = storage.usage_by_model(days); // 源 5459
  // 源 5465：第一个名字（router.models）**无默认** ⇒ 缺 models 直接 AttributeError 冒；
  // 只有第二个名字（provider_label）享受 getattr 的默认面（S6-B42）。
  const _label = py_getattr_or(py_getattr(router, "models"), "provider_label", null);
  if (py_callable(_label)) {
    // 源 5467–5471：逐模型两层循环（by_model 非可迭代 / 元素非 dict 都会冒，S6-B41）。
    for (const m of py_iter(by_model)) {
      // 源 5468：`m.get("sources") or []`（第一次 .get）。
      for (const src of py_iter(py_or(py_dict_get(m, "sources", null), []))) {
        // 源 5469：CPython 对 `src[k] = RHS` 的字节码序是"压目标对象 → 压键 → 求 RHS → STORE_SUBSCR"，
        // 前两步**不做校验** ⇒ src 非 dict 时先死的是 RHS 的 src.get（端口同结论，次序论证见 §D33 末段）。
        py_dict_set(src, "provider_label", py_invoke(_label, [py_dict_get(src, "provider_id", "")]));
      }
      // 源 5470：**第二次** .get（源不复用循环变量，S6-B43）。
      const sources = py_or(py_dict_get(m, "sources", null), []);
      // 源 5471：`sources[0]["provider_label"] if len(sources) == 1 else ""`（两层下标，S6-B44）。
      py_dict_set(
        m,
        "provider_label",
        // 端口侧的唯一收窄：`sources` 在 §M 面里是 unknown，取元素要显式过一道 list 视图
        // （源 5471 的 `sources[0]` 由 py_len==1 保证存在 ⇒ 端口不重复校验，同 §D16 口径）。
        py_len(sources) === 1 ? py_dict_index((sources as readonly unknown[])[0], "provider_label") : "",
      );
    }
  }
  const summary = storage.usage_summary(days); // 源 5474
  const daily = storage.usage_daily(days); // 源 5475
  const recentTurns = storage.usage_recent_turns({ limit: 30, days }); // 源 5477（两个关键字实参**总是传**，§D25）
  return json_response({ days, summary, daily, byModel: by_model, recentTurns }); // 源 5472–5478 五键书写序
}

/**
 * GET /api/token-analytics #103（源 5481–5534）。
 * docstring：上下文窗口分析——按来源（messages / system_prompt / tools / skills）拆 token，
 * 外加 prompt-caching 命中率与 agent 动作计数。逐点（源行号）：
 *  - 5488–5489 缝与单例调用在**函数最顶上**，早于 router 解析（S6-B47）；
 *  - 5493 `await _router_for_request(request)` 在本文件 6707 行是 `_git_router` 的别名（属 S8 段）
 *    ⇒ 缝臂承接（§D37）；且这句**在 try 之外**（S6-B46）⇒ 未接线即冒，不会被 5532 吞；
 *  - 5494 `if router:` 真值闸（None/空 dict 假、对象真 ⇒ §M py_truth）；
 *  - 5495–5533 整块 catch-all（S6-B52，源注释自陈 fail-open）；
 *  - 5496 一个式子里两次属性读 + 一次实参调用（顺序近似见 §D32）；5497/5498 两个下划线方法；
 *  - 5503 `int(getattr(router.llm, "context_limit", 0) or 0)`——源注释 5499–5502 明说
 *    0 = unknown，**绝不编造 200k 的窗口**；
 *  - 5513 `hasattr` 与真取值**两次**属性读（S6-B48）+ `limit=1000` 关键字参；
 *  - 5514 对象行/dict 行两形状（S6-B49），or 右侧只在左侧假时求；
 *  - 5515 `if not user_msgs:` ⇒ 空列表走 reset_session（四关键字实参，§D25）；
 *  - 5523–5531 else 支才 `snapshot()`（**位点一**），5524 的括号面见 S6-B51、`breakdown: null`
 *    的面见 S6-B50；
 *  - 5534 无论前面成败，**最后一次** `snapshot()` 当响应体。
 */
export async function handle_token_analytics(
  request: WebRequest,
  seams: HttpS6Seams = HTTP_S6_SEAMS,
): Promise<WebResponse> {
  const analytics = seams.token_analytics_module().get_token_analytics(); // 源 5488–5489
  const router = await seams.router_for_request(request); // 源 5493（try **之外**，S6-B46/§D37）
  if (py_truth(router)) {
    // 源 5494
    try {
      // 源 5496：`router.compactor.estimate_tokens(router.get_system_prompt())`（求值序近似 §D32）
      const sp_tokens = py_call1(
        py_getattr(router, "compactor"),
        "estimate_tokens",
        py_call0(router, "get_system_prompt"),
      );
      const tool_tokens = py_call0(router, "_tool_def_tokens"); // 源 5497
      const skill_tokens = py_call0(router, "_skill_tokens"); // 源 5498
      // 源 5503：getattr 有默认 0 ⇒ router.llm 缺属性**才**回落 0；router.llm 本身缺失是 AttributeError
      // 冒（在 try 内 ⇒ 被吞，S6-B52）；`or 0` 兜的是 context_limit 为 None/0/"" 那一族。
      const ctx_window = py_int(
        py_or(py_getattr_or(py_getattr(router, "llm"), "context_limit", 0), 0),
      );
      // 源 5513：三元式的条件先求 ⇒ hasattr 一次、真取值再一次（S6-B48）。
      let hist: unknown = [];
      if (py_hasattr(router, "storage")) {
        hist = (py_getattr(router, "storage") as StorageApi).get_messages(
          py_getattr(router, "session_id"),
          { limit: 1000 }, // 关键字参（§D25）
        );
      }
      const user_msgs: unknown[] = []; // 源 5514 列表推导
      for (const m of py_iter(hist)) {
        let keep = py_getattr_or(m, "role", "") === "user"; // or 左（dict 行恒假，S6-B49）
        if (!keep) keep = py_isinstance_dict(m) && py_dict_get(m, "role", null) === "user"; // or 右（短路）
        if (keep) user_msgs.push(m);
      }
      if (!py_truth(user_msgs)) {
        // 源 5516–5521：空会话 ⇒ 只写开销基线（四个关键字实参，键**总是出现**，§D25）。
        analytics.reset_session({
          system_prompt_tokens: sp_tokens,
          tool_def_tokens: tool_tokens,
          skill_tokens,
          context_window: ctx_window,
        });
      } else {
        const snap = analytics.snapshot(); // 源 5523（**只在** else 支；5534 还有位点二）
        // 源 5524：默认 {} 只在**缺键**时生效（`breakdown: null` 会炸，S6-B50）；
        // 括号是 `(not tools and tool_tokens > 0) or used == 0`（S6-B51）。
        const breakdown = py_dict_get(snap, "breakdown", {});
        const left =
          !py_truth(py_dict_get(breakdown, "tools", null)) && py_gt(tool_tokens, 0);
        if (left || py_eq_int(py_dict_get(snap, "used", 0), 0)) {
          // 源 5525–5531：五个关键字实参；`sp + tool + skill` 是**两次**二元 +（左结合）。
          analytics.update_from_usage({
            context_tokens: py_add(py_add(sp_tokens, tool_tokens), skill_tokens),
            context_window: ctx_window,
            system_prompt_tokens: sp_tokens,
            tool_def_tokens: tool_tokens,
            skill_tokens,
          });
        }
      }
    } catch (exc) {
      void exc; // 源 5532–5533 except Exception: pass（fail-open，S6-B52）
    }
  }
  return json_response(analytics.snapshot()); // 源 5534
}

/* ─── Memory diagnostics & wiki adjudication (C1-C4) ────────────（源 5537–5546）
 * 【归属】这段横幅在段 S6 的区间尾（5547）之内、其下的 `handle_memory_diagnostics`
 * （5548）属 **S7** ⇒ 按 SEGMENTS 的分段边界照抄为注释，正文不移植（S7 批次认领）。
 * 读密集的诊断为一份负载，理由同 usage/stats：面板一次要 tier 计数 + FTS 索引健康 +
 * 检索门面健康，三者都很便宜（两条 COUNT 查询加一个进程内 dict）。
 * wiki 那一侧是全应用里唯一由**用户**来裁定系统检测到的矛盾的地方。刻意不做自动化 ——
 * 见 wiki_store.add()：按置信度自动取代会让一条低置信度的错断言悄悄压掉一条高置信度的对断言。
 * ────────────────────────────────────────────────────────────────────────── */


/* ──────────────────────────────────────────────────────────────────────────
 * §D DIVERGENCE(port)（S6a 落笔部分；S6b–e 批次就地续号）
 *
 *  D1 函数级 import 的 seam 放置：本段把"import 模块面"建模为 `xxx_module()` getter，
 *    getter 调用点 = 源 import 语句所在行（#68 在 query 读取前、#69 在 json-try 前、
 *    #76/#77 在体首、#78 在验参后）。未接线时抛出点与 CPython 一致。S5 D7 的"首用处放缝"
 *    只适用于 import 与首用**同位**的段；本段两者不同位，故按 import 行放置，逐 handler 注释已标。
 *  D2 `.lower()`（源 4665/4666）→ JS `toLowerCase()`：消费点是枚举字面量（allow/deny/
 *    workspace/session…），对跨字符大小写差异两侧结论一致（同 S5 D4 的论证形状）。
 *  D3 `_redact` 掩码支假设 api_key 是 str：非 str 真值（int/容器）在 CPython 先死在 `len()`
 *    （TypeError），端口先死在 py_len（PyTypeErrorP，文案含真实类型名）——抛出点同序；
 *    仅"有 len 的非 str（list/str 以外容器）"深支的 f-string 切片语义不逐字复刻（config
 *    经 json.load 只可能是 str），登记于此。
 *  D4 `open(tmp,"w",encoding="utf-8") + json.dump(...)` 折成一次 `fs_write_text(path, content)`：
 *    失败位点等价（open 失败/序列化失败/replace 失败都在同一源行位置冒出），写盘由 seam 假件承接。
 *  D5 #78 的 `except json.JSONDecodeError` 族判定用 §0 的 JSON_DECODE_OR_VALUE（宽到 ValueError）：
 *    CPython 里 JSONDecodeError ⊂ ValueError，捕获方向只宽不窄的理由是端口不可证 request.json()
 *    把解码失败装进哪个类名（keys.ts B4 注释的既定事实）；探针接线后 request.json() 由缝供给。
 *  D6 未捕获异常（S6-B1 的 KeyError、S6-B6/B7 的 AttributeError/TypeError、未接线的
 *    ModuleNotFoundError）在端口 = rejected promise 上冒，**不在本文件渲染**；最终状态码归
 *    装配层 `CreateServerSeams.render_uncaught`（同 S5 D6）。
 *  D7 `f"{path}.tmp"` → 模板串等价拼接。
 *  D8 `copy.deepcopy`（源 4595 import copy）→ §0 私有 py_deepcopy：不 memoize 循环引用
 *    （CPython 会）；`_CONFIG` 全部来自 json.load（无环），深支不可达，登记不修。
 *    `import copy` 是 stdlib ⇒ 不建缝。
 *
 * S6b 批次续号（D9–D17，源 4760–4945）：
 *  D9 `_wire_scene_callbacks`（源 4802 的接收者）是**本文件自己的模块级 helper**（定义在 7491，属 S9 段）。
 *    端口不做跨段 import（简报红线：宁可不用），改由 seam 臂 `wire_scene_callbacks` 承接，装配层把 S9
 *    落地后的真函数接进来——真值只有一份，本段零副本。缺省臂抛 NameError，而源在 4807 是
 *    `except Exception: pass` ⇒ 未接线时该臂被**照源的容错吞掉**，结论与"helper 不存在 ⇒ 场景回调
 *    fail-open"一致（副作用：这条臂的 miswiring 只能靠 applied 之外的可观察面反查，S6-B14 同因）。
 *    与 D1 的关系：D1 管的是"模块面 getter 调用点 = import 行"，这条管的是"同文件跨段函数"。
 *  D10 `bool(x)`（源 4832/4911/4925）一律用 §M `py_truth`：它返回 JS boolean，**对 string/number/
 *    array/None 的结论与 CPython 逐点相同**（空 dict 面见 D17，是 §M 的既有偏差，不在段内二次实现）。
 *    **不新建 py_bool 镜像**——那是 §M 已有语义的第二份定义。
 *  D11 `min(a, b)` / `max(a, b)`（源 4843/4849/4863/4864/4869/4870/4871/4879）用 JS `Math.min/Math.max`：
 *    全部操作数都来自 §M 的 `py_int`/`py_float`（即 CPython int/float，端口里是有限 number），
 *    无 NaN、无 Decimal、无自定义 `__lt__` ⇒ 两侧逐位同结论；已验收的 S5 同法
 *    （s5 583/952/1024/1062/1097）。`mt // 2`（源 4879 地板除）同理：mt 被 4871 钳成 >= 8000 的
 *    非负 int，`Math.floor(mt/2)` 与 `//` 在该定义域上相同（负数面在源里不可达，登记不修）。
 *  D12 `except OSError as e`（源 4942）需要 **OSError 子类面**：`catches_classes` 只比类名字符串，
 *    认不出 `PermissionError ⊂ OSError`。keys.ts 的 `PyPermissionErrorP extends PyOSErrorP` 是真继承 ⇒
 *    §0 加 `catches_oserror`（先 instanceof，再按文案前缀兜普通 Error 装的 `OSError:`）。
 *    不改 keys.ts、不动 §M 的 catches_classes（那是 §0 既有私有面）。
 *  D13 setattr / 函数当值：`router.llm =`、`r.compactor.threshold =`、`get_telemetry().enabled =`、
 *    `._llm =`（源 4810/4813/4848/4849/4889–4895/4898–4904/4914/4804–4806）一律 §0 `py_setattr`
 *    （§M 无 setattr；接收者在端口是探针注入的普通对象）。源 4793 把三个**函数对象**放进元组，
 *    端口把这三个名字声明为函数类型属性（不是方法）后当值传，避免引入 python 没有的 `this` 绑定语义。
 *  D14 `await get_memory_layer().set_enabled(...)`（源 4925，python 侧是协程）：端口统一 `await`；
 *    假件返回同步值时 `await 非promise` 是恒等，可观察顺序不变（不改变 4926 的 append 时机）。
 *  D15 `f"could not persist: {e}"`（源 4943）是 **`str(e)`**（不是 repr）⇒ §M `exc_str`，
 *    与 D7 的 f-string 等价拼接同族，但这里刻意用 str 面：4943 的文案在源里没有 `!r`。
 *  D16 类型面 vs 运行面：keys.ts 把 `request.json()` 定成 `Promise<JsonDict>`，而 CPython 解码可以是
 *    list/str/int。本段**不因为 TS 类型是 JsonDict 就省掉运行期判定**——八个子 patch 的读取全部走
 *    §M `py_dict_get` / §0 `py_dict_index` / `py_contains` / `py_dict_items`（非 dict 接收者给出与源
 *    同类同位的 AttributeError/TypeError/KeyError），这是 S6-B9/S6-B10 能成立的前提。
 *  D17 【§M 已知偏差，本段不修只登记】`py_truth`（keys.ts 96–115）对**空对象**给 `true`
 *    （111 行自己的注释："已解码的 JSON 对象：非 null 即真"），而 CPython `bool({})` 是 **False**。
 *    `py_or` 是它的薄封装（keys.ts 118–120）⇒ 同一面。可观察后果（源行号）：
 *      · 本段 4775/4856/4918/4929/4934 五个 `if patch_x:` 闸 —— body 传 `{"model":{}}` 时源**跳过整支**，
 *        端口**进入整支**：重建 LLM 客户端、在 `_CONFIG` 里建空键、`applied` 多一项；
 *      · 四处 `patch.get(k) or {}`（4774/4855/4917/4928/4933）在 `{}` 时源取右值（新空 dict），
 *        端口把左值原样返回（值等价，仅对象身份不同，本段无身份可观察面）；
 *      · 已验收的 S6a 同源同面：4746 `failed = {}` + 4756 `"ok": not failed` —— 零失败时源 `ok=true`、
 *        端口 `ok=false`。
 *    处理：按红线**不在段内另造第二份 bool 镜像**（那是 mirror-single-source 明令禁止的），段内继续只
 *    import §M 的 `py_truth`；偏差连同冒烟证据（`tmp/w218_s6_typecheck/smoke/run_a.mjs` 的 A/B/E 组）
 *    上报 lead，由 lead 决定在 §M 单点修（改 111 行为按键/`Object.keys(...).length > 0`）并全段复验。
 *    段内断言一律**按源的真实语义**书写并把这类项标成 mdiv（已知 §M 偏差），不放宽断言去凑绿。
 *    **【S6c 批次就地更新】** lead 已按此在 keys.ts **单点修好** §M（现 96–105 的行内注释自证：
 *    空 dict 按 `Object.keys(...).length` 判 ⇒ `{}` 假、`NaN` 真、类实例（非 Object 原型）恒真、
 *    `__bool__` 优先）。本批 S6c 的**全部真值面按修后脸书写**（`py_or` 链、`if cur`、`model else None`
 *    三处尤关键）；上面登记的 mdiv 随 §M 修复消解，S3/S5/S6a/S6b 的**复跑归 lead**，本批不改写 D17 原文。
 *
 * S6c 批次续号（D18–D21，源 4948–5212）：
 *  D18 `from subagent_runtime import MAX_CONCURRENT_SUBAGENTS`（源 4994）是**数据常量**的 from-import：
 *    CPython 在 import 位点即刻绑值，之后再改模块属性不影响已绑名字。端口在**同位**读一次 seam 对象的
 *    `MAX_CONCURRENT_SUBAGENTS` 属性存本地——若假件把模块面做成 getter 代理，两侧观察到的"取值时刻"
 *    一致（都是 import 行，而非 5030 的回填点）。
 *  D19 5155–5198 的 stdlib/三方 IO 面收拢成缝（D4 同族，全部零真碰盘）：
 *    · `yaml.safe_dump(doc, f, allow_unicode=True, sort_keys=False)`（源 5191，PyYAML 第三方）⇒
 *      `yaml_dump(doc): string` 出文本 + `fd_write_text(fd, text)` 承接 fdopen/写/关——闸规观察面
 *      （tmp 路径内容、写入先于 replace 的次序）不变；
 *    · `tempfile.mkstemp(dir, suffix)` → `mkstemp` 缝回 `[fd, path]`（名字唯一性由 OS/假件给出，
 *      与 _persist_config 的 `f"{path}.tmp"` 定名面**不同族**，故不折叠）；
 *      源 5187 的 `import tempfile` 与 5112–5113 的 `import os`/`import yaml` 同为**无副作用的
 *      stdlib/三方模块面** ⇒ 不为它们各开一个 module() getter（开了也没有可观察的第二面），
 *      观察面全在调用行（5156/5158/5188/5190–5192/5195）；
 *    · `os.makedirs(exist_ok=True)` / `os.unlink` / `os.path.abspath` → `fs_makedirs` / `os_unlink` /
 *      `os_path_abspath` 缝（join/split 本体在 §M）；
 *    · 源 5157 `os.path.dirname(__file__)`：seam 只提供 `abspath_module_file()`（=abspath(__file__)，
 *      S6a 既定面）⇒ `dirname(abspath(__file__))` 与 `dirname(__file__)` 再被 5156 外层 abspath 归一后
 *      落到**同一目录**（abspath 先 normalize 再判），端口取此近似并登记；
 *    · 源 5193 `except BaseException:`：JS 无 Exception/BaseException 分层，catch 即全收，
 *      KeyboardInterrupt/SystemExit 深支在端口不可达（源侧后果=整请求冒 500 页，同 catch-all），登记不修。
 *  D20 registry 单例的端口建模（源 5095–5097/5116–5117/5162/5206–5211）：`in registry`、`registry.get`、
 *    `registry.values()` 三个用面都是**纯 dict 语义** ⇒ 把单例建模成 name→def 的普通 dict，由 §0 的
 *    py_contains / §M 的 py_dict_get / §0 的 py_dict_values 覆盖，不再造第二份成员/get/values 逻辑；
 *    def 上的 `d.to_public()`（源 5096/5210/5211，接收者是 unknown）经 §0 `py_call0`：属性缺失先死在
 *    py_getattr（AttributeError，与 CPython 同面），"属性在但不可调"给
 *    `'X' object is not callable`（CPython 同类文案，参数 repr 面端口近似到类型名）——登记近似。
 *  D21 数值域近似（源 5019/5026，账本行都是 JSON 解码产物 ⇒ 定义域内两侧同结论）：
 *    · `(finished or base) - base` 的减法在端口是 JS number 强制转换——字符串数值会被**悄悄换算**
 *      （CPython 直接 TypeError）。可观察后果仍等价的原因：非数值时端口得 NaN、随后**同一行**的
 *      py_int 抛 "cannot convert float NaN to integer"（§M py_int 的 ValueError 文案面），两侧都
 *      冒进源 5024 / 端口同一只 catch-all ⇒ 账本合并都在**同一行**中止、保留同样的部分行。
 *    · `rows.sort(key=..., reverse=True)`（源 5026）用 §0 py_sorted 的**取负键升序**建模：数值域上
 *      降序 = 负键升序，等键稳定性两侧一致（CPython reverse=True 不翻转等键先入序）；非数值
 *      createdAt 在源是 TypeError（5026 在 try **之外** ⇒ 冒出 handler），端口 NaN 比较恒 false ⇒
 *      静默保持原序——定义域外分歧，登记（账本 createdAt 恒为数值，不可达）。
 *
 * S6d 批次续号（D22–D29，源 5224–5410）：
 *  D22 **`or` 短路 vs `py_or` 的 eager 求值**：§M 的 `py_or(a,b)` 是**函数**，两个实参在调用前就都算完，
 *    而 CPython 的 `a or b` 在 a 为真时**根本不求值 b**。本批 b 侧带副作用/带抛点的一律改成显式
 *    `py_truth(a) ? a : B`（S6a 的 `_config_path` 同法），逐点：
 *      · 5227/5245/5265/5302/5321 `... or router.session_id` ⇒ 短路 ⇒ query/body 给了 sessionId 时
 *        **不读** `router.session_id`（假件把它做成 getter 时，读次数是探针面）；
 *      · 5335/5351/5361/5377 系（#93/#94/#95/#98/#99）`match_info.get(...) or query.get(...)` ⇒
 *        match_info 命中时**不调** `query.get`；
 *      · 5382 `... or str(uuid4())` ⇒ 有 uuid4 **缝调用**，不短路就会每次多烧一次随机源（探针按次数钉）。
 *    其余 b 侧是字面量/纯读的 or 链（5283–5285、5234 无）继续用 `py_or`，与 S6a–S6c 口径一致。
 *  D23 `by_seq`（源 5272）的键在 CPython 是 **int**、且 dict 保持**插入序**、同键后写**赢值但位置保持在先**。
 *    普通 JS 对象会把 "10"/"3" 这类**整数样键重排成升序** ⇒ 与源的可观察面（5294 孤儿的输出次序）不符。
 *    端口因此把 by_seq 建成 `Map<string, unknown>`（键是 int 的十进制串面）：插入序保真、
 *    同键 `set` 保持先入位置、`py_dict_pop` 的删除保持剩余序。**登记的近似**：超过 2^53 的 seq 在端口
 *    会因 double 精度撞键（CPython int 无限精度）；快照 seq 来自 SQLite 计数器，定义域外，不修。
 *  D24 `isinstance(seq, int)`（5247/5323）的端口面 §0 `py_isinstance_int`：
 *    · **bool ⊂ int**（CPython 事实）⇒ `{"seq": true}` 在两侧都**过闸**，并把 True 原样送进 store（S6-B26）；
 *    · float：CPython `isinstance(2.0, int)` 为**假**，而端口拿不到"JSON 里写过 .0"这条信息
 *      （解码后只有 number）⇒ `Number.isInteger(2.0)` 为真、端口**过闸**。**这是端口侧不可达的支**：
 *      `{"seq": 2.0}` 源 400、端口 200。登记不修（要修得改 §M 的 JSON 解码面，超出本段范围）。
 *    · NaN/Infinity：`Number.isInteger` 为假 ⇒ 与源同（源的 float('nan') 也不是 int）。
 *  D25 查询串默认值与关键字实参的两处建模：
 *    · 5338 `int(request.query.get("from_seq", 0))` 的默认是 **int 0**、5228 的默认是 **字符串 "0"**；
 *      端口的 `QueryView.get(name, fallback?: string)` 只收 string ⇒ 两处统一写 `"0"`，
 *      `py_int("0") === 0 === py_int(0)` 同结论（默认值路径两侧都不抛）。
 *    · 5344/5366/5384 的**关键字实参**在源里**总是出现**（没传时是 None，不是省略），端口收进 opts 对象
 *      并**显式写 null**（`{from_seq, to_seq, limit}` / `{at_seq}` / `{title}`）。
 *      坑 1 口径：探针里"没传"这一档要断言的是 opts 里**该键存在且为 null**，不是把键省掉。
 *  D26 `str(uuid4())`（5382）：uuid 是 stdlib、值是**随机**的 ⇒ 不可复现的量必须由缝供给
 *      （`uuid4(): unknown`，fail-closed 抛 NameError 形状，绝不回退固定串）。源 17 行是**模块顶层**
 *      import，端口按"观察面在调用行"折进 5382 一处（§D19 同族），不为它开 module() getter。
 *      `str()` 面走 §M `py_str`：假件给字符串时恒等，给带 `__str__` 的对象时与 CPython 的 UUID 同位。
 *  D27 `web.Response(text=log_text, content_type="text/plain", charset="utf-8")`（5400）→
 *      §M `text_response`（与源 3857/3864 同一张面，`kind:"text"`）。源未写 `status=` ⇒ 200。
 *      非 str 的 `text=` 由 aiohttp 自己抛 TypeError，端口在 `StorageApi.get_session_log` 的接口上
 *      钉成 `string`（假件给非 str 时编译期就红）⇒ 该运行期面在端口不可达，登记。
 *  D28 `except Exception`（5243/5270/5319/5375 四处吞点）在端口 = JS `catch` **全收**：
 *      CPython 不吞 `BaseException`（KeyboardInterrupt/SystemExit 会一路冒到 500 页），端口这一层
 *      没有该分层。源 5193 已按同一口径登记过（S6c §D19），本批四处同族，不重复展开。
 *  D29 `py_dict_copy`（§0，源 4709 建的 `dict(...)` 面）在 5251/5355 复用为 `{**x}` 解包面：
 *      文案就是 CPython 解包的 `argument after ** must be a mapping, not X`；None 侧写作 `not NoneType`。
 *      **展开赢的键面**：源 `{a, **r}` 里 r 的同名键覆盖 a 的值、但**位置**仍在左（端口对象展开同结论），
 *      所以探针钉的是 `ok`/`sessionId` 被 report 改写后的值，而不是"report 排在后面"。
 *
 * S6e 批次续号（D30–D38，源 5413–5547）：
 *  D30 `callable()` / `hasattr()` 在 §M 没有 ⇒ §0 私有 `py_callable` / `py_hasattr`（闸二机器判定
 *    与 §M 的 55 个名字零交集）。`py_hasattr` 的容错**只到 AttributeError**（CPython 3.x 面），
 *    其余异常上冒；`py_callable` 除 JS function 外还认带 `__call__` 的对象（CPython 的实例可调用面）。
 *  D31 源 5469 的 `_label(...)`：`getattr` 取到的可调用值按 §D13 的"函数当值"口径调用
 *    （§0 `py_invoke`，**不绑接收者**）。CPython 那边若 `provider_label` 是**实例上的绑定方法**，
 *    getattr 会自动绑 self；端口假件给的是普通函数/闭包 ⇒ 两侧都是"无 self 的一元调用"。
 *    等价性论证：源里 `provider_label` 由 model_registry 注册为普通函数（`py_invoke` 面），
 *    若哪天改成绑定方法，差别只在实现方是否依赖 self —— 那是 registry 模块（非本段）的事，登记。
 *  D32 源 5496 一句里 CPython 的求值序是 ①`router.compactor` → ②`.estimate_tokens` → ③实参
 *    `router.get_system_prompt()` → ④调用。端口把 ① 显式前置（`py_getattr`），②/③ 的先后合并进
 *    `py_call1`（③ 在 ② 之前完成）。**登记为近似**：②与③互换只会改变"哪个异常先冒"，而这两步
 *    都在源 5495 的同一只 catch-all 之内（S6-B52）⇒ 异常身份不外露、成功调用的发生与否不变。
 *  D33 数值/比较/算术面 §0 私有 `py_add` / `py_gt` / `py_eq_int`：JS 原生 `+`/`>`/`==` 会把 CPython
 *    的 TypeError（`int + str`、`'5' > 0`）静默换算成结果，从而**多出** `update_from_usage` 调用
 *    （探针可观察）⇒ 一律用 helper。三者覆盖本批用到的定义域（number/bool/str/list），其余抛
 *    CPython 同类文案。`py_str` 一侧仍全部走 §M。
 *    另一处**次序**问题（源 5469 `src["provider_label"] = _label(src.get("provider_id",""))`）：
 *    CPython 对下标赋值的字节码序是 ①压目标对象 `src` → ②压键常量 → ③求右值（`src.get` → `_label`）
 *    → ④`STORE_SUBSCR`，**①② 两步不做任何类型校验**（校验在 ④）。故 src 非 dict 的现实形状里，
 *    两侧第一个抛出的都是 ③ 的 `AttributeError: 'X' object has no attribute 'get'`、`_label`
 *    都**不被调用** ⇒ 端口（实参序：目标、键、右值、最后 `py_dict_set`）与源**完全同结论**，不是近似。
 *    唯一能分出两侧的形状是"目标 `.get` 得动、但 `STORE_SUBSCR` 才失败"（自定义映射对象），
 *    那种形状下源在 label 调用**之后**抛、端口同样在 `py_invoke` 之后才进 `py_dict_set` 抛 ⇒
 *    只差一次 label 调用，且该形状在本段真实数据里不存在（`sources` 元素恒为 dict，源注释自陈）。
 *    登记不修（探针 P5h 钉的就是现实形状那一支：先 AttributeError、label 零调用）。
 *  D34 `max(1, min(n, 365))`（源 5452）用 `Math.max/Math.min`：n 已由 §M `py_int` 钉成有限整数
 *    （坏值走 5451 的 30），无 NaN/Infinity ⇒ 与 §D11 同判据（同法已验收于 S5/S6b）。
 *  D35 `_parse_range_days` 的默认值面：源 5447 是 `query.get("days", "30")`，§M `QueryView.get(name,
 *    fallback?)` 的契约（keys.ts 402–406 与同文件 headers 面 453 行的 `fallback ?? ""`）就是
 *    "缺键 ⇒ 回 fallback" ⇒ 端口把默认串交给缝，**不额外判空串**：传了 `?days=` 时两侧都拿 `""`
 *    去 `int()`、都死在 ValueError、都回落 30（同路径，非同结果巧合）。探针按**省掉 key**测默认档。
 *  D36 `web.json_response(info)`（源 5420）与 `web.json_response(analytics.snapshot())`（5534）的
 *    顶层非 dict 面：§M `json_response(body: unknown, status=200)` 收 unknown，与 aiohttp 的
 *    `json_response` 允许任意可序列化值（None/list/str/数字）同结论 ⇒ 端口不因"响应体是 unknown"
 *    而加任何形状校验（源没有）。
 *  D37 `_router_for_request`（源 5493）是本文件 6707 行的**别名**（`= _git_router`，定义属 S8 段）：
 *    与 §D9 同族（不跨段 import，改由缝臂 `router_for_request(request)` 承接）。**区别要写清**：
 *    D9 那处（源 4802）被源自己的 `except Exception: pass` 吞掉，未接线是 fail-**open**；本处源在
 *    5493 **没有**兜（try 从 5495 起，S6-B46）⇒ 缺省臂抛的 NameError 直接冒 handler，
 *    **不会**悄悄退化成 5494 的"router 是假 ⇒ 只回 snapshot"支。fail-closed 的理由与形态都在此。
 *  D38 缝调用次数的记账口径：本批新增两臂（`artifact_index_module` / `token_analytics_module`）
 *    各按源 import 行放置（§D1）；`storage_module()` 在 5415 一次（#100），#101/#102/#103 三个
 *    函数**一次都不吃** storage 缝（它们走 `router.storage` 属性面，S6-B39）⇒ "哪个 storage 句柄"
 *    在探针里仍是可观察面，端口不合并两条路径。
 * ──────────────────────────────────────────────────────────────────────── */

// PORT STATUS: 本文件无 TODO(port)。
