"""Negative witnesses for CI evidence and file-safety checks (no dependencies)."""
import copy
import importlib.util
from pathlib import Path
import unittest
import sys

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("crm_guard", Path(__file__).with_name("check-crm906-pr.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def complete_evidence():
    return {
        "bootstrap_exit": 0,
        "results": [{"label": label, "ok": True} for label in guard.EXPECTED_LABELS],
        "full_suite": {"exit": 0, "summaries": sorted(guard.EXPECTED_SUMMARIES)},
        "negative_runner_exit": 2,
        "masked_runner_exit": 2,
    }


class SafetyTests(unittest.TestCase):
    def test_protected_files_cannot_be_added_deleted_or_renamed(self):
        for name in guard.PROTECTED:
            with self.subTest(path=name), self.assertRaises(ValueError):
                guard.validate_paths([name])

    def test_sensitive_paths_refused_but_public_templates_allowed(self):
        for name in (".env", "nested/.env.production", "private.pem", "audit/results.json", "docs/crm906-fixes-report.md"):
            with self.subTest(path=name), self.assertRaises(ValueError):
                guard.validate_paths([name])
        guard.validate_paths([".env.example", "docs/oralink/crm/906.md", "supabase/migrations/906_oralink_consent_order_hardening.sql"])

    def test_complete_evidence_accepted(self):
        self.assertEqual(guard.validate_results(complete_evidence()), 58)

    def test_missing_critical_case_cannot_be_replaced_by_fake_pass(self):
        data = complete_evidence()
        data["results"][0]["label"] = "unrelated test"
        with self.assertRaises(ValueError):
            guard.validate_results(data)

    def test_omitted_failed_duplicate_or_nonboolean_results_fail(self):
        mutations = []
        data = complete_evidence(); data["results"].pop(); mutations.append(data)
        data = complete_evidence(); data["results"][0]["ok"] = False; mutations.append(data)
        data = complete_evidence(); data["results"][0]["ok"] = 1; mutations.append(data)
        data = complete_evidence(); data["results"][0] = copy.deepcopy(data["results"][1]); mutations.append(data)
        for data in mutations:
            with self.subTest(data=data["results"][0]), self.assertRaises(ValueError):
                guard.validate_results(data)

    def test_missing_full_suite_or_expected_sql_error_fails(self):
        for field in ("full_suite", "negative_runner_exit", "masked_runner_exit", "bootstrap_exit"):
            data = complete_evidence(); data.pop(field)
            with self.subTest(field=field), self.assertRaises(ValueError):
                guard.validate_results(data)


if __name__ == "__main__":
    unittest.main()
