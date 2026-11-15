"""Small live-backend probe; no model calls. Restart checks require --restarts.

BACKEND_TOKEN_FILE is required. Run on the Linux Docker host for --restarts.
Use a fresh OUTFILE; existing evidence is never overwritten.
"""

import argparse
import concurrent.futures
import json
import math
import os
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--restarts", action="store_true", help="stop/start the named engine and restart the API")
args = parser.parse_args()
token = Path(os.environ["BACKEND_TOKEN_FILE"]).read_text().strip()
origin = os.environ.get("BACKEND_URL", "http://127.0.0.1:8788").rstrip("/")
outfile = Path(os.environ.get("OUTFILE", "evaluation/load-results.json"))
if outfile.exists():
    raise SystemExit("OUTFILE already exists; preserve it and choose a new path")


def request(path, payload=None, authenticated=True):
    headers = {"Content-Type": "application/json"}
    if authenticated:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(origin + path, data=None if payload is None else json.dumps(payload).encode(), headers=headers)
    started = time.perf_counter()
    try:
        response = urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        value = json.load(response)
        return response.status, value, round((time.perf_counter() - started) * 1000, 2)


def ok(path, payload=None):
    status, value, _ = request(path, payload)
    assert status == 200, (path, status, value)
    return value


def expect(path, status, payload=None, authenticated=True):
    actual, _, _ = request(path, payload, authenticated)
    assert actual == status, (path, actual, status)
    return actual


def bootstrap(session):
    return ok("/api/bootstrap?sessionId=" + session)


prefix = "reliability-" + uuid.uuid4().hex[:12]
sessions = [prefix + "-" + str(i) for i in range(5)]
tasks = ["checkout deployment regression rollback", "dispatch deployment regression rollback", "search deployment regression rollback", "ledger deployment regression rollback"]
# Warm each identity in each session; measured requests do not create memories.
for session in sessions:
    for task in tasks:
        ok("/api/plan", {"task": task, "sessionId": session, "mode": "graph", "budget": 4096})

before = bootstrap(sessions[0])


def attempt(index):
    status, plan, elapsed = request("/api/plan", {"task": tasks[index % 4], "sessionId": sessions[index % 5], "mode": "graph", "budget": 4096})
    complete = status == 200 and not plan.get("abstained", True) and all(all(name in {tool["name"] for tool in plan["tools"]} for name in tool["requires"]) for tool in plan["tools"])
    return {"index": index, "session": index % 5, "status": status, "complete": complete, "roundTripMs": elapsed, "schemaBytes": plan.get("schemaBytes"), "graphVersion": plan.get("receipt", {}).get("graphVersion")}


start = time.perf_counter()
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
    cases = list(pool.map(attempt, range(20)))
elapsed = round((time.perf_counter() - start) * 1000, 2)
after = bootstrap(sessions[0])
assert before["weights"] == after["weights"]
assert before["graphVersion"] == after["graphVersion"]
assert before["budget"] == after["budget"]
assert all(case["complete"] and case["graphVersion"] == before["graphVersion"] for case in cases), cases

