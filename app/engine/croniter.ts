/**
 * croniter.ts — vendored third-party support module for cron_manager.ts.
 *
 * NOT one of the 221 migration units: this is a faithful TS port of the subset
 * of the third-party `croniter` site-package (installed per
 * `app/requirements.txt`: croniter>=2.0.0) that
 * `app/backend/cron_manager.py::CronJob.calculate_next_run` exercises:
 * `croniter(expr, epoch_float).get_next(float)`.
 *
 * # Why vendor instead of an npm dependency
 *   croniter's validation errors (CroniterBadCronError & friends) LEAK through
 *   `calculate_next_run` (its `except ImportError` does not catch them) and
 *   reach cron_manager's callers, so a third-party JS cron library could not
 *   preserve the observable failure texts. RULEBOOK §1-revision dependency
 *   clause is satisfied either way — functionality parity is what governs.
 *
 * # Ported surface (everything croniter does for a FLOAT start time, next-only)
 *   - `_expand`: aliases (both tuple slots), the EXPANDERS hash pass (H()/R()
 *     forms, crc32 for 'h'), '?' handling, dow '#'/L nth syntax, dom 'W'
 *     nearest-weekday, step/range/list expansion with the exact
 *     CroniterBadCronError/NotAlphaError/UnsupportedSyntax messages, LOWMAP
 *     value_alias, LEN_MEANS_ALL collapse with its other-field-star guard,
 *     the set-sort `f"{i:02}"` key quirk.
 *   - `_calc_next` + `_calc` next-pass procs (year/month/dom/dow/dow_nth/
 *     nearest_wk/hour/minute/second), `_get_next_nearest_diff` incl. the
 *     'l'->range_val substitution and the `d > range_val` skip, the day_or
 *     two-branch union for restricted dom+dow, the 50-year search bound and
 *     CroniterBadDateError("failed to find next date").
 *   - float timestamps are handled as naive UTC seconds: croniter's
 *     `timestamp_to_datetime` for a float start runs
 *     `fromtimestamp(ts, tz=tzutc()).replace(tzinfo=None)` — pure UTC wall
 *     time, machine timezone irrelevant. All relativedelta arithmetic on this
 *     path is fixed-size (days/hours/minutes/seconds) plus month adds that
 *     always pin day=1, so integer epoch arithmetic is exact.
 *
 * # Excluded (unreachable for a float start_time via get_next)
 *   datetime start (tz-aware/DST machinery, _add_tzinfo, pytz branch),
 *   get_prev/_get_prev_nearest_diff, is_prev, second_at_beginning,
 *   expand_from_start_time/_get_low_from_current_date_number, strict
 *   cross-validation, match/match_range/is_valid/value, croniter_range.
 *
 * # Divergences
 *   DIVERGENCE(port, R() randomness): croniter's 'r' hash uses
 *       random.randint(0, 0xFFFFFFFF) (interpreter-global Mersenne Twister);
 *       this port uses Math.random over the same domain. 'r' values were
 *       never reproducible across runs anyway; 'h' (crc32) IS exact and
 *       ported. Unreachable from cron_manager (hash_id is never passed, so
 *       every 'h' form raises the same "Hashed definitions must include
 *       hash_id" python does, and 'r' only appears in hand-written
 *       expressions).
 *   DIVERGENCE(port, python set repr in one message): the nth-mixing error
 *       interpolates `dow={set}` / `nth={dict-of-sets}` python reprs. This
 *       port renders numeric sets ascending — equal to CPython slot order
 *       for the only reachable values (dow 0..7 and nth 1..5 each hash to
 *       their own slot in the initial 8-entry table). A set mixing 'l' with
 *       ints iterates by randomised str hash and can differ; documented and
 *       skipped by the parity probe.
 *   DIVERGENCE(port, regex character classes): python's `\d`/`\w` for str
 *       patterns are Unicode-aware, so the ported regexes use `\p{Nd}` (u
 *       flag) and the swept PY_WORD_CLASS instead of ASCII `[0-9]`, and
 *       pyIntDigits NFKD-folds Nd runs the way CPython's int() reads them.
 *       Residual risk is only ICU-vs-CPython table drift for digits added
 *       after this interpreter's Unicode version. CPython int() extensions
 *       that the guards cannot let through (whitespace, underscores, sign)
 *       stay unreachable here: fields come from `expr_format.split()`, which
 *       strips all whitespace before any of these regexes sees a token.
 *       Absurdly
 *       long digit runs (16+) would exceed JS's exact-integer range where
 *       python ints are arbitrary — the assert fails on both sides and only
 *       the message text could differ; probe keeps nth values sane.
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import { PY_WORD_CLASS } from "./py_unidata.js";

type ExpandedField = Array<number | string>;

/** python str(int) / str(float) for message interpolation ("step '0'"). */
function pyNumberStr(n: number): string {
    return String(n); // JS shortest round-trip repr == CPython float repr
}

// ── error hierarchy (names are part of the observable contract) ──────────────

export class CroniterError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CroniterError";
    }
}

/** python: class CroniterBadCronError(CroniterError) (ValueError line). */
export class CroniterBadCronError extends CroniterError {
    constructor(message: string) {
        super(message);
        this.name = "CroniterBadCronError";
    }
}

