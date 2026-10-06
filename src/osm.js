// OpenStreetMap places and amenities: indexing with osmium, and searching by name or "category near place".
import fs from "node:fs";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { ftsQuery, normalizeComparable, STOPWORDS } from "./text.js";

const MAX_DISTANCE_KM = 75;
const CATEGORY_KEYS = ["place", "amenity", "shop", "tourism", "railway", "public_transport", "emergency", "healthcare", "aeroway", "social_facility", "leisure", "office", "craft", "natural", "man_made"];
const PLACE_RANK = { city: 6, town: 5, village: 4, suburb: 3, hamlet: 2 };

// Question words (Dutch and English) mapped to OSM tags.
export const CATEGORY_RULES = [
  { label: "hospital", words: ["ziekenhuis", "ziekenhuizen", "hospital", "hospitals"], tags: [["amenity", "hospital"], ["healthcare", "hospital"]] },
  { label: "pharmacy", words: ["apotheek", "apotheken", "pharmacy", "pharmacies"], tags: [["amenity", "pharmacy"]] },
  { label: "doctor", words: ["huisarts", "huisartsen", "dokter", "doctor", "doctors"], tags: [["amenity", "doctors"], ["healthcare", "doctor"]] },
  { label: "supermarket", words: ["supermarkt", "supermarkten", "supermarket", "supermarkets"], tags: [["shop", "supermarket"]] },
  { label: "fuel", words: ["tankstation", "benzine", "brandstof", "petrol", "gas station", "fuel"], tags: [["amenity", "fuel"]] },
  { label: "fire station", words: ["brandweer", "fire station", "fire department"], tags: [["amenity", "fire_station"], ["emergency", "fire_station"]] },
  { label: "police", words: ["politie", "police"], tags: [["amenity", "police"]] },
  { label: "drinking water", words: ["drinkwater", "waterpunt"], tags: [["amenity", "drinking_water"]] },
  { label: "station", words: ["treinstation", "station", "stations"], tags: [["railway", "station"], ["railway", "halt"]] },
  { label: "airport", words: ["vliegveld", "luchthaven", "airport"], tags: [["aeroway", "aerodrome"]] },
  { label: "shelter", words: ["opvang", "schuilplaats", "shelter"], tags: [["amenity", "shelter"], ["social_facility", "shelter"]] },
];

// Words that name a kind of place rather than a place: category words of the rules above, and stopwords.
const GENERIC_WORDS = new Set([...STOPWORDS, ...CATEGORY_RULES.flatMap((rule) => rule.words.flatMap((word) => normalizeComparable(word).split(" ")))]);

function decodeOpl(value) {
  return value.replace(/%([0-9a-fA-F]{2,6})%/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16))).replace(/%%/g, "%");
}

/** Parse one node line of osmium's OPL output. Returns null for nodes without a usable name. */
export function parseOplNode(line) {
  const id = line.match(/^n(\d+)/)?.[1];
  const coordinate = line.match(/(?:^| )x(-?\d+(?:\.\d+)?) y(-?\d+(?:\.\d+)?)(?: |$)/);
  const rawTags = line.match(/(?:^| )T([^ ]*)/);
  if (!id || !coordinate || !rawTags) return null;
  const tags = {};
  for (const pair of rawTags[1].split(",")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    tags[decodeOpl(pair.slice(0, separator))] = decodeOpl(pair.slice(separator + 1));
  }
  const categories = CATEGORY_KEYS.flatMap((key) => tags[key] ? [key, tags[key], `${key}=${tags[key]}`] : []).join(" ");
  const aliases = [tags["name:nl"], tags["name:en"], tags.official_name, tags.alt_name, tags.short_name, tags.operator, tags.brand].filter(Boolean).join(" ");
  const name = tags.name || tags["name:nl"] || tags.amenity || tags.shop || tags.tourism || tags.railway || tags.emergency || tags.healthcare || tags.aeroway || tags.social_facility;
  if (!name) return null;
  return { osmId: `n${id}`, name, aliases, categories, latitude: Number(coordinate[2]), longitude: Number(coordinate[1]), place: tags.place || null, tags };
}

function deleteRegion(db, region) {
  const deleteFts = db.prepare("DELETE FROM osm_fts WHERE rowid=?");
  for (const row of db.prepare("SELECT id FROM osm_objects WHERE region=?").all(region)) deleteFts.run(row.id);
  db.prepare("DELETE FROM osm_objects WHERE region=?").run(region);
}

