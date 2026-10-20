from pathlib import Path
import subprocess, os, time, json, hashlib, re, signal
out = Path(__file__).resolve().parent
root = out.parents[4]
files = (out / "selection.txt").read_text().splitlines()
env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG", "LC_ALL") if key in os.environ}
env.update({"TMPDIR": "/private/tmp", "MIOON_ENABLE_LIVE_PROVIDER": "0"})
results = []
for index, name in enumerate(files):
    path = "tests/" + name
    limit = 240 if "real-media" in name else 180
    command = ["node", "--test", "--test-reporter=tap", path]
    started = time.monotonic()
    logfile = out / "logs" / (name + ".tap")
    timed_out = False
    with logfile.open("wb") as stream:
        process = subprocess.Popen(command, cwd=root, env=env, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=limit)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGTERM)
            try:
                code = process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                code = process.wait(timeout=10)
    data = logfile.read_bytes()
    raw = data.decode("utf-8", errors="replace")
    counts = {key: int(match.group(1)) for key in ("tests", "pass", "fail", "cancelled", "skipped", "todo") if (match := re.search(r"^# " + key + r" (\d+)$", raw, re.M))}
    record = {"file": path, "command": command, "timeoutSeconds": limit, "durationSeconds": round(time.monotonic()-started, 3), "exitCode": code, "timedOut": timed_out, "counts": counts, "log": str(logfile.relative_to(out)), "sha256": hashlib.sha256(data).hexdigest()}
    results.append(record)
    (out / "isolated-results.json").write_text(json.dumps({"scope": "Selected affected tests only; one process per file; TMPDIR=/private/tmp; no full-suite claim", "environment": {"TMPDIR": "/private/tmp", "MIOON_ENABLE_LIVE_PROVIDER": "0", "credentialEnvironmentForwarded": False}, "results": results}, indent=2, ensure_ascii=False)+"\n")
    print(json.dumps({"index": index+1, "total": len(files), **record}, ensure_ascii=False), flush=True)
