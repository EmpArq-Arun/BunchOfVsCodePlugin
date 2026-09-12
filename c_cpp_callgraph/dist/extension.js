"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
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

// src/diagnostics.ts
function initDiagnostics(context) {
  _channel = vscode.window.createOutputChannel("C/C++ Call Graph");
  _statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  _statusBar.command = "callgraph.showDiagnostics";
  _statusBar.tooltip = "C/C++ Call Graph \u2014 click for diagnostics";
  setStatusBarMode("heuristic");
  _statusBar.show();
  context.subscriptions.push(_channel, _statusBar);
}
function setStatusBarMode(mode) {
  if (!_statusBar)
    return;
  switch (mode) {
    case "heuristic":
      _statusBar.text = "$(type-hierarchy) CallGraph: heuristic";
      _statusBar.color = void 0;
      break;
    case "verifying":
      _statusBar.text = "$(sync~spin) CallGraph: clang running\u2026";
      _statusBar.color = new vscode.ThemeColor("statusBarItem.warningForeground");
      break;
    case "verified":
      _statusBar.text = "$(check) CallGraph: clang-verified";
      _statusBar.color = new vscode.ThemeColor("statusBarItem.prominentForeground");
      break;
    case "error":
      _statusBar.text = "$(warning) CallGraph: clang failed";
      _statusBar.color = new vscode.ThemeColor("statusBarItem.errorForeground");
      break;
  }
}
function ts() {
  return (/* @__PURE__ */ new Date()).toISOString().slice(11, 23);
}
function logInfo(msg) {
  _channel?.appendLine(`[${ts()}] \u2139  ${msg}`);
}
function logOk(msg) {
  _channel?.appendLine(`[${ts()}] \u2713  ${msg}`);
}
function logWarn(msg) {
  _channel?.appendLine(`[${ts()}] \u26A0  ${msg}`);
}
function logError(msg) {
  _channel?.appendLine(`[${ts()}] \u2717  ${msg}`);
}
function logSection(title) {
  _channel?.appendLine("");
  _channel?.appendLine(`\u2500\u2500 ${title} ${"\u2500".repeat(Math.max(0, 60 - title.length))}`);
}
function show() {
  _channel?.show(true);
}
function dispose() {
  _channel?.dispose();
  _statusBar?.dispose();
  _channel = void 0;
  _statusBar = void 0;
}
var vscode, _channel, _statusBar;
var init_diagnostics = __esm({
  "src/diagnostics.ts"() {
    "use strict";
    vscode = __toESM(require("vscode"));
  }
});

// src/semantic/ctagsIndex.ts
var ctagsIndex_exports = {};
__export(ctagsIndex_exports, {
  buildTypeUsageMap: () => buildTypeUsageMap,
  runCtags: () => runCtags
});
async function runCtags(ctagsBinary, workspaceRoot, timeoutMs = 2e4) {
  const args = [
    "-R",
    "--output-format=u-ctags",
    "--fields=+a+i+K+S+z",
    "--c++-kinds=+pc",
    "--extras=+q",
    // fully-qualified names as additional tags
    "-f",
    "-",
    // output to stdout
    "."
  ];
  logInfo(`ctags: running "${ctagsBinary} ${args.join(" ")}" in ${workspaceRoot}`);
  return new Promise((resolve3) => {
    const proc = (0, import_child_process4.spawn)(ctagsBinary, args, { cwd: workspaceRoot });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled)
        return;
      settled = true;
      proc.kill();
      logWarn(`ctags timed out after ${timeoutMs}ms`);
      resolve3([]);
    }, timeoutMs);
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (e) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      logError(`ctags spawn failed: ${e.message}`);
      resolve3([]);
    });
    proc.on("close", (code) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        logWarn(`ctags exited with code ${code}: ${stderr.slice(0, 200)}`);
      }
      const entries = parseUCtagsOutput(stdout);
      logOk(`ctags: ${entries.length} entries`);
      resolve3(entries);
    });
  });
}
function parseUCtagsOutput(output) {
  const entries = [];
  for (const line of output.split("\n")) {
    if (!line || line.startsWith("!"))
      continue;
    const parts = line.split("	");
    if (parts.length < 4)
      continue;
    const name = parts[0];
    const file = parts[1];
    const kindChar = parts[3];
    const extra = {};
    for (let i = 4; i < parts.length; i++) {
      const sep = parts[i].indexOf(":");
      if (sep > 0)
        extra[parts[i].slice(0, sep)] = parts[i].slice(sep + 1);
    }
    entries.push({
      name,
      file: file.replace(/^\.\//, ""),
      kind: extra["kind"] ?? kindChar,
      scope: extra["class"] ?? extra["namespace"] ?? extra["scope"],
      inherits: extra["inherits"],
      typeref: extra["typeref"],
      signature: extra["signature"],
      access: extra["access"]
    });
  }
  return entries;
}
function buildTypeUsageMap(entries) {
  const usageMap = /* @__PURE__ */ new Map();
  const addClass = (className, filePath) => {
    const s = usageMap.get(className) ?? /* @__PURE__ */ new Set();
    s.add(filePath);
    usageMap.set(className, s);
  };
  for (const e of entries) {
    if (e.inherits) {
      for (const base of e.inherits.split(",").map((s) => s.trim())) {
        if (base)
          addClass(base, e.file);
      }
    }
    if (e.typeref) {
      const match = e.typeref.match(/\b([A-Za-z_]\w*)\b/);
      if (match)
        addClass(match[1], e.file);
    }
    if (e.signature) {
      for (const [, cn] of e.signature.matchAll(/\b([A-Z][A-Za-z_]\w*)\b/g)) {
        addClass(cn, e.file);
      }
    }
  }
  return usageMap;
}
var import_child_process4;
var init_ctagsIndex = __esm({
  "src/semantic/ctagsIndex.ts"() {
    "use strict";
    import_child_process4 = require("child_process");
    init_diagnostics();
  }
});

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode5 = __toESM(require("vscode"));

// src/parser/workspaceIndex.ts
var vscode2 = __toESM(require("vscode"));

// src/parser/textUtils.ts
function stripCommentsAndLiterals(src) {
  const out = new Array(src.length);
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : "";
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (c === "/" && c2 === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out[i] = src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    if (c === '"') {
      out[i] = '"';
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < n) {
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
          continue;
        }
        out[i] = src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out[i] = '"';
        i++;
      }
      continue;
    }
    if (c === "'") {
      out[i] = "'";
      i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === "\\" && i + 1 < n) {
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
          continue;
        }
        out[i] = " ";
        i++;
      }
      if (i < n) {
        out[i] = "'";
        i++;
      }
      continue;
    }
    out[i] = c;
    i++;
  }
  return out.join("");
}
function stripCompilerAnnotations(src) {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  while (i < n) {
    if (src[i] === "_" && src.startsWith("__attribute__", i)) {
      let j = i + 13;
      while (j < n && /\s/.test(src[j]))
        j++;
      if (src[j] === "(") {
        const start = i;
        let depth = 0;
        while (j < n) {
          if (src[j] === "(")
            depth++;
          else if (src[j] === ")") {
            depth--;
            if (depth === 0) {
              j++;
              break;
            }
          }
          j++;
        }
        for (let k = start; k < j; k++)
          if (out[k] !== "\n")
            out[k] = " ";
        i = j;
        continue;
      }
    }
    if (src[i] === "_" && src.startsWith("__declspec", i)) {
      let j = i + 10;
      while (j < n && /\s/.test(src[j]))
        j++;
      if (src[j] === "(") {
        const start = i;
        let depth = 0;
        while (j < n) {
          if (src[j] === "(")
            depth++;
          else if (src[j] === ")") {
            depth--;
            if (depth === 0) {
              j++;
              break;
            }
          }
          j++;
        }
        for (let k = start; k < j; k++)
          if (out[k] !== "\n")
            out[k] = " ";
        i = j;
        continue;
      }
    }
    i++;
  }
  return out.join("");
}
var LineIndex = class {
  constructor(src) {
    this.lineStarts = [0];
    for (let i = 0; i < src.length; i++) {
      if (src[i] === "\n")
        this.lineStarts.push(i + 1);
    }
  }
  /** Converts a 0-based character offset to a 1-based {line, column}. */
  toLineCol(offset) {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (this.lineStarts[mid] <= offset)
        lo = mid;
      else
        hi = mid - 1;
    }
    return { line: lo + 1, column: offset - this.lineStarts[lo] + 1 };
  }
};
var CONTROL_KEYWORDS = /* @__PURE__ */ new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "sizeof",
  "new",
  "delete",
  "static_assert",
  "decltype",
  "typeof",
  "__attribute__",
  "alignof",
  "noexcept",
  "throw",
  "else",
  "do",
  "typeid",
  "using",
  "namespace",
  "template",
  "explicit"
]);
function isControlKeyword(name) {
  return CONTROL_KEYWORDS.has(name);
}

// src/parser/namespaceTracker.ts
function extractNamespaceRanges(cleanedSrc) {
  const ranges = [];
  const n = cleanedSrc.length;
  const NS_RE = /\bnamespace\s*((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*)?\s*\{/g;
  let m;
  while (m = NS_RE.exec(cleanedSrc)) {
    const localName = (m[1] ?? "").replace(/\s+/g, "");
    const braceOpen = m.index + m[0].length - 1;
    const end = findMatchingBrace(cleanedSrc, braceOpen);
    if (end === -1)
      continue;
    ranges.push({ name: localName, start: braceOpen + 1, end });
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    let parent;
    for (let j = i - 1; j >= 0; j--) {
      const candidate = ranges[j];
      if (candidate.start <= r.start && candidate.end >= r.end) {
        if (!parent || candidate.start > parent.start)
          parent = candidate;
      }
    }
    if (parent && parent.name && r.name) {
      r.name = `${parent.name}::${r.name}`;
    } else if (parent && parent.name && !r.name) {
      r.name = parent.name;
    }
  }
  return ranges;
}
function namespaceAt(offset, ranges) {
  let best;
  for (const r of ranges) {
    if (offset < r.start || offset >= r.end)
      continue;
    if (!best || r.start > best.start)
      best = r;
  }
  return best?.name;
}
function findMatchingBrace(src, openOffset) {
  let depth = 0;
  for (let i = openOffset; i < src.length; i++) {
    if (src[i] === "{")
      depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0)
        return i + 1;
    }
  }
  return -1;
}

