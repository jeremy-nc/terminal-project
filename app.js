// Browser terminal client (multi-tab).
//
// One WebSocket carries every session. Each message is keyed by a session `id`,
// so a single connection multiplexes many PTYs. Each tab owns its own pair of
// xterm instances: an interactive main view and a read-only mirror that shares
// the source's logical cols/rows but renders with its own smaller font.

const Term = window.Terminal;
const FitAddon = window.FitAddon.FitAddon;

// --- base64 <-> bytes helpers (binary-safe; avoids splitting UTF-8 chunks) ---
function b64ToBytes(s) {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function strToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const statusEl = document.getElementById("status");
const status = (t) => (statusEl.textContent = t);
const mainHosts = document.getElementById("main-hosts");
const mirrorHosts = document.getElementById("mirror-hosts");
const tabsEl = document.getElementById("tabs");

const tabs = new Map(); // tabId -> tab object
const bySession = new Map(); // sessionId -> tabId
const pendingStarts = []; // tabIds awaiting a "started" reply (FIFO, in send order)
let activeTabId = null;
let tabSeq = 0;

const ws = new WebSocket(`ws://${location.host}/ws`);

// Keep the mirror's logical grid identical to the source PTY; only the font differs.
function syncMirror(tab) {
  if (tab.mainTerm.cols && tab.mainTerm.rows)
    tab.mirrorTerm.resize(tab.mainTerm.cols, tab.mainTerm.rows);
}
function writeBoth(tab, bytes) {
  tab.mainTerm.write(bytes);
  tab.mirrorTerm.write(bytes);
}

function makeTab() {
  const tabId = "t" + ++tabSeq;
  const mainHost = document.createElement("div");
  mainHost.className = "tab-term tab-host";
  mainHosts.appendChild(mainHost);
  const mirrorHost = document.createElement("div");
  mirrorHost.className = "tab-mirror tab-host";
  mirrorHosts.appendChild(mirrorHost);

  const mainTerm = new Term({
    fontSize: 14, cursorBlink: true, fontFamily: "monospace",
    theme: { background: "#1e1e1e", foreground: "#d4d4d4" },
  });
  const fit = new FitAddon();
  mainTerm.loadAddon(fit);
  mainTerm.open(mainHost);
  const mirrorTerm = new Term({
    fontSize: 9, cursorBlink: false, disableStdin: true, fontFamily: "monospace",
    theme: { background: "#15171a", foreground: "#8a8a8a" },
  });
  mirrorTerm.open(mirrorHost);

  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  const label = document.createElement("span");
  label.textContent = "starting…";
  const closeBtn = document.createElement("span");
  closeBtn.className = "tab-close";
  closeBtn.textContent = "×";
  tabEl.append(label, closeBtn);
  tabsEl.appendChild(tabEl);

  const tab = { tabId, sessionId: null, mainTerm, fit, mirrorTerm, mainHost, mirrorHost, tabEl, label };
  tabs.set(tabId, tab);
  tabEl.addEventListener("click", (e) => { if (e.target !== closeBtn) activateTab(tabId); });
  closeBtn.addEventListener("click", (e) => { e.stopPropagation(); closeTab(tabId); });
  mainTerm.onData((d) => sendStdin(tab, d)); // raw keystrokes (arrows, Ctrl-C, …)
  return tab;
}

function startSession(tab) {
  tab.fit.fit();
  syncMirror(tab);
  pendingStarts.push(tab.tabId);
  ws.send(JSON.stringify({ type: "start", shell: "bash", cols: tab.mainTerm.cols, rows: tab.mainTerm.rows }));
}

function createTab() {
  const tab = makeTab();
  activateTab(tab.tabId);
  startSession(tab);
}

function activateTab(tabId) {
  activeTabId = tabId;
  for (const t of tabs.values()) {
    const on = t.tabId === tabId;
    t.mainHost.classList.toggle("hidden", !on);
    t.mirrorHost.classList.toggle("hidden", !on);
    t.tabEl.classList.toggle("active", on);
  }
  const tab = tabs.get(tabId);
  if (!tab) return;
  tab.fit.fit();
  syncMirror(tab);
  tab.mainTerm.focus();
  status(tab.sessionId ? `session ${tab.sessionId}` : "starting…");
}

function closeTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  if (tab.sessionId) {
    ws.send(JSON.stringify({ type: "close", id: tab.sessionId }));
    bySession.delete(tab.sessionId);
  }
  tab.mainTerm.dispose();
  tab.mirrorTerm.dispose();
  tab.mainHost.remove();
  tab.mirrorHost.remove();
  tab.tabEl.remove();
  tabs.delete(tabId);
  if (activeTabId !== tabId) return;
  const next = tabs.keys().next();
  if (!next.done) activateTab(next.value);
  else createTab(); // always keep at least one tab open
}

