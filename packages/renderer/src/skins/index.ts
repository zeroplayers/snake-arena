import { CanvasTexture, SRGBColorSpace, type Texture } from "three";
import { DEFAULT_BODY_SVG, DEFAULT_HEAD_SVG, DEFAULT_TAIL_SVG } from "./svg";

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
   * circle (incl. stroke) fills ~72% of its SVG, so the square is drawn ~1.4× wider.
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
    planeScale: 512 / 367,
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
const TEXTURE_SIZE = 256;

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
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(recolorSvg(svg, color))}`;
    return texture;
  }

  dispose(): void {
    for (const texture of this.cache.values()) texture.dispose();
    this.cache.clear();
  }
}

function recolorSvg(svg: string, color: string | undefined): string {
  if (!color || !HEX_COLOR.test(color)) return svg;
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  for (const stop of doc.querySelectorAll("#changeableOuterColor")) {
    stop.setAttribute("stop-color", color);
    stop.setAttribute("stop-opacity", "1");
  }
  return new XMLSerializer().serializeToString(doc.documentElement);
}
