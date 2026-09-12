"use strict";
(() => {
  // src/webview/main.ts
  var vscode = acquireVsCodeApi();
  function send(msg) {
    vscode.postMessage(msg);
  }
  var ALL_FILTERS = ["direct", "pointer", "virtual", "confirmed", "contradicted", "unchecked", "inactive", "lambda"];
  var saved = vscode.getState() ?? {};
  var theme = saved.theme ?? "dark";
  var currentLayout = saved.layout ?? "dagre-lr";
  var currentDepth = saved.depth ?? 0;
  var sidebarWidth = saved.sidebarWidth ?? 280;
  var sidebarCollapsed = saved.sidebarCollapsed ?? false;
  var depthSeeded = saved.depthSeeded ?? false;
  var filtersCollapsed = saved.filtersCollapsed ?? false;
  var clustered = saved.clustered ?? false;
  var classNsFilters = /* @__PURE__ */ new Set();
  var classFileFilters = /* @__PURE__ */ new Set();
  var pathMode = saved.pathMode ?? false;
  var activeFilters = new Set(saved.filters ?? [...ALL_FILTERS]);
  function saveState() {
    vscode.setState({
      theme,
      layout: currentLayout,
      depth: currentDepth,
      sidebarWidth,
      sidebarCollapsed,
      depthSeeded,
      filters: [...activeFilters],
      filtersCollapsed,
      clustered,
      pathMode
    });
  }
  var fullGraph = null;
  var classHierarchy = null;
  var classUmlData = null;
  var uiMode = "callgraph";
  var selectedNodeId = null;
  var callSiteCycle = [];
  var callSiteIndex = -1;
  var cy = null;
  var depthFetchTimer;
  var popupNodeId = null;
  var popupPinned = false;
  var popupHovered = false;
  var popupDragOffX = 0;
  var popupDragOffY = 0;
  document.getElementById("app").innerHTML = `
<div class="toolbar">
  <span class="mode-badge" id="modeBadge">heuristic mode</span>
  <span class="enrich-status" id="enrichStatus" hidden>verifying with clang\u2026</span>
  <div class="depth-control" id="depthControl">
    <label for="depthSlider">Depth <span id="depthValue">\u2013</span>/20</label>
    <input type="range" id="depthSlider" min="1" max="20" value="5"/>
  </div>
  <div class="layout-control">
    <label for="layoutSel">Layout</label>
    <select id="layoutSel">
      <option value="dagre-lr"     ${currentLayout === "dagre-lr" ? "selected" : ""}>\u2192 Horizontal</option>
      <option value="dagre-tb"     ${currentLayout === "dagre-tb" ? "selected" : ""}>\u2193 Vertical</option>
      <option value="dagre-bt"     ${currentLayout === "dagre-bt" ? "selected" : ""}>\u2191 Hierarchy</option>
      <option value="breadthfirst" ${currentLayout === "breadthfirst" ? "selected" : ""}>\u22A5 Tree</option>
      <option value="cose"         ${currentLayout === "cose" ? "selected" : ""}>\u2B21 Force</option>
      <option value="circle"       ${currentLayout === "circle" ? "selected" : ""}>\u25CB Circle</option>
      <option value="radial"       ${currentLayout === "radial" ? "selected" : ""}>\u2B24 Radial</option>
    </select>
  </div>
  <span class="node-count" id="nodeCount"></span>
  <div class="spacer"></div>
  <button class="toolbar-btn ${clustered ? "active" : ""}" id="clusterToggle" title="Group functions by class / file (reduces visual complexity)">\u2B21 Group</button>
  <button class="toolbar-btn ${pathMode ? "active" : ""}" id="pathToggle" title="Show only the path from root to selected node">\u2934 Path</button>
  <button class="toolbar-btn" id="sidebarToggle" title="Toggle sidebar">\u2630</button>
  <button class="toolbar-btn" id="themeToggle" title="Toggle theme">${theme === "dark" ? "\u2600\uFE0F" : "\u{1F319}"}</button>
  <div class="export-controls">
    <button id="exportDot">DOT</button>
    <button id="exportMermaid">Mermaid</button>
    <button id="exportSvg">SVG</button>
  </div>
</div>
<div class="banner" id="banner" hidden></div>
<div class="legend" id="legend">
  <span><i class="swatch swatch-confirmed"></i>clang-confirmed</span>
  <span><i class="swatch swatch-unconfirmed"></i>heuristic, clang disagrees</span>
  <span><i class="swatch swatch-unverified"></i>unchecked</span>
  <span><i class="swatch swatch-pointer"></i>fn pointer</span>
  <span><i class="swatch swatch-virtual"></i>virtual candidate</span>
  <span style="margin-left:10px;font-size:10px;color:var(--text-muted)">Ctrl+hover node = source preview \xB7 click edge = go to call site</span>
  <span class="spacer"></span>
  <button class="filter-bar-toggle" id="filterBarToggle" title="Toggle edge/node filters">\u2699 Filters</button>
</div>
<div class="filter-bar" id="filterBar" ${filtersCollapsed ? "hidden" : ""}>
  <span class="filter-group-label">Edges:</span>
  <button class="filter-btn" data-filter="direct"       title="Direct function calls">Direct</button>
  <button class="filter-btn" data-filter="pointer"      title="Calls via function pointer / callback / dispatch table">Fn Pointer</button>
  <button class="filter-btn" data-filter="virtual"      title="Virtual dispatch candidates">Virtual</button>
  <span class="filter-sep"></span>
  <span class="filter-group-label">Confidence:</span>
  <button class="filter-btn" data-filter="confirmed"    title="Edges confirmed by clang">\u2713 Confirmed</button>
  <button class="filter-btn" data-filter="unchecked"    title="Heuristic edges not yet checked by clang">~ Unchecked</button>
  <button class="filter-btn" data-filter="contradicted" title="Heuristic edges contradicted by clang \u2014 real false positives">\u2717 Disputed</button>
  <span class="filter-sep"></span>
  <span class="filter-group-label">Nodes:</span>
  <button class="filter-btn" data-filter="inactive"     title="Nodes inside inactive #ifdef / #if 0 blocks">Inactive</button>
  <button class="filter-btn" data-filter="lambda"       title="Lambda / anonymous function nodes">Lambdas</button>
  <span class="filter-sep"></span>
  <button class="filter-action-btn" id="filterAllOn"  >All on</button>
  <button class="filter-action-btn" id="filterAllOff" >All off</button>
  <span class="filter-count" id="filterCount"></span>
</div>
<div class="main" id="mainArea">
  <div id="cy"></div>
  <div class="resize-handle" id="resizeHandle"></div>
  <div class="sidebar" id="sidebar" style="width:${sidebarCollapsed ? 0 : sidebarWidth}px">
    <div class="sidebar-inner" id="sidebarInner">
      <div class="empty-msg">Click a node to inspect it.</div>
    </div>
  </div>
</div>
<!-- floating source popup -->
<div class="source-popup hidden" id="sourcePopup">
  <div class="popup-header" id="popupHeader">
    <span class="popup-title" id="popupTitle">Source</span>
    <span class="popup-hint" id="popupHint">Ctrl+click to pin</span>
    <button class="popup-pin" id="popupPin" title="Pin">\u{1F4CC}</button>
    <button class="popup-close" id="popupClose">\u2715</button>
  </div>
  <div class="popup-body" id="popupBody">
    <div class="source-inner" id="popupSourceInner"></div>
  </div>
</div>
`;
  var modeBadge = document.getElementById("modeBadge");
  var filterBar = document.getElementById("filterBar");
  var filterCount = document.getElementById("filterCount");
  var clusterToggleBtn = document.getElementById("clusterToggle");
  var pathToggleBtn = document.getElementById("pathToggle");
  var selectedEdgePairKey = null;
  var selectedEdgeSiteIdx = 0;
  var selectedEdgeCallSites = [];
  var CLUSTER_PALETTE = [
    "#2f6fed",
    "#e05b2b",
    "#2da44e",
    "#8250df",
    "#d14d4d",
    "#0ea5a0",
    "#c08000",
    "#1a7f37",
    "#6640c9",
    "#b06020"
  ];
  var clusterColorMap = /* @__PURE__ */ new Map();
  var clusterColorIdx = 0;
  function getClusterColor(key) {
    if (!clusterColorMap.has(key)) {
      clusterColorMap.set(key, CLUSTER_PALETTE[clusterColorIdx % CLUSTER_PALETTE.length]);
      clusterColorIdx++;
    }
    return clusterColorMap.get(key);
  }
  var enrichStatusEl = document.getElementById("enrichStatus");
  var depthControl = document.getElementById("depthControl");
  var depthSlider = document.getElementById("depthSlider");
  var depthValueEl = document.getElementById("depthValue");
  var layoutSel = document.getElementById("layoutSel");
  var nodeCountEl = document.getElementById("nodeCount");
  var bannerEl = document.getElementById("banner");
  var legendEl = document.getElementById("legend");
  var sidebar = document.getElementById("sidebar");
  var sidebarInner = document.getElementById("sidebarInner");
  var resizeHandle = document.getElementById("resizeHandle");
  var sourcePopup = document.getElementById("sourcePopup");
  var popupTitle = document.getElementById("popupTitle");
  var popupHint = document.getElementById("popupHint");
  var popupPin = document.getElementById("popupPin");
  var popupClose = document.getElementById("popupClose");
  var popupBody = document.getElementById("popupBody");
  var popupSrcInner = document.getElementById("popupSourceInner");
  var popupHeader = document.getElementById("popupHeader");
  applyTheme(theme);
  if (sidebarCollapsed)
    sidebar.classList.add("collapsed");
  function buildCyStyle() {
    const v = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    return [
      { selector: "node", style: { label: "data(label)", "background-color": v("--cy-node-bg"), color: v("--cy-node-text"), "font-size": 11, "text-valign": "center", "text-halign": "center", shape: "round-rectangle", width: "label", height: "label", padding: "8px", "border-width": 1, "border-color": v("--cy-node-border") } },
      { selector: "node[isRoot]", style: { "background-color": v("--cy-node-root-bg"), color: v("--cy-node-root-text"), "border-color": v("--cy-node-root-bord"), "border-width": 2 } },
      { selector: "node[inactive]", style: { "border-style": "dashed", "border-color": v("--cy-node-inact-bord"), "background-color": v("--cy-node-inact-bg"), color: v("--cy-node-inact-text") } },
      { selector: "node.selected", style: { "border-color": v("--cy-sel-bord"), "border-width": 3 } },
      { selector: "node[virtualConfirmed]", style: { "border-color": v("--cy-virt-bord"), "border-width": 2 } },
      { selector: "node[isIsr]", style: { "border-color": "#ff6b35", "border-width": 3, "border-style": "dashed" } },
      { selector: "node.classNode", style: { shape: "round-rectangle", "background-color": v("--cy-node-cls-bg"), "border-color": v("--cy-node-cls-bord"), "text-wrap": "wrap", "text-max-width": 160, "font-family": "monospace", "font-size": 10, color: v("--cy-node-text") } },
      { selector: "node.clusterNode", style: { shape: "round-rectangle", "font-size": 13, "font-weight": "bold", "text-wrap": "wrap", "text-max-width": 200, "text-valign": "center", "text-halign": "center", padding: "18px", width: "label", height: "label" } },
      {
        selector: "node.umlClassNode",
        style: {
          shape: "round-rectangle",
          "background-color": v("--cy-node-bg"),
          color: v("--cy-node-text"),
          "font-family": 'ui-monospace,"SF Mono",Consolas,monospace',
          "font-size": 11,
          "text-wrap": "wrap",
          "text-max-width": 220,
          "text-valign": "center",
          "text-halign": "center",
          // center the label BLOCK on the node (not text-align)
          "text-justification": "left",
          // left-align lines WITHIN the label block
          padding: "12px",
          width: "label",
          height: "label",
          "border-width": 1.5,
          "border-color": v("--cy-node-border")
        }
      },
      {
        selector: "node.umlRoot",
        style: {
          "border-color": v("--cy-node-root-bord"),
          "border-width": 3,
          "background-color": v("--cy-node-root-bg"),
          color: v("--cy-node-root-text")
        }
      },
      { selector: "edge", style: { width: 1.5, "line-color": v("--cy-edge"), "target-arrow-color": v("--cy-edge"), "target-arrow-shape": "triangle", "curve-style": "bezier", "font-size": 9, color: v("--cy-edge"), opacity: 0.6 } },
      { selector: 'edge[confirmed="true"]', style: { opacity: 1, "line-color": v("--cy-edge-ok"), "target-arrow-color": v("--cy-edge-ok") } },
      { selector: 'edge[confirmed="false"]', style: { opacity: 1, "line-style": "dashed", "line-color": v("--cy-edge-bad"), "target-arrow-color": v("--cy-edge-bad") } },
      { selector: 'edge[kind="pointer"]', style: { "line-style": "dashed", "line-color": v("--cy-edge-ptr"), "target-arrow-color": v("--cy-edge-ptr"), label: "data(label)", opacity: 1 } },
      { selector: 'edge[kind="virtualCandidate"]', style: { "line-style": "dotted", "line-color": v("--cy-edge-virt"), "target-arrow-color": v("--cy-edge-virt"), opacity: 1 } },
      { selector: "edge.hovered", style: { width: 3, opacity: 1 } },
      { selector: "edge.highlighted", style: { width: 3, opacity: 1, "line-color": v("--cy-hi-edge"), "target-arrow-color": v("--cy-hi-edge") } }
    ];
  }
  cy = cytoscape({ container: document.getElementById("cy"), style: buildCyStyle() });
  cy.on("tap", "node", (evt) => {
    if (uiMode !== "callgraph")
      return;
    const id = evt.target.id();
    const d = evt.target.data();
    if (d.isCluster === "true") {
      showClusterSidebar(id, d.clusterLabel, d.memberIds ? JSON.parse(d.memberIds) : []);
    } else if (id === selectedNodeId) {
      cyclCallSite(1);
    } else {
      selectNode(
        id,
        /*cycleToFirst*/
        false
      );
    }
  });
  cy.on("tap", "edge", (evt) => {
    const d = evt.target.data();
    if (d.callSitesJson) {
      const sites = JSON.parse(d.callSitesJson);
      const pairKey = d.id;
      if (selectedEdgePairKey !== pairKey) {
        selectedEdgePairKey = pairKey;
        selectedEdgeSiteIdx = 0;
        selectedEdgeCallSites = sites;
      } else {
        selectedEdgeSiteIdx = (selectedEdgeSiteIdx + 1) % sites.length;
      }
      const site = sites[selectedEdgeSiteIdx];
      showBanner(`Call site ${selectedEdgeSiteIdx + 1} of ${sites.length} \u2014 ${site.file}:${site.line}`);
      send({ type: "openLocation", location: { file: site.file, line: site.line, column: site.col } });
    } else if (d.callFile) {
      send({ type: "openLocation", location: { file: d.callFile, line: d.callLine, column: d.callCol } });
    }
  });
  cy.on("mouseover", "edge", (evt) => evt.target.addClass("hovered"));
  cy.on("mouseout", "edge", (evt) => evt.target.removeClass("hovered"));
  var hoveredNodeId = null;
  var hoveredMouseX = 0;
  var hoveredMouseY = 0;
  cy.on("mouseover", "node", (evt) => {
    const id = evt.target.id();
    const oe = evt.originalEvent;
    hoveredNodeId = fullGraph?.nodes[id] ? id : null;
    hoveredMouseX = oe.clientX;
    hoveredMouseY = oe.clientY;
    if (oe.ctrlKey && hoveredNodeId)
      triggerSourcePopup(hoveredNodeId, oe.clientX, oe.clientY);
  });
  cy.on("mousemove", "node", (evt) => {
    const oe = evt.originalEvent;
    hoveredMouseX = oe.clientX;
    hoveredMouseY = oe.clientY;
  });
  cy.on("mouseout", "node", () => {
    hoveredNodeId = null;
    if (!popupPinned && !popupHovered)
      hidePopupDelayed();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Control" && hoveredNodeId)
      triggerSourcePopup(hoveredNodeId, hoveredMouseX, hoveredMouseY);
    if (e.key === "Escape") {
      popupPinned = false;
      hidePopup();
    }
  });
  depthSlider.addEventListener("input", () => {
    currentDepth = parseInt(depthSlider.value, 10);
    depthValueEl.textContent = String(currentDepth);
    if (uiMode === "classDiagram" && classUmlData) {
      renderUmlDiagram();
      saveState();
      return;
    }
    renderCallGraphSlice();
    saveState();
    if (depthFetchTimer)
      window.clearTimeout(depthFetchTimer);
    depthFetchTimer = window.setTimeout(() => {
      if (fullGraph && currentDepth > fullGraph.computedDepth)
        send({ type: "requestDepth", depth: currentDepth });
    }, 350);
  });
  layoutSel.addEventListener("change", () => {
    currentLayout = layoutSel.value;
    saveState();
    if (uiMode === "classDiagram" && classUmlData)
      renderUmlDiagram();
    else if (uiMode === "callgraph")
      renderCallGraphSlice();
    else
      renderClassHierarchy();
  });
  document.getElementById("themeToggle").addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    document.getElementById("themeToggle").textContent = theme === "dark" ? "\u2600\uFE0F" : "\u{1F319}";
    applyTheme(theme);
    if (uiMode === "classDiagram" && classUmlData)
      renderUmlDiagram();
    saveState();
  });
  document.getElementById("sidebarToggle").addEventListener("click", toggleSidebar);
  document.getElementById("exportDot").addEventListener("click", () => send({ type: "exportGraph", format: "dot" }));
  document.getElementById("exportMermaid").addEventListener("click", () => send({ type: "exportGraph", format: "mermaid" }));
  document.getElementById("exportSvg").addEventListener("click", () => send({ type: "exportGraph", format: "svg" }));
  resizeHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebar.offsetWidth;
    const onMove = (me) => {
      const newW = Math.max(180, Math.min(600, startW - (me.clientX - startX)));
      sidebar.style.width = newW + "px";
      sidebarWidth = newW;
      if (sidebarCollapsed) {
        sidebarCollapsed = false;
        sidebar.classList.remove("collapsed");
      }
    };
    const onUp = () => {
      saveState();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    if (sidebarCollapsed) {
      sidebar.classList.add("collapsed");
      sidebar.style.width = "0";
    } else {
      sidebar.classList.remove("collapsed");
      sidebar.style.width = sidebarWidth + "px";
    }
    saveState();
  }
  popupClose.addEventListener("click", () => {
    popupPinned = false;
    hidePopup();
  });
  popupPin.addEventListener("click", () => pinPopup());
  sourcePopup.addEventListener("mouseenter", () => {
    popupHovered = true;
  });
  sourcePopup.addEventListener("mouseleave", () => {
    popupHovered = false;
    if (!popupPinned)
      hidePopupDelayed();
  });
  sourcePopup.addEventListener("click", (e) => {
    if (e.ctrlKey)
      pinPopup();
  });
  popupHeader.addEventListener("mousedown", (e) => {
    if (e.target.closest(".popup-pin,.popup-close"))
      return;
    e.preventDefault();
    const rect = sourcePopup.getBoundingClientRect();
    popupDragOffX = e.clientX - rect.left;
    popupDragOffY = e.clientY - rect.top;
    const onMove = (me) => {
      sourcePopup.style.left = Math.max(0, me.clientX - popupDragOffX) + "px";
      sourcePopup.style.top = Math.max(0, me.clientY - popupDragOffY) + "px";
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  function triggerSourcePopup(nodeId, mouseX, mouseY) {
    if (popupNodeId === nodeId && !sourcePopup.classList.contains("hidden"))
      return;
    popupNodeId = nodeId;
    const node = fullGraph?.nodes[nodeId];
    popupTitle.textContent = node?.qualifiedName ?? node?.name ?? nodeId;
    popupHint.textContent = popupPinned ? "" : "Ctrl+click to pin";
    popupSrcInner.innerHTML = '<div style="padding:8px;color:var(--text-muted)">Loading\u2026</div>';
    positionPopup(mouseX, mouseY);
    sourcePopup.classList.remove("hidden");
    send({ type: "requestSource", nodeId });
  }
  function positionPopup(x, y) {
    const pw = 440, ph = 280;
    let left = x + 18, top = y + 12;
    if (left + pw > window.innerWidth - 8)
      left = Math.max(8, x - pw - 8);
    if (top + ph > window.innerHeight - 8)
      top = Math.max(8, window.innerHeight - ph - 8);
    sourcePopup.style.left = left + "px";
    sourcePopup.style.top = top + "px";
  }
  function pinPopup() {
    popupPinned = true;
    popupPin.classList.add("pinned");
    popupHint.textContent = "Pinned \u2014 Esc or \u2715 to close";
  }
  var hideTimer;
  function hidePopupDelayed() {
    hideTimer = window.setTimeout(() => {
      if (!popupPinned && !popupHovered)
        hidePopup();
    }, 200);
  }
  function hidePopup() {
    if (hideTimer)
      window.clearTimeout(hideTimer);
    sourcePopup.classList.add("hidden");
    popupPinned = false;
    popupHovered = false;
    popupPin.classList.remove("pinned");
    popupNodeId = null;
  }
  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "graph": {
        uiMode = "callgraph";
        fullGraph = msg.data;
        if (!depthSeeded || currentDepth === 0) {
          currentDepth = msg.data.defaultDepth;
          depthSeeded = true;
          saveState();
        }
        depthSlider.value = String(currentDepth);
        depthValueEl.textContent = String(currentDepth);
        modeBadge.textContent = msg.data.semanticEnrichmentApplied ? "heuristic + clang-verified" : `${msg.data.mode} mode`;
        depthControl.hidden = false;
        legendEl.hidden = false;
        showBanner(msg.data.truncated ? "Graph truncated \u2014 narrow depth or raise callgraph.maxVisibleNodes." : null);
        renderCallGraphSlice();
        if (selectedNodeId && fullGraph.nodes[selectedNodeId])
          renderSidebar(fullGraph.nodes[selectedNodeId]);
        return;
      }
      case "classHierarchy":
        uiMode = "classDiagram";
        classHierarchy = msg.data;
        modeBadge.textContent = msg.data.mode === "semantic" ? "heuristic + clang-verified \u2014 class hierarchy" : `${msg.data.mode} mode \u2014 class hierarchy`;
        depthControl.hidden = true;
        legendEl.hidden = true;
        renderClassHierarchy();
        return;
      case "classUml":
        uiMode = "classDiagram";
        classUmlData = msg.data;
        classHierarchy = null;
        classNsFilters = /* @__PURE__ */ new Set();
        classFileFilters = /* @__PURE__ */ new Set();
        const dtLabel = msg.data.diagramType === "uml" ? "UML" : msg.data.diagramType === "usage" ? "Usage" : "Hierarchy";
        modeBadge.textContent = `${msg.data.mode} mode \u2014 Class ${dtLabel}`;
        depthControl.hidden = false;
        legendEl.hidden = true;
        renderUmlDiagram();
        return;
      case "sourceSnippet": {
        if (msg.nodeId !== popupNodeId)
          return;
        renderPopupSource(msg.source, msg.startLine);
        return;
      }
      case "enrichmentStatus":
        enrichStatusEl.hidden = msg.status !== "checking";
        return;
      case "uiConfig":
        applyPopupConfig(msg.popup);
        return;
      case "error":
        showBanner(msg.message);
        return;
    }
  });
  send({ type: "ready" });
  function applyPopupConfig(popup) {
    sourcePopup.style.setProperty("--popup-font-size", popup.fontSize + "px");
    sourcePopup.style.width = popup.width + "px";
    sourcePopup.style.height = popup.height + "px";
    popupBody.style.fontSize = popup.fontSize + "px";
  }
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    if (cy)
      cy.style(buildCyStyle()).update();
  }
  function showBanner(text) {
    bannerEl.hidden = !text;
    if (text)
      bannerEl.textContent = text;
  }
  function syncFilterButtons() {
    document.querySelectorAll(".filter-btn").forEach((btn) => {
      const f = btn.dataset.filter;
      btn.classList.toggle("active", activeFilters.has(f));
    });
    if (fullGraph) {
      const totalEdges = fullGraph.edges.length;
      const shownEdges = fullGraph.edges.filter(edgePassesFilter).length;
      const totalNodes = Object.keys(fullGraph.nodes).length;
      const shownNodes = Object.values(fullGraph.nodes).filter(nodePassesFilter).length;
      const hiddenEdges = totalEdges - shownEdges;
      const hiddenNodes = totalNodes - shownNodes;
      const parts = [];
      if (hiddenEdges > 0)
        parts.push(`${hiddenEdges} edge${hiddenEdges !== 1 ? "s" : ""} hidden`);
      if (hiddenNodes > 0)
        parts.push(`${hiddenNodes} node${hiddenNodes !== 1 ? "s" : ""} hidden`);
      filterCount.textContent = parts.length ? `(${parts.join(", ")})` : "";
    } else {
      filterCount.textContent = "";
    }
  }
  function edgePassesFilter(e) {
    if (e.kind === "direct" && !activeFilters.has("direct"))
      return false;
    if (e.kind === "pointer" && !activeFilters.has("pointer"))
      return false;
    if (e.kind === "virtualCandidate" && !activeFilters.has("virtual"))
      return false;
    if (e.confirmed === true && !activeFilters.has("confirmed"))
      return false;
    if (e.confirmed === false && !activeFilters.has("contradicted"))
      return false;
    if (e.confirmed === void 0 && !activeFilters.has("unchecked"))
      return false;
    return true;
  }
  function nodePassesFilter(n) {
    if (!n.active && !activeFilters.has("inactive"))
      return false;
    if (n.name === "<lambda>" && !activeFilters.has("lambda"))
      return false;
    return true;
  }
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const f = btn.dataset.filter;
      if (activeFilters.has(f))
        activeFilters.delete(f);
      else
        activeFilters.add(f);
      saveState();
      syncFilterButtons();
      renderCallGraphSlice();
    });
  });
  document.getElementById("filterAllOn").addEventListener("click", () => {
    for (const f of ALL_FILTERS)
      activeFilters.add(f);
    saveState();
    syncFilterButtons();
    renderCallGraphSlice();
  });
  document.getElementById("filterAllOff").addEventListener("click", () => {
    activeFilters.clear();
    saveState();
    syncFilterButtons();
    renderCallGraphSlice();
  });
  document.getElementById("filterBarToggle").addEventListener("click", () => {
    filtersCollapsed = !filtersCollapsed;
    filterBar.hidden = filtersCollapsed;
    saveState();
  });
  clusterToggleBtn.addEventListener("click", () => {
    clustered = !clustered;
    clusterToggleBtn.classList.toggle("active", clustered);
    clusterColorMap.clear();
    clusterColorIdx = 0;
    saveState();
    if (uiMode === "classDiagram" && classUmlData)
      renderUmlDiagram();
    else
      renderCallGraphSlice();
  });
  pathToggleBtn.addEventListener("click", () => {
    pathMode = !pathMode;
    pathToggleBtn.classList.toggle("active", pathMode);
    saveState();
    renderCallGraphSlice();
  });
  syncFilterButtons();
  function clusterKeyOf(fn) {
    if (fn.className)
      return `class:${fn.className}`;
    const filename = (fn.location.file.split("/").pop() ?? fn.location.file).replace(/\.(c|cpp|cc|cxx|h|hh|hpp|hxx)$/i, "");
    return `file:${filename}`;
  }
  function clusterDisplay(key) {
    if (key.startsWith("class:"))
      return `\u25C8 ${key.slice(6)}`;
    return `\u25AA ${key.slice(5)}`;
  }
  var KIND_RANK = { pointer: 3, virtual: 2, virtualCandidate: 2, direct: 1 };
  function deduplicateEdges(rawEdges) {
    const map = /* @__PURE__ */ new Map();
    for (const e of rawEdges) {
      const pairKey = `${e.callerId}\u2192${e.calleeId}`;
      const existing = map.get(pairKey);
      const site = { file: e.callSite.file, line: e.callSite.line, col: e.callSite.column };
      if (!existing) {
        map.set(pairKey, {
          pairKey,
          callerId: e.callerId,
          calleeId: e.calleeId,
          kind: e.kind,
          confirmed: e.confirmed === true ? "true" : e.confirmed === false ? "false" : void 0,
          via: e.via,
          callSites: [site]
        });
      } else {
        existing.callSites.push(site);
        if ((KIND_RANK[e.kind] ?? 0) > (KIND_RANK[existing.kind] ?? 0))
          existing.kind = e.kind;
        if (e.confirmed === true)
          existing.confirmed = "true";
      }
    }
    return [...map.values()];
  }
  function layoutOptions(nodeCount = 0, rootId) {
    const dagre = (dir) => ({
      name: "dagre",
      rankDir: dir,
      nodeSep: 50,
      rankSep: 90,
      ranker: "network-simplex",
      animate: false
    });
    const bf = (r) => ({
      name: "breadthfirst",
      directed: false,
      roots: r ? `[id="${CSS.escape(r)}"]` : void 0,
      spacingFactor: 1.6,
      animate: false,
      padding: 20
    });
    switch (currentLayout) {
      case "radial":
        return { name: "concentric", concentric: (n) => n.degree(), levelWidth: () => 2, animate: false };
      case "cose":
        return { name: "cose", animate: false, randomize: false, nodeDimensionsIncludeLabels: true, padding: 20 };
      case "circle":
        return { name: "circle", animate: false, padding: 30 };
      case "breadthfirst":
        return bf(rootId);
      case "dagre-bt":
        return dagre("BT");
      case "dagre-tb":
        return dagre("TB");
      default:
        if (nodeCount > 200)
          return bf(rootId);
        return dagre("LR");
    }
  }
  var WARN_NODES = 300;
  var BLOCK_NODES = 1600;
  function findPathFromRoot(graph, targetId) {
    if (targetId === graph.rootId)
      return { nodeIds: /* @__PURE__ */ new Set([graph.rootId]), pairKeys: /* @__PURE__ */ new Set() };
    const adj = /* @__PURE__ */ new Map();
    for (const e of graph.edges) {
      (adj.get(e.callerId) ?? adj.set(e.callerId, []).get(e.callerId)).push(e.calleeId);
      (adj.get(e.calleeId) ?? adj.set(e.calleeId, []).get(e.calleeId)).push(e.callerId);
    }
    const parent = /* @__PURE__ */ new Map([[graph.rootId, null]]);
    const queue = [graph.rootId];
    while (queue.length > 0) {
      const cur = queue.shift();
      if (cur === targetId) {
        const nodeIds = /* @__PURE__ */ new Set();
        const pairKeys = /* @__PURE__ */ new Set();
        let n = cur;
        while (n !== void 0) {
          nodeIds.add(n);
          const p = parent.get(n);
          if (p != null) {
            pairKeys.add(`${p}\u2192${n}`);
            pairKeys.add(`${n}\u2192${p}`);
            n = p;
          } else
            break;
        }
        return { nodeIds, pairKeys };
      }
      for (const neighbor of adj.get(cur) ?? []) {
        if (!parent.has(neighbor)) {
          parent.set(neighbor, cur);
          queue.push(neighbor);
        }
      }
    }
    return null;
  }
  function renderCallGraphSlice() {
    if (!fullGraph)
      return;
    if (clustered) {
      renderClusteredSlice();
      return;
    }
    const depthIds = Object.keys(fullGraph.nodes).filter(
      (id) => (fullGraph.nodeDepths[id] ?? Infinity) <= currentDepth
    );
    const visIds = depthIds.filter((id) => nodePassesFilter(fullGraph.nodes[id]));
    const visSet = new Set(visIds);
    const filtered = fullGraph.edges.filter((e) => visSet.has(e.callerId) && visSet.has(e.calleeId) && edgePassesFilter(e));
    const deduped = deduplicateEdges(filtered);
    let pathNodeIds = null;
    let pathPairKeys = null;
    if (pathMode && selectedNodeId && selectedNodeId !== fullGraph.rootId) {
      const path = findPathFromRoot(fullGraph, selectedNodeId);
      if (path) {
        pathNodeIds = path.nodeIds;
        pathPairKeys = path.pairKeys;
        showBanner(`\u2934 Path mode: showing shortest path to ${fullGraph.nodes[selectedNodeId]?.name ?? selectedNodeId}`);
      } else {
        showBanner(`\u2934 Path mode: no path found from root to selected node`);
      }
    } else if (pathMode) {
      showBanner("\u2934 Path mode ON \u2014 click a node to show the shortest path to it");
    }
    const connectedIds = /* @__PURE__ */ new Set([fullGraph.rootId]);
    for (const e of deduped) {
      connectedIds.add(e.callerId);
      connectedIds.add(e.calleeId);
    }
    const nodeCount = visIds.filter((id) => connectedIds.has(id)).length;
    const edgeCount = deduped.length;
    if (nodeCount > BLOCK_NODES) {
      showBanner(`\u26D4 ${nodeCount} nodes is above the ${BLOCK_NODES} render limit. Enable \u2B21 Group mode, reduce depth, or add filters.`);
      nodeCountEl.textContent = `${nodeCount} nodes \u2014 not rendered`;
      syncFilterButtons();
      return;
    }
    if (!pathMode) {
      if (nodeCount > WARN_NODES) {
        showBanner(`\u26A0 Large graph (${nodeCount} nodes) \u2014 using hierarchical layout. Enable \u2B21 Group mode for a cleaner view.`);
      } else {
        showBanner(fullGraph.truncated ? "Graph truncated \u2014 narrow depth or raise callgraph.maxVisibleNodes." : null);
      }
    }
    const nodeEls = [];
    for (const id of visIds) {
      if (!connectedIds.has(id))
        continue;
      if (pathNodeIds && !pathNodeIds.has(id))
        continue;
      const n = fullGraph.nodes[id];
      const clusterKey = clusterKeyOf(n);
      const borderCol = getClusterColor(clusterKey);
      const nodeLabel = (n.isIsr ? "\u26A1 " : "") + (n.qualifiedName ?? n.name);
      nodeEls.push({
        data: {
          id,
          label: nodeLabel,
          isRoot: id === fullGraph.rootId ? "true" : void 0,
          inactive: !n.active ? "true" : void 0,
          virtualConfirmed: n.virtualConfirmed ? "true" : void 0,
          isIsr: n.isIsr ? "true" : void 0
        },
        style: { "border-color": borderCol, "border-width": 2.5 }
      });
    }
    const edgeEls = [];
    for (const de of deduped) {
      if (pathPairKeys && !pathPairKeys.has(de.pairKey))
        continue;
      if (pathNodeIds && (!pathNodeIds.has(de.callerId) || !pathNodeIds.has(de.calleeId)))
        continue;
      const count = de.callSites.length;
      const label = count > 1 ? `\xD7${count}` : de.via ? `via ${de.via}` : "";
      edgeEls.push({ data: {
        id: de.pairKey,
        source: de.callerId,
        target: de.calleeId,
        kind: de.kind,
        confirmed: de.confirmed,
        label,
        callSitesJson: JSON.stringify(de.callSites),
        callFile: de.callSites[0]?.file,
        callLine: de.callSites[0]?.line,
        callCol: de.callSites[0]?.col
      } });
    }
    cy.batch(() => {
      cy.elements().remove();
      cy.add([...nodeEls, ...edgeEls]);
    });
    cy.layout(layoutOptions(nodeEls.length, fullGraph.rootId)).run();
    if (selectedNodeId)
      cy.getElementById(selectedNodeId).addClass("selected");
    highlightCallSiteEdge();
    const total = Object.keys(fullGraph.nodes).length;
    const shownCount = pathNodeIds ? pathNodeIds.size : nodeEls.length;
    const parts = [`${shownCount}/${total} nodes`];
    if (total - depthIds.length > 0)
      parts.push(`${total - depthIds.length} beyond depth`);
    if (depthIds.length - nodeCount > 0)
      parts.push(`${depthIds.length - nodeCount} filtered`);
    nodeCountEl.textContent = parts.join(" \xB7 ");
    syncFilterButtons();
  }
  function renderClusteredSlice() {
    if (!fullGraph)
      return;
    const depthIds = Object.keys(fullGraph.nodes).filter(
      (id) => (fullGraph.nodeDepths[id] ?? Infinity) <= currentDepth
    );
    const visIds = depthIds.filter((id) => nodePassesFilter(fullGraph.nodes[id]));
    const visSet = new Set(visIds);
    const nodeCluster = /* @__PURE__ */ new Map();
    const clusterMembers = /* @__PURE__ */ new Map();
    for (const id of visIds) {
      const fn = fullGraph.nodes[id];
      const key = clusterKeyOf(fn);
      nodeCluster.set(id, key);
      const arr = clusterMembers.get(key) ?? [];
      arr.push(id);
      clusterMembers.set(key, arr);
    }
    const filteredEdges = fullGraph.edges.filter((e) => visSet.has(e.callerId) && visSet.has(e.calleeId) && edgePassesFilter(e));
    const clusterEdgeMap = /* @__PURE__ */ new Map();
    for (const e of filteredEdges) {
      const ck = nodeCluster.get(e.callerId);
      const tk = nodeCluster.get(e.calleeId);
      if (!ck || !tk)
        continue;
      const pairKey = `${ck}~~~${tk}`;
      const existing = clusterEdgeMap.get(pairKey) ?? { sites: [], selfLoop: ck === tk };
      existing.sites.push({ file: e.callSite.file, line: e.callSite.line, col: e.callSite.column });
      clusterEdgeMap.set(pairKey, existing);
    }
    const nodeEls = [];
    const rootCluster = nodeCluster.get(fullGraph.rootId) ?? "";
    for (const [key, members] of clusterMembers) {
      const color = getClusterColor(key);
      const isRoot = key === rootCluster;
      const label = `${clusterDisplay(key)}
${members.length} fn${members.length !== 1 ? "s" : ""}`;
      nodeEls.push({
        data: {
          id: `cluster:${key}`,
          label,
          isCluster: "true",
          clusterLabel: label,
          isRoot: isRoot ? "true" : void 0,
          memberIds: JSON.stringify(members)
        },
        classes: "clusterNode",
        style: {
          "border-color": color,
          "border-width": isRoot ? 4 : 2.5,
          "background-color": color + "22"
        }
      });
    }
    const edgeEls = [];
    for (const [pairKey, { sites, selfLoop }] of clusterEdgeMap) {
      if (selfLoop)
        continue;
      const sepIdx = pairKey.indexOf("~~~");
      const ck = pairKey.slice(0, sepIdx);
      const tk = pairKey.slice(sepIdx + 3);
      const count = sites.length;
      edgeEls.push({ data: {
        id: `cedge:${pairKey}`,
        source: `cluster:${ck}`,
        target: `cluster:${tk}`,
        kind: "direct",
        label: `${count} call${count !== 1 ? "s" : ""}`,
        callSitesJson: JSON.stringify(sites)
      } });
    }
    if (nodeEls.length > BLOCK_NODES) {
      showBanner(`\u26D4 Too many clusters (${nodeEls.length}) \u2014 reduce depth.`);
      return;
    }
    showBanner(nodeEls.length > WARN_NODES ? `\u26A0 ${nodeEls.length} clusters \u2014 consider reducing depth.` : null);
    cy.batch(() => {
      cy.elements().remove();
      cy.add([...nodeEls, ...edgeEls]);
    });
    cy.layout(layoutOptions(nodeEls.length, `cluster:${rootCluster}`)).run();
    nodeCountEl.textContent = `${nodeEls.length} groups \xB7 ${edgeEls.length} connections`;
    syncFilterButtons();
  }
  function showClusterSidebar(clusterId, label, memberIds) {
    selectedNodeId = null;
    cy.nodes().removeClass("selected");
    cy.getElementById(clusterId).addClass("selected");
    const fns = memberIds.map((id) => fullGraph?.nodes[id]).filter((fn) => !!fn).sort((a, b) => (a.qualifiedName ?? a.name).localeCompare(b.qualifiedName ?? b.name));
    sidebarInner.innerHTML = `
    <div class="sidebar-section">
      <div class="fn-name" style="font-size:14px">${esc(label)}</div>
      <div class="fn-flags">${fns.length} function${fns.length !== 1 ? "s" : ""} \u2014 click to open in editor</div>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-section-title">Functions</div>
      ${fns.map((fn) => `
        <div class="call-site-entry" data-fn-id="${esc(fn.id)}">
          <span class="cs-caller">${fn.isIsr ? "\u26A1 " : ""}${esc(fn.qualifiedName ?? fn.name)}</span>
          <span class="cs-loc">${fn.location.line}</span>
        </div>`).join("")}
    </div>`;
    sidebarInner.querySelectorAll("[data-fn-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const fn = fullGraph?.nodes[el.dataset.fnId];
        if (fn)
          send({ type: "openLocation", location: fn.location });
      });
      el.addEventListener("dblclick", () => {
        const fn = fullGraph?.nodes[el.dataset.fnId];
        if (fn) {
          clustered = false;
          clusterToggleBtn.classList.remove("active");
          saveState();
          renderCallGraphSlice();
          setTimeout(() => {
            if (fullGraph?.nodes[fn.id])
              selectNode(fn.id, false);
          }, 200);
        }
      });
    });
    if (sidebarCollapsed)
      toggleSidebar();
  }
  function renderClassHierarchy() {
    if (!classHierarchy)
      return;
    const els = [];
    const byName = /* @__PURE__ */ new Map();
    for (const c of Object.values(classHierarchy.classes))
      byName.set(c.name, c.id);
    for (const c of Object.values(classHierarchy.classes)) {
      const methodLines = c.methods.slice(0, 8).map((m) => `+ ${m.name}()`).join("\n");
      const more = c.methods.length > 8 ? `
\u2026 +${c.methods.length - 8} more` : "";
      els.push({ data: { id: c.id, label: `${c.name}
${methodLines}${more}`, inactive: !c.active ? "true" : void 0 }, classes: "classNode" });
    }
    for (const c of Object.values(classHierarchy.classes))
      for (const base of c.bases) {
        const bid = byName.get(base);
        if (!bid)
          continue;
        els.push({ data: { id: `${c.id}\u2192${bid}`, source: c.id, target: bid, kind: "direct", label: "extends" } });
      }
    cy.batch(() => {
      cy.elements().remove();
      cy.add(els);
    });
    cy.layout(
      currentLayout === "radial" ? { name: "concentric", concentric: (n) => n.degree(), levelWidth: () => 2, animate: false } : layoutOptions(els.length)
    ).run();
    nodeCountEl.textContent = `${Object.keys(classHierarchy.classes).length} classes`;
  }
  function umlEdgeStyle(kind) {
    const v = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    switch (kind) {
      case "inheritance":
        return {
          "curve-style": "bezier",
          "line-style": "solid",
          "target-arrow-shape": "triangle",
          "target-arrow-fill": "hollow",
          "target-arrow-color": v("--cy-edge"),
          "line-color": v("--cy-edge"),
          width: 2
        };
      case "composition":
        return {
          "curve-style": "bezier",
          "line-style": "solid",
          "source-arrow-shape": "diamond",
          "source-arrow-fill": "filled",
          "source-arrow-color": v("--cy-edge-ok"),
          "target-arrow-shape": "none",
          "line-color": v("--cy-edge-ok"),
          width: 2
        };
      case "aggregation":
        return {
          "curve-style": "bezier",
          "line-style": "solid",
          "source-arrow-shape": "diamond",
          "source-arrow-fill": "hollow",
          "source-arrow-color": v("--cy-edge-ptr"),
          "target-arrow-shape": "none",
          "line-color": v("--cy-edge-ptr"),
          width: 1.5
        };
      case "dependency":
        return {
          "curve-style": "bezier",
          "line-style": "dashed",
          "target-arrow-shape": "triangle",
          "target-arrow-fill": "hollow",
          "target-arrow-color": v("--cy-edge"),
          "line-color": v("--cy-edge"),
          width: 1.5
        };
      default:
        return { "curve-style": "bezier", "line-style": "solid", "target-arrow-shape": "triangle", "line-color": v("--cy-edge"), width: 1.5 };
    }
  }
  var umlShowMembers = true;
  var umlShowMethods = true;
  var umlRelFilters = /* @__PURE__ */ new Set(["inheritance", "composition", "aggregation", "dependency"]);
  function buildUmlLabel(cls) {
    const parts = [];
    if (cls.isStruct)
      parts.push("\xABstruct\xBB");
    parts.push(cls.name);
    if (umlShowMembers && cls.members.length > 0) {
      parts.push("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
      for (const m of cls.members.slice(0, 7)) {
        const a = m.access === "public" ? "+" : m.access === "protected" ? "#" : "\u2212";
        const ptr = m.isPointer ? "*" : m.isReference ? "&" : "";
        parts.push(`${a} ${m.name}: ${(m.type + ptr).replace(/\s+/g, " ").slice(0, 24)}`);
      }
      if (cls.members.length > 7)
        parts.push(`  \u2026 +${cls.members.length - 7} more`);
    }
    if (umlShowMethods && cls.methods.length > 0) {
      parts.push("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
      const ctors = cls.methods.filter((m) => m.name === cls.name || m.name === `~${cls.name}`);
      const virts = cls.methods.filter((m) => m.isVirtual && m.name !== cls.name && m.name !== `~${cls.name}`);
      const regular = cls.methods.filter((m) => !m.isVirtual && m.name !== cls.name && m.name !== `~${cls.name}`);
      for (const m of [...ctors, ...virts, ...regular].slice(0, 9)) {
        const a = m.isVirtual ? "\u223F" : "+";
        parts.push(`${a} ${m.name}()`);
      }
      if (cls.methods.length > 9)
        parts.push(`  \u2026 +${cls.methods.length - 9} more`);
    }
    return parts.join("\n");
  }
  function renderUmlDiagram() {
    if (!classUmlData)
      return;
    const depths = classUmlData.classNodeDepths ?? null;
    const rootId = classUmlData.rootClassId;
    depthControl.hidden = false;
    const allNs = /* @__PURE__ */ new Set();
    for (const cls of Object.values(classUmlData.classes)) {
      if (cls.namespace)
        allNs.add(cls.namespace);
    }
    if (classNsFilters.size === 0)
      classNsFilters = new Set(allNs);
    let nsColorIdx2 = 0;
    const nsColorMap2 = /* @__PURE__ */ new Map();
    for (const ns of allNs) {
      nsColorMap2.set(ns, CLUSTER_PALETTE[nsColorIdx2++ % CLUSTER_PALETTE.length]);
    }
    const visibleClasses = Object.values(classUmlData.classes).filter((cls) => {
      if (classFileFilters.size > 0 && !classFileFilters.has(cls.location.file))
        return false;
      if (cls.namespace && classNsFilters.size > 0 && !classNsFilters.has(cls.namespace))
        return false;
      if (depths && rootId) {
        const d = depths[cls.id];
        if (d === void 0 || d > currentDepth)
          return false;
      }
      return true;
    });
    const visibleIds = new Set(visibleClasses.map((c) => c.id));
    if (clustered) {
      renderUmlClustered(visibleClasses, visibleIds, nsColorMap2);
      return;
    }
    const nodeEls = [];
    for (const cls of visibleClasses) {
      const label = buildUmlLabel(cls);
      const borderColor = nsColorMap2.get(cls.namespace ?? "") ?? void 0;
      const isRoot = cls.id === rootId;
      nodeEls.push({
        data: { id: cls.id, label, inactive: !cls.active ? "true" : void 0 },
        classes: "umlClassNode" + (isRoot ? " umlRoot" : ""),
        ...borderColor ? { style: { "border-color": borderColor, "border-width": 2.5 } } : {}
      });
    }
    const edgeEls = [];
    for (const edge of classUmlData.edges) {
      if (!visibleIds.has(edge.fromId) || !visibleIds.has(edge.toId))
        continue;
      if (!umlRelFilters.has(edge.kind))
        continue;
      const kindLabel = edge.kind === "composition" ? `\u25C6${edge.memberName ? " " + edge.memberName : ""}` : edge.kind === "aggregation" ? `\u25C7${edge.memberName ? " " + edge.memberName : ""}` : "";
      edgeEls.push({
        data: { id: `${edge.fromId}\u2192${edge.toId}:${edge.kind}`, source: edge.fromId, target: edge.toId, kind: edge.kind, label: kindLabel },
        style: umlEdgeStyle(edge.kind)
      });
    }
    if (nodeEls.length > BLOCK_NODES) {
      showBanner(`\u26D4 ${nodeEls.length} classes \u2014 too many. Reduce depth, add namespace filters, or enable \u2B21 Group.`);
      nodeCountEl.textContent = `${nodeEls.length} classes \u2014 not rendered`;
      return;
    }
    showBanner(nodeEls.length > WARN_NODES ? `\u26A0 ${nodeEls.length} classes \u2014 consider reducing depth or enabling \u2B21 Group.` : null);
    cy.batch(() => {
      cy.elements().remove();
      cy.add([...nodeEls, ...edgeEls]);
    });
    const layoutOverride = classUmlData.diagramType === "hierarchy" && currentLayout === "dagre-lr" ? { ...layoutOptions(nodeEls.length, rootId), rankDir: "BT" } : layoutOptions(nodeEls.length, rootId);
    cy.layout(layoutOverride).run();
    const relCounts = /* @__PURE__ */ new Map();
    for (const e of edgeEls)
      relCounts.set(e.data.kind, (relCounts.get(e.data.kind) ?? 0) + 1);
    const relSummary = [...relCounts.entries()].map(([k, n]) => `${n} ${k}`).join(" \xB7 ");
    nodeCountEl.textContent = `${nodeEls.length} classes \xB7 ${relSummary}`;
    buildUmlSidebar(nsColorMap2, allNs);
  }
  function renderUmlClustered(visibleClasses, visibleIds, nsColorMap) {
    const clusterMembers = /* @__PURE__ */ new Map();
    const classToCluster = /* @__PURE__ */ new Map();
    for (const cls of visibleClasses) {
      const key = cls.namespace ? `ns:${cls.namespace}` : `file:${cls.location.file.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "global"}`;
      classToCluster.set(cls.id, key);
      const arr = clusterMembers.get(key) ?? [];
      arr.push(cls.id);
      clusterMembers.set(key, arr);
    }
    const rootClusterKey = classUmlData?.rootClassId ? classToCluster.get(classUmlData.rootClassId) : void 0;
    const nodeEls = [];
    for (const [key, members] of clusterMembers) {
      const isNs = key.startsWith("ns:");
      const displayName = isNs ? `\u25C8 ${key.slice(3)}` : `\u25AA ${key.slice(5)}`;
      const col = isNs ? nsColorMap.get(key.slice(3)) ?? "#6b7080" : "#6b7080";
      nodeEls.push({
        data: {
          id: `cluster:${key}`,
          label: `${displayName}
${members.length} class${members.length !== 1 ? "es" : ""}`,
          isCluster: "true",
          clusterLabel: displayName,
          memberIds: JSON.stringify(members),
          isRoot: key === rootClusterKey ? "true" : void 0
        },
        classes: "clusterNode",
        style: { "border-color": col, "border-width": key === rootClusterKey ? 4 : 2.5, "background-color": col + "22" }
      });
    }
    const clusterEdgeMap = /* @__PURE__ */ new Map();
    for (const edge of classUmlData?.edges ?? []) {
      const fc = classToCluster.get(edge.fromId);
      const tc = classToCluster.get(edge.toId);
      if (!fc || !tc || fc === tc)
        continue;
      const pk = `${fc}|||${tc}`;
      clusterEdgeMap.set(pk, (clusterEdgeMap.get(pk) ?? 0) + 1);
    }
    const edgeEls = [];
    for (const [pk, count] of clusterEdgeMap) {
      const [fc, tc] = pk.split("|||");
      edgeEls.push({ data: {
        id: `ce:${pk}`,
        source: `cluster:${fc}`,
        target: `cluster:${tc}`,
        kind: "direct",
        label: `${count}`,
        callSitesJson: "[]"
      } });
    }
    cy.batch(() => {
      cy.elements().remove();
      cy.add([...nodeEls, ...edgeEls]);
    });
    cy.layout(layoutOptions(nodeEls.length, rootClusterKey ? `cluster:${rootClusterKey}` : void 0)).run();
    nodeCountEl.textContent = `${nodeEls.length} groups \xB7 ${edgeEls.length} connections`;
    buildUmlSidebar(nsColorMap, /* @__PURE__ */ new Set([...nsColorMap.keys()]));
  }
  function buildUmlSidebar(nsColorMap, allNs) {
    const allFiles = classUmlData?.availableFiles ?? [];
    const fileByFolder = /* @__PURE__ */ new Map();
    for (const f of allFiles) {
      const parts = f.split("/");
      const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
      const arr = fileByFolder.get(folder) ?? [];
      arr.push(f);
      fileByFolder.set(folder, arr);
    }
    const fileSection = allFiles.length > 0 ? `
    <div class="sidebar-section">
      <div class="sidebar-section-title">\u{1F4C1} Filter by file (${classFileFilters.size === 0 ? "all" : classFileFilters.size + " of " + allFiles.length})</div>
      <div style="max-height:180px;overflow-y:auto;font-size:11px">
        ${[...fileByFolder.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([folder, files]) => `
          <div style="color:var(--text-muted);padding:2px 0;font-size:10px">${esc(folder)}/</div>
          ${files.sort().map((f) => {
      const fname = f.split("/").pop() ?? f;
      const on = classFileFilters.size === 0 || classFileFilters.has(f);
      return `<div class="call-site-entry file-filter-btn ${on ? "active" : ""}" data-file="${esc(f)}"
              style="cursor:pointer;padding:2px 4px 2px 12px;opacity:${on ? 1 : 0.4}">
              ${esc(fname)}
            </div>`;
    }).join("")}
        `).join("")}
      </div>
      <div style="margin-top:6px;display:flex;gap:6px">
        <button class="filter-action-btn" id="fileAllOn">All files</button>
        <button class="filter-action-btn" id="fileCurOnly">Current file</button>
      </div>
    </div>` : "";
    const nsSection = allNs.size > 0 ? `
    <div class="sidebar-section">
      <div class="sidebar-section-title">Namespaces \u2014 click to filter</div>
      ${[...allNs].map((ns) => {
      const col = nsColorMap.get(ns) ?? "#6b7080";
      const on = classNsFilters.size === 0 || classNsFilters.has(ns);
      return `<div class="call-site-entry ns-filter-btn ${on ? "active" : ""}" data-ns="${esc(ns)}" style="border-left:4px solid ${col};padding-left:6px;cursor:pointer;opacity:${on ? 1 : 0.45}">
                  ${esc(ns)}
                </div>`;
    }).join("")}
      <div style="margin-top:6px;display:flex;gap:6px">
        <button class="filter-action-btn" id="nsAllOn">All on</button>
        <button class="filter-action-btn" id="nsAllOff">All off</button>
      </div>
    </div>` : "";
    const relSection = `
    <div class="sidebar-section">
      <div class="sidebar-section-title">Relationships</div>
      ${["inheritance", "composition", "aggregation", "dependency"].map((kind) => {
      const labels = { inheritance: "\u27F5 Inheritance", composition: "\u25C6 Composition", aggregation: "\u25C7 Aggregation", dependency: "- - Dependency" };
      const on = umlRelFilters.has(kind);
      return `<label class="checkbox-control" style="margin-bottom:4px">
          <input type="checkbox" class="rel-filter" data-kind="${kind}" ${on ? "checked" : ""}> ${labels[kind]}
        </label>`;
    }).join("")}
    </div>`;
    const viewSection = `
    <div class="sidebar-section">
      <div class="sidebar-section-title">Show in nodes</div>
      <label class="checkbox-control" style="margin-bottom:4px"><input type="checkbox" id="umlMembers" ${umlShowMembers ? "checked" : ""}> Members</label>
      <label class="checkbox-control"><input type="checkbox" id="umlMethods" ${umlShowMethods ? "checked" : ""}> Methods</label>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-section-title">Legend</div>
      <div style="font-size:11px;line-height:1.9;color:var(--text-muted)">
        \u25C1\u2500\u2500 Inheritance<br>\u25C6\u2500\u2500 Composition (owns)<br>\u25C7\u2500\u2500 Aggregation (ref)<br>- \u2192 Dependency
      </div>
    </div>`;
    sidebarInner.innerHTML = fileSection + nsSection + relSection + viewSection;
    sidebarInner.querySelectorAll(".file-filter-btn").forEach((el) => {
      el.addEventListener("click", () => {
        const f = el.dataset.file;
        if (classFileFilters.size === 0) {
          classFileFilters = new Set(allFiles.filter((x) => x !== f));
        } else if (classFileFilters.has(f)) {
          classFileFilters.delete(f);
        } else {
          classFileFilters.add(f);
        }
        renderUmlDiagram();
      });
    });
    document.getElementById("fileAllOn")?.addEventListener("click", () => {
      classFileFilters.clear();
      renderUmlDiagram();
    });
    document.getElementById("fileCurOnly")?.addEventListener("click", () => {
      const rootFile = classUmlData?.classes[classUmlData?.rootClassId ?? ""]?.location.file;
      if (rootFile) {
        classFileFilters = new Set(allFiles.filter((f) => f !== rootFile));
        renderUmlDiagram();
      }
    });
    sidebarInner.querySelectorAll(".ns-filter-btn").forEach((el) => {
      el.addEventListener("click", () => {
        const ns = el.dataset.ns;
        if (classNsFilters.has(ns))
          classNsFilters.delete(ns);
        else
          classNsFilters.add(ns);
        renderUmlDiagram();
      });
    });
    document.getElementById("nsAllOn")?.addEventListener("click", () => {
      classNsFilters = new Set(allNs);
      renderUmlDiagram();
    });
    document.getElementById("nsAllOff")?.addEventListener("click", () => {
      classNsFilters.clear();
      renderUmlDiagram();
    });
    sidebarInner.querySelectorAll(".rel-filter").forEach((el) => {
      el.addEventListener("change", () => {
        const kind = el.dataset.kind;
        if (el.checked)
          umlRelFilters.add(kind);
        else
          umlRelFilters.delete(kind);
        renderUmlDiagram();
      });
    });
    document.getElementById("umlMembers")?.addEventListener("change", (e) => {
      umlShowMembers = e.target.checked;
      renderUmlDiagram();
    });
    document.getElementById("umlMethods")?.addEventListener("change", (e) => {
      umlShowMethods = e.target.checked;
      renderUmlDiagram();
    });
    if (sidebarCollapsed)
      toggleSidebar();
  }
  cy.on("tap", "node.umlClassNode", (evt) => {
    const id = evt.target.id();
    if (!classUmlData?.classes[id])
      return;
    const cls = classUmlData.classes[id];
    send({ type: "openLocation", location: cls.location });
    const relList = cls.relationships.filter((r) => classUmlData.classes[r.targetClassId]).map((r) => `<div class="call-site-entry" data-goto-id="${esc(r.targetClassId)}">
      <span class="cs-caller">${r.kind}: ${esc(r.targetName)}${r.memberName ? ` (${esc(r.memberName)})` : ""}</span>
      <span class="cs-loc">${esc(classUmlData.classes[r.targetClassId]?.location.file.split("/").pop() ?? "")}</span>
    </div>`).join("");
    const methodList = cls.methods.slice(0, 15).map(
      (m) => `<div class="call-site-entry"><span class="cs-caller">${m.isVirtual ? "\u223F" : "+"}${esc(m.name)}()</span><span class="cs-loc">${m.location.line}</span></div>`
    ).join("");
    sidebarInner.innerHTML = `
    <div class="sidebar-section">
      <div class="fn-name">${esc(cls.qualifiedName)}</div>
      ${cls.namespace ? `<div class="fn-flags">namespace ${esc(cls.namespace)}</div>` : ""}
      <div class="fn-loc" id="umlGoto">\u{1F4CD} ${esc(cls.location.file)}:${cls.location.line}</div>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-section-title">Relationships (${cls.relationships.length})</div>
      ${relList || '<div class="empty-msg">None detected</div>'}
    </div>
    <div class="sidebar-section">
      <div class="sidebar-section-title">Methods (${cls.methods.length})</div>
      ${methodList || '<div class="empty-msg">None</div>'}
    </div>`;
    document.getElementById("umlGoto")?.addEventListener("click", () => send({ type: "openLocation", location: cls.location }));
    sidebarInner.querySelectorAll("[data-goto-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const targetCls = classUmlData?.classes[el.dataset.gotoId];
        if (targetCls)
          send({ type: "openLocation", location: targetCls.location });
      });
    });
    if (sidebarCollapsed)
      toggleSidebar();
  });
  function selectNode(id, cycleToFirst) {
    if (!fullGraph)
      return;
    const node = fullGraph.nodes[id];
    if (!node)
      return;
    selectedNodeId = id;
    cy.nodes().removeClass("selected");
    cy.getElementById(id).addClass("selected");
    callSiteCycle = fullGraph.edges.filter((e) => e.calleeId === id && fullGraph.nodes[e.callerId]).map((e) => e.callSite);
    const seen = /* @__PURE__ */ new Set();
    callSiteCycle = callSiteCycle.filter((loc) => {
      const key = `${loc.file}:${loc.line}`;
      if (seen.has(key))
        return false;
      seen.add(key);
      return true;
    });
    callSiteIndex = cycleToFirst ? 0 : -1;
    highlightCallSiteEdge();
    renderSidebar(node);
    if (callSiteIndex >= 0 && callSiteCycle[callSiteIndex]) {
      send({ type: "openLocation", location: callSiteCycle[callSiteIndex] });
    } else {
      send({ type: "openLocation", location: node.location });
    }
    if (pathMode)
      renderCallGraphSlice();
  }
  function cyclCallSite(dir) {
    if (!selectedNodeId || callSiteCycle.length === 0)
      return;
    callSiteIndex = (callSiteIndex + dir + callSiteCycle.length) % callSiteCycle.length;
    highlightCallSiteEdge();
    updateSidebarActiveEntry();
    send({ type: "openLocation", location: callSiteCycle[callSiteIndex] });
  }
  function highlightCallSiteEdge() {
    if (!selectedNodeId)
      return;
    cy.edges().removeClass("highlighted");
    if (callSiteIndex < 0 || !callSiteCycle[callSiteIndex])
      return;
    const loc = callSiteCycle[callSiteIndex];
    const match = cy.edges().filter(
      (e) => e.data("callLine") === loc.line && e.data("callFile") === loc.file && e.data("target") === selectedNodeId
    );
    match.addClass("highlighted");
  }
  function renderSidebar(node) {
    if (!fullGraph)
      return;
    const rawCallerEdges = fullGraph.edges.filter((e) => e.calleeId === node.id && fullGraph.nodes[e.callerId]);
    const seenCallerSites = /* @__PURE__ */ new Set();
    const callerEdges = rawCallerEdges.filter((e) => {
      const key = `${e.callSite.file}:${e.callSite.line}`;
      if (seenCallerSites.has(key))
        return false;
      seenCallerSites.add(key);
      return true;
    });
    const calleeEdges = fullGraph.edges.filter((e) => e.callerId === node.id && fullGraph.nodes[e.calleeId]);
    const flags = [];
    if (!node.active)
      flags.push("inactive (#ifdef / #if 0)");
    if (node.isVirtual)
      flags.push("virtual");
    if (node.virtualConfirmed)
      flags.push("override (clang-confirmed)");
    const aliasSection = node.aliases && node.aliases.length > 0 ? `<div class="sidebar-section">
        <div class="sidebar-section-title">\u2B21 Interface macros (${node.aliases.length})</div>
        ${node.aliases.map(
      (a) => `<div class="call-site-entry">
             <span class="cs-caller" style="font-family:monospace;font-size:11px">#define ${esc(a)}(\u2026)</span>
           </div>`
    ).join("")}
        <div style="font-size:10px;color:var(--text-muted);padding:2px 6px">These macro calls are resolved to this function</div>
      </div>` : "";
    const isrSection = node.isIsr ? `<div class="sidebar-section">
        <div class="fn-isr-badge">\u26A1 ISR \u2014 ${esc(node.isrAttribute ?? "interrupt handler")}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Interrupt Service Routine. This function runs in interrupt context.</div>
      </div>` : "";
    sidebarInner.innerHTML = `
    <div class="sidebar-section">
      <div class="fn-name">${esc(node.qualifiedName ?? node.name)}</div>
      <div class="fn-sig">${esc(node.signature)}</div>
      <div class="fn-loc" id="sbDefLink">\u{1F4CD} ${esc(node.location.file)}:${node.location.line}</div>
      ${flags.length ? `<div class="fn-flags">${esc(flags.join(" \xB7 "))}</div>` : ""}
    </div>

    ${isrSection}
    ${aliasSection}

    <div class="sidebar-section">
      <div class="sidebar-section-title">Called from (${callerEdges.length}) <span style="font-weight:normal;font-size:10px;color:var(--text-muted)">\u2014 click or click node to cycle</span></div>
      <div id="callersList">
        ${callerEdges.length === 0 ? '<div class="empty-msg">Not called by any visible node</div>' : callerEdges.map((e, i) => {
      const caller = fullGraph.nodes[e.callerId];
      const loc = e.callSite;
      const viaBadge = e.kind === "pointer" && e.via ? ` <span style="font-size:10px;color:var(--cy-edge-ptr)">[via ${esc(e.via)}]</span>` : "";
      const klass = i === callSiteIndex ? "call-site-entry active" : "call-site-entry";
      return `<div class="${klass}" data-cs-index="${i}">
                <span class="cs-caller">${esc(caller.qualifiedName ?? caller.name)}${viaBadge}</span>
                <span class="cs-loc">${esc(loc.file.split("/").pop() ?? loc.file)}:${loc.line}</span>
              </div>`;
    }).join("")}
      </div>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-section-title">Calls (${calleeEdges.length})</div>
      <div id="calleesList">
        ${calleeEdges.length === 0 ? '<div class="empty-msg">Calls nothing visible at this depth</div>' : calleeEdges.map((e) => {
      const callee = fullGraph.nodes[e.calleeId];
      const kindBadge = e.kind === "pointer" ? ` <span style="font-size:10px;color:var(--cy-edge-ptr)">[ptr${e.via ? " via " + e.via : ""}]</span>` : e.kind === "virtualCandidate" ? ` <span style="font-size:10px;color:var(--cy-edge-virt)">[virtual]</span>` : "";
      return `<div class="call-site-entry" data-callee-id="${esc(callee.id)}">
                <span class="cs-caller">${esc(callee.qualifiedName ?? callee.name)}${kindBadge}</span>
                <span class="cs-loc">${esc(callee.location.file.split("/").pop() ?? callee.location.file)}:${callee.location.line}</span>
              </div>`;
    }).join("")}
      </div>
    </div>
  `;
    if (fullGraph) {
      const visibleIsrs = Object.values(fullGraph.nodes).filter((n) => n.isIsr && (fullGraph.nodeDepths[n.id] ?? Infinity) <= currentDepth);
      if (visibleIsrs.length > 0) {
        const isrHtml = visibleIsrs.map(
          (n) => `<div class="call-site-entry" data-goto-id="${esc(n.id)}"><span class="cs-caller">\u26A1 ${esc(n.qualifiedName ?? n.name)}</span><span class="cs-loc" style="font-size:10px">${esc(n.isrAttribute ?? "")}</span></div>`
        ).join("");
        sidebarInner.innerHTML += `<div class="sidebar-section"><div class="sidebar-section-title">\u26A1 ISRs in graph (${visibleIsrs.length})</div>${isrHtml}</div>`;
        sidebarInner.querySelectorAll("[data-goto-id]").forEach((el) => {
          el.addEventListener("click", () => {
            const gid = el.dataset.gotoId;
            const fn = fullGraph?.nodes[gid];
            if (fn) {
              selectNode(gid, false);
              send({ type: "openLocation", location: fn.location });
            }
          });
        });
      }
    }
    document.getElementById("sbDefLink")?.addEventListener("click", () => send({ type: "openLocation", location: node.location }));
    sidebarInner.querySelectorAll("[data-cs-index]").forEach((el) => {
      el.addEventListener("click", () => {
        const i = parseInt(el.dataset.csIndex, 10);
        callSiteIndex = i;
        highlightCallSiteEdge();
        updateSidebarActiveEntry();
        send({ type: "openLocation", location: callerEdges[i].callSite });
      });
    });
    sidebarInner.querySelectorAll("[data-callee-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.calleeId;
        const callee = fullGraph?.nodes[id];
        if (callee)
          send({ type: "openLocation", location: callee.location });
      });
    });
  }
  function updateSidebarActiveEntry() {
    sidebarInner.querySelectorAll("[data-cs-index]").forEach((el) => {
      const i = parseInt(el.dataset.csIndex, 10);
      el.classList.toggle("active", i === callSiteIndex);
    });
    const active = sidebarInner.querySelector(".call-site-entry.active");
    active?.scrollIntoView({ block: "nearest" });
  }
  var CPP_KEYWORDS = /* @__PURE__ */ new Set([
    "if",
    "else",
    "for",
    "while",
    "do",
    "switch",
    "case",
    "break",
    "continue",
    "return",
    "void",
    "int",
    "char",
    "float",
    "double",
    "long",
    "short",
    "unsigned",
    "signed",
    "bool",
    "true",
    "false",
    "nullptr",
    "NULL",
    "const",
    "static",
    "extern",
    "inline",
    "auto",
    "register",
    "volatile",
    "struct",
    "class",
    "union",
    "enum",
    "typedef",
    "namespace",
    "using",
    "template",
    "typename",
    "virtual",
    "override",
    "final",
    "public",
    "private",
    "protected",
    "new",
    "delete",
    "operator",
    "sizeof",
    "this",
    "explicit",
    "mutable",
    "friend",
    "try",
    "catch",
    "throw",
    "noexcept",
    "constexpr",
    "decltype",
    "static_assert",
    "alignas",
    "alignof"
  ]);
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function highlightCpp(raw) {
    let r = "", i = 0, n = raw.length;
    while (i < n) {
      if (raw[i] === "/" && raw[i + 1] === "*") {
        const e = raw.indexOf("*/", i + 2);
        const chunk = e < 0 ? raw.slice(i) : raw.slice(i, e + 2);
        r += `<span class="tok-cm">${esc(chunk)}</span>`;
        i = e < 0 ? n : e + 2;
        continue;
      }
      if (raw[i] === "/" && raw[i + 1] === "/") {
        const e = raw.indexOf("\n", i);
        r += `<span class="tok-cm">${esc(e < 0 ? raw.slice(i) : raw.slice(i, e))}</span>`;
        i = e < 0 ? n : e;
        continue;
      }
      if (raw[i] === "#") {
        let e = i;
        while (e < n) {
          if (raw[e] === "\n" && raw[e - 1] !== "\\")
            break;
          e++;
        }
        r += `<span class="tok-pp">${esc(raw.slice(i, e))}</span>`;
        i = e;
        continue;
      }
      if (raw[i] === '"') {
        let j = i + 1;
        while (j < n && raw[j] !== '"') {
          if (raw[j] === "\\")
            j++;
          j++;
        }
        r += `<span class="tok-st">${esc(raw.slice(i, j + 1))}</span>`;
        i = j + 1;
        continue;
      }
      if (raw[i] === "'") {
        let j = i + 1;
        while (j < n && raw[j] !== "'") {
          if (raw[j] === "\\")
            j++;
          j++;
        }
        r += `<span class="tok-st">${esc(raw.slice(i, j + 1))}</span>`;
        i = j + 1;
        continue;
      }
      if (/[0-9]/.test(raw[i]) || raw[i] === "." && /[0-9]/.test(raw[i + 1] ?? "")) {
        let j = i;
        while (j < n && /[0-9a-fA-FxX._uUlLfF]/.test(raw[j]))
          j++;
        r += `<span class="tok-nm">${esc(raw.slice(i, j))}</span>`;
        i = j;
        continue;
      }
      if (/[A-Za-z_]/.test(raw[i])) {
        let j = i;
        while (j < n && /[A-Za-z0-9_]/.test(raw[j]))
          j++;
        const w = raw.slice(i, j);
        let k = j;
        while (k < n && raw[k] === " ")
          k++;
        r += CPP_KEYWORDS.has(w) ? `<span class="tok-kw">${esc(w)}</span>` : raw[k] === "(" ? `<span class="tok-fn">${esc(w)}</span>` : esc(w);
        i = j;
        continue;
      }
      r += esc(raw[i]);
      i++;
    }
    return r;
  }
  function isAnchorLine(lines, idx) {
    for (let i = 0; i < idx; i++) {
      const t2 = lines[i].trim();
      if (t2 && !t2.startsWith("//") && !t2.startsWith("*") && !t2.startsWith("/*") && !t2.startsWith("#"))
        return false;
    }
    const t = lines[idx]?.trim() ?? "";
    return !!(t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("#"));
  }
  function renderPopupSource(source, startLine) {
    const startNo = startLine;
    const lines = source.split("\n");
    popupSrcInner.innerHTML = "";
    for (let i = 0; i < lines.length; i++) {
      const ln = startNo + i;
      const row = document.createElement("div");
      row.className = "source-line" + (isAnchorLine(lines, i) ? " anchor" : "");
      row.innerHTML = `<div class="ln">${ln}</div><div class="lc">${highlightCpp(lines[i])}</div>`;
      popupSrcInner.appendChild(row);
    }
    const anchor = popupSrcInner.querySelector(".anchor");
    anchor?.scrollIntoView({ block: "nearest" });
  }
})();
//# sourceMappingURL=webview.js.map