// src/parser/functionExtractor.ts
var ISR_PRECEDE_PATTERNS = [
  // GCC / Clang __attribute__
  { re: /__attribute__\s*\(\s*\(\s*interrupt/i, label: "__attribute__((interrupt))" },
  { re: /__attribute__\s*\(\s*\(\s*isr\b/i, label: "__attribute__((isr))" },
  { re: /__attribute__\s*\(\s*\(\s*vector/i, label: "__attribute__((vector(...)))" },
  { re: /__attribute__\s*\(\s*\(\s*naked/i, label: "__attribute__((naked))" },
  // Keil / MDK / IAR / CC-RX / Green Hills
  { re: /\b__irq\b/, label: "__irq" },
  { re: /\b__interrupt\b/, label: "__interrupt" },
  { re: /\b_Interrupt\b/, label: "_Interrupt (Microchip XC)" },
  { re: /\b__near\s+__interrupt\b/i, label: "__near __interrupt" },
  { re: /\binterrupt\s+void\b/, label: "interrupt void" },
  // CCS (Code Composer Studio) / TI
  { re: /#pragma\s+vector\s*=/, label: "#pragma vector=" },
  { re: /#pragma\s+interrupt/i, label: "#pragma interrupt" },
  // ESP-IDF / ESP8266
  { re: /\bIRAM_ATTR\b/, label: "IRAM_ATTR" },
  { re: /\bICACHE_FLASH_ATTR\b/, label: "ICACHE_FLASH_ATTR" },
  { re: /\bICACHE_RAM_ATTR\b/, label: "ICACHE_RAM_ATTR" },
  // Nordic nRF5 SDK / nRFx
  { re: /\bnrf_nvic_irq_enable\b/, label: "Nordic NVIC" },
  // FreeRTOS (any function with FromISR suffix handled by name below)
  // OSEK / AUTOSAR
  { re: /\bISR\s*\(/, label: "ISR() macro (AVR/AUTOSAR)" }
];
var ISR_NAME_PATTERNS = [
  { re: /_IRQHandler$/, label: "ARM CMSIS IRQHandler" },
  { re: /_IRQ$/, label: "_IRQ suffix" },
  { re: /_Interrupt$/i, label: "_Interrupt suffix" },
  { re: /^ISR_/i, label: "ISR_ prefix" },
  { re: /_isr$/i, label: "_isr suffix" },
  { re: /FromISR$/, label: "FreeRTOS FromISR" },
  { re: /^NMI_Handler$/, label: "ARM NMI_Handler" },
  { re: /^HardFault_Handler$/, label: "ARM HardFault_Handler" },
  { re: /^MemManage_Handler$/, label: "ARM MemManage_Handler" },
  { re: /^BusFault_Handler$/, label: "ARM BusFault_Handler" },
  { re: /^UsageFault_Handler$/, label: "ARM UsageFault_Handler" },
  { re: /^SVC_Handler$/, label: "ARM SVC_Handler" },
  { re: /^DebugMon_Handler$/, label: "ARM DebugMon_Handler" },
  { re: /^PendSV_Handler$/, label: "ARM PendSV_Handler" },
  { re: /^SysTick_Handler$/, label: "ARM SysTick_Handler" }
];
function detectIsrAttribute(name, cleanedSrc, headerStart, extraPatterns) {
  const lastEnd = Math.max(
    cleanedSrc.lastIndexOf("}", headerStart - 1),
    cleanedSrc.lastIndexOf(";", headerStart - 1)
  );
  const searchFrom = lastEnd >= 0 ? lastEnd + 1 : Math.max(0, headerStart - 300);
  const parenPos = cleanedSrc.indexOf("(", headerStart);
  const searchTo = parenPos >= 0 ? parenPos : headerStart + 120;
  const window4 = cleanedSrc.slice(searchFrom, searchTo);
  for (const { re, label } of ISR_PRECEDE_PATTERNS) {
    if (re.test(window4))
      return label;
  }
  for (const ep of extraPatterns) {
    if (ep.test(window4))
      return "custom pattern";
  }
  for (const { re, label } of ISR_NAME_PATTERNS) {
    if (re.test(name))
      return label;
  }
  return null;
}
var FUNC_HEADER_RE = /(^|[\n;}])[ \t]*(virtual\s+|explicit\s+|inline\s+|static\s+)*((?:[A-Za-z_][\w:<>,\*&\s]*?)\s+)?(~?[A-Za-z_]\w*(?:::~?[A-Za-z_]\w*)*)\s*\(([^;{}()]*)\)\s*(const\s*)?(override\s*)?(final\s*)?(noexcept(\([^)]*\))?\s*)?(\s*:\s*[^{]*)?\s*\{/g;
function extractFunctionSpans(cleanedSrc, extraIsrPatterns = [], rawSrc, nsRanges = []) {
  const isrSrc = rawSrc ?? cleanedSrc;
  const spans = [];
  FUNC_HEADER_RE.lastIndex = 0;
  let m;
  while (m = FUNC_HEADER_RE.exec(cleanedSrc)) {
    const qualifiers = m[2] ?? "";
    const isVirtual = /\bvirtual\b/.test(qualifiers);
    const isStatic = /\bstatic\b/.test(qualifiers);
    const returnType = (m[3] || "").trim();
    const rawName = m[4];
    const params = m[5];
    const braceOffset = m.index + m[0].length - 1;
    let name = rawName;
    let className;
    const qualified = rawName.split("::");
    if (qualified.length >= 2) {
      className = qualified.slice(0, -1).join("::");
      name = qualified[qualified.length - 1];
    }
    if (isControlKeyword(name) || isControlKeyword(returnType)) {
      FUNC_HEADER_RE.lastIndex = m.index + 1;
      continue;
    }
    const bodyEnd = findMatchingBrace2(cleanedSrc, braceOffset);
    if (bodyEnd === -1)
      continue;
    const headerStart = findHeaderStart(cleanedSrc, m.index);
    const isrAttr = detectIsrAttribute(name, isrSrc, headerStart, extraIsrPatterns);
    const ns = nsRanges.length > 0 ? namespaceAt(headerStart, nsRanges) : void 0;
    spans.push({
      name,
      className,
      namespace: ns,
      signature: `${returnType ? returnType + " " : ""}${rawName}(${params.trim()})`.trim(),
      headerStart,
      bodyStart: braceOffset,
      bodyEnd,
      isVirtualLike: isVirtual,
      isStatic,
      isIsr: isrAttr !== null,
      isrAttribute: isrAttr ?? ""
    });
    FUNC_HEADER_RE.lastIndex = braceOffset + 1;
  }
  return spans;
}
function findHeaderStart(src, matchIndex) {
  let i = matchIndex;
  while (i < src.length && (src[i] === "\n" || src[i] === ";" || src[i] === "}"))
    i++;
  while (i < src.length && /\s/.test(src[i]))
    i++;
  return i;
}
function findMatchingBrace2(src, openOffset) {
  let depth = 0;
  for (let i = openOffset; i < src.length; i++) {
    if (src[i] === "{")
      depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0)
        return i + 1;
    }
  }
  return -1;
}

// src/parser/classExtractor.ts
var CLASS_RE = /(^|[\n;}])[ \t]*(class|struct)\s+([A-Za-z_]\w*)\s*(?:final\s*)?(?::\s*([^{]+))?\{/g;
var ACCESS_RE = /^\s*(public|private|protected)\s*:/;
var MEMBER_RE = /^\s*(static\s+)?((?:const\s+|mutable\s+|volatile\s+)*)((?:[A-Za-z_][\w:<>*& ,]*?))\s+([*&\s]*)([A-Za-z_]\w*)\s*(?:=[^;{]*)?\s*;/;
var SMART_PTR_RE = /\b(?:unique_ptr|shared_ptr|weak_ptr|auto_ptr)\b/;
var STDLIB_NAMES = /* @__PURE__ */ new Set([
  "string",
  "wstring",
  "vector",
  "list",
  "deque",
  "set",
  "map",
  "unordered_map",
  "unordered_set",
  "queue",
  "stack",
  "priority_queue",
  "array",
  "pair",
  "tuple",
  "optional",
  "variant",
  "any",
  "function",
  "thread",
  "mutex",
  "atomic",
  "future",
  "promise",
  "exception",
  "runtime_error",
  "logic_error",
  "ios",
  "iostream",
  "fstream",
  "sstream",
  "ostream",
  "istream",
  "size_t",
  "int8_t",
  "uint8_t",
  "int16_t",
  "uint16_t",
  "int32_t",
  "uint32_t",
  "int64_t",
  "uint64_t"
]);
var PRIMITIVE_RE = /^(?:bool|char|short|int|long|float|double|void|wchar_t|auto|nullptr_t)$/;
function findMatchingBrace3(src, openOffset) {
  let depth = 0;
  for (let i = openOffset; i < src.length; i++) {
    if (src[i] === "{")
      depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0)
        return i + 1;
    }
  }
  return -1;
}
function classNamesInType(typeStr, knownClasses) {
  const names = /* @__PURE__ */ new Set();
  for (const m of typeStr.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
    const n = m[1];
    if (PRIMITIVE_RE.test(n) || STDLIB_NAMES.has(n))
      continue;
    if (knownClasses.has(n))
      names.add(n);
  }
  return [...names];
}
function isPointerLike(typeStr, modifiers) {
  return typeStr.includes("*") || modifiers.includes("*") || /\b(?:unique_ptr|shared_ptr|weak_ptr|auto_ptr)\b/.test(typeStr);
}
function isReferenceLike(typeStr, modifiers) {
  return typeStr.includes("&") || modifiers.includes("&");
}
function extractClassSpans(cleanedSrc, nsRanges = [], knownClassNames = /* @__PURE__ */ new Set()) {
  const out = [];
  CLASS_RE.lastIndex = 0;
  let m;
  while (m = CLASS_RE.exec(cleanedSrc)) {
    const isStruct = m[2] === "struct";
    const name = m[3];
    const baseList = m[4];
    const braceOffset = m.index + m[0].length - 1;
    const bodyEnd = findMatchingBrace3(cleanedSrc, braceOffset);
    if (bodyEnd === -1)
      continue;
    const ns = nsRanges.length > 0 ? namespaceAt(m.index, nsRanges) : void 0;
    const qualifiedName = ns ? `${ns}::${name}` : name;
    const bases = baseList ? baseList.split(",").map((b) => b.replace(/\b(public|private|protected|virtual)\b/g, "").trim()).filter(Boolean) : [];
    const body = cleanedSrc.slice(braceOffset + 1, bodyEnd - 1);
    const { members, relationships } = parseClassBody(body, isStruct, knownClassNames);
    for (const base of bases) {
      relationships.unshift({ targetClass: base, kind: "inheritance", access: "public" });
    }
    out.push({
      name,
      namespace: ns,
      qualifiedName,
      bases,
      members,
      relationships,
      headerStart: m.index,
      bodyStart: braceOffset,
      bodyEnd,
      isStruct
    });
    CLASS_RE.lastIndex = braceOffset + 1;
  }
  return out;
}
function parseClassBody(body, isStruct, knownClasses) {
  const members = [];
  const relMap = /* @__PURE__ */ new Map();
  let currentAccess = isStruct ? "public" : "private";
  const lines = body.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line)
      continue;
    const accM = ACCESS_RE.exec(line);
    if (accM) {
      currentAccess = accM[1];
      continue;
    }
    if (/^\s*(class|struct|union|enum|typedef|friend|template)\b/.test(line))
      continue;
    if (line.includes("(") || line.includes("}"))
      continue;
    if (line.startsWith("#"))
      continue;
    const mm = MEMBER_RE.exec(line);
    if (!mm)
      continue;
    const [, staticKw, qualifiers, typeRaw, ptrMods, varName] = mm;
    const type = (typeRaw + " " + ptrMods).trim();
    const isPointer = isPointerLike(typeRaw, ptrMods);
    const isReference = isReferenceLike(typeRaw, ptrMods);
    const isSmartPtr = SMART_PTR_RE.test(typeRaw);
    const member = {
      name: varName,
      type: type.trim(),
      access: currentAccess,
      isStatic: !!staticKw,
      isConst: qualifiers.includes("const"),
      isPointer,
      isReference,
      isSmartPtr
    };
    members.push(member);
    const relatedClasses = classNamesInType(typeRaw, knownClasses).filter((cn) => cn !== "this");
    for (const targetClass of relatedClasses) {
      if (relMap.has(targetClass))
        continue;
      let kind;
      if (isSmartPtr && !typeRaw.includes("weak_ptr") && !typeRaw.includes("shared_ptr")) {
        kind = "composition";
      } else if (isPointer || isReference || isSmartPtr) {
        kind = "aggregation";
      } else {
        kind = "composition";
      }
      relMap.set(targetClass, { targetClass, kind, memberName: varName, access: currentAccess });
    }
  }
  return { members, relationships: [...relMap.values()] };
}

// src/parser/callSiteExtractor.ts
var CALL_RE = /\b([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\(/g;
function extractCallSites(body) {
  const sites = [];
  CALL_RE.lastIndex = 0;
  let m;
  while (m = CALL_RE.exec(body)) {
    const name = m[1];
    const last = name.includes("::") ? name.split("::").pop() : name;
    if (isControlKeyword(last) || isControlKeyword(name))
      continue;
    sites.push({ name, offset: m.index });
  }
  return sites;
}

// src/parser/conditionalTracker.ts
var DIRECTIVE_RE = /^[ \t]*#[ \t]*(if|ifdef|ifndef|elif|else|endif|define|undef)\b(.*)$/;
function trackConditionals(src) {
  const definedLocally = /* @__PURE__ */ new Set();
  const inactiveRanges = [];
  const unresolvedRanges = [];
  const stack = [];
  let pos = 0;
  const lines = src.split("\n");
  let offset = 0;
  const currentEffectiveActive = () => {
    if (stack.length === 0)
      return true;
    return stack[stack.length - 1].branchActive;
  };
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;
    const m = DIRECTIVE_RE.exec(line);
    if (!m)
      continue;
    const directive = m[1];
    const rest = m[2].trim();
    if (directive === "define") {
      const name = rest.split(/[\s(]/)[0];
      if (name)
        definedLocally.add(name);
      continue;
    }
    if (directive === "undef") {
      const name = rest.split(/\s/)[0];
      if (name)
        definedLocally.delete(name);
      continue;
    }
    if (directive === "if" || directive === "ifdef" || directive === "ifndef") {
      const parentActive = currentEffectiveActive();
      let active;
      let macroName;
      if (directive === "if" && rest.replace(/\s/g, "") === "0") {
        active = false;
      } else if (directive === "ifdef") {
        macroName = rest.split(/\s/)[0];
        active = definedLocally.has(macroName) ? true : void 0;
      } else if (directive === "ifndef") {
        macroName = rest.split(/\s/)[0];
        active = definedLocally.has(macroName) ? false : void 0;
      } else {
        active = void 0;
      }
      const combined = parentActive === false ? false : active;
      stack.push({
        directiveStart: lineStart,
        branchActive: combined,
        macroName,
        anyBranchTaken: combined === true,
        parentActive
      });
      recordRangeStart(combined, macroName, lineStart, inactiveRanges, unresolvedRanges, true);
      continue;
    }
    if (directive === "elif" || directive === "else") {
      const frame = stack[stack.length - 1];
      if (!frame)
        continue;
      closeRange(frame, lineStart, inactiveRanges, unresolvedRanges);
      let active;
      if (frame.anyBranchTaken) {
        active = false;
      } else if (directive === "else") {
        active = frame.branchActive === void 0 ? void 0 : true;
      } else {
        active = void 0;
      }
      const combined = frame.parentActive === false ? false : active;
      frame.branchActive = combined;
      frame.directiveStart = lineStart;
      if (combined === true)
        frame.anyBranchTaken = true;
      recordRangeStart(combined, frame.macroName, lineStart, inactiveRanges, unresolvedRanges, true);
      continue;
    }
    if (directive === "endif") {
      const frame = stack.pop();
      if (!frame)
        continue;
      closeRange(frame, lineStart, inactiveRanges, unresolvedRanges);
      continue;
    }
  }
  return { inactiveRanges, unresolvedRanges };
}
function recordRangeStart(active, macroName, start, inactiveRanges, unresolvedRanges, _opening) {
}
function closeRange(frame, end, inactiveRanges, unresolvedRanges) {
  if (frame.branchActive === false) {
    inactiveRanges.push({ start: frame.directiveStart, end });
  } else if (frame.branchActive === void 0) {
    unresolvedRanges.push({ start: frame.directiveStart, end, macro: frame.macroName ?? "<expr>" });
  }
}
function isOffsetInactive(offset, info) {
  return info.inactiveRanges.some((r) => offset >= r.start && offset < r.end);
}

// src/parser/functionPointerTracker.ts
var FUNC_PTR_DECL_RE = /\(\s*\*\s*([A-Za-z_]\w*)\s*\)\s*\([^)]*\)\s*=\s*&?([A-Za-z_]\w*)\s*[;,)]/g;
var BARE_ASSIGN_RE = /(?:^|[^.\w])(?:[A-Za-z_]\w*(?:->|\.))?([A-Za-z_]\w*)\s*=\s*&?([A-Za-z_]\w*)\s*[;,)]/g;
var DESIGNATED_INIT_RE = /\.(\w+)\s*=\s*&?([A-Za-z_]\w*)\s*[,}]/g;
var ADDR_OF_RE = /&([A-Za-z_]\w*)\b/g;
var FUNC_IN_ARG_RE = /\b([A-Za-z_]\w*)\s*(?=[,)])/g;
var LAMBDA_ASSIGN_RE = /(?:^|[^.\w])(?:[A-Za-z_]\w*(?:->|\.))?([A-Za-z_]\w*)\s*=\s*\[[^\]]*\]\s*\(/g;
var ARRAY_INIT_RE = /=\s*\{([^{}]*)\}/g;
function findMatchingParen(src, openOffset) {
  let depth = 0;
  for (let i = openOffset; i < src.length; i++) {
    if (src[i] === "(")
      depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0)
        return i + 1;
    }
  }
  return -1;
}
function findMatchingBrace4(src, openOffset) {
  let depth = 0;
  for (let i = openOffset; i < src.length; i++) {
    if (src[i] === "{")
      depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0)
        return i + 1;
    }
  }
  return -1;
}
function findPointerBindings(cleanedSrc, knownFunctionNames) {
  const bindings = [];
  const lambdas = [];
  let m;
  FUNC_PTR_DECL_RE.lastIndex = 0;
  while (m = FUNC_PTR_DECL_RE.exec(cleanedSrc)) {
    const [, variable, fn] = m;
    if (knownFunctionNames.has(fn)) {
      bindings.push({ variable, functionName: fn, offset: m.index });
    }
  }
  BARE_ASSIGN_RE.lastIndex = 0;
  while (m = BARE_ASSIGN_RE.exec(cleanedSrc)) {
    const [, variable, fn] = m;
    if (knownFunctionNames.has(fn) && variable !== fn) {
      bindings.push({ variable, functionName: fn, offset: m.index });
    }
  }
  DESIGNATED_INIT_RE.lastIndex = 0;
  while (m = DESIGNATED_INIT_RE.exec(cleanedSrc)) {
    const fieldName = m[1];
    const fn = m[2];
    if (knownFunctionNames.has(fn)) {
      bindings.push({ variable: fieldName, functionName: fn, offset: m.index });
      bindings.push({ variable: "<designated-init>", functionName: fn, offset: m.index });
    }
  }
  ADDR_OF_RE.lastIndex = 0;
  while (m = ADDR_OF_RE.exec(cleanedSrc)) {
    const fn = m[1];
    if (knownFunctionNames.has(fn)) {
      bindings.push({ variable: "<addr-of>", functionName: fn, offset: m.index });
    }
  }
  const CALL_WITH_ARGS_RE = /\b[A-Za-z_]\w*\s*\(([^()]*)\)/g;
  CALL_WITH_ARGS_RE.lastIndex = 0;
  while (m = CALL_WITH_ARGS_RE.exec(cleanedSrc)) {
    const args = m[1];
    FUNC_IN_ARG_RE.lastIndex = 0;
    let am;
    while (am = FUNC_IN_ARG_RE.exec(args)) {
      const fn = am[1];
      if (knownFunctionNames.has(fn)) {
        bindings.push({ variable: "<passed-as-arg>", functionName: fn, offset: m.index });
      }
    }
  }
  ARRAY_INIT_RE.lastIndex = 0;
  while (m = ARRAY_INIT_RE.exec(cleanedSrc)) {
    const items = m[1].split(",").map((s) => s.trim());
    for (const item of items) {
      if (/^[A-Za-z_]\w*$/.test(item) && knownFunctionNames.has(item)) {
        bindings.push({ variable: "<dispatch-table>", functionName: item, offset: m.index });
      }
    }
  }
  LAMBDA_ASSIGN_RE.lastIndex = 0;
  while (m = LAMBDA_ASSIGN_RE.exec(cleanedSrc)) {
    const paramOpen = m.index + m[0].length - 1;
    const paramClose = findMatchingParen(cleanedSrc, paramOpen);
    if (paramClose === -1)
      continue;
    const braceOpen = cleanedSrc.indexOf("{", paramClose);
    if (braceOpen === -1)
      continue;
    const semiBetween = cleanedSrc.slice(paramClose, braceOpen).includes(";");
    if (semiBetween)
      continue;
    const bodyEnd = findMatchingBrace4(cleanedSrc, braceOpen);
    if (bodyEnd === -1)
      continue;
    lambdas.push({ variable: m[1], offset: m.index, bodyStart: braceOpen, bodyEnd });
  }
  return { bindings, lambdas };
}

// src/parser/macroAliasTracker.ts
function extractMacroAliases(rawCleaned, relPath = "") {
  const aliases = /* @__PURE__ */ new Map();
  const src = rawCleaned.replace(/\r\n|\r/g, "\n").replace(/\\\n/g, " ");
  let m;
  const FUNC_MACRO_RE = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]*\([^)]*\)[ \t]+([A-Za-z_][\w:]*)[ \t]*\(/gm;
  while (m = FUNC_MACRO_RE.exec(src)) {
    const macro = m[1], real = m[2];
    if (macro !== real)
      aliases.set(macro, real);
  }
  const PAREN_WRAP_RE = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]*\([^)]*\)[ \t]+\([ \t]*([A-Za-z_][\w:]*)[ \t]*\(/gm;
  PAREN_WRAP_RE.lastIndex = 0;
  while (m = PAREN_WRAP_RE.exec(src)) {
    const macro = m[1], real = m[2];
    if (macro !== real && !aliases.has(macro))
      aliases.set(macro, real);
  }
  const DO_WRAP_RE = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]*\([^)]*\)[ \t]+do\s*\{?\s*([A-Za-z_][\w:]*)[ \t]*\(/gm;
  DO_WRAP_RE.lastIndex = 0;
  while (m = DO_WRAP_RE.exec(src)) {
    const macro = m[1], real = m[2];
    if (macro !== real && !aliases.has(macro))
      aliases.set(macro, real);
  }
  const SIMPLE_MACRO_RE = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]+([A-Za-z_][\w:]*)[ \t]*(?:\/\/[^\n]*)?$/gm;
  SIMPLE_MACRO_RE.lastIndex = 0;
  while (m = SIMPLE_MACRO_RE.exec(src)) {
    const macro = m[1], real = m[2];
    if (macro !== real && !aliases.has(macro))
      aliases.set(macro, real);
  }
  return aliases;
}
function buildMergedAliasMap(perFileMaps, filePaths = []) {
  const raw = /* @__PURE__ */ new Map();
  const sourceFile = /* @__PURE__ */ new Map();
  for (let i = 0; i < perFileMaps.length; i++) {
    const m = perFileMaps[i];
    const path5 = filePaths[i] ?? "";
    for (const [k, v] of m) {
      if (!raw.has(k)) {
        raw.set(k, v);
        sourceFile.set(k, path5);
      }
    }
  }
  const resolved = /* @__PURE__ */ new Map();
  for (const key of raw.keys()) {
    resolved.set(key, followChain(key, raw, 8));
  }
  return resolved;
}
function followChain(start, raw, maxHops) {
  let current = start;
  const seen = /* @__PURE__ */ new Set([current]);
  for (let i = 0; i < maxHops; i++) {
    const next = raw.get(current);
    if (!next || seen.has(next))
      break;
    seen.add(next);
    current = next;
  }
  return current;
}
function resolveAlias(name, aliases) {
  return aliases.get(name) ?? name;
}

