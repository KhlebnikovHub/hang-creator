"""Bounded UI smoke test using headless Edge and only Python's standard library.

Run from the project: python tests/browser_smoke.py
The app runs against a temporary copy; the real tabs library is never changed.
The dedicated Edge profile is kept in tests/.browser-profile for reuse.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit
from urllib.request import urlopen


PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))
from server import create_server  # noqa: E402

DEFAULT_EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")


class CDP:
    """Minimal synchronous WebSocket/CDP client, including masked client frames."""

    def __init__(self, url: str):
        target = urlsplit(url)
        if target.scheme != "ws" or target.hostname not in ("127.0.0.1", "localhost"):
            raise ValueError("Only a loopback ws:// debugger is allowed.")
        self.socket = socket.create_connection((target.hostname, target.port), timeout=15)
        self.socket.settimeout(20)
        self.buffer = bytearray()
        self.sequence = 0
        self.events = []
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {target.path}{'?' + target.query if target.query else ''} HTTP/1.1\r\n"
            f"Host: {target.hostname}:{target.port}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.socket.sendall(request.encode("ascii"))
        while b"\r\n\r\n" not in self.buffer:
            chunk = self.socket.recv(4096)
            if not chunk:
                raise ConnectionError("Debugger closed the WebSocket handshake.")
            self.buffer.extend(chunk)
            if len(self.buffer) > 65536:
                raise ConnectionError("Oversized WebSocket handshake.")
        headers, extra = bytes(self.buffer).split(b"\r\n\r\n", 1)
        self.buffer = bytearray(extra)
        expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest())
        response_headers = dict(
            line.split(b":", 1) for line in headers.split(b"\r\n")[1:] if b":" in line
        )
        accept = next((value.strip() for name, value in response_headers.items() if name.lower() == b"sec-websocket-accept"), None)
        if not headers.startswith(b"HTTP/1.1 101 ") or accept != expected:
            raise ConnectionError("Debugger rejected the WebSocket handshake: " + headers.decode("latin1"))

    def _read(self, size: int) -> bytes:
        while len(self.buffer) < size:
            chunk = self.socket.recv(max(4096, size - len(self.buffer)))
            if not chunk:
                raise ConnectionError("Debugger WebSocket closed.")
            self.buffer.extend(chunk)
        result = bytes(self.buffer[:size])
        del self.buffer[:size]
        return result

    def _send(self, payload: bytes, opcode: int = 1):
        size = len(payload)
        frame = bytearray((0x80 | opcode, 0x80 | (size if size < 126 else 126 if size < 65536 else 127)))
        if size >= 65536:
            frame.extend(struct.pack("!Q", size))
        elif size >= 126:
            frame.extend(struct.pack("!H", size))
        mask = os.urandom(4)
        frame.extend(mask)
        frame.extend(value ^ mask[index % 4] for index, value in enumerate(payload))
        self.socket.sendall(frame)

    def _message(self) -> dict:
        fragments = bytearray()
        while True:
            first, second = self._read(2)
            opcode = first & 15
            size = second & 127
            if size == 126:
                size = struct.unpack("!H", self._read(2))[0]
            elif size == 127:
                size = struct.unpack("!Q", self._read(8))[0]
            if size > 32 * 1024 * 1024:
                raise ConnectionError("Oversized debugger frame.")
            mask = self._read(4) if second & 128 else None
            payload = self._read(size)
            if mask:
                payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
            if opcode == 8:
                raise ConnectionError("Debugger sent a close frame.")
            if opcode == 9:
                self._send(payload, 10)
                continue
            if opcode == 10:
                continue
            if opcode not in (0, 1):
                raise ConnectionError(f"Unexpected debugger opcode: {opcode}")
            fragments.extend(payload)
            if first & 128:
                return json.loads(fragments.decode("utf-8"))

    def call(self, method: str, params: dict | None = None) -> dict:
        self.sequence += 1
        request_id = self.sequence
        self._send(json.dumps({"id": request_id, "method": method, "params": params or {}}).encode("utf-8"))
        deadline = time.monotonic() + 20
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Debugger command timed out: " + method)
            self.socket.settimeout(remaining)
            message = self._message()
            if message.get("id") != request_id:
                self.events.append(message)
                continue
            if "error" in message:
                raise RuntimeError(f"{method}: {message['error']}")
            return message.get("result", {})

    def evaluate(self, expression: str):
        result = self.call("Runtime.evaluate", {
            "expression": expression, "awaitPromise": True, "returnByValue": True, "userGesture": True,
        })
        if "exceptionDetails" in result:
            detail = result["exceptionDetails"]
            raise AssertionError(detail.get("exception", {}).get("description", detail.get("text", str(detail))))
        return result.get("result", {}).get("value")

    def wait(self, expression: str, message: str, timeout: float = 15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                result = self.evaluate(expression)
                if result:
                    return result
            except AssertionError as error:
                if "Cannot read" not in str(error) and "not defined" not in str(error):
                    raise
            time.sleep(0.1)
        raise AssertionError("Timed out: " + message)

    def click(self, selector: str):
        self.evaluate(f"document.querySelector({json.dumps(selector)}).click()")

    def fill(self, selector: str, value: str, event: str = "input"):
        self.evaluate(
            "(() => { const el = document.querySelector(" + json.dumps(selector) + ");"
            "if (!el) throw new Error('Missing input: ' + " + json.dumps(selector) + ");"
            "el.value = " + json.dumps(value) + ";"
            "el.dispatchEvent(new Event(" + json.dumps(event) + ", {bubbles:true})); })()"
        )

    def key(self, key: str, code: str | None = None, modifiers: int = 0, repeat: bool = False):
        code = code or ("Digit" + key if key.isdigit() else key)
        details = {"key":key,"code":code,"modifiers":modifiers}
        if key in ("Enter", " "):
            details["windowsVirtualKeyCode"] = 13 if key == "Enter" else 32
            details["nativeVirtualKeyCode"] = details["windowsVirtualKeyCode"]
        down = {"type":"keyDown", **details, "autoRepeat":repeat}
        if key in ("Enter", " ") and not modifiers:
            down["text"] = "\r" if key == "Enter" else " "
            down["unmodifiedText"] = down["text"]
        self.call("Input.dispatchKeyEvent", down)
        self.call("Input.dispatchKeyEvent", {"type": "keyUp", **details})

    def screenshot(self, path: Path):
        self.evaluate("window.scrollTo(0,0)")
        metrics = self.call("Page.getLayoutMetrics")
        size = metrics.get("cssContentSize", metrics["contentSize"])
        result = self.call("Page.captureScreenshot", {
            "format": "png", "fromSurface": True, "captureBeyondViewport": True,
            "clip": {"x": 0, "y": 0, "width": size["width"], "height": min(size["height"], 5000), "scale": 1},
        })
        path.write_bytes(base64.b64decode(result["data"]))

    def close(self):
        self.socket.close()


def assert_that(condition: bool, message: str):
    if not condition:
        raise AssertionError(message)
    print("PASS " + message, flush=True)


def render_png(client: CDP, tab_expression: str) -> tuple[dict, bytes]:
    png = client.evaluate("""(async () => {
      const tab = await SAVED;
      const pages = await HangExport.renderPNG(tab);
      if (!Array.isArray(pages) || !pages.length) throw new Error('No PNG pages');
      const first = pages[0];
      const bytes = new Uint8Array(await first.blob.arrayBuffer());
      const bitmap = await createImageBitmap(first.blob);
      let binary = '';
      for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start,start+8192));
      const result = {name:first.name, type:first.blob.type, size:first.blob.size, width:bitmap.width, height:bitmap.height, bytes:btoa(binary), pages:pages.length};
      bitmap.close(); return result;
    })()""".replace("SAVED", tab_expression))
    return png, base64.b64decode(png.pop("bytes"))


def wait_debugger(port: int, process: subprocess.Popen) -> str:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Edge exited with status {process.returncode}.")
        try:
            with urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as response:
                targets = json.load(response)
            for target in targets:
                if target.get("type") == "page" and target.get("webSocketDebuggerUrl"):
                    return target["webSocketDebuggerUrl"]
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    raise RuntimeError("Headless Edge debugger did not start within 20 seconds.")


def check_measure_rhythms(client: CDP, artifacts: Path) -> dict:
    def current():
        return client.evaluate("HangApp.getTab()")

    def counts():
        return client.evaluate("(() => { const tab=HangApp.getTab(); return tab.measures.map((_,i)=>HangCore.slots(tab,i).length); })()")

    def change_division(beat: int, division: int):
        client.fill(f'[data-beat="{beat}"]', str(division), "change")
        client.wait("!document.querySelector('dialog[open]')", "rhythm change completes")

    assert_that(client.evaluate("document.querySelector('#rhythm-scope').value === 'measure'"), "rhythm controls default to the selected measure")
    for index in range(1, 4):
        client.click(f'[data-cell="{index},main,0"]')
        client.key(str(index + 1))
    others_before = current()["measures"][1:]
    client.click('[data-edit-rhythm="0"]')
    change_division(0, 2)
    first = current()
    first_labels = client.evaluate("Array.from(document.querySelectorAll('#score .measure-card')[0].querySelectorAll('.count-cell')).map(el=>el.textContent.trim())")
    assert_that(counts() == [5, 4, 4, 4] and first_labels == ["1", "и", "2", "3", "4"], "first measure alone becomes 1-and-2-3-4 with five positions")
    assert_that(first["measures"][1:] == others_before and [beat["division"] for beat in first["beats"]] == [1, 1, 1, 1], "other measures and the default rhythm remain unchanged")
    client.screenshot(artifacts / "per-measure-editor.png")
    first_png, first_bytes = render_png(client, "HangApp.getTab()")
    (artifacts / "per-measure-export.png").write_bytes(first_bytes)

    client.fill("#rhythm-measure", "1", "change")
    change_division(2, 4)
    assert_that(counts() == [5, 7, 4, 4], "second measure divides its third beat into four independently")
    client.click("#undo")
    assert_that(counts() == [5, 4, 4, 4], "undo restores only the last measure rhythm change")
    client.click("#redo")
    assert_that(counts() == [5, 7, 4, 4], "redo restores the second measure's own subdivision")

    client.fill("#rhythm-scope", "all", "change")
    change_division(0, 2)
    all_tab = current()
    assert_that(counts() == [5, 8, 5, 5] and [beat["division"] for beat in all_tab["beats"]] == [2, 1, 1, 1], "all-measure change updates the first beat and the default rhythm")
    assert_that(all_tab["measures"][1]["beats"][2]["division"] == 4 and all_tab["meter"] == {"numerator": 4, "denominator": 4}, "all-measure edit preserves the second measure's other subdivision and 4/4")
    assert_that([measure["rows"]["main"][0] for measure in all_tab["measures"]] == [["D", "4"], ["2"], ["3"], ["4"]], "notes stay at their original beat onsets across different grids")

    for source, key, expected in (("0,main,4", "ArrowRight", "1,main,0"), ("1,main,0", "ArrowLeft", "0,main,4"), ("1,main,7", "ArrowRight", "2,main,0"), ("2,main,0", "ArrowLeft", "1,main,7")):
        client.click(f'[data-cell="{source}"]')
        client.key(key)
        assert_that(client.evaluate("document.querySelector('.note-cell.selected').dataset.cell") == expected, "keyboard crosses mixed grids: " + source + " -> " + expected)
    client.click("#undo")
    assert_that(counts() == [5, 7, 4, 4], "undo reverses all-measure change without losing local rhythms")
    client.click("#redo")
    assert_that(counts() == [5, 8, 5, 5], "redo restores mixed grids together")

    client.evaluate("""(() => {
      window.__smokeCanvasLabels=[];
      window.__smokeFillText=CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText=function(value,x,y,maxWidth) {
        if(this.fillStyle==='#668256') window.__smokeCanvasLabels.push({value:String(value),x,y,width:maxWidth});
        return window.__smokeFillText.apply(this,arguments);
      };
    })()""")
    try:
        png, mixed_bytes = render_png(client, "HangApp.getTab()")
        drawn = client.evaluate("window.__smokeCanvasLabels")
    finally:
        client.evaluate("CanvasRenderingContext2D.prototype.fillText=window.__smokeFillText")
    groups = {}
    for label in drawn:
        groups.setdefault(label["y"], []).append(label)
    rows = list(groups.values())
    assert_that([len(row) for row in rows] == [5, 8, 5, 5] and [label["value"] for label in rows[0]] == ["1", "и", "2", "3", "4"], "PNG draws each measure's own grid and labels")
    expected_durations = [[.5, .5, 1, 1, 1], [.5, .5, 1, .25, .25, .25, .25, 1], [.5, .5, 1, 1, 1], [.5, .5, 1, 1, 1]]
    quarter_width = (png["width"] - 128) / 4
    assert_that(all(abs(label["x"] - (64 + (sum(durations[:index]) + duration / 2) * quarter_width)) < .1 for row, durations in zip(rows, expected_durations) for index, (label, duration) in enumerate(zip(row, durations))), "PNG cell centers follow durations independently in every measure")
    (artifacts / "mixed-rhythm.png").write_bytes(mixed_bytes)
    client.screenshot(artifacts / "mixed-editor.png")

    original_id = current()["id"]
    client.evaluate("""(async () => {
      const fixture=HangApp.getTab(); fixture.title='Два такта · проверка ритма'; fixture.tempo=400;
      fixture.measures=fixture.measures.slice(0,2);
      fixture.measures.forEach((measure,index)=>{measure.rows.main=HangCore.slots(fixture,index).map(()=>['D']);});
      await HangApp.importFile(new File([JSON.stringify(fixture)],'playback.json',{type:'application/json'}));
      window.__smokeSounds=[];
    })()""")
    client.click("#play")
    client.wait("document.querySelector('#play').classList.contains('playing')", "mixed rhythm playback starts")
    client.wait("!document.querySelector('#play').classList.contains('playing') && window.__smokeSounds.length > 0", "two mixed-grid measures finish playback", timeout=5)
    playback = client.evaluate("({elapsed:(window.__smokePlayEnd-window.__smokePlayStart)/1000,sounds:window.__smokeSounds})")
    expected_offsets = [0, .075, .15, .3, .45, .6, .675, .75, .9, .9375, .975, 1.0125, 1.05]
    actual_offsets = [sound["time"] - playback["sounds"][0]["time"] for sound in playback["sounds"]]
    assert_that(len(actual_offsets) == len(expected_offsets) and all(abs(actual-expected)<.025 for actual, expected in zip(actual_offsets, expected_offsets)), "playback schedules all thirteen mixed-grid positions at their correct times")
    assert_that(1.2 <= playback["elapsed"] < 1.7, "two 4/4 measures at 400 BPM last 1.2 seconds plus the playback lead-in")
    client.click(f'[data-tab="{original_id}"]')
    client.evaluate("HangApp.flushSaves()")
    return {"slots": counts(), "png": png, "playbackSeconds": playback["elapsed"]}


def check_hybrid(client: CDP, copied_root: Path, artifacts: Path) -> dict:
    client.click("#new-tab")
    client.fill("#tab-title", "Гибрид · ритм и слоги")
    client.click('[data-cell="0,main,0"]')
    client.evaluate("document.querySelector('[data-cell=\"0,main,0\"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))")
    client.wait("document.querySelector('#cell-dialog').open", "hybrid chord dialog opens")
    client.fill("#cell-value", "D/4")
    client.click("#confirm-cell")
    client.click('[data-cell="1,main,0"]')
    client.click('[data-note="2"]')
    client.click('[data-edit-rhythm="0"]')
    for beat, division, expected in ((1, 2, 5), (2, 3, 7), (3, 4, 10)):
        client.fill(f'[data-beat="{beat}"]', str(division), "change")
        client.wait(f"HangCore.slots(HangApp.getTab(),0).length === {expected}", "hybrid mixed divisions")
    timing_expression = "(() => {const tab=HangApp.getTab();return tab.measures.map((_,i)=>HangCore.slots(tab,i).map(slot=>[slot.offset,slot.duration]));})()"
    measures_before = client.evaluate("HangApp.getTab().measures")
    timing_before = client.evaluate(timing_expression)
    client.click('[data-notation="konnakol"]')
    client.fill("#phrase-input", "Ta Ki Ta | Ta Ki Ta | Ta Ka")
    client.click("#apply-phrase")
    phrases = client.evaluate("HangApp.getTab().phrases")
    assert_that([phrase["size"] for phrase in phrases] == [3, 3, 2], "konnakol phrases exist before switching to hybrid")
    client.click('[data-notation="hybrid"]')
    client.wait("HangApp.getTab().notation === 'hybrid'", "hybrid mode activates")
    expected_first = ["1", "Ta", "Ka", "Ta", "Ki", "Ta", "Ta", "Ka", "Di", "Mi"]
    display_expression = "(() => {const tab=HangApp.getTab();return tab.measures.map((_,i)=>HangCore.slots(tab,i).map(slot=>slot.displayLabel));})()"
    displayed = client.evaluate(display_expression)
    dom_labels = client.evaluate("Array.from(document.querySelectorAll('#score .measure-card')[0].querySelectorAll('.count-cell')).map(el=>el.textContent.trim())")
    assert_that(displayed == [expected_first, ["1", "2", "3", "4"], ["1", "2", "3", "4"], ["1", "2", "3", "4"]] and dom_labels == expected_first, "hybrid combines whole-beat counts with per-beat syllables only in the subdivided measure")
    assert_that(client.evaluate("HangApp.getTab().measures") == measures_before and client.evaluate(timing_expression) == timing_before, "switching to hybrid preserves notes, grids, and timing")
    assert_that(client.evaluate("document.querySelector('#konnakol-panel').hidden && !document.querySelector('[data-label-beat=\"1\"]').disabled && document.querySelector('[data-label-beat=\"1\"]').offsetParent !== null"), "hybrid hides phrase controls and keeps custom beat labels editable")
    assert_that(client.evaluate("HangApp.getTab().phrases") == phrases, "hybrid preserves konnakol phrases while ignoring their overlay")
    client.evaluate("""(() => {
      window.__hybridCanvasText=[];window.__hybridFillText=CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText=function(value,x,y,maxWidth){window.__hybridCanvasText.push({value:String(value),x,y,width:maxWidth,color:this.fillStyle});return window.__hybridFillText.apply(this,arguments);};
    })()""")
    try:
        png, png_bytes = render_png(client, "HangApp.getTab()")
        drawn = client.evaluate("window.__hybridCanvasText")
    finally:
        client.evaluate("CanvasRenderingContext2D.prototype.fillText=window.__hybridFillText")
    numbered = [item["value"] for item in drawn if item["color"] == "#4e704a"]
    syllables = [item["value"] for item in drawn if item["color"] == "#668256"]
    beats_by_measure = client.evaluate("(() => {const tab=HangApp.getTab();return tab.measures.map((_,i)=>HangCore.measureBeats(tab,i));})()")
    reconstructed = []
    number_index = syllable_index = 0
    for beats in beats_by_measure:
        row = []
        for beat in beats:
            assert_that(numbered[number_index] == beat["label"], "PNG retains beat number " + beat["label"])
            number_index += 1
            if beat["division"] == 1:
                row.append(beat["label"])
            else:
                row.extend(syllables[syllable_index:syllable_index + beat["division"]])
                syllable_index += beat["division"]
        reconstructed.append(row)
    assert_that(reconstructed == displayed and number_index == len(numbered) and syllable_index == len(syllables), "PNG exports both hybrid header levels independently for each measure")
    assert_that(any("4/4" in item["value"] and "BPM" in item["value"] and "Гибрид" in item["value"] for item in drawn), "PNG metadata identifies the hybrid mode")
    (artifacts / "hybrid-export.png").write_bytes(png_bytes)
    client.evaluate("HangApp.flushSaves()")
    client.screenshot(artifacts / "hybrid-editor.png")

    client.fill('[data-label-beat="1"]', "Dha Ge", "change")
    custom_first = ["1", "Dha", "Ge", "Ta", "Ki", "Ta", "Ta", "Ka", "Di", "Mi"]
    client.wait("HangCore.slots(HangApp.getTab(),0)[1].displayLabel === 'Dha'", "custom hybrid syllables update")
    client.fill('[data-label-beat="0"]', "Раз", "change")
    custom_first[0] = "Раз"
    client.wait("HangCore.slots(HangApp.getTab(),0)[0].displayLabel === 'Раз'", "custom whole-beat count updates")
    assert_that(client.evaluate(display_expression)[0] == custom_first, "hybrid edits custom syllables and a whole-beat count in the same controls")
    rows_after_custom = client.evaluate("HangApp.getTab().measures.map(measure=>measure.rows)")
    assert_that(rows_after_custom == [measure["rows"] for measure in measures_before] and client.evaluate(timing_expression) == timing_before, "custom hybrid labels leave notes and durations unchanged")
    client.click('[data-notation="count"]')
    assert_that(client.evaluate("HangCore.slots(HangApp.getTab(),0)[0].displayLabel") == "Раз", "ordinary count retains the custom whole-beat label")
    client.click('[data-notation="konnakol"]')
    assert_that(client.evaluate("!document.querySelector('#konnakol-panel').hidden && HangApp.getTab().phrases.length === 3"), "switching back to konnakol restores its saved phrase controls")
    assert_that(client.evaluate(display_expression)[0] == ["Ta", "Ki", "Ta", "Ta", "Ki", "Ta", "Ta", "Ka", "Ta", "Ki"], "konnakol restores the saved phrase overlay")
    client.click('[data-notation="hybrid"]')
    assert_that(client.evaluate(display_expression)[0] == custom_first and client.evaluate("HangApp.getTab().phrases") == phrases, "hybrid restores its per-beat labels and keeps the konnakol phrase")
    assert_that(client.evaluate("HangApp.getTab().measures.map(measure=>measure.rows)") == rows_after_custom and client.evaluate(timing_expression) == timing_before, "all three notation switches preserve notes and timing")
    client.evaluate("HangApp.flushSaves()")
    saved = client.evaluate("HangApp.getTab()")
    assert_that(json.loads((copied_root / "tabs" / (saved["id"] + ".json")).read_text(encoding="utf-8")) == saved, "hybrid JSON persists mode, custom syllables, counts, and saved phrases")
    assert_that(client.evaluate("JSON.stringify(HangCore.validateTab(JSON.parse(JSON.stringify(HangApp.getTab())))) === JSON.stringify(HangApp.getTab())"), "hybrid JSON survives client validation roundtrip")
    previous_epoch = client.evaluate("performance.timeOrigin")
    client.call("Page.reload", {"ignoreCache": True})
    client.wait("performance.timeOrigin !== " + json.dumps(previous_epoch) + " && document.readyState === 'complete' && window.HangApp && document.querySelector('#tab-title')?.value === 'Гибрид · ритм и слоги'", "hybrid document reopens after reload")
    assert_that(client.evaluate("HangApp.getTab()") == saved and client.evaluate(display_expression)[0] == custom_first, "reload restores the complete hybrid document")
    for width in (960, 1150):
        client.call("Emulation.setDeviceMetricsOverride", {"width": width, "height": 1100, "deviceScaleFactor": 1, "mobile": False})
        client.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        fit = client.evaluate("(() => {const control=document.querySelector('#notation-control').getBoundingClientRect();return {page:document.documentElement.scrollWidth,inside:[...document.querySelectorAll('#notation-control button')].every(el=>{const r=el.getBoundingClientRect();return r.width>0 && r.left>=control.left-.5 && r.right<=control.right+.5;})};})()")
        assert_that(fit["page"] <= width + 1 and fit["inside"], f"three notation buttons fit their desktop control at {width}px")
    client.fill('[data-label-beat="0"]', "1", "change")
    client.fill('[data-label-beat="1"]', "", "change")
    client.wait("HangCore.slots(HangApp.getTab(),0)[1].displayLabel === 'Ta'", "canonical labels restored for mobile screenshot")
    client.call("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": True})
    client.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    mobile = client.evaluate("({width:innerWidth,page:document.documentElement.scrollWidth,buttons:[...document.querySelectorAll('#notation-control button')].map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};})})")
    assert_that(mobile["width"] <= 391 and mobile["page"] <= 391 and len(mobile["buttons"]) == 3 and all(button["left"] >= 0 and button["right"] <= 391 and button["width"] > 0 for button in mobile["buttons"]), "all three notation buttons fit the 390px mobile viewport")
    client.screenshot(artifacts / "hybrid-mobile.png")
    assert_that(not client.evaluate("window.__smokeErrors") and not [event for event in client.events if event.get("method") == "Runtime.exceptionThrown"], "hybrid browser scenario has no JavaScript runtime errors")
    return {"displayedLabels": displayed, "customFirstMeasure": custom_first, "png": png, "mobile": mobile}


def check_numbered_hybrid(client: CDP, copied_root: Path, artifacts: Path) -> dict:
    def header_labels(index: int):
        return client.evaluate("Array.from(document.querySelectorAll('#score .measure-card')[" + str(index) + "].querySelectorAll('.count-cell')).map(el=>el.textContent.trim())")

    def geometry():
        return client.evaluate("""(() => {
          const failures=[],tab=HangApp.getTab();
          for(const card of document.querySelectorAll('#score .measure-card[data-measure]')) {
            const m=Number(card.dataset.measure),slots=HangCore.slots(tab,m),labels=[...card.querySelectorAll('.count-cell')];
            for(const group of card.querySelectorAll('.hybrid-beat')) {
              const beat=Number(group.dataset.beatNumber),indices=slots.map((slot,index)=>slot.beat===beat?index:-1).filter(index=>index>=0);
              const rect=group.getBoundingClientRect(),first=labels[indices[0]].getBoundingClientRect(),last=labels[indices.at(-1)].getBoundingClientRect();
              if(Math.abs(rect.left-first.left)>2 || Math.abs(rect.right-last.right)>2 || first.top<rect.bottom-2) failures.push('group span '+m+','+beat);
              const range=document.createRange();range.selectNodeContents(group);const text=range.getBoundingClientRect();
              if(Math.abs((text.left+text.right-rect.left-rect.right)/2)>2) failures.push('number center '+m+','+beat);
            }
            for(let index=0;index<slots.length;index++) {
              const label=labels[index].getBoundingClientRect();
              const note=card.querySelector('[data-cell$=",'+index+'"]').getBoundingClientRect();
              if(Math.abs(note.left-label.left)>2 || Math.abs(note.width-label.width)>2 || note.top<label.bottom-2) failures.push('note alignment '+m+','+index);
            }
            const whole=card.querySelector('.hybrid-whole'),group=card.querySelector('.hybrid-beat');
            if(whole && group && Math.abs(whole.getBoundingClientRect().height-55)>2) failures.push('whole spans two rows '+m);
            const hand=card.querySelector('.hybrid-count-hand');
            if(hand && Math.abs(hand.getBoundingClientRect().height-55)>2) failures.push('hand spans two rows '+m);
          }
          return failures;
        })()""")

    def capture_export(expression: str):
        client.evaluate("""(() => {window.__numberedCanvas=[];window.__numberedFill=CanvasRenderingContext2D.prototype.fillText;
          CanvasRenderingContext2D.prototype.fillText=function(value,x,y,maxWidth){window.__numberedCanvas.push({value:String(value),x,y,width:maxWidth,color:this.fillStyle});return window.__numberedFill.apply(this,arguments);};})()""")
        try:
            png, data = render_png(client, expression)
            drawn = client.evaluate("window.__numberedCanvas")
        finally:
            client.evaluate("CanvasRenderingContext2D.prototype.fillText=window.__numberedFill")
        return png, data, drawn

    client.click("#new-tab")
    client.fill("#tab-title", "Гибрид · счёт над слогами")
    client.click('[data-cell="0,main,0"]')
    client.evaluate("document.querySelector('[data-cell=\"0,main,0\"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))")
    client.wait("document.querySelector('#cell-dialog').open", "numbered hybrid chord opens")
    client.fill("#cell-value", "D/4")
    client.click("#confirm-cell")
    client.click('[data-cell="1,main,0"]')
    client.click('[data-note="2"]')
    other_measures = client.evaluate("HangApp.getTab().measures.slice(1)")
    client.click('[data-edit-rhythm="0"]')
    client.fill('[data-beat="0"]', "4", "change")
    client.wait("HangCore.slots(HangApp.getTab(),0).length===7", "first beat divides into four")
    client.click('[data-notation="hybrid"]')
    first_card = "document.querySelector('#score .measure-card')"
    assert_that(client.evaluate(first_card + ".querySelector('.hybrid-beat[data-beat-number=\"0\"]').textContent.trim()") == "1" and header_labels(0) == ["Ta", "Ka", "Di", "Mi", "2", "3", "4"], "first beat retains number 1 above Ta-Ka-Di-Mi; whole beats remain 2-3-4")
    assert_that(header_labels(1) == ["1", "2", "3", "4"] and client.evaluate("HangApp.getTab().measures.slice(1)") == other_measures, "numbered hybrid leaves following measures unchanged")
    assert_that(not geometry(), "both hybrid header levels align with note columns")
    png, png_bytes, drawn = capture_export("HangApp.getTab()")
    lower = [item for item in drawn if item["color"] == "#668256"]
    upper = [item for item in drawn if item["color"] == "#4e704a"]
    first_note = next(item for item in drawn if item["value"] == "D" and item["color"] == "#263b35")
    assert_that([item["value"] for item in lower] == ["Ta", "Ka", "Di", "Mi"] and [item["value"] for item in upper] == ["1", "2", "3", "4"] * 4, "PNG retains every beat number and all four first-beat syllables")
    first_number = upper[0]
    assert_that(first_number["y"] < lower[0]["y"] < first_note["y"] and abs(first_number["x"]-(lower[0]["x"]+lower[3]["x"])/2)<.1, "PNG centers beat 1 above its syllable span and keeps notes below both levels")
    quarter_width=(png["width"]-128)/4
    assert_that(abs(first_number["x"]-(64+quarter_width/2))<.1 and all(abs(item["x"]-(64+(index+.5)*quarter_width/4))<.1 for index,item in enumerate(lower)) and abs(first_note["x"]-lower[0]["x"])<.1, "PNG beat, syllable, and note centers match their durations")
    ordinary_png, _, ordinary_drawn = capture_export("(() => {const tab=HangApp.getTab();tab.notation='count';return tab;})()")
    ordinary_note = next(item for item in ordinary_drawn if item["value"] == "D" and item["color"] == "#263b35")
    assert_that(png["height"] > ordinary_png["height"] and first_note["y"] > ordinary_note["y"], "PNG reserves additional header height for hybrid beat numbers")
    client.evaluate("HangApp.flushSaves()")
    client.screenshot(artifacts / "hybrid-numbered-editor.png")
    (artifacts / "hybrid-numbered-export.png").write_bytes(png_bytes)
    client.fill("#hands", "split", "change")
    assert_that(not geometry() and client.evaluate("HangApp.getTab().measures[0].rows.R[0].join('/')") == "D/4", "R/L rows and hand header align with both hybrid levels")
    for beat, division, count in ((0,1,4),(1,2,5),(2,3,7),(3,4,10)):
        client.fill(f'[data-beat="{beat}"]',str(division),"change")
        client.wait(f"HangCore.slots(HangApp.getTab(),0).length==={count}", "mixed hybrid divisions")
    numbers = client.evaluate(first_card + ".querySelectorAll('.hybrid-beat').length")
    assert_that(numbers == 3 and client.evaluate("Array.from("+first_card+".querySelectorAll('[data-beat-number]')).map(el=>el.textContent.trim())") == ["1","2","3","4"] and not geometry(), "mixed 1-2-3-4 subdivisions retain all four numbered beat groups")
    client.click('[data-notation="count"]')
    for beat,label in enumerate(("0","1","2","1")):
        client.fill(f'[data-label-beat="{beat}"]',label,"change")
    client.click('[data-notation="hybrid"]')
    client.fill("#rhythm-scope","all","change")
    client.fill('[data-beat="0"]',"4","change")
    client.wait("HangCore.slots(HangApp.getTab(),1).length===7", "all-measure subdivision")
    number_rows = client.evaluate("Array.from(document.querySelectorAll('#score .measure-card')).map(card=>Array.from(card.querySelectorAll('[data-beat-number]')).map(el=>el.textContent.trim()))")
    assert_that(number_rows == [["0","1","2","1"],["1","2","3","4"],["1","2","3","4"],["1","2","3","4"]] and client.evaluate("HangApp.getTab().meter.numerator===4 && HangApp.getTab().meter.denominator===4"), "all-measure editing preserves custom zero and repeated local labels in 4/4")
    client.evaluate("HangApp.flushSaves()")
    saved=client.evaluate("HangApp.getTab()")
    assert_that(json.loads((copied_root/"tabs"/(saved["id"]+".json")).read_text(encoding="utf-8"))==saved, "numbered hybrid saves without changing the JSON data model")
    previous_epoch=client.evaluate("performance.timeOrigin")
    client.call("Page.reload",{"ignoreCache":True})
    client.wait("performance.timeOrigin!=="+json.dumps(previous_epoch)+" && document.readyState==='complete' && window.HangApp && document.querySelector('#tab-title')?.value==='Гибрид · счёт над слогами'", "numbered hybrid reload")
    assert_that(client.evaluate("HangApp.getTab()") == saved and not geometry(), "JSON reload preserves local numbering, split hands, notes, and layout")
    client.call("Emulation.setDeviceMetricsOverride",{"width":390,"height":844,"deviceScaleFactor":1,"mobile":True})
    client.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
    assert_that(client.evaluate("innerWidth<=391 && document.documentElement.scrollWidth<=391") and not geometry(), "both numbered header levels and R/L columns align on mobile 390px")
    assert_that(not client.evaluate("window.__smokeErrors") and not [event for event in client.events if event.get("method")=="Runtime.exceptionThrown"], "numbered hybrid has no JavaScript runtime errors")
    return {"firstMeasure":["1","Ta","Ka","Di","Mi","2","3","4"],"numberRows":number_rows,"png":png}


POLISH_AUDIO_MOCK = r"""
  window.__polishAudio={contexts:[],sounds:[],pending:[],gate:false};
  window.AudioContext=class {
    constructor(){this.state='suspended';this.destination={};this.id=__polishAudio.contexts.length;this.started=null;__polishAudio.contexts.push(this);}
    get currentTime(){return this.started===null?0:(performance.now()-this.started)/1000;}
    resume(){return new Promise(resolve=>{const ready=()=>{if(this.state!=='closed'){this.state='running';this.started=performance.now();}resolve();};if(__polishAudio.gate)__polishAudio.pending.push(ready);else ready();});}
    close(){this.state='closed';this.ended=performance.now();return Promise.resolve();}
    createGain(){return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}
    createOscillator(){let frequency;const context=this;return {type:'sine',frequency:{setValueAtTime(value){frequency=value;}},connect(){},disconnect(){},stop(){},start(time){__polishAudio.sounds.push({context:context.id,time,frequency});}};}
  };
