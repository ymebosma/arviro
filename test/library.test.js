import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigError, normalizeConfig } from "../src/config.js";
import { createLibrary, formatAge, formatBytes, formatLibraryRows, formatUpdate, formatVerify, parseCatalog, parseChecksumFile, parseMeta4, xmlElements, zimEdition } from "../src/library.js";
import { fixtureConfig, makeFixture, startFakeDownloads, WIKIPEDIA_BOOK, WIKIVOYAGE_BOOK } from "./helpers.js";

const fixture = makeFixture();
const cli = fileURLToPath(new URL("../bin/arviro.js", import.meta.url));
const remote = startFakeDownloads();
const { NEW_WIKIPEDIA, ZIM_BYTES, catalogFeed, meta4 } = remote;
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const md5 = (buffer) => crypto.createHash("md5").update(buffer).digest("hex");

before(() => remote.start());
after(async () => {
  await remote.close();
  fixture.cleanup();
});

const quiet = { log: () => {}, retryDelayMs: 10 };
const rawLibrary = () => ({
  downloads: [
    { zim: "wikipedia_nl_all_nopic" },
    { map: "test", url: `${remote.url}/europe/testland-latest.osm.pbf` },
  ],
  kiwixCatalog: `${remote.url}/catalog/v2`,
});
const makeConfig = (library = rawLibrary()) => fixtureConfig(fixture, { library });
const clock = (iso) => () => new Date(iso);

test("xmlElements, parseCatalog, parseMeta4 and parseChecksumFile read the download formats", () => {
  const elements = xmlElements('<a><b x="1 &amp; 2">one</b><bc>no</bc><b/><b y="z">two</b></a>', "b");
  assert.deepEqual(elements.map((element) => element.body), ["one", "", "two"]);
  assert.equal(elements[0].attributes.x, "1 & 2");

  const latest = parseCatalog(catalogFeed("https://download.example"), "wikipedia_nl_all_nopic", "https://library.example/catalog/v2/entries");
  assert.equal(latest.file, `${NEW_WIKIPEDIA}.zim`);
  assert.equal(latest.url, `https://download.example/zim/wikipedia/${NEW_WIKIPEDIA}.zim`);
  assert.equal(latest.meta4Url, `${latest.url}.meta4`);
  assert.equal(latest.bytes, ZIM_BYTES.length);
  assert.equal(latest.updated, "2026-09-15T00:00:00Z");
  assert.equal(parseCatalog('<feed xmlns="http://www.w3.org/2005/Atom"></feed>', "wikipedia_nl_all_nopic"), null);
  // The file name decides where the download goes: a catalogue must not be able to point outside the ZIM folder or at another series.
  const traversal = catalogFeed("https://download.example").replace(`/zim/wikipedia/${NEW_WIKIPEDIA}.zim.meta4`, "/zim/..%2F..%2Fwikipedia_nl_all_nopic_2026-09.zim.meta4");
  assert.equal(parseCatalog(traversal, "wikipedia_nl_all_nopic"), null);
  const otherSeries = catalogFeed("https://download.example").replace(`${NEW_WIKIPEDIA}.zim.meta4`, "wikipedia_de_all_maxi_2026-09.zim.meta4");
  assert.equal(parseCatalog(otherSeries, "wikipedia_nl_all_nopic"), null);
  // The feed lists the book under the name without its flavour; the file name of the right flavour decides.
  assert.equal(parseCatalog(catalogFeed("https://download.example"), "wikipedia_nl_all_maxi").file, "wikipedia_nl_all_maxi_2026-09.zim");
  assert.equal(parseCatalog(catalogFeed("https://download.example"), "wikipedia_nl_all"), null);

  const link = parseMeta4(meta4("https://download.example"));
  assert.equal(link.size, ZIM_BYTES.length);
  assert.deepEqual(link.hashes[0], { algorithm: "sha256", hex: sha256(ZIM_BYTES) });
  assert.deepEqual(link.urls, [`https://download.example/mirror/${NEW_WIKIPEDIA}.zim`, `https://download.example/zim/wikipedia/${NEW_WIKIPEDIA}.zim`]);

  const hex = md5(Buffer.from("x"));
  assert.deepEqual(parseChecksumFile(`${hex}  file.pbf\n`, "file.pbf"), { algorithm: "md5", hex });
  assert.deepEqual(parseChecksumFile(`${sha256(Buffer.from("other"))}  other.pbf\nMD5 (file.pbf) = ${hex.toUpperCase()}\n`, "file.pbf"), { algorithm: "md5", hex });
  assert.equal(parseChecksumFile("nothing here", "file.pbf"), null);
  assert.equal(zimEdition("wikipedia_nl_all_nopic_2026-04.zim"), "2026-04");
  assert.equal(zimEdition("wikipedia_nl_all_nopic"), null);
});