// src/parser/workspaceIndex.ts
init_diagnostics();
function pushIndex(map, key, id) {
  const arr = map.get(key);
  if (arr)
    arr.push(id);
  else
    map.set(key, [id]);
}
function pushEdge(map, key, edge) {
  const arr = map.get(key);
  if (arr)
    arr.push(edge);
  else
    map.set(key, [edge]);
}
function lambdaNodeId(relPath, offset) {
  return `${relPath}:lambda:${offset}`;
}
var FILE_GLOB = "**/*.{c,cc,cpp,cxx,h,hh,hpp,hxx}";
var EXCLUDE_GLOB = "**/{node_modules,build,out,dist,.git,bin}/**";
var WorkspaceIndex = class {
  constructor() {
    this.functions = /* @__PURE__ */ new Map();
    this.nameIndex = /* @__PURE__ */ new Map();
    this.qualifiedIndex = /* @__PURE__ */ new Map();
    this.edgesByCaller = /* @__PURE__ */ new Map();
    this.edgesByCallee = /* @__PURE__ */ new Map();
    this.classes = /* @__PURE__ */ new Map();
    this.functionRanges = /* @__PURE__ */ new Map();
    this.macroAliases = /* @__PURE__ */ new Map();
    this.dirty = true;
  }
  markDirty() {
    this.dirty = true;
  }
  getMacroAliases() {
    return this.macroAliases;
  }
  async ensureFresh() {
    if (!this.dirty)
      return;
    await this.fullRescan();
    this.dirty = false;
  }
  getFunction(id) {
    return this.functions.get(id);
  }
  getOutgoing(id) {
    return this.edgesByCaller.get(id) ?? [];
  }
  getIncoming(id) {
    return this.edgesByCallee.get(id) ?? [];
  }
  getAllClasses() {
    return [...this.classes.values()];
  }
  getAllFunctions() {
    return [...this.functions.values()];
  }
  /** Body line range (1-based, inclusive) for a function node. */
  getFunctionRange(id) {
    const r = this.functionRanges.get(id);
    return r ? { startLine: r.startLine, endLine: r.endLine } : void 0;
  }
  /** Find the function whose body range contains `line` (1-based). */
  findFunctionAtLine(relPath, line) {
    let best;
    let bestDist = Infinity;
    for (const [id, range] of this.functionRanges) {
      if (range.relPath !== relPath)
        continue;
      if (line >= range.startLine && line <= range.endLine) {
        const dist = line - range.startLine;
        if (dist < bestDist) {
          bestDist = dist;
          best = this.functions.get(id);
        }
      }
    }
    return best;
  }
  /**
   * When the cursor is on a function DECLARATION (ending with `;`) or a
   * forward declaration, extract the function name from the source line and
   * look it up in the index.  Returns the best match.
   *
   * @param lineText Raw text of the cursor line, e.g.
   *   `  static Zirconia::LocalModule&  GetHeartbeatLocalModule();`
   * @param relPath Source file (used for same-file preference)
   */
  findFunctionByNameOnLine(lineText, relPath) {
    const DECL_NAME_RE = /\b(~?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\(/g;
    const candidates = [];
    let m;
    while (m = DECL_NAME_RE.exec(lineText)) {
      const raw = m[1];
      if (!/\b(if|for|while|switch|do|return|sizeof|catch)\b/.test(raw)) {
        candidates.push(raw);
      }
    }
    for (const raw of candidates) {
      const parts = raw.split("::");
      const bareName = parts[parts.length - 1];
      const qualIds = this.qualifiedIndex.get(raw);
      if (qualIds && qualIds.length > 0)
        return this.functions.get(qualIds[0]);
      const allIds = this.nameIndex.get(bareName);
      if (!allIds || allIds.length === 0)
        continue;
      const sameFile = allIds.filter((id) => this.functions.get(id)?.location.file === relPath);
      const preferred = sameFile.length > 0 ? sameFile : allIds;
      const fn = this.functions.get(preferred[0]);
      if (fn)
        return fn;
    }
    return void 0;
  }
  /** Find the class whose definition is closest to `line` (1-based) in `relPath`. */
  findClassAtLine(relPath, line) {
    let best;
    for (const cls of this.classes.values()) {
      if (cls.location.file !== relPath)
        continue;
      if (cls.location.line <= line) {
        if (!best || cls.location.line > best.location.line)
          best = cls;
      }
    }
    return best;
  }
  /**
   * Builds a ClassGraphData suitable for UML/hierarchy/usage diagrams.
   * `rootClassId` sets the depth-0 node for depth-slider filtering.
   */
  buildClassGraph(diagramType, rootClassId) {
    const classes = {};
    for (const [id, cls] of this.classes)
      classes[id] = cls;
    const edgeSet = /* @__PURE__ */ new Map();
    const addEdge = (fromId, toId, kind, memberName, access = "public") => {
      if (fromId === toId)
        return;
      if (!this.classes.has(fromId) || !this.classes.has(toId))
        return;
      const key = `${fromId}\u2192${toId}:${kind}`;
      if (!edgeSet.has(key))
        edgeSet.set(key, { fromId, toId, kind, memberName, access });
    };
    for (const cls of this.classes.values()) {
      for (const rel of cls.relationships) {
        if (diagramType === "hierarchy" && rel.kind !== "inheritance")
          continue;
        if (rel.targetClassId.startsWith("unresolved:"))
          continue;
        addEdge(cls.id, rel.targetClassId, rel.kind, rel.memberName, rel.access);
      }
      if (diagramType !== "hierarchy") {
        for (const method of cls.methods) {
          const sigWords = (method.signature ?? "").matchAll(/\b([A-Z][A-Za-z_]\w*)\b/g);
          for (const [, name] of sigWords) {
            const targetIds = [...this.classes.values()].filter((c) => c.name === name).map((c) => c.id);
            for (const tid of targetIds) {
              if (tid !== cls.id)
                addEdge(cls.id, tid, "dependency");
            }
          }
        }
      }
    }
    let classNodeDepths;
    if (rootClassId && classes[rootClassId]) {
      const depths = { [rootClassId]: 0 };
      const queue = [rootClassId];
      while (queue.length > 0) {
        const cur = queue.shift();
        const d = depths[cur];
        for (const e of edgeSet.values()) {
          for (const neighbor of [e.fromId === cur ? e.toId : null, e.toId === cur ? e.fromId : null]) {
            if (neighbor && depths[neighbor] === void 0) {
              depths[neighbor] = d + 1;
              queue.push(neighbor);
            }
          }
        }
      }
      classNodeDepths = depths;
    }
    const availableFiles = [...new Set(
      [...this.classes.values()].map((c) => c.location.file)
    )].sort();
    return {
      classes,
      edges: [...edgeSet.values()],
      mode: "heuristic",
      diagramType,
      rootClassId,
      classNodeDepths,
      availableFiles
    };
  }
  /** Finds the innermost indexed function whose body spans the given 1-based line, in the given relative path. */
  async fullRescan() {
    this.functions.clear();
    this.nameIndex.clear();
    this.qualifiedIndex.clear();
    this.edgesByCaller.clear();
    this.edgesByCallee.clear();
    this.classes.clear();
    this.functionRanges.clear();
    this.macroAliases.clear();
    const uris = await vscode2.workspace.findFiles(FILE_GLOB, EXCLUDE_GLOB, 5e3);
    const parsed = [];
    const cfg = vscode2.workspace.getConfiguration("callgraph");
    const MAX_AMBIGUOUS_BARE_LINKS = cfg.get("maxAmbiguousLinks", 12);
    const extraIsrRawPatterns = cfg.get("isrPatterns", []);
    const extraIsrPatterns = extraIsrRawPatterns.flatMap((p) => {
      try {
        return [new RegExp(p, "i")];
      } catch {
        return [];
      }
    });
    const allClassNames = /* @__PURE__ */ new Set();
    for (const uri of uris) {
      let text;
      try {
        const bytes = await vscode2.workspace.fs.readFile(uri);
        text = Buffer.from(bytes).toString("utf8");
      } catch {
        continue;
      }
      const rawCleaned = stripCommentsAndLiterals(text);
      const cleaned = stripCompilerAnnotations(rawCleaned);
      const lineIndex = new LineIndex(cleaned);
      const nsRanges = extractNamespaceRanges(cleaned);
      const conditionalInfo = trackConditionals(cleaned);
      const relPath = vscode2.workspace.asRelativePath(uri, false);
      const classSpansFirstPass = extractClassSpans(cleaned, nsRanges);
      for (const c of classSpansFirstPass)
        allClassNames.add(c.name);
      const functionSpans = extractFunctionSpans(cleaned, extraIsrPatterns, rawCleaned, nsRanges);
      const classSpans = extractClassSpans(cleaned, nsRanges, allClassNames);
      parsed.push({ relPath, cleanedSrc: cleaned, rawCleaned, lineIndex, functionSpans, classSpans, nsRanges, conditionalInfo });
    }
    const perFileMaps = parsed.map((f) => extractMacroAliases(f.rawCleaned));
    const filePaths = parsed.map((f) => f.relPath);
    this.macroAliases = buildMergedAliasMap(perFileMaps, filePaths);
    const headerCount = filePaths.filter((p) => /\.(h|hh|hpp|hxx)$/i.test(p)).length;
    const sourceCount = filePaths.length - headerCount;
    logInfo(`Index: ${filePaths.length} files scanned (${sourceCount} source, ${headerCount} header)`);
    const parsedWithRelationships = [];
    for (const f of parsed) {
      const text2 = f.cleanedSrc;
      const classSpans2 = extractClassSpans(text2, f.nsRanges, allClassNames);
      parsedWithRelationships.push({ ...f, classSpans: classSpans2 });
    }
    for (const f of parsedWithRelationships) {
      for (const c of f.classSpans) {
        const loc = f.lineIndex.toLineCol(c.headerStart);
        const id = `${f.relPath}:class:${c.headerStart}`;
        const members = c.members.map((m) => ({
          name: m.name,
          type: m.type,
          access: m.access,
          isStatic: m.isStatic,
          isConst: m.isConst,
          isPointer: m.isPointer,
          isReference: m.isReference,
          isSmartPtr: m.isSmartPtr
        }));
        this.classes.set(id, {
          id,
          name: c.name,
          qualifiedName: c.qualifiedName,
          namespace: c.namespace,
          location: { file: f.relPath, line: loc.line, column: loc.column },
          bases: c.bases,
          methods: [],
          members,
          relationships: [],
          // resolved in a later pass once all class ids are known
          active: !isOffsetInactive(c.headerStart, f.conditionalInfo),
          isStruct: c.isStruct
        });
      }
    }
    const classNameToIds = /* @__PURE__ */ new Map();
    for (const cls of this.classes.values()) {
      const arr = classNameToIds.get(cls.name) ?? [];
      arr.push(cls.id);
      classNameToIds.set(cls.name, arr);
      if (cls.qualifiedName !== cls.name) {
        const arr2 = classNameToIds.get(cls.qualifiedName) ?? [];
        arr2.push(cls.id);
        classNameToIds.set(cls.qualifiedName, arr2);
      }
    }
    for (const [fileIdx, f] of parsedWithRelationships.entries()) {
      for (const c of f.classSpans) {
        const clsId = `${f.relPath}:class:${c.headerStart}`;
        const cls = this.classes.get(clsId);
        if (!cls)
          continue;
        const resolvedRels = [];
        for (const rel of c.relationships) {
          const targetIds = classNameToIds.get(rel.targetClass) ?? [];
          const targetId = targetIds[0] ?? `unresolved:${rel.targetClass}`;
          resolvedRels.push({
            targetClassId: targetId,
            targetName: rel.targetClass,
            kind: rel.kind,
            memberName: rel.memberName,
            access: rel.access
          });
        }
        cls.relationships = resolvedRels;
      }
    }
    parsed.length = 0;
    for (const f of parsedWithRelationships)
      parsed.push(f);
    for (const f of parsed) {
      for (const span of f.functionSpans) {
        const loc = f.lineIndex.toLineCol(span.headerStart);
        const endLoc = f.lineIndex.toLineCol(span.bodyEnd);
        const id = `${f.relPath}:${span.headerStart}`;
        const node = {
          id,
          name: span.name,
          qualifiedName: (() => {
            const parts = [];
            if (span.namespace)
              parts.push(span.namespace);
            if (span.className)
              parts.push(span.className);
            parts.push(span.name);
            return parts.length > 1 ? parts.join("::") : void 0;
          })(),
          location: { file: f.relPath, line: loc.line, column: loc.column },
          signature: span.signature,
          isVirtual: span.isVirtualLike,
          isStatic: span.isStatic || void 0,
          className: span.className,
          active: !isOffsetInactive(span.headerStart, f.conditionalInfo),
          isIsr: span.isIsr || void 0,
          isrAttribute: span.isrAttribute || void 0
        };
        this.functions.set(id, node);
        this.functionRanges.set(id, { startLine: loc.line, endLine: endLoc.line, relPath: f.relPath });
        pushIndex(this.nameIndex, span.name, id);
        if (span.className)
          pushIndex(this.qualifiedIndex, `${span.className}::${span.name}`, id);
      }
    }
    for (const node of this.functions.values()) {
      if (!node.className)
        continue;
      for (const cls of this.classes.values()) {
        if (cls.name === node.className)
          cls.methods.push(node);
      }
    }
    if (this.macroAliases.size > 0) {
      const validAliases = /* @__PURE__ */ new Map();
      for (const [alias, resolved] of this.macroAliases) {
        if (this.nameIndex.has(resolved))
          validAliases.set(alias, resolved);
      }
      const rawCount = this.macroAliases.size;
      this.macroAliases = validAliases;
      logInfo(`Macro function-aliases: ${validAliases.size} resolve to indexed functions (${rawCount - validAliases.size} filtered \u2014 C keywords, constants, HAL defines)`);
      const reverseAliasMap = /* @__PURE__ */ new Map();
      for (const [macro, realName] of this.macroAliases) {
        const arr = reverseAliasMap.get(realName) ?? [];
        arr.push(macro);
        reverseAliasMap.set(realName, arr);
      }
      for (const fn of this.functions.values()) {
        const fnAliases = reverseAliasMap.get(fn.name);
        if (fnAliases && fnAliases.length > 0) {
          fn.aliases = fnAliases;
          logInfo(`  alias: ${fnAliases.join(", ")} \u2192 ${fn.name} (${fn.location.file}:${fn.location.line})`);
        }
      }
    }
    const knownNames = new Set(this.nameIndex.keys());
    const allFunctionBindings = [];
    const lambdasByFile = /* @__PURE__ */ new Map();
    for (const f of parsed) {
      const { bindings, lambdas } = findPointerBindings(f.cleanedSrc, knownNames);
      for (const b of bindings) {
        allFunctionBindings.push({ ...b, file: f.relPath });
        if (b.variable.startsWith("<") && b.variable !== "<dispatch-table>") {
          const calleeIds = this.nameIndex.get(b.functionName);
          if (calleeIds) {
            const loc = f.lineIndex.toLineCol(b.offset);
            const callSiteLoc = { file: f.relPath, line: loc.line, column: loc.column };
            const enclosing = [...this.functionRanges.entries()].find(
              ([, r]) => r.relPath === f.relPath && loc.line >= r.startLine && loc.line <= r.endLine
            );
            const callerId = enclosing ? enclosing[0] : `${f.relPath}:scope`;
            for (const calleeId of calleeIds) {
              const edge = { callerId, calleeId, kind: "pointer", callSite: callSiteLoc, via: b.variable };
              pushEdge(this.edgesByCaller, callerId, edge);
              pushEdge(this.edgesByCallee, calleeId, edge);
            }
          }
        }
      }
      lambdasByFile.set(f.relPath, lambdas);
      for (const lambda of lambdas) {
        const loc = f.lineIndex.toLineCol(lambda.offset);
        const id = lambdaNodeId(f.relPath, lambda.offset);
        this.functions.set(id, {
          id,
          name: "<lambda>",
          qualifiedName: `<lambda assigned to ${lambda.variable}>`,
          location: { file: f.relPath, line: loc.line, column: loc.column },
          signature: `[](...) { /* assigned to ${lambda.variable} */ }`,
          active: !isOffsetInactive(lambda.offset, f.conditionalInfo)
        });
      }
    }
    const warnedSkipped = /* @__PURE__ */ new Set();
    const warnedBadAlias = /* @__PURE__ */ new Set();
    for (const f of parsed) {
      const lambdasThisFile = lambdasByFile.get(f.relPath) ?? [];
      const resolveBody = (callerId, bodyStart, bodyEnd) => {
        const body = f.cleanedSrc.slice(bodyStart, bodyEnd);
        const callSites = extractCallSites(body);
        for (const site of callSites) {
          const absOffset = bodyStart + site.offset;
          const lastSegment = site.name.includes("::") ? site.name.split("::").pop() : site.name;
          let calleeIds = this.qualifiedIndex.get(site.name);
          let kind = "direct";
          let via;
          if (!calleeIds) {
            const ANON_VARS = /* @__PURE__ */ new Set(["<dispatch-table>", "<designated-init>", "<addr-of>", "<passed-as-arg>"]);
            const varBindings = allFunctionBindings.filter(
              (b) => b.variable === site.name && !ANON_VARS.has(b.variable)
            );
            const lambdaTargets = [];
            for (const l of lambdasThisFile) {
              if (l.variable === site.name)
                lambdaTargets.push(lambdaNodeId(f.relPath, l.offset));
            }
            if (varBindings.length > 0 || lambdaTargets.length > 0) {
              const allTargets = new Set(lambdaTargets);
              for (const b of varBindings) {
                for (const id of this.nameIndex.get(b.functionName) ?? [])
                  allTargets.add(id);
              }
              if (allTargets.size > 0) {
                calleeIds = [...allTargets];
                kind = "pointer";
                via = site.name;
              }
            }
            if (!calleeIds) {
              const bare = site.name.includes("::") ? site.name.split("::").pop() : site.name;
              const allWithName = this.nameIndex.get(bare);
              if (allWithName && allWithName.length > 0) {
                const sameFileIds = allWithName.filter((id) => {
                  const fn = this.functions.get(id);
                  return fn?.location.file === f.relPath;
                });
                if (sameFileIds.length > 0) {
                  calleeIds = sameFileIds;
                } else {
                  const visibleIds = allWithName.filter((id) => {
                    const fn = this.functions.get(id);
                    return fn && !fn.isStatic;
                  });
                  if (visibleIds.length === 0) {
                  } else if (visibleIds.length === 1) {
                    calleeIds = visibleIds;
                  } else if (visibleIds.length <= MAX_AMBIGUOUS_BARE_LINKS) {
                    calleeIds = visibleIds;
                    if (kind === "direct")
                      kind = "virtualCandidate";
                  } else {
                    const skipKey = `${f.relPath}:${bare}`;
                    if (!warnedSkipped.has(skipKey)) {
                      warnedSkipped.add(skipKey);
                      logInfo(`  skipping '${bare}' in ${f.relPath}: ${visibleIds.length} non-static matches \u2014 use qualified name or set callgraph.maxAmbiguousLinks to include them as virtual candidates`);
                    }
                  }
                }
              }
            }
            if (!calleeIds && this.macroAliases.size > 0) {
              const bare = site.name.includes("::") ? site.name.split("::").pop() : site.name;
              const resolved = resolveAlias(bare, this.macroAliases);
              if (resolved !== bare) {
                calleeIds = this.nameIndex.get(resolved);
                if (calleeIds && calleeIds.length > 0) {
                  kind = "direct";
                  via = void 0;
                  logInfo(`  macro-alias: ${bare} \u2192 ${resolved} (in ${f.relPath})`);
                } else {
                  if (!warnedBadAlias.has(bare)) {
                    warnedBadAlias.add(bare);
                    logWarn(`  macro-alias: ${bare} \u2192 ${resolved} but "${resolved}" is not in the function index (compiler intrinsic or external library?)`);
                  }
                }
              }
            }
          }
          if (!calleeIds || calleeIds.length === 0)
            continue;
          const callSiteLoc = f.lineIndex.toLineCol(absOffset);
          const edge = {
            callerId,
            kind,
            via,
            callSite: { file: f.relPath, line: callSiteLoc.line, column: callSiteLoc.column }
          };
          for (const calleeId of calleeIds) {
            const fullEdge = { ...edge, calleeId };
            pushEdge(this.edgesByCaller, callerId, fullEdge);
            pushEdge(this.edgesByCallee, calleeId, fullEdge);
          }
        }
      };
      for (const span of f.functionSpans) {
        resolveBody(`${f.relPath}:${span.headerStart}`, span.bodyStart, span.bodyEnd);
      }
      for (const lambda of lambdasThisFile) {
        resolveBody(lambdaNodeId(f.relPath, lambda.offset), lambda.bodyStart, lambda.bodyEnd);
      }
    }
  }
};

// src/webviewPanel.ts
var vscode4 = __toESM(require("vscode"));

// src/parser/heuristicGraphBuilder.ts
function edgeKey(e) {
  return `${e.callerId}|${e.calleeId}|${e.callSite.line}|${e.callSite.column}`;
}
function buildCallGraph(index, rootId, maxDepth, maxVisibleNodes) {
  const root = index.getFunction(rootId);
  if (!root) {
    throw new Error(`Unknown function id: ${rootId}`);
  }
  const nodes = { [rootId]: root };
  const nodeDepths = { [rootId]: 0 };
  const edgeMap = /* @__PURE__ */ new Map();
  let truncated = false;
  const addNode = (id) => {
    if (nodes[id])
      return true;
    if (Object.keys(nodes).length >= maxVisibleNodes) {
      truncated = true;
      return false;
    }
    const fn = index.getFunction(id);
    if (!fn)
      return false;
    nodes[id] = fn;
    return true;
  };
  const recordDepth = (id, depth) => {
    if (nodeDepths[id] === void 0 || depth < nodeDepths[id]) {
      nodeDepths[id] = depth;
    }
  };
  const bfs = (direction) => {
    const visited = /* @__PURE__ */ new Set([rootId]);
    let frontier = [{ id: rootId, depth: 0 }];
    let depthReached = 0;
    for (let d = 1; d <= maxDepth; d++) {
      if (frontier.length === 0)
        break;
      const nextFrontier = [];
      for (const { id } of frontier) {
        const edges = direction === "out" ? index.getOutgoing(id) : index.getIncoming(id);
        for (const e of edges) {
          const neighborId = direction === "out" ? e.calleeId : e.callerId;
          if (!addNode(neighborId))
            continue;
          recordDepth(neighborId, d);
          const key = edgeKey(e);
          if (!edgeMap.has(key))
            edgeMap.set(key, e);
          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            nextFrontier.push({ id: neighborId, depth: d });
          }
        }
      }
      if (nextFrontier.length > 0)
        depthReached = d;
      frontier = nextFrontier;
    }
    return depthReached;
  };
  const calleeDepth = bfs("out");
  const callerDepth = bfs("in");
  return {
    rootId,
    nodes,
    edges: [...edgeMap.values()],
    nodeDepths,
    mode: "heuristic",
    computedDepth: Math.max(calleeDepth, callerDepth),
    truncated,
    defaultDepth: 5
    // placeholder — overwritten by webviewPanel.postGraph() with the real setting value
  };
}

// src/export/graphExport.ts
function sanitizeId(id) {
  return id.replace(/[^A-Za-z0-9_]/g, "_");
}
function escapeLabel(label) {
  return label.replace(/"/g, '\\"');
}
function toDot(graph) {
  const lines = ["digraph CallGraph {", "  rankdir=LR;", '  node [shape=box, fontname="Helvetica"];'];
  for (const node of Object.values(graph.nodes)) {
    const label = escapeLabel(node.qualifiedName ?? node.name);
    const style = node.id === graph.rootId ? ', style=filled, fillcolor="#2f6fed", fontcolor=white' : !node.active ? ", style=dashed, color=gray" : "";
    lines.push(`  ${sanitizeId(node.id)} [label="${label}"${style}];`);
  }
  for (const edge of graph.edges) {
    const style = edge.kind === "pointer" ? ' [style=dashed, label="via ' + escapeLabel(edge.via ?? "") + '"]' : edge.kind === "virtualCandidate" ? ' [style=dotted, color="#a64dff"]' : "";
    lines.push(`  ${sanitizeId(edge.callerId)} -> ${sanitizeId(edge.calleeId)}${style};`);
  }
  lines.push("}");
  return lines.join("\n");
}
function toMermaid(graph) {
  const lines = ["flowchart LR"];
  for (const node of Object.values(graph.nodes)) {
    const label = (node.qualifiedName ?? node.name).replace(/"/g, "'");
    const shape = node.id === graph.rootId ? `["${label}"]` : `("${label}")`;
    lines.push(`  ${sanitizeId(node.id)}${shape}`);
  }
  for (const edge of graph.edges) {
    const arrow = edge.kind === "pointer" ? "-.->" : edge.kind === "virtualCandidate" ? "-..->" : "-->";
    const label = edge.via ? `|via ${edge.via}|` : "";
    lines.push(`  ${sanitizeId(edge.callerId)} ${arrow}${label} ${sanitizeId(edge.calleeId)}`);
  }
  return lines.join("\n");
}

// src/export/graphvizRunner.ts
var import_child_process = require("child_process");
function renderSvgWithGraphviz(dotBinaryPath, dotText) {
  return new Promise((resolve3, reject) => {
    const proc = (0, import_child_process.spawn)(dotBinaryPath, ["-Tsvg"]);
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => out += d.toString());
    proc.stderr.on("data", (d) => err += d.toString());
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => {
      if (code === 0)
        resolve3(out);
      else
        reject(new Error(err || `dot exited with code ${code}`));
    });
    proc.stdin.write(dotText);
    proc.stdin.end();
  });
}

// src/semantic/resolveConfig.ts
var vscode3 = __toESM(require("vscode"));
var fs2 = __toESM(require("fs"));
var path2 = __toESM(require("path"));
var import_child_process2 = require("child_process");

// src/semantic/compileCommands.ts
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
function shouldDropFlag(arg, nextArg) {
  if (arg === "-c")
    return { drop: true, alsoDropNext: false };
  if (arg === "-o" || arg === "--output")
    return { drop: true, alsoDropNext: true };
  if (arg.startsWith("-o") && arg.length > 2)
    return { drop: true, alsoDropNext: false };
  if (arg === "-MF" || arg === "-MT" || arg === "-MQ")
    return { drop: true, alsoDropNext: true };
  if (arg === "-MD" || arg === "-MMD" || arg === "-MP")
    return { drop: true, alsoDropNext: false };
  return { drop: false, alsoDropNext: false };
}
function tokenizeCommand(cmd) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (c === "\\" && quote === '"' && i + 1 < cmd.length) {
        current += cmd[++i];
      } else {
        current += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += c;
  }
  if (current)
    tokens.push(current);
  return tokens;
}
var CompileCommandsDb = class _CompileCommandsDb {
  constructor() {
    this.byFile = /* @__PURE__ */ new Map();
    this.allFiles = [];
  }
  static load(compileCommandsPath) {
    try {
      const raw = fs.readFileSync(compileCommandsPath, "utf8");
      const json = JSON.parse(raw);
      const db = new _CompileCommandsDb();
      for (const entry of json) {
        const directory = entry.directory ?? path.dirname(compileCommandsPath);
        const file = path.isAbsolute(entry.file) ? entry.file : path.resolve(directory, entry.file);
        let args;
        if (Array.isArray(entry.arguments)) {
          args = entry.arguments;
        } else if (typeof entry.command === "string") {
          args = tokenizeCommand(entry.command);
        } else {
          continue;
        }
        db.byFile.set(path.normalize(file), { directory, file, args });
        db.allFiles.push(path.normalize(file));
      }
      return db;
    } catch {
      return void 0;
    }
  }
  /** Compiler args (cleaned) plus the working directory clang should be invoked from, for a given file. */
  entryFor(filePath) {
    const norm2 = path.normalize(filePath).replace(/\\/g, "/");
    let entry = this.byFile.get(norm2);
    if (!entry) {
      const normLower = norm2.toLowerCase();
      for (const [k, v] of this.byFile) {
        if (k.toLowerCase() === normLower) {
          entry = v;
          break;
        }
      }
    }
    if (!entry) {
      const dir = path.dirname(norm2);
      entry = [...this.byFile.values()].find(
        (e) => path.dirname(e.file.replace(/\\/g, "/")).toLowerCase() === dir.toLowerCase()
      );
    }
    if (!entry)
      return void 0;
    const cleaned = [];
    for (let i = 1; i < entry.args.length; i++) {
      const arg = entry.args[i];
      if (arg === entry.file)
        continue;
      const { drop, alsoDropNext } = shouldDropFlag(arg, entry.args[i + 1]);
      if (drop) {
        if (alsoDropNext)
          i++;
        continue;
      }
      cleaned.push(arg);
    }
    return { args: cleaned, directory: entry.directory };
  }
  /** Compiler args for `filePath`, stripped of flags we don't want when re-invoking ourselves. Prefer entryFor() when you also need the right cwd. */
  argsFor(filePath) {
    return this.entryFor(filePath)?.args;
  }
  hasAnyEntries() {
    return this.allFiles.length > 0;
  }
  entryCount() {
    return this.allFiles.length;
  }
  /** Returns the compiler binary name from the first entry (e.g. "arm-none-eabi-gcc", "clang++"). */
  firstCompiler() {
    if (this.allFiles.length === 0)
      return void 0;
    const firstFile = this.allFiles[0];
    const entry = this.byFile.get(firstFile);
    if (!entry || entry.args.length === 0)
      return void 0;
    return path.basename(entry.args[0]);
  }
};

