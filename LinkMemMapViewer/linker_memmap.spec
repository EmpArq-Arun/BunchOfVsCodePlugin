# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for Linker MemMap Viewer
# ==========================================
# Build:   pyinstaller linker_memmap.spec   (from inside lmv\)
# Output:  dist\LinkerMemMap\LinkerMemMap.exe   (folder, not single file)
#
# WHY --onedir INSTEAD OF --onefile:
#   --onefile packs everything into a self-extracting stub that extracts to %TEMP%
#   on every run.  Many antivirus products flag this pattern as suspicious
#   (dropper/injector behaviour) regardless of content.
#   --onedir produces a plain folder — no self-extraction, no temp writes,
#   no suspicious PE patterns.  Distribute the whole dist\LinkerMemMap\ folder
#   (zip it up).  Users double-click LinkerMemMap.exe inside the folder.
#
# WHY http.server IS INCLUDED:
#   Bottle's default server (wsgiref) imports wsgiref.simple_server which
#   imports http.server.  Without it the EXE crashes at startup with
#   "ModuleNotFoundError: No module named 'http.server'".
#
# ANTIVIRUS FALSE POSITIVES:
#   If AV still flags the exe:
#     1. Add the dist\LinkerMemMap\ folder to your AV exclusions
#     2. Or run from source:  python app.py
#     3. Or submit to AV vendor for whitelisting (common for internal tools)

import os

datas = [
    ('static',    'static'),
    ('templates', 'templates'),
    ('parsers',   'parsers'),
    ('README.md', '.'),
]

a = Analysis(
    ['app.py'],
    pathex=['.'],
    binaries=[],
    datas=datas,
    hiddenimports=[
        # Bottle runtime requirements
        'bottle',
        # wsgiref (Bottle's default server) imports these at runtime
        'wsgiref',
        'wsgiref.simple_server',
        'wsgiref.handlers',
        'wsgiref.headers',
        'wsgiref.util',
        'http',
        'http.server',      # required by wsgiref.simple_server
        'http.client',
        'socketserver',
        # Parser modules (PyInstaller misses dynamic imports)
        'parsers.ld_parser',
        'parsers.elf_parser',
        'parsers.map_parser',
        'parsers.callgraph_parser',
        'parsers.disasm_parser',
        # Email (used indirectly by http stack)
        'email.mime.text',
        'email.mime.multipart',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Heavy packages we genuinely don't use — reduces folder size
        'matplotlib', 'numpy', 'pandas', 'scipy', 'PIL', 'Pillow',
        'tkinter', 'wx', 'gtk', 'gi',
        'IPython', 'jupyter', 'notebook',
        'pytest', '_pytest', 'doctest',
        'setuptools', 'distutils',
        'xmlrpc',
        'sqlite3',
        # Do NOT exclude http.server — wsgiref needs it
    ],
    noarchive=False,
    optimize=0,   # 0 = keep docstrings, easier to debug; change to 1 for release
)

# Remove Linux .so files that sneak in when building on WSL or cross-compiled Python
# These cause the 0xc000012f "not designed to run on Windows" error
a.binaries = [
    (dst, src, typ)
    for dst, src, typ in a.binaries
    if not (src.endswith('.so') or '.so.' in src)
]

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],                 # binaries go into the folder, not embedded in the exe
    exclude_binaries=True,
    name='LinkerMemMap',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,          # UPX disabled: AV tools flag UPX-packed PE files more aggressively
    console=False,      # no black CMD window — server runs silently in background
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # Uncomment to add custom icon:
    # icon='icon.ico',
)

# COLLECT builds the onedir output folder
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='LinkerMemMap',
)