test("formatting helpers", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(3.3 * 1024 ** 3), "3.3 GB");
  assert.equal(formatBytes(null), "?");
  assert.equal(formatAge(0.5), "today");
  assert.equal(formatAge(12.7), "12 days old");
  assert.equal(formatAge(200), "6 months old");
  assert.equal(formatAge(900), "2 years old");
});

test("the download list is validated", () => {
  const config = makeConfig();
  assert.deepEqual(config.library.downloads.map((item) => [item.id, item.kind]), [["wikipedia_nl_all_nopic", "zim"], ["test", "map"]]);
  assert.equal(config.library.downloads[1].checksum, `${remote.url}/europe/testland-latest.osm.pbf.md5`);
  assert.equal(config.library.downloads[1].file, path.join(fixture.root, "maps/test.osm.pbf"));
  assert.equal(config.library.stateFile, path.join(fixture.root, "data", "library.json"));
  assert.equal(config.library.indexAfterUpdate, true);
  assert.equal(config.library.keepOldEditions, false);
  assert.equal(normalizeConfig({}).library.kiwixCatalog, "https://library.kiwix.org/catalog/v2");

  const custom = makeConfig({ downloads: [{ map: "test", url: "https://example.org/x.pbf", checksum: "x.pbf.sha256" }, { zim: "wikivoyage_nl_all_maxi", checksum: false }] });
  assert.equal(custom.library.downloads[0].checksum, "https://example.org/x.pbf.sha256");
  assert.equal(custom.library.downloads[1].checksum, false);
  assert.equal(makeConfig({ downloads: [{ map: "test", url: "https://example.org/x.pbf", checksum: false }] }).library.downloads[0].checksum, null);

  const rejects = (library, pattern) => assert.throws(() => makeConfig(library), pattern);
  rejects({ downloads: {} }, /must be a list/);
  rejects({ downloads: [{}] }, /needs "zim"/);
  rejects({ downloads: [{ zim: "x", map: "test" }] }, /not both/);
  rejects({ downloads: [{ zim: "wikipedia_nl_all_nopic_2026-04" }] }, /without the edition date/);
  rejects({ downloads: [{ zim: "bad name" }] }, /not a ZIM name/);
  rejects({ downloads: [{ map: "nowhere", url: "https://example.org/x" }] }, /not a region/);
  rejects({ downloads: [{ map: "test" }] }, /needs the "url"/);
  rejects({ downloads: [{ map: "test", url: "ftp://example.org/x" }] }, /http or https/);
  rejects({ downloads: [{ zim: "a" }, { zim: "a" }] }, /listed twice/);
  assert.throws(() => normalizeConfig({ library: { downloads: [{ zim: "wikipedia_nl_all_nopic" }] } }), ConfigError);
});

test("status lists the files in the library, their age, and files outside the download list", () => {
  const rows = createLibrary(makeConfig(), { ...quiet, now: clock("2026-10-03T12:00:00Z") }).status();
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId.wikipedia_nl_all_nopic.file, `${WIKIPEDIA_BOOK}.zim`);
  assert.equal(byId.wikipedia_nl_all_nopic.edition, "2026-04");
  assert.equal(Math.floor(byId.wikipedia_nl_all_nopic.ageDays), 185);
  assert.equal(byId.wikipedia_nl_all_nopic.managed, true);
  assert.equal(byId.wikipedia_nl_all_nopic.verifiedAt, null);
  assert.equal(byId.test.kind, "map");
  assert.equal(byId.test.exists, true);
  assert.equal(byId.wikivoyage_nl_all_maxi.managed, false);
  assert.equal(byId.wikivoyage_nl_all_maxi.file, `${WIKIVOYAGE_BOOK}.zim`);
  const text = formatLibraryRows(rows);
  assert.match(text, /wikipedia_nl_all_nopic +zim +wikipedia_nl_all_nopic_2026-04\.zim +0 B +edition 2026-04 +6 months old +checksum unknown/);
  assert.match(text, /wikivoyage_nl_all_maxi .* not in library\.downloads/);
  assert.equal(formatLibraryRows([]), "The library is empty: no ZIM files, map regions or library.downloads are configured.");
});

