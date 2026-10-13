/**
 * url_guard.ts — URL Guard with SSRF protection, IMDS blacklist, and private
 * network filtering.
 *
 * Ported from `app/backend/url_guard.py` (144 lines).
 *
 * Provides URL sanitization and destination verification based on community
 * reference implementation.
 *
 * RULEBOOK CITATIONS
 *   §1  node:dns (getaddrinfo) via a worker_threads + SharedArrayBuffer sync
 *       bridge (the previous same-thread async bridge deadlocked behind
 *       Atomics.wait, evidence tmp/urlgu2_ts_divergence.json); no
 *       child_process/subprocess anywhere.
 *   §2  Python 3.13.12 stdlib semantics are mirrored bug-for-bug; every
 *       boundary was decided by the pinned-interpreter oracle artifacts
 *       tmp/urlgu2_oracle_facts.json / tmp/urlgu2_oracle2_facts.json:
 *       - urllib.parse.urlsplit: lstrip C0+space, global \t\r\n removal,
 *         scheme grammar (ASCII-letter start + scheme_chars), _splitnetloc
 *         (only / ? # delimit the netloc — a backslash does NOT, unlike
 *         WHATWG), bracket checks ("Invalid IPv6 URL", IPvFuture regex,
 *         ip_address messages), _checknetloc NFKC, _userinfo/_hostinfo
 *         splits, hostname lowercasing with IPv6 zone-case preservation,
 *         lazy port property messages ("Port could not be cast to integer
 *         value as 'x'" / "Port out of range 0-65535"). new URL()/WHATWG is
 *         NOT used: WHATWG normalizes 2130706433/0177.0.0.1 to loopback
 *         ints and treats '\' as '/', faces the oracle proves CPython
 *         sends to the resolver instead (check_url_base DNSFAIL rows).
 *       - ipaddress: IPv4Address/IPv6Address parse rules (4-octal-decimal
 *         no-leading-zeros; RFC hextets with ::, v4 tail, scope ids),
 *         str() compression (leftmost-longest zero run), IPv4-mapped
 *         rendering and per-property delegation, _IPv4Constants /
 *         _IPv6Constants tables and _BLOCKED_NETWORKS verbatim.
 *       - Python str.strip()/lower()/repr() semantics via pyStrip/pyRepr.
 *   §2  gaierror → "域名解析失败 (DNS resolution failed): {err}" keeps the
 *       OS-layer resolver wording verbatim per side (CPython "[Errno 11001]
 *       getaddrinfo failed" vs V8 "getaddrinfo ENOTFOUND ..."); the parity
 *       gate masks ONLY the raw resolver tail after that prefix (registered
 *       normalization, no whole-row ignores).
 *   §4  naming: url_guard.py → url_guard.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import { Worker } from "node:worker_threads";
import { TextDecoder } from "node:util";

// ---------------------------------------------------------------------------
// Python-visible error classes
// ---------------------------------------------------------------------------

class PyValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

class PyGaiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "gaierror";
  }
}

function pyStr(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}

// ---------------------------------------------------------------------------
// Python str helpers (bug-for-bug)
// ---------------------------------------------------------------------------

/** Py_UNICODE_ISSPACE set used by str.strip() with no arguments. */
function isPySpace(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0b || cp === 0x0c || cp === 0x0d) {
    return true;
  }
  if (cp === 0x20 || (cp >= 0x1c && cp <= 0x1f)) {
    return true;
  }
  if (cp === 0x85 || cp === 0xa0 || cp === 0x1680) {
    return true;
  }
  if (cp >= 0x2000 && cp <= 0x200a) {
    return true;
  }
  return cp === 0x2028 || cp === 0x2029 || cp === 0x202f || cp === 0x205f || cp === 0x3000;
}

/** str.strip() (Python): removes leading/trailing Unicode whitespace.
 * Exported as a documented test-mirror surface: the parity probes must apply
 * the exact `url.strip()` the source performs before urlparse; the
 * Py_UNICODE_ISSPACE set is pinned by oracle faces tmp/urlgu2_oracle2_facts.json
 * sections strip2/env2 (NBSP/U+3000/LS stripped; \x1c-\x1f/\x0b/\x0c stripped).
 * The mktables mirror-vs-oracle audit uses it to replay oracle input handling. */
