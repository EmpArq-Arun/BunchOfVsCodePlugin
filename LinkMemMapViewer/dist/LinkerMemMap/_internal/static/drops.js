// ═══════════════════════════════════════════════════════════════════════════
// FILE DROPS  — the only file that handles user file input
//
// Why this was broken before:
//   1. JSON.stringify inside onclick="" attributes corrupted the HTML parser
//      so getElementById() returned null and NO event listeners fired
//   2. Overlaid invisible input ate clicks before div handler ran
//   3. pointer-events on child elements blocked the click from reaching input
//
// Fix: inputs are display:none. Div click calls input.click() explicitly.
//      All wiring runs inside DOMContentLoaded so DOM is guaranteed ready.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

function initDropZones() {
    wireLDDropZone();   // multi-file capable
    wireDropZone('elf-drop', 'elf-fi', handleELFFile);
    wireDropZone('map-drop', 'map-fi', handleMapFile);
    wireWindowDrop();
    console.log('[drops] Drop zones wired');
}

function wireDropZone(divId, inputId, cb) {
    const div = document.getElementById(divId);
    const inp = document.getElementById(inputId);
    if (!div || !inp) { console.error('[drops] Missing element:', divId, inputId); return; }

    div.addEventListener('dragover',  function(e){ e.preventDefault(); e.stopPropagation(); div.classList.add('over'); });
    div.addEventListener('dragleave', function(e){ e.stopPropagation(); div.classList.remove('over'); });
    div.addEventListener('drop', function(e){
        e.preventDefault(); e.stopPropagation();
        div.classList.remove('over');
        var f = e.dataTransfer && e.dataTransfer.files[0];
        if (f) cb(f);
    });
    div.addEventListener('click', function(e){
        if (e.target === inp) return;
        inp.click();
    });
    inp.addEventListener('change', function(e){
        var f = e.target.files && e.target.files[0];
        if (f) { cb(f); inp.value = ''; }
    });
}

function wireWindowDrop() {
    window.addEventListener('dragover', function(e){ e.preventDefault(); });
    window.addEventListener('drop', function(e){
        e.preventDefault();
        var f = e.dataTransfer && e.dataTransfer.files[0];
        if (!f) return;
        var files = Array.from(e.dataTransfer.files);
        var ldFiles = files.filter(function(f2){
            var n=f2.name.toLowerCase();
            return n.endsWith('.ld')||n.endsWith('.lds')||n.endsWith('.x');
        });
        if (ldFiles.length > 0) { handleLDFiles(ldFiles); return; }
        var n = f.name.toLowerCase();
        if (n.endsWith('.map')) handleMapFile(f);
    });
}

/**
 * Wire the LD drop zone for multi-file support.
 * Allows dropping or selecting multiple .ld files at once
 * (e.g. memory.ld + sections.ld from ESP-IDF build).
 */
function wireLDDropZone() {
    var div = document.getElementById('ld-drop');
    var inp = document.getElementById('ld-fi');
    if (!div || !inp) { console.error('[drops] LD drop zone missing'); return; }

    div.addEventListener('dragover', function(e){ e.preventDefault(); e.stopPropagation(); div.classList.add('over'); });
    div.addEventListener('dragleave', function(){ div.classList.remove('over'); });
    div.addEventListener('drop', function(e){
        e.preventDefault(); e.stopPropagation();
        div.classList.remove('over');
        var files = Array.from(e.dataTransfer.files).filter(function(f){
            var n = f.name.toLowerCase();
            return n.endsWith('.ld') || n.endsWith('.lds') || n.endsWith('.x');
        });
        if (files.length) handleLDFiles(files);
    });
    div.addEventListener('click', function(e){ if(e.target!==inp) inp.click(); });
    inp.addEventListener('change', function(e){
        var files = Array.from(e.target.files||[]);
        if (files.length) handleLDFiles(files);
        inp.value = '';
    });
}

/**
 * Read one or more .ld files and upload them together.
 * Multiple files are sent as content + content_2 + content_3 …
 * The server auto-orders them: MEMORY block first, SECTIONS block second.
 */
