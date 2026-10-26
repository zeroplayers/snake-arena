import {
  AdditiveBlending,
  CircleGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  type Scene,
} from "three";
import { lerp } from "../interpolate.ts";
import { type SkinTextures, SVG_PADDING } from "../skins/index.ts";
import { GLOW_SVG } from "../skins/svg.ts";
import type { RenderFood } from "../types.ts";
import { hashString } from "../util.ts";

const FOOD_COLORS = ["#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF", "#FFA500"];

/** Glow square side relative to the food radius (the original's 6× base size, padded). */
const GLOW_SIZE_MULTIPLIER = 6 * SVG_PADDING;
const GLOW_OPACITY = 0.75;
const PULSE_AMPLITUDE = 0.08;
const PULSE_SPEED = 3; // rad/s

type FoodKey = string | number;

/**
 * Food as two instanced meshes: a solid dot and an additive halo. With food ids it also
 * animates between ticks: new food grows in, eaten food shrinks into the nearest head.
 */
export class FoodRenderer {
  private core: InstancedMesh<CircleGeometry, MeshBasicMaterial>;
  private glow: InstancedMesh<PlaneGeometry, MeshBasicMaterial>;
  private capacity = 0;
  private time = 0;
  private readonly matrix = new Matrix4();
  private readonly color = new Color();
  private readonly prevById = new Map<FoodKey, RenderFood>();

  constructor(
    private readonly scene: Scene,
    private readonly textures: SkinTextures,
  ) {
    [this.core, this.glow] = this.createMeshes(256);
  }

  /**
   * Draws food blended between two ticks. `heads` are the interpolated snake heads, flat
   * `[x, y, ...]`, used as targets for eaten food.
   */
  update(
    prev: readonly RenderFood[],
    next: readonly RenderFood[],
    alpha: number,
    heads: readonly number[],
    dt: number,
  ): void {
    this.time += dt;
    this.ensureCapacity(prev.length + next.length);

    const prevById = this.prevById;
    prevById.clear();
    for (const f of prev) if (f.id !== undefined) prevById.set(f.id, f);

    let n = 0;
    for (const f of next) {
      const before = f.id === undefined ? undefined : prevById.get(f.id);
      if (before) {
        prevById.delete(before.id as FoodKey);
        this.write(n++, f, lerp(before.x, f.x, alpha), lerp(before.y, f.y, alpha), 1);
      } else {
        // Appeared this tick (or no ids to tell): grow in only when we can tell.
        const grow = f.id === undefined || prev.length === 0 ? 1 : alpha;
        this.write(n++, f, f.x, f.y, grow);
      }
    }
    // Whatever is left in prevById was eaten (or decayed) during this tick.
    for (const f of prevById.values()) {
      const head = nearestHead(heads, f.x, f.y, f.size * 12);
      const x = head ? lerp(f.x, head[0], alpha) : f.x;
      const y = head ? lerp(f.y, head[1], alpha) : f.y;
      this.write(n++, f, x, y, 1 - alpha);
    }

    this.core.count = n;
    this.glow.count = n;
    for (const mesh of [this.core, this.glow]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  destroy(): void {
    this.disposeMeshes();
  }

  private write(i: number, f: RenderFood, x: number, y: number, scale: number): void {
    const phase = hashString(String(f.id ?? i));
    const pulse = 1 + PULSE_AMPLITUDE * Math.sin(this.time * PULSE_SPEED + phase);
    const r = f.size * scale * pulse;

    this.color.set(f.color ?? (FOOD_COLORS[phase % FOOD_COLORS.length] as string));
    this.matrix.makeScale(r, r, 1).setPosition(x, y, -0.1);
    this.core.setMatrixAt(i, this.matrix);
    this.core.setColorAt(i, this.color);

    const g = r * GLOW_SIZE_MULTIPLIER;
    this.matrix.makeScale(g, g, 1).setPosition(x, y, -0.11);
    this.glow.setMatrixAt(i, this.matrix);
    this.glow.setColorAt(i, this.color);
  }

  private ensureCapacity(n: number): void {
    if (n <= this.capacity) return;
    this.disposeMeshes();
    let capacity = this.capacity;
    while (capacity < n) capacity *= 2;
    [this.core, this.glow] = this.createMeshes(capacity);
  }

  private createMeshes(
    capacity: number,
  ): [
    InstancedMesh<CircleGeometry, MeshBasicMaterial>,
    InstancedMesh<PlaneGeometry, MeshBasicMaterial>,
  ] {
    this.capacity = capacity;
    const core = new InstancedMesh(
      new CircleGeometry(1, 20),
      new MeshBasicMaterial({ transparent: true, depthWrite: false }),
      capacity,
    );
    const glow = new InstancedMesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({
        map: this.textures.get(GLOW_SVG, undefined),
        transparent: true,
        opacity: GLOW_OPACITY,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
      capacity,
    );
    for (const mesh of [core, glow]) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false; // instances span the arena; the bounding sphere would go stale
      mesh.count = 0;
      this.scene.add(mesh);
    }
    core.renderOrder = -1;
    glow.renderOrder = -2;
    return [core, glow];
  }

  private disposeMeshes(): void {
    for (const mesh of [this.core, this.glow]) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose(); // the glow texture belongs to SkinTextures
      mesh.dispose();
    }
  }
}

function nearestHead(
  heads: readonly number[],
  x: number,
  y: number,
  maxDist: number,
): [number, number] | undefined {
  let best: [number, number] | undefined;
  let bestD = maxDist * maxDist;
  for (let i = 0; i + 1 < heads.length; i += 2) {
    const hx = heads[i] as number;
    const hy = heads[i + 1] as number;
    const d = (hx - x) ** 2 + (hy - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = [hx, hy];
    }
  }
  return best;
}