export function pyStrip(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end) {
    const cp = s.codePointAt(start)!;
    if (!isPySpace(cp)) {
      break;
    }
    start += cp > 0xffff ? 2 : 1;
  }
  while (end > start) {
    const cp = s.codePointAt(end - 1)!;
    if (!isPySpace(cp)) {
      break;
    }
    end -= cp > 0xffff ? 2 : 1;
  }
  return s.slice(start, end);
}

/** urlsplit's lstrip(_WHATWG_C0_CONTROL_OR_SPACE): NUL..space (0x00-0x20). */
function pyLstripC0Space(s: string): string {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) <= 0x20) {
    i++;
  }
  return s.slice(i);
}

/** str.isprintable() (Python): not in Cc/Cf/Cs/Co/Cn/Zl/Zp/Zs, ' ' exempt. */
function isPyPrintable(ch: string): boolean {
  if (ch === " ") {
    return true;
  }
  if (/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{Zs}]/u.test(ch)) {
    return false;
  }
  return !/\P{Assigned}/u.test(ch);
}

/** repr(str) (Python 3): quote preference + escape rules. */
function pyRepr(s: string): string {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    if (ch === "\\") {
      out += "\\\\";
    } else if (ch === quote) {
      out += "\\" + quote;
    } else if (ch === "\t") {
      out += "\\t";
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (!isPyPrintable(ch)) {
      const cp = ch.codePointAt(0)!;
      if (cp <= 0xff) {
        out += "\\x" + cp.toString(16).padStart(2, "0");
      } else if (cp <= 0xffff) {
        out += "\\u" + cp.toString(16).padStart(4, "0");
      } else {
        out += "\\U" + cp.toString(16).padStart(8, "0");
      }
    } else {
      out += ch;
    }
  }
  return out + quote;
}

function isAsciiAlpha(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z"));
}

function isAsciiStr(s: string): boolean {
  // str.isascii(): true iff every codepoint is <= 0x7f.
  for (const ch of s) {
    if ((ch.codePointAt(0) as number) > 0x7f) {
      return false;
    }
  }
  return true;
}

/** str.split(sep, maxsplit) Python semantics (the remainder stays whole). */
function pySplitMax(s: string, sep: string, maxsplit: number): string[] {
  const out: string[] = [];
  let rest = s;
  let splits = 0;
  while (splits < maxsplit) {
    const idx = rest.indexOf(sep);
    if (idx < 0) {
      break;
    }
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep.length);
    splits++;
  }
  out.push(rest);
  return out;
}

// ---------------------------------------------------------------------------
// urllib.parse.urlsplit mirror (Python 3.13.12)
// ---------------------------------------------------------------------------

const SCHEME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-.";

export interface SplitResult {
  scheme: string;
  netloc: string;
  path: string;
  username: string | null;
  password: string | null;
  hostname: string | null;
  /** raw port text; getPort() mirrors the lazy property (may raise) */
  portRaw: string | null;
  getPort(): number | null;
}

function splitnetloc(url: string, start: number): [string, string] {
  let delim = url.length;
  for (const dc of ["/", "?", "#"]) {
    const wd = url.indexOf(dc, start);
    if (wd >= 0 && wd < delim) {
      delim = wd;
    }
  }
  return [url.slice(start, delim), url.slice(delim)];
}

function checkBracketedHost(hostname: string): void {
  if (hostname.startsWith("v")) {
    if (!/^v[0-9a-fA-F]+\..+$/.test(hostname)) {
      throw new PyValueError("IPvFuture address is invalid");
    }
    return;
  }
  const ip = ipAddress(hostname); // throws ValueError if not IPv6 or IPv4
  if (ip.family === 4) {
    throw new PyValueError("An IPv4 address cannot be in brackets");
  }
}

function checkBracketedNetloc(netloc: string): void {
  // mirrors _check_bracketed_netloc (must match _hostinfo's splitting)
  const hostnameAndPort = netloc.slice(netloc.lastIndexOf("@") + 1);
  const openIdx = hostnameAndPort.indexOf("[");
  let hostname: string;
  if (openIdx >= 0) {
    const beforeBracket = hostnameAndPort.slice(0, openIdx);
    if (beforeBracket) {
      throw new PyValueError("Invalid IPv6 URL");
    }
    const bracketed = hostnameAndPort.slice(openIdx + 1);
    const closeIdx = bracketed.indexOf("]");
    hostname = closeIdx >= 0 ? bracketed.slice(0, closeIdx) : bracketed;
    const after = closeIdx >= 0 ? bracketed.slice(closeIdx + 1) : "";
    if (after && !after.startsWith(":")) {
      throw new PyValueError("Invalid IPv6 URL");
    }
  } else {
    const colonIdx = hostnameAndPort.indexOf(":");
    hostname = colonIdx >= 0 ? hostnameAndPort.slice(0, colonIdx) : hostnameAndPort;
  }
  checkBracketedHost(hostname);
}

