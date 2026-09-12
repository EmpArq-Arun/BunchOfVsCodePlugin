"""
callgraph_parser.py  —  GCC -fcallgraph-info=su,da  VCG format parser
======================================================================

ACTUAL FORMAT (confirmed from user's arm-none-eabi-gcc output):

    GCC generates .ci files in VCG (Vienna Graph Format), NOT a text
    key-value format.  One .ci file per translation unit.

    graph: { title: "path/to/source.c"
      node: { title: "FuncName"
              label: "FuncName\\npath/file.c:line:col\\nN bytes (type)\\n..." }
      node: { title: "ExternalFunc"
              label: "ExternalFunc\\npath/file.h:line:col"
              shape: ellipse }         ← ellipse = external / not defined here
      edge: { sourcename: "Caller"
              targetname: "Callee"
              label: "path/file.c:line:col" }
    }

KEY OBSERVATIONS:
    - node title   = function name  (used as identifier in edges)
    - node label   = "name\\nfile:line:col\\nN bytes (static|dynamic|bounded)"
    - "N bytes"    = this function's own stack frame  (from -fstack-usage)
    - shape:ellipse = external function (defined in another TU) — no body size
    - edge source/target reference node titles directly by name
    - Multiple .ci files form one graph together (edges cross TU boundaries)

STACK FRAME EXTRACTION:
    The label field contains the stack usage on the second or third line:
        "FuncName\\nfile.c:33:6\\n16 bytes (static)\\n0 dynamic objects"
         ─────────  ──────────  ──────────────────────────────────────
         name       location    stack info

    Types: static / dynamic / dynamic,bounded
    "0 dynamic objects" means no heap allocation.

WHAT THIS MODULE PRODUCES:
    analyse_callgraph(ci_contents, su_entries)
      → per-function worst-case stack depth via DFS over the call graph

EMBEDDED ENGINEER — WHY THIS MATTERS:
    Each FreeRTOS task must have a stack large enough for its deepest
    call chain.  .su alone gives "Peripheral_Init frame = 16 bytes".
    .ci tells you Peripheral_Init calls Error_SetFailureMode, so the
    task running Peripheral_Init needs 16 + Error_SetFailureMode's
    worst case = true stack requirement.

SOFTWARE ENGINEER — ALGORITHM:
    Directed graph DFS with memoisation (longest-path in a DAG).
    Cycles (recursive calls) are capped at one level.
    Time: O(V + E).
"""

import re
from collections import defaultdict


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def analyse_callgraph(ci_contents, su_entries=None):
    """
    Analyse a list of raw .ci file strings (VCG format).

    Parameters
    ----------
    ci_contents : list[str]
        Raw text of each .ci file.
    su_entries : list[dict], optional
        Parsed .su entries {func, size, type, ...}.
        Used to fill stack frame sizes for nodes that have no "N bytes" label
        (typically external functions defined in other TUs).

    Returns
    -------
    dict:
        worst_case    {name: {frame, worst_case, path, file, line, recursive}}
        has_recursive bool
        has_unbounded bool  (dynamic-stack function in any call chain)
        node_count    int
        edge_count    int
        top_worst     list[dict]  top 20 by worst_case
        format_sample str         first lines of first file (debug)
    """
    if not ci_contents:
        return None

    # Build one unified graph from all .ci files
    all_nodes = {}   # name → node dict
    all_edges = []   # list of {source, target}

    format_sample = '\n'.join(ci_contents[0].splitlines()[:10]) if ci_contents else ''

    for content in ci_contents:
        nodes, edges = _parse_vcg(content)
        # Merge nodes: keep the one with frame data if conflict
        for name, node in nodes.items():
            if name not in all_nodes or node['frame'] > 0:
                all_nodes[name] = node
        all_edges.extend(edges)

    # Fill missing frame sizes from .su data (for external/library functions)
    if su_entries:
        su_map = {e['func']: e.get('size', 0) for e in su_entries}
        for name, node in all_nodes.items():
            if node['frame'] == 0 and name in su_map:
                node['frame'] = su_map[name]

    # Build adjacency list  name → [callee_name, ...]
    adj = defaultdict(list)
    for edge in all_edges:
        src, tgt = edge['source'], edge['target']
        if src in all_nodes and tgt in all_nodes:
            adj[src].append(tgt)

    # Identify unbounded dynamic-stack functions from .su data
    unbounded = set()
    if su_entries:
        for e in su_entries:
            t = e.get('type', '')
            if 'dynamic' in t and 'bounded' not in t:
                unbounded.add(e['func'])
    # Also pick up from node labels
    for name, node in all_nodes.items():
        if node.get('dynamic') and not node.get('bounded'):
            unbounded.add(name)

    # Compute worst-case depths
    worst_case = _compute_worst_case(all_nodes, adj)

    has_unbounded = any(
        any(n in unbounded for n in v.get('path', []))
        for v in worst_case.values()
    )
    has_recursive = any(v.get('recursive', False) for v in worst_case.values())

    top_worst = sorted(
        [{'func': k, **v} for k, v in worst_case.items()],
        key=lambda x: -x['worst_case']
    )[:20]

    return {
        'worst_case':    worst_case,
        'has_recursive': has_recursive,
        'has_unbounded': has_unbounded,
        'node_count':    len(all_nodes),
        'edge_count':    len(all_edges),
        'top_worst':     top_worst,
        'format_sample': format_sample,
    }


# ---------------------------------------------------------------------------
# VCG parser
# ---------------------------------------------------------------------------

