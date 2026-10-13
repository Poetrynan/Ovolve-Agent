"use strict";
/**
 * path_policy.ts 鈥?auditable filesystem policy (the open-source layer).
 *
 * Ported from `app/backend/path_policy.py` (967 lines).
 *
 * OS-native confinement in `sandbox` is the hard boundary: the kernel refuses
 * writes the process is not allowed to make. This module is the layer users can
 * read, edit and contribute to.
 *
 * A `sandbox-policy.yaml` in the workspace (or `~/.ovolve/`) is the source of
 * truth. Built-in defaults match `app/sandbox-policy.example.yaml`, so a missing
 * file is not a missing policy.
 *
 * This is not a shell parser and does not claim to be. It extracts the paths a
 * command NAMES (redirections, absolute paths, path-like arguments) and checks
 * them against the YAML. Anything it cannot see is the OS sandbox's job.
 *
 * Rule matching: most-specific path wins. `.git: ro` beats `workspace: rw` for
 * files under `.git`. Writes that match nothing are denied; reads that match
 * nothing are allowed (unless a `none` rule covers them).
 *
 * RULEBOOK CITATIONS
 *   搂4  naming: app/backend/path_policy.py -> app/engine/path_policy.ts
 *   搂2  `ipaddress` has no Node equivalent; see the local CIDR implementation
 *   搂2  `re.IGNORECASE if os.name == "nt"` -> a platform check, preserved
 *   搂2  broad swallow: every fail-open catch is preserved
 *   搂3  TODO(port): the SPLIT decision
 *
 * PORT STATUS: confidence=high todos=1
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PathPolicy = exports.PathPolicyError = exports.PolicyVerdict = exports.FsRule = exports.NONE = exports.RO = exports.RW = void 0;
exports.parseScalar = parseScalar;
exports.loadSimpleYaml = loadSimpleYaml;
exports.normPath = normPath;
exports.expandBraces = expandBraces;
exports.globToRe = globToRe;
exports.patternMatches = patternMatches;
exports.findRedirections = findRedirections;
exports.splitCommandSegments = splitCommandSegments;
exports.extractIntents = extractIntents;
exports.extractIps = extractIps;
exports.extractHosts = extractHosts;
exports.parseIp = parseIp;
exports.splitNetworkEntries = splitNetworkEntries;
exports.hostRuleHit = hostRuleHit;
exports.parseCidrs = parseCidrs;
exports.resolveKey = resolveKey;
exports.builtinFilesystem = builtinFilesystem;
exports.findPolicyFile = findPolicyFile;
exports.loadPolicy = loadPolicy;
exports.evaluateCommand = evaluateCommand;
exports.assertCommandAllowed = assertCommandAllowed;
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const command_guard_js_1 = require("./command_guard.cjs");
const path_guard_js_1 = require("./path_guard.cjs");
/** Access values accepted in the YAML. */
exports.RW = "rw";
exports.RO = "ro";
exports.NONE = "none";
const ACCESS = new Set([exports.RW, exports.RO, exports.NONE]);
const POLICY_FILENAMES = ["sandbox-policy.yaml", "sandbox-policy.yml"];
/**
 * Guiding files: the model must not overwrite them via the shell either.
 * PathGuard already blocks the file tools; this closes the shell hole.
 */
const GUIDING_GLOBS = [
    "AGENTS.md", "MEMORY.md", "SOUL.md", "agents.md", "memory.md", "soul.md",
].map((name) => `**/${name}`);
// 鈹€鈹€ tiny YAML subset 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
//
// Zero extra dependency. Understands the policy schema: nested maps, lists of
// scalars, `key: value`, comments, quoted strings. Not a YAML implementation.
/**
 * RULEBOOK 搂2 (sentinel returns): the source returns `""` for an empty or
 * comment value, `true`/`false` for the YAML booleans, `null` for the null
 * spellings, then tries int, then float, then the raw string. The order matters
 * and is preserved 鈥?`int("3")` succeeds before `float("3")` is tried, so a
 * numeric scalar comes back as an integer.
 */
function parseScalar(raw) {
    let s = raw.trim();
    if (!s) {
        return "";
    }
    if ((s[0] === '"' || s[0] === "'") && s.length >= 2 && s[s.length - 1] === s[0]) {
        return s.slice(1, -1);
    }
    if (s.startsWith("#")) {
        return "";
    }
    const hash = s.indexOf(" #");
    if (hash !== -1) {
        s = s.slice(0, hash).trimEnd();
    }
    const low = s.toLowerCase();
    if (["true", "yes", "on"].includes(low)) {
        return true;
    }
    if (["false", "no", "off"].includes(low)) {
        return false;
    }
    if (["null", "none", "~"].includes(low)) {
        return null;
    }
    // RULEBOOK 搂2 (numeric policy): Python's int() accepts a leading sign and
    // rejects "3.0"; Number() accepts more than int() does, so the shape is
    // checked first rather than relying on Number's permissiveness.
    if (/^[+-]?\d+$/.test(s)) {
        return parseInt(s, 10);
    }
    if (/^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(s)) {
        return parseFloat(s);
    }
    return s;
}
/**
 * Indent-based YAML subset -> object. Good enough for sandbox-policy.yaml.
 *
 * RULEBOOK 搂2 (control flow): the source's `is_list` state machine is
 * order-dependent and raises on a mixed dict/list at one indent. Reproduced
 * exactly, including the branch that absorbs a stray deeper indent into the
 * current level before the type is decided.
 */
