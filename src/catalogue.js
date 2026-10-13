// What can be added to the library: a short curated list, the Kiwix catalogue, and Geofabrik's region index.
import { zimSeries } from "./config.js";
import { acquisitionOf, xmlElements } from "./library.js";
import { decodeEntities } from "./text.js";

const MAX_RESPONSE = 8 * 1024 * 1024;
const CACHE_MS = 60 * 60 * 1000;
const USER_AGENT = "arviro-admin (https://github.com/ymebosma/arviro)";

/**
 * A starting point for people who do not know the catalogues yet, per language (ISO 639-3, as the Kiwix
 * catalogue uses). Nothing here is downloaded by itself; the owner chooses on the admin page.
 */
export const CURATED = Object.freeze([
  { kind: "zim", language: "eng", name: "wikipedia_en_all_mini", title: "Wikipedia, English, introductions only", note: "The first part of every article; the smallest edition." },
  { kind: "zim", language: "eng", name: "wikipedia_en_all_nopic", title: "Wikipedia, English, without pictures", note: "Every article in full; tens of gigabytes." },
  { kind: "zim", language: "eng", name: "wikipedia_en_medicine_maxi", title: "WikiMed, English", note: "The medical articles of Wikipedia." },
  { kind: "zim", language: "eng", name: "wikivoyage_en_all_maxi", title: "Wikivoyage, English", note: "Travel guides." },
  { kind: "zim", language: "nld", name: "wikipedia_nl_all_nopic", title: "Wikipedia, Dutch, without pictures", note: "General knowledge, people, places. The smallest complete edition." },
  { kind: "zim", language: "nld", name: "wikipedia_nl_all_maxi", title: "Wikipedia, Dutch, with pictures", note: "The same articles, with images; much larger." },
  { kind: "zim", language: "nld", name: "wikivoyage_nl_all_maxi", title: "Wikivoyage, Dutch", note: "Travel guides." },
  { kind: "zim", language: "nld", name: "wiktionary_nl_all_maxi", title: "Wiktionary, Dutch", note: "Dictionary." },
  { kind: "zim", language: "deu", name: "wikipedia_de_all_nopic", title: "Wikipedia, German, without pictures", note: "General knowledge, people, places." },
  { kind: "zim", language: "deu", name: "wikivoyage_de_all_maxi", title: "Wikivoyage, German", note: "Travel guides." },
  { kind: "zim", language: "fra", name: "wikipedia_fr_all_nopic", title: "Wikipedia, French, without pictures", note: "General knowledge, people, places." },
  { kind: "zim", language: "fra", name: "wikivoyage_fr_all_maxi", title: "Wikivoyage, French", note: "Travel guides." },
  { kind: "map", language: "eng", id: "gb", title: "Great Britain", url: "https://download.geofabrik.de/europe/great-britain-latest.osm.pbf" },
  { kind: "map", language: "eng", id: "ie", title: "Ireland and Northern Ireland", url: "https://download.geofabrik.de/europe/ireland-and-northern-ireland-latest.osm.pbf" },
  { kind: "map", language: "nld", id: "nl", title: "Netherlands", url: "https://download.geofabrik.de/europe/netherlands-latest.osm.pbf" },
  { kind: "map", language: "nld", id: "be", title: "Belgium", url: "https://download.geofabrik.de/europe/belgium-latest.osm.pbf" },
  { kind: "map", language: "deu", id: "de", title: "Germany", url: "https://download.geofabrik.de/europe/germany-latest.osm.pbf" },
  { kind: "map", language: "deu", id: "at", title: "Austria", url: "https://download.geofabrik.de/europe/austria-latest.osm.pbf" },
  { kind: "map", language: "deu", id: "ch", title: "Switzerland", url: "https://download.geofabrik.de/europe/switzerland-latest.osm.pbf" },
  { kind: "map", language: "fra", id: "fr", title: "France", url: "https://download.geofabrik.de/europe/france-latest.osm.pbf" },
  { kind: "map", language: "fra", id: "be", title: "Belgium", url: "https://download.geofabrik.de/europe/belgium-latest.osm.pbf" },
  { kind: "map", language: "fra", id: "ch", title: "Switzerland", url: "https://download.geofabrik.de/europe/switzerland-latest.osm.pbf" },
]);

