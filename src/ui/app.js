// The admin page. Talks to /admin/api/ (see src/admin.js); no framework, no external files.
"use strict";

const $ = (selector) => document.querySelector(selector);
const state = { overview: null, token: sessionStorage.getItem("arviro-token") || "", polling: null, folder: null, lastCheck: null };

function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) node.append(child);
  return node;
}

function toast(message, isError = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast${isError ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.add("hidden"), isError ? 8000 : 3500);
}

async function api(route, { method = "GET", body = null, query = {} } = {}) {
  const url = new URL(`/admin/api/${route}`, location.href);
  for (const [key, value] of Object.entries(query)) if (value !== "" && value != null) url.searchParams.set(key, value);
  const headers = {};
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (response.status === 401) {
    $("#token-panel").classList.remove("hidden");
    throw new Error("Enter the server token first.");
  }
  const data = await response.json().catch(() => ({ error: `The server answered ${response.status}.` }));
  if (!response.ok) throw new Error(data.error || `The server answered ${response.status}.`);
  $("#token-panel").classList.add("hidden");
  return data;
}

const bytes = (value) => {
  if (value == null) return "?";
  if (value < 1024) return `${value} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let number = value / 1024;
  let unit = 0;
  while (number >= 1000 && unit < units.length - 1) { number /= 1024; unit += 1; }
  return `${number < 10 ? number.toFixed(1) : Math.round(number)} ${units[unit]}`;
};
const age = (days) => (days == null ? "" : days < 1 ? "today" : days < 60 ? `${Math.floor(days)} days old` : days < 730 ? `${Math.floor(days / 30)} months old` : `${Math.floor(days / 365)} years old`);
const day = (iso) => (iso ? String(iso).slice(0, 10) : "");

function copyButton(text) {
  return el("button", { class: "secondary small", type: "button", onclick: () => navigator.clipboard?.writeText(text).then(() => toast("Copied.")) }, "Copy");
}

function renderChecks(checks) {
  const body = $("#checks tbody");
  body.replaceChildren(...checks.map((check) => {
    const cells = [
      el("td", { class: `state ${check.ok ? "ok" : "bad"}`, text: check.ok ? "✓" : "✗" }),
      el("td", { class: "label", text: check.label }),
    ];
    const detail = el("td", {}, [el("div", { text: check.detail })]);
    if (!check.ok && check.advice) {
      const advice = el("div", { class: "advice muted" }, [check.advice.text, " "]);
      if (check.advice.command) advice.append(el("code", { text: check.advice.command }), copyButton(check.advice.command));
      if (check.advice.url) advice.append(" ", el("a", { href: check.advice.url, target: "_blank", rel: "noreferrer", text: check.advice.url }));
      detail.append(advice);
    }
    if (!check.ok && check.fix) {
      const labels = { "ollama-pull": "Pull the model", index: "Build the index", "library-update": "Run the library update" };
      detail.append(el("div", { class: "advice" }, el("button", { class: "small", type: "button", onclick: () => startJob({ job: check.fix }) }, labels[check.fix] || "Fix")));
    }
    cells.push(detail);
    return el("tr", {}, cells);
  }));
}

function renderSources(sources) {
  const rows = sources.filter((source) => source.type === "documents").map((source) => el("tr", {}, [
    el("td", { class: `state ${source.exists ? "ok" : "bad"}`, text: source.exists ? "✓" : "✗" }),
    el("td", { class: "label" }, [el("b", { text: source.id }), source.private ? el("span", { class: "muted", text: " private" }) : ""]),
    el("td", {}, [el("div", { text: source.path }), el("div", { class: "muted", text: source.description })]),
    el("td", {}, el("button", { class: "secondary small", type: "button", onclick: () => removeSource(source.id) }, "Remove")),
  ]));
  $("#sources tbody").replaceChildren(...(rows.length ? rows : [el("tr", {}, el("td", { class: "muted", text: "No document folders yet." }))]));
}

/** What the last "Check for updates" said about one item, as a short line. */
function verdictOf(check) {
  if (!check) return null;
  const remote = check.remote ? `${check.remote.file}${check.remote.bytes ? ` (${bytes(check.remote.bytes)})` : ""}${check.kind === "map" && check.remote.modifiedAt ? ` dated ${day(check.remote.modifiedAt)}` : ""}` : "";
  if (check.verdict === "newer") return { text: `NEWER: ${remote}`, bad: true };
  if (check.verdict === "missing") return { text: `AVAILABLE: ${remote}`, bad: true };
  if (check.verdict === "current") return { text: "up to date", bad: false };
  if (check.verdict === "unknown") return { text: "cannot tell whether a newer version exists", bad: false };
  if (check.verdict === "error") return { text: `ERROR: ${check.error}`, bad: true };
  return null;
}

function renderDownloads(overview) {
  const managed = new Set(overview.downloads.map((item) => `${item.kind}:${item.id}`));
  const rows = overview.library.map((row) => {
    const facts = row.exists
      ? [row.file, bytes(row.bytes), `${row.kind === "zim" ? "edition" : "dated"} ${row.edition || "?"}`, age(row.ageDays), row.verifiedAt ? `checksum verified ${day(row.verifiedAt)}` : "checksum unknown"]
      : ["not downloaded yet"];
    const verdict = verdictOf(state.lastCheck?.[`${row.kind}:${row.id}`]);
    return el("tr", {}, [
      el("td", { class: `state ${row.exists ? "ok" : "bad"}`, text: row.exists ? "✓" : "–" }),
      el("td", { class: "label" }, [el("b", { text: row.id }), el("span", { class: "muted", text: ` ${row.kind}` })]),
      el("td", {}, [
        el("div", { text: facts.join("  ·  ") }),
        row.managed ? "" : el("div", { class: "muted", text: "not in the download list; it stays as it is" }),
        verdict ? el("div", { class: verdict.bad ? "bad" : "ok", text: verdict.text }) : "",
      ]),
      el("td", {}, managed.has(`${row.kind}:${row.id}`) ? el("button", { class: "secondary small", type: "button", onclick: () => removeDownload(row.id) }, "Remove") : ""),
    ]);
  });
  $("#downloads tbody").replaceChildren(...(rows.length ? rows : [el("tr", {}, el("td", { class: "muted", text: "Nothing yet. Add an encyclopedia or a map below." }))]));
  $("#download-dirs").textContent = `ZIM files go to ${overview.defaults.zimDir}; map extracts to ${overview.defaults.mapsDir} unless maps.regions says otherwise. After an update the index runs by itself; restart the server after a new ZIM edition.`;
  const hasDownloads = overview.downloads.length > 0;
  $("#library-check").disabled = !hasDownloads;
  $("#library-update").disabled = !hasDownloads;
}

function renderConnect(overview) {
  const { server } = overview.config;
  const host = server.host === "0.0.0.0" || server.host === "::" ? location.hostname : server.host;
  const base = `http://${host.includes(":") ? `[${host}]` : host}:${server.port}`;
  const rows = [
    ["All sources", `${base}/mcp`, server.hasToken ? "Bearer token: server.authToken" : "no token"],
    ["Public sources only", `${base}/public/mcp`, server.hasPublicToken ? "Bearer token: server.publicToken" : "no token"],
    ["This page", `${base}/admin/`, "from this computer"],
  ];
  $("#connect tbody").replaceChildren(...rows.map(([label, url, note]) => el("tr", {}, [
    el("td", { class: "label", text: label }),
    el("td", {}, [el("code", { text: url }), " ", copyButton(url)]),
    el("td", { class: "muted", text: note }),
  ])));
  $("#stdio-snippet").textContent = JSON.stringify({ mcpServers: { arviro: { command: "node", args: ["/path/to/arviro/bin/arviro.js", "stdio"] } } }, null, 2);
}