function handleLDFiles(files) {
    if (!files || !files.length) return;
    var fieldNames = ['content','content_2','content_3','content_4','content_5'];
    var total = Math.min(files.length, fieldNames.length);
    var done  = 0;
    var contents = new Array(total);
    var names = [];
    files.slice(0, total).forEach(function(file, i) {
        names.push(file.name);
        var r = new FileReader();
        r.onerror = function(){ alert('Failed to read ' + file.name); };
        r.onload  = function(e) {
            contents[i] = e.target.result;
            done++;
            if (done === total) {
                var fd = new FormData();
                contents.forEach(function(c, idx){
                    fd.append(fieldNames[idx], c);
                });
                fd.append('filename', names.join(' + '));
                uploadLD(names.join(' + '), fd);  // pass pre-built FormData
            }
        };
        r.readAsText(file);
    });
}

// Backward-compat alias used by window drop handler
function handleLDFile(file) { handleLDFiles([file]); }

function handleELFFile(file) {
    S.elfFile = file;
    markDropLoaded('elf-drop', 'elf-name', file.name);
    document.getElementById('echip').style.display = '';
    document.getElementById('ename').textContent   = file.name;
    document.getElementById('analyse-btn').disabled = false;
    document.getElementById('tool-status').textContent = 'ELF ready — click Analyse ELF';
}

function handleMapFile(file) {
    var r = new FileReader();
    r.onload  = function(e) { uploadMap(file.name, e.target.result); };
    r.onerror = function()  { alert('Failed to read ' + file.name); };
    r.readAsText(file);
}

async function uploadLD(name, textOrFd) {
    try {
        var fd = textOrFd instanceof FormData
            ? textOrFd
            : new FormData();
        if (!(textOrFd instanceof FormData)) {
            fd.append('content', textOrFd);
            fd.append('filename', name);
        }
        var res = await fetch('/parse_ld', { method:'POST', body:fd });
        var d = await res.json();
        if (d.error) { alert('LD parse error:\n' + d.error); return; }
        S.ld = d;
        markDropLoaded('ld-drop', 'ld-name', name);
        document.getElementById('fchip').style.display = '';
        document.getElementById('fname').textContent = name;
        if (typeof diagLog==='function') diagLog('file', 'LD loaded: '+name,
          {regions:d.regions?.length, sections:d.sections?.length, entry:d.entry||'none'});
        if (d.entry) {
            document.getElementById('entry-chip').style.display = '';
            document.getElementById('esym').textContent = d.entry;
        }
        showApp(); rerender();
    } catch(e) { alert('Upload failed: ' + e.message); }
}

async function uploadMap(name, text) {
    try {
        var fd = new FormData();
        fd.append('content', text);
        fd.append('filename', name);
        fd.append('target', typeof getTargetJson === 'function' ? getTargetJson() : '');
        var res = await fetch('/parse_map', { method:'POST', body:fd });
        var d = await res.json();
        if (d.error) { alert('Map error:\n' + d.error); return; }
        S.mapData = d;
        // If ELF not loaded, seed S.syms from map file symbols
        // so the Symbols + Bloat tabs show data without needing nm
        if (!S.syms || !S.syms.length) {
          S.syms = (d.symbols || []).map(function(sym) {
            return {
              name:    sym.name,
              addr:    sym.addr,
              size:    sym.size || 0,
              type:    sym.type || (sym.name.startsWith('.')?'section':'variable'),
              section: sym.section || '',
              file:    sym.file || '',
              color:   '#8b949e',
              _from_map: true,
            };
          });
          S.fSyms = S.syms.slice();
        }
        // Warn if arch in file mismatches selected target
        var selectedArch = (typeof _currentTarget !== 'undefined')
          ? (_currentTarget.startsWith('esp32') ? 'esp32' : 'arm') : 'arm';
        if (d.arch && d.arch !== selectedArch) {
          var tgt = document.getElementById('tool-status');
          if (tgt) tgt.innerHTML = '<span style="color:var(--ora);font-size:10px">'
            + '⚠ Map file detected as ' + d.arch.toUpperCase() + ' but target is ' + selectedArch.toUpperCase()
            + '. Select the matching target chip above.</span>';
        }
        markDropLoaded('map-drop', 'map-name', name);
        document.getElementById('mchip').style.display = '';
        document.getElementById('mname').textContent = name;
        if(typeof diagLog==='function') diagLog('file','MAP loaded: '+name,
          {arch:d.arch, sections:d.sections?.length, flash:d.summary?.total_flash, ram:d.summary?.total_ram});
        showApp(); rerender();
        if (typeof _checkAutoCloseSettings === 'function') _checkAutoCloseSettings();
    } catch(e) {
      if(typeof diagLog==='function') diagLog('error','LD upload failed: '+e.message);
      alert('Upload failed: ' + e.message); }
}