// src/semantic/resolveConfig.ts
init_diagnostics();
var COMMON_SUBDIRS = [
  "",
  "build",
  "out",
  "cmake-build-debug",
  "cmake-build-release",
  "cmake-build-relwithdebinfo",
  "_build",
  "release",
  "debug"
];
function findClangVersion(binary) {
  try {
    const out = (0, import_child_process2.execFileSync)(binary, ["--version"], {
      timeout: 5e3,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    return out.split("\n")[0]?.trim() ?? "unknown";
  } catch {
    return "not found";
  }
}
var norm = (p) => p.replace(/\\/g, "/");
function isDir(p) {
  try {
    return fs2.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function resolveToFile(p) {
  return p.endsWith("/") || isDir(p) ? norm(path2.join(p, "compile_commands.json")) : p;
}
function resolveSemanticConfig() {
  const folders = vscode3.workspace.workspaceFolders;
  if (!folders || folders.length === 0)
    return void 0;
  const workspaceRoot = norm(folders[0].uri.fsPath);
  const cfg = vscode3.workspace.getConfiguration("callgraph");
  let clangBinaryRaw = cfg.get("clangBinaryPath", "").trim();
  if (clangBinaryRaw) {
    clangBinaryRaw = norm(clangBinaryRaw);
    if (clangBinaryRaw.endsWith("/") || isDir(clangBinaryRaw)) {
      const exeName = process.platform === "win32" ? "clang++.exe" : "clang++";
      clangBinaryRaw = norm(path2.join(clangBinaryRaw, exeName));
      logInfo(`clangBinaryPath was a directory \u2014 resolved to: ${clangBinaryRaw}`);
    }
  }
  const userSetClang = clangBinaryRaw.length > 0;
  const clangBinary = clangBinaryRaw || "clang++";
  let ccPath = "";
  const explicitCc = norm(cfg.get("compileCommandsPath", "").trim());
  if (explicitCc) {
    let r = path2.isAbsolute(explicitCc) ? explicitCc : path2.join(workspaceRoot, explicitCc);
    ccPath = resolveToFile(norm(r));
  }
  if (!ccPath) {
    const buildDirRaw = cfg.get("buildDirectory", "").trim();
    if (buildDirRaw) {
      const buildDirs = buildDirRaw.split(",").map((d) => d.trim()).filter(Boolean);
      const tried = [];
      for (const dir of buildDirs) {
        const base = path2.isAbsolute(dir) ? dir : path2.join(workspaceRoot, dir);
        const candidate = norm(path2.join(base, "compile_commands.json"));
        tried.push(candidate);
        if (fs2.existsSync(candidate)) {
          ccPath = candidate;
          logInfo(`compile_commands.json found via buildDirectory "${dir}"`);
          break;
        }
      }
      if (!ccPath && buildDirs.length > 0) {
        logWarn(`None of the buildDirectory entries contained compile_commands.json.`);
        logWarn(`Tried: ${tried.join(", ")}`);
      }
    }
  }
  if (!ccPath) {
    for (const sub of COMMON_SUBDIRS) {
      const candidate = norm(path2.join(workspaceRoot, sub, "compile_commands.json"));
      if (fs2.existsSync(candidate)) {
        ccPath = candidate;
        logInfo(`Auto-detected compile_commands.json at: ${candidate}`);
        break;
      }
    }
  }
  if (!ccPath || !fs2.existsSync(ccPath)) {
    logInfo("No compile_commands.json found \u2014 running in pure heuristic mode");
    logInfo('To enable clang verification: set callgraph.buildDirectory (comma-separated, e.g. "build, Debug_FLASH") or callgraph.compileCommandsPath');
    return void 0;
  }
  if (isDir(ccPath)) {
    const withFile = norm(path2.join(ccPath, "compile_commands.json"));
    if (fs2.existsSync(withFile)) {
      logInfo(`Path was a directory \u2014 using compile_commands.json inside: ${withFile}`);
      ccPath = withFile;
    } else {
      logWarn(`"${ccPath}" is a directory but contains no compile_commands.json`);
      return void 0;
    }
  }
  const db = CompileCommandsDb.load(ccPath);
  if (!db || !db.hasAnyEntries()) {
    logWarn(`Failed to parse compile_commands.json at: ${ccPath}`);
    try {
      const raw = fs2.readFileSync(ccPath, "utf8").trim();
      logWarn(raw.startsWith("[") ? 'JSON parsed but contained 0 entries \u2014 check "file" and "arguments"/"command" fields' : 'File does not start with "[" \u2014 expected a JSON array');
    } catch (e) {
      logWarn(`Could not read file: ${e?.message ?? e}`);
    }
    return void 0;
  }
  logOk(`compile_commands.json: ${ccPath} (${db.entryCount()} entries)`);
  const firstCompiler = db.firstCompiler() ?? "";
  const CROSS_RE = /arm-none-eabi|arm-linux|avr-gcc|msp430|xtensa|riscv|m68k|powerpc|aarch64-linux/i;
  const isCrossCompiler = CROSS_RE.test(firstCompiler);
  if (isCrossCompiler) {
    if (userSetClang) {
      logInfo(`compile_commands.json uses cross-compiler "${firstCompiler}".`);
      logInfo(`You have set callgraph.clangBinaryPath \u2014 will attempt clang AST queries.`);
      logInfo(`Make sure your clang supports the same target (e.g. arm-none-eabi via LLVM Embedded Toolchain).`);
    } else {
      logWarn(`Compiler "${firstCompiler}" is a cross-compiler. Clang AST verification is disabled.`);
      logInfo(`To enable it: set callgraph.clangBinaryPath to an ARM-capable clang++ binary`);
      logInfo(`(e.g. LLVM Embedded Toolchain: ...\\LLVM-ET-Arm-XX\\bin\\clang++.exe)`);
      return void 0;
    }
  }
  const clangVersion = findClangVersion(clangBinary);
  if (clangVersion === "not found") {
    logError(`clang binary not found: "${clangBinary}"`);
    if (clangBinary.endsWith("clang++.exe") || clangBinary.endsWith("clang++")) {
      logError("Check that the path exists and the binary is executable.");
    }
    return void 0;
  }
  logOk(`clang binary: ${clangBinary}`);
  logOk(`clang version: ${clangVersion}`);
  if (isCrossCompiler && !/arm|embedded|ET/i.test(clangVersion)) {
    logWarn(`clang version string doesn't mention ARM \u2014 if this is a native x86 clang it cannot compile ARM code.`);
    logWarn(`Expected something like "LLVM Embedded Toolchain for Arm" or "Target: arm-none-eabi".`);
  }
  return {
    clangBinary,
    compileCommandsDb: db,
    workspaceRoot,
    maxCallerConfirmations: cfg.get("maxCallerConfirmations", 15),
    timeoutMs: 8e3
  };
}

// src/semantic/semanticEnrichment.ts
var path4 = __toESM(require("path"));
init_diagnostics();

// src/semantic/clangAstQuery.ts
var import_child_process3 = require("child_process");
var path3 = __toESM(require("path"));
init_diagnostics();
var DEFAULT_TIMEOUT_MS = 8e3;
function queryClangAst(opts) {
  const { clangBinary, filePath, compilerArgs, filterName, cwd, timeoutMs } = opts;
  const args = [
    "-Xclang",
    "-ast-dump=json",
    "-Xclang",
    `-ast-dump-filter=${filterName}`,
    "-fsyntax-only",
    ...compilerArgs,
    filePath
  ];
  return new Promise((resolve3) => {
    const proc = (0, import_child_process3.spawn)(clangBinary, args, { cwd });
    let stdout = "";
    let stderrTail = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled)
        return;
      settled = true;
      proc.kill();
      resolve3({ ok: false, roots: [], error: `clang query timed out after ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` });
    }, timeoutMs ?? DEFAULT_TIMEOUT_MS);
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2e3);
    });
    proc.on("error", (err) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      resolve3({ ok: false, roots: [], error: `failed to spawn ${clangBinary}: ${err.message}` });
    });
    proc.on("close", () => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      if (!stdout.trim()) {
        const msg = stderrTail || "clang produced no output";
        logWarn(`clang query [${filterName}] in ${path3.basename(filePath)}: no output \u2014 ${msg.slice(0, 120)}`);
        resolve3({ ok: false, roots: [], error: msg });
        return;
      }
      const roots = splitConcatenatedJson(stdout);
      if (roots.length === 0) {
        logWarn(`clang query [${filterName}] in ${path3.basename(filePath)}: JSON parse failed`);
        resolve3({ ok: false, roots: [], error: "could not parse clang JSON output" });
        return;
      }
      logOk(`clang query [${filterName}] in ${path3.basename(filePath)}: ${roots.length} match(es)`);
      resolve3({ ok: true, roots });
    });
  });
}
function splitConcatenatedJson(text) {
  const results = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped)
        escaped = false;
      else if (c === "\\")
        escaped = true;
      else if (c === '"')
        inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0)
        start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const chunk = text.slice(start, i + 1);
        try {
          results.push(JSON.parse(chunk));
        } catch {
        }
        start = -1;
      }
    }
  }
  return results;
}
function findNodes(node, kind, out = []) {
  const nodes = Array.isArray(node) ? node : [node];
  for (const n of nodes) {
    if (!n || typeof n !== "object")
      continue;
    if (n.kind === kind)
      out.push(n);
    if (Array.isArray(n.inner))
      findNodes(n.inner, kind, out);
  }
  return out;
}
function findCallSites(node) {
  const directCalls = findNodes(node, "CallExpr");
  const memberCalls = findNodes(node, "CXXMemberCallExpr");
  const results = [];
  for (const call of directCalls) {
    const refs = findNodes(call, "DeclRefExpr");
    const calleeRef = refs.find((r) => r.referencedDecl)?.referencedDecl;
    if (calleeRef && (calleeRef.kind === "FunctionDecl" || calleeRef.kind === "CXXMethodDecl")) {
      results.push({ call, calleeName: calleeRef.name ?? "", calleeType: calleeRef.type?.qualType, calleeKind: calleeRef.kind });
    }
  }
  for (const call of memberCalls) {
    const memberExpr = findNodes(call, "MemberExpr")[0];
    if (memberExpr?.name) {
      results.push({ call, calleeName: memberExpr.name, calleeKind: "CXXMethodDecl" });
    }
  }
  return results;
}

