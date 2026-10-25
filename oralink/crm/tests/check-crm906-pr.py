#!/usr/bin/env python3
"""Fail-closed PR safety and PostgreSQL evidence checks; standard library only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
PROTECTED = {"supabase/tests/ol14/" + name for name in
             ("README.md", "fixture.sql", "run.py", "shadow.sql")}
IMMUTABLE = {
    "supabase/migrations/903_oralink_harden_is_account_member.sql":
        "40a06c18bcbf7da3a325ba69bd66ede290604a23b438cfb17093db45197a577a",
    "supabase/migrations/904_oralink_ol14_residual_hardening.sql":
        "b8f78bc55552934dcc3918903adc3798e724915b18a9768a9c8cb2f293a0c83c",
}
# Updating the regression suite requires an intentional update of this manifest.
EXPECTED_LABELS = (
    'pre904 historical high grant then STOP is revoked',
    'pre904 explicit later START is granted',
    'reproduce 904 historical regression',
    'reproduce 904 new STOP masked',
    'reproduce SQL setval privilege before906',
    'first migration fails safely: exhausted',
    'atomic rollback and sequence restart: exhausted',
    'first migration fails safely: inherited',
    'atomic rollback and sequence restart: inherited',
    'first migration fails safely: badindex',
    'atomic rollback and sequence restart: badindex',
    '906 restores legacy revoked decision',
    '906 preserves current revoked on ambiguous historical START',
    '906 preserves granted when both old orders agree',
    '906 preserves ordinary revoked',
    '906 preserves historical events and old seq',
    'new STOP beats historical high grant',
    'new explicit START may grant',
    'idempotence does not undo later START',
    'idempotence preserves every allocated order',
    'old sequence avoids historical collisions',
    'authenticated/1/setval denied/contact_consents_seq_seq',
    'authenticated/1/setval denied/contact_consents_decision_order_seq',
    'authenticated/1/legitimate consent INSERT',
    'authenticated/2/setval denied/contact_consents_seq_seq',
    'authenticated/2/setval denied/contact_consents_decision_order_seq',
    'authenticated/2/legitimate consent INSERT',
    'authenticated/3/setval denied/contact_consents_seq_seq',
    'authenticated/3/setval denied/contact_consents_decision_order_seq',
    'authenticated/3/legitimate consent INSERT',
    'authenticated/4/setval denied/contact_consents_seq_seq',
    'authenticated/4/setval denied/contact_consents_decision_order_seq',
    'anon/-/setval denied/contact_consents_seq_seq',
    'anon/-/setval denied/contact_consents_decision_order_seq',
    'service_role/-/setval denied/contact_consents_seq_seq',
    'service_role/-/setval denied/contact_consents_decision_order_seq',
    'viewer INSERT denied',
    'anon INSERT denied',
    'service legitimate INSERT remains possible',
    'caller supplied decision order ignored',
    'owner B sees real own consent rows',
    'owner B retains own STOP',
    'B cannot see account A consent rows',
    'A cannot see account B consent view',
    'cross account SELECT denied',
    'account forgery denied',
    'revoked member cannot INSERT into old account',
    'migration replay waits for active writer',
    'concurrent STOP preserved after migration replay',
    'service cannot rewrite decision_order',
    'inherited sequence UPDATE aborts corrective migration',
    'new order sequence nextval is private',
    'setval is not a public RPC function',
    'concurrent STOP inserted after opt-in wins despite earlier BEGIN',
    'full CRM903/904/906 suite and migration replays',
    'real SQL division-by-zero makes runner red',
    'masked psql error cannot produce green runner',
    'decision sequence configuration drift fails closed',
)
EXPECTED_SUMMARIES = {
    "== SUMMARY pass=80 fail=0", "== ORALINK SUMMARY pass=49 fail=0",
    "== IS_ACCOUNT_MEMBER SUMMARY pass=36 fail=0", "== OL14_RESIDUAL SUMMARY pass=88 fail=0",
}


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def validate_paths(paths):
    bad = []
    for value in paths:
        path = Path(value)
        name = path.name.lower()
        parts = {part.lower() for part in path.parts}
        if value in PROTECTED:
            bad.append(value)
        elif ((name.startswith(".env") and name not in {".env.example", ".env.local.example"})
              or name in {"id_rsa", "id_ed25519", "credentials.json", "secrets.json"}
              or path.suffix.lower() in {".pem", ".key", ".p12", ".pfx", ".kdbx", ".dump", ".sqlite", ".db", ".log", ".patch", ".pyc", ".bak"}
              or parts & {".ssh", ".aws", ".supabase", "reports", "node_modules", ".next", "__pycache__"}
              or value.startswith("supabase/.temp/")
              or re.search(r"(?:handover|preflight|local-report|fixes-report|results\.json)", name)):
            bad.append(value)
    if bad:
        raise ValueError("Protected or sensitive paths changed: " + ", ".join(bad))


def validate_results(data):
    if not isinstance(data, dict) or data.get("bootstrap_exit") != 0:
        raise ValueError("Database bootstrap did not succeed")
    rows = data.get("results")
    if not isinstance(rows, list) or len(rows) != len(EXPECTED_LABELS):
        raise ValueError("Missing regression assertions")
    if any(not isinstance(row, dict) or row.get("ok") is not True for row in rows):
        raise ValueError("A regression assertion failed")
    labels = [row.get("label") for row in rows]
    if any(not isinstance(label, str) for label in labels):
        raise ValueError("Malformed assertion label")
    if len(set(labels)) != len(labels) or set(labels) != set(EXPECTED_LABELS):
        raise ValueError("Missing, duplicate or unexpected assertion labels")
    full = data.get("full_suite")
    if not isinstance(full, dict) or full.get("exit") != 0:
        raise ValueError("Full CRM suite did not succeed")
    summaries = full.get("summaries")
    if not isinstance(summaries, list) or len(summaries) != 4 or set(summaries) != EXPECTED_SUMMARIES:
        raise ValueError("Full CRM suite evidence is incomplete")
    if data.get("negative_runner_exit") != 2 or data.get("masked_runner_exit") != 2:
        raise ValueError("SQL error mutations were not rejected")
    return len(rows)


def check_safety(base):
    if base:
        if not re.fullmatch(r"[0-9a-fA-F]{40}", base):
            raise ValueError("Base must be a full Git commit SHA")
    else:
        before = os.environ.get("BEFORE_SHA", "")
        pr_base = os.environ.get("BASE_SHA", "")
        if os.environ.get("EVENT_NAME") == "pull_request":
            if not re.fullmatch(r"[0-9a-fA-F]{40}", pr_base):
                raise ValueError("Missing PR base SHA")
            base = git("merge-base", pr_base, "HEAD").decode().strip()
        elif re.fullmatch(r"[0-9a-fA-F]{40}", before) and set(before) != {"0"}:
            base = before
        else:
            # First push of the branch: compare all inherited PR changes too.
            base = git("merge-base", "origin/main", "HEAD").decode().strip()
    git("cat-file", "-e", base + "^{commit}")
    subprocess.run(["git", "diff", "--no-ext-diff", "--check", base, "HEAD", "--"], cwd=ROOT, check=True)
    names = git("diff", "--no-renames", "--name-only", "-z", base, "HEAD", "--").split(b"\0")
    paths = [os.fsdecode(name) for name in names if name]
    validate_paths(paths)
    for name, expected in IMMUTABLE.items():
        if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != expected:
            raise ValueError("Published migration changed: " + name)
    for name in ("run-consent-order-906.py", "check-crm906-pr.py", "test-check-crm906-pr.py"):
        file = ROOT / "oralink/crm/tests" / name
        compile(file.read_bytes(), str(file), "exec")
    subprocess.run(["bash", "-n", "oralink/crm/tests/run-isolation-cases.sh"], cwd=ROOT, check=True)
    print(f"PASS: whitespace, protected/sensitive paths, immutable migrations and syntax ({len(paths)} changed paths)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base")
    parser.add_argument("--results", type=Path)
    args = parser.parse_args()
    try:
        if args.results:
            count = validate_results(json.loads(args.results.read_text()))
            print(f"PASS: {count} regression scenarios, full CRM suites and expected SQL failures")
        else:
            check_safety(args.base)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print("FAIL:", error)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