function sendStdin(tab, data) {
  if (tab.sessionId && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: "stdin", id: tab.sessionId, data: strToB64(data) }));
}

// --- WebSocket message routing ---
ws.onopen = () => {
  status("connected");
  createTab(); // open the first tab once the socket is ready
};

ws.onclose = () => status("disconnected");

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  switch (msg.type) {
    case "started": {
      // Match response to the oldest pending start (FIFO; server replies in order).
      const tabId = pendingStarts.shift();
      if (!tabId) break;
      const tab = tabs.get(tabId);
      if (!tab) break;
      tab.sessionId = msg.id;
      bySession.set(msg.id, tabId);
      tab.label.textContent = `bash #${tab.tabId.slice(1)}`;
      tab.mirrorTerm.resize(msg.cols, msg.rows);
      if (activeTabId === tabId) status(`session ${msg.id}`);
      break;
    }
    case "replay": {
      const tabId = bySession.get(msg.id);
      const tab = tabId && tabs.get(tabId);
      if (tab) { tab.mirrorTerm.resize(msg.cols, msg.rows); writeBoth(tab, b64ToBytes(msg.data)); }
      break;
    }
    case "stdout": {
      const tabId = bySession.get(msg.id);
      const tab = tabId && tabs.get(tabId);
      if (tab) writeBoth(tab, b64ToBytes(msg.data));
      break;
    }
    case "exit": {
      const tabId = bySession.get(msg.id);
      const tab = tabId && tabs.get(tabId);
      if (tab) {
        tab.sessionId = null;
        bySession.delete(msg.id);
        tab.label.textContent = `[exited ${msg.code}]`;
        if (activeTabId === tab.tabId) status(`exited (${msg.code})`);
      }
      break;
    }
    case "error":
      status(`error: ${msg.message}`);
      break;
  }
};

// --- hybrid input box (commits on Enter; sends to the active tab) ---
const cmd = document.getElementById("cmd");
function sendCommand() {
  const tabId = activeTabId;
  const tab = tabId && tabs.get(tabId);
  if (!tab || !cmd.value && cmd.value !== "0") return;
  sendStdin(tab, cmd.value + "\n");
  cmd.value = "";
}
cmd.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendCommand(); } });
document.getElementById("send").addEventListener("click", sendCommand);

// --- resize: only the active main view drives the PTY size ---
let resizeTimer = null;
function applyResize() {
  const tab = activeTabId && tabs.get(activeTabId);
  if (!tab) return;
  tab.fit.fit();
  syncMirror(tab);
  if (tab.sessionId && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: "resize", id: tab.sessionId, cols: tab.mainTerm.cols, rows: tab.mainTerm.rows }));
}
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(applyResize, 120); });

// --- toolbar buttons ---
document.getElementById("new-tab").addEventListener("click", createTab);
document.getElementById("restart").addEventListener("click", () => {
  const tab = activeTabId && tabs.get(activeTabId);
  if (!tab) return;
  if (tab.sessionId) { ws.send(JSON.stringify({ type: "close", id: tab.sessionId })); bySession.delete(tab.sessionId); tab.sessionId = null; }
  tab.mainTerm.reset();
  tab.mirrorTerm.reset();
  startSession(tab);
});
