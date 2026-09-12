// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  /** @type {any[]} */
  let sendCommands = [];
  /** @type {any[]} */
  let otherBlocks = [];
  let filterText = '';
  /** Which rows currently have the raw-hex toggle expanded (by blockIndex). */
  const expandedHex = new Set();

  const tbody = document.getElementById('sendTableBody');
  const otherBody = document.getElementById('otherBlocksBody');
  const filterInput = document.getElementById('filterInput');
  const addBtn = document.getElementById('addSendBtn');
  const renumberBtn = document.getElementById('renumberBtn');

  filterInput.addEventListener('input', (e) => {
    filterText = e.target.value.toLowerCase();
    render();
  });

  addBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'addSend' });
  });

  renumberBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'renumber' });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
      sendCommands = msg.sendCommands;
      otherBlocks = msg.otherBlocks;
      render();
    }
  });

  function matchesFilter(cmd) {
    if (!filterText) return true;
    const hay = `${cmd.index} ${cmd.labelLines.join(' ')} ${hexToEditableAscii(cmd.hex)}`.toLowerCase();
    return hay.includes(filterText);
  }

  function render() {
    renderSendTable();
    renderOtherBlocks();
  }

  function renderSendTable() {
    tbody.innerHTML = '';
    sendCommands.forEach((cmd) => {
      if (!matchesFilter(cmd)) return;
      const tr = document.createElement('tr');

      tr.appendChild(makeCell('span', cmd.index, { className: 'index-cell' }));

      // Label lines (usually just 1: name, e.g. "Ping" or the AT command name).
      const labelCell = document.createElement('td');
      if (cmd.labelLines.length === 0) {
        labelCell.appendChild(makeInput('', (val) => postLabel(cmd.blockIndex, 0, val)));
      } else {
        cmd.labelLines.forEach((line, idx) => {
          const input = makeInput(line, (val) => postLabel(cmd.blockIndex, idx, val));
          labelCell.appendChild(input);
        });
      }
      tr.appendChild(labelCell);

      // ASCII is the primary, directly-editable representation of the bytes.
      // The file only ever stores the hex encoding of this, so hex itself is
      // tucked behind a small toggle rather than shown by default.
      const asciiCell = document.createElement('td');
      asciiCell.className = 'ascii-cell';

      const asciiInput = makeInput(hexToEditableAscii(cmd.hex), (val) =>
        vscode.postMessage({ type: 'applyAsciiEdit', blockIndex: cmd.blockIndex, asciiText: val })
      );
      asciiInput.classList.add('ascii-input');
      asciiCell.appendChild(asciiInput);

      const toggleRow = document.createElement('div');
      toggleRow.className = 'hex-toggle-row';
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'hex-toggle-btn';
      const isExpanded = expandedHex.has(cmd.blockIndex);
      toggleBtn.textContent = isExpanded ? '▾ hex' : '▸ hex';
      toggleBtn.title = 'Show/edit the raw hex bytes stored in the file';
      toggleBtn.addEventListener('click', () => {
        if (expandedHex.has(cmd.blockIndex)) expandedHex.delete(cmd.blockIndex);
        else expandedHex.add(cmd.blockIndex);
        render();
      });
      toggleRow.appendChild(toggleBtn);
      asciiCell.appendChild(toggleRow);

      if (isExpanded) {
        const hexInput = makeInput(cmd.hex, (val) =>
          vscode.postMessage({ type: 'editSendHex', blockIndex: cmd.blockIndex, value: val })
        );
        hexInput.classList.add('hex-input');
        if (!isValidHex(cmd.hex)) hexInput.classList.add('invalid');
        hexInput.addEventListener('input', () => {
          hexInput.classList.toggle('invalid', !isValidHex(hexInput.value));
        });
        asciiCell.appendChild(hexInput);
      }

      tr.appendChild(asciiCell);

      // Trailing fields (flag/delay/etc - meaning not confirmed).
      const trailingCell = document.createElement('td');
      trailingCell.className = 'trailing-cell';
      cmd.trailingFields.forEach((field, idx) => {
        const input = makeInput(field, (val) =>
          vscode.postMessage({
            type: 'editSendTrailingField',
            blockIndex: cmd.blockIndex,
            fieldIndex: idx,
            value: val,
          })
        );
        input.classList.add('narrow-input');
        trailingCell.appendChild(input);
      });
      tr.appendChild(trailingCell);

      const actions = document.createElement('td');
      actions.className = 'actions-cell';
      actions.appendChild(
        makeButton('↑', 'Move up', () =>
          vscode.postMessage({ type: 'moveSend', blockIndex: cmd.blockIndex, direction: 'up' })
        )
      );
      actions.appendChild(
        makeButton('↓', 'Move down', () =>
          vscode.postMessage({ type: 'moveSend', blockIndex: cmd.blockIndex, direction: 'down' })
        )
      );
      actions.appendChild(
        makeButton('⧉', 'Duplicate this command', () =>
          vscode.postMessage({ type: 'duplicateSend', blockIndex: cmd.blockIndex })
        )
      );
      actions.appendChild(
        makeButton('✕', 'Delete this command', () => {
          vscode.postMessage({ type: 'deleteSend', blockIndex: cmd.blockIndex });
        }, 'danger')
      );
      tr.appendChild(actions);

      tbody.appendChild(tr);
    });

    if (sendCommands.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'empty-state';
      td.textContent = 'No Send commands yet. Click "+ Send Command" to add one.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }

  function postLabel(blockIndex, labelLineIndex, value) {
    vscode.postMessage({ type: 'editSendLabelLine', blockIndex, labelLineIndex, value });
  }

  function renderOtherBlocks() {
    otherBody.innerHTML = '';
    otherBlocks.forEach((block) => {
      const section = document.createElement('div');
      section.className = 'other-block';

      const title = document.createElement('div');
      title.className = 'other-block-title';
      title.textContent = block.keyword;
      section.appendChild(title);

      block.lines.forEach((line, lineIndex) => {
        const row = document.createElement('div');
        row.className = 'other-block-row';
        const input = makeInput(line, (val) =>
          vscode.postMessage({
            type: 'editOtherLine',
            blockIndex: block.blockIndex,
            lineIndex,
            value: val,
          })
        );
        row.appendChild(input);
        section.appendChild(row);
      });

      otherBody.appendChild(section);
    });
  }

  function makeInput(value, onChange) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value ?? '';
    input.spellcheck = false;
    input.addEventListener('change', () => onChange(input.value));
    return input;
  }

  function makeCell(tag, text, opts) {
    const td = document.createElement('td');
    const el = document.createElement(tag);
    el.textContent = text;
    if (opts && opts.className) el.className = opts.className;
    td.appendChild(el);
    return td;
  }

  function makeButton(label, title, onClick, extraClass) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.title = title;
    btn.className = 'icon-btn' + (extraClass ? ' ' + extraClass : '');
    btn.addEventListener('click', onClick);
    return btn;
  }

  function isValidHex(hex) {
    const tokens = (hex || '').trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return true;
    return tokens.every((t) => /^[0-9a-fA-F]{1,2}$/.test(t));
  }

  // Mirrors ptpModel.ts hexToEditableAscii — kept in sync manually since the
  // webview can't import the extension-side TS module directly. The
  // extension is the source of truth for the actual conversion on save;
  // this is only used to render the ASCII text shown/edited in the table.
  function hexToEditableAscii(hex) {
    const tokens = (hex || '').trim().split(/\s+/).filter(Boolean);
    let out = '';
    for (const tok of tokens) {
      const val = parseInt(tok, 16);
      if (Number.isNaN(val)) continue;
      switch (val) {
        case 0x0d: out += '\\r'; continue;
        case 0x0a: out += '\\n'; continue;
        case 0x09: out += '\\t'; continue;
        case 0x00: out += '\\0'; continue;
        case 0x5c: out += '\\\\'; continue;
      }
      if (val >= 0x20 && val < 0x7f) {
        out += String.fromCharCode(val);
      } else {
        out += '\\x' + tok.toUpperCase().padStart(2, '0');
      }
    }
    return out;
  }

  vscode.postMessage({ type: 'ready' });
})();
