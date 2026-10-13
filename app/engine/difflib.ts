/**
 * difflib.ts — SequenceMatcher（gestalt pattern matching）的逐行忠实移植.
 *
 * Ported from the interpreter's stdlib `difflib.py` (CPython 3.13 source,
 * SequenceMatcher class). Python 侧 `difflib` 是标准库；TS 无对应物，
 * 故在本仓库内自带一份，供 cua_ocr_diff 等单元 `import` 使用。
 *
 * RULEBOOK CITATIONS
 *   §2  behaviour: b2j index map, j2len cascade in find_longest_match
 *       (strictly `>` bestsize update ⇒ earliest-in-a then earliest-in-b
 *       tie-breaking), the four extend loops (non-junk backward/forward,
 *       junk backward/forward), queue-based get_matching_blocks with
 *       tuple-order sort and adjacent-block collapse, sentinel (len(a),
 *       len(b), 0), get_opcodes tag selection, ratio = 2.0*matches/total
 *       else 1.0 — all byte-for-byte in algorithm, including the
 *       autojunk popular-element purge (n >= 200, ntest = n//100 + 1)
 *       even though every in-repo caller passes autojunk=false.
 *   §2  sequence elements are line strings; Python dict-key equality and
 *       JS Map key equality agree on strings (value identity).
 *   DIVERGENCE(port): the isjunk callable takes str→bool in both worlds;
 *       Match namedtuple becomes a [a,b,size] tuple. No observable change.
 *
 * 本文件不做任何 OCR/业务逻辑；只是差异计算内核。
 */

export type Match = [a: number, b: number, size: number];
export type Opcode = [tag: string, i1: number, i2: number, j1: number, j2: number];

function calculateRatio(matches: number, length: number): number {
    if (length) {
        return (2.0 * matches) / length;
    }
    return 1.0;
}

export class SequenceMatcher {
    a: string[];
    b: string[];
    autojunk: boolean;
    private isjunk: ((elt: string) => boolean) | null;
    private b2j: Map<string, number[]> = new Map();
    private bjunk: Set<string> = new Set();
    private bpopular: Set<string> = new Set();
    private matchingBlocks: Match[] | null = null;
    private opcodesCache: Opcode[] | null = null;

    constructor(
        isjunk: ((elt: string) => boolean) | null = null,
        a: string[] = [],
        b: string[] = [],
        autojunk: boolean = true,
    ) {
        this.isjunk = isjunk;
        this.a = [];
        this.b = [];
        this.autojunk = autojunk;
        this.setSeqs(a, b);
    }

    setSeqs(a: string[], b: string[]): void {
        this.setSeq1(a);
        this.setSeq2(b);
    }

    setSeq1(a: string[]): void {
        if (a === this.a) {
            return;
        }
        this.a = a;
        this.matchingBlocks = this.opcodesCache = null;
    }

    setSeq2(b: string[]): void {
        if (b === this.b) {
            return;
        }
        this.b = b;
        this.matchingBlocks = this.opcodesCache = null;
        this.chainB();
    }

    private chainB(): void {
        // b2j: for each element of b, the ascending list of its indices.
        const b = this.b;
        const b2j = new Map<string, number[]>();
        b.forEach((elt, i) => {
            let indices = b2j.get(elt);
            if (indices === undefined) {
                indices = [];
                b2j.set(elt, indices);
            }
            indices.push(i);
        });
        this.b2j = b2j;

        // Purge junk elements (separate loop avoids mutating during keys()).
        const bjunk = new Set<string>();
        this.bjunk = bjunk;
        const isjunk = this.isjunk;
        if (isjunk) {
            for (const elt of [...b2j.keys()]) {
                if (isjunk(elt)) {
                    bjunk.add(elt);
                }
            }
            for (const elt of bjunk) {
                b2j.delete(elt);
            }
        }

        // Purge popular elements that are not junk.
        const bpopular = new Set<string>();
        this.bpopular = bpopular;
        const n = b.length;
        if (this.autojunk && n >= 200) {
            const ntest = Math.floor(n / 100) + 1;
            for (const [elt, idxs] of b2j) {
                if (idxs.length > ntest) {
                    bpopular.add(elt);
                }
            }
            for (const elt of bpopular) {
                b2j.delete(elt);
            }
        }
    }

    findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Match {
        const a = this.a;
        const b = this.b;
        const b2j = this.b2j;
        const isbjunk = (x: string): boolean => this.bjunk.has(x);

        let besti = alo;
        let bestj = blo;
        let bestsize = 0;
        // j2len[j] = length of longest junk-free match ending with a[i-1] and b[j]
        let j2len = new Map<number, number>();
        for (let i = alo; i < ahi; i++) {
            // b2j has no junk keys; the loop is skipped if a[i] is junk
            const hits = b2j.get(a[i]!);
            const newj2len = new Map<number, number>();
            if (hits !== undefined) {
                for (const j of hits) {
                    // a[i] matches b[j]
                    if (j < blo) {
                        continue;
                    }
                    if (j >= bhi) {
                        break;
                    }
                    const k = (j2len.get(j - 1) ?? 0) + 1;
                    newj2len.set(j, k);
                    if (k > bestsize) {
                        besti = i - k + 1;
                        bestj = j - k + 1;
                        bestsize = k;
                    }
                }
            }
            j2len = newj2len;
        }

        // Extend the best by non-junk elements on each end.
        while (
            besti > alo && bestj > blo &&
            !isbjunk(b[bestj - 1]!) &&
            a[besti - 1] === b[bestj - 1]
        ) {
            besti -= 1;
            bestj -= 1;
            bestsize += 1;
        }
        while (
            besti + bestsize < ahi && bestj + bestsize < bhi &&
            !isbjunk(b[bestj + bestsize]!) &&
            a[besti + bestsize] === b[bestj + bestsize]
        ) {
            bestsize += 1;
        }

        // Now suck up the matching junk on each side of it too.
        while (
            besti > alo && bestj > blo &&
            isbjunk(b[bestj - 1]!) &&
            a[besti - 1] === b[bestj - 1]
        ) {
            besti -= 1;
            bestj -= 1;
            bestsize += 1;
        }
        while (
            besti + bestsize < ahi && bestj + bestsize < bhi &&
            isbjunk(b[bestj + bestsize]!) &&
            a[besti + bestsize] === b[bestj + bestsize]
        ) {
            bestsize = bestsize + 1;
        }

        return [besti, bestj, bestsize];
    }

    getMatchingBlocks(): Match[] {
        if (this.matchingBlocks !== null) {
            return this.matchingBlocks;
        }
        const la = this.a.length;
        const lb = this.b.length;

        const queue: [number, number, number, number][] = [[0, la, 0, lb]];
        const matchingBlocks: Match[] = [];
        while (queue.length) {
            const [alo, ahi, blo, bhi] = queue.pop()!;
            const x = this.findLongestMatch(alo, ahi, blo, bhi);
            const i = x[0];
            const j = x[1];
            const k = x[2];
            // a[alo:i] vs b[blo:j] unknown
            // a[i:i+k] same as b[j:j+k]
            // a[i+k:ahi] vs b[j+k:bhi] unknown
            if (k) {
                // if k is 0, there was no matching block
                matchingBlocks.push(x);
                if (alo < i && blo < j) {
                    queue.push([alo, i, blo, j]);
                }
                if (i + k < ahi && j + k < bhi) {
                    queue.push([i + k, ahi, j + k, bhi]);
                }
            }
        }
        matchingBlocks.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);

        // Collapse adjacent equal blocks.
        let i1 = 0;
        let j1 = 0;
        let k1 = 0;
        const nonAdjacent: Match[] = [];
        for (const [i2, j2, k2] of matchingBlocks) {
            // Is this block adjacent to i1, j1, k1?
            if (i1 + k1 === i2 && j1 + k1 === j2) {
                k1 += k2;
            } else {
                // Not adjacent. Remember the first block (k1==0 means it's
                // the dummy we started with), make this the new comparator.
                if (k1) {
                    nonAdjacent.push([i1, j1, k1]);
                }
                i1 = i2;
                j1 = j2;
                k1 = k2;
            }
        }
        if (k1) {
            nonAdjacent.push([i1, j1, k1]);
        }

        nonAdjacent.push([la, lb, 0]);
        this.matchingBlocks = nonAdjacent;
        return this.matchingBlocks;
    }

    getOpcodes(): Opcode[] {
        if (this.opcodesCache !== null) {
            return this.opcodesCache;
        }
        let i = 0;
        let j = 0;
        const answer: Opcode[] = [];
        this.opcodesCache = answer;
        for (const [ai, bj, size] of this.getMatchingBlocks()) {
            // invariant: we've pumped out correct diffs to change a[:i] into
            // b[:j], and the next matching block is a[ai:ai+size] == b[bj:bj+size]
            let tag = "";
            if (i < ai && j < bj) {
                tag = "replace";
            } else if (i < ai) {
                tag = "delete";
            } else if (j < bj) {
                tag = "insert";
            }
            if (tag) {
                answer.push([tag, i, ai, j, bj]);
            }
            i = ai + size;
            j = bj + size;
            // the list of matching blocks is terminated by a sentinel with size 0
            if (size) {
                answer.push(["equal", ai, i, bj, j]);
            }
        }
        return answer;
    }

    ratio(): number {
        let matches = 0;
        for (const triple of this.getMatchingBlocks()) {
            matches += triple[2];
        }
        return calculateRatio(matches, this.a.length + this.b.length);
    }
}

// PORT STATUS: confidence=high todos=[0]
