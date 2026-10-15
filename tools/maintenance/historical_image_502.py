"""Pure, offline transition for the separately authorized three-record maintenance.
No network, production path, or database writes. The production driver must enforce
whitelist, hashes, native-502 evidence, zero settlement, quiescence and backups.
Never treat this transform as evidence that a supplier refunded a request.
"""
import copy
import json
import sys

CODE = "upstream_http_502_no_delivery"

def transition(receipt, outcome, journal):
    r, o, j = copy.deepcopy((receipt, outcome, journal))
    assert r["version"] == "published_image_receipt_v3"
    assert r["status"] == "unknown" and r["billing_state"] == "pending"
    assert len(r["units"]) == 1, "only the three authorized single-unit records"
    u = r["units"][0]
    n = r["expected_count"]
    assert n > 0 and u["output_count"] == n and u["index"] == 0 and u["output_offset"] == 0
    assert r["pending_count"] == n
    assert not any(r.get(k) for k in ("result_hash", "delivered_count", "failed_count", "http_failure"))
    assert u["status"] in ("pending", "unknown")
    assert not any(u.get(k) for k in ("result_hash", "actual_count", "http_failure", "error"))
    assert o["id"] == u["id"] and o["payload_hash"] == u["payload_hash"]
    assert o["state"] == "unknown" and not o.get("data") and not o.get("http_failure")
    assert j["task_id"] == r["task_id"] and j["owner"] == r["quote"]["owner"]["user_id"]
    assert j["keyRef"] == r["quote"]["owner"]["api_key_id"]
    assert j["status"] == "unknown" and j.get("billing_state", "pending") == "pending"
    assert j["quote"]["spec"] == r["quote"]["binding"]["spec"]
    assert not j.get("results") and not j.get("delivered_count") and not j.get("settled_price")
    # Historical response body and upstream request ID were NOT saved.
    # Empty response_hash means absent evidence, never a fabricated digest.
    proof = {"status": 502, "response_hash": "", "no_charge_final": True}
    o.update(state=CODE, http_failure=proof)
    u.update(status="failed", error=CODE, actual_count=0, http_failure=proof)
    r.update(status="failed", billing_state="not_charged", delivered_count=0, failed_count=n, pending_count=0)
    j.update(status="failed", billing_state="not_charged", delivered_count=0, failed_count=n, pending_count=0, failure_code=CODE)
    return {"receipt": r, "outcome": o, "journal": j}

if __name__ == "__main__":
    v = json.load(sys.stdin)
    print(json.dumps(transition(v["receipt"], v["outcome"], v["journal"]), ensure_ascii=False, separators=(",", ":")))
