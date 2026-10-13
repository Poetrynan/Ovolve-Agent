//! CPython's call-binding error grammar, reimplemented for the ports.
//!
//! A call to a python-defined function is bound by the eval loop, which owns
//! the wording of every binding mistake. pyo3's generated argument parser
//! hard-codes different text ("takes no arguments (1 given)", no spelling
//! suggestion), so each port that accepts `*args`/`**kwargs` verbatim has to
//! rebuild that wording here.
//!
//! Two pieces, both taken from CPython 3.13 rather than re-derived:
//!
//! * [`unexpected_keyword`] - `ceval.c`'s `"%U() got an unexpected keyword
//!   argument '%S'"`, plus the `". Did you mean 'x'?"` suffix that
//!   `_Py_CalculateSuggestions()` (`Python/suggestions.c`) appends when one of
//!   the keyword-eligible parameter names is close enough. The closeness rule
//!   is a Damerau-flavoured Levenshtein over UTF-8 *bytes* with MOVE_COST 2,
//!   CASE_COST 1 and a `len/3` budget - all of which is observable (a typo in
//!   one of two capital letters suggests, a typo in both does not), so it is
//!   reproduced line for line instead of approximated.
//! * [`too_many_positional`] - `ceval.c`'s arity message, including the
//!   "from N to M" form when some parameters have defaults, the singular
//!   "argument" only in the no-defaults-and-exactly-one case, and "was" vs
//!   "were".
//!
//! Neither covers keyword-only parameters (`"(and N keyword-only argument)"`):
//! no ported module declares any.

const MOVE_COST: usize = 2;
const CASE_COST: usize = 1;
const MAX_STRING_SIZE: usize = 40;
const MAX_CANDIDATE_ITEMS: usize = 750;

/// `suggestions.c:substitution_cost()`. The `& 31` test is what makes a single
/// capital letter cheap and an all-caps name unmatchable.
fn substitution_cost(a: u8, b: u8) -> usize {
    if (a & 31) != (b & 31) {
        return MOVE_COST;
    }
    if a == b {
        return 0;
    }
    let mut a = a;
    let mut b = b;
    if (b'A'..=b'Z').contains(&a) {
        a += 32;
    }
    if (b'A'..=b'Z').contains(&b) {
        b += 32;
    }
    if a == b {
        CASE_COST
    } else {
        MOVE_COST
    }
}

/// `suggestions.c:levenshtein_distance()`, bail-out paths included: `max_cost
/// + 1` means "worse than anything the caller will accept".
fn edit_cost(a_in: &[u8], b_in: &[u8], max_cost: usize) -> usize {
    let mut a = a_in;
    let mut b = b_in;

    let pre = a.iter().zip(b.iter()).take_while(|(x, y)| x == y).count();
    a = &a[pre..];
    b = &b[pre..];
    let mut suf = 0;
    while suf < a.len() && suf < b.len() && a[a.len() - 1 - suf] == b[b.len() - 1 - suf] {
        suf += 1;
    }
    a = &a[..a.len() - suf];
    b = &b[..b.len() - suf];

    if a.is_empty() || b.is_empty() {
        return (a.len() + b.len()) * MOVE_COST;
    }
    if a.len() > MAX_STRING_SIZE || b.len() > MAX_STRING_SIZE {
        return max_cost + 1;
    }
    if b.len() < a.len() {
        // prefer the shorter buffer
        let t = a;
        a = b;
        b = t;
    }
    if (b.len() - a.len()) * MOVE_COST > max_cost {
        return max_cost + 1;
    }

    let mut buffer = [0usize; MAX_STRING_SIZE];
    let mut tmp = MOVE_COST;
    for slot in buffer.iter_mut().take(a.len()) {
        *slot = tmp;
        tmp += MOVE_COST;
    }

    let mut result = 0usize;
    for (b_index, &code) in b.iter().enumerate() {
        let mut distance = b_index * MOVE_COST;
        result = b_index * MOVE_COST;
        let mut minimum = usize::MAX;
        for (index, &ac) in a.iter().enumerate() {
            let substitute = distance + substitution_cost(code, ac);
            distance = buffer[index];
            let insert_delete = result.min(distance) + MOVE_COST;
            result = insert_delete.min(substitute);
            buffer[index] = result;
            if result < minimum {
                minimum = result;
            }
        }
        if minimum > max_cost {
            return max_cost + 1;
        }
    }
    result
}

/// `suggestions.c:_Py_CalculateSuggestions()`: the single best candidate, ties
/// going to the earliest one in call-signature order.
pub(crate) fn suggestion<'a>(candidates: &[&'a str], name: &str) -> Option<&'a str> {
    if candidates.len() >= MAX_CANDIDATE_ITEMS {
        return None;
    }
    let nb = name.as_bytes();
    let mut best: Option<&'a str> = None;
    let mut best_dist: isize = isize::MAX;
    for item in candidates {
        if *item == name {
            continue;
        }
        let ib = item.as_bytes();
        // no more than 1/3 of the involved characters may need changed
        let mut max_distance =
            ((nb.len() + ib.len() + 3) * MOVE_COST / 6) as isize;
        if best.is_some() {
            // never take a match we have already beaten
            max_distance = max_distance.min(best_dist - 1);
        }
        if max_distance < 0 {
            continue;
        }
        let current = edit_cost(nb, ib, max_distance as usize) as isize;
        if current > max_distance {
            continue;
        }
        if best.is_none() || current < best_dist {
            best = Some(item);
            best_dist = current;
            if best_dist == 0 {
                break;
            }
        }
    }
    best
}

/// CPython's unexpected-keyword TypeError, spelling suggestion included.
/// `qualname` is the dotted name the eval loop prints (`f`, or `Cls.__init__`).
pub(crate) fn unexpected_keyword(qualname: &str, key: &str, candidates: &[&str]) -> String {
    match suggestion(candidates, key) {
        Some(s) => format!(
            "{}() got an unexpected keyword argument '{}'. Did you mean '{}'?",
            qualname, key, s
        ),
        None => format!(
            "{}() got an unexpected keyword argument '{}'",
            qualname, key
        ),
    }
}

/// CPython's too-many-positional TypeError. `co_argcount` is the number of
/// positional-or-keyword parameters the function declares (including `self`
/// for a plain `__init__`), `defcount` how many of them have defaults,
/// `given` how many positionals the call actually passed.
pub(crate) fn too_many_positional(
    qualname: &str,
    co_argcount: usize,
    defcount: usize,
    given: usize,
) -> String {
    let (sig, plural) = if defcount > 0 {
        (
            format!("from {} to {}", co_argcount - defcount, co_argcount),
            true,
        )
    } else {
        (format!("{}", co_argcount), co_argcount != 1)
    };
    format!(
        "{}() takes {} positional argument{} but {} {} given",
        qualname,
        sig,
        if plural { "s" } else { "" },
        given,
        if given == 1 { "was" } else { "were" }
    )
}
