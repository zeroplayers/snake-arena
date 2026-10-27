/**
 * Facts the legal pages (`/terms`, `/acceptable-use`, `/privacy`) quote: who runs the service
 * (as on the Companies House register) and where disputes go. Update `LEGAL_UPDATED` whenever
 * the pages change in substance.
 */
export const LEGAL = {
  /** Legal name of the operator and data controller. */
  operator: "Surnin Synergy Ltd",
  /** Shown on the legal pages and in the site footer, as UK company law asks. */
  registration:
    "a private limited company registered in England and Wales, company number 16770926",
  companyNumber: "16770926",
  /** Registered office. */
  address: "71-75 Shelton Street, Covent Garden, London, WC2H 9JQ, United Kingdom",
  /** Where privacy requests and legal notices go. */
  email: "hello@surninsynergy.com",
  governingLaw: "the laws of England and Wales",
  courts: "the courts of England and Wales",
  /** The maker's X profile, in the footer. */
  x: { url: "https://x.com/oleksiisurnin", handle: "@oleksiisurnin", label: "Oleksii Surnin on X" },
} as const;

/** When the pages last changed in substance (shown on each page). */
export const LEGAL_UPDATED = "27 October 2026";

/**
 * Minimum age to have an account. The UK's age of digital consent is 13; EU countries set
 * theirs between 13 and 16 (GDPR art. 8), so 16 works everywhere without parental consent.
 */
export const MINIMUM_AGE = 16;
