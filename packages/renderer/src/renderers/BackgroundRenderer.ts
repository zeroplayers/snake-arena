import {
  AdditiveBlending,
  CanvasTexture,
  CircleGeometry,
  Color,
  LinearFilter,
  LinearMipMapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  RepeatWrapping,
  RingGeometry,
  type Scene,
  ShaderMaterial,
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
const HUE_SPEED = 0.12; // hue turns per second

/**
 * Black backdrop, tiled dot grid clipped to the arena disc, and a wall that slowly cycles
 * through hues. Ported from ZeroSnake's rectangular arena to the circular one.
 */
export class BackgroundRenderer {
  private grid: Mesh<CircleGeometry, MeshBasicMaterial> | undefined;
  private border: Mesh<RingGeometry, MeshBasicMaterial> | undefined;
  private glow: Mesh<RingGeometry, ShaderMaterial> | undefined;
  private radius = 0;
  private hue = 0;

  constructor(
    private readonly scene: Scene,
    private readonly options: BackgroundOptions,
  ) {
    scene.background = new Color(0x000000);
  }

  /** Rebuilds the arena meshes when the radius changes. */
  setArenaRadius(radius: number): void {
    if (radius === this.radius || !(radius > 0)) return;
    this.radius = radius;
    this.disposeMeshes();

    const { cellSize, borderWidth, glowOpacity } = this.options;
    const texture = this.createGridTexture();
    // CircleGeometry UVs span its bounding square; with the texture centred, the origin
    // lands on a dot.
    texture.repeat.set((radius * 2) / cellSize, (radius * 2) / cellSize);
    this.grid = new Mesh(new CircleGeometry(radius, 256), new MeshBasicMaterial({ map: texture }));
    this.grid.position.z = -0.5;
    this.grid.renderOrder = -10;

    this.border = new Mesh(
      new RingGeometry(radius, radius + borderWidth, 256),
      new MeshBasicMaterial({ color: 0xff0000, transparent: true, depthWrite: false }),
    );
    this.border.renderOrder = -8;

    // Soft glow: a Gaussian falloff on both sides of the wall, faded to zero well before
    // the ring's edges so nothing looks cut off.
    const sigma = borderWidth * GLOW_SIGMA_MULTIPLIER;
    const centre = radius + borderWidth / 2;
    this.glow = new Mesh(
      new RingGeometry(Math.max(0, centre - sigma * 3.5), centre + sigma * 3.5, 256),
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

const GLOW_FRAGMENT = /* glsl */ `
uniform vec3 color;
uniform float centre;
uniform float sigma;
uniform float opacity;
varying vec2 vPos;
void main() {
  float x = (length(vPos) - centre) / sigma;
  gl_FragColor = vec4(color, opacity * exp(-0.5 * x * x));
  #include <colorspace_fragment>
}
`;
