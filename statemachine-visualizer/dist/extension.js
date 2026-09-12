"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode6 = __toESM(require("vscode"));

// src/scanner.ts
var vscode = __toESM(require("vscode"));

// src/parser/textUtils.ts
function stripCommentsAndLiterals(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      out += "  ";
      i += 2;
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && c2 === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    if (c === '"') {
      out += " ";
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < n) {
          out += "  ";
          i += 2;
          continue;
        }
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "'") {
      out += " ";
      i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === "\\" && i + 1 < n) {
          out += "  ";
          i += 2;
          continue;
        }
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += " ";
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
function findMatchingBrace(stripped, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < stripped.length; i++) {
    if (stripped[i] === "{") depth++;
    else if (stripped[i] === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}
function findMatchingParen(stripped, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < stripped.length; i++) {
    if (stripped[i] === "(") depth++;
    else if (stripped[i] === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}
function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === "\n") line++;
  }
  return line;
}
function splitTopLevel(text, sep = ",") {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(" || ch === "{" || ch === "<" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === ">" || ch === "]") depth--;
    if (ch === sep && depth <= 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// src/parser/cParser.ts
var C_KEYWORDS = /* @__PURE__ */ new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "return",
  "sizeof",
  "typedef",
  "struct",
  "union",
  "enum",
  "class",
  "public",
  "private",
  "protected",
  "new",
  "delete",
  "throw",
  "catch",
  "try",
  "namespace",
  "using",
  "template",
  "static_cast",
  "dynamic_cast",
  "reinterpret_cast",
  "const_cast",
  "defined",
  "goto",
  "break",
  "continue",
  "static",
  "const",
  "volatile",
  "inline",
  "extern",
  "virtual",
  "override",
  "explicit",
  "friend",
  "operator",
  "void",
  "int",
  "char",
  "short",
  "long",
  "float",
  "double",
  "bool",
  "unsigned",
  "signed",
  "auto",
  "register",
  "typename",
  "this",
  "nullptr",
  "true",
  "false",
  "__attribute__",
  "NULL"
]);
function parseFilePair(headerPath, headerSrc, implPath, implSrc) {
  const headerLines = headerSrc.split("\n").length;
  const combined = headerSrc + "\n" + implSrc;
  const remap = (line) => line <= headerLines ? { file: headerPath, line } : { file: implPath, line: line - headerLines };
  const machines = parseFile(implPath, combined);
  for (const m of machines) {
    const enumLoc = m.states[0]?.location;
    if (enumLoc) {
      const r = remap(enumLoc.line);
      m.file = r.file;
      m.id = `${r.file}::${m.enumName}`;
    }
    for (const s of m.states) {
      const r = remap(s.location.line);
      s.location = r;
    }
    for (const t of m.transitions) {
      const r = remap(t.location.line);
      t.location = r;
    }
    for (const p of m.io) {
      const r = remap(p.location.line);
      p.location = r;
    }
  }
  return machines;
}
function parseFile(file, source) {
  const stripped = stripCommentsAndLiterals(source);
  const enums = findEnums(file, source, stripped);
  if (enums.length === 0) return [];
  const functions = findFunctions(stripped);
  const io = extractIO(file, source, stripped, functions);
  const machines = [];
  for (const en of enums) {
    const result = findDispatchLogic(file, source, stripped, en, functions);
    machines.push({
      id: `${file}::${en.name}`,
      name: en.name,
      file,
      enumName: en.name,
      stateVariable: result.stateVariable,
      states: en.states,
      transitions: result.transitions,
      io,
      confidence: result.confidence,
      detectionKind: result.kind
    });
  }
  return machines;
}
function findEnums(file, source, stripped) {
  const enums = [];
  const re = /\benum\b(\s+class)?\s*([A-Za-z_]\w*)?\s*(:\s*[A-Za-z_][\w:<>\s]*)?\{/g;
  let m;
  while (m = re.exec(stripped)) {
    const braceOpen = m.index + m[0].length - 1;
    const braceClose = findMatchingBrace(stripped, braceOpen);
    if (braceClose === -1) continue;
    const tagName = m[2];
    const bodyText = stripped.slice(braceOpen + 1, braceClose - 1);
    const afterBrace = stripped.slice(braceClose);
    const aliasMatch = afterBrace.match(/^\s*([A-Za-z_]\w*)\s*;/);
    const aliasName = aliasMatch ? aliasMatch[1] : void 0;
    const before = stripped.slice(Math.max(0, m.index - 20), m.index);
    const isTypedef = /typedef\s*$/.test(before);
    const canonicalName = tagName || aliasName || `AnonEnum_L${lineAt(stripped, m.index)}`;
    const aliases = Array.from(new Set([tagName, aliasName, canonicalName].filter(Boolean)));
    const states = [];
    const entries = splitTopLevel(bodyText, ",");
    for (const entry of entries) {
      const em = entry.match(/^([A-Za-z_]\w*)\s*(=\s*([\s\S]+))?$/);
      if (!em) continue;
      states.push({
        name: em[1],
        value: em[3]?.trim(),
        isInitial: states.length === 0,
        location: { file, line: lineAt(stripped, braceOpen) }
      });
    }
    if (states.length === 0) continue;
    enums.push({
      name: canonicalName,
      aliases,
      states,
      stateNameSet: new Set(states.map((s) => s.name)),
      line: lineAt(stripped, m.index)
    });
  }
  return enums;
}
function findFunctions(stripped) {
  const functions = [];
  const re = /(^|[};])\s*((?:static|inline|extern|virtual|explicit)\s+)*[A-Za-z_][\w:<>,\*&\s]*?[\s\*&]([A-Za-z_~]\w*(?:::[A-Za-z_~]\w*)?)\s*\(([^;{}]*)\)\s*(const\s*)?(override\s*)?\{/g;
  let m;
  while (m = re.exec(stripped)) {
    const boundaryLen = m[1] ? m[1].length : 0;
    const depth = braceDepthAt(stripped, m.index + boundaryLen);
    if (depth < 0 || depth > 2) continue;
    const name = m[3];
    if (!name || C_KEYWORDS.has(name)) continue;
    const braceOpen = m.index + m[0].length - 1;
    const braceClose = findMatchingBrace(stripped, braceOpen);
    if (braceClose === -1) continue;
    const qualifiers = m[2] || "";
    functions.push({
      name,
      isStatic: /\bstatic\b/.test(qualifiers),
      isVirtual: /\bvirtual\b/.test(qualifiers) || !!m[6],
      returnType: "",
      bodyStart: braceOpen + 1,
      bodyEnd: braceClose - 1,
      line: lineAt(stripped, m.index)
    });
    re.lastIndex = braceClose - 1;
  }
  return functions;
}
function braceDepthAt(stripped, index) {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    if (stripped[i] === "{") depth++;
    else if (stripped[i] === "}") depth--;
  }
  return depth;
}
function findDispatchLogic(file, source, stripped, en, functions) {
  const viaSwitch = findSwitchDispatch(file, source, stripped, en);
  if (viaSwitch && viaSwitch.transitions.length > 0) return viaSwitch;
  const viaIfElse = findIfElseDispatch(file, source, stripped, en);
  if (viaIfElse && viaIfElse.transitions.length > 0) return viaIfElse;
  const viaDispatchTable = findDispatchTable(file, source, stripped, en, functions);
  if (viaDispatchTable && viaDispatchTable.transitions.length > 0) return viaDispatchTable;
  return { transitions: [], kind: "unknown", confidence: 0.15 };
}
function findSwitchDispatch(file, source, stripped, en) {
  const re = /\bswitch\s*\(/g;
  let m;
  let best = null;
  while (m = re.exec(stripped)) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = findMatchingParen(stripped, parenOpen);
    if (parenClose === -1) continue;
    const switchExpr = stripped.slice(parenOpen + 1, parenClose - 1).trim();
    const braceOpenIdx = stripped.indexOf("{", parenClose);
    if (braceOpenIdx === -1) continue;
    const braceClose = findMatchingBrace(stripped, braceOpenIdx);
    if (braceClose === -1) continue;
    const body = stripped.slice(braceOpenIdx + 1, braceClose - 1);
    const bodyOffset = braceOpenIdx + 1;
    const cases = extractTopLevelCases(body);
    const matchingCases = cases.filter((c) => c.label && en.stateNameSet.has(c.label));
    if (matchingCases.length < Math.max(1, Math.ceil(en.states.length * 0.4))) {
      continue;
    }
    const tail = lastIdentifier(switchExpr);
    const transitions = [];
    for (const c of cases) {
      if (!c.label || !en.stateNameSet.has(c.label)) continue;
      const slice = body.slice(c.start, c.end);
      const found = extractTransitionsFromSlice(file, source, slice, c.start + bodyOffset, tail, en);
      for (const t of found) transitions.push({ ...t, from: c.label });
    }
    const ratio = matchingCases.length / en.states.length;
    const candidate = {
      transitions,
      stateVariable: switchExpr,
      kind: "switch-case",
      confidence: Math.min(0.95, 0.5 + ratio * 0.5)
    };
    if (!best || candidate.transitions.length > best.transitions.length) {
      best = candidate;
    }
  }
  return best;
}
function extractTopLevelCases(body) {
  const markers = [];
  let depth = 0;
  const re = /\b(case\s+(?:[A-Za-z_]\w*\s*::\s*)?([A-Za-z_]\w*)\s*:|default\s*:)/g;
  let m;
  let lastIndex = 0;
  let runningDepth = 0;
  const positions = [];
  while (m = re.exec(body)) {
    positions.push({ idx: m.index, label: m[2] ?? null, len: m[0].length });
  }
  for (const p of positions) {
    for (let i = lastIndex; i < p.idx; i++) {
      if (body[i] === "{") runningDepth++;
      else if (body[i] === "}") runningDepth--;
    }
    lastIndex = p.idx;
    if (runningDepth === 0) {
      markers.push({ label: p.label, colonEnd: p.idx + p.len });
    }
  }
  const cases = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].colonEnd;
    const end = i + 1 < markers.length ? findCaseBoundary(markers, i, body) : body.length;
    cases.push({ label: markers[i].label, start, end });
  }
  return cases;
}
function findCaseBoundary(markers, i, body) {
  const nextColonEnd = markers[i + 1].colonEnd;
  const before = body.slice(Math.max(0, nextColonEnd - 40), nextColonEnd);
  const kw = before.match(/(case\s+[A-Za-z_]\w*\s*:|default\s*:)\s*$/);
  if (kw) return nextColonEnd - kw[0].length;
  return nextColonEnd;
}
function lastIdentifier(expr) {
  const cleaned = expr.replace(/[()]/g, "");
  const parts = cleaned.split(/->|\./);
  return parts[parts.length - 1].trim();
}
function extractTransitionsFromSlice(file, source, slice, sliceOffsetInStripped, tail, en) {
  const results = [];
  const escapedTail = tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assignRe = new RegExp(`(?:[\\w>.\\->]*?\\b)?${escapedTail}\\s*=\\s*(?:[A-Za-z_]\\w*\\s*::\\s*)?([A-Za-z_]\\w*)\\s*;`, "g");
  let m;
  while (m = assignRe.exec(slice)) {
    const to = m[1];
    if (!en.stateNameSet.has(to)) continue;
    const offset = sliceOffsetInStripped + m.index;
    const label = inferGuardLabel(slice, m.index);
    results.push({
      to,
      label,
      kind: "switch-case",
      location: { file, line: lineAt(source, offset) }
    });
  }
  return results;
}
function inferGuardLabel(slice, assignIndex) {
  const conditions = [];
  const ifRe = /\b(?:else\s+)?if\s*\(/g;
  let m;
  while (m = ifRe.exec(slice)) {
    const ifStart = m.index;
    if (ifStart >= assignIndex) break;
    const parenOpen = ifStart + m[0].length - 1;
    const parenClose = findMatchingParen(slice, parenOpen);
    if (parenClose === -1 || parenClose > assignIndex) continue;
    const cond = slice.slice(parenOpen + 1, parenClose - 1).trim();
    if (!cond || cond.length > 100) continue;
    const afterCond = slice.slice(parenClose);
    const braceMatch = afterCond.match(/^\s*\{/);
    let bodyEnd;
    if (braceMatch) {
      const braceOpen2 = parenClose + braceMatch[0].length - 1;
      const braceClose2 = findMatchingBrace(slice, braceOpen2);
      bodyEnd = braceClose2 !== -1 ? braceClose2 : slice.length;
    } else {
      const semiIdx = afterCond.indexOf(";");
      bodyEnd = semiIdx !== -1 ? parenClose + semiIdx + 1 : slice.length;
    }
    if (assignIndex > parenClose && assignIndex < bodyEnd) {
      conditions.push(cond);
    }
  }
  if (conditions.length > 0) {
    const cond = conditions[conditions.length - 1];
    return `on ${cond}`;
  }
  const before = slice.slice(Math.max(0, assignIndex - 120), assignIndex);
  const callMatch = before.match(/([A-Za-z_]\w*)\s*\([^()]*\)\s*;\s*$/);
  if (callMatch && !C_KEYWORDS.has(callMatch[1])) return `after ${callMatch[1]}()`;
  return void 0;
}
function findIfElseDispatch(file, source, stripped, en) {
  const transitions = [];
  let stateVariable;
  for (const stateName of en.stateNameSet) {
    const cmpRe = new RegExp(`([A-Za-z_][\\w>.\\->]*)\\s*==\\s*(?:[A-Za-z_]\\w*\\s*::\\s*)?${stateName}\\b`, "g");
    let m;
    while (m = cmpRe.exec(stripped)) {
      const expr = m[1];
      const tail = lastIdentifier(expr);
      if (!stateVariable) stateVariable = expr;
      const ifBraceOpen = stripped.indexOf("{", m.index + m[0].length);
      if (ifBraceOpen === -1 || ifBraceOpen - (m.index + m[0].length) > 80) continue;
      const ifBraceClose = findMatchingBrace(stripped, ifBraceOpen);
      if (ifBraceClose === -1) continue;
      const block = stripped.slice(ifBraceOpen + 1, ifBraceClose - 1);
      const found = extractTransitionsFromSlice(file, source, block, ifBraceOpen + 1, tail, en);
      for (const t of found) transitions.push({ ...t, from: stateName, kind: "if-else" });
    }
  }
  if (transitions.length === 0) return null;
  const statesReached = new Set(transitions.map((t) => t.from)).size;
  const ratio = statesReached / en.states.length;
  return {
    transitions,
    stateVariable,
    kind: "if-else",
    confidence: Math.min(0.85, 0.35 + ratio * 0.5)
  };
}
function findDispatchTable(file, source, stripped, en, functions) {
  const funcNames = new Set(functions.map((f) => f.name));
  const re = /=\s*\{/g;
  let m;
  while (m = re.exec(stripped)) {
    const braceOpen = m.index + m[0].length - 1;
    const braceClose = findMatchingBrace(stripped, braceOpen);
    if (braceClose === -1) continue;
    const body = stripped.slice(braceOpen + 1, braceClose - 1);
    const elements = splitTopLevel(body, ",").map((e) => e.replace(/[&\s]/g, ""));
    if (elements.length !== en.states.length) continue;
    const matchedFns = elements.filter((e) => funcNames.has(e));
    if (matchedFns.length < Math.ceil(elements.length * 0.6)) continue;
    const transitions = [];
    for (let i = 0; i < en.states.length; i++) {
      const fn = functions.find((f) => f.name === elements[i]);
      if (!fn) continue;
      const fnBody = stripped.slice(fn.bodyStart, fn.bodyEnd);
      const assignRe = /\b([A-Za-z_]\w*(?:[Ss]tate)\w*)\s*=\s*(?:[A-Za-z_]\w*\s*::\s*)?([A-Za-z_]\w*)\s*;/g;
      let am;
      while (am = assignRe.exec(fnBody)) {
        if (!en.stateNameSet.has(am[2])) continue;
        transitions.push({
          from: en.states[i].name,
          to: am[2],
          label: `via ${fn.name}()`,
          kind: "dispatch-table",
          location: { file, line: lineAt(source, fn.bodyStart + am.index) }
        });
      }
    }
    if (transitions.length > 0) {
      return {
        transitions,
        stateVariable: void 0,
        kind: "dispatch-table",
        confidence: 0.6
      };
    }
  }
  return null;
}
function extractIO(file, source, stripped, functions) {
  const io = [];
  const incRe = /^[ \t]*#include\s*[<"]([^>"]+)[>"]/gm;
  let m;
  while (m = incRe.exec(source)) {
    io.push({
      name: m[1],
      direction: "dependency",
      mechanism: "include",
      location: { file, line: lineAt(source, m.index) }
    });
  }
  for (const fn of functions) {
    if (fn.isStatic) continue;
    let mechanism = "function-call-in";
    if (/(^|_)(Get|get)([A-Z_]|$)/.test(fn.name)) mechanism = "getter";
    else if (/(^|_)(Set|set)([A-Z_]|$)/.test(fn.name)) mechanism = "setter";
    io.push({
      name: fn.name + "()",
      direction: "input",
      mechanism,
      detail: fn.isVirtual ? "virtual / overridable" : void 0,
      location: { file, line: fn.line }
    });
  }
  const localNames = /* @__PURE__ */ new Set();
  for (const f of functions) {
    localNames.add(f.name);
    const lastSeg = f.name.split("::").pop();
    if (lastSeg) localNames.add(lastSeg);
  }
  const callRe = /\b([A-Za-z_]\w*)\s*\(/g;
  const seenOut = /* @__PURE__ */ new Set();
  while (m = callRe.exec(stripped)) {
    const name = m[1];
    if (C_KEYWORDS.has(name) || localNames.has(name) || seenOut.has(name)) continue;
    if (name.length < 2) continue;
    seenOut.add(name);
    io.push({
      name: name + "()",
      direction: "output",
      mechanism: "function-call-out",
      location: { file, line: lineAt(stripped, m.index) }
    });
  }
  const externRe = /^[ \t]*extern\s+(?!"C")[\w\s\*]+?\b([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*;/gm;
  while (m = externRe.exec(stripped)) {
    io.push({
      name: m[1],
      direction: "shared",
      mechanism: "global-variable",
      location: { file, line: lineAt(stripped, m.index) }
    });
  }
  const cbRe = /\b([A-Za-z_]\w*(?:[Cc]allback|[Hh]andler|[Cc]b))\s*=\s*([A-Za-z_]\w*)\s*;/g;
  while (m = cbRe.exec(stripped)) {
    if (C_KEYWORDS.has(m[2])) continue;
    io.push({
      name: m[2] + "()",
      direction: "output",
      mechanism: "callback-registration",
      detail: `registered as ${m[1]}`,
      location: { file, line: lineAt(stripped, m.index) }
    });
  }
  const classRe = /\bclass\s+([A-Za-z_]\w*)\s*:\s*((?:public|private|protected)\s+[A-Za-z_:]\w*(?:\s*,\s*(?:public|private|protected)\s+[A-Za-z_:]\w*)*)/g;
  while (m = classRe.exec(stripped)) {
    const bases = m[2].split(",").map((b) => b.replace(/\b(public|private|protected)\b/, "").trim());
    for (const base of bases) {
      io.push({
        name: base,
        direction: "dependency",
        mechanism: "class-extension",
        detail: `${m[1]} extends ${base}`,
        location: { file, line: lineAt(stripped, m.index) }
      });
    }
  }
  return io;
}

// src/scanner.ts
var WorkspaceScanner = class {
  constructor(output) {
    this.output = output;
    this.cache = /* @__PURE__ */ new Map();
    // key: impl file path (or standalone file)
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }
  dispose() {
    this.watcher?.dispose();
  }
  getAllMachines() {
    const all = [];
    for (const list of this.cache.values()) all.push(...list);
    return all;
  }
  getMachine(id) {
    for (const list of this.cache.values()) {
      const found = list.find((m) => m.id === id);
      if (found) return found;
    }
    return void 0;
  }
  /** All machines whose enum OR dispatch logic lives in the given file. */
  getMachinesForFile(filePath) {
    const out = [];
    for (const [key, list] of this.cache.entries()) {
      for (const m of list) {
        if (m.file === filePath || key === filePath) {
          out.push(m);
          continue;
        }
        if (m.states.some((s) => s.location.file === filePath) || m.transitions.some((t) => t.location.file === filePath)) out.push(m);
      }
    }
    return out;
  }
  startWatching() {
    const config = vscode.workspace.getConfiguration("statemachineVisualizer");
    const includes = config.get("scan.include", []);
    const pattern = `{${includes.join(",")}}`;
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidChange((uri) => this.scanFile(uri));
    this.watcher.onDidCreate((uri) => this.scanFile(uri));
    this.watcher.onDidDelete((uri) => {
      this.cache.delete(uri.fsPath);
      this._onDidChange.fire();
    });
  }
  async readText(uri) {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  }
  async scanWorkspace() {
    this.cache.clear();
    const config = vscode.workspace.getConfiguration("statemachineVisualizer");
    const includes = config.get("scan.include", []);
    const excludes = config.get("scan.exclude", []);
    const excludePattern = `{${excludes.join(",")}}`;
    const errors = [];
    const allUris = [];
    for (const include of includes) {
      allUris.push(...await vscode.workspace.findFiles(include, excludePattern, 1e4));
    }
    const allPaths = allUris.map((u) => u.fsPath);
    const pathSet = new Set(allPaths);
    const pairedHeader = /* @__PURE__ */ new Map();
    const consumedHeaders = /* @__PURE__ */ new Set();
    for (const p of allPaths) {
      if (!/\.(c|cpp|cc|cxx)$/i.test(p)) continue;
      const base = p.replace(/\.(c|cpp|cc|cxx)$/i, "");
      for (const hext of [".h", ".hpp", ".hxx"]) {
        const h = base + hext;
        if (pathSet.has(h)) {
          pairedHeader.set(p, h);
          consumedHeaders.add(h);
          break;
        }
      }
    }
    let filesScanned = 0;
    for (const uri of allUris) {
      const p = uri.fsPath;
      try {
        if (consumedHeaders.has(p)) {
          filesScanned++;
          continue;
        }
        const src = await this.readText(uri);
        let machines2;
        const hdr = pairedHeader.get(p);
        if (hdr) {
          const hdrSrc = await this.readText(vscode.Uri.file(hdr));
          machines2 = parseFilePair(hdr, hdrSrc, p, src);
        } else {
          machines2 = parseFile(p, src);
        }
        if (machines2.length > 0) this.cache.set(p, machines2);
        else this.cache.delete(p);
        filesScanned++;
      } catch (e) {
        errors.push({ file: p, message: e?.message ?? String(e) });
      }
    }
    this._onDidChange.fire();
    const machines = this.getAllMachines();
    const withEdges = machines.filter((m) => m.transitions.length > 0).length;
    this.output.appendLine(
      `[scan] ${filesScanned} files, ${machines.length} state machine(s) (${withEdges} with transitions), ${errors.length} error(s).`
    );
    return { machines, filesScanned, errors };
  }
  async scanFile(uri, fireEvent = true) {
    try {
      const p = uri.fsPath;
      const src = await this.readText(uri);
      if (/\.(h|hpp|hxx)$/i.test(p)) {
        const base = p.replace(/\.(h|hpp|hxx)$/i, "");
        for (const iext of [".c", ".cpp", ".cc", ".cxx"]) {
          const impl = base + iext;
          try {
            const implSrc = await this.readText(vscode.Uri.file(impl));
            const machines2 = parseFilePair(p, src, impl, implSrc);
            if (machines2.length > 0) this.cache.set(impl, machines2);
            else this.cache.delete(impl);
            if (fireEvent) this._onDidChange.fire();
            return;
          } catch {
          }
        }
      }
      let machines;
      if (/\.(c|cpp|cc|cxx)$/i.test(p)) {
        const base = p.replace(/\.(c|cpp|cc|cxx)$/i, "");
        let hdrSrc = null, hdrPath = "";
        for (const hext of [".h", ".hpp", ".hxx"]) {
          try {
            hdrSrc = await this.readText(vscode.Uri.file(base + hext));
            hdrPath = base + hext;
            break;
          } catch {
          }
        }
        machines = hdrSrc !== null ? parseFilePair(hdrPath, hdrSrc, p, src) : parseFile(p, src);
      } else {
        machines = parseFile(p, src);
      }
      if (machines.length > 0) this.cache.set(p, machines);
      else this.cache.delete(p);
    } catch (e) {
      this.output.appendLine(`[scan] failed to read/parse ${uri.fsPath}: ${e}`);
    }
    if (fireEvent) this._onDidChange.fire();
  }
};

// src/sidebar/sidebarProvider.ts
var vscode2 = __toESM(require("vscode"));
var SidebarProvider = class {
  constructor(scanner) {
    this.scanner = scanner;
    this._onDidChangeTreeData = new vscode2.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    scanner.onDidChange(() => this._onDidChangeTreeData.fire());
  }
  refresh() {
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(element) {
    if (element.kind === "file") {
      const item2 = new vscode2.TreeItem(
        vscode2.workspace.asRelativePath(element.file),
        vscode2.TreeItemCollapsibleState.Expanded
      );
      item2.iconPath = new vscode2.ThemeIcon("file-code");
      item2.contextValue = "file";
      item2.description = `${element.machines.length} state machine${element.machines.length === 1 ? "" : "s"}`;
      return item2;
    }
    const m = element.machine;
    const item = new vscode2.TreeItem(m.name, vscode2.TreeItemCollapsibleState.None);
    item.iconPath = new vscode2.ThemeIcon(confidenceIcon(m.confidence));
    item.description = `${m.states.length} states \xB7 ${m.transitions.length} transitions \xB7 ${m.detectionKind}`;
    item.tooltip = buildTooltip(m);
    item.contextValue = "stateMachine";
    item.command = {
      command: "statemachineVisualizer.openVisualization",
      title: "Open Visualization",
      arguments: [m.id]
    };
    return item;
  }
  getChildren(element) {
    const all = this.scanner.getAllMachines();
    if (!element) {
      const byFile = /* @__PURE__ */ new Map();
      for (const m of all) {
        const list = byFile.get(m.file) ?? [];
        list.push(m);
        byFile.set(m.file, list);
      }
      if (byFile.size === 0) return [];
      return Array.from(byFile.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([file, machines]) => ({ kind: "file", file, machines }));
    }
    if (element.kind === "file") {
      return element.machines.map((machine) => ({ kind: "machine", machine }));
    }
    return [];
  }
};
function confidenceIcon(confidence) {
  if (confidence >= 0.7) return "symbol-class";
  if (confidence >= 0.4) return "symbol-misc";
  return "question";
}
function buildTooltip(m) {
  const lines = [
    `${m.name} (enum)`,
    `Detected via: ${m.detectionKind}`,
    `Confidence: ${Math.round(m.confidence * 100)}%`,
    `States: ${m.states.map((s) => s.name).join(", ")}`
  ];
  if (m.transitions.length === 0) {
    lines.push("No transitions resolved \u2014 enum found but dispatch logic was not recognized.");
  }
  return lines.join("\n");
}

// src/webview/panelManager.ts
var vscode3 = __toESM(require("vscode"));
var path = __toESM(require("path"));
var cp = __toESM(require("child_process"));
var fs = __toESM(require("fs"));
var PanelManager = class {
  constructor(extensionUri, output) {
    this.extensionUri = extensionUri;
    this.output = output;
  }
  show(machine) {
    if (!this.panel) {
      this.panel = vscode3.window.createWebviewPanel(
        "statemachineVisualizer.diagram",
        "State Machine: " + machine.name,
        vscode3.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode3.Uri.joinPath(this.extensionUri, "media")]
        }
      );
      this.panel.onDidDispose(() => {
        this.panel = void 0;
        this.currentMachineId = void 0;
      });
      this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
      this.panel.webview.html = this.buildHtml(this.panel.webview);
    }
    this.currentMachineId = machine.id;
    this.panel.title = "State Machine: " + machine.name;
    this.panel.reveal(vscode3.ViewColumn.Beside, true);
    this.postMachine(machine);
  }
  postMachine(machine) {
    this.panel?.webview.postMessage({ type: "load", machine });
  }
  async handleMessage(msg) {
    if (msg?.type === "revealLocation") {
      const { file, line } = msg.location ?? {};
      if (!file) return;
      try {
        const doc = await vscode3.workspace.openTextDocument(file);
        const editor = await vscode3.window.showTextDocument(doc, vscode3.ViewColumn.One);
        const pos = new vscode3.Position(Math.max(0, (line ?? 1) - 1), 0);
        editor.selection = new vscode3.Selection(pos, pos);
        editor.revealRange(new vscode3.Range(pos, pos), vscode3.TextEditorRevealType.InCenter);
      } catch (e) {
        this.output.appendLine(`Could not open ${file}: ${e}`);
      }
    }
  }
  isShowing(machineId) {
    return !!this.panel && this.currentMachineId === machineId;
  }
  buildHtml(webview) {
    const scriptUri = webview.asWebviewUri(
      vscode3.Uri.joinPath(this.extensionUri, "media", "webview.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode3.Uri.joinPath(this.extensionUri, "media", "webview.css")
    );
    const nonce = String(Date.now());
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${styleUri}">
  <style>
    #toolbar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border,#333);flex-wrap:wrap}
    #backBtn{display:none}
    #title{font-weight:600;font-size:13px}
    #confidence{font-size:10.5px;opacity:.65;margin-left:4px}
    .sm-layout-group{display:flex;gap:3px;border-left:1px solid #555;padding-left:8px;margin-left:auto}
    .sm-layout-btn{background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-foreground,#ddd);border:none;padding:3px 9px;border-radius:3px;cursor:pointer;font-size:11px}
    .sm-layout-btn.active{background:var(--vscode-button-background,#0e639c);color:#fff}
    #graph{width:100%;height:calc(100vh - 110px)}
    #legend{padding:5px 12px;border-top:1px solid var(--vscode-panel-border,#333);font-size:11px}
    .legend-row{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:3px}
    .legend-chip{display:flex;align-items:center;gap:5px}
    .legend-chip i{display:inline-block;width:10px;height:10px;border-radius:2px}
    .legend-note{opacity:.65;font-size:10.5px}
  </style>
  <title>State Machine Diagram</title>
</head>
<body>
  <div id="toolbar">
    <button id="backBtn" disabled></button>
    <span id="title"></span>
    <span id="confidence"></span>
    <div class="sm-layout-group">
      <button class="sm-layout-btn active" data-layout="lr" title="Left-to-right flow">\u21C6 LR</button>
      <button class="sm-layout-btn"        data-layout="tb" title="Top-to-bottom flow">\u21C5 TB</button>
    </div>
  </div>
  <div id="graph"></div>
  <div id="legend"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
};
function machineToDot(m) {
  const lines = [];
  lines.push(`digraph "${m.name}" {`);
  lines.push("  rankdir=LR;");
  lines.push('  node [shape=box, style="rounded,filled", fillcolor="#eef2ff", fontname="Helvetica"];');
  for (const s of m.states) {
    const label = s.name.replace(/"/g, '\\"');
    const shape = s.isInitial ? 'shape=box style="rounded,filled,bold"' : "";
    lines.push(`  "${s.name}" [label="${label}" ${shape}];`);
  }
  for (const t of m.transitions) {
    const label = (t.label ?? "").replace(/"/g, '\\"');
    lines.push(`  "${t.from}" -> "${t.to}" [label="${label}"];`);
  }
  lines.push("}");
  return lines.join("\n");
}
async function exportViaGraphviz(machine, output) {
  const config = vscode3.workspace.getConfiguration("statemachineVisualizer");
  const dotPath = config.get("tools.graphvizPath", "");
  const dot = machineToDot(machine);
  const dir = path.dirname(machine.file);
  const baseName = `${machine.name}.statemachine`;
  const dotFile = path.join(dir, `${baseName}.dot`);
  fs.writeFileSync(dotFile, dot, "utf8");
  if (!dotPath) {
    const choice = await vscode3.window.showInformationMessage(
      `Wrote ${baseName}.dot. Set "statemachineVisualizer.tools.graphvizPath" to your Graphviz 'dot' executable to also render an SVG automatically.`,
      "Open Settings"
    );
    if (choice === "Open Settings") {
      vscode3.commands.executeCommand("workbench.action.openSettings", "statemachineVisualizer.tools.graphvizPath");
    }
    return;
  }
  const svgFile = path.join(dir, `${baseName}.svg`);
  cp.execFile(dotPath, ["-Tsvg", dotFile, "-o", svgFile], (err) => {
    if (err) {
      output.appendLine(`[graphviz] export failed: ${err.message}`);
      vscode3.window.showErrorMessage(`Graphviz export failed: ${err.message}`);
      return;
    }
    vscode3.window.showInformationMessage(`Exported ${path.basename(svgFile)}`);
    vscode3.commands.executeCommand("vscode.open", vscode3.Uri.file(svgFile));
  });
}

// src/fileGraph/panel.ts
var vscode5 = __toESM(require("vscode"));

// src/fileGraph/scanner.ts
var path2 = __toESM(require("path"));
var vscode4 = __toESM(require("vscode"));
var CKW = /* @__PURE__ */ new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "return",
  "sizeof",
  "typedef",
  "struct",
  "union",
  "enum",
  "class",
  "public",
  "private",
  "protected",
  "new",
  "delete",
  "throw",
  "catch",
  "try",
  "namespace",
  "using",
  "template",
  "static_cast",
  "dynamic_cast",
  "reinterpret_cast",
  "const_cast",
  "defined",
  "goto",
  "break",
  "continue",
  "static",
  "const",
  "volatile",
  "inline",
  "extern",
  "virtual",
  "override",
  "explicit",
  "friend",
  "operator",
  "void",
  "int",
  "char",
  "short",
  "long",
  "float",
  "double",
  "bool",
  "unsigned",
  "signed",
  "auto",
  "register",
  "typename",
  "this",
  "nullptr",
  "true",
  "false",
  "NULL",
  "assert",
  "printf",
  "fprintf",
  "sprintf",
  "malloc",
  "free",
  "memcpy",
  "memset",
  "strlen"
]);
async function buildFileInteractionGraph(output, smData = /* @__PURE__ */ new Map()) {
  const cfg = vscode4.workspace.getConfiguration("statemachineVisualizer");
  const incs = cfg.get("scan.include", []);
  const excs = cfg.get("scan.exclude", []);
  const excPat = `{${excs.join(",")}}`;
  const uris = [];
  for (const inc of incs) uris.push(...await vscode4.workspace.findFiles(inc, excPat, 1e4));
  output.appendLine(`[fileGraph] scanning ${uris.length} files\u2026`);
  const fdMap = /* @__PURE__ */ new Map();
  for (const uri of uris) {
    try {
      const src = Buffer.from(await vscode4.workspace.fs.readFile(uri)).toString("utf8");
      const strip = stripCommentsAndLiterals(src);
      fdMap.set(uri.fsPath, {
        file: uri.fsPath,
        source: src,
        stripped: strip,
        defs: extractDefs(uri.fsPath, src, strip),
        localIncludes: extractIncludes(src)
      });
    } catch (e) {
      output.appendLine(`[fileGraph] skip ${uri.fsPath}: ${e}`);
    }
  }
  const globalDefs = /* @__PURE__ */ new Map();
  for (const fd of fdMap.values())
    for (const d of fd.defs) {
      if (!globalDefs.has(d.name)) globalDefs.set(d.name, []);
      globalDefs.get(d.name).push(d);
    }
  const bnMap = /* @__PURE__ */ new Map();
  for (const f of fdMap.keys()) {
    const bn = path2.basename(f).toLowerCase();
    if (!bnMap.has(bn)) bnMap.set(bn, []);
    bnMap.get(bn).push(f);
  }
  const allRefs = [];
  for (const fd of fdMap.values())
    allRefs.push(...extractCrossRefs(fd, fdMap, globalDefs, bnMap));
  output.appendLine(`[fileGraph] ${allRefs.length} cross-file refs`);
  return buildGraph(fdMap, allRefs, smData);
}
function extractDefs(file, source, stripped) {
  const defs = [];
  const fnRe = /(^|[};])\s*((?:(?:static|inline|virtual|explicit|extern)\s+)*)([A-Za-z_][\w:<>,\s*&]*?[\s*&])([A-Za-z_~]\w*(?:::[A-Za-z_~]\w*)?)\s*\(([^;{}]*)\)\s*(?:const\s*)?(?:override\s*)?\{/g;
  let m;
  while (m = fnRe.exec(stripped)) {
    const q = m[2] ?? "";
    const name = m[4];
    if (!name || CKW.has(name) || /\bstatic\b/.test(q) || /\bextern\b/.test(q)) continue;
    const short = name.split("::").pop();
    if (CKW.has(short)) continue;
    defs.push({ name: short, file, line: lineAt(source, m.index), kind: "function" });
    if (name !== short) defs.push({ name, file, line: lineAt(source, m.index), kind: "function" });
  }
  const clsRe = /\b(?:class|struct)\s+([A-Za-z_]\w*)\s*(?:final\s*)?(?::[^{]*)?\{/g;
  while (m = clsRe.exec(stripped)) {
    if (m[1]) defs.push({ name: m[1], file, line: lineAt(source, m.index), kind: "class" });
  }
  const enumRe = /\benum\b(?:\s+class)?\s+([A-Za-z_]\w*)\s*(?::[^{]*)?\{/g;
  while (m = enumRe.exec(stripped)) {
    if (m[1]) defs.push({ name: m[1], file, line: lineAt(source, m.index), kind: "typedef" });
  }
  const tdRe = /\btypedef\b[^;]+\b([A-Za-z_]\w*)\s*;/g;
  while (m = tdRe.exec(stripped)) {
    if (m[1] && !CKW.has(m[1]) && m[1].length >= 3) defs.push({ name: m[1], file, line: lineAt(source, m.index), kind: "typedef" });
  }
  return defs;
}
function extractIncludes(src) {
  const r = [];
  const re = /^\s*#include\s*"([^"]+)"/gm;
  let m;
  while (m = re.exec(src)) r.push({ header: m[1], line: lineAt(src, m.index) });
  return r;
}
function extractCrossRefs(fd, allFiles, globalDefs, bnMap) {
  const refs = [];
  const localNames = /* @__PURE__ */ new Set([...fd.defs.map((d) => d.name), ...fd.defs.map((d) => d.name.split("::").pop())]);
  const isHeader = /\.(h|hpp|hxx)$/i.test(fd.file);
  const pairedImpl = isHeader ? [".c", ".cpp", ".cc", ".cxx"].map((ext) => fd.file.replace(/\.(h|hpp|hxx)$/i, ext)) : [];
  for (const inc of fd.localIncludes) {
    for (const toFile of resolveHeader(inc.header, fd.file, bnMap)) {
      if (toFile !== fd.file)
        refs.push({ fromFile: fd.file, toFile, kind: "include", symbol: inc.header, detail: `#include "${inc.header}"`, fromLine: inc.line });
    }
  }
  const callRe = /\b([A-Za-z_]\w*)\s*\(/g;
  const seenC = /* @__PURE__ */ new Set();
  let m;
  while (m = callRe.exec(fd.stripped)) {
    const name = m[1];
    if (CKW.has(name) || localNames.has(name) || seenC.has(name) || name.length < 2 || /^[A-Z_]{2,}$/.test(name)) continue;
    seenC.add(name);
    for (const def of globalDefs.get(name) ?? []) {
      if (def.file === fd.file || def.kind !== "function") continue;
      if (isHeader && pairedImpl.includes(def.file)) continue;
      refs.push({ fromFile: fd.file, toFile: def.file, kind: "call", symbol: name, detail: `${name}()`, fromLine: lineAt(fd.source, m.index) });
    }
  }
  const extRe = /\bextern\b\s+(?!"C")((?:const\s+)?[A-Za-z_][\w\s*<>]*?)\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*;/g;
  while (m = extRe.exec(fd.stripped)) {
    const varType = m[1]?.trim();
    const varName = m[2];
    if (!varName || CKW.has(varName)) continue;
    for (const def of globalDefs.get(varName) ?? []) {
      if (def.file === fd.file || def.kind !== "variable") continue;
      refs.push({ fromFile: fd.file, toFile: def.file, kind: "extern", symbol: varName, detail: `extern ${varType} ${varName}`, fromLine: lineAt(fd.source, m.index) });
    }
  }
  const inhRe = /\bclass\s+([A-Za-z_]\w*)\s*(?:final\s*)?:\s*((?:(?:public|private|protected)\s+[A-Za-z_:]\w*(?:\s*,\s*(?:public|private|protected)\s+[A-Za-z_:]\w*)*)+)/g;
  while (m = inhRe.exec(fd.stripped)) {
    const derived = m[1];
    for (const base of m[2].split(",").map((b) => b.replace(/\b(public|private|protected)\b/g, "").replace(/::/g, "").trim())) {
      if (!base) continue;
      for (const def of globalDefs.get(base) ?? []) {
        if (def.file === fd.file) continue;
        refs.push({ fromFile: fd.file, toFile: def.file, kind: "inherit", symbol: base, detail: `class ${derived} : ${base}`, fromLine: lineAt(fd.source, m.index) });
      }
    }
  }
  const typeRe = /\b([A-Za-z_]\w*)\s*(?:\*\s*)?(?:[A-Za-z_]\w*\s*)?[,;(){]/g;
  const seenT = /* @__PURE__ */ new Set();
  while (m = typeRe.exec(fd.stripped)) {
    const name = m[1];
    if (CKW.has(name) || localNames.has(name) || seenT.has(name) || name.length < 3 || /^[A-Z_]{2,}$/.test(name)) continue;
    seenT.add(name);
    for (const def of globalDefs.get(name) ?? []) {
      if (def.file === fd.file || def.kind === "function") continue;
      refs.push({ fromFile: fd.file, toFile: def.file, kind: "typedef", symbol: name, detail: `${name} (${def.kind})`, fromLine: lineAt(fd.source, m.index) });
    }
  }
  return refs;
}
function resolveHeader(header, fromFile, bnMap) {
  const fromDir = path2.dirname(fromFile);
  const bn = path2.basename(header).toLowerCase();
  const candidates = bnMap.get(bn) ?? [];
  const norm = header.replace(/\\/g, "/");
  const exact = candidates.filter((c) => c.replace(/\\/g, "/").endsWith(norm));
  return exact.length ? exact : candidates;
}
function buildFilePairs(allFiles) {
  const h2i = /* @__PURE__ */ new Map();
  const implFiles = allFiles.filter((f) => /\.(c|cpp|cc|cxx)$/i.test(f));
  const headerFiles = allFiles.filter((f) => /\.(h|hpp|hxx)$/i.test(f));
  for (const h of headerFiles) {
    const base = h.replace(/\.(h|hpp|hxx)$/i, "");
    const hName = path2.basename(base).toLowerCase();
    for (const iext of [".c", ".cpp", ".cc", ".cxx"]) {
      const exact = base + iext;
      if (implFiles.includes(exact)) {
        h2i.set(h, exact);
        break;
      }
    }
    if (h2i.has(h)) continue;
    const prefix = hName + "_";
    const prefixMatch = implFiles.find((f) => {
      const fBase = path2.basename(f, path2.extname(f)).toLowerCase();
      return fBase.startsWith(prefix) && path2.dirname(f) === path2.dirname(h);
    });
    if (prefixMatch) {
      h2i.set(h, prefixMatch);
      continue;
    }
    const hDir = path2.dirname(h);
    const suffixMatch = implFiles.find((f) => {
      const fBase = path2.basename(f, path2.extname(f)).toLowerCase();
      return hName.startsWith(fBase + "_") && path2.dirname(f) === hDir;
    });
    if (suffixMatch && ![...h2i.values()].includes(suffixMatch)) {
      h2i.set(h, suffixMatch);
    }
  }
  return h2i;
}
function buildGraph(fdMap, allRefs, smData) {
  const wsRoot = vscode4.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const allFilePaths = [...fdMap.keys()];
  const h2i = buildFilePairs(allFilePaths);
  const i2h = /* @__PURE__ */ new Map();
  for (const [h, i] of h2i.entries()) i2h.set(i, h);
  const remapFile = (f) => h2i.get(f) ?? f;
  const remappedRefs = allRefs.map((r) => ({ ...r, fromFile: remapFile(r.fromFile), toFile: remapFile(r.toFile) })).filter((r) => r.fromFile !== r.toFile);
  const folderFiles = /* @__PURE__ */ new Map();
  for (const file of fdMap.keys()) {
    if (h2i.has(file)) continue;
    const dir = path2.dirname(file);
    const relDir = (dir.startsWith(wsRoot) ? dir.slice(wsRoot.length).replace(/^[/\\]+/, "") : path2.basename(dir)) || "(root)";
    if (!folderFiles.has(relDir)) folderFiles.set(relDir, { absPath: dir, files: [] });
    folderFiles.get(relDir).files.push(file);
  }
  const fileFolderMap = /* @__PURE__ */ new Map();
  const folders = [];
  for (const [id, { absPath, files: files2 }] of folderFiles.entries()) {
    for (const f of files2) fileFolderMap.set(f, id);
    folders.push({ id, label: path2.basename(absPath) || id, path: absPath, fileCount: files2.length, crossFolderEdges: 0 });
  }
  folders.sort((a, b) => a.label.localeCompare(b.label));
  const degMap = /* @__PURE__ */ new Map();
  for (const r of remappedRefs) {
    if (!degMap.has(r.fromFile)) degMap.set(r.fromFile, /* @__PURE__ */ new Set());
    if (!degMap.has(r.toFile)) degMap.set(r.toFile, /* @__PURE__ */ new Set());
    degMap.get(r.fromFile).add(r.toFile);
    degMap.get(r.toFile).add(r.fromFile);
  }
  const files = [];
  for (const file of fdMap.keys()) {
    if (h2i.has(file)) continue;
    const pairedHdr = i2h.get(file);
    const names = [
      ...smData.get(file) ?? [],
      ...pairedHdr ? smData.get(pairedHdr) ?? [] : []
    ];
    const displayLabel = pairedHdr ? path2.basename(file, path2.extname(file)) : void 0;
    files.push({
      id: file,
      label: path2.basename(file),
      file,
      folderId: fileFolderMap.get(file) ?? "(root)",
      ext: path2.extname(file).toLowerCase(),
      degree: degMap.get(file)?.size ?? 0,
      hasSM: names.length > 0,
      smNames: [...new Set(names)],
      pairedFile: pairedHdr,
      displayLabel
    });
  }
  files.sort((a, b) => a.label.localeCompare(b.label));
  const edgeMap = /* @__PURE__ */ new Map();
  for (const r of remappedRefs) {
    const key = `${r.fromFile}|||${r.toFile}|||${r.kind}`;
    if (!edgeMap.has(key)) edgeMap.set(key, { symbols: [], details: [], count: 0 });
    const e = edgeMap.get(key);
    if (!e.symbols.includes(r.symbol)) {
      e.symbols.push(r.symbol);
      if (r.detail) e.details.push(r.detail);
    }
    e.count++;
  }
  const edges = [];
  for (const [key, data] of edgeMap.entries()) {
    const [from, to, kind] = key.split("|||");
    edges.push({ from, to, kind, ...data });
  }
  for (const e of edges) {
    const ff = fileFolderMap.get(e.from);
    const tf = fileFolderMap.get(e.to);
    if (ff && tf && ff !== tf) {
      const fn = folders.find((f) => f.id === ff);
      if (fn) fn.crossFolderEdges++;
    }
  }
  const details = {};
  for (const fd of fdMap.values()) {
    if (h2i.has(fd.file)) continue;
    details[fd.file] = buildFileDetail(fd, remappedRefs);
  }
  return { folders, files, edges, details };
}
function buildFileDetail(fd, allRefs) {
  const compMap = /* @__PURE__ */ new Map();
  const getComp = (name, kind, dir) => {
    const key = `${dir}::${name}`;
    if (!compMap.has(key)) {
      const cp2 = { name, kind, direction: dir, connections: [] };
      compMap.set(key, cp2);
    }
    return compMap.get(key);
  };
  for (const r of allRefs) {
    if (r.toFile === fd.file) {
      const cp2 = getComp(r.symbol, r.kind === "inherit" ? "class" : r.kind === "extern" ? "variable" : "function", "export");
      if (!cp2.defLine) {
        const def = fd.defs.find((d) => d.name === r.symbol || d.name.split("::").pop() === r.symbol);
        if (def) cp2.defLine = def.line;
      }
      if (!cp2.connections.some((c) => c.file === r.fromFile && c.mechanism === r.kind))
        cp2.connections.push({ file: r.fromFile, mechanism: r.kind, line: r.fromLine, detail: r.detail });
    }
    if (r.fromFile === fd.file && r.kind !== "include") {
      const cp2 = getComp(r.symbol, r.kind === "inherit" ? "class" : r.kind === "extern" ? "variable" : "function", "import");
      if (!cp2.connections.some((c) => c.file === r.toFile && c.mechanism === r.kind))
        cp2.connections.push({ file: r.toFile, mechanism: r.kind, line: r.fromLine, detail: r.detail });
    }
  }
  const includes = allRefs.filter((r) => r.fromFile === fd.file && r.kind === "include").map((r) => r.toFile).filter((v, i, a) => a.indexOf(v) === i);
  const includedBy = allRefs.filter((r) => r.toFile === fd.file && r.kind === "include").map((r) => r.fromFile).filter((v, i, a) => a.indexOf(v) === i);
  return { file: fd.file, label: path2.basename(fd.file), components: [...compMap.values()], includes, includedBy };
}

// src/fileGraph/panel.ts
var FileGraphPanel = class {
  constructor(extensionUri, output, smScanner) {
    this.extensionUri = extensionUri;
    this.output = output;
    this.smScanner = smScanner;
  }
  async open(filePath) {
    this.focusFile = filePath;
    if (!this.panel) {
      this.panel = vscode5.window.createWebviewPanel(
        "statemachineVisualizer.fileGraph",
        "C/C++ Dependency Graph",
        vscode5.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode5.Uri.joinPath(this.extensionUri, "media")]
        }
      );
      this.panel.webview.html = this.buildHtml(this.panel.webview);
      this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
      this.panel.onDidDispose(() => {
        this.panel = void 0;
      });
    } else {
      this.panel.reveal();
      await this.refresh();
      return;
    }
    this.panel.reveal();
  }
  /** Called on file save — partial refresh if panel is open */
  async onFileSaved(uri) {
    if (!this.panel) return;
    await this.refresh();
  }
  isOpen() {
    return !!this.panel;
  }
  async refresh() {
    if (!this.panel) return;
    this.panel.webview.postMessage({ type: "loading" });
    try {
      const smData = /* @__PURE__ */ new Map();
      for (const m of this.smScanner.getAllMachines()) {
        const list = smData.get(m.file) ?? [];
        list.push(m.name);
        smData.set(m.file, list);
      }
      const graph = await buildFileInteractionGraph(this.output, smData);
      this.panel.webview.postMessage({ type: "loadGraph", graph, focusFile: this.focusFile });
    } catch (e) {
      this.panel.webview.postMessage({ type: "error", message: String(e?.message ?? e) });
    }
  }
  async handleMessage(msg) {
    switch (msg?.type) {
      case "ready":
        await this.refresh();
        break;
      case "revealFile": {
        try {
          const doc = await vscode5.workspace.openTextDocument(msg.file);
          const editor = await vscode5.window.showTextDocument(doc, { viewColumn: vscode5.ViewColumn.Active, preserveFocus: false });
          const pos = new vscode5.Position(Math.max(0, (msg.line ?? 1) - 1), 0);
          editor.selection = new vscode5.Selection(pos, pos);
          editor.revealRange(new vscode5.Range(pos, pos), vscode5.TextEditorRevealType.InCenter);
        } catch (e) {
          this.output.appendLine(`[fileGraph] open: ${e}`);
        }
        break;
      }
      case "openSM":
        vscode5.commands.executeCommand("statemachineVisualizer.openSMForFile", msg.file);
        break;
      case "refresh":
        await this.refresh();
        break;
    }
  }
  buildHtml(webview) {
    const scriptUri = webview.asWebviewUri(vscode5.Uri.joinPath(this.extensionUri, "media", "fileGraph.js"));
    const nonce = `${Date.now()}`;
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");
    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;width:100%;overflow:hidden;background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-foreground,#ddd);font-family:var(--vscode-font-family,sans-serif);font-size:12px}
#app{display:flex;flex-direction:column;height:100vh;width:100vw}
#toolbar{display:flex;align-items:center;gap:5px;padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border,#333);flex-shrink:0;flex-wrap:wrap;min-height:34px}
#main{display:flex;flex:1 1 0;min-height:0;overflow:hidden;position:relative}
#graph{flex:1 1 0;min-width:0;min-height:0}
#resize-handle{width:5px;flex-shrink:0;cursor:col-resize;background:var(--vscode-panel-border,#2d2d2d)}
#resize-handle:hover,#resize-handle.dragging{background:#4f8cff}
#sidebar{width:220px;flex-shrink:0;display:flex;flex-direction:column;overflow:hidden;border-left:1px solid var(--vscode-panel-border,#333)}
#sidebar.collapsed{width:0!important;border:none}
#loading{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:var(--vscode-editor-background,#1e1e1e);z-index:100;font-size:13px;opacity:.9}
#loading-spinner{width:26px;height:26px;border:3px solid #444;border-top-color:#4f8cff;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
button{background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-foreground,#ddd);border:none;padding:3px 8px;border-radius:3px;cursor:pointer;font-size:11px;white-space:nowrap}
button.active{background:var(--vscode-button-background,#0e639c);color:#fff}
button:disabled{opacity:.4;cursor:default}
.tsep{width:1px;height:16px;background:#555;margin:0 2px;flex-shrink:0}
#breadcrumb{font-size:11px;opacity:.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
#stats{margin-left:auto;opacity:.5;font-size:10.5px;flex-shrink:0;white-space:nowrap}
#legend-panel{padding:8px;overflow-y:auto;flex:1}
#legend-panel h3{font-size:10px;opacity:.6;margin:6px 0 4px;text-transform:uppercase;letter-spacing:.4px}
.leg-item{display:flex;align-items:center;gap:5px;padding:2px 0;cursor:pointer;user-select:none}
.leg-item input[type=checkbox]{cursor:pointer;accent-color:#4f8cff}
.leg-dot{width:16px;height:3px;border-radius:2px;flex-shrink:0}
.leg-item label{cursor:pointer;font-size:10.5px}
.leg-item.disabled label{opacity:.4;text-decoration:line-through}
#info-panel{border-top:none;padding:8px;font-size:11px;display:none;max-height:280px;overflow-y:auto;flex-shrink:0}
#vresize{height:5px;flex-shrink:0;cursor:row-resize;background:var(--vscode-panel-border,#2d2d2d);display:none}
#vresize:hover,#vresize.dragging{background:#4f8cff}
#info-title{font-weight:bold;font-size:12px;margin-bottom:2px}
#info-path{font-size:9px;opacity:.45;margin-bottom:6px;word-break:break-all}
#info-body{line-height:1.5;opacity:.85}
#info-actions{margin-top:6px;display:flex;gap:5px;flex-wrap:wrap}
#tooltip{position:fixed;pointer-events:none;z-index:999;display:none;background:var(--vscode-editorHoverWidget-background,#252526);border:1px solid var(--vscode-panel-border,#444);border-radius:5px;max-width:360px;font-size:11px;box-shadow:0 4px 12px #0008;min-width:180px}
.tip-header{padding:7px 10px 5px;font-weight:bold;border-bottom:1px solid #3338;font-size:11.5px}
.tip-kind{padding:4px 10px 2px;opacity:.6;font-size:9.5px;text-transform:uppercase;letter-spacing:.5px}
.tip-list{padding:2px 10px 6px;margin:0;list-style:none}
.tip-list li{padding:1px 0;font-family:monospace;font-size:10px;opacity:.9}
.tip-list li::before{content:"\u2022 ";opacity:.45}
</style></head>
<body>
<div id="app">
  <div id="toolbar">
    <button id="btn-back" disabled title="Back to previous view">\u21A9</button>
    <div class="tsep"></div>
    <button class="layout-btn" data-layout="radial" title="Force/Radial">\u2299 Radial</button>
    <button class="layout-btn active" data-layout="lr" title="Left\u2192Right">\u21C6 LR</button>
    <button class="layout-btn" data-layout="tb" title="Top\u2192Bottom">\u21C5 TB</button>
    <div class="tsep"></div>
    <button id="btn-refresh" title="Re-scan workspace">\u27F3</button>
    <button id="btn-fit" title="Fit to window">\u2922 Fit</button>
    <button id="btn-collapse-all" title="Collapse all">\u229F</button>
    <button id="btn-toggle-sidebar" title="Toggle panel">\u25C0 Panel</button>
    <span id="breadcrumb">Workspace</span>
    <span id="stats"></span>
  </div>
  <div id="main">
    <div id="graph"></div>
    <div id="resize-handle"></div>
    <div id="sidebar">
      <div id="legend-panel">
        <h3>Connections</h3>
        <div class="leg-item" data-kind="call"><input type="checkbox" id="lg-call" checked><span class="leg-dot" style="background:#4f8cff"></span><label for="lg-call">Function calls</label></div>
        <div class="leg-item" data-kind="include"><input type="checkbox" id="lg-inc" checked><span class="leg-dot" style="background:#6c7280"></span><label for="lg-inc">#include</label></div>
        <div class="leg-item" data-kind="extern"><input type="checkbox" id="lg-ext" checked><span class="leg-dot" style="background:#ff6b6b"></span><label for="lg-ext">extern var</label></div>
        <div class="leg-item" data-kind="inherit"><input type="checkbox" id="lg-inh" checked><span class="leg-dot" style="background:#a855f7"></span><label for="lg-inh">Inheritance</label></div>
        <div class="leg-item" data-kind="typedef"><input type="checkbox" id="lg-tdf" checked><span class="leg-dot" style="background:none;border-top:2px dashed #f59e0b;width:16px;height:0"></span><label for="lg-tdf">Type usage</label></div>
        <h3>Nodes</h3>
        <div style="font-size:10px;opacity:.65;line-height:1.7">
          \u{1F4C1} Folder \u2014 <b>click</b> to expand<br>
          \u{1F7E6} File \u2014 <b>click</b> to expand fns<br>
          \u25B6 green = exported symbol<br>
          \u25C0 orange = imported symbol<br>
          \u22A1 = state machine file
        </div>
        <h3>Navigate</h3>
        <div style="font-size:10px;opacity:.55;line-height:1.7">
          Click folder \u2192 see files<br>
          Click file \u2192 see functions<br>
          Click again \u2192 collapse<br>
          \u21A9 \u2192 go back<br>
          Hover edge \u2192 details popup<br>
          Click edge \u2192 open source
        </div>
      </div>
      <div id="vresize"></div>
      <div id="info-panel" style="border-top:1px solid var(--vscode-panel-border,#333)">
        <div id="info-title"></div>
        <div id="info-path"></div>
        <div id="info-body"></div>
        <div id="info-actions"></div>
      </div>
    </div>
  </div>
</div>
<div id="loading"><div id="loading-spinner"></div><span id="loading-text">Scanning\u2026</span></div>
<div id="tooltip"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body></html>`;
  }
};

// src/extension.ts
async function activate(context) {
  const output = vscode6.window.createOutputChannel("State Machine Visualizer");
  context.subscriptions.push(output);
  const scanner = new WorkspaceScanner(output);
  context.subscriptions.push(scanner);
  const sidebarProvider = new SidebarProvider(scanner);
  const treeView = vscode6.window.createTreeView("statemachineVisualizer.sidebar", {
    treeDataProvider: sidebarProvider
  });
  context.subscriptions.push(treeView);
  const panelManager = new PanelManager(context.extensionUri, output);
  const fileGraphPanel = new FileGraphPanel(context.extensionUri, output, scanner);
  context.subscriptions.push(
    vscode6.commands.registerCommand("statemachineVisualizer.openFileGraph", async (uri) => {
      await fileGraphPanel.open(uri?.fsPath);
    })
  );
  context.subscriptions.push(
    vscode6.commands.registerCommand("statemachineVisualizer.refresh", async () => {
      await vscode6.window.withProgress(
        { location: vscode6.ProgressLocation.Notification, title: "Scanning workspace for state machines\u2026" },
        async () => {
          const result = await scanner.scanWorkspace();
          if (result.machines.length === 0) {
            vscode6.window.setStatusBarMessage(
              "No state machines detected yet. Heuristic mode looks for enums driven by switch/if-else/dispatch-table logic.",
              6e3
            );
          }
        }
      );
    })
  );
  context.subscriptions.push(
    vscode6.commands.registerCommand("statemachineVisualizer.openVisualization", (machineId) => {
      const machine = scanner.getMachine(machineId);
      if (!machine) {
        vscode6.window.showWarningMessage("That state machine is no longer available \u2014 try refreshing the scan.");
        return;
      }
      panelManager.show(machine);
    })
  );
  context.subscriptions.push(
    vscode6.commands.registerCommand("statemachineVisualizer.revealInFile", (item) => {
      const machine = item?.machine;
      if (!machine) return;
      vscode6.workspace.openTextDocument(machine.file).then(
        (doc) => vscode6.window.showTextDocument(doc, { selection: new vscode6.Range(0, 0, 0, 0) })
      );
    })
  );
  context.subscriptions.push(
    vscode6.commands.registerCommand("statemachineVisualizer.openSMForFile", (filePath) => {
      const machines = scanner.getMachinesForFile(filePath);
      if (machines.length === 0) {
        vscode6.window.showInformationMessage(`No state machines detected in ${filePath.split(/[/\\]/).pop()}.`);
        return;
      }
      panelManager.show(machines[0]);
    })
  );
  context.subscriptions.push(
    vscode6.commands.registerCommand("statemachineVisualizer.exportGraphviz", async (item) => {
      const machine = item?.machine;
      if (!machine) {
        vscode6.window.showWarningMessage("Select a state machine in the sidebar first.");
        return;
      }
      await exportViaGraphviz(machine, output);
    })
  );
  scanner.startWatching();
  const C_EXTS = /* @__PURE__ */ new Set([".c", ".cpp", ".h", ".hpp", ".cc", ".cxx", ".hxx"]);
  context.subscriptions.push(
    vscode6.workspace.onDidSaveTextDocument(async (doc) => {
      if (!C_EXTS.has(doc.uri.fsPath.slice(doc.uri.fsPath.lastIndexOf(".")).toLowerCase())) return;
      await scanner.scanFile(doc.uri);
      if (fileGraphPanel.isOpen()) {
        await fileGraphPanel.onFileSaved(doc.uri);
      }
    })
  );
  void vscode6.commands.executeCommand("statemachineVisualizer.refresh");
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