function checkNetlocNFKC(netloc: string): void {
  if (!netloc || isAsciiStr(netloc)) {
    return;
  }
  const n = netloc.replace(/@/g, "").replace(/:/g, "").replace(/#/g, "").replace(/\?/g, "");
  const netloc2 = n.normalize("NFKC");
  if (n === netloc2) {
    return;
  }
  for (const c of ["/", "?", "#", "@", ":"]) {
    if (netloc2.includes(c)) {
      throw new PyValueError(
        "netloc '" + netloc + "' contains invalid characters under NFKC normalization"
      );
    }
  }
}

/** urllib.parse.urlsplit(url) mirror. Raises PyValueError like CPython. */
export function urlsplit(url: string): SplitResult {
  let work = pyLstripC0Space(url);
  work = work.replace(/[\t\r\n]/g, ""); // _UNSAFE_URL_BYTES_TO_REMOVE

  let scheme = "";
  let rest = work;
  const i = work.indexOf(":");
  if (i > 0 && isAsciiAlpha(work[0])) {
    let bad = false;
    for (const c of work.slice(0, i)) {
      if (!SCHEME_CHARS.includes(c)) {
        bad = true;
        break;
      }
    }
    if (!bad) {
      scheme = work.slice(0, i).toLowerCase();
      rest = work.slice(i + 1);
    }
  }

  let netloc = "";
  if (rest.startsWith("//")) {
    const [nl, rem] = splitnetloc(rest, 2);
    netloc = nl;
    rest = rem;
    const haveOpen = netloc.includes("[");
    const haveClose = netloc.includes("]");
    if ((haveOpen && !haveClose) || (haveClose && !haveOpen)) {
      throw new PyValueError("Invalid IPv6 URL");
    }
    if (haveOpen && haveClose) {
      checkBracketedNetloc(netloc);
    }
  }

  if (rest.includes("#")) {
    rest = rest.slice(0, rest.indexOf("#"));
  }
  if (rest.includes("?")) {
    rest = rest.slice(0, rest.indexOf("?"));
  }
  checkNetlocNFKC(netloc);

  // _userinfo / _hostinfo (lazy in CPython; values deterministic)
  const at = netloc.lastIndexOf("@");
  let username: string | null = null;
  let password: string | null = null;
  if (at >= 0) {
    const userinfo = netloc.slice(0, at);
    const colon = userinfo.indexOf(":");
    if (colon >= 0) {
      username = userinfo.slice(0, colon);
      password = userinfo.slice(colon + 1);
    } else {
      username = userinfo;
      password = null;
    }
  }
  const hostinfo = netloc.slice(at + 1);
  const ob = hostinfo.indexOf("[");
  let hostRaw: string;
  let portRaw: string | null;
  if (ob >= 0) {
    const bracketed = hostinfo.slice(ob + 1);
    const cb = bracketed.indexOf("]");
    hostRaw = cb >= 0 ? bracketed.slice(0, cb) : bracketed;
    const afterClose = cb >= 0 ? bracketed.slice(cb + 1) : "";
    const pc = afterClose.indexOf(":");
    portRaw = pc >= 0 ? afterClose.slice(pc + 1) : "";
  } else {
    const pc = hostinfo.indexOf(":");
    hostRaw = pc >= 0 ? hostinfo.slice(0, pc) : hostinfo;
    portRaw = pc >= 0 ? hostinfo.slice(pc + 1) : "";
  }
  if (portRaw === "") {
    portRaw = null;
  }

  // hostname property: empty -> None; zone after '%' keeps its case
  let hostname: string | null = hostRaw === "" ? null : hostRaw;
  if (hostname !== null) {
    const zc = hostname.indexOf("%");
    if (zc >= 0) {
      hostname = hostname.slice(0, zc).toLowerCase() + "%" + hostname.slice(zc + 1);
    } else {
      hostname = hostname.toLowerCase();
    }
  }

  const getPort = (): number | null => {
    if (portRaw === null) {
      return null;
    }
    if (!/^[0-9]+$/.test(portRaw)) {
      throw new PyValueError(`Port could not be cast to integer value as ${pyRepr(portRaw)}`);
    }
    const value = BigInt(portRaw);
    if (!(0n <= value && value <= 65535n)) {
      throw new PyValueError("Port out of range 0-65535");
    }
    return Number(value);
  };

  return { scheme, netloc, path: rest, username, password, hostname, portRaw, getPort };
}

// ---------------------------------------------------------------------------
// ipaddress mirror (Python 3.13.12 IPv4Address / IPv6Address / ip_address)
// ---------------------------------------------------------------------------

interface PyIp {
  family: 4 | 6;
  ip: bigint;
  scope: string | null;
}

const HEX_DIGITS = /^[0-9a-fA-F]+$/;
const ASCII_DIGITS = /^[0-9]+$/;

/** IPv4Address.__init__ + _ip_int_from_string/_parse_octet (accept-or-null). */
function ipv4Try(s: string): bigint | null {
  if (s === "") {
    return null; // Address cannot be empty
  }
  if (s.includes("/")) {
    return null; // Unexpected '/'
  }
  const octets = s.split(".");
  if (octets.length !== 4) {
    return null; // Expected 4 octets
  }
  let n = 0n;
  for (const o of octets) {
    if (o === "" || !ASCII_DIGITS.test(o) || o.length > 3) {
      return null;
    }
    if (o !== "0" && o[0] === "0") {
      return null; // Leading zeros are not permitted
    }
    const v = Number(o);
    if (v > 255) {
      return null;
    }
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function parseHextet(h: string): bigint | null {
  if (!HEX_DIGITS.test(h) || h.length > 4) {
    return null;
  }
  return BigInt("0x" + h);
}

/** IPv6Address.__init__ + _split_scope_id/_ip_int_from_string (accept-or-null). */
function ipv6Try(s: string): { ip: bigint; scope: string | null } | null {
  if (s.includes("/")) {
    return null;
  }
  let addr = s;
  let scope: string | null = null;
  const pc = s.indexOf("%");
  if (pc >= 0) {
    addr = s.slice(0, pc);
    scope = s.slice(pc + 1);
    if (scope === "" || scope.includes("%")) {
      return null; // Invalid IPv6 address
    }
  }
  if (addr === "") {
    return null;
  }
  if (addr.length > 45) {
    return null;
  }
  const parts = pySplitMax(addr, ":", 9);
  if (parts.length < 3) {
    return null;
  }
  if (parts[parts.length - 1]!.includes(".")) {
    const tail = parts.pop()!;
    const v4 = ipv4Try(tail);
    if (v4 === null) {
      return null;
    }
    parts.push(((v4 >> 16n) & 0xffffn).toString(16));
    parts.push((v4 & 0xffffn).toString(16));
  }
  if (parts.length > 9) {
    return null;
  }
  let skipIndex: number | null = null;
  for (let k = 1; k < parts.length - 1; k++) {
    if (parts[k] === "") {
      if (skipIndex !== null) {
        return null; // At most one '::'
      }
      skipIndex = k;
    }
  }
  let partsHi = 0;
  let partsLo = 0;
  let partsSkipped = 0;
  if (skipIndex !== null) {
    partsHi = skipIndex;
    partsLo = parts.length - skipIndex - 1;
    if (parts[0] === "") {
      partsHi -= 1;
      if (partsHi !== 0) {
        return null; // Leading ':' only permitted as part of '::'
      }
    }
    if (parts[parts.length - 1] === "") {
      partsLo -= 1;
      if (partsLo !== 0) {
        return null; // Trailing ':' only permitted as part of '::'
      }
    }
    partsSkipped = 8 - (partsHi + partsLo);
    if (partsSkipped < 1) {
      return null;
    }
  } else {
    if (parts.length !== 8) {
      return null; // Exactly 8 parts expected without '::'
    }
    if (parts[0] === "" || parts[parts.length - 1] === "") {
      return null;
    }
    partsHi = parts.length;
    partsLo = 0;
    partsSkipped = 0;
  }
  let ip = 0n;
  for (let k = 0; k < partsHi; k++) {
    const hv = parseHextet(parts[k]!);
    if (hv === null) {
      return null;
    }
    ip = (ip << 16n) | hv;
  }
  ip <<= 16n * BigInt(partsSkipped);
  for (let k = parts.length - partsLo; k < parts.length; k++) {
    const hv = parseHextet(parts[k]!);
    if (hv === null) {
      return null;
    }
    ip = (ip << 16n) | hv;
  }
  return { ip, scope };
}

/** ipaddress.ip_address(str): returns PyIp or throws PyValueError. */
function ipAddress(address: string): PyIp {
  const v4 = ipv4Try(address);
  if (v4 !== null) {
    return { family: 4, ip: v4, scope: null };
  }
  const v6 = ipv6Try(address);
  if (v6 !== null) {
    return { family: 6, ip: v6.ip, scope: v6.scope };
  }
  throw new PyValueError(`${pyRepr(address)} does not appear to be an IPv4 or IPv6 address`);
}

/** _BaseV4._string_from_ip_int */
function ipv4Str(n: bigint): string {
  return [
    ((n >> 24n) & 0xffn).toString(),
    ((n >> 16n) & 0xffn).toString(),
    ((n >> 8n) & 0xffn).toString(),
    (n & 0xffn).toString(),
  ].join(".");
}

/** _BaseV6._compress_hextets + _string_from_ip_int */
function ipv6StrFromInt(ipInt: bigint): string {
  const hex = ipInt.toString(16).padStart(32, "0");
  const hextets: string[] = [];
  for (let k = 0; k < 32; k += 4) {
    hextets.push(BigInt("0x" + hex.slice(k, k + 4)).toString(16));
  }
  // longest run of "0" (ties keep the leftmost); runs >= 2 compress to "::"
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let idx = 0; idx < hextets.length; idx++) {
    if (hextets[idx] === "0") {
      curLen += 1;
      if (curStart === -1) {
        curStart = idx;
      }
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curLen = 0;
      curStart = -1;
    }
  }
  let out = hextets;
  if (bestLen > 1) {
    const bestEnd = bestStart + bestLen;
    if (bestEnd === out.length) {
      out = out.concat([""]);
    }
    out.splice(bestStart, bestEnd - bestStart, "");
    if (bestStart === 0) {
      out = [""].concat(out);
    }
  }
  return out.join(":");
}

/** str(IPv4Address | IPv6Address): mapped form renders as ::ffff:x.x.x.x. */
function ipToStr(ip: PyIp): string {
  if (ip.family === 4) {
    return ipv4Str(ip.ip);
  }
  let s: string;
  if ((ip.ip >> 32n) === 0xffffn) {
    s = ipv6StrFromInt(ip.ip >> 32n) + ":" + ipv4Str(ip.ip & 0xffffffffn);
  } else {
    s = ipv6StrFromInt(ip.ip);
  }
  return ip.scope !== null ? s + "%" + ip.scope : s;
}

interface NetSpec {
  base: bigint;
  bits: number;
}

function containsNet(ipInt: bigint, net: NetSpec, width: number): boolean {
  const shift = BigInt(width - net.bits);
  return (ipInt >> shift) === (net.base >> shift);
}

function v4Net(cidr: string): NetSpec {
  const [base, bits] = cidr.split("/");
  return { base: ipv4Try(base!)!, bits: Number(bits) };
}

function ipv6NetBase(addr: string): bigint {
  const p = ipv6Try(addr);
  if (p === null) {
    throw new Error(`internal: bad ipv6 net base ${addr}`);
  }
  return p.ip;
}

function v6Net(cidr: string): NetSpec {
  const slash = cidr.lastIndexOf("/");
  const base = ipv6NetBase(cidr.slice(0, slash));
  return { base, bits: Number(cidr.slice(slash + 1)) };
}

// _IPv4Constants (3.13.12) — verbatim
const V4_LINKLOCAL = v4Net("169.254.0.0/16");
const V4_LOOPBACK = v4Net("127.0.0.0/8");
const V4_MULTICAST = v4Net("224.0.0.0/4");
const V4_PRIVATE_NETS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.0.170/31",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "240.0.0.0/4",
  "255.255.255.255/32",
].map(v4Net);
const V4_PRIVATE_EXC = ["192.0.0.9/32", "192.0.0.10/32"].map(v4Net);
const V4_RESERVED = v4Net("240.0.0.0/4");

// _IPv6Constants (3.13.12) — verbatim
const V6_LINKLOCAL = v6Net("fe80::/10");
const V6_MULTICAST = v6Net("ff00::/8");
const V6_PRIVATE_NETS = [
  "::1/128",
  "::/128",
  "::ffff:0:0/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "fc00::/7",
  "fe80::/10",
].map(v6Net);
const V6_PRIVATE_EXC = [
  "2001:1::1/128",
  "2001:1::2/128",
  "2001:3::/32",
  "2001:4:112::/48",
  "2001:20::/28",
  "2001:30::/28",
].map(v6Net);
const V6_RESERVED_NETS = [
  "::/8",
  "100::/8",
  "200::/7",
  "400::/6",
  "800::/5",
  "1000::/4",
  "4000::/3",
  "6000::/3",
  "8000::/3",
  "A000::/3",
  "C000::/3",
  "E000::/4",
  "F000::/5",
  "F800::/6",
  "FE00::/9",
].map(v6Net);

interface IpFacts {
  L: boolean; // is_loopback
  K: boolean; // is_link_local
  P: boolean; // is_private
  U: boolean; // is_unspecified
  M: boolean; // is_multicast
  R: boolean; // is_reserved
}

function ipv4Facts(n: bigint): IpFacts {
  return {
    L: containsNet(n, V4_LOOPBACK, 32),
    K: containsNet(n, V4_LINKLOCAL, 32),
    P:
      V4_PRIVATE_NETS.some((net) => containsNet(n, net, 32)) &&
      !V4_PRIVATE_EXC.some((net) => containsNet(n, net, 32)),
    U: n === 0n,
    M: containsNet(n, V4_MULTICAST, 32),
    R: containsNet(n, V4_RESERVED, 32),
  };
}

/** IPv6Address properties delegate to ipv4_mapped when the top 96 bits are
 * 0xFFFF (checked per property in CPython; the delegation is uniform). */
function ipFactsOf(ip: PyIp): IpFacts {
  if (ip.family === 4) {
    return ipv4Facts(ip.ip);
  }
  if ((ip.ip >> 32n) === 0xffffn) {
    return ipv4Facts(ip.ip & 0xffffffffn);
  }
  return {
    L: ip.ip === 1n,
    K: containsNet(ip.ip, V6_LINKLOCAL, 128),
    P:
      V6_PRIVATE_NETS.some((net) => containsNet(ip.ip, net, 128)) &&
      !V6_PRIVATE_EXC.some((net) => containsNet(ip.ip, net, 128)),
    U: ip.ip === 0n,
    M: containsNet(ip.ip, V6_MULTICAST, 128),
    R: V6_RESERVED_NETS.some((net) => containsNet(ip.ip, net, 128)),
  };
}

// ---------------------------------------------------------------------------
// url_guard.py module-level tables
// ---------------------------------------------------------------------------

const _IMDS_HOSTNAMES = new Set(["metadata.google.internal", "instance-data"]);

const _IMDS_IPS: PyIp[] = [ipAddress("169.254.169.254"), ipAddress("fd00:ec2::254")];

function inImdsIps(ip: PyIp): boolean {
  // set membership via __eq__: same type + same int; IPv6 also same scope_id
  return _IMDS_IPS.some(
    (x) => x.family === ip.family && x.ip === ip.ip && (ip.family === 4 || x.scope === ip.scope)
  );
}

// Blacklisted networks: loopback, private, link-local, unspecified
// (ipaddress.ip_network objects; `ip in net` is false across families)
const _BLOCKED_NETWORKS: (NetSpec & { display: string; width: 4 | 6 })[] = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "255.255.255.255/32",
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
].map((cidr) => {
  if (cidr.includes(":")) {
    return { ...v6Net(cidr), display: cidr, width: 6 as const };
  }
  return { ...v4Net(cidr), display: cidr, width: 4 as const };
});