function renderJob(job) {
  const panel = $("#job-panel");
  if (!job) return panel.classList.add("hidden");
  panel.classList.remove("hidden");
  $("#job-title").textContent = job.name;
  const status = $("#job-status");
  status.textContent = job.status === "running" ? "running…" : job.status === "done" ? "done" : `failed: ${job.error}`;
  status.className = `pill ${job.status}`;
  const log = $("#job-log");
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  log.textContent = job.lines.join("\n") || "…";
  if (atBottom) log.scrollTop = log.scrollHeight;
  if (job.status === "running" && !state.polling) state.polling = setTimeout(pollJob, 1000);
}

async function pollJob() {
  state.polling = null;
  try {
    const { job } = await api("jobs");
    renderJob(job);
    if (job && job.status !== "running") {
      // The outcome of a check is shown in the download table; an update makes an earlier check stale.
      if (job.name === "library check" && Array.isArray(job.result)) state.lastCheck = Object.fromEntries(job.result.map((row) => [`${row.kind}:${row.id}`, row]));
      else if (job.name === "library update") state.lastCheck = null;
      toast(job.status === "done" ? `${job.name}: done.` : `${job.name} failed.`, job.status !== "done");
      await refresh();
    }
  } catch (error) {
    toast(error.message, true);
  }
}