async function runAnalysis() {
    if (!S.elfFile) { alert('Drop an ELF file first'); return; }
    var btn    = document.getElementById('analyse-btn');
    var prog   = document.getElementById('elf-prog');
    var status = document.getElementById('tool-status');
    btn.disabled = true; btn.textContent = 'Uploading...';
    if(typeof diagLog==='function'){
      var _t=typeof _getToolsForCurrentTarget==='function'?_getToolsForCurrentTarget():{};
      diagLog('analysis','ELF analysis started',{nm:_t.nm,objdump:_t.objdump,prefix:_t.prefix||'(none)'});
    }
    prog.style.display = ''; prog.value = 0;

    var tools = {
        nm:     document.getElementById('t-nm').value.trim(),
        re:     document.getElementById('t-re').value.trim(),
        size:   document.getElementById('t-sz').value.trim(),
        a2l:    document.getElementById('t-a2l').value.trim(),
        prefix: document.getElementById('t-prefix').value.trim(),
        objdump:document.getElementById('t-objdump')?.value.trim()||'',
    };
    var fd = new FormData();
    fd.append('elf', S.elfFile);
    fd.append('tools', JSON.stringify(tools));
    fd.append('ld_data', JSON.stringify(S.ld || {regions:[],sections:[],entry:''}));

    try {
        var d = await new Promise(function(resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', '/analyse_elf');
            xhr.upload.onprogress = function(e) {
                if (e.lengthComputable) {
                    prog.value = Math.round(e.loaded/e.total*80);
                    status.textContent = 'Uploading ' + Math.round(e.loaded/1024) + 'KB';
                }
            };
            xhr.onload  = function() { try { resolve(JSON.parse(xhr.responseText)); } catch(e){ reject(e); } };
            xhr.onerror = function() { reject(new Error('Network error')); };
            xhr.send(fd);
        });

        prog.style.display = 'none'; btn.disabled = false; btn.textContent = 'Analyse ELF';
        if (d.error) { status.textContent = 'Error: ' + d.error; if(d.debug) populateDebug(d.debug); return; }

        // Replace any map-derived symbols with proper nm symbols
        S.syms = d.symbols; S.elfSecs = d.elf_sections; S.warns = d.warnings; S.startup = d.startup;
        document.getElementById('sym-chip').style.display = '';
        document.getElementById('symcount').textContent = d.symbols.length;
        status.textContent = d.symbols.length > 0 ? '✓ ' + d.symbols.length + ' symbols' : 'Warning: 0 symbols — check Debug tab';
        if(typeof diagLog==='function') diagLog('analysis','ELF analysis complete',
          {symbols:d.symbols?.length, warnings:d.warnings?.length,
           nm_ok:d.debug?.nm_ok, nm_tool:d.debug?.nm_tool,
           re_ok:d.debug?.re_ok, sz_ok:d.debug?.sz_ok,
           nm_stderr:(d.debug?.nm_stderr||'').slice(0,120)||'none'});
        if (d.debug) populateDebug(d.debug);
        if (!d.symbols.length) switchTab('dbg');
        showApp(); rerender();
        if (typeof _checkAutoCloseSettings === 'function') _checkAutoCloseSettings();
    } catch(e) {
        prog.style.display = 'none'; btn.disabled = false; btn.textContent = 'Analyse ELF';
        status.textContent = 'Error: ' + e.message;
        if(typeof diagLog==='function') diagLog('error','ELF analysis failed: '+e.message);
    }
}

function markDropLoaded(dropId, nameId, name) {
    var drop = document.getElementById(dropId);
    var nameEl = document.getElementById(nameId);
    if (drop) { drop.classList.add('loaded'); var p=drop.querySelector('p'); if(p) p.textContent=name; }
    if (nameEl) { nameEl.textContent = name; nameEl.style.display = ''; }
}