// src/semantic/semanticEnrichment.ts
function pickRootByLine(roots, line) {
  if (roots.length <= 1 || line === void 0)
    return roots[0];
  for (const r of roots) {
    const decl = [...findNodes(r, "CXXMethodDecl"), ...findNodes(r, "FunctionDecl")].find((d) => d.loc?.line === line);
    if (decl)
      return r;
  }
  return roots[0];
}
async function confirmCallees(fn, absFilePath, cfg) {
  const entry = cfg.compileCommandsDb.entryFor(absFilePath);
  if (!entry)
    return { ok: false, calleeNames: /* @__PURE__ */ new Set() };
  const res = await queryClangAst({
    clangBinary: cfg.clangBinary,
    filePath: absFilePath,
    compilerArgs: entry.args,
    filterName: fn.qualifiedName ?? fn.name,
    cwd: entry.directory,
    timeoutMs: cfg.timeoutMs
  });
  if (!res.ok || res.roots.length === 0)
    return { ok: false, calleeNames: /* @__PURE__ */ new Set() };
  const root = pickRootByLine(res.roots, fn.location.line);
  const sites = findCallSites(root);
  return { ok: true, calleeNames: new Set(sites.map((s) => s.calleeName)) };
}
async function confirmCallerReferencesCallee(callerFn, absCallerFile, calleeName, cfg) {
  const entry = cfg.compileCommandsDb.entryFor(absCallerFile);
  if (!entry)
    return void 0;
  const res = await queryClangAst({
    clangBinary: cfg.clangBinary,
    filePath: absCallerFile,
    compilerArgs: entry.args,
    filterName: callerFn.qualifiedName ?? callerFn.name,
    cwd: entry.directory,
    timeoutMs: cfg.timeoutMs
  });
  if (!res.ok || res.roots.length === 0)
    return void 0;
  const root = pickRootByLine(res.roots, callerFn.location.line);
  const sites = findCallSites(root);
  return sites.some((s) => s.calleeName === calleeName);
}
async function confirmClassInfo(className, absFilePath, cfg) {
  const entry = cfg.compileCommandsDb.entryFor(absFilePath);
  if (!entry)
    return { ok: false, bases: [], polymorphic: false };
  const res = await queryClangAst({
    clangBinary: cfg.clangBinary,
    filePath: absFilePath,
    compilerArgs: entry.args,
    filterName: className,
    cwd: entry.directory,
    timeoutMs: cfg.timeoutMs
  });
  if (!res.ok)
    return { ok: false, bases: [], polymorphic: false };
  for (const root of res.roots) {
    const record = findNodes(root, "CXXRecordDecl").find((r) => r.name === className && (r.definitionData || r.bases));
    if (record) {
      const bases = (record.bases ?? []).map((b) => b.type?.qualType).filter((x) => !!x);
      return { ok: true, bases, polymorphic: !!record.definitionData?.isPolymorphic };
    }
  }
  return { ok: true, bases: [], polymorphic: false };
}
async function enrichCallGraph(graph, classLookup, cfg) {
  const rootNode = graph.nodes[graph.rootId];
  if (!rootNode)
    return { ...graph, semanticEnrichmentApplied: true };
  logSection(`Enriching graph for ${rootNode.qualifiedName ?? rootNode.name}`);
  const rootAbsFile = path4.resolve(cfg.workspaceRoot, rootNode.location.file);
  const calleeResult = await confirmCallees(rootNode, rootAbsFile, cfg);
  const incomingToRoot = graph.edges.filter((e) => e.calleeId === graph.rootId && e.kind === "direct");
  const distinctCallerIds = [...new Set(incomingToRoot.map((e) => e.callerId))].slice(0, cfg.maxCallerConfirmations);
  const callerConfirmations = /* @__PURE__ */ new Map();
  for (const callerId of distinctCallerIds) {
    const callerNode = graph.nodes[callerId];
    if (!callerNode)
      continue;
    const callerAbsFile = path4.resolve(cfg.workspaceRoot, callerNode.location.file);
    const result = await confirmCallerReferencesCallee(callerNode, callerAbsFile, rootNode.name, cfg);
    if (result !== void 0)
      callerConfirmations.set(callerId, result);
  }
  const enrichedEdges = graph.edges.map((e) => {
    if (e.callerId === graph.rootId && e.kind === "direct" && calleeResult.ok) {
      const calleeNode = graph.nodes[e.calleeId];
      return { ...e, confirmed: calleeNode ? calleeResult.calleeNames.has(calleeNode.name) : false };
    }
    if (e.calleeId === graph.rootId && e.kind === "direct" && callerConfirmations.has(e.callerId)) {
      return { ...e, confirmed: callerConfirmations.get(e.callerId) };
    }
    return e;
  });
  const extraNodes = {};
  const extraEdges = [];
  if (rootNode.className) {
    const classConfirmation = await confirmClassInfo(rootNode.className, rootAbsFile, cfg);
    if (classConfirmation.ok && classConfirmation.polymorphic) {
      const subclasses = classLookup.getAllClasses().filter((c) => c.bases.includes(rootNode.className));
      for (const sub of subclasses) {
        const override = sub.methods.find((m) => m.name === rootNode.name && m.id !== rootNode.id);
        if (!override)
          continue;
        extraNodes[override.id] = { ...override, virtualConfirmed: true };
        for (const callerId of distinctCallerIds) {
          const originalCallSite = incomingToRoot.find((e) => e.callerId === callerId)?.callSite ?? rootNode.location;
          extraEdges.push({
            callerId,
            calleeId: override.id,
            kind: "virtualCandidate",
            callSite: originalCallSite,
            confirmed: true
          });
        }
      }
    }
  }
  return {
    ...graph,
    nodes: { ...graph.nodes, ...extraNodes },
    edges: [...enrichedEdges, ...extraEdges],
    semanticEnrichmentApplied: true
  };
}

