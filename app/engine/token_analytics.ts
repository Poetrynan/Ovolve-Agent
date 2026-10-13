/**
 * token_analytics.ts — port of app/backend/token_analytics.py (unit 167).
 *
 * SOURCE: app/backend/token_analytics.py (355 lines) — 实时上下文窗口分析引擎。
 * 三层分析：Token Space Breakdown（按来源拆分窗口占用）/ Prompt Caching（命中、
 * 未命中、平均命中率、费用节省）/ Agent Action Breakdown（本轮工具调用、规则
 * 应用、子代理委派）。混合策略：API 精确值 + 本地估算；不自己定价、不编造分母。
 * 纯内存、无 I/O、无持久化；进程级单例 get_token_analytics()。
 *
 * RULEBOOK CITATIONS（§ numbering as in HANDOFF_V4 / RULEBOOK）
 *   §4 naming: python 拼写逐字保留 —— _TOOL_CATEGORIES, _DEFAULT_CATEGORY,
 *     _classify_tool, _Breakdown, _CacheStats, _ActionStats, _TurnSnapshot,
 *     TokenAnalytics, get_token_analytics 以及全部私有字段名（_turn/_total_*）。
 *     snapshot() 的键是前端 prop 契约（camelCase），逐字保留。
 *   RULEBOOK §2 dataclass: 四个 dataclass 保留 python 字段声明序；构造器支持
 *     位置与关键字两种调用形态，arity/关键字错误措辞与 CPython 逐字一致
 *     （self 计入位置参数计数）；field(default_factory=…) 只在参数**被省略**
 *     （TS undefined）时生效，显式传 null 原样存入（真三态，§4.3 惯例）。
 *   RULEBOOK §2 module-level mutable state: `_analytics` 单例为模块级 let，
 *     get_token_analytics() 用 `is None`（身份）判断而不是真值判断。
 *   RULEBOOK §1 telemetry ban 与本单元的关系：manifest.tsv 把
 *     token_analytics.py 标为 DELETE/wave 0（与 telemetry.py 同行）。操作员
 *     2026-09-25 直接指令撤销该行对**本文件**的适用性、按 TS 单元移植并逐
 *     bug 对拍（AMEND-07「功能一致 supreme」）。本模块是纯内存 UI 分析器：
 *     无网络、无上报、无持久化，移植不产生任何遥测路径。
 *   RULEBOOK §2 dict as ordered structure: snapshot()/toolBreakdown 的键插入
 *     顺序是可观察行为（比较器按键序走），TS 用对象字面量按源码顺序构造。
 *
 * QUIRKS PINNED BY THE PARITY PROBE（编号即探针家族）
 *   §1 缓存门是 `has_cache_info or (read>0 or miss>0 or creation>0)` 的真值
 *      或链且**短路**：has_cache_info 真值时三个 `>` 比较根本不求值（把 str
 *      塞进 cache_read，hcT 在 `+=` 炸、hcF 在 `>` 炸——两种不同的异常文案）。
 *   §2 denom==0 时**不**追加 turn_rates 但**仍然** recompute_average()。
 *   §3 savings/cost_source 的赋值在缓存门**里面**：全零 + has_cache_info 假值
 *      时即使传了 cost_source 也不会写入（真值门 `if cost_source:`）。
 *   §4 int(savings_micros) 是真 int()：bool→1/0、浮点向零截断、字符串文法
 *      （符号/下划线夹在数字间/前导零/两侧 ASCII 空白）、NaN→ValueError、
 *      inf→OverflowError；falsy 的 savings 根本走不到 int()（None/0/""/False
 *      被门吃掉），所以 "0" 这种**真值**字符串会成功加 0。
 *   §5 messages = max(0, context_tokens - known) 的 max 是 python max(a,b)
 *      语义（b > a 才换）；known 是左结合的 `+` 链——str+str 拼接、str+int
 *      抛 "can only concatenate str"、int+str 抛 "unsupported operand
 *      type(s) for +"，三种文案各归各位。
 *   §6 **部分应用**：异常发生时已写完的字段保持已写状态——t.used /
 *      used_is_exact / context_window / model_id / breakdown 三个已知分段在
 *      messages 行炸掉之前已经落账；updated_at 与 _total_turns 在函数尾，
 *      异常路径**都不发生**（时钟 0 读、turns 不加）。
 *   §7 毒化后的 snapshot 自身会抛：used='x' 且 total>0 时 percent 的 `/`
 *      抛 "unsupported operand type(s) for /"；knowns 毒化后 local_sum 的
 *      `+` 先炸；is_exact 的 `and` 短路（used_is_exact=False 时不求值
 *      `used > 0`）——所以 total=0 时毒化 snapshot 不炸。
 *   §8 update_context_window 的 max(1, x) 对 str 抛 "'>' not supported
 *      between instances of 'str' and 'int'"；NaN 走 "b > a 为假" 分支得 1。
 *   §9 reset_session 的 `context_window or self._turn.context_window` 是
 *      真值 or：显式 0/""/None 落到旧窗口；"w" 这种真值 str 会在
 *      `ctx_win > 0` 处抛 TypeError。四件套（breakdown/used/messages/
 *      updated_at）在**全新** _TurnSnapshot 上重写，used=sum 若抛则
 *      updated_at 保持 0.0。
 *   §10 reset_turn 只换 actions（全新 _ActionStats，含全新 defaultdict），
 *       totals 与 cache 一概不动。
 *   §11 on_tool_call 先 _classify_tool（None/int 在 .lower() 处抛
 *       AttributeError，**任何状态都没变**），后计数；toolBreakdown 是
 *       defaultdict：键按**首次触碰顺序**插入，重复调用累加不重排。
 *   §12 on_fold 的 messages 减法链左结合且先于 t.used 赋值——链上抛错时
 *       used 不变、时钟不读。
 *   §13 percent/averageHitRate 走 python round(x, n) 的**十进制半途平局
 *       银行家舍入**：round(0.03125, 4)=0.0312、round(12.25, 1)=12.2、
 *       round(0.0625, 4)=0.0625（**精确值不进位**——仓内既有 pyRound 房型
 *       在这一格会误进位成 0.0626，本端口用修正版，见 pyRound 注释）。
 *   §14 used 或 local_sum 是真值 or：used=0.0/None 落到分段和；t.used 可被
 *       毒化成 str/None 并原样流进后续算术。
 *   §15 context_window=True（bool）会**原样存入** total 并参与 windowKnown；
 *       窗口 0/负值**不覆盖**已有窗口（update_from_usage）或夹到 1
 *       （update_context_window）。
 *   §16 model_id / cost_source 真值门 + 原样存储：7、9 这类真值非 str 照存。
 *   §17 isExact = bool(used_is_exact) and used > 0（真值 and，短路）。
 *   §18 单例 get_token_analytics 用 `is None` 身份判断；进程内两次调用同
 *       一实例。
 *
 * MIGRATION DECISIONS / DIVERGENCES
 *   DIVERGENCE(port, threading.Lock): python 用 threading.Lock 保护写操作、
 *     读返回快照。JS 单线程无竞争，锁被省略（字段都不建——无消费者读它）。
 *     可观察面（快照一致性）不变：每个方法体是同步临界区。
 *   DIVERGENCE(port, dataclass __repr__/__eq__): 未复刻 —— 四个 dataclass
 *     是模块私有中间结构，grep 证明仓内无打印/比较它们的消费者（消费方走
 *     snapshot() 的 dict）；探针按 vars() 序投影字段。
 *   DIVERGENCE(port, keyword 袋与位置 dict 的歧义): python 的关键字调用在
 *     JS 里镜像为"普通对象实参"（kw-only 函数第一参 / 其他方法末参）。
 *     因此 python 里"把 dict 按位置传给末槽位"不可表达——grep 证明无调用
 *     点这样做（消费方全部用关键字语法调 update_from_usage/reset_session，
 *     其余方法收字符串/数字）。
 *   DIVERGENCE(port, str.lower 全 Unicode 映射): _classify_tool 用 JS
 *     toLowerCase（final sigma ς 等与 python σ 有分歧）；但查表键全是
 *     ASCII——lowered 串能与键相等当且仅当其小写映射落入 ASCII（两侧对该
 *     映射一致），故返回值等价。bytes 实参（python bytes.lower 是 ASCII
 *     的）照 python "不抛、查表必不中、得 other" 的结果直返 other。
 *   DIVERGENCE(port, int() 的 Unicode 十进制数字): python int("١٢") 接受
 *     Nd 类数字与 Unicode 空白；端口只接 ASCII 数字/空白。不可达：
 *     savings_micros 的生产值是 model_registry 按费率算好的 int。
 *   DIVERGENCE(port, 整数精度): python int 任意精度，TS number 是 IEEE
 *     双精度；int("100000000000000000000") 一类 >2^53 的 savings 累计会丢
 *     精度。不可达：savings_micros 是微美元额度，费率域远低于 2^53。
 *   DIVERGENCE(port, property 可调用性): python 的 total_cache_tokens 是
 *     property，`c.total_cache_tokens(1)` 报 "'int' object is not callable"；
 *     TS getter 返回裸 number，调用错误由 JS 引擎措辞（探针不钉这一格）。
 *   DIVERGENCE(port, int(True) 语义): 本端口 pyInt 对 bool 返回 1/0（与
 *     CPython int(True) 一致）；仓内 rate_limiter.ts 的 pyInt 对 bool 抛
 *     TypeError 是其自身场景域的变体，两份实现互不引用。
 */

