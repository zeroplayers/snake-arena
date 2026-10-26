import { CanvasTexture, SRGBColorSpace, type Texture } from "three";
import { DEFAULT_BODY_SVG, DEFAULT_HEAD_SVG, DEFAULT_TAIL_SVG } from "./svg.ts";

/**
 * Textures cover this many times the SVG's own viewBox, centred on it. The skins' blur glow
 * spills well past their viewBox; without the margin it gets clipped into a visible square.
 */
export const SVG_PADDING = 2;

export interface SkinPart {
  readonly svg: string;
}

export interface SkinDefinition {
  readonly id: string;
  readonly head: SkinPart;
  readonly body: SkinPart;
  readonly tail: SkinPart;
  /** Used when the snake has no colour of its own. */
  readonly defaultColor: string;
  /**
   * Side of the textured square relative to the snake's diameter. The default skin's body
   * circle (incl. stroke) fills ~72% of its SVG, and textures are padded by `SVG_PADDING`.
   */
  readonly planeScale: number;
}

export const SKINS: Record<string, SkinDefinition> = {
  default: {
    id: "default",
    head: { svg: DEFAULT_HEAD_SVG },
    body: { svg: DEFAULT_BODY_SVG },
    tail: { svg: DEFAULT_TAIL_SVG },
    defaultColor: "#F1F1F1",
    planeScale: (512 / 367) * SVG_PADDING,
  },
};

export function resolveSkin(id: string | undefined): SkinDefinition {
  return (id && SKINS[id]) || (SKINS.default as SkinDefinition);
}

/** Colours handed out to snakes that don't pick one (the original's colour schemes). */
export const SNAKE_PALETTE = [
  "#FF0000",
  "#00FFD4",
  "#179EFF",
  "#BFFF00",
  "#ED00EE",
  "#00EDDD",
  "#FF9500",
  "#F1F1F1",
] as const;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const TEXTURE_SIZE = 512;

/**
 * Textures of skin SVGs with every `<stop id="changeableOuterColor">` set to a colour
 * (ported from ZeroSnake's svgTextureModifier). A texture is usable at once and fills in when
 * the image has decoded. One cache per renderer, so disposing one renderer can't break another.
 */
export class SkinTextures {
  private cache = new Map<string, Texture>();

  get(svg: string, color: string | undefined): Texture {
    const key = `${color ?? ""}|${svg}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const canvas = document.createElement("canvas");
    canvas.width = TEXTURE_SIZE;
    canvas.height = TEXTURE_SIZE;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    this.cache.set(key, texture);

    const image = new Image();
    image.onload = () => {
      canvas.getContext("2d")?.drawImage(image, 0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
      texture.needsUpdate = true;
    };
    image.onerror = () => console.error("[renderer] failed to rasterise skin SVG");
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(prepareSvg(svg, color))}`;
    return texture;
  }

  dispose(): void {
    for (const texture of this.cache.values()) texture.dispose();
    this.cache.clear();
  }
}

/** Recolours `changeableOuterColor` stops and widens the canvas and filters for the glow. */
function prepareSvg(svg: string, color: string | undefined): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;

  if (color && HEX_COLOR.test(color)) {
    for (const stop of doc.querySelectorAll("#changeableOuterColor")) {
      stop.setAttribute("stop-color", color);
      stop.setAttribute("stop-opacity", "1");
    }
  }

  const [x = 0, y = 0, w = 1024, h = 1024] = (root.getAttribute("viewBox") ?? "")
    .split(/[\s,]+/)
    .map(Number);
  const pw = w * SVG_PADDING;
  const ph = h * SVG_PADDING;
  const px = x - (pw - w) / 2;
  const py = y - (ph - h) / 2;
  root.setAttribute("viewBox", `${px} ${py} ${pw} ${ph}`);
  root.setAttribute("width", String(pw));
  root.setAttribute("height", String(ph));
  // Filter regions default to the shape's bounding box (+50%), which also cuts the blur off.
  for (const filter of doc.querySelectorAll("filter")) {
    filter.setAttribute("filterUnits", "userSpaceOnUse");
    filter.setAttribute("x", String(px));
    filter.setAttribute("y", String(py));
    filter.setAttribute("width", String(pw));
    filter.setAttribute("height", String(ph));
  }
  return new XMLSerializer().serializeToString(root);
}
