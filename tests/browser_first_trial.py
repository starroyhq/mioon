"""Fresh browser-only first-use acceptance. Integrated with syntax checks only.

Run only after the caller builds the current source. All creative mutations use
the real UI; HTTP is restricted to reads and media verification. No seeded DB,
DOM/app-state injection, provider keys, live generation or native Electron claim.
Existing historical harnesses/evidence are deliberately left untouched.
This is a portable human-run Playwright artifact, not an executed acceptance in
the current CUA-only agent environment. Agents must use the supported CUA surface
when browser policy forbids launching Playwright or mutating page evaluation.

python3 tests/browser_first_trial.py --repo "$PWD" --out /new/private/evidence-dir
Requires installed Python Playwright + Chromium, Node >=24 and FFmpeg/ffprobe.
The output directory must not exist. It retains a private synthetic workspace.
"""
import argparse
import copy
import hashlib
import json
import os
import pathlib
import platform
import re
import secrets
import shutil
import socket
import subprocess
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from playwright.sync_api import expect, sync_playwright


def check(value, message):
    if not value:
        raise AssertionError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Unexpected local-service redirect")


class Trial:
    def __init__(self, args):
        self.repo = pathlib.Path(args.repo).resolve(strict=True)
        self.out = pathlib.Path(args.out).absolute()
        check(self.out.parent.resolve(strict=True) == self.out.parent,
              "Use a canonical output parent, not a symlink/alias")
        self.out.mkdir(mode=0o700)  # Never merge/overwrite an earlier run.
        self.workspace = self.out / "workspace"  # Backend creates a private root.
        self.image = self.repo / "examples/synthetic/reference.png"
        check(self.image.is_file(), "Missing checked-in synthetic reference")
        check((self.repo / "apps/web/dist/index.html").is_file(), "Build web first")
        self.node = args.node or shutil.which("node")
        self.ffmpeg = args.ffmpeg or os.environ.get("MIOON_FFMPEG_PATH") or shutil.which("ffmpeg")
        self.ffprobe = args.ffprobe or os.environ.get("MIOON_FFPROBE_PATH") or shutil.which("ffprobe")
        check(self.node and self.ffmpeg and self.ffprobe, "Node/FFmpeg/ffprobe required")
        self.chromium = args.chromium or shutil.which("chromium")
        self.headed = args.headed
        self.page = self.browser = self.context = self.process = self.log_handle = None
        self.pid = None
        self.base = self.token = None
        self.lifetime = 0
        self.requests, self.page_errors, self.blocked_requests = [], [], []
        self.report = {
            "status": "running", "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "harnessSha256": digest(pathlib.Path(__file__).read_bytes()),
            "platform": {"system": platform.system(), "machine": platform.machine()},
            "scope": "Real built Web UI + local backend, synthetic media, mock provider only",
            "nativeElectron": "not_run", "macNative": "not_verified", "nativeSaveAs": "not_verified",
            "limits": ["Browser download is not Electron native Save As acceptance.",
                       "Backend and browser restart is not an Electron application restart.",
                       "No live-provider calls, keys, external uploads, packaging or signing.",
                       "Network observation covers browser requests, not a host packet capture.",
                       "Fresh build is a caller prerequisite; manifests prove run inputs stayed unchanged."],
            "steps": [], "lifetimes": [], "screenshots": [],
        }
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.before_manifest = self.manifest()
        write_json(self.out / "source-build-before.json", self.before_manifest)
        self.save()

    def manifest(self):
        paths = [self.repo / name for name in ("package.json", "pnpm-lock.yaml")]
        for root in ("apps/web/src", "apps/web/dist", "apps/server/src", "packages/business/src", "packages/contracts/src"):
            paths.extend(p for p in (self.repo / root).rglob("*") if p.is_file())
        return {str(p.relative_to(self.repo)): digest(p.read_bytes()) for p in sorted(paths)}

    def save(self):
        self.report.update(pageErrors=self.page_errors, blockedBrowserRequests=self.blocked_requests)
        write_json(self.out / "report.json", self.report)
        write_json(self.out / "browser-request-summary.json", self.requests)

    def record(self, number, label, **evidence):
        self.report["steps"].append({"step": number, "name": label, "passed": True, **evidence})
        self.save()
        print(f"PASS {number}: {label}", flush=True)

    def capture(self, name):
        self.page.screenshot(path=str(self.out / name), full_page=True)
        self.report["screenshots"].append(name)
        self.save()

    def wait(self, fn, predicate, label, seconds=30):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            value = fn()
            if predicate(value):
                return value
            if self.page and not self.page.is_closed():
                self.page.wait_for_timeout(150)
            else:
                time.sleep(0.15)
        raise AssertionError("Timed out: " + label)

    def http(self, route, body=None, authenticated=True):
        check(route.startswith("/") and not route.startswith("//"), "Relative local route required")
        headers = {"Content-Type": "application/json"}
        if authenticated:
            headers["Authorization"] = "Bearer " + self.token
        request = urllib.request.Request(self.base + route, data=None if body is None else json.dumps(body).encode(), headers=headers)
        with self.opener.open(request, timeout=20) as response:
            payload = json.load(response)
        if route == "/health":
            return payload
        check(payload.get("ok") is True, "Read-only API rejected: " + route)
        return payload["data"]

    def rpc(self, operation, data=None):
        check(operation in {"provider.list", "project.list", "project.get"}, "Harness RPC must be read-only")
        return self.http("/api/rpc", {"operation": operation, "input": data or {}})

    def state(self):
        return self.rpc("project.get", {"projectId": self.pid})

    def tasks(self):
        query = urllib.parse.urlencode({"projectId": self.pid, "pendingOnly": "false", "limit": "50"})
        result = self.http("/api/tasks?" + query)
        check(result["nextCursor"] is None, "Small trial unexpectedly exceeded task page")
        return result

    def settled_tasks(self, expected_count=None):
        return self.wait(self.tasks, lambda r: (expected_count is None or len(r["items"]) == expected_count)
                         and all(t["status"] == "applied" and t["acknowledged"] for t in r["items"]),
                         "all local edits acknowledged")

    def media_hash(self, asset_id):
        check(re.fullmatch(r"[0-9a-f-]{36}", asset_id), "Invalid managed media ID")
        request = urllib.request.Request(self.base + "/media/" + asset_id,
                                         headers={"Authorization": "Bearer " + self.token})
        with self.opener.open(request, timeout=30) as response:
            data = response.read(32 * 1024 * 1024 + 1)
        check(len(data) <= 32 * 1024 * 1024, "Unexpectedly large trial media")
        return digest(data)

    def start_server(self):
        check(self.process is None, "Previous backend still owned")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self.lifetime += 1
        self.base, self.token = f"http://127.0.0.1:{port}", secrets.token_urlsafe(32)
        # Do not inherit provider credentials, proxy settings or Node injection flags.
        names = {"PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TZ"}
        env = {key: value for key, value in os.environ.items() if key in names}
        env.update(PORT=str(port), MIOON_DATA_DIR=str(self.workspace), MIOON_TOKEN=self.token,
                   MIOON_ENABLE_LIVE_PROVIDER="0", MIOON_FFMPEG_PATH=str(self.ffmpeg), MIOON_FFPROBE_PATH=str(self.ffprobe))
        self.log_handle = (self.out / f"backend-{self.lifetime}.log").open("w")
        self.process = subprocess.Popen([self.node, "apps/server/src/cli.mjs"], cwd=self.repo, env=env,
                                        stdout=self.log_handle, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            check(self.process.poll() is None, "Backend exited before readiness; see its log")
            try:
                self.http("/health", authenticated=False)
                self.report["lifetimes"].append({"number": self.lifetime, "backendPid": self.process.pid, "origin": self.base})
                return
            except (OSError, urllib.error.URLError):
                time.sleep(0.15)
        raise AssertionError("Backend readiness timeout")

    def stop_server(self):
        if self.process is None:
            return
        process = self.process
        try:
            process.terminate()
            try:
                code = process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()  # Only the exact owned test backend, never a guessed PID.
                process.wait(timeout=10)
                raise AssertionError("Backend required forced termination")
            check(code == 0, f"Backend normal shutdown returned {code}")
        finally:
            self.process = None
            self.log_handle.close()
            self.log_handle = None

    def launch_browser(self, playwright):
        launch = {"headless": not self.headed, "chromium_sandbox": True}
        if self.chromium:
            launch["executable_path"] = self.chromium
        self.browser = playwright.chromium.launch(**launch)
        self.report["browserVersion"] = self.browser.version
        self.context = self.browser.new_context(viewport={"width": 1600, "height": 1050}, accept_downloads=True)
        self.context.route("**/*", self.guard_request)
        self.page = self.context.new_page()
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        self.page.set_default_timeout(15000)

    def guard_request(self, route):
        request = route.request
        parsed = urllib.parse.urlsplit(request.url)
        if parsed.scheme in ("http", "https") and f"{parsed.scheme}://{parsed.netloc}" != self.base:
            self.blocked_requests.append({"origin": f"{parsed.scheme}://{parsed.netloc}", "reason": "non-local browser request"})
            route.abort("blockedbyclient")
            return
        if request.method == "POST" and parsed.path != "/api/login":
            body = request.post_data_json or {}
            operation = body.get("operation")
            input_data = body.get("input", {})
            # Evidence excludes import bytes, headers, auth and complete prompt bodies.
            summary = {"lifetime": self.lifetime, "path": parsed.path, "operation": operation,
                       "requestId": input_data.get("requestId"), "providerId": input_data.get("providerId")}
            self.requests.append(summary)
            if operation == "generation.submit" and input_data.get("providerId") != "mock":
                self.blocked_requests.append({"reason": "non-mock generation attempt"})
                route.abort("blockedbyclient")
                return
        route.continue_()

    def login(self, project=None):
        self.page.goto(self.base + ("/?project=" + project if project else "/"))
        self.page.get_by_label("访问令牌", exact=True).fill(self.token)
        self.page.get_by_role("button", name="进入工作台", exact=True).click()
        expect(self.page.get_by_test_id("workbench")).to_be_visible()
        expect(self.page.get_by_test_id("workspace-loading")).to_have_count(0)

    def close_tasks(self):
        button = self.page.get_by_role("button", name="关闭任务中心", exact=True)
        if button.is_visible():
            button.click()

    def choose(self, testid, label):
        self.page.get_by_test_id(testid).click()
        self.page.get_by_role("option", name=label, exact=True).click()

    def shot_settings(self, sid):
        self.close_tasks()
        self.page.get_by_test_id("workspace-canvas").click()
        self.page.get_by_test_id("shot-node-" + sid).locator(".node-header").click()
        self.page.get_by_role("tab", name="创作参数", exact=True).click()
        expect(self.page.get_by_test_id("shot-inspector")).to_be_visible()

    def playback(self, video, seek=False):
        expect(video).to_be_visible()
        video.evaluate("v => { v.muted = true; return v.play(); }")
        value = self.wait(lambda: video.evaluate("v => ({time:v.currentTime,width:v.videoWidth,height:v.videoHeight,error:v.error&&v.error.code})"),
                          lambda v: v["time"] > 0.15 and v["width"] > 0, "actual video decode/playback")
        check(not value["error"], "Browser video decode error")
        video.evaluate("v => v.pause()")
        if seek:
            self.page.get_by_test_id("timeline-playhead").fill("15")
            self.page.get_by_test_id("timeline-playhead").press("Tab")
            self.wait(lambda: video.evaluate("v => ({time:v.currentTime,seeking:v.seeking})"),
                      lambda v: abs(v["time"] - 0.5) < 0.09 and not v["seeking"], "timeline seek to frame 15")
        return value

    def render_preview(self):
        existing = {e["id"] for e in self.state()["exports"]}
        self.page.get_by_test_id("timeline-render-preview").click()
        state = self.wait(self.state, lambda s: any(e["id"] not in existing and e["status"] == "succeeded" for e in s["exports"]),
                          "preview render", 120)
        added = [e for e in state["exports"] if e["id"] not in existing]
        check(len(added) == 1 and added[0]["purpose"] == "preview", "Exactly one preview expected")
        self.playback(self.page.get_by_test_id("timeline-preview-video"))
        return added[0]

    def close_browser(self):
        if self.browser:
            self.browser.close()
        self.page = self.context = self.browser = None

    def run(self, playwright):
        self.start_server()
        self.launch_browser(playwright)
        self.login()
        check(self.rpc("project.list") == [], "Fresh trial workspace was not empty")
        caps = self.rpc("provider.list")
        mock = next(p for p in caps if p["id"] == "mock")
        check(mock["mock"] and mock["status"] == "available", "Local mock unavailable")
        check(all(not p.get("enabled") for p in caps if not p.get("mock")), "A live provider was enabled")
        self.page.get_by_test_id("empty-create-project").click()
        self.page.get_by_test_id("project-name").fill("首次试用 · 本地模拟验收")
        self.page.get_by_test_id("create-project-submit").click()
        projects = self.wait(lambda: self.rpc("project.list"), lambda p: len(p) == 1, "one new project")
        self.pid = projects[0]["id"]
        expect(self.page.get_by_test_id("project-switcher")).to_contain_text("首次试用")
        self.record(1, "Fresh source service and project open", projectId=self.pid)

        self.page.get_by_test_id("asset-upload").set_input_files(str(self.image))
        state = self.wait(self.state, lambda s: len(s["assets"]) == 1, "PNG import")
        image = state["assets"][0]
        original_hash = digest(self.image.read_bytes())
        check(image["mimeType"] == "image/png" and image["sha256"] == original_hash, "Imported PNG identity mismatch")
        expect(self.page.get_by_test_id("asset-card-" + image["id"])).to_be_visible()
        check(self.media_hash(image["id"]) == original_hash, "Imported bytes differ")
        self.record(2, "Local PNG imported without changing its bytes", assetId=image["id"], sha256=original_hash)

        self.page.get_by_test_id("add-shot").click()
        state = self.wait(self.state, lambda s: len(s["shots"]) == 1, "one shot")
        sid = state["shots"][0]["id"]
        expect(self.page.get_by_test_id("shot-prompt")).to_be_visible()
        self.page.get_by_test_id("shot-prompt").fill("原创几何测试图，缓慢移动。仅验证本地模拟流程。V1")
        self.page.get_by_test_id("save-shot").click()
        expect(self.page.get_by_test_id("save-shot")).to_have_count(0)
        self.page.get_by_test_id("asset-to-canvas-" + image["id"]).click()
        state = self.wait(self.state, lambda s: len(s["nodes"]) == 1, "image node")
        node = state["nodes"][0]
        self.choose("attach-reference-target", state["shots"][0]["title"])
        expect(self.page.get_by_test_id("attach-reference")).to_be_enabled()
        self.page.get_by_test_id("attach-reference").click()
        state = self.wait(self.state, lambda s: len(s["edges"]) == 1, "typed first-frame reference")
        edge = state["edges"][0]
        check(edge["kind"] == "reference" and edge["role"] == "first_frame" and edge["sourceAssetId"] == image["id"], "Wrong reference binding")
        self.settled_tasks(1)
        self.shot_settings(sid)
        expect(self.page.get_by_test_id("bound-reference")).to_be_visible()
        self.capture("03-typed-reference.png")
        self.record(3, "Typed reference connects the imported image to the shot", edgeId=edge["id"], nodeId=node["id"])

        self.choose("provider-select", mock["name"] + " · 可用 · 本地模拟")
        self.choose("shot-duration", "2 秒")
        self.choose("shot-ratio", "9:16")
        self.page.get_by_test_id("generate-shot").click()
        state = self.wait(self.state, lambda s: len(s["versions"]) == 1 and s["jobs"][0]["status"] == "succeeded", "V1 mock generation", 90)
        expect(self.page.get_by_role("button", name="关闭任务中心", exact=True)).to_be_visible()
        self.close_tasks()
        v1 = copy.deepcopy(state["versions"][0])
        check(v1["isMock"] and v1["snapshot"]["referenceAssetIds"] == [image["id"]], "Mock/reference snapshot missing")
        check(v1["snapshot"]["referenceConnections"][0]["edgeId"] == edge["id"], "Typed provenance missing")
        v1_hash = self.media_hash(v1["assetId"])
        check(v1_hash == v1["sha256"], "V1 media hash mismatch")
        playback = self.playback(self.page.get_by_test_id("shot-node-" + sid).locator("video"))
        self.capture("04-mock-v1.png")
        self.record(4, "One mock job creates a real playable V1", versionId=v1["id"], sha256=v1_hash, playback=playback)

        self.page.get_by_test_id("shot-prompt").fill("原创几何测试图，换一种运动节奏。仅验证本地模拟流程。V2")
        self.page.get_by_test_id("generate-shot").click()  # Real Save-and-Generate path.
        state = self.wait(self.state, lambda s: len(s["versions"]) == 2 and all(j["status"] == "succeeded" for j in s["jobs"]), "V2 mock generation", 90)
        expect(self.page.get_by_role("button", name="关闭任务中心", exact=True)).to_be_visible()
        self.close_tasks()
        v2 = next(v for v in state["versions"] if v["id"] != v1["id"])
        check(next(v for v in state["versions"] if v["id"] == v1["id"]) == v1, "Regeneration changed V1")
        check(v2["isMock"] and v2["snapshot"]["prompt"] != v1["snapshot"]["prompt"], "V2 lacks new immutable prompt")
        self.page.get_by_role("tab", name=re.compile("版本历史")).click()
        self.page.get_by_role("button", name="比较", exact=True).click()
        comparison = self.page.get_by_role("dialog", name="版本对比", exact=True)
        expect(comparison.locator("video")).to_have_count(2)
        self.capture("05-version-comparison.png")
        comparison.get_by_role("button", name="关闭对话框", exact=True).click()
        card1 = self.page.get_by_test_id("version-card-" + v1["id"])
        if self.state()["shots"][0]["selectedVersionId"] != v1["id"]:
            card1.get_by_role("button", name="选用此版本", exact=True).click()
        self.wait(self.state, lambda s: s["shots"][0]["selectedVersionId"] == v1["id"], "V1 selection")
        expect(card1.get_by_role("button", name="当前选用", exact=True)).to_be_visible()
        check(self.media_hash(v1["assetId"]) == v1_hash, "V1 bytes changed after regeneration")
        self.record(5, "V1 and V2 compare; explicit V1 selection preserves both", versionIds=[v1["id"], v2["id"]])

        card1.get_by_role("button", name="将此固定版本加入时间线", exact=True).click()
        expect(self.page.get_by_test_id("workspace-editing")).to_have_attribute("aria-selected", "true")
        state = self.wait(self.state, lambda s: len(s["timeline"]["clips"]) == 1, "one fixed clip")
        clip = copy.deepcopy(state["timeline"]["clips"][0])
        check(clip["assetId"] == v1["assetId"] and clip["durationFrames"] == 60, "Wrong fixed source/duration")
        self.settled_tasks(2)
        self.page.get_by_test_id("return-to-source").click()
        expect(self.page.get_by_test_id("highlighted-source-version")).to_be_visible()
        self.page.get_by_test_id("version-card-" + v2["id"]).get_by_role("button", name="选用此版本", exact=True).click()
        state = self.wait(self.state, lambda s: s["shots"][0]["selectedVersionId"] == v2["id"], "V2 selected independently")
        expect(self.page.get_by_test_id("version-card-" + v2["id"]).get_by_role("button", name="当前选用", exact=True)).to_be_visible()
        check(state["timeline"]["clips"][0] == clip, "Selecting V2 replaced an existing clip")
        self.page.get_by_test_id("workspace-editing").click()
        self.page.get_by_test_id("timeline-clip-" + clip["id"]).click()
        self.record(6, "Timeline fixes V1 while shot selection independently becomes V2", clipId=clip["id"])

        old_preview = self.render_preview()
        self.page.get_by_test_id("clip-source-in").fill("15")
        self.page.get_by_test_id("clip-duration").fill("45")
        self.page.get_by_test_id("save-clip").click()
        state = self.wait(self.state, lambda s: s["timeline"]["clips"][0]["sourceInFrame"] == 15 and s["timeline"]["clips"][0]["durationFrames"] == 45, "saved trim")
        self.settled_tasks(3)
        expect(self.page.get_by_test_id("save-clip")).to_be_disabled()
        expect(self.page.get_by_test_id("preview-stale")).to_be_visible()
        self.page.get_by_test_id("timeline-undo").click()
        self.wait(self.state, lambda s: s["timeline"]["clips"][0]["durationFrames"] == 60 and s["timeline"]["clips"][0]["sourceInFrame"] == 0, "undo trim")
        self.settled_tasks(4)
        self.page.get_by_test_id("timeline-redo").click()
        state = self.wait(self.state, lambda s: s["timeline"]["clips"][0]["durationFrames"] == 45 and s["timeline"]["clips"][0]["sourceInFrame"] == 15, "redo trim")
        self.settled_tasks(5)
        check(len(state["timeline"]["clips"]) == 1, "Undo/redo duplicated the clip")
        self.capture("07-trim-and-stale-preview.png")
        self.record(7, "Source trim saves, undo/redo restore it, and old preview is stale", timelineRevision=state["timeline"]["revision"], oldPreviewId=old_preview["id"])

        new_preview = self.render_preview()
        expect(self.page.get_by_test_id("preview-stale")).to_have_count(0)
        playback = self.playback(self.page.get_by_test_id("timeline-preview-video"), seek=True)
        check(playback["width"] == 720 and playback["height"] == 1280, "Wrong preview dimensions")
        check(new_preview["timelineRevision"] == self.state()["timeline"]["revision"], "Preview is not current")
        self.capture("08-current-composition.png")
        self.record(8, "Updated real composition plays and seeks", previewId=new_preview["id"], playback=playback)

        before_export = self.state()
        self.page.get_by_test_id("export-timeline").click()
        expect(self.page.get_by_test_id("export-preflight")).to_have_attribute("data-phase", "ready", timeout=45000)
        check(len(self.state()["exports"]) == len(before_export["exports"]), "Preflight unexpectedly exported")
        self.capture("09-preflight-ready.png")
        self.page.get_by_test_id("preflight-export").click()
        state = self.wait(self.state, lambda s: any(e.get("purpose") == "export" and e["status"] == "succeeded" for e in s["exports"]), "real timeline export", 120)
        exports = [e for e in state["exports"] if e.get("purpose") == "export"]
        check(len(exports) == 1 and len(state["exports"]) == 3, "Expected two previews and exactly one export")
        exported = exports[0]
        check(exported["timelineRevision"] == state["timeline"]["revision"], "Export snapshot revision mismatch")
        dialog = self.page.get_by_role("dialog", name="导出记录", exact=True)
        row = dialog.locator(".export-card").filter(has_text="时间线导出")
        expect(row).to_have_count(1)
        with self.page.expect_download(timeout=30000) as event:
            row.get_by_test_id("download-export").click()
        check(event.value.failure() is None, "Browser download failed")
        output = self.out / "first-trial.mp4"
        event.value.save_as(str(output))
        check(output.stat().st_size > 0, "Empty download")
        check(digest(output.read_bytes()) == self.media_hash(exported["assetId"]), "Download differs from managed export")
        probe_run = subprocess.run([self.ffprobe, "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(output)], capture_output=True, text=True, timeout=30)
        check(probe_run.returncode == 0, "ffprobe failed on saved download")
        probe = json.loads(probe_run.stdout)
        write_json(self.out / "export-probe.json", probe)
        video = next(s for s in probe["streams"] if s["codec_type"] == "video")
        check(video["codec_name"] == "h264" and (video["width"], video["height"]) == (720, 1280), "Wrong exported video format")
        check(video["r_frame_rate"] == "30/1" and int(video["nb_read_frames"]) == 45, "Expected exactly 45 frames at 30fps")
        check(abs(float(video["duration"]) - 1.5) < 0.04, "Wrong exported video duration")
        check(any(s["codec_type"] == "audio" and s["codec_name"] == "aac" for s in probe["streams"]), "AAC audio stream missing")
        decode = subprocess.run([self.ffmpeg, "-v", "error", "-i", str(output), "-f", "null", "-"], capture_output=True, text=True, timeout=30)
        (self.out / "export-decode.log").write_text(decode.stderr)
        check(decode.returncode == 0, "Saved MP4 failed full FFmpeg decode")
        self.capture("09-export-and-download.png")
        dialog.get_by_role("button", name="关闭对话框", exact=True).click()
        self.record(9, "Saved browser download fully decodes: H264/AAC, 45 frames", exportId=exported["id"], sha256=digest(output.read_bytes()), nativeSaveAs="not_verified")

        self.page.get_by_test_id("jobs-button").click()
        expect(self.page.get_by_test_id("no-durable-tasks")).to_be_visible()
        self.close_tasks()
        self.wait(lambda: self.page.get_by_test_id("workspace-save-status").inner_text(),
                  lambda text: not text.strip(), "acknowledged workspace view before restart")
        before_restart = self.state()
        task_before = self.settled_tasks(5)
        originals = {a["id"]: self.media_hash(a["id"]) for a in before_restart["assets"]}
        write_json(self.out / "before-restart.json", {"project": before_restart, "tasks": task_before, "mediaHashes": originals})
        self.close_browser()
        self.stop_server()
        self.start_server()
        self.launch_browser(playwright)
        self.login(self.pid)
        expect(self.page.get_by_test_id("workspace-editing")).to_have_attribute("aria-selected", "true")
        self.page.get_by_test_id("jobs-button").click()
        expect(self.page.get_by_test_id("no-durable-tasks")).to_be_visible()
        self.close_tasks()
        # Observe through two normal 2.5-second UI refresh cycles after readiness.
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            check(self.state() == before_restart, "Reopening changed business state")
            self.page.wait_for_timeout(300)
        after_tasks = self.tasks()
        check(after_tasks["items"] == task_before["items"], "Reopening changed retained edit records")
        check(after_tasks["instanceId"] != task_before["instanceId"], "Backend instance did not change")
        check(not any(r["lifetime"] == 2 and (r["path"].startswith("/api/tasks/") or r["operation"] in
                  {"generation.submit", "job.retry", "timeline.render"}) for r in self.requests), "Restart dispatched new work")
        harmless_reads = {"project.get", "project.list", "provider.list", "asset.range.get", "asset.disposition.list", "asset.waveform.get"}
        check(all(r["operation"] in harmless_reads for r in self.requests
                  if r["lifetime"] == 2 and r["path"] == "/api/rpc"), "Restart dispatched an unexpected RPC action")
        check(all(self.media_hash(aid) == value for aid, value in originals.items()), "Restart changed managed media")
        check(digest(self.image.read_bytes()) == original_hash, "Source fixture changed")
        write_json(self.out / "after-restart.json", {"project": self.state(), "tasks": after_tasks, "mediaHashes": originals})
        self.capture("10-reopened-same-project.png")
        self.record(10, "Fresh browser and backend restore the same project without repeating work", observationSeconds=6, taskCount=len(after_tasks["items"]))

        check(not self.page_errors, "Browser page errors occurred")
        check(not self.blocked_requests, "Unexpected network/provider request occurred")
        submissions = [r for r in self.requests if r["operation"] == "generation.submit"]
        check(len(submissions) == 2 and len({r["requestId"] for r in submissions}) == 2, "Expected exactly two mock submission identities")
        after_manifest = self.manifest()
        write_json(self.out / "source-build-after.json", after_manifest)
        check(after_manifest == self.before_manifest, "Source/build changed during acceptance")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--out", required=True, help="New directory under an existing canonical parent")
    parser.add_argument("--node")
    parser.add_argument("--ffmpeg")
    parser.add_argument("--ffprobe")
    parser.add_argument("--chromium", help="Installed trusted Chromium; otherwise system/Playwright installation")
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)  # Applies only to new files owned by this acceptance process.
    trial = Trial(args)
    failure = None
    try:
        with sync_playwright() as playwright:
            try:
                trial.run(playwright)
            except Exception:
                failure = traceback.format_exc()
            finally:
                try:
                    if trial.page and not trial.page.is_closed() and trial.page.get_by_test_id("workbench").count():
                        trial.capture("final-visible-state.png")
                except Exception:
                    trial.report["finalScreenshotError"] = "Could not capture final visible state"
                try:
                    trial.close_browser()
                except Exception:
                    failure = (failure or "") + "\nBrowser cleanup: " + traceback.format_exc()
    except Exception:
        failure = traceback.format_exc()
    finally:
        try:
            trial.stop_server()
        except Exception:
            failure = (failure or "") + "\nCleanup: " + traceback.format_exc()
        trial.report["status"] = "failed" if failure else "passed"
        trial.report["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        if failure:
            # Test tokens must not appear even in unexpected error diagnostics.
            failure = failure.replace(trial.token or "unused-token", "[redacted]")
            trial.report["failure"] = failure
        trial.save()
    print(json.dumps({"status": trial.report["status"], "evidence": str(trial.out), "nativeSaveAs": "not_verified"}))
    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