def _parse_vcg(content):
    """
    Parse one GCC .ci file in VCG format.

    Returns (nodes_dict, edges_list):
        nodes_dict  {func_name: {frame, file, line, dynamic, bounded, external}}
        edges_list  [{source: name, target: name}]

    VCG uses nested braces.  We parse it as a flat token stream rather
    than a recursive descent parser because the nesting is only one level
    deep in practice (graph → node/edge records).
    """
    nodes  = {}
    edges  = []

    # Extract all record blocks:  node: { ... }  and  edge: { ... }
    # We scan for "node:" or "edge:" followed by a { ... } block.
    # Attribute values may be quoted strings (possibly with \n escapes).

    for m in re.finditer(r'(node|edge)\s*:\s*\{([^}]*)\}', content, re.DOTALL):
        kind  = m.group(1)
        block = m.group(2)
        attrs = _parse_vcg_attrs(block)

        if kind == 'node':
            name = attrs.get('title', '').strip()
            if not name:
                continue

            label    = attrs.get('label', '')
            is_ext   = attrs.get('shape', '') == 'ellipse'
            frame, dynamic, bounded, file_, line = _parse_label(label)

            nodes[name] = {
                'frame':    frame,
                'file':     file_,
                'line':     line,
                'dynamic':  dynamic,
                'bounded':  bounded,
                'external': is_ext,   # defined in another translation unit
                'recursive': False,
            }

        elif kind == 'edge':
            src = attrs.get('sourcename', '').strip()
            tgt = attrs.get('targetname', '').strip()
            if src and tgt:
                edges.append({'source': src, 'target': tgt})

    return nodes, edges


def _parse_vcg_attrs(block):
    """
    Extract key: "value" pairs from a VCG record block.

    VCG attribute format:
        key: "quoted string"
        key: unquoted_token
        key : "value with spaces and \\n escapes"

    Returns dict of {key: value_string}.
    """
    attrs = {}

    # Quoted values  — key: "value"
    for m in re.finditer(r'(\w+)\s*:\s*"((?:[^"\\]|\\.)*)"', block):
        key = m.group(1)
        # Unescape VCG string: \n → newline, \\ → \
        val = m.group(2).replace('\\n', '\n').replace('\\\\', '\\')
        attrs[key] = val

    # Unquoted values  — key: token  (e.g.  shape : ellipse)
    for m in re.finditer(r'(\w+)\s*:\s*([A-Za-z_]\w*)', block):
        key = m.group(1)
        if key not in attrs:          # don't override quoted value
            attrs[key] = m.group(2)

    return attrs


def _parse_label(label):
    """
    Extract stack frame info from a VCG node label string.

    Label format (newline-separated fields):
        FunctionName
        path/to/file.c:line:col
        N bytes (static)
        0 dynamic objects          ← optional

    Or for functions with no body (external):
        FunctionName
        path/to/file.h:line:col

    Returns (frame_bytes, is_dynamic, is_bounded, file_str, line_int)
    """
    frame   = 0
    dynamic = False
    bounded = False
    file_   = ''
    line    = 0

    lines = [l.strip() for l in label.split('\n') if l.strip()]

    for part in lines:
        # Stack frame line: "16 bytes (static)" or "32 bytes (dynamic)"
        m = re.match(r'(\d+)\s+bytes?\s*\(?(static|dynamic(?:,\s*bounded)?)?', part, re.IGNORECASE)
        if m:
            frame = int(m.group(1))
            t = (m.group(2) or '').lower()
            dynamic = 'dynamic' in t
            bounded = 'bounded' in t
            continue

        # Source location: "path/file.c:33:6" or "path/file.h:98:6"
        m = re.match(r'(.+\.(c|cpp|cxx|cc|h|hpp))(?::(\d+))?', part, re.IGNORECASE)
        if m and not file_:
            file_ = _short_path(m.group(1))
            if m.group(3):
                line = int(m.group(3))
            continue

    return frame, dynamic, bounded, file_, line


# ---------------------------------------------------------------------------
# Worst-case stack depth — DFS with memoisation
# ---------------------------------------------------------------------------

def _compute_worst_case(nodes, adj):
    """
    Compute worst-case total stack depth for every defined function.

    worst_case(f) = frame(f) + max(worst_case(callee) for callee in callees(f))

    External functions (shape=ellipse in VCG) contribute their frame only
    — we have no call graph below them.  If -fstack-usage was used, their
    frame is filled from the .su data before this point.
    """
    memo    = {}
    in_path = set()   # current DFS path — used for cycle detection

    def dfs(name):
        if name in memo:
            return memo[name]
        if name not in nodes:
            return (0, [])

        node  = nodes[name]
        frame = node.get('frame', 0)

        if name in in_path:
            # Recursive call detected — contribute frame only, no infinite loop
            node['recursive'] = True
            return (frame, [name])

        in_path.add(name)
        best_extra = 0
        best_path  = []

        for callee in adj.get(name, []):
            callee_wc, callee_path = dfs(callee)
            if callee_wc > best_extra:
                best_extra = callee_wc
                best_path  = callee_path

        in_path.discard(name)

        result = (frame + best_extra, [name] + best_path)
        memo[name] = result
        return result

    results = {}
    # Only report on functions defined in this project (not external stubs)
    for name, node in nodes.items():
        worst, path = dfs(name)
        results[name] = {
            'frame':      node.get('frame', 0),
            'worst_case': worst,
            'path':       path,
            'file':       node.get('file', ''),
            'line':       node.get('line', 0),
            'recursive':  node.get('recursive', False),
            'external':   node.get('external', False),
        }
    return results


def _short_path(p):
    """Return the last two path components for display."""
    p = p.replace('\\', '/')
    parts = [x for x in p.split('/') if x]
    return '/'.join(parts[-2:]) if len(parts) > 2 else p
