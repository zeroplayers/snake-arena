/** Served by `docsPlugin` (plugin.ts). */
declare module "virtual:zerosnake-docs" {
  /** Every page of `docs/`, the index (`slug: ""`) first. */
  export const DOCS: readonly { slug: string; title: string }[];
  /** The rendered page (a `DocPage` of render.ts), or `undefined` if no page has that slug. */
  export function loadDoc(slug: string): Promise<
    | {
        readonly slug: string;
        readonly title: string;
        readonly html: string;
        readonly anchors: readonly string[];
      }
    | undefined
  >;
}