async function startJob(body) {
  try {
    const { job } = await api("jobs", { method: "POST", body });
    renderJob(job);
    $("#job-panel").scrollIntoView({ block: "nearest" });
  } catch (error) {
    toast(error.message, true);
  }
}

function render(overview) {
  state.overview = overview;
  $("#version").textContent = overview.version;
  $("#config-line").textContent = `${overview.config.missing ? "No configuration file yet; it will be written to" : "Configuration:"} ${overview.config.path}`;
  renderChecks(overview.checks);
  renderSources(overview.sources);
  renderDownloads(overview);
  renderConnect(overview);
  renderJob(overview.job);
}

async function refresh() {
  try {
    render(await api("overview"));
  } catch (error) {
    toast(error.message, true);
  }
}

async function change(route, body) {
  try {
    render(await api(route, { method: "POST", body }));
    toast("Saved.");
  } catch (error) {
    toast(error.message, true);
  }
}

const removeSource = (id) => { if (confirm(`Remove the source "${id}" from the configuration? The files stay where they are.`)) change("sources/remove", { id }); };
const removeDownload = (id) => { if (confirm(`Stop updating "${id}"? The files already downloaded stay where they are.`)) change("downloads/remove", { id }); };

// Catalogue
async function searchCatalogue() {
  const kind = $("#catalogue-kind").value;
  const query = $("#catalogue-query").value;
  const lang = $("#catalogue-lang").value;
  $("#catalogue-lang").disabled = kind !== "zim";
  $("#catalogue-note").textContent = "Searching…";
  let data;
  try {
    data = await api("catalogue", { query: { kind, query, lang } });
  } catch (error) {
    $("#catalogue-note").textContent = error.message;
    return;
  }
  const present = new Set(state.overview.downloads.map((item) => item.id));
  const rows = [];
  const addRow = (title, note, id, body) => rows.push(el("tr", {}, [
    el("td", { class: "label" }, el("b", { text: title })),
    el("td", {}, [el("div", { text: note })]),
    el("td", {}, present.has(id) ? el("span", { class: "muted", text: "in the list" }) : el("button", { class: "small", type: "button", onclick: () => change("downloads", body) }, "Add")),
  ]));
  const searched = Boolean(query.trim() || (kind === "zim" && lang));
  if (!searched) for (const item of data.curated) addRow(item.title, item.kind === "zim" ? `${item.name} · ${item.note}` : item.url, item.kind === "zim" ? item.name : item.id, item.kind === "zim" ? { zim: item.name } : { map: item.id, url: item.url });
  if (kind === "zim") for (const book of data.results) addRow(book.title || book.name, [book.name, book.language, book.flavour, book.edition, bytes(book.bytes), book.summary].filter(Boolean).join(" · "), book.name, { zim: book.name });
  else for (const region of data.results) addRow(region.name, `${region.id} · ${region.url}`, region.suggestedId, { map: region.suggestedId, url: region.url });
  $("#catalogue tbody").replaceChildren(...rows);
  $("#catalogue-note").textContent = data.error ? data.error : !searched ? "A few common choices; search the catalogue for more." : rows.length ? `${data.results.length} found.` : "Nothing found.";
}