export const CURATED_LANGUAGES = Object.freeze([...new Set(CURATED.map((item) => item.language))]);

/** The curated choices of one kind for a language; an unknown or empty language gives the English ones. */
export function curatedFor(kind, language = "") {
  const chosen = CURATED_LANGUAGES.includes(language) ? language : "eng";
  return CURATED.filter((item) => item.kind === kind && item.language === chosen);
}

const text = (xml, name) => decodeEntities(xmlElements(xml, name)[0]?.body ?? "").trim() || null;

/**
 * Books in a Kiwix OPDS feed: { name, title, summary, language, flavour, bytes, edition }.
 * `name` is the series of the file ("wikipedia_nl_all_nopic"), which is what library.downloads needs;
 * the catalogue's own `<name>` leaves the flavour out.
 */
export function parseCatalogueFeed(xml, base = "https://library.kiwix.org/") {
  return xmlElements(xml, "entry").map((entry) => {
    const acquisition = acquisitionOf(entry.body, base);
    if (!acquisition) return null;
    return {
      name: zimSeries(acquisition.file),
      title: text(entry.body, "title"),
      summary: text(entry.body, "summary"),
      language: text(entry.body, "language"),
      flavour: text(entry.body, "flavour"),
      bytes: acquisition.bytes,
      edition: acquisition.file.match(/_(\d{4}-\d{2}(?:-\d{2})?)\.zim$/)?.[1] || null,
    };
  }).filter(Boolean);
}

/** Regions of Geofabrik's index: { id, name, parent, url }. */
export function parseGeofabrikIndex(json) {
  const features = Array.isArray(json?.features) ? json.features : [];
  return features.map((feature) => {
    const properties = feature?.properties || {};
    const url = properties.urls?.pbf;
    if (!properties.id || !url) return null;
    return { id: String(properties.id), name: String(properties.name || properties.id), parent: properties.parent ? String(properties.parent) : null, url: String(url) };
  }).filter(Boolean);
}

/** A region id for the configuration: the last part of Geofabrik's id ("europe/netherlands" -> "netherlands"). */
export function regionIdFor(geofabrikId) {
  return String(geofabrikId).split("/").at(-1).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31) || "region";
}

async function fetchBounded(fetchImpl, url, accept) {
  const response = await fetchImpl(url, { headers: { "user-agent": USER_AGENT, accept }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`${url} answered ${response.status}`); }
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE) throw new Error(`${url} is unexpectedly large`);
  const body = await response.text();
  if (body.length > MAX_RESPONSE) throw new Error(`${url} is unexpectedly large`);
  return body;
}

/**
 * @param {object} options
 * @param {string} options.kiwixCatalog  base URL of the Kiwix OPDS catalogue (config.library.kiwixCatalog)
 */
export function createCatalogue({ kiwixCatalog, geofabrikIndex, fetchImpl = fetch, now = () => Date.now() }) {
  let regionsCache = null;

  /** Search the Kiwix catalogue. `lang` is an ISO 639-3 code such as "nld" or "eng". */
  async function searchZim({ query = "", lang = "" } = {}) {
    const url = new URL(`${kiwixCatalog}/entries`);
    url.searchParams.set("count", "50");
    if (query.trim()) url.searchParams.set("q", query.trim().slice(0, 100));
    if (lang.trim()) url.searchParams.set("lang", lang.trim().slice(0, 10));
    return parseCatalogueFeed(await fetchBounded(fetchImpl, url.href, "application/atom+xml, application/xml, text/xml"), url.href);
  }

  async function regions() {
    if (regionsCache && now() - regionsCache.at < CACHE_MS) return regionsCache.list;
    const list = parseGeofabrikIndex(JSON.parse(await fetchBounded(fetchImpl, geofabrikIndex, "application/json")));
    regionsCache = { at: now(), list };
    return list;
  }

  /** Geofabrik regions whose name or id contains the query (all of them for an empty query). */
  async function searchMaps({ query = "" } = {}) {
    const needle = query.trim().toLowerCase();
    const list = await regions();
    return (needle ? list.filter((region) => region.name.toLowerCase().includes(needle) || region.id.toLowerCase().includes(needle)) : list)
      .slice(0, 100)
      .map((region) => ({ ...region, suggestedId: regionIdFor(region.id) }));
  }

  return { curated: CURATED, curatedFor, searchZim, searchMaps };
}