// src/webviewPanel.ts
init_diagnostics();
function getNonce() {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++)
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
function edgeKey2(e) {
  return `${e.callerId}|${e.calleeId}|${e.callSite.line}|${e.callSite.column}`;
}
var CallGraphPanel = class _CallGraphPanel {
  constructor(context, index) {
    this.context = context;
    this.index = index;
    this.accumulatedNodes = {};
    this.accumulatedEdges = /* @__PURE__ */ new Map();
    this.accumulatedDepths = {};
    this.currentComputedDepth = 0;
    this.currentTruncated = false;
    this.mode = "callgraph";
    this.lastDiagramType = "uml";
    this.panel = vscode4.window.createWebviewPanel(
      "callgraph",
      "C/C++ Call Graph",
      vscode4.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode4.Uri.joinPath(context.extensionUri, "media")]
      }
    );
    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => {
      _CallGraphPanel.current = void 0;
    });
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    _CallGraphPanel.current = this;
  }
  /** Called by the file watcher (debounced) — re-scans and re-renders the active panel if one is open. */
  static async refreshCurrent(index) {
    const panel = _CallGraphPanel.current;
    if (!panel)
      return;
    if (panel.mode === "classDiagram") {
      await panel.loadClassUml(index, panel.lastDiagramType ?? "uml", void 0);
      return;
    }
    if (!panel.rootFunctionName || !panel.rootFunctionFile)
      return;
    await index.ensureFresh();
    const fn = index.getAllFunctions().find(
      (f) => f.name === panel.rootFunctionName && f.location.file === panel.rootFunctionFile
    );
    if (!fn)
      return;
    panel.resetAccumulation();
    await panel.loadGraph(index, fn.id);
  }
  static async createOrShow(context, index, rootId) {
    if (_CallGraphPanel.current) {
      _CallGraphPanel.current.panel.reveal(vscode4.ViewColumn.Beside);
      _CallGraphPanel.current.mode = "callgraph";
      _CallGraphPanel.current.resetAccumulation();
      await _CallGraphPanel.current.loadGraph(index, rootId);
      return;
    }
    const instance = new _CallGraphPanel(context, index);
    await instance.loadGraph(index, rootId);
  }
  static async createOrShowClassDiagram(context, index, diagramType = "uml", rootClassId) {
    if (_CallGraphPanel.current) {
      _CallGraphPanel.current.panel.reveal(vscode4.ViewColumn.Beside);
      _CallGraphPanel.current.mode = "classDiagram";
      await _CallGraphPanel.current.loadClassUml(index, diagramType, rootClassId);
      return;
    }
    const instance = new _CallGraphPanel(context, index);
    instance.mode = "classDiagram";
    await instance.loadClassUml(index, diagramType, rootClassId);
  }
  sendUiConfig() {
    const cfg = vscode4.workspace.getConfiguration("callgraph");
    this.post({
      type: "uiConfig",
      popup: {
        fontSize: cfg.get("popup.fontSize", 12),
        width: cfg.get("popup.width", 440),
        height: cfg.get("popup.height", 280)
      }
    });
  }
  resetAccumulation() {
    for (const k of Object.keys(this.accumulatedNodes))
      delete this.accumulatedNodes[k];
    for (const k of Object.keys(this.accumulatedDepths))
      delete this.accumulatedDepths[k];
    this.accumulatedEdges.clear();
    this.currentComputedDepth = 0;
    this.currentTruncated = false;
    this.rootId = void 0;
    this.rootFunctionName = void 0;
    this.rootFunctionFile = void 0;
  }
  getHtml() {
    const webview = this.panel.webview;
    const mediaUri = (...segs) => webview.asWebviewUri(vscode4.Uri.joinPath(this.context.extensionUri, "media", ...segs));
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<link rel="stylesheet" href="${mediaUri("webview.css")}" />
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${mediaUri("vendor", "cytoscape.min.js")}"></script>
<script nonce="${nonce}" src="${mediaUri("vendor", "dagre.min.js")}"></script>
<script nonce="${nonce}" src="${mediaUri("vendor", "cytoscape-dagre.min.js")}"></script>
<script nonce="${nonce}" src="${mediaUri("webview.js")}"></script>
</body>
</html>`;
  }
  mergeIntoAccumulated(data, depthOffset = 0) {
    Object.assign(this.accumulatedNodes, data.nodes);
    for (const e of data.edges) {
      this.accumulatedEdges.set(edgeKey2(e), e);
    }
    for (const [id, d] of Object.entries(data.nodeDepths)) {
      const offsetDepth = d + depthOffset;
      if (this.accumulatedDepths[id] === void 0 || offsetDepth < this.accumulatedDepths[id]) {
        this.accumulatedDepths[id] = offsetDepth;
      }
    }
    this.currentComputedDepth = Math.max(this.currentComputedDepth, data.computedDepth + depthOffset);
    this.currentTruncated = this.currentTruncated || data.truncated;
  }
  async loadGraph(index, rootId, depth = 20, depthOffset = 0) {
    await index.ensureFresh();
    if (!this.rootId) {
      this.rootId = rootId;
      const fn = index.getFunction(rootId);
      if (fn) {
        this.rootFunctionName = fn.name;
        this.rootFunctionFile = fn.location.file;
      }
    }
    const cfg = vscode4.workspace.getConfiguration("callgraph");
    const maxNodes = cfg.get("maxVisibleNodes", 500);
    try {
      let data = buildCallGraph(index, rootId, Math.min(depth, 20), maxNodes);
      const semanticCfg = resolveSemanticConfig();
      if (semanticCfg) {
        this.post({ type: "enrichmentStatus", status: "checking" });
        setStatusBarMode("verifying");
        try {
          data = await enrichCallGraph(data, index, semanticCfg);
          setStatusBarMode("verified");
        } catch (enrichErr) {
          logError(`Enrichment failed: ${enrichErr?.message ?? enrichErr}`);
          setStatusBarMode("error");
        }
        this.post({ type: "enrichmentStatus", status: "idle" });
      } else {
        setStatusBarMode("heuristic");
      }
      this.mergeIntoAccumulated(data, depthOffset);
      this.postGraph();
    } catch (err) {
      this.post({ type: "error", message: err?.message ?? String(err) });
    }
  }
  async loadClassUml(index, diagramType, rootClassId) {
    this.lastDiagramType = diagramType;
    await index.ensureFresh();
    const data = index.buildClassGraph(diagramType, rootClassId);
    const cfg = vscode4.workspace.getConfiguration("callgraph");
    const ctagsPath = cfg.get("ctagsPath", "").trim();
    if (ctagsPath && diagramType === "usage") {
      const folders = vscode4.workspace.workspaceFolders;
      if (folders) {
        try {
          const { runCtags: runCtags2, buildTypeUsageMap: buildTypeUsageMap2 } = await Promise.resolve().then(() => (init_ctagsIndex(), ctagsIndex_exports));
          const entries = await runCtags2(ctagsPath, folders[0].uri.fsPath);
          const usageMap = buildTypeUsageMap2(entries);
          for (const [className, files] of usageMap) {
            const callerClass = [...Object.values(data.classes)].find((c) => c.name === className);
            if (!callerClass)
              continue;
            for (const filePath of files) {
              const usersInFile = [...Object.values(data.classes)].filter((c) => c.location.file === filePath && c.id !== callerClass.id);
              for (const userCls of usersInFile) {
                const edgeId = `${userCls.id}\u2192${callerClass.id}:usage`;
                if (!data.edges.find((e) => e.fromId === userCls.id && e.toId === callerClass.id)) {
                  data.edges.push({ fromId: userCls.id, toId: callerClass.id, kind: "dependency", access: "public" });
                }
              }
            }
          }
        } catch {
        }
      }
    }
    this.post({ type: "classUml", data });
  }
  postGraph() {
    if (!this.rootId)
      return;
    const cfg = vscode4.workspace.getConfiguration("callgraph");
    const data = {
      rootId: this.rootId,
      nodes: this.accumulatedNodes,
      edges: [...this.accumulatedEdges.values()],
      nodeDepths: { ...this.accumulatedDepths },
      mode: "heuristic",
      computedDepth: this.currentComputedDepth,
      truncated: this.currentTruncated,
      defaultDepth: cfg.get("defaultDepth", 5)
    };
    this.post({ type: "graph", data });
  }
  post(msg) {
    this.panel.webview.postMessage(msg);
  }
  async handleMessage(msg) {
    switch (msg.type) {
      case "ready":
        this.sendUiConfig();
        if (this.mode === "classDiagram")
          await this.loadClassUml(this.index, this.lastDiagramType);
        else
          this.postGraph();
        return;
      case "expandNode": {
        const offset = this.accumulatedDepths[msg.nodeId] ?? 0;
        await this.loadGraph(this.index, msg.nodeId, msg.depth, offset);
        return;
      }
      case "requestDepth":
        if (this.rootId) {
          const cfg = vscode4.workspace.getConfiguration("callgraph");
          const maxNodes = cfg.get("maxVisibleNodes", 500) * 2;
          try {
            const data = buildCallGraph(this.index, this.rootId, Math.min(msg.depth, 20), maxNodes);
            this.mergeIntoAccumulated(data);
            this.postGraph();
          } catch (err) {
            this.post({ type: "error", message: err?.message ?? String(err) });
          }
        }
        return;
      case "requestSource":
        await this.sendSource(msg.nodeId);
        return;
      case "openLocation":
        await this.openLocation(msg.location);
        return;
      case "exportGraph":
        await this.exportGraph(msg.format);
        return;
    }
  }
  async sendSource(nodeId) {
    const fn = this.index.getFunction(nodeId);
    if (!fn)
      return;
    try {
      const uri = this.resolveUri(fn.location.file);
      const doc = await vscode4.workspace.openTextDocument(uri);
      const range = this.index.getFunctionRange(nodeId);
      const bodyEnd = range ? Math.min(doc.lineCount - 1, range.endLine) : Math.min(doc.lineCount - 1, fn.location.line + 59);
      let commentStart = fn.location.line - 1;
      for (let i = commentStart - 1; i >= Math.max(0, commentStart - 12); i--) {
        const t = doc.lineAt(i).text.trim();
        if (t === "")
          break;
        if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.endsWith("*/")) {
          commentStart = i;
        } else
          break;
      }
      const startLine0 = commentStart;
      const endLine0 = bodyEnd - 1;
      const text = doc.getText(
        new vscode4.Range(startLine0, 0, endLine0, doc.lineAt(endLine0).text.length)
      );
      this.post({ type: "sourceSnippet", nodeId, source: text, startLine: startLine0 + 1 });
    } catch {
      this.post({ type: "error", message: `Could not load source for ${fn.name}` });
    }
  }
  async openLocation(loc) {
    try {
      const uri = this.resolveUri(loc.file);
      const doc = await vscode4.workspace.openTextDocument(uri);
      const editor = await vscode4.window.showTextDocument(doc, vscode4.ViewColumn.One);
      const pos = new vscode4.Position(Math.max(0, loc.line - 1), Math.max(0, loc.column - 1));
      editor.selection = new vscode4.Selection(pos, pos);
      editor.revealRange(new vscode4.Range(pos, pos), vscode4.TextEditorRevealType.InCenter);
    } catch {
      vscode4.window.showErrorMessage("Could not open that source location.");
    }
  }
  resolveUri(relPath) {
    const folders = vscode4.workspace.workspaceFolders;
    if (!folders || folders.length === 0)
      throw new Error("No workspace folder open");
    return vscode4.Uri.joinPath(folders[0].uri, relPath);
  }
  async exportGraph(format) {
    if (!this.rootId)
      return;
    const cfg2 = vscode4.workspace.getConfiguration("callgraph");
    const data = {
      rootId: this.rootId,
      nodes: this.accumulatedNodes,
      edges: [...this.accumulatedEdges.values()],
      nodeDepths: { ...this.accumulatedDepths },
      mode: "heuristic",
      computedDepth: this.currentComputedDepth,
      truncated: this.currentTruncated,
      defaultDepth: cfg2.get("defaultDepth", 5)
    };
    try {
      if (format === "mermaid") {
        const doc2 = await vscode4.workspace.openTextDocument({ content: toMermaid(data), language: "markdown" });
        await vscode4.window.showTextDocument(doc2, vscode4.ViewColumn.One);
        return;
      }
      const dotText = toDot(data);
      if (format === "dot") {
        const doc2 = await vscode4.workspace.openTextDocument({ content: dotText, language: "plaintext" });
        await vscode4.window.showTextDocument(doc2, vscode4.ViewColumn.One);
        return;
      }
      const cfg = vscode4.workspace.getConfiguration("callgraph");
      const dotPath = cfg.get("graphvizDotPath", "");
      if (!dotPath) {
        vscode4.window.showWarningMessage(
          'SVG export needs callgraph.graphvizDotPath set to a Graphviz "dot" binary. Exporting as DOT text instead.'
        );
        const doc2 = await vscode4.workspace.openTextDocument({ content: dotText, language: "plaintext" });
        await vscode4.window.showTextDocument(doc2, vscode4.ViewColumn.One);
        return;
      }
      const svg = await renderSvgWithGraphviz(dotPath, dotText);
      const doc = await vscode4.workspace.openTextDocument({ content: svg, language: "xml" });
      await vscode4.window.showTextDocument(doc, vscode4.ViewColumn.One);
    } catch (err) {
      vscode4.window.showErrorMessage(`Export failed: ${err?.message ?? err}`);
    }
  }
};

// src/extension.ts
init_diagnostics();
var FILE_GLOB2 = "**/*.{c,cc,cpp,cxx,h,hh,hpp,hxx}";
function activate(context) {
  initDiagnostics(context);
  logSection("C/C++ Call Graph Visualizer \u2014 activated");
  const index = new WorkspaceIndex();
  let refreshTimer;
  const scheduleRefresh = (uri) => {
    index.markDirty();
    logInfo(`File changed: ${vscode5.workspace.asRelativePath(uri)} \u2014 refresh scheduled`);
    if (refreshTimer)
      clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      refreshTimer = void 0;
      await CallGraphPanel.refreshCurrent(index);
    }, 400);
  };
  const watcher = vscode5.workspace.createFileSystemWatcher(FILE_GLOB2);
  watcher.onDidChange(scheduleRefresh);
  watcher.onDidCreate(scheduleRefresh);
  watcher.onDidDelete(scheduleRefresh);
  context.subscriptions.push(watcher);
  context.subscriptions.push(
    vscode5.commands.registerCommand("callgraph.showForCursor", async () => {
      const editor = vscode5.window.activeTextEditor;
      if (!editor) {
        vscode5.window.showInformationMessage("Open a C/C++ file and place the cursor inside a function first.");
        return;
      }
      if (editor.document.languageId !== "c" && editor.document.languageId !== "cpp") {
        vscode5.window.showInformationMessage("Call Graph only works on C/C++ files.");
        return;
      }
      await index.ensureFresh();
      const relPath = vscode5.workspace.asRelativePath(editor.document.uri, false);
      const line = editor.selection.active.line + 1;
      let fn = index.findFunctionAtLine(relPath, line);
      if (!fn) {
        const lineText = editor.document.lineAt(editor.selection.active.line).text;
        fn = index.findFunctionByNameOnLine(lineText, relPath);
        if (fn) {
          logInfo(`Cursor was on a declaration; resolved to definition: ${fn.qualifiedName ?? fn.name} at ${fn.location.file}:${fn.location.line}`);
        }
      }
      if (!fn) {
        vscode5.window.showInformationMessage(
          'No function detected at the cursor.\n\u2022 For function definitions: place cursor anywhere inside the function body.\n\u2022 For declarations (header files): the definition must be in a scanned source file.\nRun "Call Graph: Show Diagnostics" and check the indexed function count.'
        );
        return;
      }
      logInfo(`Showing call graph for: ${fn.qualifiedName ?? fn.name} at ${relPath}:${line}`);
      await CallGraphPanel.createOrShow(context, index, fn.id);
    })
  );
  context.subscriptions.push(
    vscode5.commands.registerCommand("callgraph.refreshIndex", async () => {
      logSection("Manual index rebuild");
      index.markDirty();
      await index.ensureFresh();
      const fnCount = index.getAllFunctions().length;
      const clsCount = index.getAllClasses().length;
      logOk(`Index rebuilt \u2014 ${fnCount} functions, ${clsCount} classes`);
      vscode5.window.showInformationMessage(`Call graph index rebuilt: ${fnCount} functions, ${clsCount} classes.`);
    })
  );
  context.subscriptions.push(
    vscode5.commands.registerCommand("callgraph.showClassDiagram", async () => {
      const rootId = await findClassAtCursor(index);
      await CallGraphPanel.createOrShowClassDiagram(context, index, "hierarchy", rootId);
    })
  );
  context.subscriptions.push(
    vscode5.commands.registerCommand("callgraph.showClassUml", async () => {
      const rootId = await findClassAtCursor(index);
      await CallGraphPanel.createOrShowClassDiagram(context, index, "uml", rootId);
    })
  );
  context.subscriptions.push(
    vscode5.commands.registerCommand("callgraph.showUsageDiagram", async () => {
      const rootId = await findClassAtCursor(index);
      await CallGraphPanel.createOrShowClassDiagram(context, index, "usage", rootId);
    })
  );
  context.subscriptions.push(
    vscode5.commands.registerCommand("callgraph.showDiagnostics", () => {
      show();
    })
  );
  context.subscriptions.push(
    vscode5.commands.registerCommand("callgraph.listMacroAliases", async () => {
      show();
      logSection("Listing all detected macro function-aliases");
      await index.ensureFresh();
      const aliases = index.getMacroAliases();
      if (aliases.size === 0) {
        logWarn("No macro aliases found. Ensure that your interface header files (.h/.hpp) are inside the VS Code workspace and not excluded by callgraph settings or the build/ out/ dist/ directories.");
      } else {
        logOk(`${aliases.size} macro alias(es) detected:`);
        for (const [alias, real] of aliases) {
          logInfo(`  ${alias}  \u2192  ${real}`);
        }
      }
    })
  );
}
function deactivate() {
  dispose();
}
async function findClassAtCursor(index) {
  const editor = vscode5.window.activeTextEditor;
  if (!editor)
    return void 0;
  if (editor.document.languageId !== "c" && editor.document.languageId !== "cpp")
    return void 0;
  await index.ensureFresh();
  const relPath = vscode5.workspace.asRelativePath(editor.document.uri, false);
  const line = editor.selection.active.line + 1;
  return index.findClassAtLine(relPath, line)?.id;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
