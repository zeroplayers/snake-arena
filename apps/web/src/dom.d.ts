/**
 * `wrangler types` declares HTMLRewriter's `Element` globally, and its `append(content)` shadows
 * the DOM's `ParentNode.append(...nodes)`. Client code that runs in the browser (the replay
 * viewer, `@zerosnake/viewer`) needs the DOM one, so merge it back in.
 */
interface Element {
  append(...nodes: (Node | string)[]): void;
}