// ── python 语义助手（房型照抄 execution_provider.ts / context_compactor.ts）──

class TypeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "TypeError";
    }
}
class ValueErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "ValueError";
    }
}
class OverflowErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "OverflowError";
    }
}
class AttributeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "AttributeError";
    }
}
class ZeroDivisionErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "ZeroDivisionError";
    }
}

/** python type(x).__name__（探针可见的异常文案都要用它）。 */
function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (v instanceof Set) return "set";
    if (v instanceof Map) return "dict";
    if (typeof v === "function") return "function";
    if (typeof v === "object") {
        const ctor = (v as { constructor?: { name?: string } }).constructor;
        return ctor && ctor.name && ctor.name !== "Object" ? ctor.name : "dict";
    }
    return typeof v;
}

/** python 真值（bool() 同一语义：NaN 为真——与部分仓内文件本地版不同）。 */
function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.length > 0;
    if (typeof v === "function") return true;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map || v instanceof Set) return v.size > 0;
    if (isPyDict(v)) return Object.keys(v).length > 0;
    return true;
}

/** 房型 isPyDict（memory_layer.ts 家式版）：空容器规则只对普通对象生效。 */
function isPyDict(v: unknown): v is Record<string, unknown> {
    if (v === null || typeof v !== "object") return false;
    if (Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

/** python `a or b`（真值 or，返回原操作数）。 */
function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

const isNumlike = (v: unknown): boolean => typeof v === "number" || typeof v === "boolean";

/** python `a > b`（类型不符抛 CPython 同款文案；NaN 比较为假）。 */
function pyGt(a: unknown, b: unknown): boolean {
    if (isNumlike(a) && isNumlike(b)) return (a as number) > (b as number);
    throw new TypeErrorP(`'>' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/** python `a + b`：数字相加、str+str 拼接、str+非str 抛 concatenate 文案。 */
function pyAdd(a: unknown, b: unknown): unknown {
    if (isNumlike(a) && isNumlike(b)) return (a as number) + (b as number);
    if (typeof a === "string") {
        if (typeof b === "string") return a + b;
        throw new TypeErrorP(`can only concatenate str (not "${pyTypeName(b)}") to str`);
    }
    throw new TypeErrorP(`unsupported operand type(s) for +: '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/** python `a += b`：成功路径同 +，失败文案是 `for +=`（int += str 实测）。 */
function pyIadd(a: unknown, b: unknown): unknown {
    if (isNumlike(a) && isNumlike(b)) return (a as number) + (b as number);
    if (typeof a === "string") {
        if (typeof b === "string") return a + b;
        throw new TypeErrorP(`can only concatenate str (not "${pyTypeName(b)}") to str`);
    }
    throw new TypeErrorP(`unsupported operand type(s) for +=: '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/** python `a - b`。 */
function pySub(a: unknown, b: unknown): unknown {
    if (isNumlike(a) && isNumlike(b)) return (a as number) - (b as number);
    throw new TypeErrorP(`unsupported operand type(s) for -: '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/** python `a / b`（真除法恒 float；零除文案按 int/int 与含 float 分流）。 */
function pyDiv(a: unknown, b: unknown): number {
    if (isNumlike(a) && isNumlike(b)) {
        const x = typeof a === "boolean" ? (a ? 1 : 0) : (a as number);
        const y = typeof b === "boolean" ? (b ? 1 : 0) : (b as number);
        if (y === 0) {
            const intDiv = Number.isInteger(x) && Number.isInteger(y);
            throw new ZeroDivisionErrorP(intDiv ? "division by zero" : "float division by zero");
        }
        return x / y;
    }
    throw new TypeErrorP(`unsupported operand type(s) for /: '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/** python max(a, b)：迭代语义 = 首元为当前值，后元 > 当前值才替换。 */
function pyMax2(a: unknown, b: unknown): unknown {
    return pyGt(b, a) ? b : a;
}

/** python str(x) 的 repr 形态（int() 的 ValueError 文案要用）。 */
function pyRepr(v: unknown): string {
    if (typeof v === "string") {
        const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
        const esc = v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")
            .replaceAll("\r", "\\r").replaceAll("\t", "\\t");
        if (quote === "'") return "'" + esc.replaceAll("'", "\\'") + "'";
        return '"' + esc.replaceAll('"', '\\"') + '"';
    }
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    return String(v);
}

/** CPython int()：bool→1/0、浮点向零截断（NaN→ValueError / inf→OverflowError）、
 *  字符串文法 = 两侧空白 + 符号 + 数字（下划线只能夹在数字之间、前导零合法）。
 *  Unicode Nd 数字不接（见头部 DIVERGENCE）。 */
function pyInt(v: unknown): number {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") {
        if (Number.isNaN(v)) throw new ValueErrorP("cannot convert float NaN to integer");
        if (!Number.isFinite(v)) throw new OverflowErrorP("cannot convert float infinity to integer");
        return Math.trunc(v);
    }
    if (typeof v === "string") {
        const t = v.trim();
        if (!/^[+-]?[0-9](_?[0-9])*$/.test(t)) {
            throw new ValueErrorP(`invalid literal for int() with base 10: ${pyRepr(v)}`);
        }
        const digits = t.replace(/^[+-]/, "").replaceAll("_", "");
        return t.charAt(0) === "-" ? -Number(digits) : Number(digits);
    }
    throw new TypeErrorP(`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
}

/** CPython sum(iterable)：从 int 0 起按 pyAdd 左结合累加。 */
function pySum(xs: unknown): unknown {
    if (typeof xs === "string") throw new TypeErrorP("sum() can't sum strings [use ''.join(seq) instead]");
    if (!Array.isArray(xs)) throw new TypeErrorP(`'${pyTypeName(xs)}' object is not iterable`);
    let acc: unknown = 0;
    for (const x of xs) acc = pyAdd(acc, x);
    return acc;
}

/** python round(x, n) 的类型面：非数字输入抛 CPython 同款 TypeError。 */
function pyRoundTyped(x: unknown, digits: number): unknown {
    if (typeof x !== "number") {
        throw new TypeErrorP(`type ${pyTypeName(x)} doesn't define __round__ method`);
    }
    return pyRound(x, digits);
}

/** CPython round(x, n)：对双精度数的**精确十进制展开**在第 n 位做四舍六入
 *  五成双。实现 = toFixed(n+20) 取展开 → 余量与半单位做**字符串**比较
 *  （恰好半途平局按保留末位数字的奇偶进位）。与仓内既有 pyRound 房型的
 *  差别：rest 全零（值精确等于截断值）时**直接返回**——旧版把精确值也送进
 *  奇偶进位，round(0.0625, 4) 会被误进位成 0.0626（python 是 0.0625），而
 *  1/16 这个命中率在本模块的值域内可达。 */
function pyRound(x: number, digits: number): number {
    if (!Number.isFinite(x)) return x;
    const neg = x < 0;
    const s = Math.abs(x).toFixed(digits + 20);
    const keep = s.slice(0, s.length - 20);
    const rest = s.slice(s.length - 20).replace(/0+$/, "");
    let v = Number(keep);
    if (rest !== "") {
        const c = rest.charAt(0);
        if (c > "5" || rest.length > 1) {
            v += Math.pow(10, -digits);
        } else if (c === "5") {
            // 真半途平局：保留末位（digits=0 时 keep 以 "." 结尾，末位在整数部分）
            const lastKept = keep.charAt(keep.length - 1) === "."
                ? keep.charAt(keep.length - 2)
                : keep.charAt(keep.length - 1);
            if ((parseInt(lastKept, 10) % 2) === 1) v += Math.pow(10, -digits);
        }
    }
    return Number((neg ? -v : v).toFixed(digits));
}

// ── 调用绑定：CPython 的位置/关键字绑定顺序（关键字先吃，位置溢出在后）──

type KwBag = Record<string, unknown>;

function pyUnexpectedKw(fname: string, key: string): TypeErrorP {
    return new TypeErrorP(`${fname}() got an unexpected keyword argument '${key}'`);
}
function pyMultipleValues(fname: string, key: string): TypeErrorP {
    return new TypeErrorP(`${fname}() got multiple values for argument '${key}'`);
}
function pyTooManyN(fname: string, takes: number, given: number): TypeErrorP {
    const noun = takes === 1 ? "positional argument" : "positional arguments";
    const verb = given === 1 ? "was" : "were";
    return new TypeErrorP(`${fname}() takes ${takes} ${noun} but ${given} ${verb} given`);
}
function pyTooManyRange(fname: string, lo: number, hi: number, given: number): TypeErrorP {
    const verb = given === 1 ? "was" : "were";
    return new TypeErrorP(`${fname}() takes from ${lo} to ${hi} positional arguments but ${given} ${verb} given`);
}
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

/**
 * keyword-only 函数（python `def f(self, *, a=…, b=…)`）的绑定。
 * 约定：末位普通对象实参 = 关键字袋（kw-only 函数通常也只有一个实参）；
 * 若袋存在则先按调用序校验关键字（CPython 先吃关键字，未知关键字优先于
 * 位置溢出），再按"位置实参个数 + self"报溢出。
 */
function bindKwOnly(
    fname: string,
    keys: readonly string[],
    args: unknown[],
): KwBag {
    if (args.length === 0) return {};
    let bag: KwBag | null = null;
    let positionalCount = args.length;
    if (isPyDict(args[args.length - 1])) {
        bag = args[args.length - 1] as KwBag;
        positionalCount = args.length - 1;
    }
    if (bag !== null) {
        for (const k of Object.keys(bag)) {
            if (!keys.includes(k)) throw pyUnexpectedKw(fname, k);
        }
        if (positionalCount > 0) throw pyTooManyN(fname, 1, positionalCount + 1);
        return bag;
    }
    throw pyTooManyN(fname, 1, args.length + 1);
}

/**
 * 位置或关键字参数（python `def f(self, a, b=…)`）的绑定。
 * 约定：末位普通对象实参 = 关键字袋；位置实参 = 其余（尾部 undefined 视为
 * 未传）。绑定顺序照 CPython：关键字按调用序（未知→unexpected、与已占位置
 * 撞→multiple values），然后位置溢出（takes 计数含 self），然后缺参。
 */
function bindPosKw(
    fname: string,
    spec: readonly string[],
    requiredCount: number,
    args: unknown[],
): unknown[] {
    let bag: KwBag | null = null;
    let positional = args;
    if (args.length > 0 && isPyDict(args[args.length - 1])) {
        bag = args[args.length - 1] as KwBag;
        positional = args.slice(0, -1);
    }
    while (positional.length > 0 && positional[positional.length - 1] === undefined) {
        positional = positional.slice(0, -1);
    }
    const values: unknown[] = spec.map((_, i) => (i < positional.length ? positional[i] : undefined));
    const occupied = (i: number): boolean => values[i] !== undefined;
    if (bag !== null) {
        for (const k of Object.keys(bag)) {
            const idx = spec.indexOf(k);
            if (idx < 0) throw pyUnexpectedKw(fname, k);
            if (occupied(idx)) throw pyMultipleValues(fname, k);
            values[idx] = bag[k];
        }
    }
    if (positional.length > spec.length) {
        // takes 计数含 self（实测：on_fold 报 "takes 3"，_Breakdown 报 "from 1 to 5"）
        if (requiredCount < spec.length) {
            throw pyTooManyRange(fname, requiredCount + 1, spec.length + 1, positional.length + 1);
        }
        throw pyTooManyN(fname, spec.length + 1, positional.length + 1);
    }
    const missing: string[] = [];
    for (let i = 0; i < requiredCount; i++) {
        if (!occupied(i)) missing.push(spec[i] as string);
    }
    if (missing.length > 0) throw pyMissing(fname, missing);
    return values;
}

// ── 宿主能力缝 ──

/**
 * python `time.time()` 的缝。真实默认 = Date.now()/1000（秒，浮点）；
 * 探针逐场景换成脚本时钟并记账（时钟读是一等事实）。
 */
export const TOKEN_ANALYTICS_SEAMS = {
    timeNow: (): number => Date.now() / 1000,
};

// ── 工具分类映射 ──────────────────────────────────────────────────────────

/** 将工具名归入功能类别。类别决定了行为统计面板的分组。键序 = python dict 插入序。 */
export const _TOOL_CATEGORIES: Record<string, string> = {
    // 文件读写
    "read_text": "file-read", "write_file": "file-write", "edit_file": "file-write",
    "apply_patch": "file-write", "read_file": "file-read",
    // 搜索
    "search_code": "search", "find_files": "search", "list_dir": "search",
    "grep": "search", "glob": "search", "semantic_search": "search",
    // Shell
    "run_command": "shell", "bash": "shell",
    // Web
    "web_search": "web", "web_fetch": "web",
    // 子代理
    "spawn_subagent": "agent", "task": "agent",
    // 技能
    "skill": "skill", "load_skill": "skill",
};

export const _DEFAULT_CATEGORY = "other";

export function _classify_tool(name: unknown): string {
    // python: _TOOL_CATEGORIES.get(name.lower(), _DEFAULT_CATEGORY)
    // None/int 在 .lower() 处抛 AttributeError（任何状态都还没变）。
    // bytes 实参：python bytes.lower() 是 ASCII 的、返回 bytes，查 str 键表
    // 必不中 → other（见头部 DIVERGENCE）。
    if (typeof name !== "string") {
        if (name instanceof Uint8Array) return _DEFAULT_CATEGORY;
        throw new AttributeErrorP(`'${pyTypeName(name)}' object has no attribute 'lower'`);
    }
    const lowered = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(_TOOL_CATEGORIES, lowered)
        ? (_TOOL_CATEGORIES[lowered] as string)
        : _DEFAULT_CATEGORY;
}

// ── 数据结构 ──────────────────────────────────────────────────────────────

/** Token 空间拆分。@dataclass 字段序 = 构造器参数序。 */
export class _Breakdown {
    messages: unknown;       // 对话历史 (user + assistant + tool results)
    system_prompt: unknown;  // 系统提示词
    tools: unknown;          // 工具定义 (JSON Schema)
    skills: unknown;         // 动态加载的技能内容

    constructor(...args: unknown[]) {
        const v = bindPosKw("_Breakdown.__init__", ["messages", "system_prompt", "tools", "skills"], 0, args);
        this.messages = v[0] !== undefined ? v[0] : 0;
        this.system_prompt = v[1] !== undefined ? v[1] : 0;
        this.tools = v[2] !== undefined ? v[2] : 0;
        this.skills = v[3] !== undefined ? v[3] : 0;
    }
}

/** Prompt Caching 统计。savings 由 model_registry 算好传进来——本类不自己定价。 */
export class _CacheStats {
    cache_read_tokens: unknown;        // 累计缓存命中 token
    cache_miss_tokens: unknown;        // 累计缓存未命中 token
    cache_creation_tokens: unknown;    // 累计缓存创建 token
    turn_rates: unknown;               // list[float]
    average_hit_rate: unknown;         // Optional[float]
    estimated_savings_micros: unknown; // 累计节省（微美元）
    cost_source: unknown;              // reported / estimated / fallback / ""

    constructor(...args: unknown[]) {
        const v = bindPosKw("_CacheStats.__init__",
            ["cache_read_tokens", "cache_miss_tokens", "cache_creation_tokens", "turn_rates",
                "average_hit_rate", "estimated_savings_micros", "cost_source"], 0, args);
        this.cache_read_tokens = v[0] !== undefined ? v[0] : 0;
        this.cache_miss_tokens = v[1] !== undefined ? v[1] : 0;
        this.cache_creation_tokens = v[2] !== undefined ? v[2] : 0;
        this.turn_rates = v[3] !== undefined ? v[3] : [];
        this.average_hit_rate = v[4] !== undefined ? v[4] : null;
        this.estimated_savings_micros = v[5] !== undefined ? v[5] : 0;
        this.cost_source = v[6] !== undefined ? v[6] : "";
    }

    /** python @property：属性访问，不是方法调用。 */
    get total_cache_tokens(): unknown {
        return pyAdd(this.cache_read_tokens, this.cache_creation_tokens);
    }

    recompute_average(...args: unknown[]): void {
        bindPosKw("_CacheStats.recompute_average", [], 0, args);
        if (!pyTruth(this.turn_rates)) {
            this.average_hit_rate = null;
            return;
        }
        this.average_hit_rate = pyDiv(pySum(this.turn_rates), (this.turn_rates as unknown[]).length);
    }
}

/** defaultdict(int) 的键序承载物：首次触碰插入、重复累加不重排。 */
export class DefaultDictInt extends Map<string, unknown> {}

/** Agent 行为统计——**本轮**粒度（跨轮累计另存在 TokenAnalytics._total_*）。 */
export class _ActionStats {
    tool_calls: unknown;
    rules_applied: unknown;
    subagents_delegated: unknown;
    tool_breakdown: DefaultDictInt;

    constructor(...args: unknown[]) {
        const v = bindPosKw("_ActionStats.__init__",
            ["tool_calls", "rules_applied", "subagents_delegated", "tool_breakdown"], 0, args);
        this.tool_calls = v[0] !== undefined ? v[0] : 0;
        this.rules_applied = v[1] !== undefined ? v[1] : 0;
        this.subagents_delegated = v[2] !== undefined ? v[2] : 0;
        this.tool_breakdown = v[3] !== undefined ? (v[3] as DefaultDictInt) : new DefaultDictInt();
    }
}

/** 单轮快照——给 UI 展示当前轮的实时状态。 */
export class _TurnSnapshot {
    breakdown: unknown;
    cache: unknown;
    actions: unknown;
    /** 当前模型的真实上下文窗口。0 = 还不知道——不塞"典型值"当默认。 */
    context_window: unknown;
    used: unknown;
    model_id: unknown;
    /** used 是否来自真实来源（provider 的 usage 字段）。False = 本地估算。 */
    used_is_exact: unknown;
    updated_at: unknown;

    constructor(...args: unknown[]) {
        const v = bindPosKw("_TurnSnapshot.__init__",
            ["breakdown", "cache", "actions", "context_window", "used", "model_id",
                "used_is_exact", "updated_at"], 0, args);
        this.breakdown = v[0] !== undefined ? v[0] : new _Breakdown();
        this.cache = v[1] !== undefined ? v[1] : new _CacheStats();
        this.actions = v[2] !== undefined ? v[2] : new _ActionStats();
        this.context_window = v[3] !== undefined ? v[3] : 0;
        this.used = v[4] !== undefined ? v[4] : 0;
        this.model_id = v[5] !== undefined ? v[5] : "";
        this.used_is_exact = v[6] !== undefined ? v[6] : false;
        this.updated_at = v[7] !== undefined ? v[7] : 0.0;
    }
}

// ── TokenAnalytics ───────────────────────────────────────────────────────

const UPDATE_FROM_USAGE_KEYS = [
    "context_tokens", "cache_read", "cache_miss", "cache_creation", "has_cache_info",
    "savings_micros", "cost_source", "used_is_exact", "model_id", "context_window",
    "system_prompt_tokens", "tool_def_tokens", "skill_tokens",
] as const;

const RESET_SESSION_KEYS = ["system_prompt_tokens", "tool_def_tokens", "skill_tokens", "context_window"] as const;

export class TokenAnalytics {
    // python threading.Lock：JS 单线程无竞争，省略（头部 DIVERGENCE）。
    _turn: _TurnSnapshot;
    _total_tool_calls: unknown;
    _total_rules: unknown;
    _total_subagents: unknown;
    _total_turns: unknown;

    constructor(...args: unknown[]) {
        // python: def __init__(self) —— self 之外只收关键字（普通对象实参 = 关键字袋）。
        const v = bindPosKw("TokenAnalytics.__init__", [], 0, args);
        void v;
        this._turn = new _TurnSnapshot();
        // 累计统计（跨轮）
        this._total_tool_calls = 0;
        this._total_rules = 0;
        this._total_subagents = 0;
        this._total_turns = 0;
    }

    /** 从 LLM API 响应的 usage 字段更新统计（全 keyword-only）。 */
    update_from_usage(...args: unknown[]): void {
        const kw = bindKwOnly("TokenAnalytics.update_from_usage", UPDATE_FROM_USAGE_KEYS, args);
        const g = (k: string, d: unknown): unknown => (kw[k] !== undefined ? kw[k] : d);
        const context_tokens = g("context_tokens", 0);
        const cache_read = g("cache_read", 0);
        const cache_miss = g("cache_miss", 0);
        const cache_creation = g("cache_creation", 0);
        const has_cache_info = g("has_cache_info", false);
        const savings_micros = g("savings_micros", 0);
        const cost_source = g("cost_source", "");
        const used_is_exact = g("used_is_exact", false);
        const model_id = g("model_id", "");
        const context_window = g("context_window", 0);
        const system_prompt_tokens = g("system_prompt_tokens", 0);
        const tool_def_tokens = g("tool_def_tokens", 0);
        const skill_tokens = g("skill_tokens", 0);

        const t = this._turn;
        t.used = context_tokens;
        t.used_is_exact = pyTruth(used_is_exact);
        if (pyGt(context_window, 0)) {
            t.context_window = context_window;
        }
        if (pyTruth(model_id)) {
            t.model_id = model_id;
        }
        (t.breakdown as _Breakdown).system_prompt = system_prompt_tokens;
        (t.breakdown as _Breakdown).tools = tool_def_tokens;
        (t.breakdown as _Breakdown).skills = skill_tokens;
        // messages = total - 已知分段。保底不为负。
        const known = pyAdd(pyAdd(system_prompt_tokens, tool_def_tokens), skill_tokens);
        (t.breakdown as _Breakdown).messages = pyMax2(0, pySub(context_tokens, known));

        // 缓存统计: 命中率 = cache_read / 进模型的所有 prompt token。
        //
        // cache_creation 必须在分母里：写入缓存的那部分 token 是新付钱写的，
        // 绝不是"命中"。漏掉它会让命中率在某些 provider 上恒等于
        // read/read == 1.0 —— 因为那一路 cache_miss 取的是 input_tokens
        // （非缓存输入，不含 creation），两边一叠加分母就只剩 read 自己了。
        // 界面于是永远显示 100%，而这一栏存在的意义是让人判断缓存到底省没省钱。
        if (pyTruth(has_cache_info) || pyGt(cache_read, 0) || pyGt(cache_miss, 0) || pyGt(cache_creation, 0)) {
            const c = t.cache as _CacheStats;
            c.cache_read_tokens = pyIadd(c.cache_read_tokens, cache_read);
            c.cache_miss_tokens = pyIadd(c.cache_miss_tokens, cache_miss);
            c.cache_creation_tokens = pyIadd(c.cache_creation_tokens, cache_creation);
            const denom = pyAdd(pyAdd(cache_read, cache_miss), cache_creation);
            if (pyGt(denom, 0)) {
                (c.turn_rates as unknown[]).push(pyDiv(cache_read, denom));
            }
            c.recompute_average();
            // 节省金额由调用方按模型定价算好；本类只累加，不自己定价。
            if (pyTruth(savings_micros)) {
                c.estimated_savings_micros = pyIadd(c.estimated_savings_micros, pyInt(savings_micros));
            }
            if (pyTruth(cost_source)) {
                c.cost_source = cost_source;
            }
        }

        t.updated_at = TOKEN_ANALYTICS_SEAMS.timeNow();
        this._total_turns = pyIadd(this._total_turns, 1);
    }

    /** 更新上下文窗口大小（从 config 或模型注册表获取）。 */
    update_context_window(...args: unknown[]): void {
        const v = bindPosKw("TokenAnalytics.update_context_window", ["max_tokens"], 1, args);
        this._turn.context_window = pyMax2(1, v[0]);
    }

    /** 记录一次工具调用。 */
    on_tool_call(...args: unknown[]): void {
        const v = bindPosKw("TokenAnalytics.on_tool_call", ["tool_name"], 1, args);
        // 分类在锁外先算：classify 抛错时任何状态都没变（怪癖 §11）。
        const cat = _classify_tool(v[0]);
        const a = this._turn.actions as _ActionStats;
        a.tool_calls = pyIadd(a.tool_calls, 1);
        const bd = a.tool_breakdown;
        bd.set(cat, pyIadd(bd.has(cat) ? bd.get(cat) : 0, 1));
        this._total_tool_calls = pyIadd(this._total_tool_calls, 1);
    }

    /** 记录一次规则应用。 */
    on_rule_applied(...args: unknown[]): void {
        bindPosKw("TokenAnalytics.on_rule_applied", [], 0, args);
        const a = this._turn.actions as _ActionStats;
        a.rules_applied = pyIadd(a.rules_applied, 1);
        this._total_rules = pyIadd(this._total_rules, 1);
    }

    /** 记录一次子代理委派。 */
    on_subagent_delegate(...args: unknown[]): void {
        bindPosKw("TokenAnalytics.on_subagent_delegate", [], 0, args);
        const a = this._turn.actions as _ActionStats;
        a.subagents_delegated = pyIadd(a.subagents_delegated, 1);
        this._total_subagents = pyIadd(this._total_subagents, 1);
    }

    /** 折叠后更新——折叠会大幅减少 messages 分段。 */
    on_fold(...args: unknown[]): void {
        const v = bindPosKw("TokenAnalytics.on_fold", ["tokens_before", "tokens_after"], 2, args);
        const t = this._turn;
        const b = t.breakdown as _Breakdown;
        b.messages = pyMax2(0, pySub(pySub(pySub(v[1], b.system_prompt), b.tools), b.skills));
        t.used = v[1];
        t.updated_at = TOKEN_ANALYTICS_SEAMS.timeNow();
    }

    /** 新会话或切换至空会话时，重置会话级缓存与消息统计。 */
    reset_session(...args: unknown[]): void {
        const kw = bindKwOnly("TokenAnalytics.reset_session", RESET_SESSION_KEYS, args);
        const g = (k: string, d: unknown): unknown => (kw[k] !== undefined ? kw[k] : d);
        const system_prompt_tokens = g("system_prompt_tokens", 0);
        const tool_def_tokens = g("tool_def_tokens", 0);
        const skill_tokens = g("skill_tokens", 0);
        const context_window = g("context_window", 0);
        const ctx_win = pyOr(context_window, this._turn.context_window);
        this._turn = new _TurnSnapshot();
        if (pyGt(ctx_win, 0)) {
            this._turn.context_window = ctx_win;
        }
        const b = this._turn.breakdown as _Breakdown;
        b.system_prompt = system_prompt_tokens;
        b.tools = tool_def_tokens;
        b.skills = skill_tokens;
        b.messages = 0;
        this._turn.used = pyAdd(pyAdd(system_prompt_tokens, tool_def_tokens), skill_tokens);
        this._turn.updated_at = TOKEN_ANALYTICS_SEAMS.timeNow();
    }

    /** 用户发送新消息时重置本轮的行为统计（totals/缓存不动）。 */
    reset_turn(...args: unknown[]): void {
        bindPosKw("TokenAnalytics.reset_turn", [], 0, args);
        this._turn.actions = new _ActionStats();
        this._turn.updated_at = TOKEN_ANALYTICS_SEAMS.timeNow();
    }

    /** 返回当前分析数据的快照。格式与前端 Popover 组件的 prop 对齐。 */
    snapshot(...args: unknown[]): Record<string, unknown> {
        bindPosKw("TokenAnalytics.snapshot", [], 0, args);
        const t = this._turn;
        const b = t.breakdown as _Breakdown;
        const c = t.cache as _CacheStats;
        const a = t.actions as _ActionStats;
        const local_sum = pyAdd(pyAdd(pyAdd(b.messages, b.system_prompt), b.tools), b.skills);
        const used = pyTruth(t.used) ? t.used : local_sum;
        const total = t.context_window;
        // 窗口未知（total<=0）时不编造百分比——返回 None，让 UI 显示"窗口
        // 未知"而不是一个错的分级颜色。
        const percent = pyGt(total, 0) ? pyRoundTyped((pyDiv(used, total) as number) * 100, 1) : null;
        // isExact = used 来自真实来源，且分段拼出来的和与它一致（分段里有
        // 启发式估算的 tools/skills，只要它们非零就不能声称"精确"）。
        const is_exact = pyTruth(t.used_is_exact) && pyGt(used, 0);

        const tool_breakdown: Record<string, unknown> = {};
        for (const [k, v] of a.tool_breakdown) tool_breakdown[k] = v;

        return {
            "used": used,
            "total": pyGt(total, 0) ? total : null,
            "percent": percent,
            "modelId": t.model_id,
            "isEstimated": !is_exact,
            "windowKnown": pyGt(total, 0),
            "breakdown": {
                "messages": b.messages,
                "systemPrompt": b.system_prompt,
                "tools": b.tools,
                "skills": b.skills,
            },
            "cache": {
                "cacheReadTokens": c.cache_read_tokens,
                "cacheMissTokens": c.cache_miss_tokens,
                "cacheCreationTokens": c.cache_creation_tokens,
                "averageHitRate": c.average_hit_rate === null ? null : pyRoundTyped(c.average_hit_rate, 4),
                "estimatedSavingsMicros": c.estimated_savings_micros,
                "costSource": c.cost_source,
            },
            "actions": {
                "toolCalls": a.tool_calls,
                "rulesApplied": a.rules_applied,
                "subagentsDelegated": a.subagents_delegated,
                "toolBreakdown": tool_breakdown,
            },
            "totals": {
                "toolCalls": this._total_tool_calls,
                "rulesApplied": this._total_rules,
                "subagentsDelegated": this._total_subagents,
                "turns": this._total_turns,
            },
            "updatedAt": t.updated_at,
        };
    }
}

// ── 进程单例 ──────────────────────────────────────────────────────────────

let _analytics: TokenAnalytics | null = null;

export function get_token_analytics(): TokenAnalytics {
    if (_analytics === null) {
        _analytics = new TokenAnalytics();
    }
    return _analytics;
}

// PORT STATUS: confidence=high todos=[0]