export class CroniterUnsupportedSyntaxError extends CroniterBadCronError {
    constructor(message: string) {
        super(message);
        this.name = "CroniterUnsupportedSyntaxError";
    }
}

export class CroniterBadDateError extends CroniterError {
    constructor(message: string) {
        super(message);
        this.name = "CroniterBadDateError";
    }
}

export class CroniterNotAlphaError extends CroniterBadCronError {
    constructor(message: string) {
        super(message);
        this.name = "CroniterNotAlphaError";
    }
}

/** python TypeError (`Invalid ret_type...`). */
export class CroniterTypeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TypeError";
    }
}

// ── constants (verbatim from croniter.py) ────────────────────────────────────

export const MINUTE_FIELD = 0;
export const HOUR_FIELD = 1;
export const DAY_FIELD = 2;
export const MONTH_FIELD = 3;
export const DOW_FIELD = 4;
export const SECOND_FIELD = 5;
export const YEAR_FIELD = 6;

export const UNIX_CRON_LEN = 5;
export const SECOND_CRON_LEN = 6;
export const YEAR_CRON_LEN = 7;

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const M_ALPHAS: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DOW_ALPHAS: Record<string, number> = {
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const WD_KEYS = Object.keys(DOW_ALPHAS).join("|");
const MO_KEYS = Object.keys(M_ALPHAS).join("|");

const RANGES: ReadonlyArray<readonly [number, number]> = [
    [0, 59], [0, 23], [1, 31], [1, 12], [0, 6], [0, 59], [1970, 2099],
];

const LOWMAP: ReadonlyArray<Record<number, number>> = [
    {}, {}, { 0: 1 }, { 0: 1 }, { 7: 0 }, {}, {},
];

const LEN_MEANS_ALL = [60, 24, 31, 12, 7, 60, 130];

const ALPHACONV: ReadonlyArray<Record<string, number | string>> = [
    {}, {}, { l: "l" }, M_ALPHAS, DOW_ALPHAS, {}, {},
];

/** expr_aliases values are (plain, hash) tuples; python indexes [hash_id_expr]. */
const EXPR_ALIASES: Record<string, [string, string]> = {
    "@midnight": ["0 0 * * *", "h h(0-2) * * * h"],
    "@hourly": ["0 * * * *", "h * * * * h"],
    "@daily": ["0 0 * * *", "h h * * * h"],
    "@weekly": ["0 0 * * 0", "h h * * h h"],
    "@monthly": ["0 0 1 * *", "h h h * * h"],
    "@yearly": ["0 0 1 1 *", "h h h h * h"],
    "@annually": ["0 0 1 1 *", "h h h h * h"],
};

/**
 * python `\d` for str patterns is the Unicode Nd category, not ASCII [0-9];
 * the ported regexes below therefore use \p{Nd} with the u flag.
 */
const PD = "\\p{Nd}";

const STEP_SEARCH_RE = new RegExp(`^([^-]+)-([^-/]+)(\\/(${PD}+))?$`, "u");
const ONLY_INT_RE = new RegExp(`^${PD}+$`, "u");
const STAR_OR_INT_RE = new RegExp(`^(${PD}+|\\*)$`, "u");
const HASH_EXPRESSION_RE = new RegExp(
    `^(h|r)(\\((${PD}+)-(${PD}+)\\))?(\\/(${PD}+))?$`,
    "u"
);
const RE_STAR = /[*]/;
const NEAREST_WEEKDAY_RE = new RegExp(`^(?:(${PD}+)w|w(${PD}+))$`, "u");

/**
 * croniter.special_dow_re, verbatim structure (python spelling; the port below
 * substitutes PD for `\d` and PY_WORD_CLASS for `\w`):
 *   ^(?:(?:(?:(WD(-WD)?)|(MO(-MO)?)|\w+)#)|l)(\d+)$
 * `he` captures the part BEFORE the '#'; \w is swapped for the swept CPython
 * word class so the u-flag alternation cannot drift (PY_WORD_CLASS).
 */
const SPECIAL_DOW_RE = new RegExp(
    "^(?:(?:(?<he>" +
        `(?:(?:${WD_KEYS})(?:-(?:${WD_KEYS}))?)|` +
        `(?:(?:${MO_KEYS})(?:-(?:${MO_KEYS}))?)|` +
        `${PY_WORD_CLASS}+)#` +
        "|l))" +
        "(?<last>" + PD + "+)$",
    "u"
);

/** Insertion-ordered dedup preserving python `set(...)` then sorted(). */
function pySetKey(v: number | string): string {
    return typeof v === "number" ? String(v).padStart(2, "0") : v;
}

/** python sorted(res, key=lambda i: f"{i:02}" if isinstance(i,int) else i). */
function sortByPyKey(arr: Array<number | string>): Array<number | string> {
    const keyed = arr.map((v) => ({ v, k: pySetKey(v) }));
    keyed.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
    return keyed.map((x) => x.v);
}

/** see DIVERGENCE(port, python set repr) in the header. */
function pyNumSetRepr(values: Iterable<number | string>): string {
    const arr = Array.from(new Set(values));
    if (arr.length === 0) return "set()";
    arr.sort((a, b) => (pySetKey(a) < pySetKey(b) ? -1 : pySetKey(a) > pySetKey(b) ? 1 : 0));
    return "{" + arr.map((v) => (typeof v === "number" ? pyNumberStr(v) : v)).join(", ") + "}";
}

function pyNthDictRepr(m: Map<number, Set<number | string>>): string {
    const parts: string[] = [];
    for (const [k, s] of m) parts.push(`${k}: ${pyNumSetRepr(s)}`);
    return "{" + parts.join(", ") + "}";
}

const ND_RE = /\p{Nd}/u;

/**
 * CPython int() reads Unicode decimal digits (`٥` -> 5) via
 * `_PyUnicode_TransformDecimalAndSpaceToASCII`; V8's NFKD does NOT fold Nd, so
 * the value is recovered from the code point. Every Nd block is a contiguous
 * run of ten code points starting at value 0, hence the backward scan.
 */
function pyDecimalValueAt(ch: string): number {
    const cp = ch.codePointAt(0) as number;
    let start = cp;
    while (start > cp - 10 && ND_RE.test(String.fromCodePoint(start - 1))) start--;
    return cp - start;
}

/** int() over an already regex-guarded Nd digit string (see header). */
function pyIntDigits(s: string): number {
    let ascii = "";
    for (const ch of s) ascii += String(pyDecimalValueAt(ch));
    const n = Number(ascii);
    if (!Number.isSafeInteger(n)) {
        throw new CroniterBadCronError(`invalid literal for int() with base 10: '${s}'`);
    }
    return n;
}

// ── crc32 (binascii.crc32) ───────────────────────────────────────────────────

const CRC32_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        c = CRC32_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

// ── calendar helpers ─────────────────────────────────────────────────────────

function isLeap(year: number): boolean {
    return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
}

function lastDayOfMonth(year: number, month: number): number {
    let last = DAYS[month - 1]!;
    if (month === 2 && isLeap(year)) last += 1;
    return last;
}

/** Days from 1970-01-01 for a civil date (Howard Hinnant's algorithm). */
function daysFromCivil(y: number, m: number, d: number): number {
    const yy = m <= 2 ? y - 1 : y;
    const era = Math.floor(yy / 400);
    const yoe = yy - era * 400;
    const mp = (m + 9) % 12;
    const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
}

function civilFromDays(z0: number): [number, number, number] {
    const z = z0 + 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor(
        (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
    );
    const y = yoe + era * 400;
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const m = mp < 10 ? mp + 3 : mp - 9;
    return [m <= 2 ? y + 1 : y, m, d];
}

interface Fields {
    y: number;
    mo: number;
    d: number;
    h: number;
    mi: number;
    s: number;
}

function fieldsFromEpochSeconds(ts: number): Fields {
    const t = Math.floor(ts);
    const days = Math.floor(t / 86400);
    const sod = t - days * 86400;
    const [y, mo, d] = civilFromDays(days);
    return { y, mo, d, h: Math.floor(sod / 3600), mi: Math.floor((sod % 3600) / 60), s: sod % 60 };
}

function epochSecondsFromFields(f: Fields): number {
    return daysFromCivil(f.y, f.mo, f.d) * 86400 + f.h * 3600 + f.mi * 60 + f.s;
}

/** python isoweekday() % 7 == JS getUTCDay: Sun=0..Sat=6. 1970-01-01 was Thursday. */
function dowOfFields(f: Fields): number {
    const z = daysFromCivil(f.y, f.mo, f.d);
    return ((z % 7) + 11) % 7;
}

function addMonths(f: Fields, diff: number): void {
    const total = f.y * 12 + (f.mo - 1) + diff;
    f.y = Math.floor(total / 12);
    f.mo = (total % 12) + 1;
}

function zeroTime(f: Fields): void {
    f.h = 0;
    f.mi = 0;
    f.s = 0;
}

function cloneFields(f: Fields): Fields {
    return { ...f };
}

type ProcResult = [unknown, Fields];

// ── the iterator ─────────────────────────────────────────────────────────────

export class Croniter {
    static readonly MONTHS_IN_YEAR = 12;

    expanded: ExpandedField[] = [];
    nthWeekdayOfMonth = new Map<number, Set<number | string>>();
    expressions: string[] = [];
    nearestWeekday: number[] = [];

    private _retType: unknown = Number;
    private _dayOr: boolean;
    private _implementCronBug: boolean;
    private _maxYearsBetweenMatches: number;
    private _maxYearsExplicitlySet: boolean;

    startTime = 0.0;
    dstStartTime = 0.0;
    cur = 0.0;

    private _hashId: Uint8Array | null;

    constructor(
        exprFormat: string,
        startTime: number | null = null,
        opts: {
            dayOr?: boolean;
            maxYearsBetweenMatches?: number | null;
            implementCronBug?: boolean;
            hashId?: Uint8Array | null;
        } = {}
    ) {
        this._dayOr = opts.dayOr ?? true;
        this._implementCronBug = opts.implementCronBug ?? false;
        const m = opts.maxYearsBetweenMatches ?? null;
        this._maxYearsExplicitlySet = m !== null;
        this._maxYearsBetweenMatches = Math.max(Math.trunc(m ?? 50), 1);
        this._hashId = opts.hashId ?? null;
        if (startTime === null) startTime = Date.now() / 1000;
        this.setCurrent(startTime, true);
        const ex = Croniter.expandInternal(exprFormat, this._hashId);
        this.expanded = ex.expanded;
        this.nthWeekdayOfMonth = ex.nth;
        this.expressions = ex.expressions;
        this.nearestWeekday = ex.nearest;
    }

    setCurrent(startTime: number | null, force: boolean): number {
        if ((force || this.cur === null) && startTime !== null) {
            this.startTime = startTime;
            this.dstStartTime = startTime;
            this.cur = startTime;
        }
        return this.cur;
    }

    /** croniter.get_next(float) — the form cron_manager uses. */
    get_next(retType: unknown = null, startTime: number | null = null, updateCurrent = true): number {
        return this._getNext(retType, startTime, false, updateCurrent);
    }

    private _getNext(
        retType: unknown,
        startTime: number | null,
        isPrev: boolean,
        updateCurrent: boolean
    ): number {
        this.setCurrent(startTime, true);
        const rt = retType || this._retType;
        if (rt !== Number && rt !== "datetime") {
            throw new CroniterTypeError("Invalid ret_type, only 'float' or 'datetime' is acceptable.");
        }
        const result = this._calcNext(isPrev);
        const timestamp = epochSecondsFromFields(result);
        if (updateCurrent) this.cur = timestamp;
        return timestamp;
    }

    private _calcNext(isPrev: boolean): Fields {
        if (isPrev) throw new CroniterError("get_prev is not part of the ported surface");
        const current = fieldsFromEpochSeconds(this.cur);
        const expanded = this.expanded.slice();
        const nth = new Map(this.nthWeekdayOfMonth);

        if (
            expanded[DAY_FIELD]![0] !== "*" &&
            expanded[DOW_FIELD]![0] !== "*" &&
            this._dayOr
        ) {
            if (
                this._implementCronBug &&
                (RE_STAR.test(this.expressions[DAY_FIELD]!) ||
                    RE_STAR.test(this.expressions[DOW_FIELD]!))
            ) {
                // cron-bug mode: fall through to the intersection path
            } else {
                const bak = expanded[DOW_FIELD]!;
                expanded[DOW_FIELD] = ["*"];
                const t1 = this._calc(cloneFields(current), expanded, nth);
                expanded[DOW_FIELD] = bak;
                expanded[DAY_FIELD] = ["*"];
                const t2 = this._calc(cloneFields(current), expanded, nth);
                return epochSecondsFromFields(t1) <= epochSecondsFromFields(t2) ? t1 : t2;
            }
        }
        return this._calc(cloneFields(current), expanded, nth);
    }

    /** _calc, next pass only (see header). */
    private _calc(
        now: Fields,
        expanded: ExpandedField[],
        nthWeekdayOfMonth: Map<number, Set<number | string>>
    ): Fields {
        let t = cloneFields(now);
        let te = epochSecondsFromFields(t);
        te += expanded.length > UNIX_CRON_LEN ? 1 : 60;
        if (expanded.length > UNIX_CRON_LEN) {
            te = Math.floor(te);
        } else {
            te = te - ((te % 60) + 60) % 60;
        }
        t = fieldsFromEpochSeconds(te);

        let month = t.mo;
        const currentYear = t.y;
        let year = t.y;

        const nextDiff = Croniter._getNextNearestDiff;

        const procYear = (f: Fields): ProcResult => {
            if (expanded.length === YEAR_CRON_LEN && !expanded[YEAR_FIELD]!.includes("*")) {
                const diffYear = nextDiff(f.y, expanded[YEAR_FIELD]!, null);
                if (diffYear === null) return [null, f];
                if (diffYear !== 0) {
                    const g = cloneFields(f);
                    g.y = f.y + diffYear;
                    g.mo = 1;
                    g.d = 1;
                    zeroTime(g);
                    return [true, g];
                }
            }
            return [false, f];
        };

        const procMonth = (f: Fields): ProcResult => {
            if (!expanded[MONTH_FIELD]!.includes("*")) {
                const diffMonth = nextDiff(f.mo, expanded[MONTH_FIELD]!, Croniter.MONTHS_IN_YEAR);
                if (diffMonth !== null && diffMonth !== 0) {
                    addMonths(f, diffMonth);
                    f.d = 1;
                    f.h = 0;
                    f.mi = 0;
                    f.s = 0;
                    return [true, f];
                }
            }
            return [false, f];
        };

        const procDayOfMonth = (f: Fields): ProcResult => {
            if (!expanded[DAY_FIELD]!.includes("*")) {
                const days = lastDayOfMonth(year, month);
                if (expanded[DAY_FIELD]!.includes("l") && days === f.d) return [false, f];
                const diffDay = nextDiff(f.d, expanded[DAY_FIELD]!, days);
                if (diffDay !== null && diffDay !== 0) {
                    const g = fieldsFromEpochSeconds(epochSecondsFromFields(f) + diffDay * 86400);
                    zeroTime(g);
                    return [true, g];
                }
            }
            return [false, f];
        };

        const procDayOfWeek = (f: Fields): ProcResult => {
            if (!expanded[DOW_FIELD]!.includes("*")) {
                const diffDow = nextDiff(dowOfFields(f), expanded[DOW_FIELD]!, 7);
                if (diffDow !== null && diffDow !== 0) {
                    const g = fieldsFromEpochSeconds(epochSecondsFromFields(f) + diffDow * 86400);
                    zeroTime(g);
                    return [true, g];
                }
            }
            return [false, f];
        };

        /** _get_nth_weekday_of_month: all days of `wday` in the month, ascending. */
        const nthWeekdayList = (y: number, mo: number, dayOfWeek: number): number[] => {
            // calendar.Calendar(firstweekday=(dow+6)%7).monthdayscalendar: the
            // leading column holds the month's first `wday`, and the weekday of
            // the 1st is calendar.weekday() (Mon=0), not the croniter dow (Sun=0).
            const w = (dayOfWeek + 6) % 7;
            const firstDow = (dowOfFields({ y, mo, d: 1, h: 0, mi: 0, s: 0 }) + 6) % 7;
            const offset = (w - firstDow + 7) % 7;
            const out: number[] = [];
            for (let day = 1 + offset; day <= lastDayOfMonth(y, mo); day += 7) out.push(day);
            return out;
        };

        const procDayOfWeekNth = (f: Fields): ProcResult => {
            if (nthWeekdayOfMonth.has(Number("*"))) {
                /* unreachable: parse only ever sets integer keys */
            }
            if (nthWeekdayOfMonth.has("*" as unknown as number)) {
                const s = nthWeekdayOfMonth.get("*" as unknown as number)!;
                for (let i = 0; i < 7; i++) {
                    const c = nthWeekdayOfMonth.get(i);
                    if (c) for (const x of s) c.add(x);
                    else nthWeekdayOfMonth.set(i, s);
                }
                nthWeekdayOfMonth.delete("*" as unknown as number);
            }
            const candidates: number[] = [];
            for (const [wday, nthSet] of nthWeekdayOfMonth) {
                const c = nthWeekdayList(f.y, f.mo, wday);
                for (const n of nthSet) {
                    let candidate: number;
                    if (n === "l") candidate = c[c.length - 1]!;
                    else {
                        if (c.length < (n as number)) continue;
                        candidate = c[(n as number) - 1]!;
                    }
                    if (f.d <= candidate) candidates.push(candidate);
                }
            }
            if (candidates.length === 0) {
                const days = lastDayOfMonth(year, month);
                const g = fieldsFromEpochSeconds(
                    epochSecondsFromFields(f) + (days - f.d + 1) * 86400
                );
                zeroTime(g);
                return [true, g];
            }
            candidates.sort((a, b) => a - b);
            const diffDay = candidates[0]! - f.d;
            if (diffDay !== 0) {
                const g = fieldsFromEpochSeconds(epochSecondsFromFields(f) + diffDay * 86400);
                zeroTime(g);
                return [true, g];
            }
            return [false, f];
        };

        /** _get_nearest_weekday (calendar.weekday Mon=0..Sun=6). */
        const nearestWeekdayAt = (y: number, mo: number, day: number): number => {
            const last = lastDayOfMonth(y, mo);
            const dd = Math.min(day, last);
            const weekday = dowOfFields({ y, mo, d: dd, h: 0, mi: 0, s: 0 });
            const monFirst = (weekday + 6) % 7;
            if (monFirst < 5) return dd;
            if (monFirst === 5) return dd > 1 ? dd - 1 : dd + 2;
            return dd < last ? dd + 1 : dd - 2;
        };

        const procNearestWeekday = (f: Fields): ProcResult => {
            const candidates: number[] = [];
            for (const wDay of this.nearestWeekday) {
                const candidate = nearestWeekdayAt(f.y, f.mo, wDay);
                if (f.d <= candidate) candidates.push(candidate);
            }
            if (candidates.length === 0) {
                const days = lastDayOfMonth(year, month);
                const g = fieldsFromEpochSeconds(
                    epochSecondsFromFields(f) + (days - f.d + 1) * 86400
                );
                zeroTime(g);
                return [true, g];
            }
            candidates.sort((a, b) => a - b);
            const diffDay = candidates[0]! - f.d;
            if (diffDay !== 0) {
                const g = fieldsFromEpochSeconds(epochSecondsFromFields(f) + diffDay * 86400);
                zeroTime(g);
                return [true, g];
            }
            return [false, f];
        };

        const procHour = (f: Fields): ProcResult => {
            if (!expanded[HOUR_FIELD]!.includes("*")) {
                const diffHour = nextDiff(f.h, expanded[HOUR_FIELD]!, 24);
                if (diffHour !== null && diffHour !== 0) {
                    const g = fieldsFromEpochSeconds(epochSecondsFromFields(f) + diffHour * 3600);
                    g.mi = 0;
                    g.s = 0;
                    return [true, g];
                }
            }
            return [false, f];
        };

        const procMinute = (f: Fields): ProcResult => {
            if (!expanded[MINUTE_FIELD]!.includes("*")) {
                const diffMin = nextDiff(f.mi, expanded[MINUTE_FIELD]!, 60);
                if (diffMin !== null && diffMin !== 0) {
                    const g = fieldsFromEpochSeconds(epochSecondsFromFields(f) + diffMin * 60);
                    g.s = 0;
                    return [true, g];
                }
            }
            return [false, f];
        };

        const procSecond = (f: Fields): ProcResult => {
            if (expanded.length > UNIX_CRON_LEN) {
                if (!expanded[SECOND_FIELD]!.includes("*")) {
                    const diffSec = nextDiff(f.s, expanded[SECOND_FIELD]!, 60);
                    if (diffSec !== null && diffSec !== 0) {
                        return [true, { ...f, s: f.s + diffSec }];
                    }
                }
            } else {
                f.s = 0;
            }
            return [false, f];
        };

        const procs: Array<(f: Fields) => ProcResult> = [
            procYear,
            procMonth,
            this.nearestWeekday.length > 0 ? procNearestWeekday : procDayOfMonth,
            nthWeekdayOfMonth.size > 0 ? procDayOfWeekNth : procDayOfWeek,
            procHour,
            procMinute,
            procSecond,
        ];

        while (Math.abs(year - currentYear) <= this._maxYearsBetweenMatches) {
            let advanced = false;
            let stop = false;
            for (const proc of procs) {
                const [changed, nt] = proc(t);
                if (changed === null) {
                    stop = true;
                    break;
                }
                t = nt;
                if (changed) {
                    month = t.mo;
                    year = t.y;
                    advanced = true;
                    break;
                }
            }
            if (stop) break;
            if (advanced) continue;
            return t;
        }
        throw new CroniterBadDateError("failed to find next date");
    }

    static _getNextNearestDiff(
        x: number,
        toCheck: ExpandedField,
        rangeVal: number | null
    ): number | null {
        for (let i = 0; i < toCheck.length; i++) {
            let d = toCheck[i];
            if (rangeVal !== null) {
                if (d === "l") d = rangeVal;
                else if ((d as number) > rangeVal) continue;
            }
            if ((d as number) >= x) return (d as number) - x;
        }
        if (rangeVal === null) return null;
        return (toCheck[0] as number) - x + rangeVal;
    }

    static valueAlias(val: number, fieldIndex: number, lenExpressions: number): number {
        const low = LOWMAP[fieldIndex]!;
        if (Object.prototype.hasOwnProperty.call(low, String(val))) {
            if (
                !(
                    ((fieldIndex === DAY_FIELD || fieldIndex === MONTH_FIELD) &&
                        lenExpressions === UNIX_CRON_LEN) ||
                    ((fieldIndex === MONTH_FIELD || fieldIndex === DOW_FIELD) &&
                        lenExpressions === SECOND_CRON_LEN) ||
                    ((fieldIndex === DAY_FIELD ||
                        fieldIndex === MONTH_FIELD ||
                        fieldIndex === DOW_FIELD) &&
                        lenExpressions === YEAR_CRON_LEN)
                )
            ) {
                val = low[val]!;
            }
        }
        return val;
    }

    static _alphaconv(index: number, key: string, expressions: string[]): number | string {
        const table = ALPHACONV[index]!;
        if (Object.prototype.hasOwnProperty.call(table, key)) return table[key]!;
        throw new CroniterNotAlphaError(`[${expressions.join(" ")}] is not acceptable`);
    }

    /** HashExpander.expand — the single EXPANDER. hash_id null mirrors cron_manager. */
    private static _hashExpand(
        efl: string,
        idx: number,
        expr: string,
        hashId: Uint8Array | null
    ): string {
        const m = HASH_EXPRESSION_RE.exec(expr);
        if (!m) return expr;
        const hashType = m[1];
        const rangeBegin = m[3];
        const rangeEnd = m[4];
        const divisor = m[6];

        if (hashType === "h" && hashId === null) {
            throw new CroniterBadCronError("Hashed definitions must include hash_id");
        }
        if (rangeBegin && rangeEnd) {
            if (pyIntDigits(rangeBegin) >= pyIntDigits(rangeEnd)) {
                throw new CroniterBadCronError("Range end must be greater than range begin");
            }
        }
        const doHash = (rb: number, re: number): number => {
            const crc =
                hashType === "r"
                    ? Math.floor(Math.random() * 0x100000000)
                    : crc32(hashId as Uint8Array);
            return ((crc >>> idx) % (re - rb + 1)) + rb;
        };
        if (rangeBegin && rangeEnd && divisor) {
            if (pyIntDigits(divisor) === 0) {
                throw new CroniterBadCronError(`Bad expression: ${expr}`);
            }
            const x = doHash(pyIntDigits(rangeBegin), pyIntDigits(divisor) - 1 + pyIntDigits(rangeBegin));
            return `${x}-${pyIntDigits(rangeEnd)}/${pyIntDigits(divisor)}`;
        }
        if (rangeBegin && rangeEnd) {
            return String(doHash(pyIntDigits(rangeBegin), pyIntDigits(rangeEnd)));
        }
        if (divisor) {
            if (pyIntDigits(divisor) === 0) {
                throw new CroniterBadCronError(`Bad expression: ${expr}`);
            }
            const x = doHash(RANGES[idx]![0], pyIntDigits(divisor) - 1 + RANGES[idx]![0]);
            return `${x}-${RANGES[idx]![1]}/${pyIntDigits(divisor)}`;
        }
        return String(doHash(RANGES[idx]![0], RANGES[idx]![1]));
    }

    /** croniter._expand for the float-start, non-strict path. */
    static expandInternal(
        exprFormat: string,
        hashId: Uint8Array | null = null
    ): {
        expanded: ExpandedField[];
        nth: Map<number, Set<number | string>>;
        expressions: string[];
        nearest: number[];
    } {
        const efl0 = String(exprFormat).toLowerCase();
        const hashIdExpr = hashId !== null ? 1 : 0;
        let efl = efl0;
        if (Object.prototype.hasOwnProperty.call(EXPR_ALIASES, efl0)) {
            efl = EXPR_ALIASES[efl0]![hashIdExpr];
        }
        // python str.split() — whitespace runs, no empty members
        const expressions = efl.split(/\s+/).filter((s) => s.length > 0);

        if (expressions.length !== 5 && expressions.length !== 6 && expressions.length !== 7) {
            throw new CroniterBadCronError(
                "Exactly 5, 6 or 7 columns has to be specified for iterator expression."
            );
        }

        const expanded: ExpandedField[] = [];
        const nthWeekday = new Map<number, Set<number | string>>();
        const nearestWeekday: number[] = [];

        for (let fieldIndex = 0; fieldIndex < expressions.length; fieldIndex++) {
            let expr: string = Croniter._hashExpand(
                efl,
                fieldIndex,
                expressions[fieldIndex]!,
                hashId
            );

            if (expr.includes("?")) {
                if (expr !== "?") {
                    throw new CroniterBadCronError(
                        `[${exprFormat}] is not acceptable. Question mark can not used with other characters`
                    );
                }
                if (fieldIndex !== DAY_FIELD && fieldIndex !== DOW_FIELD) {
                    throw new CroniterBadCronError(
                        `[${exprFormat}] is not acceptable. Question mark can only used in day_of_month or day_of_week`
                    );
                }
                expr = "*";
            }

            const eList: Array<number | string> = expr.split(",");
            const res: Array<number | string> = [];
            const seen = new Set<number | string>();

            while (eList.length > 0) {
                let e = eList.pop()!;
                let nth: number | "l" | null = null;

                if (fieldIndex === DOW_FIELD) {
                    const sm = SPECIAL_DOW_RE.exec(String(e));
                    if (sm) {
                        const he = sm.groups?.he ?? "";
                        const last = sm.groups?.last ?? "";
                        if (he) {
                            e = he;
                            try {
                                const v = pyIntDigits(last);
                                nth = v; // python assigns before the assert
                                if (!(5 >= (v as number) && (v as number) >= 1)) {
                                    throw new Error("assert failed");
                                }
                            } catch {
                                throw new CroniterBadCronError(
                                    `[${exprFormat}] is not acceptable. Invalid day_of_week value: '${
                                        nth === null ? "None" : pyNumberStr(nth)
                                    }'`
                                );
                            }
                        } else if (last) {
                            e = last;
                            nth = "l";
                        }
                    }
                }

                if (fieldIndex === DAY_FIELD) {
                    const wm = NEAREST_WEEKDAY_RE.exec(String(e));
                    if (wm) {
                        const wDay = pyIntDigits(String(wm[1] || wm[2]));
                        if (wDay < 1 || wDay > 31) {
                            throw new CroniterBadCronError(
                                `[${exprFormat}] is not acceptable, nearest weekday day value '${wDay}' out of range`
                            );
                        }
                        if (eList.length > 0 || res.length > 0) {
                            throw new CroniterBadCronError(
                                `[${exprFormat}] is not acceptable. 'W' can only be used with a single day value, not in a list or range`
                            );
                        }
                        nearestWeekday.push(wDay);
                        res.push(wDay);
                        continue;
                    }
                }

                const es = String(e);
                let t = es.replace(/^\*\/(.+)$/, `${RANGES[fieldIndex]![0]}-${RANGES[fieldIndex]![1]}/$1`);
                let m = STEP_SEARCH_RE.exec(t);

                if (!m) {
                    t = es.replace(/^(.+)\/(.+)$/, `$1-${RANGES[fieldIndex]![1]}/$2`);
                    m = STEP_SEARCH_RE.exec(t);
                }

                if (m) {
                    let low: string = m[1]!;
                    let high: string = m[2]!;
                    let stepS: string | number = m[4] ?? 1;
                    if (fieldIndex === DAY_FIELD && high === "l") high = "31";

                    if (!ONLY_INT_RE.test(low)) {
                        low = String(Croniter._alphaconv(fieldIndex, low, expressions));
                    }
                    if (!ONLY_INT_RE.test(high)) {
                        high = String(Croniter._alphaconv(fieldIndex, high, expressions));
                    }
                    if (!ONLY_INT_RE.test(String(stepS))) {
                        throw new CroniterBadCronError(
                            `[${exprFormat}] step '${String(stepS)}' in field ${fieldIndex} is not acceptable`
                        );
                    }
                    const step = pyIntDigits(String(stepS));
                    if (step === 0) {
                        throw new CroniterBadCronError(
                            `[${exprFormat}] step '0' in field ${fieldIndex} is not acceptable`
                        );
                    }

                    for (const band of [low, high]) {
                        if (!ONLY_INT_RE.test(String(band))) {
                            throw new CroniterBadCronError(
                                `[${exprFormat}] bands '${low}-${high}' in field ${fieldIndex} are not acceptable`
                            );
                        }
                    }

                    const lo = Croniter.valueAlias(pyIntDigits(low), fieldIndex, expressions.length);
                    const hi = Croniter.valueAlias(pyIntDigits(high), fieldIndex, expressions.length);

                    if (Math.max(lo, hi) > Math.max(RANGES[fieldIndex]![0], RANGES[fieldIndex]![1])) {
                        throw new CroniterBadCronError(`${exprFormat} is out of bands`);
                    }

                    let rng: Array<number | string> = [];
                    if (lo > hi) {
                        const whole: number[] = [];
                        for (let v = RANGES[fieldIndex]![0]; v <= RANGES[fieldIndex]![1]; v++) whole.push(v);
                        for (let v = lo; v <= RANGES[fieldIndex]![1]; v += step) rng.push(v);
                        let toSkip = 0;
                        if (rng.length > 0) {
                            const lastVal = rng[rng.length - 1] as number;
                            let alreadySkipped = 0;
                            for (let i = whole.length - 1; i >= 0; i--) {
                                if (whole[i] === lastVal) {
                                    alreadySkipped = whole.length - 1 - i;
                                    break;
                                }
                            }
                            const curpos = whole.indexOf(lastVal);
                            if (curpos + step > whole.length && alreadySkipped < step) {
                                toSkip = step - alreadySkipped;
                            }
                        }
                        for (let v = RANGES[fieldIndex]![0] + toSkip; v <= hi; v += step) rng.push(v);
                    } else if (lo === hi) {
                        for (let v = RANGES[fieldIndex]![0]; v <= RANGES[fieldIndex]![1]; v += step)
                            rng.push(v);
                    } else {
                        for (let v = lo; v <= hi; v += step) rng.push(v);
                    }

                    if (fieldIndex === DOW_FIELD && nth !== null && nth !== "l") {
                        rng = rng.map((item) => `${item}#${nth}`);
                    }
                    for (const a of rng) if (!seen.has(a)) eList.push(a);
                    for (const a of rng) seen.add(a);
                } else {
                    if (t.startsWith("-")) {
                        throw new CroniterBadCronError(
                            `[${exprFormat}] is not acceptable, negative numbers not allowed`
                        );
                    }
                    let tok: number | string = t;
                    if (!STAR_OR_INT_RE.test(t)) {
                        tok = Croniter._alphaconv(fieldIndex, t, expressions);
                    } else if (ONLY_INT_RE.test(t)) {
                        tok = pyIntDigits(t);
                    }
                    // python: try int(t) except ValueError pass — "*" and "l"
                    // stay strings; digit strings became ints above.
                    if (typeof tok === "number") {
                        tok = Croniter.valueAlias(tok, fieldIndex, expressions.length);
                    }
                    if (tok !== "*" && tok !== "l") {
                        const n = typeof tok === "number" ? tok : pyIntDigits(String(tok));
                        if (n < RANGES[fieldIndex]![0] || n > RANGES[fieldIndex]![1]) {
                            throw new CroniterBadCronError(
                                `[${exprFormat}] is not acceptable, out of range`
                            );
                        }
                        res.push(n);
                        if (fieldIndex === DOW_FIELD && nth !== null) {
                            if (!nthWeekday.has(n)) nthWeekday.set(n, new Set());
                            nthWeekday.get(n)!.add(nth);
                        }
                    } else {
                        res.push(tok);
                    }
                }
            }

            let fin: Array<number | string> = sortByPyKey(Array.from(new Set(res)));
            if (fin.length === LEN_MEANS_ALL[fieldIndex]) {
                if (
                    (fieldIndex === DAY_FIELD && !expressions[DOW_FIELD]!.includes("*")) ||
                    (fieldIndex === DOW_FIELD && !expressions[DAY_FIELD]!.includes("*"))
                ) {
                    // keep the expanded values (avoid over-optimization)
                } else {
                    fin = ["*"];
                }
            }

            expanded.push(fin.length === 1 && fin[0] === "*" ? ["*"] : fin);
        }

        if (nthWeekday.size > 0) {
            const dowBase = Array.from(new Set(expanded[DOW_FIELD] ?? []));
            const diff = dowBase.filter(
                (v) => !Array.from(nthWeekday.keys()).some((k) => k === v) && v !== "*"
            );
            if (diff.length > 0 && new Set(expanded[DOW_FIELD]!).size !== LEN_MEANS_ALL[DOW_FIELD]) {
                throw new CroniterUnsupportedSyntaxError(
                    `day-of-week field does not support mixing literal values and nth` +
                        ` day of week syntax.  Cron: '${exprFormat}'` +
                        `    dow=${pyNumSetRepr(diff)} vs nth=${pyNthDictRepr(nthWeekday)}`
                );
            }
        }

        return { expanded, nth: nthWeekday, expressions, nearest: nearestWeekday };
    }
}

/** Module-level convenience mirroring `croniter(expr, now).get_next(float)`. */
export function croniterNext(expression: string, now: number): number {
    return new Croniter(expression, now).get_next(Number);
}
