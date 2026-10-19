#!/usr/bin/env python3
"""Stdlib-only Go probe for the persisted/request save-receipt boundary.

Reads exact data declarations from immutable old Git source and the current
working tree. It creates two disposable tiny Go modules outside the repository,
never imports/builds the application, uses no network/DB, and removes its scratch
files. The only persistent output is this script's sibling result JSON.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


OLD_REF = "8ad2eff39ff5bf6bfd07563041556f4a4c42d9a1"
TYPE_FILES = (
    "backend/internal/mediaworkbench/media.go",
    "backend/internal/mediaworkbench/adapter.go",
    "backend/internal/mediaworkbench/lifecycle.go",
)
PLAN_FILE = "backend/internal/imageplan/json.go"
HANDLER_FILE = "backend/internal/handler/admin/media_workbench_handler.go"
REPO_FILE = "backend/internal/repository/media_config_repo.go"
ALL_FILES = (*TYPE_FILES, PLAN_FILE, HANDLER_FILE, REPO_FILE)


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def run(command: list[str], cwd: Path, **kwargs: object) -> subprocess.CompletedProcess:
    return subprocess.run(command, cwd=cwd, check=True, capture_output=True, **kwargs)


def normalized(raw: bytes) -> str:
    return raw.decode("utf-8-sig").replace("\r\n", "\n")


def declarations(sources: dict[str, str]) -> dict[str, str]:
    """Copy complete top-level declarations; no fields or type names are renamed.

    The selected source data types use ordinary single-line aliases and struct
    declarations with balanced braces. Tags/comments have no structural braces.
    This is intentionally a small probe, not a general Go source transformer.
    """
    result: dict[str, str] = {}
    for source in sources.values():
        for match in re.finditer(r"^type\s+(\w+)\s+", source, re.MULTILINE):
            end = source.find("\n", match.end())
            line = source[match.start():end]
            if "{" in line:
                depth = 0
                position = source.find("{", match.end())
                while position < len(source):
                    if source[position] == "{":
                        depth += 1
                    elif source[position] == "}":
                        depth -= 1
                        if depth == 0:
                            end = position + 1
                            break
                    position += 1
                else:
                    raise RuntimeError("Unbalanced declaration: " + match.group(1))
            name = match.group(1)
            if name in result:
                raise RuntimeError("Duplicate declaration: " + name)
            result[name] = source[match.start():end]
    return result


def select_types(all_types: dict[str, str], roots: list[str]) -> tuple[str, list[str]]:
    pending = list(roots)
    selected: set[str] = set()
    while pending:
        name = pending.pop()
        if name in selected:
            continue
        selected.add(name)
        source = re.sub(r"//[^\n]*|`[^`]*`", "", all_types[name])
        names = set(re.findall(r"\b[A-Za-z_]\w*\b", source))
        pending.extend(names.intersection(all_types).difference(selected))
    names = sorted(selected)
    return "\n\n".join(all_types[name] for name in names), names


def request_type(handler: str) -> str:
    body = handler[handler.index("func (h *MediaWorkbenchHandler) SaveDraft"):]
    match = re.search(r"var in struct \{.*?\n\t\}", body, re.DOTALL)
    if match is None:
        raise RuntimeError("Cannot locate the exact SaveDraft input structure")
    # Removing the package qualifier changes namespacing only. No JSON tag,
    # field name/type or input field is changed.
    return match.group(0).replace("var in struct", "type SaveRequest struct").replace("mediaworkbench.", "")


def make_draft(source: str) -> str:
    match = re.search(r"func makeDraft\(.*?\n\}", source, re.DOTALL)
    if match is None:
        raise RuntimeError("Cannot locate makeDraft")
    return match.group(0)


MAIN = r'''
type Result struct {
    Name string `json:"name"`
    Expected string `json:"expected"`
    Observed string `json:"observed"`
    Pass bool `json:"pass"`
}
var results []Result
func check(name, expected string, pass bool, observed string) {
    results=append(results, Result{Name:name,Expected:expected,Observed:observed,Pass:pass})
}
func strict(body []byte, out any) error {
    // Matches the repository/request production contract: strict decoding plus
    // exactly one JSON document. HTTP size limits and SQL scanning are outside
    // this deliberately bounded source-level probe.
    decoder:=json.NewDecoder(bytes.NewReader(body))
    decoder.DisallowUnknownFields()
    if err:=decoder.Decode(out);err!=nil{return err}
    if err:=decoder.Decode(new(any));err!=io.EOF{return fmt.Errorf("trailing JSON")}
    return nil
}
func decodeCheck(name string, body []byte, out any, fragment string) {
    err:=strict(body,out)
    observed:="success";if err!=nil{observed=err.Error()}
    if fragment==""{check(name,"success",err==nil,observed)}else{
        check(name,fragment,err!=nil && strings.Contains(observed,fragment),observed)
    }
}
func main(){
    // Synthetic configuration only. No real Account, credential, price,
    // supplier, user, key, published order or receipt is read from a database.
    oldJSON:=[]byte(`{"schema_version":1,"record_version":8,"media_types":["image"],"adapter_bindings":{},"sales":{"enabled":false,"updated_at":"2026-10-19T00:00:00Z"},"draft":{"revision":"mwd_fixture","based_on_published_revision":"","updated_at":"2026-10-19T00:00:00Z","products":[{"product_id":"fixture-product","media_type":"image","site_model":"fixture-site","upstream_model":"fixture-upstream","display_name":"fixture","enabled":false,"pricing_rules":[],"adapter_config":{"size_mappings":[]}}]},"validation":{"draft_revision":"mwd_fixture","status":"UNKNOWN"},"published":null,"procurement":{"entries":[]}}`)
    var object map[string]any
    if err:=json.Unmarshal(oldJSON,&object);err!=nil{panic(err)}
    draft:=object["draft"].(map[string]any)
    draft["save_receipt"]=map[string]any{"submission_id":"550e8400-e29b-41d4-a716-446655440000","base_record_version":7,"draft_revision":"mwd_fixture"}
    receiptJSON,_:=json.Marshal(object)
    draft["save_receipt"]=nil;nullJSON,_:=json.Marshal(object)
    delete(draft,"save_receipt");draft["unknown_extension"]=true;unknownJSON,_:=json.Marshal(object)
    var cfg Config
    decodeCheck("persisted_legacy_config",oldJSON,&cfg,"")
    receiptError:="";if !expectReceipt{receiptError=`unknown field "save_receipt"`}
    decodeCheck("persisted_receipt_config",receiptJSON,&cfg,receiptError)
    decodeCheck("persisted_null_receipt_config",nullJSON,&cfg,receiptError)
    decodeCheck("persisted_unrelated_unknown_field",unknownJSON,&cfg,`unknown field "unknown_extension"`)
    oldRequest:=[]byte(`{"expected_record_version":7,"draft":{"products":[]}}`)
    newRequest:=[]byte(`{"expected_record_version":7,"submission_id":"550e8400-e29b-41d4-a716-446655440000","draft":{"products":[]}}`)
    nestedReceipt:=[]byte(`{"expected_record_version":7,"draft":{"save_receipt":{"submission_id":"forged"},"products":[]}}`)
    var request SaveRequest
    decodeCheck("http_legacy_request",oldRequest,&request,"")
    requestError:="";if !expectReceipt{requestError=`unknown field "submission_id"`}
    decodeCheck("http_receipt_request",newRequest,&request,requestError)
    decodeCheck("http_forged_nested_receipt",nestedReceipt,&request,`unknown field "save_receipt"`)
    decodeCheck("http_trailing_json",append(oldRequest,[]byte(` {}`)...),&request,"trailing JSON")
    var loose Config
    if err:=json.Unmarshal(receiptJSON,&loose);err!=nil{panic(err)}
    roundTrip,_:=json.Marshal(loose)
    contains:=bytes.Contains(roundTrip,[]byte(`"save_receipt"`))
    expected:="drops receipt";if expectReceipt{expected="preserves receipt"}
    observed:="drops receipt";if contains{observed="preserves receipt"}
    check("loose_decode_then_typed_marshal",expected,contains==expectReceipt,observed)
    if expectReceipt{
        var typed Config
        if err:=strict(receiptJSON,&typed);err!=nil{panic(err)}
        before,_:=json.Marshal(typed.Draft)
        // This proves the exact typed DTO round-trip, not an HTTP/SQL mutation.
        typed.Sales.Enabled=false;typed.RecordVersion++
        body,_:=json.Marshal(typed);var reread Config
        if err:=strict(body,&reread);err!=nil{panic(err)}
        after,_:=json.Marshal(reread.Draft)
        check("typed_non_draft_roundtrip","draft and receipt unchanged",bytes.Equal(before,after),string(after))
    }
    // This exact makeDraft function deliberately builds a new draft identity.
    // A legacy no-ID write is not an old receipt for its replacement draft.
    next:=makeDraft(DraftInput{Products:cfg.Draft.Products},"",time.Date(2026,10,19,0,0,1,0,time.UTC))
    nextJSON,_:=json.Marshal(next)
    hasReceipt:=bytes.Contains(nextJSON,[]byte(`"save_receipt"`))
    check("legacy_makeDraft_starts_without_receipt","no receipt on replacement draft",!hasReceipt,string(nextJSON))
    pass:=true;for _,result:=range results{if !result.Pass{pass=false}}
    output:=map[string]any{"mode":probeMode,"pass":pass,"fixture_sha256":fmt.Sprintf("%x",sha256.Sum256(receiptJSON)),"cases":results}
    body,_:=json.MarshalIndent(output,"","  ");fmt.Println(string(body))
    if !pass{os.Exit(1)}
}
'''


def build_probe(source: dict[str, str], mode: str) -> tuple[str, str, dict]:
    # Bind the helper to the inspected production decoder contract. A future
    # reader change must not silently run this historical strict-reader probe.
    for marker in ("decoder.DisallowUnknownFields()", "decoder.Decode(&a.Config)", "decoder.Decode(new(any))"):
        if marker not in source[REPO_FILE]:
            raise RuntimeError("Production repository strict decoder changed: " + marker)
    for marker in ("d.DisallowUnknownFields()", "d.Decode(v)", "d.Decode(new(any))"):
        if marker not in source[HANDLER_FILE]:
            raise RuntimeError("Production HTTP strict decoder changed: " + marker)
    types, names = select_types(declarations({p: source[p] for p in TYPE_FILES}), ["Config", "DraftInput"])
    plan, plan_names = select_types(declarations({PLAN_FILE: source[PLAN_FILE]}), ["Plan"])
    request = request_type(source[HANDLER_FILE])
    helper = make_draft(source[TYPE_FILES[0]])
    main = (
        'package main\nimport("bytes";"crypto/sha256";"encoding/json";"fmt";"io";"os";"strings";"time";"compatprobe/imageplan")\n'
        + 'const expectReceipt=' + ("true" if mode == "current" else "false") + '\n'
        + 'const probeMode=' + json.dumps(mode) + '\n'
        + types + '\n' + request + '\n' + helper + '\n' + MAIN
    )
    plan_source = "package imageplan\n" + plan + "\n"
    return main, plan_source, {
        "production_repository_strict_decoder_asserted": True,
        "production_handler_strict_decoder_asserted": True,
        "copied_data_types": names,
        "copied_imageplan_types": plan_names,
        "copied_type_declarations_sha256": digest(types.encode()),
        "copied_request_declaration_sha256": digest(request.encode()),
        "copied_makeDraft_sha256": digest(helper.encode()),
        "generated_main_sha256": digest(main.encode()),
        "generated_imageplan_sha256": digest(plan_source.encode()),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[5])
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("probe-results.json"))
    parser.add_argument("--scratch-parent", type=Path, default=Path("D:/"))
    args = parser.parse_args()
    repo = args.repo.resolve()
    old_raw = {p: run(["git", "show", OLD_REF + ":" + p], repo).stdout for p in ALL_FILES}
    current_raw = {p: (repo / p).read_bytes() for p in ALL_FILES}
    report: dict = {
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "scope": "source_schema_probe_only_not_application_db_http_or_rollback_artifact_validation",
        "old_git_ref": OLD_REF,
        "working_tree_head": run(["git", "rev-parse", "HEAD"], repo).stdout.decode().strip(),
        "go_version": run(["go", "version"], repo).stdout.decode().strip(),
        "sources": [],
        "runs": [],
    }
    for path in ALL_FILES:
        report["sources"].append({
            "path": path,
            "old_git_blob": run(["git", "rev-parse", OLD_REF + ":" + path], repo).stdout.decode().strip(),
            "old_raw_sha256": digest(old_raw[path]),
            "old_normalized_sha256": digest(normalized(old_raw[path]).encode()),
            "current_raw_sha256": digest(current_raw[path]),
            "current_normalized_sha256": digest(normalized(current_raw[path]).encode()),
        })
    scratch = Path(tempfile.mkdtemp(prefix="receipt-compat-review-", dir=args.scratch_parent)).resolve()
    try:
        env = dict(os.environ)
        env["GOTOOLCHAIN"] = "local"  # Never download an application toolchain.
        env["GOWORK"] = "off"
        env["GOPROXY"] = "off"       # Test modules use standard library only.
        for mode, raw in (("old", old_raw), ("current", current_raw)):
            main_source, plan_source, metadata = build_probe({p: normalized(raw[p]) for p in ALL_FILES}, mode)
            folder = scratch / mode
            (folder / "imageplan").mkdir(parents=True)
            (folder / "go.mod").write_text("module compatprobe\n\ngo 1.27.0\n", encoding="utf-8")
            (folder / "main.go").write_text(main_source, encoding="utf-8")
            (folder / "imageplan" / "types.go").write_text(plan_source, encoding="utf-8")
            completed = subprocess.run(["go", "run", "."], cwd=folder, env=env, capture_output=True, text=True, timeout=90)
            run_result = {"mode": mode, "exit_code": completed.returncode, **metadata}
            if completed.stdout.strip():
                try:
                    run_result["result"] = json.loads(completed.stdout)
                except json.JSONDecodeError:
                    run_result["stdout"] = completed.stdout
            if completed.stderr:
                run_result["stderr"] = completed.stderr
            report["runs"].append(run_result)
    finally:
        # Only remove the exact directory created by this run, after resolving
        # and checking that it remains directly under the explicit scratch root.
        if scratch.parent != args.scratch_parent.resolve() or not scratch.name.startswith("receipt-compat-review-"):
            raise RuntimeError("Refusing cleanup outside created scratch scope")
        shutil.rmtree(scratch)
        report["scratch_removed"] = not scratch.exists()
    report["pass"] = all(item["exit_code"] == 0 and item.get("result", {}).get("pass") is True for item in report["runs"])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output.resolve()), "pass": report["pass"], "go_version": report["go_version"], "runs": [{"mode": item["mode"], "exit_code": item["exit_code"], "cases": len(item.get("result", {}).get("cases", []))} for item in report["runs"]], "scratch_removed": report["scratch_removed"]}, ensure_ascii=False))
    if not report["pass"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