function blockedNetworkHit(ip: PyIp): (NetSpec & { display: string }) | null {
  for (const net of _BLOCKED_NETWORKS) {
    if (net.width === ip.family && containsNet(ip.ip, net, net.width === 4 ? 32 : 128)) {
      return net;
    }
  }
  return null;
}

function isIpBlockedObj(ip: PyIp): [boolean, string] {
  const shown = ipToStr(ip);
  if (inImdsIps(ip)) {
    return [true, `云厂商元数据服务(IMDS)已被拦截 (blocked IMDS): ${shown}`];
  }
  const facts = ipFactsOf(ip);
  if (facts.L) {
    return [true, `回环地址(Loopback)已被拦截 (blocked loopback): ${shown}`];
  }
  if (facts.K) {
    return [true, `链路本地(Link-local)地址已被拦截 (blocked link-local): ${shown}`];
  }
  if (facts.P) {
    return [true, `私网(Private IP)地址已被拦截 (blocked private): ${shown}`];
  }
  if (facts.U || facts.M || facts.R) {
    return [true, `保留/未指定网络地址已被拦截 (blocked reserved): ${shown}`];
  }
  const hit = blockedNetworkHit(ip);
  if (hit) {
    return [true, `黑名单网络范围已被拦截 (blocked network range): ${shown} in ${hit.display}`];
  }
  return [false, ""];
}