// Folder browser
async function showFolder(target) {
  try {
    state.folder = await api("folders", { query: { path: target || "" } });
  } catch (error) {
    return toast(error.message, true);
  }
  $("#folder-current").textContent = state.folder.path;
  $("#folder-up").disabled = !state.folder.parent;
  $("#folder-list").replaceChildren(...state.folder.folders.map((folder) => el("li", { text: folder.name, onclick: () => showFolder(folder.path) })));
  const dialog = $("#folder-dialog");
  if (!dialog.open) dialog.showModal();
}

// Chat
const chat = { history: [], busy: false, controller: null, modelsLoaded: false };

function addBubble(role, text = "") {
  const node = el("div", { class: `msg ${role}`, text });
  $("#chat-messages").append(node);
  node.scrollIntoView({ block: "end" });
  return node;
}

function addCall(name, args) {
  const label = name === "search_library" ? `Searched ${args.source || "the library"}: "${args.query || ""}"${args.pathPrefix ? ` in ${args.pathPrefix}` : ""}`
    : name === "read_document" ? `Read ${args.source || ""}: ${args.path || ""}${args.offset ? ` from ${args.offset}` : ""}` : `${name} ${JSON.stringify(args)}`;
  const details = el("details", { class: "call" }, [el("summary", { text: label }), el("pre", { text: "…" })]);
  $("#chat-messages").append(details);
  details.scrollIntoView({ block: "end" });
  return details;
}

async function loadModels() {
  const select = $("#chat-model");
  try {
    const data = await api("chat/models");
    const remembered = localStorage.getItem("arviro-chat-model");
    select.replaceChildren(...(data.models.length ? data.models.map((name) => el("option", { value: name, text: name })) : [el("option", { value: "", text: "no chat model in Ollama" })]));
    select.value = data.models.includes(remembered) ? remembered : data.default || data.models[0] || "";
    $("#chat-note").textContent = data.error ? `${data.error} The chat needs Ollama at ${data.url}.`
      : data.models.length ? "The model runs in Ollama on this computer and uses the same two tools a chat app gets. Nothing leaves this computer."
        : `Ollama at ${data.url} has no chat model yet. Pull one that can call tools, for example: ollama pull qwen3:8b`;
    chat.modelsLoaded = true;
  } catch (error) {
    $("#chat-note").textContent = error.message;
  }
}