/** Index the named nodes of one .osm.pbf extract. Unchanged files are skipped. */
export async function indexOsmRegion(db, region, file, osmium, log = () => {}) {
  if (!fs.existsSync(file)) return { region, skipped: "file is missing" };
  if (!osmium) return { region, skipped: "osmium was not found" };
  const stat = fs.statSync(file);
  const signature = `opl2:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  const prior = db.prepare("SELECT signature FROM osm_sources WHERE region=?").get(region);
  if (prior?.signature === signature) {
    return { region, unchanged: true, objects: Number(db.prepare("SELECT count(*) AS n FROM osm_objects WHERE region=?").get(region).n) };
  }

  // Load into a staging region first, so a failed run leaves the previous data intact.
  const staging = `${region}__staging`;
  db.exec("BEGIN IMMEDIATE");
  try { deleteRegion(db, staging); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }

  const filters = ["n/name", "n/place", "n/amenity", "n/shop", "n/tourism", "n/railway", "n/public_transport", "n/emergency", "n/healthcare", "n/aeroway", "n/social_facility"];
  const child = spawn(osmium, ["tags-filter", file, ...filters, "-R", "-f", "opl", "-o", "-"], { stdio: ["ignore", "pipe", "pipe"] });
  let errorOutput = "";
  child.stderr.on("data", (chunk) => { if (errorOutput.length < 4000) errorOutput += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(errorOutput.trim() || `osmium exited with code ${code}`)));
  });
  exited.catch(() => {});

  const insert = db.prepare("INSERT OR REPLACE INTO osm_objects(region,osm_id,name,aliases,categories,latitude,longitude,place,tags) VALUES(?,?,?,?,?,?,?,?,?)");
  const insertFts = db.prepare("INSERT INTO osm_fts(rowid,name,aliases,categories) VALUES(?,?,?,?)");
  let count = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for await (const line of readline.createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      const object = parseOplNode(line);
      if (!object) continue;
      const row = insert.run(staging, object.osmId, object.name, object.aliases, object.categories, object.latitude, object.longitude, object.place, JSON.stringify(object.tags));
      insertFts.run(row.lastInsertRowid, object.name, object.aliases, object.categories);
      count += 1;
      if (count % 100_000 === 0) log(`maps ${region}: ${count} objects`);
    }
    await exited;
    deleteRegion(db, region);
    db.prepare("UPDATE osm_objects SET region=? WHERE region=?").run(region, staging);
    db.prepare("INSERT OR REPLACE INTO osm_sources(region,path,signature,indexed_at) VALUES(?,?,?,?)").run(region, file, signature, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { region, indexed: true, objects: count };
}

/** Remove map regions that are no longer configured. */
export function removeStaleRegions(db, regions) {
  const removed = [];
  for (const row of db.prepare("SELECT region FROM osm_sources").all()) {
    if (regions.includes(row.region)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      deleteRegion(db, row.region);
      db.prepare("DELETE FROM osm_sources WHERE region=?").run(row.region);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    removed.push(row.region);
  }
  return removed;
}

function haversine(a, b) {
  const toRad = (degrees) => degrees * Math.PI / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
}

export function createOsmSearch(db) {
  let cache = null;

  // Place names (cities, villages, ...) by normalized name, to find the place a question is about.
  function places() {
    const version = db.prepare("PRAGMA data_version").get().data_version;
    if (cache?.version === version) return cache.byName;
    const byName = new Map();
    for (const row of db.prepare("SELECT region, name, latitude, longitude, place FROM osm_objects WHERE place IS NOT NULL").iterate()) {
      const key = normalizeComparable(row.name);
      if (key.length < 2) continue;
      const rank = PLACE_RANK[row.place] || 1;
      const existing = byName.get(key);
      if (!existing || rank > existing.rank) byName.set(key, { ...row, rank });
    }
    cache = { version, byName };
    return byName;
  }

  /**
   * The longest place name that occurs in the question as whole words.
   * A name made only of category words and stopwords ("Het Station", a hamlet) is not taken for the place:
   * in "the pharmacy nearest to the station of Gouda", Gouda is meant.
   */
  function findPlace(query, regions) {
    const words = normalizeComparable(query).split(" ").filter(Boolean);
    const byName = places();
    let best = null;
    for (let start = 0; start < words.length; start += 1) {
      for (let length = Math.min(5, words.length - start); length >= 1; length -= 1) {
        const candidateWords = words.slice(start, start + length);
        if (candidateWords.every((word) => GENERIC_WORDS.has(word))) continue;
        const candidate = byName.get(candidateWords.join(" "));
        if (!candidate || !regions.includes(candidate.region)) continue;
        if (!best || candidate.name.length > best.name.length || (candidate.name.length === best.name.length && candidate.rank > best.rank)) best = candidate;
        break;
      }
    }
    return best;
  }

  /**
   * "ziekenhuis in Gouda" gives the nearest hospitals to Gouda with distances;
   * any other question is matched against names and categories.
   */
  function search(query, { limit = 10, regions = [] } = {}) {
    if (!regions.length) return [];
    // Substring match, so Dutch compounds such as "streekziekenhuis" are recognised; rule order breaks ties.
    const normalizedQuery = normalizeComparable(query);
    const rule = CATEGORY_RULES.find((candidate) => candidate.words.some((word) => normalizedQuery.includes(word)));
    const location = rule ? findPlace(query, regions) : null;
    if (location && rule) {
      const match = rule.tags.map(([key, value]) => `categories:"${`${key} ${value}`.replace(/[^\p{L}\p{N}]+/gu, " ")}"`).join(" OR ");
      const candidates = [];
      const rows = db.prepare("SELECT o.region, o.name, o.latitude, o.longitude FROM osm_fts JOIN osm_objects o ON o.id=osm_fts.rowid WHERE osm_fts MATCH ? AND o.region=?").iterate(match, location.region);
      for (const row of rows) {
        const distanceKm = haversine(location, row);
        if (distanceKm <= MAX_DISTANCE_KM) candidates.push({ ...row, distanceKm });
      }
      return candidates.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, limit).map((row) => ({
        region: row.region,
        name: row.name,
        category: rule.label,
        latitude: row.latitude,
        longitude: row.longitude,
        distanceKm: Number(row.distanceKm.toFixed(2)),
        near: location.name,
      }));
    }
    const match = ftsQuery(query);
    if (!match) return [];
    const placeholders = regions.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT o.region, o.name, o.aliases, o.categories, o.latitude, o.longitude, o.place, bm25(osm_fts, 2.5, 1.5, 1.0) AS score
      FROM osm_fts JOIN osm_objects o ON o.id=osm_fts.rowid
      WHERE osm_fts MATCH ? AND o.region IN (${placeholders}) ORDER BY score LIMIT ?
    `).all(match, ...regions, limit);
    return rows.map((row) => ({
      region: row.region,
      name: row.name,
      aliases: row.aliases || undefined,
      categories: row.categories || undefined,
      latitude: row.latitude,
      longitude: row.longitude,
      place: row.place || undefined,
    }));
  }

  return { search };
}
