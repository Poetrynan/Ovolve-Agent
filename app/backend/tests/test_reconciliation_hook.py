"""
test_reconciliation_hook.py — 5D 任务完成态自动收口与文档对齐审计测试。
"""
import pytest
import os
import sys
import tempfile

backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from reconciliation import PostTurnReconciliationEngine, ReconciliationSummary


def test_reconciliation_summary_and_audit():
    with tempfile.TemporaryDirectory() as tmp_ws:
        # Create a mock doc
        docs_dir = os.path.join(tmp_ws, "Documents")
        os.makedirs(docs_dir, exist_ok=True)
        with open(os.path.join(docs_dir, "PROGRESS.md"), "w", encoding="utf-8") as f:
            f.write("# PROGRESS\n")

        # Create an ephemeral temp file
        tmp_file = os.path.join(tmp_ws, "test_scratch.tmp")
        with open(tmp_file, "w", encoding="utf-8") as f:
            f.write("temporary data")

        assert os.path.exists(tmp_file)

        # Run reconciliation
        summary = PostTurnReconciliationEngine.run_reconciliation(tmp_ws)

        assert isinstance(summary, ReconciliationSummary)
        # Verify ephemeral file was cleaned
        assert not os.path.exists(tmp_file)
        assert len(summary.cleaned_ephemeral_files) == 1
        assert "Documents/PROGRESS.md" in summary.docs_audited
        assert len(summary.audit_notes) > 0
