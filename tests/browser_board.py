"""Board editing regression in a real headless browser and temporary library."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading

from browser_smoke import CDP, DEFAULT_EDGE, PROJECT, create_server, render_png, wait_debugger


def main():
    artifacts = PROJECT / 'artifacts' / 'board-desktop'
    artifacts.mkdir(parents=True, exist_ok=True)
    checks = []
    installed_browser = Path(os.environ.get('LOCALAPPDATA', '')) / 'ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'
    browser = Path(os.environ.get('BROWSER_BIN', str(installed_browser if installed_browser.is_file() else DEFAULT_EDGE)))
    with tempfile.TemporaryDirectory(prefix='hang-board-') as temporary:
        base = Path(temporary).resolve()
        root = base / 'app'
        root.mkdir()
        for path in PROJECT.iterdir():
            if path.is_file() and path.suffix.lower() in ('.html', '.js', '.css'):
                shutil.copy2(path, root / path.name)
        server = create_server(root)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        client = None
        process = None
        with (artifacts / 'browser.log').open('wb') as log:
            try:
                process = subprocess.Popen([
                    str(browser), '--headless=new', '--disable-gpu', '--in-process-gpu', '--no-sandbox',
                    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
                    '--disable-background-networking', '--mute-audio', '--hide-scrollbars',
                    '--remote-debugging-address=127.0.0.1', f'--remote-debugging-port={port}',
                    f'--user-data-dir={base / "profile"}', '--window-size=1440,1100', 'about:blank',
                ], stdout=subprocess.DEVNULL, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                client = CDP(wait_debugger(port, process))
                client.call('Page.enable')
                client.call('Runtime.enable')
                client.call('Page.navigate', {'url': f'http://127.0.0.1:{server.server_port}/'})
                client.wait('window.HangApp && document.getElementById("tab-title").value', 'editor ready')

                def check(expression, message):
                    if not client.evaluate(expression):
                        raise AssertionError(message)
                    checks.append(message)
                    print('PASS ' + message, flush=True)

                def select(slot, row='main'):
                    client.evaluate(f'HangApp.selectCell({{measure:0,row:{json.dumps(row)},slot:{slot}}})')

                client.evaluate('''(async () => {
                    const tab=HangCore.createTab({title:'Свободный ритм · ячейки и руки'});
                    tab.measures=tab.measures.slice(0,2);
                    tab.measures[0].rows.main=[['D'],['S'],['K'],['4']];
                    await HangApp.importFile(new File([JSON.stringify(tab)],'board.json',{type:'application/json'}));
                })()''')
                client.wait('HangApp.getTab().title.startsWith("Свободный ритм")', 'test document')
                client.evaluate('window.boardOtherMeasure=JSON.stringify(HangApp.getTab().measures[1])')
                client.evaluate('window.beforeCustomSplit=JSON.stringify(HangApp.getTab())')
                select(1)
                client.click('#split-cell-4')
                check('HangCore.slots(HangApp.getTab(),0).length===7 && HangCore.slots(HangApp.getTab(),0).slice(1,5).every(slot=>slot.durationFraction==="1/16")', 'direct divide-by-four creates four sixteenths')
                client.click('#undo')
                for parts in (6, 8, 24, 64):
                    select(1)
                    client.click('#split-cell-custom')
                    client.fill('#split-parts', str(parts))
                    check(f'document.getElementById("split-preview").textContent.includes("1/{parts*4}")', f'custom {parts}-way split previews exact duration')
                    client.click('#confirm-split')
                    client.wait(f'HangCore.slots(HangApp.getTab(),0).length==={parts+3} && !document.getElementById("split-dialog").open', f'custom split into {parts}')
                    check(f'HangApp.getTab().measures[0].rows.main[1][0]==="S" && HangApp.getTab().measures[0].rows.main[{parts+1}][0]==="K" && HangCore.slots(HangApp.getTab(),0)[{parts+1}].offset===2 && Math.abs(HangCore.slots(HangApp.getTab(),0).reduce((sum,slot)=>sum+slot.duration,0)-4)<1e-9 && JSON.stringify(HangApp.getTab().measures[1])===window.boardOtherMeasure', f'custom {parts}-way split preserves notes, other bars and meter')
                    if parts == 64:
                        check('["split-cell-2","split-cell-3","split-cell-4","split-cell-custom"].every(id=>document.getElementById(id).disabled)', 'full beat disables additional split buttons')
                    client.click('#undo')
                    check('JSON.stringify(HangApp.getTab())===window.beforeCustomSplit', f'undo restores the original {parts}-way split input')
                select(1)
                client.click('#split-cell-custom')
                for invalid in ('', '1', '2.5', '65'):
                    client.fill('#split-parts', invalid)
                    client.click('#confirm-split')
                    check('document.getElementById("split-dialog").open && document.getElementById("split-parts").getAttribute("aria-invalid")==="true" && !document.getElementById("split-error").hidden && JSON.stringify(HangApp.getTab())===window.beforeCustomSplit', f'invalid custom split {invalid!r} keeps dialog and score unchanged')
                client.fill('#split-parts', '8')
                check('document.getElementById("split-error").hidden && document.getElementById("split-parts").getAttribute("aria-invalid")==="false"', 'correcting the integer clears the inline error')
                client.key('Enter')
                client.wait('HangCore.slots(HangApp.getTab(),0).length===11 && !document.getElementById("split-dialog").open', 'Enter applies corrected custom split')
                client.click('#undo')
                select(1)
                client.click('#split-cell-4')
                client.evaluate('window.beforeCapacityError=JSON.stringify(HangApp.getTab())')
                client.click('#split-cell-custom')
                check('document.getElementById("split-parts").max==="61" && document.getElementById("split-limit").textContent.includes("61")', 'custom dialog explains remaining beat capacity')
                client.fill('#split-parts', '62')
                client.click('#confirm-split')
                check('document.getElementById("split-dialog").open && !document.getElementById("split-error").hidden && JSON.stringify(HangApp.getTab())===window.beforeCapacityError', 'capacity rejection remains atomic and visible in the dialog')
                client.call('Input.dispatchKeyEvent', {'type':'keyDown','key':'Escape','code':'Escape','windowsVirtualKeyCode':27,'nativeVirtualKeyCode':27})
                client.call('Input.dispatchKeyEvent', {'type':'keyUp','key':'Escape','code':'Escape','windowsVirtualKeyCode':27,'nativeVirtualKeyCode':27})
                check('!document.getElementById("split-dialog").open && JSON.stringify(HangApp.getTab())===window.beforeCapacityError', 'Escape cancels custom splitting without changing the score')
                client.click('#undo')
                select(1)
                client.click('#split-cell-2')
                client.wait('HangCore.slots(HangApp.getTab(),0).length===5', 'first split')
                select(2)
                client.click('#split-cell-2')
                client.wait('HangCore.slots(HangApp.getTab(),0).length===6', 'nested split')
                check('JSON.stringify(HangCore.slots(HangApp.getTab(),0).map(s=>s.durationFraction))===JSON.stringify(["1/4","1/8","1/16","1/16","1/4","1/4"])', 'only selected eighth becomes two sixteenths')
                check('HangCore.slots(HangApp.getTab(),0).reduce((sum,s)=>sum+s.duration,0)===4 && JSON.stringify(HangApp.getTab().measures[1])===window.boardOtherMeasure', 'meter and other measure remain exact')
                check('HangApp.getTab().measures[0].rows.main[4][0]==="K" && HangCore.slots(HangApp.getTab(),0)[4].offset===2', 'later hits retain original onsets')
                check('document.getElementById("cell-duration").textContent.includes("1/16") && [...document.querySelectorAll("[data-measure=\\"0\\"] [data-count-slot]")].map(e=>e.textContent).join(" ") === "1 2 (1 2) 3 4"', 'subdivision count and exact duration are visible')
                client.click('#undo')
                check('HangCore.slots(HangApp.getTab(),0).length===5', 'undo subdivision')
                client.click('#redo')
                check('HangCore.slots(HangApp.getTab(),0).length===6', 'redo subdivision')
                select(2)
                client.click('#merge-cell')
                client.wait('HangCore.slots(HangApp.getTab(),0).length===5', 'merge siblings')
                client.click('#undo')
                select(2)
                client.click('#edit-syllable')
                client.fill('#syllable-value', 'Da')
                client.click('#syllable-form [value=save]')
                client.click('[data-notation=konnakol]')
                check('HangCore.slots(HangApp.getTab(),0)[2].displayLabel==="Da"', 'individual syllable can be edited in selected cell')
                client.click('#edit-pattern')
                check('[...document.querySelectorAll("[data-pattern]")].map(e=>e.value).join(" ")==="Ta Ka Di Mi Ta Ka Jo Nu"', 'default syllable scheme is unchanged')
                client.fill('[data-pattern="0"]', 'Pa')
                client.click('#pattern-form [value=save]')
                check('HangCore.slots(HangApp.getTab(),0)[0].displayLabel==="Pa" && HangCore.slots(HangApp.getTab(),0)[2].displayLabel==="Da"', 'global pattern updates automatic syllables and preserves manual syllable')
                client.click('[data-notation=hybrid]')
                check('document.querySelectorAll("[data-measure=\\"0\\"] .hybrid-beat").length===1', 'hybrid view retains beat numbers above split cells')
                client.fill('#hands', 'split', 'change')
                if client.evaluate('document.getElementById("auto-advance").checked'):
                    client.click('#auto-advance')
                select(2, 'R')
                client.click('[data-entry-hand=L]')
                client.click('[data-note="8"]')
                check('HangApp.getTab().measures[0].rows.L[2][0]==="8" && HangApp.getTab().measures[0].rows.R[1][0]==="S"', 'hand selector writes left notes without changing right notes')
                client.evaluate('window.beforeHandCustomSplit=JSON.stringify(HangApp.getTab())')
                client.click('#split-cell-custom')
                client.fill('#split-parts', '6')
                client.click('#confirm-split')
                client.wait('HangCore.slots(HangApp.getTab(),0).length===11 && !document.getElementById("split-dialog").open', 'custom split of a hand cell')
                check('HangApp.getTab().measures[0].rows.L[2][0]==="8" && HangApp.getTab().measures[0].rows.R[1][0]==="S" && [2,3,4,5,6,7].every(slot=>HangCore.cellHands(HangApp.getTab(),0,slot)==="split")', 'custom subdivision preserves both hands and inherits their mode')
                client.click('#undo')
                check('JSON.stringify(HangApp.getTab())===window.beforeHandCustomSplit', 'undo restores the original hand cell after a custom split')
                check('document.querySelectorAll("[data-measure=\\"0\\"] .note-cell").length===6 && document.querySelectorAll("[data-measure=\\"0\\"] .note-cell [data-hand]").length===12', 'two hands share one physical cell per time position')
                check('getComputedStyle(document.querySelector(".hand-R")).color!==getComputedStyle(document.querySelector(".hand-L")).color', 'right and left notes have different colors')
                client.click('#hand-colors')
                check('HangApp.getTab().handColors===false && getComputedStyle(document.querySelector(".hand-R")).color===getComputedStyle(document.querySelector(".hand-L")).color', 'monochrome preserves visible R/L labels')
                client.click('#hand-colors')
                client.click('[data-entry-hand=R]')
                client.click('[data-entry-mode=paint]')
                client.click('[data-note="7"]')
                client.evaluate('window.beforeStroke=JSON.stringify(HangApp.getTab());document.querySelector("[data-measure=\\"0\\"] .note-cell").scrollIntoView({block:"center"})')
                points = client.evaluate('''[2,3,4].map(s=>{const r=document.querySelector(`[data-cell="0,R,${s}"]`).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})''')
                client.call('Input.dispatchMouseEvent', {'type':'mouseMoved', **points[0]})
                client.call('Input.dispatchMouseEvent', {'type':'mousePressed', 'button':'left', 'buttons':1, 'clickCount':1, **points[0]})
                for point in points[1:]:
                    client.call('Input.dispatchMouseEvent', {'type':'mouseMoved', 'button':'left', 'buttons':1, **point})
                client.call('Input.dispatchMouseEvent', {'type':'mouseReleased', 'button':'left', 'buttons':0, 'clickCount':1, **points[-1]})
                check('[2,3,4].every(i=>HangApp.getTab().measures[0].rows.R[i][0]==="7") && HangApp.getTab().measures[0].rows.L[2][0]==="8"', 'marker drag fills several cells and preserves the other hand')
                client.click('#undo')
                check('JSON.stringify(HangApp.getTab())===window.beforeStroke', 'one undo reverses the entire marker stroke')
                client.click('#redo')
                client.click('[data-entry-mode=select]')
                select(4, 'R')
                client.evaluate('window.beforeHandMode=HangApp.getTab()')
                client.click('#toggle-cell-hands')
                check('HangCore.cellHands(HangApp.getTab(),0,4)==="single" && HangApp.getTab().measures[0].rows.main[4][0]==="7" && !HangApp.getTab().measures[0].rows.R[4].length', 'one R/L cell becomes neutral and preserves its note')
                check('[0,1,2,3,5].every(i=>["main","R","L"].every(row=>JSON.stringify(HangApp.getTab().measures[0].rows[row][i])===JSON.stringify(window.beforeHandMode.measures[0].rows[row][i])))', 'local hand mode leaves every other cell unchanged')
                check('!document.querySelector("[data-cell=\\"0,main,4\\"] [data-hand]") && document.querySelectorAll("[data-cell$=\\",3\\"] [data-hand]").length>0', 'neutral cell and two-hand cell coexist in one grid')
                client.click('#split-cell-2')
                check('HangCore.cellHands(HangApp.getTab(),0,4)==="single" && HangCore.cellHands(HangApp.getTab(),0,5)==="single" && HangCore.cellHands(HangApp.getTab(),0,6)==="split"', 'subdivided children inherit only their parent hand mode')
                client.click('#undo')
                select(3, 'R')
                client.click('[data-entry-mode=paint]')
                client.click('[data-note="6"]')
                client.evaluate('window.beforeMixedStroke=JSON.stringify(HangApp.getTab());document.querySelector("[data-measure=\\"0\\"] .note-cell").scrollIntoView({block:"center"})')
                points = client.evaluate('''[3,4,5].map(s=>{const cells=[...document.querySelectorAll('[data-measure="0"] .note-cell')];const b=cells[s].getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})''')
                client.call('Input.dispatchMouseEvent', {'type':'mouseMoved', **points[0]})
                client.call('Input.dispatchMouseEvent', {'type':'mousePressed','button':'left','buttons':1,'clickCount':1, **points[0]})
                for point in points[1:]:
                    client.call('Input.dispatchMouseEvent', {'type':'mouseMoved','button':'left','buttons':1, **point})
                client.call('Input.dispatchMouseEvent', {'type':'mouseReleased','button':'left','buttons':0,'clickCount':1, **points[-1]})
                check('HangApp.getTab().measures[0].rows.R[3][0]==="6" && HangApp.getTab().measures[0].rows.main[4][0]==="6" && HangApp.getTab().measures[0].rows.R[5][0]==="6" && !HangApp.getTab().measures[0].rows.R[4].length', 'one marker stroke crosses hand and neutral cells without hidden notes')
                client.click('#undo')
                check('JSON.stringify(HangApp.getTab())===window.beforeMixedStroke', 'one undo restores a mixed-hand marker stroke')
                client.click('#redo')
                client.click('[data-entry-mode=select]')
                if not client.evaluate('document.getElementById("auto-advance").checked'):
                    client.click('#auto-advance')
                select(3, 'R')
                client.click('[data-note="9"]')
                check('document.querySelector(".note-cell.selected").dataset.cell==="0,main,4"', 'auto advance selects neutral row in the next cell')
                client.click('[data-note="D"]')
                check('HangApp.getTab().measures[0].rows.main[4][0]==="D" && !HangApp.getTab().measures[0].rows.R[4].length && document.querySelector(".note-cell.selected").dataset.cell==="0,R,5"', 'entry after auto advance stays visible and returns to right hand')
                client.evaluate('HangApp.flushSaves()')
                snapshot = client.evaluate('HangApp.getTab()')
                png, pixels = render_png(client, 'HangApp.getTab()')
                (artifacts / 'board-export.png').write_bytes(pixels)
                check('!document.querySelector("dialog[open]")', 'editor is ready after edits')
                client.wait('document.getElementById("toast").hidden || getComputedStyle(document.getElementById("toast")).opacity==="0"', 'notification clears before screenshot')
                client.screenshot(artifacts / 'board-editor-ready.png')
                epoch = client.evaluate('performance.timeOrigin')
                client.call('Page.reload')
                client.wait('performance.timeOrigin !== '+json.dumps(epoch)+' && window.HangApp && document.getElementById("tab-title").value.startsWith("Свободный ритм")', 'saved document reload')
                if client.evaluate('HangApp.getTab()') != snapshot:
                    raise AssertionError('all rhythm, syllable, color and hand settings survive reload')
                checks.append('all rhythm, syllable, color and hand settings survive reload')
                for width in (390, 320):
                    client.call('Emulation.setDeviceMetricsOverride', {'width':width,'height':844,'deviceScaleFactor':1,'mobile':True})
                    client.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                    check('document.documentElement.scrollWidth<=innerWidth', f'desktop responsive layout fits {width}px')
                    check('[...document.querySelectorAll("[data-notation]")].every(e=>{const r=e.getBoundingClientRect();return r.width>0 && r.height>0})', f'notation switch remains visible at {width}px')
                    client.click('[data-notation=count]')
                    client.click('[data-notation=konnakol]')
                    client.click('[data-notation=hybrid]')
                    check('HangApp.getTab().notation==="hybrid"', f'notation switch works at {width}px')
                client.screenshot(artifacts / 'board-responsive.png')
                client.click('#split-cell-custom')
                client.fill('#split-parts', '6')
                check('document.documentElement.scrollWidth<=innerWidth && (()=>{const r=document.getElementById("split-dialog").getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.height<=innerHeight})()', 'custom split dialog fits a 320px viewport')
                client.screenshot(artifacts / 'custom-split-responsive.png')
                client.click('#split-dialog [data-close-split]')
                client.evaluate('window.savedMixedId=HangApp.getTab().id')
                client.evaluate('''(async()=>{const tab=HangCore.createTab({title:'Локальные руки',hands:'single'});tab.measures=tab.measures.slice(0,1);tab.measures[0].rows.main=[['D'],['2'],['3'],['4']];await HangApp.importFile(new File([JSON.stringify(tab)],'local-hands.json',{type:'application/json'}));})()''')
                select(1)
                client.click('#toggle-cell-hands')
                check('HangApp.getTab().hands==="single" && HangCore.cellHands(HangApp.getTab(),0,1)==="split" && HangApp.getTab().measures[0].rows.R[1][0]==="2" && HangCore.cellHands(HangApp.getTab(),0,0)==="single"', 'single-row tab supports one independent R/L cell')
                client.click('[data-entry-hand=L]')
                client.click('[data-note="8"]')
                check('HangApp.getTab().measures[0].rows.L[1][0]==="8" && HangApp.getTab().measures[0].rows.main[2][0]==="3"', 'local left-hand input works under global single-row mode')
                client.evaluate('document.querySelector(`[data-tab="${window.savedMixedId}"]`).click()')
                (artifacts / 'results.json').write_text(json.dumps({'checks':checks,'png':png},ensure_ascii=False,indent=2),encoding='utf-8')
                print(f'PASS {len(checks)} board checks; artifacts: {artifacts}',flush=True)
                return 0
            finally:
                if client:
                    try:
                        client.call('Browser.close')
                    except (OSError, RuntimeError):
                        pass
                    client.close()
                if process:
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.terminate()
                        process.wait(timeout=5)
                server.shutdown()
                server.server_close()
                worker.join(timeout=5)


if __name__ == '__main__':
    raise SystemExit(main())
