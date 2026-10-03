// The admin page. Talks to /admin/api/ (see src/admin.js); no framework, no external files.
"use strict";

const $ = (selector) => document.querySelector(selector);
const state = { overview: null, token: sessionStorage.getItem("arviro-token") || "", polling: null, folder: null };

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

function renderDownloads(overview) {
  const managed = new Set(overview.downloads.map((item) => `${item.kind}:${item.id}`));
  const rows = overview.library.map((row) => {
    const facts = row.exists
      ? [row.file, bytes(row.bytes), `${row.kind === "zim" ? "edition" : "dated"} ${row.edition || "?"}`, age(row.ageDays), row.verifiedAt ? `checksum verified ${day(row.verifiedAt)}` : "checksum unknown"]
      : ["not downloaded yet"];
    return el("tr", {}, [
      el("td", { class: `state ${row.exists ? "ok" : "bad"}`, text: row.exists ? "✓" : "–" }),
      el("td", { class: "label" }, [el("b", { text: row.id }), el("span", { class: "muted", text: ` ${row.kind}` })]),
      el("td", {}, [el("div", { text: facts.join("  ·  ") }), row.managed ? "" : el("div", { class: "muted", text: "not in the download list; it stays as it is" })]),
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
    if (job && job.status !== "running") { toast(job.status === "done" ? `${job.name}: done.` : `${job.name} failed.`, job.status !== "done"); await refresh(); }
  } catch (error) {
    toast(error.message, true);
  }
}

async function startJob(body) {
  try {
    const { job } = await api("jobs", { method: "POST", body });
    renderJob(job);
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
  if (!query.trim()) for (const item of data.curated) addRow(item.title, item.kind === "zim" ? `${item.name} · ${item.note}` : item.url, item.kind === "zim" ? item.name : item.id, item.kind === "zim" ? { zim: item.name } : { map: item.id, url: item.url });
  if (kind === "zim") for (const book of data.results) addRow(book.title || book.name, [book.name, book.language, book.flavour, book.edition, bytes(book.bytes), book.summary].filter(Boolean).join(" · "), book.name, { zim: book.name });
  else for (const region of data.results) addRow(region.name, `${region.id} · ${region.url}`, region.suggestedId, { map: region.suggestedId, url: region.url });
  $("#catalogue tbody").replaceChildren(...rows);
  $("#catalogue-note").textContent = data.error ? data.error : rows.length ? (query.trim() ? `${data.results.length} found.` : "A few common choices; search for more.") : "Nothing found.";
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

function init() {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      for (const other of document.querySelectorAll(".tab")) other.classList.toggle("active", other === tab);
      for (const pane of document.querySelectorAll(".tabpane")) pane.classList.toggle("active", pane.id === `tab-${tab.dataset.tab}`);
      if (tab.dataset.tab === "library" && !$("#catalogue tbody").children.length) searchCatalogue();
    });
  }
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
