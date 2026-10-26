import {
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type Scene,
} from "three";
import { type InterpolatedSnake, interpolateSnake, resamplePolyline } from "../interpolate";
import { resolveSkin, type SkinDefinition, type SkinTextures, SNAKE_PALETTE } from "../skins";
import type { RenderSnake } from "../types";
import { hashString } from "../util";

export interface SnakeView {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly length: number;
}

interface SnakeEntry {
  body: InstancedMesh<PlaneGeometry, MeshBasicMaterial>;
  readonly head: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly tail: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly state: InterpolatedSnake;
  skinKey: string;
  /** Interpolated head position and size, for the camera and the food renderer. */
  view: SnakeView;
}

const INITIAL_BODY_CAPACITY = 64;
const RENDER_ORDER_STRIDE = 3;

/**
 * Snakes as textured squares, ported from ZeroSnake's PlayerRenderer. Instead of one mesh per
 * segment, each snake gets an instanced body plus a head and a tail mesh. Engine segments are
 * blended between ticks and resampled at a fixed spacing, so the look doesn't depend on how
 * densely the engine samples the body.
 */
export class SnakeRenderer {
  private readonly snakes = new Map<string, SnakeEntry>();
  private readonly materials = new Map<string, MeshBasicMaterial>();
  private readonly geometry = new PlaneGeometry(1, 1);
  private readonly prevById = new Map<string, RenderSnake>();
  private readonly seen = new Set<string>();
  private readonly resampled: number[] = [];
  private readonly heads: number[] = [];
  private readonly matrix = new Matrix4();

  constructor(
    private readonly scene: Scene,
    private readonly textures: SkinTextures,
    /** Distance between drawn body circles, in snake radii. */
    private readonly segmentSpacing: number,
  ) {}

  /** Draws snakes blended between two ticks. `onTop` is drawn above everyone else. */
  update(
    prev: readonly RenderSnake[],
    next: readonly RenderSnake[],
    alpha: number,
    onTop?: string,
  ): void {
    this.prevById.clear();
    for (const s of prev) this.prevById.set(s.id, s);
    this.seen.clear();
    this.heads.length = 0;

    next.forEach((snake, index) => {
      if (snake.segments.length === 0) return;
      this.seen.add(snake.id);
      const entry = this.entryFor(snake);
      const state = interpolateSnake(this.prevById.get(snake.id), snake, alpha, entry.state);
      const order = (snake.id === onTop ? next.length : index) * RENDER_ORDER_STRIDE;
      this.draw(entry, state, resolveSkin(snake.skin?.id), order);
      this.heads.push(entry.view.x, entry.view.y);
    });

    for (const id of this.snakes.keys()) if (!this.seen.has(id)) this.remove(id);
  }

  /** Interpolated head of a snake drawn in the last `update`. */
  view(id: string): SnakeView | undefined {
    return this.seen.has(id) ? this.snakes.get(id)?.view : undefined;
  }

  /** Flat `[x, y, ...]` of every head drawn in the last `update`. */
  headPositions(): readonly number[] {
    return this.heads;
  }

  destroy(): void {
    for (const id of [...this.snakes.keys()]) this.remove(id);
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    this.geometry.dispose();
  }

