"""Negative witnesses for CI evidence and file-safety checks (no dependencies)."""
import copy
import importlib.util
from pathlib import Path
import unittest
import sys
from types import SimpleNamespace
from unittest.mock import patch

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


class AdditionalWitnessTests(unittest.TestCase):
    def test_sensitive_file_in_history_cannot_hide_behind_empty_net_diff(self):
        original = guard.git
        head = original("rev-parse", "HEAD").decode().strip()
        def git_with_history(*args):
            if args[0] == "log":
                return b"supabase/tests/ol14/fixture.sql\0"
            return original(*args)
        with patch.object(guard, "git", side_effect=git_with_history):
            with self.assertRaises(ValueError):
                guard.check_safety(head)

    def runner(self):
        spec = importlib.util.spec_from_file_location("runner906", Path(__file__).with_name("run-consent-order-906.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_masking_requires_exact_existing_directive(self):
        module = self.runner()
        original = "\\set ON_ERROR_STOP on\nSELECT 1/0;\n"
        self.assertIn("\\set ON_ERROR_STOP off", module.masked_error_sql(original))
        for bad in ["SELECT 1/0;", original + original]:
            with self.subTest(sql=bad), self.assertRaises(RuntimeError):
                module.masked_error_sql(bad)

    def test_failed_or_mismatched_mutation_write_is_not_a_test_success(self):
        module = self.runner()
        for rc, read_rc, content in [(1,0,'wanted'), (0,1,'wanted'), (0,0,'stale')]:
            def docker(*args, text=None):
                return SimpleNamespace(returncode=rc if args[0]=='bash' else read_rc, stdout=content, stderr='synthetic failure')
            with self.subTest(write=rc,read=read_rc,content=content), self.assertRaises(RuntimeError):
                module.write_negative_sql(docker,'wanted')
        calls=[]
        def good_docker(*args,text=None):
            calls.append((args,text))
            return SimpleNamespace(returncode=0,stdout='wanted',stderr='')
        module.write_negative_sql(good_docker,'wanted')
        self.assertEqual(len(calls),2)


if __name__ == "__main__":
    unittest.main()
