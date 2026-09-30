// Display names for NPPES records, shared by the site generator and the emails.
// NPPES names are all caps ("A GIFTED JOURNEY ( BEHAVIORAL, CONSULTING AND ADVOCACY)"). Shouting
// a clinic's own name at it reads like a mail merge, so title-case it and keep real acronyms.
const KEEP = new Set(["ABA", "LLC", "PLLC", "LLP", "LP", "PA", "PC", "BCBA", "TX", "USA", "II", "III", "DBA"]);
const SMALL = new Set(["and", "of", "the", "for", "in", "at", "to", "a", "an", "&"]);
export function displayName(raw) {
  return String(raw || "").trim().replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/\s+,/g, ",")
    .toLowerCase().split(/\s+/).map((w, i) => {
      const bare = w.replace(/[^a-z&]/gi, "").toUpperCase();
      if (KEEP.has(bare)) return w.toUpperCase();
      if (i > 0 && SMALL.has(w)) return w;
      return w.split("-").map((part) => part.replace(/[a-z]/, (c) => c.toUpperCase())).join("-");
    }).join(" ")
    .replace(/\bMc([a-z])/g, (_, c) => "Mc" + c.toUpperCase());
}
