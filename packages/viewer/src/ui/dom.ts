type Child = Node | string | false | null | undefined;

/** `document.createElement` with a class, attributes and children. Text is never parsed as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; title?: string; [attr: string]: string | undefined } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key === "class") el.className = value;
    else el.setAttribute(key, value);
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

export function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const el = h("button", { type: "button", class: "zsv-btn", title }, label);
  el.addEventListener("click", onClick);
  return el;
}

export function swatch(color: string): HTMLSpanElement {
  const el = h("span", { class: "zsv-swatch" });
  el.style.background = color;
  return el;
}

export const fmt = {
  score: (v: number) => v.toFixed(1),
  mass: (v: number) => v.toFixed(1),
  turn: (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2),
};
