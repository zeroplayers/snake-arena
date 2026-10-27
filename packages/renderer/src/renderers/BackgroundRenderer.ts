import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  LinearFilter,
  LinearMipMapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  Path,
  PlaneGeometry,
  RepeatWrapping,
  type Scene,
  ShaderMaterial,
  Shape,
  ShapeGeometry,
} from "three";

export interface BackgroundOptions {
  /** Distance between grid dots, world units. */
  readonly cellSize: number;
  /** Grid dot radius, world units. */
  readonly dotRadius: number;
  /** Width of the arena wall line, world units. */
  readonly borderWidth: number;
  /** Peak opacity of the soft glow around the wall. */
  readonly glowOpacity: number;
}

export const DEFAULT_BACKGROUND: BackgroundOptions = {
  cellSize: 2.1,
  dotRadius: 0.1,
  borderWidth: 0.35,
  glowOpacity: 0.55,
};

const GRID_TEXTURE_PX = 64;
/** Glow falloff (Gaussian sigma) in wall widths. */
const GLOW_SIGMA_MULTIPLIER = 3;
/** The glow mesh reaches this many sigmas each side of the wall (faded to zero by then). */
const GLOW_REACH_SIGMAS = 3.5;
/** How many sigmas of glow outside the wall `extent` keeps in view (~2% of its peak beyond). */
const GLOW_VISIBLE_SIGMAS = 2.5;
const HUE_SPEED = 0.12; // hue turns per second

/**
 * Black backdrop, tiled dot grid clipped to the square arena, and a wall that slowly cycles
 * through hues, with a soft glow on both sides. As in ZeroSnake, whose arena was a square too.
 */
export class BackgroundRenderer {
  private grid: Mesh<PlaneGeometry, MeshBasicMaterial> | undefined;
  private border: Mesh<ShapeGeometry, MeshBasicMaterial> | undefined;
  private glow: Mesh<ShapeGeometry, ShaderMaterial> | undefined;
  private halfSize = 0;
  private hue = 0;

  constructor(
    private readonly scene: Scene,
    private readonly options: BackgroundOptions,
  ) {
    scene.background = new Color(0x000000);
  }

  /**
   * How far from the centre (along an axis) the wall and the visible part of its glow reach:
   * a camera showing ±this sees the whole arena.
   */
  extent(halfSize: number): number {
    const { borderWidth } = this.options;
    return halfSize + borderWidth / 2 + borderWidth * GLOW_SIGMA_MULTIPLIER * GLOW_VISIBLE_SIGMAS;
  }

  /** Rebuilds the arena meshes when its size changes. */
  setArenaHalfSize(halfSize: number): void {
    if (halfSize === this.halfSize || !(halfSize > 0)) return;
    this.halfSize = halfSize;
    this.disposeMeshes();

    const { cellSize, borderWidth, glowOpacity } = this.options;
    const texture = this.createGridTexture();
    // PlaneGeometry UVs span the plane; with the texture centred, the origin lands on a dot.
    texture.repeat.set((halfSize * 2) / cellSize, (halfSize * 2) / cellSize);
    this.grid = new Mesh(
      new PlaneGeometry(halfSize * 2, halfSize * 2),
      new MeshBasicMaterial({ map: texture }),
    );
    this.grid.position.z = -0.5;
    this.grid.renderOrder = -10;

    this.border = new Mesh(
      squareFrame(halfSize, halfSize + borderWidth),
      new MeshBasicMaterial({ color: 0xff0000, transparent: true, depthWrite: false }),
    );
    this.border.renderOrder = -8;

    // Soft glow: a Gaussian falloff on both sides of the wall (by distance to the square, so
    // it rounds off outside the corners), faded to zero well before the frame's edges so
    // nothing looks cut off.
    const sigma = borderWidth * GLOW_SIGMA_MULTIPLIER;
    const centre = halfSize + borderWidth / 2;
    this.glow = new Mesh(
      squareFrame(centre - sigma * GLOW_REACH_SIGMAS, centre + sigma * GLOW_REACH_SIGMAS),
      new ShaderMaterial({
        uniforms: {
          color: { value: new Color(0xffffff) },
          centre: { value: centre },
          sigma: { value: sigma },
          opacity: { value: glowOpacity },
        },
        vertexShader: GLOW_VERTEX,
        fragmentShader: GLOW_FRAGMENT,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.glow.renderOrder = -9;
    this.glow.visible = glowOpacity > 0;

    this.scene.add(this.grid, this.glow, this.border);
  }

  update(dt: number): void {
    this.hue = (this.hue + dt * HUE_SPEED) % 1;
    this.border?.material.color.setHSL(this.hue, 1, 0.5);
    this.glow?.material.uniforms.color?.value.setHSL(this.hue, 1, 0.6);
  }

  destroy(): void {
    this.disposeMeshes();
  }

  private createGridTexture(): CanvasTexture {
    const { cellSize, dotRadius } = this.options;
    const canvas = document.createElement("canvas");
    canvas.width = GRID_TEXTURE_PX;
    canvas.height = GRID_TEXTURE_PX;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, GRID_TEXTURE_PX, GRID_TEXTURE_PX);
      ctx.fillStyle = "#FFFFFF";
      ctx.beginPath();
      const r = Math.min(dotRadius / cellSize, 0.5) * GRID_TEXTURE_PX;
      ctx.arc(GRID_TEXTURE_PX / 2, GRID_TEXTURE_PX / 2, r, 0, Math.PI * 2);
      ctx.fill();
    }
    const texture = new CanvasTexture(canvas);
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.center.set(0.5, 0.5);
    texture.minFilter = LinearMipMapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.anisotropy = 4;
    return texture;
  }

  private disposeMeshes(): void {
    for (const mesh of [this.grid, this.border, this.glow]) {
      if (!mesh) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      if (mesh.material instanceof MeshBasicMaterial) mesh.material.map?.dispose();
      mesh.material.dispose();
    }
    this.grid = this.border = this.glow = undefined;
  }
}

const GLOW_VERTEX = /* glsl */ `
varying vec2 vPos;
void main() {
  vPos = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** The flat region between two centred squares of half-sides `inner` and `outer`. */
function squareFrame(inner: number, outer: number): ShapeGeometry {
  const shape = new Shape()
    .moveTo(-outer, -outer)
    .lineTo(outer, -outer)
    .lineTo(outer, outer)
    .lineTo(-outer, outer)
    .closePath();
  if (inner > 0) {
    shape.holes.push(
      new Path()
        .moveTo(-inner, -inner)
        .lineTo(-inner, inner)
        .lineTo(inner, inner)
        .lineTo(inner, -inner)
        .closePath(),
    );
  }
  return new ShapeGeometry(shape);
}

const GLOW_FRAGMENT = /* glsl */ `
uniform vec3 color;
uniform float centre;
uniform float sigma;
uniform float opacity;
varying vec2 vPos;
void main() {
  // Signed distance to the square of half-side centre (negative inside).
  vec2 d = abs(vPos) - vec2(centre);
  float x = (length(max(d, 0.0)) + min(max(d.x, d.y), 0.0)) / sigma;
  gl_FragColor = vec4(color, opacity * exp(-0.5 * x * x));
  #include <colorspace_fragment>
}
`;
