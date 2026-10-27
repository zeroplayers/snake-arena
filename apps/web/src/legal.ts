/**
 * Facts the legal pages (`/terms`, `/acceptable-use`, `/privacy`) quote. The bracketed values
 * are placeholders: fill them in before launch (zeroplayers/snake-arena#86), and update
 * `LEGAL_UPDATED` whenever the pages change in substance.
 */
export const LEGAL = {
  /** Who runs the service: a person's or company's legal name. */
  operator: "[OPERATOR LEGAL NAME]",
  /** Postal address, with the country. */
  address: "[POSTAL ADDRESS, COUNTRY]",
  /** Where privacy requests and legal notices go. */
  email: "[CONTACT EMAIL]",
  /** E.g. "the laws of Germany". */
  governingLaw: "[GOVERNING LAW, e.g. the laws of COUNTRY]",
  /** E.g. "the courts of Berlin, Germany". */
  courts: "[COURTS, e.g. the courts of CITY, COUNTRY]",
} as const;

/** When the pages last changed in substance (shown on each page). */
export const LEGAL_UPDATED = "27 October 2026";

/** Minimum age to have an account. 16 is the highest age of digital consent in the EU (GDPR art. 8). */
export const MINIMUM_AGE = 16;
