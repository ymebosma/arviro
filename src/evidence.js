// Evidence check for "who is X?" questions: only an exactly matching title counts as confirmation.
import { extractEntityLookup, normalizeComparable } from "./text.js";

/**
 * @param {string} query
 * @param {{ source: string, title: string, path: string, encyclopedia?: boolean }[]} candidates  titles found by the search
 * @returns {object} { mode: "general" } or an entity verdict with status verified | ambiguous | not_found
 */
export function buildEvidence(query, candidates) {
  const subject = extractEntityLookup(query);
  if (!subject) return { mode: "general", status: "retrieved" };
  const normalizedSubject = normalizeComparable(subject);
  const reference = ({ source, title, path }) => ({ source, title, path });
  const exact = candidates.filter((item) => normalizeComparable(item.title) === normalizedSubject);
  if (exact.length) {
    const preferred = exact.find((item) => item.encyclopedia) || exact[0];
    return {
      mode: "entity",
      status: "verified",
      subject,
      requiredSource: { source: preferred.source, path: preferred.path },
      exactMatches: exact.slice(0, 5).map(reference),
    };
  }
  const related = candidates.filter((item) => {
    const title = normalizeComparable(item.title);
    return title && (title.includes(normalizedSubject) || normalizedSubject.includes(title));
  }).slice(0, 5).map(reference);
  return {
    mode: "entity",
    status: related.length ? "ambiguous" : "not_found",
    subject,
    candidates: related,
  };
}
