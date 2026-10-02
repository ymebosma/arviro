// Shared test fixtures: a small library on disk, stand-ins for external programs, and a fake kiwix-serve.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { normalizeConfig } from "../src/config.js";
import { PREFIX } from "../src/embeddings.js";

export const WIKIPEDIA_BOOK = "wikipedia_nl_all_nopic_2026-04";
export const WIKIVOYAGE_BOOK = "wikivoyage_nl_all_maxi_2026-09";

function write(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

const FIRST_AID = `# First aid at home

Keep a first aid kit in the house. It should contain bandages, sterile dressings and disposable gloves.

## Bleeding

Press firmly on a bleeding wound with a clean dressing and raise the limb.

## Burns

Cool a burn with lukewarm running water for at least ten minutes.
`;

const OPL = [
  "n1 v1 dV c0 t i0 u Tplace=town,name=Testdorp x5.1000000 y52.3000000",
  "n2 v1 dV c0 t i0 u Tamenity=hospital,name=Streekziekenhuis%20%Testdorp x5.1100000 y52.3050000",
  "n3 v1 dV c0 t i0 u Tamenity=hospital,name=Ver%20%Hospitaal x6.9000000 y53.2000000",
  "n4 v1 dV c0 t i0 u Tamenity=pharmacy,name=Apotheek%20%Centrum x5.1010000 y52.3010000",
  "n5 v1 dV c0 t i0 u Tplace=village,name=Anderdorp x5.5000000 y52.5000000",
  "n6 v1 dV c0 t i0 u Tamenity=hospital,name=Ziekenhuis%20%Anderdorp x5.5050000 y52.5010000",
  "n7 v1 dV c0 t i0 u Thighway=crossing x5.2 y52.2",
].join("\n");

/**
 * Create a temporary library. Returns the paths and a `cleanup` function.
 * Layout: library/ (public documents), wiki/ (private documents), zim/ (empty ZIM files), maps/.
 */
export function makeFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "arviro-test-")));
  const library = path.join(root, "library");
  write(path.join(library, "manuals/first-aid.md"), FIRST_AID);
  write(path.join(library, "manuals/water.txt"), "Drinking water\n\nBoil water for one minute to make it safe to drink. Store ten litres per person.\n");
  write(path.join(library, "guides/documents/emergency-guide.pdf"), "%PDF-1.4 placeholder");
  write(path.join(library, "guides/text/emergency-guide.txt"), "Emergency guide, page one. Keep a battery radio and a torch ready.\n\fPage two explains evacuation routes and the emergency meeting point.\n");
  write(path.join(library, "manuals/checklist.pdf"), "%PDF-1.4 placeholder without a text copy");
  write(path.join(library, "web/standalone.html"), "<html><body><h1>Storm</h1><p>Close shutters &amp; windows during a storm warning.</p></body></html>");
  write(path.join(library, "web/twin.html"), "<html><body><p>Twin page about candles.</p></body></html>");
  write(path.join(library, "web/twin.txt"), "Twin page about candles and matches for a power outage.\n");
  write(path.join(library, ".hidden/secret.md"), "# Hidden\n\nThis hidden file about bandages must never be indexed.\n");
  write(path.join(library, "vendor/ignored.md"), "# Vendor\n\nBundled third party text about bandages that is excluded.\n");
  write(path.join(root, "outside/secret.txt"), "Outside the library: must stay unreadable.\n");

  const wiki = path.join(root, "wiki");
  write(path.join(wiki, "family/grandmother.md"), "# Grandmother Anna\n\nAnna was born in Utrecht and kept a diary about the family bakery.\n");

  const zimDir = path.join(root, "zim");
  for (const name of [`${WIKIPEDIA_BOOK}.zim`, "wikipedia_nl_all_nopic_2025-01.zim", `${WIKIVOYAGE_BOOK}.zim`]) write(path.join(zimDir, name), "");

  write(path.join(root, "maps/test.osm.pbf"), "placeholder");
  write(path.join(root, "maps/test.opl"), `${OPL}\n`);
  // Stand-ins for osmium and pdftotext.
  write(path.join(root, "bin/osmium"), `#!/bin/sh\ncat "${path.join(root, "maps/test.opl")}"\n`, 0o755);
  write(path.join(root, "bin/pdftotext"), [
    "#!/bin/sh",
    "# Stand-in for pdftotext: every PDF has five pages.",
    "first=1; last=5",
    'while [ $# -gt 0 ]; do case "$1" in -f) first=$2; shift 2;; -l) last=$2; shift 2;; *) shift;; esac; done',
    'if [ "$first" -gt 5 ]; then echo "Command Line Error: Wrong page range given: the first page ($first) can not be after the last page (5)." >&2; exit 99; fi',
    '[ "$last" -gt 5 ] && last=5',
    "page=$first",
    'while [ "$page" -le "$last" ]; do printf "Checklist page %s: torch, radio and spare batteries\\n   item      one\\n\\n\\f" "$page"; page=$((page + 1)); done',
    "",
  ].join("\n"), 0o755);
  // A pdftotext that fails the way the real one does on a damaged file: its message contains the file path.
  write(path.join(root, "bin/pdftotext-broken"), [
    "#!/bin/sh",
    'for last; do :; done',
    'echo "Syntax Error: Could not read $*" >&2',
    "exit 1",
    "",
  ].join("\n"), 0o755);

  return { root, library, wiki, zimDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A normalized configuration for the fixture. Embeddings are off unless overridden. */
export function fixtureConfig(fixture, overrides = {}) {
  return normalizeConfig({
    dataDir: path.join(fixture.root, "data"),
    sources: {
      library: {
        path: fixture.library,
        description: "Test library",
        routes: [{ prefix: "manuals", terms: ["first aid", "bandage", "medical"] }],
        expandQueries: true,
      },
      wiki: { path: fixture.wiki, description: "Private notes", private: true },
    },
    kiwix: { zimDir: fixture.zimDir, port: 1 },
    maps: { regions: { test: path.join(fixture.root, "maps/test.osm.pbf") } },
    embedding: { provider: "none" },
    server: { port: 0 },
    tools: { osmium: path.join(fixture.root, "bin/osmium"), pdftotext: path.join(fixture.root, "bin/pdftotext"), kiwixServe: false },
    ...overrides,
  });
}

/**
 * An embedder that maps texts to "concept" vectors, so that different words can mean the same thing.
 * Texts sharing a concept have cosine similarity 1; unrelated texts 0.
 * Two extra dimensions keep a query without any concept unrelated to documents without any concept.
 */
export function conceptEmbedder(concepts) {
  return {
    enabled: true,
    model: "test-concepts",
    async embed(inputs, prefix) {
      return inputs.map((input) => {
        const lower = input.toLowerCase();
        const vector = concepts.map((words) => words.some((word) => lower.includes(word)) ? 1 : 0);
        const none = vector.some(Boolean) ? 0 : 1;
        return [...vector, prefix === PREFIX.query ? none : 0, prefix === PREFIX.query ? 0 : none];
      });
    },
  };
}

const ARTICLES = {
  [`/kiwix/content/${WIKIPEDIA_BOOK}/Gregor_Kobel`]: { title: "Gregor Kobel", snippet: "Gregor Kobel is een Zwitsers <b>voetballer</b> die als doelman speelt." },
  [`/kiwix/content/${WIKIPEDIA_BOOK}/Gouda`]: { title: "Gouda", snippet: "Gouda is een stad en gemeente in Zuid-Holland." },
  [`/kiwix/content/${WIKIVOYAGE_BOOK}/Gouda`]: { title: "Gouda", snippet: "Gouda is een stad met een bekende kaasmarkt." },
  [`/kiwix/content/${WIKIPEDIA_BOOK}/Once_Upon_a_Time..._in_Hollywood`]: { title: "Once Upon a Time... in Hollywood", snippet: "Once Upon a Time... in Hollywood is een film uit 2019." },
};

/** A minimal stand-in for kiwix-serve with a few articles. Returns { port, requests, close }. */
export async function startFakeKiwix() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push(url.pathname + url.search);
    const book = url.searchParams.get("content");
    if (url.pathname === "/kiwix/search") {
      const pattern = (url.searchParams.get("pattern") || "").toLowerCase();
      const items = Object.entries(ARTICLES)
        .filter(([link, article]) => link.includes(`/${book}/`) && `${article.title} ${article.snippet}`.toLowerCase().includes(pattern))
        .map(([link, article]) => `<item><title>${article.title}</title><link>${link}</link><description>...${article.snippet}...</description><book><title>Book</title></book></item>`);
      res.writeHead(200, { "content-type": "application/rss+xml" });
      return res.end(`<?xml version="1.0"?><rss><channel><title>Search</title>${items.join("")}</channel></rss>`);
    }
    if (url.pathname === "/kiwix/suggest") {
      const term = (url.searchParams.get("term") || "").toLowerCase();
      const items = Object.entries(ARTICLES)
        .filter(([link, article]) => link.includes(`/${book}/`) && article.title.toLowerCase().split(" ").some((word) => word.startsWith(term)))
        .map(([link, article]) => ({ value: article.title, label: article.title, kind: "path", path: link.split("/").at(-1) }));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify([...items, { value: term, label: "containing", kind: "pattern" }]));
    }
    const article = ARTICLES[decodeURIComponent(url.pathname)];
    if (article) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<html><head><title>${article.title}</title></head><body><h1>${article.title}</h1><p>${article.snippet}</p><p>Tweede alinea.</p></body></html>`);
    }
    if ([WIKIPEDIA_BOOK, WIKIVOYAGE_BOOK].some((name) => url.pathname === `/kiwix/content/${name}`)) {
      res.writeHead(302, { location: `${url.pathname}/Hoofdpagina` });
      return res.end();
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    requests,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}
