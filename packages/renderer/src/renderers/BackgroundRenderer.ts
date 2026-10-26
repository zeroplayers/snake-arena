import {
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
} from "three";

export interface BackgroundOptions {
  /** Distance between grid dots, world units. */
  readonly cellSize: number;
  /** Grid dot radius, world units. */
  readonly dotRadius: number;
  /** Width of the arena wall line, world units. */
  readonly borderWidth: number;
  readonly glowOpacity: number;
}

export const DEFAULT_BACKGROUND: BackgroundOptions = {
  cellSize: 2.1,
  dotRadius: 0.1,
  borderWidth: 0.35,
  glowOpacity: 0.2,
};

const GRID_TEXTURE_PX = 64;
const GLOW_WIDTH_MULTIPLIER = 4;
const HUE_SPEED = 0.12; // hue turns per second

/**
 * Black backdrop, tiled dot grid clipped to the arena disc, and a wall that slowly cycles
 * through hues. Ported from ZeroSnake's rectangular arena to the circular one.
 */
export class BackgroundRenderer {
  private grid: Mesh<CircleGeometry, MeshBasicMaterial> | undefined;
  private border: Mesh<RingGeometry, MeshBasicMaterial> | undefined;
  private glow: Mesh<RingGeometry, MeshBasicMaterial> | undefined;
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

    const glowWidth = borderWidth * GLOW_WIDTH_MULTIPLIER;
    this.glow = new Mesh(
      new RingGeometry(radius - glowWidth, radius + borderWidth + glowWidth, 256),
      new MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: glowOpacity,
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
    this.glow?.material.color.setHSL(this.hue, 1, 0.75);
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
      mesh.material.map?.dispose();
      mesh.material.dispose();
    }
    this.grid = this.border = this.glow = undefined;
  }
}