"""


def check_polish(client: CDP, copied_root: Path, artifacts: Path) -> dict:
    """A bounded editing/transport regression; saved tabs live only in the clone."""
    def current():
        return client.evaluate("HangApp.getTab()")

    def select(measure: int, row: str, slot: int):
        selector = f'[data-cell="{measure},{row},{slot}"]'
        client.click(selector)
        client.evaluate(f"document.querySelector({json.dumps(selector)}).focus()")

    def selected():
        return client.evaluate("(() => {const parts=document.querySelector('.note-cell.selected').dataset.cell.split(',');const tab=HangApp.getTab();return {measure:Number(parts[0]),row:parts[1],slot:Number(parts[2]),id:tab.measures[Number(parts[0])].id};})()")

    def checkbox(selector: str, checked: bool):
        client.evaluate("(() => {const el=document.querySelector(" + json.dumps(selector) + ");el.checked=" + json.dumps(checked) + ";el.dispatchEvent(new Event('change',{bubbles:true}));})()")

    def menu(action: str, index: int):
        client.evaluate(f"document.querySelector('[data-{action}=\"{index}\"]').closest('details').open=true")
        client.click(f'[data-{action}="{index}"]')

    def confirm():
        client.wait("document.querySelector('#confirm-dialog').open", "confirmation opens")
        client.click("#confirm-yes")
        client.wait("!document.querySelector('#confirm-dialog').open", "confirmation completes")

    def import_fixture(transport: bool = False):
        return client.evaluate("""(async () => {
          let tab=HangCore.createTab({title:TRANSPORT?'Пульс · прослушивание':'Пульс · работа с тактами',hands:'split'});
          tab.tempo=400;tab.notation='hybrid';
          let beats=HangCore.clone(tab.beats);beats[0].division=2;
          tab=HangCore.setMeasureRhythm(tab,0,beats).tab;
          beats=HangCore.clone(tab.beats);beats[2].division=4;
          if(!TRANSPORT)tab=HangCore.setMeasureRhythm(tab,1,beats).tab;
          tab.measures[0].label='Пульс';tab.measures[1].label='Ответ';tab.measures[2].label='Возвращение';
          tab.measures[0].rows.R=[['D'],[],['1'],[],['2']];
          tab.measures[0].rows.L=[[],['3'],[],['4'],[]];
          if(TRANSPORT){tab.measures=tab.measures.slice(0,2);tab.measures[1].label='Пауза';}
          else {tab.measures[1].rows.R=[['7'],[],['8'],['9'],['10'],['11'],['12']];tab.measures[2].rows.R=[['2'],['4'],['6'],['8']];}
          await HangApp.importFile(new File([JSON.stringify(tab)],'practice.json',{type:'application/json'}));
          return HangApp.getTab();
        })()""".replace("TRANSPORT", json.dumps(transport)))

    client.click("#new-tab")
    assert_that(client.evaluate("document.querySelector('#auto-advance').checked"), "automatic entry advance defaults to on")
    select(0, "main", 0)
    for number in range(9, 13):
        client.click(f'[data-note="{number}"]')
    assert_that(current()["measures"][0]["rows"]["main"] == [["9"], ["10"], ["11"], ["12"]] and selected()["measure"] == 1, "palette 9–12 enters notes and advances across the measure boundary")
    checkbox("#auto-advance", False)
    select(0, "main", 0)
    client.key("в", code="KeyD")
    assert_that(current()["measures"][0]["rows"]["main"][0] == ["D"] and selected()["slot"] == 0, "physical KeyD enters Ding with the Russian keyboard layout and advance disabled")
    assert_that(client.evaluate("document.querySelector('[data-note=\"D\"]').getAttribute('aria-pressed')==='true' && document.querySelectorAll('.selected-count').length>0"), "palette and count highlight the selected Ding cell")
    client.click('[data-note="12"]')
    assert_that(selected()["slot"] == 0 and current()["measures"][0]["rows"]["main"][0] == ["12"], "palette also respects disabled automatic advance")
    checkbox("#auto-advance", True)
    client.click('[data-note="11"]')
    assert_that(selected()["slot"] == 1 and client.evaluate("document.querySelector('#selection-context').textContent.trim().length>0"), "entry context follows the selected position")
    active_id = current()["id"]
    before_undo = current()
    client.click(f'[data-tab="{active_id}"]')
    assert_that(client.evaluate("!document.querySelector('#undo').disabled"), "clicking the current library item preserves undo")
    client.click("#undo")
    client.click("#redo")
    assert_that(current() == before_undo, "entry undo and redo restore the exact document")

    fixture = import_fixture()
    chosen_id = fixture["measures"][2]["id"]
    select(2, "R", 2)
    menu("move-up", 2)
    assert_that(selected()["id"] == chosen_id and selected()["measure"] == 1, "moving a selected measure keeps its ID, note and local rhythm selected")
    client.click('[data-duplicate="0"]')
    assert_that(selected()["id"] == chosen_id and selected()["measure"] == 2, "duplicating before the selected measure preserves selection identity")
    before_delete = current()
    client.click('[data-remove="0"]')
    confirm()
    after_delete = current()
    assert_that(selected()["id"] == chosen_id and selected()["measure"] == 1, "deleting before the selected measure preserves selection identity")
    client.click("#undo")
    assert_that(current() == before_delete and selected()["id"] == chosen_id, "undo restores the removed measure without changing the selected measure")
    client.click("#redo")
    assert_that(current() == after_delete and selected()["id"] == chosen_id, "redo keeps stable selection through the splice")
    before_insert = current()
    menu("insert", 0)
    inserted = current()["measures"][1]
    assert_that(len(current()["measures"]) == len(before_insert["measures"]) + 1 and all(not cell for row in inserted["rows"].values() for cell in row) and selected()["id"] == inserted["id"] and inserted.get("beats") == before_insert["measures"][0].get("beats"), "insert-after selects an empty measure with the source measure's own rhythm")
    client.click("#undo")
    menu("clear", 0)
    confirm()
    assert_that(all(not cell for row in current()["measures"][0]["rows"].values() for cell in row), "clear measure removes its notes")
    client.click("#undo")
    assert_that(current() == before_insert, "clear measure is fully undoable")

    fixture = import_fixture()
    select(0, "L", 3)
    client.key("ArrowDown")
    assert_that(selected()["measure"] == 1 and selected()["row"] == "R" and selected()["slot"] == 2, "Down from L crosses to the next R row at the same musical offset")
    client.key("ArrowUp")
    assert_that(selected()["measure"] == 0 and selected()["row"] == "L" and selected()["slot"] == 3, "Up crosses back through grids with different divisions")
    select(1, "L", 4)
    client.key("ArrowDown")
    assert_that(selected()["measure"] == 2 and selected()["row"] == "R" and selected()["slot"] == 2, "vertical movement chooses the nearest onset in a coarser grid")
    source = current()
    client.click("#duplicate-tab")
    copied = current()
    library_ids = client.evaluate("Array.from(document.querySelectorAll('[data-tab]')).map(el=>el.dataset.tab)")
    def musical_measures(tab: dict):
        return [{key:value for key,value in measure.items() if key != "id"} for measure in tab["measures"]]
    assert_that(copied["id"] != source["id"] and len(library_ids) == len(set(library_ids)) and musical_measures(copied) == musical_measures(source), "document copy has a unique library ID and preserves rhythms and notes")
    client.evaluate("HangApp.flushSaves()")
    assert_that(json.loads((copied_root / "tabs" / (copied["id"] + ".json")).read_text(encoding="utf-8")) == copied, "the document copy is stored in its own JSON file")
    previous_epoch = client.evaluate("performance.timeOrigin")
    client.call("Page.reload", {"ignoreCache": True})
    client.wait("performance.timeOrigin!==" + json.dumps(previous_epoch) + " && document.readyState==='complete' && window.HangApp && HangApp.getTab().id===" + json.dumps(copied["id"]), "saved copy reopens after reload")
    assert_that(current() == copied, "reload preserves copied notes, hand rows and per-measure divisions")

    playback_tab = import_fixture(transport=True)
    client.fill("#playback-range", "measure", "change")
    checkbox("#playback-loop", False)
    checkbox("#playback-metronome", False)
    select(1, "R", 0)
    client.evaluate("__polishAudio.sounds=[]")
    client.click("#transport-play")
    client.wait("document.querySelector('#play').classList.contains('playing')", "selected-rest measure starts")
    client.wait("!document.querySelector('#play').classList.contains('playing')", "selected-rest measure completes", timeout=3)
    rest_duration = client.evaluate("(() => {const c=__polishAudio.contexts.at(-1);return (c.ended-c.started)/1000;})()")
    assert_that(.6 <= rest_duration < 1.1 and not client.evaluate("__polishAudio.sounds.length"), "an empty selected measure keeps its full duration and makes no note sounds")
    client.fill("#playback-range", "all", "change")
    checkbox("#playback-metronome", True)
    client.evaluate("__polishAudio.sounds=[]")
    client.click("#transport-play")
    client.wait("document.querySelector('#play').classList.contains('playing')", "all-measures transport starts")
    client.wait("document.querySelectorAll('.playhead').length>0", "playhead highlights the running position")
    client.wait("parseFloat(document.querySelector('.playback-bar').style.getPropertyValue('--progress'))>0", "playback progress advances")
    client.wait("!document.querySelector('#play').classList.contains('playing')", "all-measures transport completes", timeout=4)
    sounds = client.evaluate("__polishAudio.sounds")
    notes = [sound for sound in sounds if sound["frequency"] not in (1600, 2400)]
    clicks = [sound for sound in sounds if sound["frequency"] in (1600, 2400)]
    all_duration = client.evaluate("(() => {const c=__polishAudio.contexts.at(-1);return (c.ended-c.started)/1000;})()")
    assert_that(len(notes) == 5 and len(clicks) == 8 and 1.2 <= all_duration < 1.8, "whole-piece playback preserves mixed divisions, both hands, rests and eight quarter-note metronome clicks")
    expected_offsets = [0, .075, .15, .3, .45]
    assert_that(all(abs(sound["time"] - notes[0]["time"] - offset) < .025 for sound, offset in zip(notes, expected_offsets)), "scheduled note offsets follow each measure's own rhythm")
    assert_that(not client.evaluate("document.querySelectorAll('.playhead').length"), "completed playback clears its playhead")

    client.fill("#playback-range", "measure", "change")
    checkbox("#playback-loop", True)
    client.evaluate("__polishAudio.sounds=[]")
    client.click("#transport-play")
    client.wait("__polishAudio.sounds.length>=8", "loop reaches the second rest-measure cycle", timeout=3)
    assert_that(client.evaluate("document.querySelector('#play').classList.contains('playing')"), "selected measure continues looping beyond its first cycle")
    checkbox("#auto-advance", False)
    select(1, "R", 0)
    client.key(" ", code="Space", repeat=True)
    assert_that(client.evaluate("document.querySelector('#play').classList.contains('playing')"), "holding Space does not repeatedly toggle the transport")
    client.click('[data-note="9"]')
    assert_that(not client.evaluate("document.querySelector('#play').classList.contains('playing')") and client.evaluate("__polishAudio.contexts.at(-1).state==='closed'"), "editing stops a looping session and closes its context")
    sound_count = client.evaluate("__polishAudio.sounds.length")
    client.evaluate("new Promise(resolve=>setTimeout(resolve,180))")
    assert_that(client.evaluate("__polishAudio.sounds.length") == sound_count, "a stopped loop leaves no active scheduling callbacks")

    client.evaluate("__polishAudio.gate=true;__polishAudio.sounds=[]")
    client.click("#transport-play")
    client.click("#transport-play")
    client.evaluate("__polishAudio.gate=false;__polishAudio.pending.splice(0).forEach(resolve=>resolve())")
    client.evaluate("new Promise(resolve=>setTimeout(resolve,100))")
    assert_that(not client.evaluate("document.querySelector('#play').classList.contains('playing')") and not client.evaluate("__polishAudio.sounds.length"), "rapid second Play cancels a pending audio resume without stale sounds")
    client.click("#transport-play")
    client.wait("document.querySelector('#play').classList.contains('playing')", "a new session starts normally after a cancelled resume")
    assert_that(client.evaluate("__polishAudio.contexts.filter(c=>c.state==='running').length===1"), "only the current audio context remains active")
    client.click("#transport-play")
    client.evaluate("__polishAudio.gate=true;__polishAudio.sounds=[]")
    client.click("#transport-play")
    client.click('[data-tab="hang-massive"]')
    client.evaluate("__polishAudio.gate=false;__polishAudio.pending.splice(0).forEach(resolve=>resolve());new Promise(resolve=>setTimeout(resolve,180))")
    assert_that(not client.evaluate("__polishAudio.sounds.length") and not client.evaluate("document.querySelector('#play').classList.contains('playing')"), "switching documents cancels a pending audio resume")

    client.fill("#playback-range", "all", "change")
    checkbox("#playback-loop", False)
    checkbox("#playback-metronome", False)
    checkbox("#auto-advance", True)
    client.click('[data-notation="hybrid"]')
    client.evaluate("HangApp.flushSaves()")
    demo = current()
    png, png_bytes = render_png(client, "HangApp.getTab()")
    assert_that(png["type"] == "image/png" and png_bytes.startswith(b"\x89PNG\r\n\x1a\n"), "polished editor still exports the hybrid score as PNG")
    (artifacts / "polish-export.png").write_bytes(png_bytes)
    assert_that(client.evaluate("document.documentElement.scrollWidth<=innerWidth"), "desktop editor has no horizontal page overflow")
    client.screenshot(artifacts / "polish-editor.png")
    client.call("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": True})
    client.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
    assert_that(client.evaluate("innerWidth<=391 && document.documentElement.scrollWidth<=391 && document.body.scrollWidth<=391"), "entry and transport controls fit the mobile 390px viewport")
    client.screenshot(artifacts / "polish-mobile.png")
    assert_that(not client.evaluate("window.__smokeErrors") and not [event for event in client.events if event.get("method") == "Runtime.exceptionThrown"], "editing and transport report no JavaScript runtime errors")
    return {"copy":copied["id"],"playback":{"restSeconds":rest_duration,"allSeconds":all_duration,"notes":len(notes),"metronomeClicks":len(clicks)},"demo":demo["title"],"png":png}


def check_polish_focused(client: CDP, copied_root: Path, artifacts: Path) -> dict:
    """Only regressions for the final keyboard, deletion and mobile CSS fixes."""
    client.evaluate("document.querySelector('.measure-menu summary').focus()")
    client.key("Enter")
    client.wait("Boolean(document.querySelector('.measure-menu[open]'))", "native Enter opens the measure actions")
    assert_that(not client.evaluate("document.querySelector('#cell-dialog').open") and not client.evaluate("__polishAudio.contexts.length"), "Enter on a summary does not open the chord editor or start audio")
    client.key(" ", code="Space")
    client.wait("!document.querySelector('.measure-menu[open]')", "native Space closes the measure actions")
    assert_that(not client.evaluate("document.querySelector('#cell-dialog').open") and not client.evaluate("__polishAudio.contexts.length"), "Space on a summary keeps the editor and transport idle")

    before = client.evaluate("HangApp.getTab()")
    client.click("#toggle-preview")
    assert_that(client.evaluate("document.querySelector('.editor-content').classList.contains('preview') && getComputedStyle(document.querySelector('.playback-bar')).display==='none' && getComputedStyle(document.querySelector('.entry-status')).display==='none' && document.querySelectorAll('#score .note-cell').length>0"), "print preview hides entry and transport controls and keeps the score")
    assert_that(client.evaluate("document.documentElement.scrollWidth<=innerWidth"), "print preview fits the desktop viewport")
    client.click("#toggle-preview")
    assert_that(client.evaluate("HangApp.getTab()") == before and client.evaluate("getComputedStyle(document.querySelector('.playback-bar')).display!=='none'"), "returning from print preview preserves the document and restores transport")

    client.click("#new-tab")
    deleted_id = client.evaluate("HangApp.getTab().id")
    client.evaluate("document.querySelector('[data-cell=\"0,main,0\"]').click();document.querySelector('[data-cell=\"0,main,0\"]').focus()")
    client.key("в", code="KeyD")
    with_note = client.evaluate("HangApp.getTab()")
    client.key("я", code="KeyZ", modifiers=2)
    assert_that(client.evaluate("HangApp.getTab().measures[0].rows.main[0].length===0"), "physical Ctrl+Z undoes entry with the Russian keyboard layout")
    client.key("н", code="KeyY", modifiers=2)
    assert_that(client.evaluate("HangApp.getTab()") == with_note, "physical Ctrl+Y redoes entry with the Russian keyboard layout")
    client.evaluate("HangApp.flushSaves()")
    client.click("#transport-play")
    client.wait("document.querySelector('#play').classList.contains('playing')", "document to delete is playing")
    client.click("#delete-tab")
    client.wait("document.querySelector('#confirm-dialog').open", "document deletion asks for confirmation")
    client.click("#confirm-yes")
    client.wait("!document.querySelector('#confirm-dialog').open && HangApp.getTab().id!==" + json.dumps(deleted_id), "deleting the active document opens another document")
    client.evaluate("HangApp.flushSaves()")
    assert_that(not (copied_root / "tabs" / (deleted_id + ".json")).exists() and client.evaluate("__polishAudio.contexts.every(context=>context.state==='closed')") and not client.evaluate("document.querySelector('#play').classList.contains('playing')"), "deleting the playing document removes its JSON and closes audio safely")

    client.click('[data-tab="hang-massive"]')
    client.click('[data-notation="hybrid"]')
    client.evaluate("HangApp.flushSaves()")
    png, data = render_png(client, "HangApp.getTab()")
    (artifacts / "polish-final-export.png").write_bytes(data)
    client.screenshot(artifacts / "polish-final-editor.png")
    client.call("Emulation.setDeviceMetricsOverride", {"width":390,"height":844,"deviceScaleFactor":1,"mobile":True})
    client.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
    notation = client.evaluate("(() => {const control=document.querySelector('#notation-control');return {control:[control.clientWidth,control.scrollWidth],buttons:[...control.querySelectorAll('button')].map(button=>{const range=document.createRange();range.selectNodeContents(button);const text=range.getBoundingClientRect(),box=button.getBoundingClientRect();return {label:button.textContent,client:button.clientWidth,scroll:button.scrollWidth,textInside:text.left>=box.left-.5&&text.right<=box.right+.5};})};})()")
    assert_that(notation["control"][1] <= notation["control"][0] and all(button["scroll"] <= button["client"] and button["textInside"] for button in notation["buttons"]), "all three notation glyph boxes fit their own buttons at 390px: " + str(notation))
    assert_that(client.evaluate("innerWidth<=391 && document.documentElement.scrollWidth<=391 && document.body.scrollWidth<=391"), "final mobile layout has no horizontal page overflow")
    client.screenshot(artifacts / "polish-final-mobile.png")
    assert_that(not client.evaluate("window.__smokeErrors") and not [event for event in client.events if event.get("method") == "Runtime.exceptionThrown"], "final keyboard, preview and deletion changes report no runtime errors")
    return {"deleted":deleted_id,"notation":notation,"png":png}


def check_polish_concurrent(client: CDP, copied_root: Path) -> dict:
    client.click("#new-tab")
    client.fill("#tab-title", "Пульс · удаляемая копия")
    first_id = client.evaluate("HangApp.getTab().id")
    client.evaluate("HangApp.flushSaves()")
    client.click("#delete-tab")
    client.wait("document.querySelector('#confirm-dialog').open", "copy deletion confirmation opens")
    imported = client.evaluate("""(async () => {const tab=HangApp.getTab();tab.title='Пульс · завершённый импорт';await HangApp.importFile(new File([JSON.stringify(tab)],'pending-import.json',{type:'application/json'}));return HangApp.getTab();})()""")
    assert_that(imported["id"] != first_id and client.evaluate("document.querySelector('#confirm-dialog').open"), "an asynchronous import can finish while another document's deletion is being confirmed")
    client.click("#confirm-yes")
    client.wait("!document.querySelector('#confirm-dialog').open", "deletion confirmation finishes")
    client.evaluate("HangApp.flushSaves()")
    assert_that(client.evaluate("HangApp.getTab()") == imported and not client.evaluate("Boolean(document.querySelector('[data-tab=" + json.dumps(first_id) + "]'))") and not (copied_root / "tabs" / (first_id + ".json")).exists(), "confirming deletion removes only the original copy and keeps the imported document open")
    assert_that(json.loads((copied_root / "tabs" / (imported["id"] + ".json")).read_text(encoding="utf-8")) == imported, "the concurrently imported document remains intact on disk")
    client.evaluate("(() => {const stale=document.createElement('button');stale.dataset.tab='missing-tab';document.querySelector('#library').append(stale);stale.click();stale.remove();})()")
    assert_that(client.evaluate("HangApp.getTab().id") == imported["id"], "a stale library click cannot switch to a missing document")
    assert_that(not client.evaluate("window.__smokeErrors") and not [event for event in client.events if event.get("method") == "Runtime.exceptionThrown"], "concurrent import and deletion report no runtime errors")
    return {"deleted":first_id,"retained":imported["id"]}


def run_checks(client: CDP, url: str, copied_root: Path, artifacts: Path, hybrid_only: bool = False, numbered_only: bool = False, polish_only: bool = False, focused_only: bool = False, concurrent_only: bool = False):
    print("Starting isolated browser checks", flush=True)
    client.call("Page.enable")
    client.call("Runtime.enable")
    client.call("Log.enable")
    client.call("Page.addScriptToEvaluateOnNewDocument", {"source": """
      window.__smokeErrors = [];
      addEventListener('error', event => window.__smokeErrors.push(event.message));
      addEventListener('unhandledrejection', event => window.__smokeErrors.push(String(event.reason)));
      window.__smokeSounds=[];
      const NativeAudioContext=window.AudioContext;
      if(NativeAudioContext) window.AudioContext=class extends NativeAudioContext {
        resume() { return super.resume().then(()=>{window.__smokePlayStart=performance.now();}); }
        close() { window.__smokePlayEnd=performance.now(); return super.close(); }
        createOscillator() {
          const oscillator=super.createOscillator(),start=oscillator.start.bind(oscillator);
          oscillator.start=time=>{window.__smokeSounds.push({time});start(time);};
          return oscillator;
        }
      };
    """})
    if polish_only or focused_only:
        client.call("Page.addScriptToEvaluateOnNewDocument", {"source": POLISH_AUDIO_MOCK})
    client.call("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 1100, "deviceScaleFactor": 1, "mobile": False})
    client.call("Page.navigate", {"url": url})
    client.wait("Boolean(document.readyState === 'complete' && window.HangExport && document.querySelector('#score .note-cell'))", "editor startup")
    assert_that(client.evaluate("document.querySelectorAll('#library .library-item').length > 0"), "sample library opens")
    if concurrent_only:
        return {"concurrent":check_polish_concurrent(client, copied_root)}
    if focused_only:
        return {"focused":check_polish_focused(client, copied_root, artifacts)}
    if polish_only:
        return {"polish": check_polish(client, copied_root, artifacts)}
    if numbered_only:
        return {"numberedHybrid": check_numbered_hybrid(client, copied_root, artifacts)}
    if hybrid_only:
        return {"hybrid": check_hybrid(client, copied_root, artifacts)}
    client.click("#new-tab")
    client.wait("Boolean(document.querySelector('#score .note-cell'))", "new score")
    title = "Пульс · проверка редактора"
    client.fill("#tab-title", title)
    client.evaluate("""(() => {
      window.__manualSaveFetch = window.fetch;
      window.fetch = (url, options) => options?.method === 'POST' && String(url) === '/api/tabs'
        ? Promise.resolve(new Response('{"error":"simulated write failure"}', {status:503}))
        : window.__manualSaveFetch(url, options);
    })()""")
    client.evaluate("HangApp.saveChanges()")
    assert_that(client.evaluate("document.querySelector('#save-status').dataset.fileState === 'error' && !document.querySelector('#save-changes').disabled"), "manual server-save failure keeps an error status and allows retry")
    assert_that(client.evaluate("HangApp.getTab().title") == title, "failed manual server save retains the edited document")
    client.evaluate("window.fetch = window.__manualSaveFetch; delete window.__manualSaveFetch")
    client.click("#save-changes")
    saved_expression = """(async () => {
      const body = await (await fetch('/api/tabs')).json();
      return body.tabs.find(tab => tab.title === TITLE) || null;
    })()""".replace("TITLE", json.dumps(title))
    tab = client.wait(saved_expression, "new tab saved on disk")
    client.wait("document.querySelector('#save-status').dataset.fileState === 'saved' && !document.querySelector('#save-changes').disabled", "manual server-save retry completes")
    assert_that(json.loads((copied_root / "tabs" / (tab["id"] + ".json")).read_text(encoding="utf-8")) == client.evaluate("HangApp.getTab()"), "Save Changes writes the current document to tabs in server mode")
    assert_that(tab["meter"] == {"numerator": 4, "denominator": 4}, "new tab uses 4/4")

    client.evaluate("document.querySelector('#score .note-cell').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))")
    client.wait("document.querySelector('#cell-dialog').open", "chord editor opens")
    client.fill("#cell-value", "D/4")
    client.click("#confirm-cell")
    client.wait("!document.querySelector('#cell-dialog').open", "chord editor closes")
    tab = client.wait("(async () => { const tab = await " + saved_expression + "; return tab?.measures[0].rows.main[0].join('/') === 'D/4' ? tab : null; })()", "chord save")
    assert_that(tab["measures"][0]["rows"]["main"][0] == ["D", "4"], "chord D/4 edits through the UI")

    mixed_rhythm = check_measure_rhythms(client, artifacts)
    tab = client.evaluate(saved_expression)
    before_notation = tab["measures"]
    client.click('[data-notation="konnakol"]')
    tab = client.wait("(async () => { const tab = await " + saved_expression + "; return tab?.notation === 'konnakol' ? tab : null; })()", "konnakol save")
    assert_that(tab["measures"] == before_notation, "konnakol switches labels and preserves notes")
    assert_that(client.evaluate("!document.querySelector('#konnakol-panel').hidden"), "konnakol phrase controls appear")

    client.fill("#hands", "split", "change")
    tab = client.wait("(async () => { const tab = await " + saved_expression + "; return tab?.hands === 'split' ? tab : null; })()", "split-hand save")
    labels = client.evaluate("Array.from(document.querySelectorAll('#score .hand-notes small')).map(el => el.textContent.trim())")
    assert_that("R" in labels and "L" in labels and tab["measures"][0]["rows"]["R"][0] == ["D", "4"], "split hands show R/L and retain the chord")
    stored = copied_root / "tabs" / (tab["id"] + ".json")
    assert_that(json.loads(stored.read_text(encoding="utf-8")) == tab, "saved JSON matches the edited document")

    previous_epoch = client.evaluate("performance.timeOrigin")
    client.call("Page.reload", {"ignoreCache": True})
    client.wait("performance.timeOrigin !== " + json.dumps(previous_epoch) + " && document.readyState === 'complete' && [...document.querySelectorAll('#library .library-item')].some(el => el.textContent.includes(" + json.dumps(title) + "))", "saved document appears after reload")
    client.evaluate("[...document.querySelectorAll('#library .library-item')].find(el => el.textContent.includes(" + json.dumps(title) + ")).click()")
    client.wait("document.querySelector('#tab-title').value === " + json.dumps(title), "saved document reopens")
    reopened = client.evaluate(saved_expression)
    assert_that(reopened == tab, "reload reopens all saved edits")

    png, png_bytes = render_png(client, saved_expression)
    assert_that(png["type"] == "image/png" and png_bytes.startswith(b"\x89PNG\r\n\x1a\n") and png["width"] > 500 and png["height"] > 200, "PNG export produces a valid, decodable image")
    (artifacts / "mixed-hands-export.png").write_bytes(png_bytes)
    client.screenshot(artifacts / "mixed-hands-editor.png")

    client.call("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": True})
    client.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    mobile = client.evaluate("({width:innerWidth, client:document.documentElement.clientWidth, page:document.documentElement.scrollWidth, body:document.body.scrollWidth})")
    assert_that(mobile["width"] <= 391 and mobile["page"] <= 391 and mobile["body"] <= 391, "mobile layout fits the requested 390px viewport: " + str(mobile))
    client.screenshot(artifacts / "mixed-mobile.png")
    errors = client.evaluate("window.__smokeErrors")
    exceptions = [event.get("params", {}).get("exceptionDetails", {}) for event in client.events if event.get("method") == "Runtime.exceptionThrown"]
    assert_that(not errors and not exceptions, "browser reports no JavaScript runtime errors")

    client.call("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 1100, "deviceScaleFactor": 1, "mobile": False})
    disk_ids = client.evaluate("(async () => (await (await fetch('/api/tabs')).json()).tabs.map(tab => tab.id))()")
    file_count = len(list((copied_root / "tabs").glob("*.json")))
    client.click('[data-tab="hang-2"]')
    original_title = client.evaluate("HangApp.getTab().title")
    renamed_title = original_title + " · QA"
    client.fill("#tab-title", renamed_title)
    client.evaluate("HangApp.flushSaves()")
    previous_epoch = client.evaluate("performance.timeOrigin")
    client.call("Page.reload", {"ignoreCache": True})
    client.wait("performance.timeOrigin !== " + json.dumps(previous_epoch) + " && document.readyState === 'complete' && document.querySelector('#tab-title')?.value === " + json.dumps(renamed_title), "renamed sample reopens")
    renamed_tabs = client.evaluate("(async () => (await (await fetch('/api/tabs')).json()).tabs)()")
    renamed_ids = [item["id"] for item in renamed_tabs]
    assert_that(sorted(renamed_ids) == sorted(disk_ids) and len(set(renamed_ids)) == len(renamed_ids) and len(list((copied_root / "tabs").glob("*.json"))) == file_count, "renaming and reloading a sample preserves unique IDs and file count")
    client.fill("#tab-title", original_title)
    client.evaluate("HangApp.flushSaves()")

    client.click('[data-tab="hang-massive"]')
    client.wait("HangApp.getTab().id === 'hang-massive'", "real Hang Massive sample opens")
    demo_png, demo_bytes = render_png(client, "HangApp.getTab()")
    client.call("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": True})
    client.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    assert_that(client.evaluate("innerWidth <= 391 && document.documentElement.scrollWidth <= 391"), "real sample also fits the mobile viewport")
    return {"document": tab["id"], "png": png, "mobile": mobile, "mixedRhythm": mixed_rhythm, "demo": {"title": "Hang Massive", "png": demo_png}}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--edge", type=Path, default=DEFAULT_EDGE)
    parser.add_argument("--no-sandbox", action="store_true", help="For restricted automation environments where Edge child processes cannot start")
    parser.add_argument("--hybrid-only", action="store_true", help="Run only the bounded hybrid-notation regression")
    parser.add_argument("--hybrid-numbered-only", action="store_true", help="Run only the hybrid beat-number/header regression")
    parser.add_argument("--polish-only", action="store_true", help="Run only editing and transport regressions with a deterministic AudioContext")
    parser.add_argument("--polish-focused-only", action="store_true", help="Run only the final summary-keyboard, deletion, preview and mobile-label regressions")
    parser.add_argument("--polish-concurrent-only", action="store_true", help="Run only a pending import finishing during document deletion")
    parser.add_argument("--artifacts", type=Path, default=PROJECT / "artifacts", help="Directory for this run's screenshots and logs")
    args = parser.parse_args()
    if not args.edge.is_file():
        parser.error("Edge executable not found; pass --edge PATH.")
    required = ("index.html", "app.js", "core.js", "export.js", "styles.css", "playback.js")
    for name in required:
        if not (PROJECT / name).is_file():
            parser.error(f"UI is not ready: missing {name}.")
    artifacts = args.artifacts.resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    profile = PROJECT / "tests" / ".browser-profile"
    profile.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="hang-browser-smoke-") as temporary:
        copied_root = Path(temporary).resolve()
        if not copied_root.is_relative_to(Path(tempfile.gettempdir()).resolve()):
            raise RuntimeError("Unexpected temporary directory location.")
        for path in PROJECT.iterdir():
            if path.is_file() and path.suffix.lower() in (".html", ".js", ".css"):
                shutil.copy2(path, copied_root / path.name)
        if (PROJECT / "tabs").is_dir():
            (copied_root / "tabs").mkdir()
            for path in (PROJECT / "tabs").glob("*.json"):
                if path.is_file() and not path.is_symlink():
                    shutil.copy2(path, copied_root / "tabs" / path.name)
        server = create_server(copied_root)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        with socket.socket() as free_port:
            free_port.bind(("127.0.0.1", 0))
            debug_port = free_port.getsockname()[1]
        process = None
        client = None
        artifact_prefix = "polish-concurrent-" if args.polish_concurrent_only else "polish-final-" if args.polish_focused_only else "polish-" if args.polish_only else "hybrid-numbered-" if args.hybrid_numbered_only else "hybrid-" if args.hybrid_only else ""
        browser_log = (artifacts / (artifact_prefix + "browser-stderr.log")).open("wb")
        try:
            browser_args = [
                str(args.edge), "--headless=new", "--disable-gpu", "--in-process-gpu", "--no-first-run", "--no-default-browser-check",
                "--disable-extensions", "--disable-background-networking", "--mute-audio", "--hide-scrollbars",
                "--remote-debugging-address=127.0.0.1", f"--remote-debugging-port={debug_port}",
                f"--user-data-dir={profile}", "--window-size=1440,1100", "about:blank",
            ]
            if args.no_sandbox:
                browser_args.append("--no-sandbox")
            process = subprocess.Popen(browser_args, stdout=subprocess.DEVNULL, stderr=browser_log, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            client = CDP(wait_debugger(debug_port, process))
            result = run_checks(client, f"http://127.0.0.1:{server.server_port}/", copied_root, artifacts, args.hybrid_only, args.hybrid_numbered_only, args.polish_only, args.polish_focused_only, args.polish_concurrent_only)
            (artifacts / (artifact_prefix + "browser-smoke.json")).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
            (artifacts / (artifact_prefix + "browser-failure.png")).unlink(missing_ok=True)
            print("Browser smoke passed. Artifacts: " + str(artifacts), flush=True)
            return 0
        except Exception as error:
            if client:
                try:
                    client.screenshot(artifacts / (artifact_prefix + "browser-failure.png"))
                except Exception:
                    pass
            print(f"FAIL {type(error).__name__}: {error}", file=sys.stderr, flush=True)
            return 1
        finally:
            if client:
                try:
                    client.call("Browser.close")
                except (OSError, RuntimeError):
                    pass
                client.close()
            if process:
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)
            browser_log.close()


if __name__ == "__main__":
    raise SystemExit(main())