test("check reports newer editions without downloading anything", async () => {
  // The placeholder map was never downloaded by arviro, so its own date is compared with the server's.
  const old = new Date("2026-01-01T00:00:00Z");
  fs.utimesSync(path.join(fixture.root, "maps/test.osm.pbf"), old, old);
  remote.requests.length = 0;
  const rows = await createLibrary(makeConfig(), quiet).check();
  const [wikipedia, map] = rows;
  assert.equal(wikipedia.verdict, "newer");
  assert.equal(wikipedia.remote.file, `${NEW_WIKIPEDIA}.zim`);
  assert.equal(map.verdict, "newer");
  assert.equal(map.remote.modifiedAt, "2026-04-01T06:00:00.000Z");
  assert.ok(!remote.requests.some((line) => /^GET \/(zim|mirror)\/.*\.zim$/.test(line) || line === "GET /europe/testland-latest.osm.pbf"), remote.requests.join("\n"));
  assert.ok(remote.requests.includes("HEAD /europe/testland-latest.osm.pbf"));
  assert.match(formatLibraryRows(rows), /NEWER: wikipedia_nl_all_nopic_2026-09\.zim \(293 kB\)/);

  // The catalogue was asked by the full name first and then by the name without the flavour.
  assert.ok(remote.requests.includes("GET /catalog/v2/entries?name=wikipedia_nl_all_nopic&count=50"), remote.requests.join("\n"));
  assert.ok(remote.requests.includes("GET /catalog/v2/entries?name=wikipedia_nl_all&count=50"), remote.requests.join("\n"));
  const unknownName = await createLibrary(makeConfig({ downloads: [{ zim: "nothing_here" }], kiwixCatalog: `${remote.url}/catalog/v2` }), quiet).check();
  assert.equal(unknownName[0].verdict, "error");
  assert.match(unknownName[0].error, /not in the Kiwix catalogue/);
  await assert.rejects(createLibrary(makeConfig(), quiet).check(["typo"]), /not in library\.downloads/);
});