  private draw(
    entry: SnakeEntry,
    state: InterpolatedSnake,
    skin: SkinDefinition,
    order: number,
  ): void {
    const { radius } = state;
    const side = radius * 2 * skin.planeScale;
    const count = resamplePolyline(state.points, radius * this.segmentSpacing, this.resampled);
    const pts = this.resampled;
    const hx = pts[0] as number;
    const hy = pts[1] as number;
    entry.view = { x: hx, y: hy, radius, length: state.length };

    // Head: the SVG's eyes point up (+y), so rotate +y onto the heading.
    entry.head.position.set(hx, hy, 0);
    entry.head.rotation.z = state.angle - Math.PI / 2;
    entry.head.scale.set(side, side, 1);
    entry.head.renderOrder = order + 2;

    // Tail: last point, tip (-y in the SVG) pointing away from the body.
    const tailVisible = count > 1;
    entry.tail.visible = tailVisible;
    if (tailVisible) {
      const tx = pts[2 * count - 2] as number;
      const ty = pts[2 * count - 1] as number;
      const px = pts[2 * count - 4] as number;
      const py = pts[2 * count - 3] as number;
      entry.tail.position.set(tx, ty, 0);
      entry.tail.rotation.z = Math.atan2(ty - py, tx - px) + Math.PI / 2;
      entry.tail.scale.set(side, side, 1);
      entry.tail.renderOrder = order;
    }

    // Body: points between head and tail, tail end first so segments nearer the head
    // overlap the ones behind them.
    const bodyCount = Math.max(0, count - 2);
    const body = this.ensureBodyCapacity(entry, bodyCount);
    for (let j = 0; j < bodyCount; j++) {
      const k = count - 2 - j;
      this.matrix
        .makeScale(side, side, 1)
        .setPosition(pts[2 * k] as number, pts[2 * k + 1] as number, 0);
      body.setMatrixAt(j, this.matrix);
    }
    body.count = bodyCount;
    body.instanceMatrix.needsUpdate = true;
    body.renderOrder = order + 1;
  }

  private entryFor(snake: RenderSnake): SnakeEntry {
    const skin = resolveSkin(snake.skin?.id);
    const color =
      snake.skin?.color ?? (SNAKE_PALETTE[hashString(snake.id) % SNAKE_PALETTE.length] as string);
    const skinKey = `${skin.id}|${color}`;
    const existing = this.snakes.get(snake.id);
    if (existing && existing.skinKey === skinKey) return existing;

    const head = new Mesh(this.geometry, this.material(skin.head.svg, color));
    const tail = new Mesh(this.geometry, this.material(skin.tail.svg, color));
    const body = this.createBody(this.material(skin.body.svg, color), INITIAL_BODY_CAPACITY);
    const state = existing?.state ?? { points: [], angle: 0, radius: 1, length: 0 };
    if (existing) this.remove(snake.id);

    const entry: SnakeEntry = {
      body,
      head,
      tail,
      state,
      skinKey,
      view: { x: 0, y: 0, radius: 1, length: 0 },
    };
    this.scene.add(body, tail, head);
    this.snakes.set(snake.id, entry);
    return entry;
  }

  private ensureBodyCapacity(
    entry: SnakeEntry,
    n: number,
  ): InstancedMesh<PlaneGeometry, MeshBasicMaterial> {
    if (n <= entry.body.instanceMatrix.count) return entry.body;
    let capacity = entry.body.instanceMatrix.count;
    while (capacity < n) capacity *= 2;
    this.scene.remove(entry.body);
    entry.body.dispose();
    const body = this.createBody(entry.body.material, capacity);
    entry.body = body;
    this.scene.add(body);
    return body;
  }

  private createBody(
    material: MeshBasicMaterial,
    capacity: number,
  ): InstancedMesh<PlaneGeometry, MeshBasicMaterial> {
    const body = new InstancedMesh(this.geometry, material, capacity);
    body.instanceMatrix.setUsage(DynamicDrawUsage);
    body.frustumCulled = false;
    body.count = 0;
    return body;
  }

  /** Materials are shared by every snake with the same part and colour. */
  private material(svg: string, color: string): MeshBasicMaterial {
    const key = `${color}|${svg}`;
    let material = this.materials.get(key);
    if (!material) {
      material = new MeshBasicMaterial({
        map: this.textures.get(svg, color),
        transparent: true,
        depthWrite: false,
        depthTest: false,
      });
      this.materials.set(key, material);
    }
    return material;
  }

  private remove(id: string): void {
    const entry = this.snakes.get(id);
    if (!entry) return;
    this.scene.remove(entry.body, entry.head, entry.tail);
    entry.body.dispose();
    this.snakes.delete(id);
  }
}
