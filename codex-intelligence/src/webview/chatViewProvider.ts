import * as vscode from 'vscode';

type ChatFn     = (msg: string, file?: string) => Promise<string>;
type AutocompFn = (prefix: string, file: string) => Promise<string[]>;
interface InMsg  { type: string; text?: string; prefix?: string; }

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly chatFn: ChatFn,
    private readonly autocompFn: AutocompFn
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();

    webviewView.webview.onDidReceiveMessage(async (msg: InMsg) => {
      if (msg.type === 'chat') {
        const file = vscode.window.activeTextEditor?.document.uri.fsPath;
        this.post({ type:'loading', on:true });
        try   { this.post({ type:'reply', text: await this.chatFn(msg.text??'', file) }); }
        catch (e: unknown) { this.post({ type:'error', text: e instanceof Error ? e.message : String(e) }); }
        finally { this.post({ type:'loading', on:false }); }
      } else if (msg.type === 'openDiagram') {
        await vscode.commands.executeCommand('codex.showDiagram');
      }
    });
  }

  private post(msg: object): void { this.view?.webview.postMessage(msg); }

  private html(): string { return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  :root{--bg:var(--vscode-sideBar-background);--fg:var(--vscode-foreground);--input-bg:var(--vscode-input-background);--input-fg:var(--vscode-input-foreground);--btn-bg:var(--vscode-button-background);--btn-fg:var(--vscode-button-foreground);--border:var(--vscode-panel-border);--code:var(--vscode-textCodeBlock-background)}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--vscode-font-family);font-size:13px;color:var(--fg);background:var(--bg);display:flex;flex-direction:column;height:100vh}
  #msgs{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
  .msg{padding:8px 10px;border-radius:6px;line-height:1.5;word-break:break-word}
  .user{background:var(--btn-bg);color:var(--btn-fg);align-self:flex-end;max-width:90%}
  .assistant{background:var(--code);white-space:pre-wrap}
  .error{background:var(--vscode-inputValidation-errorBackground);color:var(--vscode-inputValidation-errorForeground)}
  #toolbar{display:flex;gap:6px;padding:6px 8px;border-bottom:1px solid var(--border);flex-wrap:wrap}
  .tb{background:transparent;color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px}
  #row{display:flex;gap:6px;padding:8px;border-top:1px solid var(--border)}
  #inp{flex:1;background:var(--input-bg);color:var(--input-fg);border:1px solid var(--border);border-radius:4px;padding:6px 8px;resize:none;min-height:36px;max-height:120px;font-family:inherit;font-size:13px}
  #send{background:var(--btn-bg);color:var(--btn-fg);border:none;border-radius:4px;padding:6px 12px;cursor:pointer;font-size:13px}
  #send:disabled{opacity:.5;cursor:default}
  .spin{display:inline-block;width:10px;height:10px;border:2px solid var(--border);border-top-color:var(--fg);border-radius:50%;animation:s .6s linear infinite;margin-right:6px}
  @keyframes s{to{transform:rotate(360deg)}}
</style></head><body>
<div id="toolbar">
  <button class="tb" onclick="q('Summarise the current file')">Summarise</button>
  <button class="tb" onclick="q('List all exported functions')">Exports</button>
  <button class="tb" onclick="vscode.postMessage({type:'openDiagram'})">Diagram</button>
</div>
<div id="msgs"><div class="msg assistant">Ask me anything about your codebase.</div></div>
<div id="row">
  <textarea id="inp" rows="1" placeholder="Ask about your code..."
    onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send()}"
    oninput="this.style.height='auto';this.style.height=this.scrollHeight+'px'"></textarea>
  <button id="send" onclick="send()">Send</button>
</div>
<script>
const vscode=acquireVsCodeApi(),msgs=document.getElementById('msgs'),inp=document.getElementById('inp'),btn=document.getElementById('send');
function send(){const t=inp.value.trim();if(!t)return;add(t,'user');inp.value='';inp.style.height='auto';vscode.postMessage({type:'chat',text:t});}
function q(t){add(t,'user');vscode.postMessage({type:'chat',text:t});}
function add(t,r){const d=document.createElement('div');d.className='msg '+r;d.textContent=t;msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;}
window.addEventListener('message',e=>{
  const m=e.data;
  if(m.type==='reply'){add(m.text,'assistant');}
  else if(m.type==='error'){add('Error: '+m.text,'error');}
  else if(m.type==='loading'){
    btn.disabled=m.on;
    const ex=document.getElementById('ld');
    if(m.on&&!ex){const d=document.createElement('div');d.id='ld';d.className='msg assistant';d.innerHTML='<span class="spin"></span>Thinking...';msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;}
    else if(!m.on&&ex){ex.remove();}
  }
});
</script></body></html>`; }
}