test("update downloads new editions, verifies checksums, removes old editions and records the state", async () => {
  const config = makeConfig();
  const library = createLibrary(config, { ...quiet, now: clock("2026-10-03T12:00:00Z") });
  const summary = await library.update();
  assert.equal(summary.downloaded, 2);
  assert.equal(summary.failed, 0);
  const [wikipedia, map] = summary.items;
  assert.equal(wikipedia.action, "downloaded");
  assert.equal(wikipedia.file, `${NEW_WIKIPEDIA}.zim`);
  assert.deepEqual(wikipedia.removed, [`${WIKIPEDIA_BOOK}.zim`, "wikipedia_nl_all_nopic_2025-01.zim"]);
  assert.ok(ZIM_BYTES.equals(fs.readFileSync(path.join(fixture.zimDir, `${NEW_WIKIPEDIA}.zim`))));
  assert.ok(!fs.existsSync(path.join(fixture.zimDir, `${WIKIPEDIA_BOOK}.zim`)));
  assert.ok(fs.existsSync(path.join(fixture.zimDir, `${WIKIVOYAGE_BOOK}.zim`)), "other series are left alone");
  assert.ok(!fs.existsSync(path.join(fixture.zimDir, `${NEW_WIKIPEDIA}.zim.part`)));
  assert.equal(map.action, "downloaded");
  assert.equal(fs.readFileSync(path.join(fixture.root, "maps/test.osm.pbf"), "utf8"), "map extract, version one");

  const state = JSON.parse(fs.readFileSync(config.library.stateFile, "utf8"));
  assert.equal(state.items["zim:wikipedia_nl_all_nopic"].checksum, `sha256:${sha256(ZIM_BYTES)}`);
  assert.equal(state.items["zim:wikipedia_nl_all_nopic"].downloadedAt, "2026-10-03T12:00:00.000Z");
  assert.equal(state.items["map:test"].checksum, `md5:${md5(remote.map.bytes)}`);
  assert.equal(state.items["map:test"].remoteModified, "2026-04-01T06:00:00.000Z");
  assert.match(formatUpdate(summary), /wikipedia_nl_all_nopic +downloaded wikipedia_nl_all_nopic_2026-09\.zim \(293 kB\); removed wikipedia_nl_all_nopic_2026-04\.zim, wikipedia_nl_all_nopic_2025-01\.zim/);
  assert.match(formatUpdate(summary), /2 downloaded, 0 failed\./);

  // Everything is current now; the status shows the checksums as verified.
  const again = await library.update();
  assert.deepEqual(again.items.map((row) => row.action), ["current", "current"]);
  const rows = library.status();
  assert.equal(rows[0].edition, "2026-09");
  assert.equal(rows[0].verifiedAt, "2026-10-03T12:00:00.000Z");
  assert.equal(rows[1].edition, "2026-04-01");

  // A new map build on the server is noticed by its checksum, and replaces the file.
  remote.map = { bytes: Buffer.from("map extract, version two"), modified: "Thu, 01 Oct 2026 06:00:00 GMT" };
  assert.equal((await library.check(["test"]))[0].verdict, "newer");
  const third = await library.update(["test"]);
  assert.equal(third.items[0].action, "downloaded");
  assert.equal(fs.readFileSync(path.join(fixture.root, "maps/test.osm.pbf"), "utf8"), "map extract, version two");
  assert.equal(library.status()[1].edition, "2026-10-01");
});

test("verify recomputes checksums and notices a changed file", async () => {
  const library = createLibrary(makeConfig(), quiet);
  assert.deepEqual((await library.verify()).map((row) => row.status), ["ok", "ok"]);
  fs.appendFileSync(path.join(fixture.root, "maps/test.osm.pbf"), "!");
  const rows = await library.verify();
  assert.deepEqual(rows.map((row) => row.status), ["ok", "mismatch"]);
  assert.match(formatVerify(rows), /test +MISMATCH +test\.osm\.pbf differs .*arviro library update --force test/);
  const repaired = await library.update(["test"], { force: true });
  assert.equal(repaired.items[0].action, "downloaded");
  assert.deepEqual((await library.verify(["test"])).map((row) => row.status), ["ok"]);
  const unmanaged = createLibrary(makeConfig({ downloads: [{ zim: "wikivoyage_nl_all_maxi" }], kiwixCatalog: `${remote.url}/catalog/v2` }), quiet);
  assert.equal((await unmanaged.verify())[0].status, "unknown");
});

test("a download continues from a .part file and falls back to a mirror", async () => {
  const config = makeConfig({ downloads: [{ zim: "wikipedia_nl_all_nopic" }], kiwixCatalog: `${remote.url}/catalog/v2`, keepOldEditions: true });
  const target = path.join(fixture.zimDir, `${NEW_WIKIPEDIA}.zim`);
  fs.rmSync(target, { force: true });
  fs.writeFileSync(`${target}.part`, ZIM_BYTES.subarray(0, 100_000));
  remote.requests.length = 0;
  remote.canonicalFails = true;
  try {
    const summary = await createLibrary(config, quiet).update();
    assert.equal(summary.items[0].action, "downloaded");
  } finally {
    remote.canonicalFails = false;
  }
  assert.ok(ZIM_BYTES.equals(fs.readFileSync(target)));
  assert.ok(remote.requests.some((line) => line === `GET /mirror/${NEW_WIKIPEDIA}.zim range=bytes=100000-`), remote.requests.join("\n"));
  assert.ok(fs.existsSync(path.join(fixture.zimDir, `${WIKIVOYAGE_BOOK}.zim`)));

  // A server that ignores the Range header answers 200 with the whole file; the partial file is then overwritten.
  fs.rmSync(target, { force: true });
  fs.writeFileSync(`${target}.part`, Buffer.from("stale bytes"));
  remote.ignoreRange = true;
  try {
    const summary = await createLibrary(config, quiet).update();
    assert.equal(summary.items[0].action, "downloaded");
  } finally {
    remote.ignoreRange = false;
  }
  assert.ok(ZIM_BYTES.equals(fs.readFileSync(target)));
}, { timeout: 60_000 });