async function sendChat() {
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text || chat.busy) return;
  const model = $("#chat-model").value;
  if (!model) return toast("Choose a model first.", true);
  localStorage.setItem("arviro-chat-model", model);
  input.value = "";
  chat.history.push({ role: "user", content: text });
  addBubble("user", text);
  chat.busy = true;
  chat.controller = new AbortController();
  $("#chat-send").classList.add("hidden");
  $("#chat-stop").classList.remove("hidden");
  let bubble = addBubble("assistant");
  let call = null;
  let thinking = null;
  // A thinking model's reasoning is shown dimmed while it streams, and folded away once the answer starts.
  const think = (text) => {
    if (!thinking) {
      thinking = el("details", { class: "call thinking", open: "" }, [el("summary", { text: "Thinking…" }), el("pre", { text: "" })]);
      bubble.before(thinking);
    }
    thinking.querySelector("pre").textContent += text;
    thinking.scrollIntoView({ block: "end" });
  };
  const doneThinking = () => {
    if (!thinking) return;
    thinking.removeAttribute("open");
    thinking.querySelector("summary").textContent = "Thought";
    thinking = null;
  };
  try {
    const headers = { "content-type": "application/json" };
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    const response = await fetch("/admin/api/chat", { method: "POST", headers, body: JSON.stringify({ messages: chat.history, model }), signal: chat.controller.signal });
    if (response.status === 401) { $("#token-panel").classList.remove("hidden"); throw new Error("Enter the server token first."); }
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `The server answered ${response.status}.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const handle = (event) => {
      if (event.type === "thinking") { think(event.text); }
      else if (event.type === "token") { doneThinking(); bubble.textContent += event.text; bubble.scrollIntoView({ block: "end" }); }
      else if (event.type === "tool") { doneThinking(); call = addCall(event.name, event.args); }
      else if (event.type === "toolResult") { if (call) call.querySelector("pre").textContent = event.text; call = null; }
      else if (event.type === "message") {
        chat.history.push(event.message);
        // A turn that only calls tools has no text; its bubble goes, and a new one follows the tool result.
        if (event.message.role === "assistant" && !bubble.textContent) bubble.remove();
        if (event.message.role === "tool") bubble = addBubble("assistant");
      }
      else if (event.type === "error") { addBubble("error", event.message); }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) handle(JSON.parse(line));
      }
    }
    doneThinking();
    if (!bubble.textContent) bubble.remove();
  } catch (error) {
    doneThinking();
    if (chat.controller.signal.aborted) { if (!bubble.textContent) bubble.textContent = "[stopped]"; }
    else addBubble("error", error.message);
  } finally {
    chat.busy = false;
    chat.controller = null;
    $("#chat-send").classList.remove("hidden");
    $("#chat-stop").classList.add("hidden");
    input.focus();
  }
}

function newChat() {
  if (chat.busy) chat.controller?.abort();
  chat.history = [];
  $("#chat-messages").replaceChildren();
}

function init() {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      for (const other of document.querySelectorAll(".tab")) other.classList.toggle("active", other === tab);
      for (const pane of document.querySelectorAll(".tabpane")) pane.classList.toggle("active", pane.id === `tab-${tab.dataset.tab}`);
      if (tab.dataset.tab === "library" && !$("#catalogue tbody").children.length) searchCatalogue();
      if (tab.dataset.tab === "chat" && !chat.modelsLoaded) loadModels();
    });
  }
  $("#chat-form").addEventListener("submit", (event) => { event.preventDefault(); sendChat(); });
  $("#chat-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendChat(); }
  });
  $("#chat-stop").addEventListener("click", () => chat.controller?.abort());
  $("#chat-new").addEventListener("click", newChat);
  $("#chat-model").addEventListener("change", () => localStorage.setItem("arviro-chat-model", $("#chat-model").value));
  $("#token-form").addEventListener("submit", (event) => {
    event.preventDefault();
    state.token = $("#token-input").value.trim();
    sessionStorage.setItem("arviro-token", state.token);
    refresh();
  });
  $("#recheck").addEventListener("click", refresh);
  $("#library-check").addEventListener("click", () => startJob({ job: "library-check" }));
  $("#library-update").addEventListener("click", () => startJob({ job: "library-update" }));
  $("#source-form").addEventListener("submit", (event) => {
    event.preventDefault();
    change("sources", { path: $("#source-path").value.trim(), id: $("#source-id").value.trim(), description: $("#source-description").value.trim(), private: $("#source-private").checked });
  });
  $("#source-path").addEventListener("change", () => {
    if ($("#source-id").value) return;
    const name = $("#source-path").value.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
    $("#source-id").value = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 31);
  });
  $("#browse").addEventListener("click", () => showFolder($("#source-path").value.trim() || state.overview?.defaults.home));
  $("#folder-up").addEventListener("click", () => showFolder(state.folder.parent));
  $("#folder-home").addEventListener("click", () => showFolder(state.folder.home));
  $("#folder-close").addEventListener("click", () => $("#folder-dialog").close());
  $("#folder-use").addEventListener("click", () => {
    $("#source-path").value = state.folder.path;
    $("#source-path").dispatchEvent(new Event("change"));
    $("#folder-dialog").close();
  });
  $("#catalogue-form").addEventListener("submit", (event) => { event.preventDefault(); searchCatalogue(); });
  $("#catalogue-kind").addEventListener("change", searchCatalogue);
  refresh();
}

init();