// ── LD Folder scanner ────────────────────────────────────────────────────────
// Allows scanning build/esp-idf/esp_system/ld (or any directory) for .ld files,
// showing a picker, and loading selected files together.

let _ldScanResults = [];

async function scanLdFolder() {
    const pathEl = document.getElementById('ld-scan-path');
    const path   = (pathEl?.value || '').trim();
    if (!path) { alert('Enter a directory path first'); return; }

    const resEl = document.getElementById('ld-scan-results');
    if (resEl) { resEl.style.display = ''; resEl.innerHTML = '<div style="padding:6px;color:var(--dim);font-size:11px">Scanning…</div>'; }

    try {
        const fd = new FormData();
        fd.append('path', path);
        const res = await fetch('/scan_ld', { method: 'POST', body: fd });
        const d   = await res.json();

        if (d.error) {
            if (resEl) resEl.innerHTML = `<div style="padding:6px;color:var(--red);font-size:11px">❌ ${d.error}</div>`;
            return;
        }
        if (!d.files || !d.files.length) {
            if (resEl) resEl.innerHTML = '<div style="padding:6px;color:var(--ora);font-size:11px">No .ld files found</div>';
            return;
        }

        _ldScanResults = d.files.map(f => ({ ...f, selected: true }));
        _renderLdPicker(d.files, d.root);

    } catch(e) {
        if (resEl) resEl.innerHTML = `<div style="padding:6px;color:var(--red);font-size:11px">Error: ${e.message}</div>`;
    }
}

function _renderLdPicker(files, root) {
    const resEl = document.getElementById('ld-scan-results');
    if (!resEl) return;

    const shortRoot = root ? root.replace(/.*[\/\\]([^\/\\]+[\/\\][^\/\\]+)$/, '$1') : root;
    let html = `<div style="font-size:10px;color:var(--dim);margin-bottom:4px">${files.length} .ld files in ${shortRoot}</div>`;
    html += '<div style="display:flex;flex-direction:column;gap:2px;max-height:120px;overflow-y:auto;">';

    files.forEach((f, i) => {
        const isMemory   = f.name.toLowerCase().includes('memory');
        const isSections = f.name.toLowerCase().includes('section');
        const tag = isMemory ? ' <span style="color:var(--acc);font-size:9px">[MEMORY]</span>'
                  : isSections ? ' <span style="color:var(--grn);font-size:9px">[SECTIONS]</span>' : '';
        html += `<label style="display:flex;gap:6px;font-size:10px;cursor:pointer;
            padding:2px 4px;border-radius:3px;background:var(--s2)">
            <input type="checkbox" ${_ldScanResults[i].selected ? 'checked' : ''}
                onchange="_ldScanResults[${i}].selected=this.checked" style="accent-color:var(--acc)">
            <span style="color:var(--txt)">${f.name}${tag}</span>
            <span style="color:var(--dim);margin-left:auto">${(f.size/1024).toFixed(0)}KB</span>
        </label>`;
    });

    html += `</div>
        <button class="run-btn" style="margin-top:6px;width:100%"
            onclick="loadSelectedLdFiles()">▶ Load selected</button>`;

    resEl.style.display = '';
    resEl.innerHTML = html;
}

async function loadSelectedLdFiles() {
    const selected = _ldScanResults.filter(f => f.selected);
    if (!selected.length) { alert('Select at least one .ld file'); return; }

    const fd = new FormData();
    fd.append('paths', JSON.stringify(selected.map(f => f.path)));
    try {
        const res = await fetch('/load_ld_files', { method: 'POST', body: fd });
        const d   = await res.json();
        if (d.error) { alert('Error: ' + d.error); return; }

        // Build combined FormData for /parse_ld
        const fieldNames = ['content','content_2','content_3','content_4','content_5'];
        const fd2 = new FormData();
        d.files.forEach((f, i) => fd2.append(fieldNames[i], f.content));
        const name = d.files.map(f => f.name).join(' + ');
        uploadLD(name, fd2);

        // Close the picker
        const resEl = document.getElementById('ld-scan-results');
        if (resEl) resEl.style.display = 'none';
    } catch(e) { alert('Load failed: ' + e.message); }
}