checks = {
    "unauthenticatedBackend": expect("/api/health", 401, authenticated=False),
    "invalidPlan": expect("/api/plan", 400, {"task": "", "sessionId": sessions[0]}),
    "unknownRoute": expect("/api/missing", 404),
}
recovery = {"tested": False}
if args.restarts:
    # Create one genuine, independently inspectable sandbox execution and update.
    plan = ok("/api/plan", {"task": tasks[0], "sessionId": sessions[0], "mode": "graph"})
    service = plan["service"]
    calls = [
        {"name": "service_metrics", "arguments": {"serviceId": service["id"], "resourceId": service["resourceId"]}},
        {"name": "deployments_list", "arguments": {"serviceId": service["id"]}},
        {"name": "deployment_details", "arguments": {"serviceId": service["id"], "deploymentId": service["latestDeploymentId"]}},
    ]
    run = ok("/internal/execute", {"planId": plan["id"], "sessionId": sessions[0], "calls": calls, "usage": {"promptTokens": None, "completionTokens": None, "neurons": None}, "requestedModel": "recovery-fixed-policy", "returnedModel": "recovery-fixed-policy"})
    assert run["success"] is True
    feedback = {"runId": run["id"], "sessionId": sessions[0], "correct": run["success"]}
    ok("/api/feedback", feedback)
    checks["duplicateBeforeRestart"] = expect("/api/feedback", 409, feedback)
    protected = []
    for name in ("resultsdetail.json", "ambiguity-resultsdetail.json"):
        path = Path("evaluation") / name
        if path.exists():
            detail = json.loads(path.read_text())
            heldout = next(case["run"] for case in detail["cases"] if case["split"] == "heldout" and case["run"])
            payload = {"sessionId": detail["sessionId"], "runId": heldout["id"], "correct": False}
            expect("/api/feedback", 403, payload)
            protected.append((payload, bootstrap(detail["sessionId"])["weights"]))
    persisted = bootstrap(sessions[0])
    engine_name = os.environ.get("ENGINE_CONTAINER", "incident-context-hydra")
    api_name = os.environ.get("API_CONTAINER", "incident-context-api")
    assert all(name and not name.startswith("-") for name in (engine_name, api_name))
    stopped = False
    try:
        subprocess.run(["docker", "stop", engine_name], check=True, stdout=subprocess.DEVNULL)
        stopped = True
        health_status = expect("/api/health", 503)
        plan_status = expect("/api/plan", 503, {"task": tasks[0], "sessionId": sessions[0]})
    finally:
        if stopped:
            subprocess.run(["docker", "start", engine_name], check=True, stdout=subprocess.DEVNULL)
    ready_start = time.perf_counter()
    for _ in range(40):
        if request("/api/health")[0] == 200:
            break
        time.sleep(0.5)
    else:
        raise RuntimeError("Engine failed to recover")
    engine_ready_ms = round((time.perf_counter() - ready_start) * 1000, 2)
    engine_after = bootstrap(sessions[0])
    assert persisted["weights"] == engine_after["weights"]
    assert persisted["graphVersion"] == engine_after["graphVersion"]
    assert persisted["budget"] == engine_after["budget"]
    subprocess.run(["docker", "restart", api_name], check=True, stdout=subprocess.DEVNULL)
    ready_start = time.perf_counter()
    for _ in range(40):
        try:
            if request("/api/health")[0] == 200:
                break
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.5)
    else:
        raise RuntimeError("Backend failed to recover")
    api_ready_ms = round((time.perf_counter() - ready_start) * 1000, 2)
    restored = bootstrap(sessions[0])
    assert persisted["weights"] == restored["weights"]
    assert persisted["graphVersion"] == restored["graphVersion"]
    assert persisted["budget"] == restored["budget"]
    checks["duplicateAfterRestart"] = expect("/api/feedback", 409, feedback)
    for payload, weights in protected:
        expect("/api/feedback", 403, payload)
        assert bootstrap(payload["sessionId"])["weights"] == weights
    recovery = {"tested": True, "engineDownHealthStatus": health_status, "engineDownPlanStatus": plan_status, "engineReadyAfterStartMs": engine_ready_ms, "apiReadyAfterRestartMs": api_ready_ms, "weightsPreserved": True, "budgetPreserved": True, "graphVersionPreserved": True, "protectedBenchmarks": len(protected), "protectedFeedbackStatus": 403, "duplicateFeedbackStatus": 409}

timings = sorted(case["roundTripMs"] for case in cases)
report = {"status": "complete", "generatedAt": datetime.now(timezone.utc).isoformat(), "scope": "Loopback backend HTTP planning, real HydraDB, five warmed sessions, 20 requests, 12-tool catalog; no model calls or sustained/public-Internet load claim.", "concurrency": 5, "requests": 20, "errors": sum(not case["complete"] for case in cases), "wallMs": elapsed, "p50Ms": timings[math.ceil(len(timings) * .5) - 1], "p95Ms": timings[math.ceil(len(timings) * .95) - 1], "weightsUnchangedDuringLoad": True, "graphVersionUnchangedDuringLoad": True, "modelBudget": after["budget"], "checks": checks, "recovery": recovery, "cases": cases}
outfile.parent.mkdir(parents=True, exist_ok=True)
with outfile.open("x") as output:
    json.dump(report, output, indent=2)
print(json.dumps({key: value for key, value in report.items() if key != "cases"}, indent=2))