test("a download whose checksum does not match is discarded", async () => {
  const config = makeConfig({ downloads: [{ map: "test", url: `${remote.url}/europe/testland-latest.osm.pbf`, checksum: `${remote.url}/zim/wikipedia/${NEW_WIKIPEDIA}.zim.meta4` }] });
  const before = fs.readFileSync(path.join(fixture.root, "maps/test.osm.pbf"));
  const summary = await createLibrary(config, quiet).update([], { force: true });
  assert.equal(summary.items[0].action, "failed");
  assert.match(summary.items[0].error, /checksum of the download does not match/);
  assert.ok(before.equals(fs.readFileSync(path.join(fixture.root, "maps/test.osm.pbf"))), "the old file is kept");
  assert.ok(!fs.existsSync(path.join(fixture.root, "maps/test.osm.pbf.part")));
}, { timeout: 60_000 });

test("a ZIM without a published checksum is refused unless checksum is off", async () => {
  // The server stops serving the .meta4 file of the book, and there is no .sha256 file either.
  const config = makeConfig({ downloads: [{ zim: "wikipedia_nl_all_nopic" }], kiwixCatalog: `${remote.url}/catalog/v2`, keepOldEditions: true });
  remote.meta4Missing = true;
  try {
    fs.rmSync(path.join(fixture.zimDir, `${NEW_WIKIPEDIA}.zim`), { force: true });
    const refused = await createLibrary(config, quiet).update();
    assert.equal(refused.items[0].action, "failed");
    assert.match(refused.items[0].error, /no checksum is published/);
    const allowed = await createLibrary(makeConfig({ downloads: [{ zim: "wikipedia_nl_all_nopic", checksum: false }], kiwixCatalog: `${remote.url}/catalog/v2`, keepOldEditions: true }), quiet).update();
    assert.equal(allowed.items[0].action, "downloaded");
    assert.equal(JSON.parse(fs.readFileSync(config.library.stateFile, "utf8")).items["zim:wikipedia_nl_all_nopic"].checksum, null);
  } finally {
    remote.meta4Missing = false;
  }
});

test("the command line runs library status and update, and the index afterwards", async () => {
  const configPath = path.join(fixture.root, "library-config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir: path.join(fixture.root, "data"),
    sources: { library: { path: fixture.library } },
    kiwix: { zimDir: fixture.zimDir },
    maps: { regions: { test: path.join(fixture.root, "maps/test.osm.pbf") } },
    embedding: { provider: "none" },
    tools: { osmium: path.join(fixture.root, "bin/osmium"), pdftotext: false, kiwixServe: false },
    library: { downloads: [{ map: "test", url: `${remote.url}/europe/testland-latest.osm.pbf` }], kiwixCatalog: `${remote.url}/catalog/v2` },
  }));
  const run = (...args) => new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args, "--config", configPath], { timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
  const status = await run("library", "status");
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /^test +map +test\.osm\.pbf/m);
  assert.match(status.stdout, /wikivoyage_nl_all_maxi .*not in library\.downloads/);

  const update = await run("library", "update", "--force");
  assert.equal(update.code, 0, update.stderr);
  assert.match(update.stdout, /test +downloaded test\.osm\.pbf/);
  assert.match(update.stderr, /updating the search index/);
  assert.match(update.stdout, /"maps": \[\s*\{\s*"region": "test",\s*"indexed": true/);

  const skipped = await run("library", "update", "--force", "--no-index");
  assert.equal(skipped.code, 0, skipped.stderr);
  assert.doesNotMatch(skipped.stderr, /updating the search index/);

  const unknown = await run("library", "dance");
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown library command/);
}, { timeout: 120_000 });