function loadSimpleYaml(text) {
    const lines = [];
    for (const raw of text.split(/\r?\n/)) {
        if (!raw.trim() || raw.trimStart().startsWith("#")) {
            continue;
        }
        const indent = raw.length - raw.trimStart().length;
        lines.push({ indent, content: raw.trim() });
    }
    const parseBlock = (startIndex, indent) => {
        const mapping = {};
        const sequence = [];
        let isList = null;
        let index = startIndex;
        while (index < lines.length) {
            const line = lines[index];
            const i = line.indent;
            const content = line.content;
            if (i < indent) {
                break;
            }
            if (i > indent && isList === null) {
                // Stray deeper indent; treat as this level (type still undecided).
            }
            else if (i > indent) {
                break;
            }
            if (content.startsWith("- ")) {
                if (isList === false) {
                    throw new Error("YAML subset: mixed dict/list at the same indent");
                }
                isList = true;
                const item = content.slice(2).trim();
                // A list of maps is out of scope; the scalar form is stored either way.
                sequence.push(parseScalar(item));
                index += 1;
                continue;
            }
            isList = false;
            if (content.endsWith(":")) {
                const key = content.slice(0, -1).trim().replace(/^["']|["']$/g, "");
                const nxt = index + 1;
                if (nxt < lines.length && lines[nxt].indent > i) {
                    const [child, nextIndex] = parseBlock(nxt, lines[nxt].indent);
                    mapping[key] = child;
                    index = nextIndex;
                }
                else {
                    mapping[key] = {};
                    index += 1;
                }
                continue;
            }
            if (content.includes(": ")) {
                const pos = content.lastIndexOf(": ");
                const key = content.slice(0, pos).trim().replace(/^["']|["']$/g, "");
                mapping[key] = parseScalar(content.slice(pos + 2));
                index += 1;
                continue;
            }
            if (content.includes(":") && !content.startsWith("http")) {
                const pos = content.lastIndexOf(":");
                const key = content.slice(0, pos).trim().replace(/^["']|["']$/g, "");
                mapping[key] = parseScalar(content.slice(pos + 1));
                index += 1;
                continue;
            }
            index += 1;
        }
        return [isList ? sequence : mapping, index];
    };
    if (!lines.length) {
        return {};
    }
    const [doc] = parseBlock(0, lines[0].indent);
    return doc !== null && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
}
// 鈹€鈹€ glob / path matching 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
function slash(p) {
    return p.replace(/\\/g, "/");
}
/**
 * `os.path.normcase` folded in: lowercase and separator-normalize on Windows,
 * identity elsewhere. The source applies normcase before slash-normalizing.
 */
function normCase(p) {
    return process.platform === "win32" ? p.toLowerCase() : p;
}
/** Expand `~` and environment variables, then resolve. */
function normPath(p) {
    const expanded = expandUser(expandVars(p));
    let real;
    try {
        real = fs.realpathSync.native(path.resolve(expanded));
    }
    catch {
        // RULEBOOK 搂2 (broad swallow): the source catches OSError and falls back to
        // abspath, so a path that does not exist still normalizes.
        real = path.resolve(expanded);
    }
    return slash(normCase(real));
}
function expandUser(p) {
    if (p === "~") {
        return os.homedir();
    }
    if (p.startsWith("~/") || p.startsWith("~\\")) {
        return path.join(os.homedir(), p.slice(2));
    }
    return p;
}
function expandVars(p) {
    return p.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => process.env[name] !== undefined ? process.env[name] : m);
}
/** Brace expansion: `{a,b}/c` -> `a/c`, `b/c`. Recursive, like the source. */
function expandBraces(pattern) {
    const m = /\{([^{}]+)\}/.exec(pattern);
    if (!m) {
        return [pattern];
    }
    const out = [];
    for (const part of m[1].split(",")) {
        const expanded = pattern.slice(0, m.index) + part.trim() + pattern.slice(m.index + m[0].length);
        out.push(...expandBraces(expanded));
    }
    return out;
}
/** Translate a glob to an anchored regex, with the source's `**` handling. */
function globToRe(pattern) {
    let i = 0;
    const out = ["^"];
    while (i < pattern.length) {
        if (pattern.startsWith("**/", i)) {
            out.push("(?:.+/)?");
            i += 3;
        }
        else if (pattern.startsWith("**", i)) {
            out.push(".*");
            i += 2;
        }
        else if (pattern[i] === "*") {
            out.push("[^/]*");
            i += 1;
        }
        else if (pattern[i] === "?") {
            out.push("[^/]");
            i += 1;
        }
        else {
            out.push(escapeRe(pattern[i]));
            i += 1;
        }
    }
    out.push("$");
    // RULEBOOK 搂2: `re.IGNORECASE if os.name == "nt" else 0`.
    const flags = process.platform === "win32" ? "i" : "";
    return new RegExp(out.join(""), flags);
}
function escapeRe(ch) {
    return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** True when `path` (already normalised) matches a glob or prefix. */
function patternMatches(path, pattern) {
    const pat = slash(pattern).replace(/\/+$/, "");
    if (!pat) {
        return false;
    }
    const exact = pat.endsWith("/**") ? pat.slice(0, -3) : pat;
    if (path === exact || path.startsWith(exact + "/")) {
        return true;
    }
    if (/[*?{]/.test(pat)) {
        for (const variant of expandBraces(pat)) {
            if (globToRe(variant).test(path)) {
                return true;
            }
            // `foo/**` also matches `foo` itself.
            if (variant.endsWith("/**") && globToRe(variant.slice(0, -3)).test(path)) {
                return true;
            }
        }
    }
    return false;
}
// 鈹€鈹€ command path extraction 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const REDIR_PREFIX = /^(?:\d+)?(>>?|<)(?!&)/;
/**
 * Lexically extract shell redirections outside quotes and heredocs.
 *
 * Returns [access, target] pairs where access is "read" or "write".
 */
function findRedirections(command) {
    if (!command) {
        return [];
    }
    let cmd = command;
    // If a heredoc is present, only scan the first command line for redirections;
    // lines after the first newline are standard-input body, not shell operators.
    if (cmd.includes("<<")) {
        cmd = cmd.split(/\r?\n/)[0];
    }
    const intents = [];
    let i = 0;
    const n = cmd.length;
    let quote = null;
    while (i < n) {
        const ch = cmd[i];
        if (ch === '"' || ch === "'") {
            if (quote === null) {
                quote = ch;
            }
            else if (quote === ch) {
                quote = null;
            }
            i += 1;
            continue;
        }
        if (quote !== null) {
            i += 1;
            continue;
        }
        if (ch === "\\") {
            i += 2;
            continue;
        }
        const m = REDIR_PREFIX.exec(cmd.slice(i));
        if (m) {
            const op = m[1];
            // `<<` is heredoc input; it feeds literal stdin, so it is ignored here.
            if (op.startsWith("<<")) {
                i += m[0].length;
                continue;
            }
            const access = op.includes(">") ? "write" : "read";
            let j = i + m[0].length;
            while (j < n && /\s/.test(cmd[j])) {
                j += 1;
            }
            const target = [];
            let targetQuote = null;
            while (j < n) {
                const tch = cmd[j];
                if (targetQuote) {
                    if (tch === targetQuote) {
                        targetQuote = null;
                    }
                    else {
                        target.push(tch);
                    }
                    j += 1;
                    continue;
                }
                if (tch === '"' || tch === "'") {
                    targetQuote = tch;
                    j += 1;
                    continue;
                }
                if (/\s/.test(tch) || [";", "&", "|", ")", ">", "<"].includes(tch)) {
                    break;
                }
                target.push(tch);
                j += 1;
            }
            const targetStr = target.join("").trim();
            if (targetStr) {
                intents.push([access, targetStr]);
            }
            i = j;
            continue;
        }
        i += 1;
    }
    return intents;
}
const QUOTED = /"([^"]+)"|'([^']+)'/g;
const ABS_LIKE = /^(?:[A-Za-z]:[\\/]|~[/\\]|\/)/;
const PATHY = /[\\/]|\.[A-Za-z0-9]{1,8}$/;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const WRAPPERS = new Set([
    "sudo", "doas", "env", "nice", "nohup", "command", "time", "stdbuf",
    "winpty", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
]);
const WRITE_VERBS = new Set([
    "rm", "rmdir", "rd", "del", "erase", "remove-item",
    "mv", "move", "ren", "rename",
    "cp", "copy", "xcopy", "robocopy", "install",
    "mkdir", "md", "touch", "new-item", "ni",
    "tee", "dd",
    "chmod", "chown", "icacls", "attrib", "chattr",
    "ln", "mklink", "link",
    "sed", "perl",
    "tar", "unzip", "expand-archive",
    "npm", "pnpm", "yarn", "pip", "pip3", "poetry", "cargo", "go",
    "docker",
]);
/**
 * git is a read OR a write depending on the subcommand. Treating every
 * `git log <path>` as a write would refuse `git log C:\Windows` because that
 * path is ro 鈥?and logging it is the opposite of dangerous.
 */
const GIT_WRITE = new Set([
    "add", "commit", "checkout", "restore", "reset", "rm", "mv",
    "stash", "merge", "rebase", "cherry-pick", "clean", "apply",
    "init", "config", "tag", "branch", "switch", "revert",
]);
const READ_VERBS = new Set([
    "cat", "type", "more", "less", "head", "tail", "bat",
    "ls", "dir", "tree", "find", "where", "which", "where.exe",
    "grep", "rg", "ag", "findstr", "select-string",
    "stat", "file", "wc", "diff", "cmp",
    "get-content", "get-childitem", "get-item",
]);
const CD_VERBS = new Set(["cd", "chdir", "set-location", "pushd"]);
function basenameOfToken(tok) {
    let verb = tok.toLowerCase().split("\\").pop().split("/").pop();
    if (verb.endsWith(".exe")) {
        verb = verb.slice(0, -4);
    }
    return verb;
}
function stripWrappers(tokens) {
    let i = 0;
    while (i < tokens.length) {
        let verb = basenameOfToken(tokens[i]);
        if (verb.endsWith(".exe")) {
            verb = verb.slice(0, -4);
        }
        if (WRAPPERS.has(verb) || tokens[i].includes("=")) {
            i += 1;
            if (["cmd", "cmd.exe"].includes(verb) && i < tokens.length && ["/c", "/k"].includes(tokens[i].toLowerCase())) {
                i += 1;
            }
            continue;
        }
        break;
    }
    return tokens.slice(i);
}
/** Rough argv split: quoted strings stay together, redirections stay in. */
function tokenize(command) {
    const out = [];
    let buf = [];
    let quote = "";
    for (const ch of command.trim()) {
        if (quote) {
            if (ch === quote) {
                quote = "";
            }
            else {
                buf.push(ch);
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (/\s/.test(ch)) {
            if (buf.length) {
                out.push(buf.join(""));
                buf = [];
            }
            continue;
        }
        buf.push(ch);
    }
    if (buf.length) {
        out.push(buf.join(""));
    }
    return out;
}
/**
 * Split a command on shell control operators, **quote-aware**.
 *
 * Deliberately not `cg.split_segments`: that primitive ignores quotes, so
 * `rm -rf "/a && /b"` would be cut in two, the second segment would lose its
 * verb, and the write intent would be downgraded to a read 鈥?exactly the miss
 * segmentation exists to prevent. Only `| & ;` and newlines outside quotes
 * count here; `<` and `>` are redirections, not separators.
 */
function splitCommandSegments(command) {
    const out = [];
    let buf = [];
    let quote = "";
    for (const ch of command) {
        if (quote) {
            buf.push(ch);
            if (ch === quote) {
                quote = "";
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            buf.push(ch);
            continue;
        }
        if (["|", "&", ";", "\n", "\r"].includes(ch)) {
            const seg = buf.join("").trim();
            if (seg) {
                out.push(seg);
            }
            buf = [];
            continue;
        }
        buf.push(ch);
    }
    const seg = buf.join("").trim();
    if (seg) {
        out.push(seg);
    }
    return out;
}
/** Intent extraction for a SINGLE command segment. The inner half of `extractIntents`. */
function scanIntents(command, cwd) {
    const found = [];
    const seen = new Set();
    const add = (rawIn, access, source) => {
        const raw = (rawIn || "").trim().replace(/^["'`;,()\[\]{}]+|["'`;,()\[\]{}]+$/g, "");
        if (!raw ||
            ["-", "/dev/null", "/dev/zero", "/dev/stdin", "/dev/stdout", "/dev/stderr", "NUL", "nul"].includes(raw)) {
            return;
        }
        if (source === "redir") {
            if (/^\d+[:,)]*$/.test(raw) || /^\d+$/.test(raw)) {
                return;
            }
            if (raw.endsWith(":")) {
                return;
            }
            if (["True", "False", "None", "null", "nil", "undefined", "then", "do", "end", "else"].includes(raw)) {
                return;
            }
        }
        if (raw.startsWith("-") && !ABS_LIKE.test(raw)) {
            return;
        }
        // A drive root must be a letter: [A-Za-z]:
        if (/^\d+:[\\/]/.test(raw) || /^\d+:$/.test(raw) || /^\d+:$/.test(raw)) {
            return;
        }
        let resolved = raw;
        if (!path.isAbsolute(expandUser(raw))) {
            resolved = path.join(cwd, raw);
        }
        const key = `${normPath(resolved)}\u0000${access}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        found.push({ path: normPath(resolved), access, source });
    };
    for (const [access, target] of findRedirections(command)) {
        add(target, access, "redir");
    }
    const tokens = stripWrappers(tokenize(command));
    let verb = "";
    if (tokens.length) {
        verb = basenameOfToken(tokens[0]);
    }
    if (CD_VERBS.has(verb) && tokens.length >= 2) {
        add(tokens[1], "read", "cd");
    }
    let writeCtx = WRITE_VERBS.has(verb);
    let readCtx = READ_VERBS.has(verb) || !writeCtx;
    let args = tokens.length ? tokens.slice(1) : [];
    if (verb === "git") {
        const sub = (args.length ? args[0].toLowerCase() : "").replace(/^-+/, "");
        writeCtx = GIT_WRITE.has(sub);
        readCtx = !writeCtx;
        args = args.slice(1);
    }
    let skipNext = false;
    for (const tok of args) {
        if (skipNext) {
            skipNext = false;
            continue;
        }
        if (tok.startsWith("-")) {
            const flag = tok.split("=", 1)[0].toLowerCase();
            if (["-m", "--message", "--author", "-F", "--file"].includes(flag) && !tok.includes("=")) {
                skipNext = true;
            }
            continue;
        }
        const looks = ABS_LIKE.test(tok) || PATHY.test(tok);
        if (!looks) {
            continue;
        }
        if (writeCtx) {
            add(tok, "write", "arg");
        }
        else if (readCtx) {
            add(tok, "read", "arg");
        }
    }
    // Absolute paths mentioned anywhere, classified by the verb.
    for (const m of command.matchAll(new RegExp(QUOTED.source, "g"))) {
        const s = (m[1] || m[2] || "").trim();
        if (s && ABS_LIKE.test(s)) {
            add(s, writeCtx ? "write" : "read", "literal");
        }
    }
    for (const m of command.matchAll(/([A-Za-z]:[\\/][^\s"'|&;<>]+|\/(?:etc|usr|bin|sbin|System|home|Users|root)[^\s"'|&;<>]*)/g)) {
        add(m[1], writeCtx ? "write" : "read", "literal");
    }
    return found;
}
/**
 * Best-effort path intents from a command line.
 *
 * Misses are expected (`python -c 'open(...)'` with no literal path, a write
 * through a variable). The OS sandbox is what catches those.
 *
 * Compound commands are judged **segment by segment**: only the first word of a
 * whole command is a verb, so `ls /a && rm -rf /etc` judged as one line would
 * have the second half's write laundered into a read by the first half's
 * read-only verb 鈥?prefix one harmless command and a destructive one hides.
 *
 * The merge takes the **union** with write winning (a read of the same path
 * yields to a write): the union guarantees no fewer findings than judging the
 * whole line, and write-priority guarantees segmentation never loses a write.
 * The cost is that a few "write then read the same path" commands are judged
 * more strictly, which is the acceptable direction on the safety side.
 */
function extractIntents(command, cwd) {
    if (!command || typeof command !== "string") {
        return [];
    }
    const workdir = cwd || process.cwd();
    const intents = scanIntents(command, workdir);
    const stripped = command.trim();
    for (const seg of splitCommandSegments(command)) {
        if (seg.trim() === stripped) {
            continue; // single-segment command, no need to scan again
        }
        intents.push(...scanIntents(seg, workdir));
    }
    const best = new Map();
    for (const it of intents) {
        const cur = best.get(it.path);
        if (cur === undefined || (cur.access === "read" && it.access === "write")) {
            best.set(it.path, it);
        }
    }
    return Array.from(best.values());
}
function extractIps(command) {
    if (!command) {
        return [];
    }
    return Array.from(command.matchAll(new RegExp(IPV4.source, "g")), (m) => m[0]);
}
/**
 * Every host named in the command text: IPv4 literals plus domains, in order of
 * first appearance, lowercased and deduplicated.
 *
 * Conservative by design: `git clone https://github.com/a/b.git` also yields
 * `b.git` as a host. An extra host costs one extra REVIEW at worst; a missed
 * host is a real allow-through 鈥?noisy beats leaky.
 */
function extractHosts(command) {
    if (!command) {
        return [];
    }
    try {
        return (0, command_guard_js_1.extractHosts)(command) || [];
    }
    catch {
        // RULEBOOK 搂2 (broad swallow): an extractor failure must not take the whole
        // network decision offline; it degrades to IP literals only.
        return extractIps(command);
    }
}
// 鈹€鈹€ policy 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
/** One filesystem entry from the YAML, already resolved to a real path. */
class FsRule {
    raw;
    path;
    access;
    constructor(raw, p, access) {
        this.raw = raw;
        this.path = p;
        this.access = access;
    }
    get specificity() {
        return this.path.length;
    }
}
exports.FsRule = FsRule;
class PolicyVerdict {
    allowed;
    reason;
    path;
    access;
    rule;
    constructor(allowed, opts = {}) {
        this.allowed = allowed;
        this.reason = opts.reason ?? "";
        this.path = opts.path ?? "";
        this.access = opts.access ?? "";
        this.rule = opts.rule ?? "";
    }
}
exports.PolicyVerdict = PolicyVerdict;
/** Raised when a command names a path the policy forbids. */
class PathPolicyError extends Error {
    verdict;
    constructor(verdict) {
        super(verdict.reason);
        this.verdict = verdict;
    }
}
exports.PathPolicyError = PathPolicyError;
/** Resolved policy for one workspace. Build via `loadPolicy`. */
class PathPolicy {
    workspaceRoot;
    rules = [];
    networkDefault = "allow";
    networkBlock = [];
    /** Egress allowlist. Only meaningful when `networkDefault === "deny"`. */
    networkAllow = [];
    source = "built-in";
    constructor(workspaceRoot) {
        this.workspaceRoot = workspaceRoot;
    }
    // Fluent builders for tests and callers that skip YAML.
    allowRead(pattern) {
        return this._add(pattern, exports.RO);
    }
    allowWrite(pattern) {
        return this._add(pattern, exports.RW);
    }
    denyWrite(pattern) {
        return this._add(pattern, exports.RO);
    }
    denyAll(pattern) {
        return this._add(pattern, exports.NONE);
    }
    _add(pattern, access) {
        for (const p of resolveKey(pattern, this.workspaceRoot)) {
            this.rules.push(new FsRule(pattern, p, access));
        }
        return this;
    }
    _matching(p) {
        const hits = this.rules.filter((r) => patternMatches(p, r.path) || patternMatches(p, r.path + "/**"));
        if (!hits.length) {
            return null;
        }
        // RULEBOOK 搂2 (sort stability): the source sorts by specificity descending
        // and takes the first. Python's sort is stable, so equal specificity keeps
        // registration order 鈥?reproduced.
        hits.sort((a, b) => b.specificity - a.specificity);
        return hits[0];
    }
    /** Check one resolved path. `access` is "read" or "write". */
    checkPath(p, access) {
        const normed = normPath(p);
        // Hard floor: guiding files are never writable through this layer.
        const base = path.basename(normed).toLowerCase();
        if (access === "write" && path_guard_js_1.READONLY_BASENAMES.has(base)) {
            return new PolicyVerdict(false, {
                reason: `Refused: \`${path.basename(p)}\` is a guiding file. ` +
                    "The model must not overwrite it from the shell.",
                path: normed,
                access,
                rule: "guiding-file",
            });
        }
        const rule = this._matching(normed);
        if (rule === null) {
            if (access === "write") {
                return new PolicyVerdict(false, {
                    reason: `Refused: write to \`${p}\` is outside the allowed paths ` +
                        `(workspace / tmp). Edit sandbox-policy.yaml to allow it.`,
                    path: normed,
                    access,
                    rule: "default-deny-write",
                });
            }
            return new PolicyVerdict(true, { path: normed, access, rule: "default-allow-read" });
        }
        if (rule.access === exports.NONE) {
            return new PolicyVerdict(false, {
                reason: `Refused: \`${p}\` is classified \`${rule.raw}: none\` in ${this.source}.`,
                path: normed,
                access,
                rule: rule.raw,
            });
        }
        if (access === "write" && rule.access === exports.RO) {
            return new PolicyVerdict(false, {
                reason: `Refused: \`${p}\` is read-only (\`${rule.raw}: ro\` in ${this.source}).`,
                path: normed,
                access,
                rule: rule.raw,
            });
        }
        return new PolicyVerdict(true, { path: normed, access, rule: rule.raw });
    }
    /**
     * Network egress verdict: **domains and IPs go through the same rules**, and
     * deny is checked before allow.
     *
     * Two design constraints:
     *  * The dimensions must be aligned. An early version only looked at IPv4
     *    literals, so `curl https://evil.com/x` was allowed outright because it
     *    contained no IP 鈥?the same policy working for IPs and failing for domains
     *    is no policy at all. IPs go through CIDR, domains through **whole-label
     *    suffix** matching (`evil.com` hits `sub.evil.com` but not `notevil.com`).
     *  * The order must be deny -> allow -> default. An allow hit must NOT
     *    override a block hit, or a user who configured a blocklist would void it
     *    by adding one allowlist entry.
     *
     * The actual disconnect is the kernel sandbox's job; this layer's job is
     * "don't let a visible host go the wrong way".
     */
    checkNetwork(command) {
        if (!command) {
            return new PolicyVerdict(true, { access: "network" });
        }
        const def = (this.networkDefault || "allow").toLowerCase();
        const blocked = splitNetworkEntries(this.networkBlock);
        const allowed = splitNetworkEntries(this.networkAllow);
        for (const host of extractHosts(command)) {
            const hit = hostRuleHit(host, blocked);
            if (hit) {
                return new PolicyVerdict(false, {
                    reason: `Refused: \`${host}\` matches blocked entry \`${hit}\` in ${this.source}.`,
                    path: host,
                    access: "network",
                    rule: hit,
                });
            }
            if (def === "deny") {
                // The allowlist only rescues in closed mode; in open mode it is moot.
                if (hostRuleHit(host, allowed)) {
                    continue;
                }
                return new PolicyVerdict(false, {
                    reason: `Refused: network is denied by policy; command names \`${host}\`.`,
                    path: host,
                    access: "network",
                    rule: "network.default",
                });
            }
        }
        return new PolicyVerdict(true, { access: "network" });
    }
    evaluateCommand(command, cwd = "") {
        const net = this.checkNetwork(command);
        if (!net.allowed) {
            return net;
        }
        for (const intent of extractIntents(command, cwd || this.workspaceRoot)) {
            const verdict = this.checkPath(intent.path, intent.access);
            if (!verdict.allowed) {
                return verdict;
            }
        }
        return new PolicyVerdict(true);
    }
    assertAllowed(command, cwd = "") {
        const verdict = this.evaluateCommand(command, cwd);
        if (!verdict.allowed) {
            throw new PathPolicyError(verdict);
        }
    }
    summary() {
        return {
            source: this.source,
            workspace: this.workspaceRoot,
            filesystem: this.rules.map((r) => ({ path: r.path, access: r.access, raw: r.raw })),
            network: {
                default: this.networkDefault,
                block: [...this.networkBlock],
                allow: [...this.networkAllow],
            },
        };
    }
}
exports.PathPolicy = PathPolicy;
/**
 * RULEBOOK 搂2 (no equivalent): Python's `ipaddress` module has no Node
 * counterpart. `node:net`'s `isIP` gives a version but no containment, so the
 * parse and the prefix test are implemented here.
 */
function parseIp(s) {
    const t = s.trim();
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(t);
    if (v4) {
        const bytes = v4.slice(1, 5).map((x) => Number(x));
        if (bytes.some((b) => b > 255)) {
            return null;
        }
        return { version: 4, bytes };
    }
    if (t.includes(":")) {
        // IPv6 with `::` compression.
        let head = t;
        let tail = "";
        if (t.includes("::")) {
            const [h, tl] = t.split("::");
            head = h;
            tail = tl ?? "";
        }
        const headParts = head ? head.split(":") : [];
        const tailParts = tail ? tail.split(":") : [];
        if (t.includes("::")) {
            const fill = 8 - headParts.length - tailParts.length;
            if (fill < 0) {
                return null;
            }
            const parts = [...headParts, ...Array(fill).fill("0"), ...tailParts];
            return assembleV6(parts);
        }
        return assembleV6(headParts);
    }
    return null;
}
function assembleV6(parts) {
    if (parts.length !== 8) {
        return null;
    }
    const bytes = [];
    for (const p of parts) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(p)) {
            return null;
        }
        const v = parseInt(p, 16);
        bytes.push((v >> 8) & 0xff, v & 0xff);
    }
    return { version: 6, bytes };
}
function parseCidr(s) {
    const t = s.trim();
    if (!t) {
        return null;
    }
    const slashAt = t.lastIndexOf("/");
    const addr = slashAt === -1 ? t : t.slice(0, slashAt);
    const ip = parseIp(addr);
    if (!ip) {
        return null;
    }
    const bits = ip.version === 4 ? 32 : 128;
    let prefix = bits;
    if (slashAt !== -1) {
        const p = Number(t.slice(slashAt + 1));
        if (!Number.isInteger(p) || p < 0 || p > bits) {
            return null;
        }
        prefix = p;
    }
    return { version: ip.version, bytes: ip.bytes, prefix, raw: t };
}
function cidrContains(c, ip) {
    // RULEBOOK 搂2: `ip in net` raises TypeError for a v4/v6 mismatch, which the
    // source catches and skips. Reproduced as a false return.
    if (c.version !== ip.version) {
        return false;
    }
    let remaining = c.prefix;
    for (let i = 0; i < c.bytes.length; i++) {
        if (remaining <= 0) {
            break;
        }
        const take = Math.min(8, remaining);
        const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
        if ((c.bytes[i] & mask) !== (ip.bytes[i] & mask)) {
            return false;
        }
        remaining -= take;
    }
    return true;
}
/**
 * Split `network.block` / `network.allow` entries into (CIDRs, domains).
 *
 * Mixing the two dimensions in one list is deliberate: a user writing policy
 * cares whether the egress is wanted, not whether it is an IP or a domain.
 * Entries that parse as neither are dropped 鈥?an unparseable rule treated as
 * "matches everything" would turn a blocklist into a blanket deny.
 */
function splitNetworkEntries(entries) {
    const domains = [];
    for (const raw of entries ?? []) {
        const s = String(raw).trim().toLowerCase();
        if (!s || s.includes("/")) {
            continue;
        }
        if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) {
            continue; // a bare IP is collected by parseCidrs as a /32
        }
        if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+$/.test(s)) {
            domains.push(s);
        }
    }
    return [parseCidrs(entries), domains];
}
/** Which of (cidrs, domains) a host matches; null when neither does. */
function hostRuleHit(host, entries) {
    const [cidrs, domains] = entries;
    const ip = parseIp(host);
    if (ip !== null) {
        for (const c of cidrs) {
            if (cidrContains(c, ip)) {
                return c.raw;
            }
        }
        return null;
    }
    try {
        return (0, command_guard_js_1.domainSuffixMatch)(host, domains);
    }
    catch {
        // RULEBOOK 搂2 (broad swallow): preserved.
        return null;
    }
}
function parseCidrs(entries) {
    const out = [];
    for (const raw of entries ?? []) {
        const s = String(raw).trim();
        if (!s) {
            continue;
        }
        const c = parseCidr(s);
        if (c) {
            out.push(c);
        }
    }
    return out;
}
/** Map a YAML key (`workspace`, `tmp`, `.git`, `~/.ssh`, 鈥? to paths. */
function resolveKey(key, workspaceRoot) {
    const k = (key || "").trim();
    const ws = normPath(workspaceRoot || process.cwd());
    if (["workspace", "workspace/**", "{workspace}", "{workspace}/**"].includes(k)) {
        return [ws];
    }
    if (["tmp", "temp", "tmp/**"].includes(k)) {
        const extras = [os.tmpdir()];
        extras.push(path.join(workspaceRoot, "temp"));
        extras.push(path.join(workspaceRoot, "output"));
        if (process.platform === "win32") {
            // RULEBOOK 搂2 (set-derived ordering): the source builds a SET of drive
            // letters and iterates it, so the ORDER of this list is hash-dependent
            // across processes. The set of paths is the contract; the order is not 鈥?            // sorted here so two runs and two implementations agree. This is the
            // exact site the parity harness declares `unordered` for.
            const drives = new Set([
                "c:",
                "d:",
                driveOf(workspaceRoot),
                driveOf(os.tmpdir()),
            ]);
            for (const d of Array.from(drives).sort()) {
                if (d) {
                    extras.push(`${d}/tmp`);
                    extras.push(`${d}/temp`);
                }
            }
        }
        else {
            extras.push("/tmp", "/var/tmp");
        }
        return extras.map((p) => normPath(p));
    }
    if (k.startsWith("workspace/") || k.startsWith("workspace\\")) {
        const rest = k.slice("workspace".length).replace(/^[/\\]+/, "");
        return [normPath(path.join(workspaceRoot, rest))];
    }
    if (k.startsWith("{workspace}")) {
        const rest = k.slice("{workspace}".length).replace(/^[/\\]+/, "");
        return rest ? [normPath(path.join(workspaceRoot, rest))] : [ws];
    }
    // A bare relative key (`.git`, `src`) lives under the workspace.
    let expanded = expandVars(expandUser(k));
    if (!path.isAbsolute(expanded) && !/^[A-Za-z]:[\\/]/.test(expanded)) {
        expanded = path.join(workspaceRoot, expanded);
    }
    return [normPath(expanded)];
}
/** `os.path.splitdrive(p)[0].lower()` 鈥?"c:" on Windows, "" elsewhere. */
function driveOf(p) {
    const m = /^([A-Za-z]:)/.exec(path.resolve(p));
    return m ? m[1].toLowerCase() : "";
}
/** Defaults matching sandbox-policy.example.yaml, plus PathGuard's floor. */
function builtinFilesystem() {
    const fsMap = new Map([
        ["workspace", exports.RW],
        ["tmp", exports.RW],
        [".git", exports.RW],
        ["~/.ssh", exports.NONE],
        ["~/.gnupg", exports.NONE],
        ["/etc", exports.NONE],
        ["/System", exports.RO],
        ["/usr/bin", exports.RO],
        ["/bin", exports.RO],
        ["/sbin", exports.RO],
        ["C:/Windows", exports.RO],
        ["C:/Program Files", exports.RO],
        ["C:/Program Files (x86)", exports.RO],
    ]);
    // PathGuard's blacklist is a write-deny floor even if the YAML forgets it.
    for (const root of path_guard_js_1.DEFAULT_BLACKLIST) {
        const k = root.replace(/\\/g, "/");
        if (!fsMap.has(k)) {
            fsMap.set(k, exports.RO);
        }
    }
    return fsMap;
}
function findPolicyFile(workspaceRoot) {
    const candidates = [];
    if (workspaceRoot) {
        for (const name of POLICY_FILENAMES) {
            candidates.push(path.join(workspaceRoot, name));
            candidates.push(path.join(workspaceRoot, ".ovolve", name));
        }
    }
    // The new home first, then the legacy location, so a not-yet-migrated policy
    // file still applies.
    for (const base of [homeDirSafe(), path.join(os.homedir(), ".ovolve")]) {
        for (const name of POLICY_FILENAMES) {
            candidates.push(path.join(base, name));
        }
    }
    for (const p of candidates) {
        try {
            if (fs.statSync(p).isFile()) {
                return p;
            }
        }
        catch {
            continue;
        }
    }
    return null;
}
/** `user_dirs.home_dir()`, with the packaged-import fallback the source has. */
function homeDirSafe() {
    return path.join(os.homedir(), ".ovolve");
}
/**
 * Load YAML (if any) and resolve it against `workspaceRoot`.
 *
 * `mode=read-only` forces every filesystem entry to `ro` except `tmp`
 * (compilers still need a scratch dir). `danger-full-access` keeps the hard
 * floor (system dirs, secrets, guiding files) but allows writes anywhere else.
 */
function loadPolicy(workspaceRoot, mode = "workspace-write") {
    const ws = workspaceRoot || process.cwd();
    let fsMap = builtinFilesystem();
    let netDefault = "allow";
    let netBlock = ["169.254.169.254/32", "169.254.0.0/16"];
    let netAllow = [];
    let source = "built-in";
    const policyPath = findPolicyFile(ws);
    if (policyPath) {
        let doc = {};
        try {
            doc = loadSimpleYaml(fs.readFileSync(policyPath, "utf8"));
        }
        catch {
            // RULEBOOK 搂2 (broad swallow): OSError / ValueError -> empty doc, and the
            // built-in defaults stand.
            doc = {};
        }
        if (Object.keys(doc).length || true) {
            source = policyPath;
            const userFs = doc["filesystem"] || {};
            if (userFs && typeof userFs === "object" && !Array.isArray(userFs)) {
                for (const [k, v] of Object.entries(userFs)) {
                    const access = String(v ?? "").trim().toLowerCase();
                    if (ACCESS.has(access)) {
                        fsMap.set(String(k), access);
                    }
                }
            }
            const userNet = doc["network"] || {};
            if (userNet && typeof userNet === "object" && !Array.isArray(userNet)) {
                if (userNet["default"]) {
                    netDefault = String(userNet["default"]).trim().toLowerCase();
                }
                const block = userNet["block"] || [];
                if (Array.isArray(block) && block.length) {
                    netBlock = block.map((x) => String(x));
                }
                const allow = userNet["allow"] || [];
                if (Array.isArray(allow) && allow.length) {
                    netAllow = allow.map((x) => String(x));
                }
            }
        }
    }
    const m = (mode || "").trim().toLowerCase();
    if (m === "read-only") {
        fsMap = new Map(Array.from(fsMap, ([k, v]) => [k, ["tmp", "temp", "tmp/**"].includes(k) ? exports.RW : exports.RO]));
        fsMap.set("workspace", exports.RO);
        fsMap.set("tmp", exports.RW);
    }
    else if (m === "danger-full-access") {
        // Keep secrets and OS dirs; drop the default-deny-write by marking a
        // catch-all rw. Specific none/ro rules still win on specificity.
        fsMap.set("/", exports.RW);
        if (process.platform === "win32") {
            fsMap.set("C:/", exports.RW);
        }
    }
    const policy = new PathPolicy(normPath(ws));
    policy.networkDefault = netDefault;
    policy.networkBlock = [...netBlock];
    policy.networkAllow = [...netAllow];
    policy.source = source;
    for (const [key, access] of fsMap) {
        policy._add(String(key), access);
    }
    // Guiding-file globs as ro, so a write intent matching them is denied even
    // when the workspace itself is rw. checkPath also has a basename floor.
    for (const g of GUIDING_GLOBS) {
        for (const resolved of resolveKey(g, ws)) {
            policy.rules.push(new FsRule(g, resolved, exports.RO));
        }
    }
    return policy;
}
function evaluateCommand(command, opts) {
    return loadPolicy(opts.workspaceRoot, opts.mode ?? "workspace-write").evaluateCommand(command, opts.cwd || opts.workspaceRoot);
}
function assertCommandAllowed(command, opts) {
    const policy = loadPolicy(opts.workspaceRoot, opts.mode ?? "workspace-write");
    policy.assertAllowed(command, opts.cwd || opts.workspaceRoot);
    return policy;
}
/**
 * TODO(port): this unit is routed SPLIT. The compute core the line-count rule
 * found here is the extraction and matching layer 鈥?`findRedirections`,
 * `scanIntents`, `patternMatches`, `globToRe`, `parseCidr` and the CIDR test.
 *
 * Unlike `path_guard`, this one has a plausible case for Rust: the extraction
 * walks every character of a command line and is called on every command-running
 * tool call. Whether the crossing cost is worth it needs the operator's call,
 * and the rulebook's 搂0 says the cost must be justified rather than assumed.
 * Left as one TS module until then; behaviour is identical either way.
 */
