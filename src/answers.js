// What an answer says about itself, read from its words: the chat's check round and `arviro eval` both need to
// know whether an answer says that the library does not have something. Splits and set lookups only, so linear
// in the length of the answer.
import { normalizeComparable } from "./text.js";

// Words an answer uses to say the library does not have something (English, Dutch, German, French).
const NOT_FOUND_PHRASES = [
  "not in the", "not found", "could not find", "couldn t find", "cannot find", "can t find", "no information", "does not contain", "doesn t contain", "not mentioned",
  "niet in de", "niet gevonden", "kon niet vinden", "kan niet vinden", "geen informatie", "staat niet", "niet te vinden", "kon ik niet", "kan ik niet",
  "nicht gefunden", "keine information", "nicht enthalten", "pas trouve", "aucune information",
];

// Words that deny, and words about finding or having information. A denial near such a word says "it is not there"
// in more ways than a list of phrases can hold: "Ik kan dit telefoonnummer niet vinden in de lokale bibliotheek".
const DENIALS = new Set(["not", "no", "cannot", "unable", "don", "doesn", "isn", "couldn", "can", "niet", "geen", "nergens", "nicht", "kein", "keine", "keinen", "pas", "aucun", "aucune", "ni"]);
const NEEDS_T = new Set(["can", "don", "doesn", "isn", "couldn"]);
// Words that are about finding or holding information and little else: they count anywhere in the sentence of the
// denial, since Dutch and German put the participle at the end ("Er is geen instructie voor ... gevonden").
const FINDING = new Set([
  "find", "found", "contain", "contains", "available", "information", "library", "libraries", "source", "sources", "documents", "records", "mentioned", "listed", "included",
  "vinden", "gevonden", "vind", "bevat", "bevatten", "beschikbaar", "beschikbare", "informatie", "gegevens", "bibliotheek", "bibliotheken", "bron", "bronnen", "documenten", "opgenomen", "vermeld",
  "finden", "gefunden", "enthalten", "informationen", "bibliothek", "quelle", "quellen", "trouve", "trouver", "bibliotheque",
]);
// Everyday words that only say "not there" right next to the denial: "heb geen", "weet niet", "staat niet".
const FINDING_NEARBY = new Set(["know", "tell", "have", "has", "access", "data", "weet", "weten", "vertellen", "zeggen", "heb", "hebben", "toegang", "staat", "staan", "terug", "weiss"]);
const NEARBY = 6;
const SAME_SENTENCE = 20;

/**
 * Whether an answer says the library does not have it: a denial in the same sentence as a word about finding
 * (within twenty words), or within a few words of an everyday word such as "have" or "weet".
 */
export function saysNotFound(answer) {
  const whole = normalizeComparable(answer);
  if (NOT_FOUND_PHRASES.some((phrase) => whole.includes(phrase))) return true;
  for (const sentence of String(answer || "").split(/[.!?;\n]/)) {
    const words = normalizeComparable(sentence).split(" ");
    let denial = -Infinity;
    let finding = -Infinity;
    let nearby = -Infinity;
    for (const [index, word] of words.entries()) {
      // "can", "don" and the like only deny with the "t" of their contraction ("can't" becomes "can t").
      if (DENIALS.has(word) && (!NEEDS_T.has(word) || words[index + 1] === "t")) denial = index;
      if (FINDING.has(word)) finding = index;
      if (FINDING_NEARBY.has(word)) nearby = index;
      if (Math.abs(denial - finding) <= SAME_SENTENCE || Math.abs(denial - nearby) <= NEARBY) return true;
    }
  }
  return false;
}