/** Check if an IP address belongs to IMDS, loopback, link-local, or private
 * range. Mirrors `is_ip_blocked(ipaddress.ip_address(ip))` and, like the
 * Python call chain, raises ValueError for input that is not an IP. */
export function is_ip_blocked(ip: string): [boolean, string] {
  return isIpBlockedObj(ipAddress(ip));
}

// ---------------------------------------------------------------------------
// synchronous DNS bridge (worker_threads + SharedArrayBuffer; no subprocess)
// ---------------------------------------------------------------------------

const DNS_SAB_BYTES = 8 + 65536;
const DNS_WAIT_MS = 30000;

const DNS_WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const dns = require("node:dns");
const ctl = new Int32Array(workerData.sab);
const data = new Uint8Array(workerData.sab, 8);
parentPort.on("message", (req) => {
  dns.lookup(req.host, { all: true, verbatim: true }, (err, res) => {
    let text;
    if (err) {
      text = JSON.stringify({
        e: 1,
        code: String((err && err.code) || ""),
        name: String((err && err.name) || "Error"),
        msg: String((err && err.message) || err),
      });
    } else {
      text = JSON.stringify({
        e: 0,
        r: res.map((x) => [x.family === 6 ? 6 : 4, String(x.address)]),
      });
    }
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > data.length) {
      Atomics.store(ctl, 0, -1);
      Atomics.notify(ctl, 0);
      return;
    }
    data.set(bytes, 0);
    Atomics.store(ctl, 1, bytes.length);
    Atomics.store(ctl, 0, 1);
    Atomics.notify(ctl, 0);
  });
});
`;

interface DnsBridge {
  worker: Worker;
  ctl: Int32Array;
  view: Uint8Array;
  decoder: TextDecoder;
}

let _dnsBridge: DnsBridge | null = null;

function ensureDnsBridge(): DnsBridge {
  if (_dnsBridge) {
    return _dnsBridge;
  }
  const sab = new SharedArrayBuffer(DNS_SAB_BYTES);
  const worker = new Worker(DNS_WORKER_SRC, {
    eval: true,
    workerData: { sab },
    stdout: false,
    stderr: false,
  });
  worker.unref();
  _dnsBridge = {
    worker,
    ctl: new Int32Array(sab),
    view: new Uint8Array(sab, 8),
    decoder: new TextDecoder(),
  };
  return _dnsBridge;
}

/** socket.getaddrinfo(host, service) equivalent for check_url's use: the
 * ordered address strings. CPython and V8 both sit on the OS getaddrinfo;
 * result order was measured identical for the localhost family
 * (tmp/urlgu2_oracle_facts.json getaddrinfo/dns_rebind_localhost_dot). */
function getaddrinfoSync(host: string): string[] {
  const bridge = ensureDnsBridge();
  Atomics.store(bridge.ctl, 0, 0);
  Atomics.store(bridge.ctl, 1, 0);
  bridge.worker.postMessage({ host });
  Atomics.wait(bridge.ctl, 0, 0, DNS_WAIT_MS);
  const flag = Atomics.load(bridge.ctl, 0);
  if (flag !== 1) {
    throw new Error("DNS lookup timeout");
  }
  const len = Atomics.load(bridge.ctl, 1);
  const text = bridge.decoder.decode(bridge.view.slice(0, len));
  const payload = JSON.parse(text) as {
    e: number;
    r?: [number, string][];
    code?: string;
    name?: string;
    msg?: string;
  };
  if (payload.e === 1) {
    const code = payload.code ?? "";
    const msg = payload.msg ?? "lookup failed";
    if (/^(ENOTFOUND|EAI_)/.test(code)) {
      throw new PyGaiError(msg);
    }
    throw new Error(msg);
  }
  return (payload.r ?? []).map((entry) => entry[1]);
}

// ---------------------------------------------------------------------------
// check_url (url_guard.py:60-142 bug-for-bug)
// ---------------------------------------------------------------------------

/** Validate a URL against SSRF attack vectors and restricted networks.
 * Returns [allowed, reason]. */
export function check_url(url: string, opts?: { allow_private?: boolean }): [boolean, string] {
  const allow_private = opts?.allow_private ?? false;
  if (!url || typeof url !== "string") {
    return [false, "无效的 URL 格式"];
  }

  let parsed: SplitResult;
  try {
    parsed = urlsplit(pyStrip(url));
  } catch (e) {
    return [false, `URL 解析失败: ${pyStr(e)}`];
  }

  const scheme = (parsed.scheme || "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return [false, `不支持的 URL 协议方案: ${scheme} (仅允许 http/https)`];
  }

  if (parsed.username || parsed.password) {
    return [false, "URL 中禁止包含用户身份凭据 (userinfo)"];
  }

  const host = parsed.hostname;
  if (!host) {
    return [false, "URL 中未提供有效的主机名 (hostname)"];
  }

  // Clean IPv6 bracket notation if present: host.strip("[]").strip()
  const clean_host = pyStrip(host.replace(/^[\[\]]+/, "").replace(/[\[\]]+$/, ""));

  // If allow_private is enabled, bypass network/IMDS checks
  const env_override = ["1", "true", "yes"].includes(
    pyStrip(process.env["OVOLVE_ALLOW_PRIVATE_URLS"] ?? "").toLowerCase()
  );
  if (allow_private || env_override) {
    return [true, ""];
  }

  // Special-use test/documentation domains (RFC 2606 / RFC 6761)
  const hostLower = clean_host.toLowerCase();
  if (
    hostLower.endsWith(".example") ||
    hostLower.endsWith(".test") ||
    hostLower.endsWith(".invalid")
  ) {
    return [true, ""];
  }

  // Check hostname blacklist
  if (_IMDS_HOSTNAMES.has(hostLower)) {
    return [false, `禁止访问云厂商元数据服务主机名 (blocked IMDS): ${clean_host}`];
  }
  if (hostLower === "localhost") {
    return [false, `禁止访问本地回环主机名 (blocked loopback localhost): ${clean_host}`];
  }

  // Check if host is direct IP address
  let direct_ip: PyIp | null = null;
  try {
    direct_ip = ipAddress(clean_host);
  } catch (e) {
    if (!(e instanceof PyValueError)) {
      throw e;
    }
    direct_ip = null;
  }

  if (direct_ip !== null) {
    const [blocked, reason] = isIpBlockedObj(direct_ip);
    if (blocked) {
      return [false, reason];
    }
    return [true, ""];
  }

  // Hostname requires DNS resolution to verify destination IP (prevents DNS rebinding)
  let addr_info: string[];
  try {
    const port = parsed.getPort();
    // mirror `parsed.port or (443 if scheme == "https" else 80)` arg eval
    void (port || (scheme === "https" ? 443 : 80));
    addr_info = getaddrinfoSync(clean_host);
  } catch (e) {
    if (e instanceof PyGaiError) {
      return [false, `域名解析失败 (DNS resolution failed): ${pyStr(e)}`];
    }
    return [false, `域名解析异常: ${pyStr(e)}`];
  }

  if (!addr_info || addr_info.length === 0) {
    return [false, "域名解析失败: 未获取到任何 IP 地址记录"];
  }

  for (const ip_str of addr_info) {
    try {
      const resolved_ip = ipAddress(ip_str);
      const [blocked, reason] = isIpBlockedObj(resolved_ip);
      if (blocked) {
        return [false, `域名解析到受限制网络 (DNS Rebinding/SSRF 防护): ${reason}`];
      }
    } catch (e) {
      if (e instanceof PyValueError) {
        continue;
      }
      throw e;
    }
  }

  return [true, ""];
}
