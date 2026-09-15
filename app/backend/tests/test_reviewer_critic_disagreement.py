# -*- coding: utf-8 -*-
import pytest
from ast_reviewer_enhanced import (
    ASTReviewer,
    ReviewFinding,
    PERSPECTIVE_SECURITY,
    PERSPECTIVE_PERFORMANCE,
    PERSPECTIVE_MAINTAINABILITY,
    PERSPECTIVE_TEST_COVERAGE,
    get_ast_reviewer,
)
from team import (
    ReviewVerdict,
    adjudicate_review_findings,
    REVIEW_PERSPECTIVE_TEMPLATES,
)


def test_four_fixed_perspectives_constants():
    assert PERSPECTIVE_SECURITY == "security"
    assert PERSPECTIVE_PERFORMANCE in ("perf", "performance")
    assert PERSPECTIVE_MAINTAINABILITY == "maintainability"
    assert PERSPECTIVE_TEST_COVERAGE in ("test-coverage", "tests")
    assert len(REVIEW_PERSPECTIVE_TEMPLATES) >= 4


def test_ast_reviewer_multi_perspective_detection():
    reviewer = get_ast_reviewer()

    # 1. Performance: regex compilation inside loop and quadratic loop
    perf_code = """
import re

def process_items(items):
    total = ""
    for item in items:
        pattern = re.compile(r"\\d+")
        total += str(item)
        for sub in items:
            pass
    return total
"""
    findings = reviewer.review_perspectives(perf_code, perspectives=["perf"])
    assert len(findings) > 0
    assert any(f.perspective in ("perf", "performance") for f in findings)
    assert any("loop" in f.message.lower() or "re.compile" in f.message.lower() or "concatenation" in f.message.lower() for f in findings)

    # 2. Maintainability: wildcard import & too many arguments
    maint_code = """
from os import *

def overly_complex_function(a, b, c, d, e, f, g, h, i):
    if a:
        if b:
            if c:
                if d:
                    if e:
                        return 1
    return 0
"""
    findings_maint = reviewer.review_perspectives(maint_code, perspectives=["maintainability"])
    assert len(findings_maint) > 0
    assert any("wildcard" in f.message.lower() or "argument" in f.message.lower() or "nest" in f.message.lower() for f in findings_maint)

    # 3. Test coverage: missing assertion & swallowed exception
    test_code = """
def test_missing_assertion():
    a = 1 + 1

def risky_worker():
    try:
        do_something()
    except Exception:
        pass
"""
    findings_tests = reviewer.review_perspectives(test_code, perspectives=["test-coverage"])
    assert len(findings_tests) > 0
    assert any("assertion" in f.message.lower() or "except" in f.message.lower() or "swallow" in f.message.lower() for f in findings_tests)


def test_critic_three_state_adjudication():
    findings = [
        ReviewFinding(
            id="f-sec-1",
            perspective="security",
            severity="error",
            message="Blocked dangerous call: os.system",
            rule_id="SEC_CALL",
        ),
        ReviewFinding(
            id="f-sec-fp",
            perspective="security",
            severity="warning",
            message="Blocked dangerous import: os",
            file="tests/test_demo.py",
            rule_id="SEC_IMPORT",
        ),
        ReviewFinding(
            id="f-maint-ambiguous",
            perspective="maintainability",
            severity="warning",
            message="Potential dynamic attribute access requires manual check",
            rule_id="MAINT_DYNAMIC",
        ),
    ]

    # Critic adjudication function
    def custom_critic(finding: ReviewFinding) -> tuple[str, str]:
        if "test_demo.py" in finding.file:
            return ReviewVerdict.REJECTED, "Standard import in test file is expected"
        if "dynamic" in finding.message.lower():
            return ReviewVerdict.ESCALATED, "Requires human review for dynamic access"
        return ReviewVerdict.CONFIRMED, "Verified genuine security defect"

    result = adjudicate_review_findings(findings, critic_fn=custom_critic)
    assert len(result[ReviewVerdict.CONFIRMED]) == 1
    assert len(result[ReviewVerdict.REJECTED]) == 1
    assert len(result[ReviewVerdict.ESCALATED]) == 1

    assert result[ReviewVerdict.CONFIRMED][0].id == "f-sec-1"
    assert result[ReviewVerdict.REJECTED][0].id == "f-sec-fp"
    assert result[ReviewVerdict.ESCALATED][0].id == "f-maint-ambiguous"


def test_ast_reviewer_verify_with_critic_pass():
    reviewer = get_ast_reviewer()
    # Code with an actual security flaw
    code_vuln = "import os\nos.system('rm -rf /')"
    findings = reviewer.review_perspectives(code_vuln, perspectives=["security"])
    adjudicated = reviewer.verify_with_critic(findings, code=code_vuln)

    confirmed = [f for f in adjudicated if f.verdict == ReviewVerdict.CONFIRMED]
    assert len(confirmed) >= 1