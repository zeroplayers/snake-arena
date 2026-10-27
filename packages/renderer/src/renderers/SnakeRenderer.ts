import {
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type Scene,
} from "three";
import {
  type InterpolatedSnake,
  interpolateSnake,
  lerpAngle,
  pointFromEnd,
  resamplePolyline,
  snakeRadius,
} from "../interpolate.ts";
import {
  resolveSkin,
  type SkinDefinition,
  type SkinTextures,
  SNAKE_PALETTE,
} from "../skins/index.ts";
import type { RenderSnake } from "../types.ts";
import { hashString } from "../util.ts";

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
/** The tail is aimed from this many body spacings up the body. */
const TAIL_AIM = 2;

/**
 * Snakes as textured squares, ported from ZeroSnake's PlayerRenderer. Instead of one mesh per
 * segment, each snake gets an instanced body plus a head and a tail mesh. The body is blended
 * between ticks along its path and resampled at a fixed spacing from the head, with the tail at
 * the body's exact end, so the look doesn't depend on how densely the engine samples the body.
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
  private readonly behindTail = { x: 0, y: 0 };
  private readonly flat: number[] = [];
  /** Direction the tail points on each tick's snake. */
  private readonly tailAngles = new WeakMap<RenderSnake, number>();

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
      const before = this.prevById.get(snake.id);
      const state = interpolateSnake(before, snake, alpha, entry.state);
      const tailAngle =
        before && state.blended
          ? lerpAngle(this.tailAngle(before), this.tailAngle(snake), alpha)
          : this.tailAngle(snake);
      const order = (snake.id === onTop ? next.length : index) * RENDER_ORDER_STRIDE;
      this.draw(entry, state, tailAngle, resolveSkin(snake.skin?.id), order);
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

  /**
   * The tail of one tick's snake points away from the body a few spacings up it. Blending this
   * between ticks turns the tail evenly; aiming it on the blended path instead makes it step
   * whenever the aim point passes a corner of the engine's polyline.
   */
  private tailAngle(snake: RenderSnake): number {
    let angle = this.tailAngles.get(snake);
    if (angle !== undefined) return angle;
    const flat = this.flat;
    flat.length = 0;
    for (const s of snake.segments) flat.push(s.x, s.y);
    const tx = flat[flat.length - 2] ?? 0;
    const ty = flat[flat.length - 1] ?? 0;
    const behind = this.behindTail;
    pointFromEnd(flat, TAIL_AIM * snakeRadius(snake) * this.segmentSpacing, behind);
    angle =
      behind.x === tx && behind.y === ty
        ? snake.angle + Math.PI
        : Math.atan2(ty - behind.y, tx - behind.x);
    this.tailAngles.set(snake, angle);
    return angle;
  }

  private draw(
    entry: SnakeEntry,
    state: InterpolatedSnake,
    tailAngle: number,
    skin: SkinDefinition,
    order: number,
  ): void {
    const { radius } = state;
    const side = radius * 2 * skin.planeScale;
    const spacing = radius * this.segmentSpacing;
    const count = resamplePolyline(state.points, spacing, this.resampled, state.bodyLength);
    const pts = this.resampled;
    const hx = pts[0] as number;
    const hy = pts[1] as number;
    entry.view = { x: hx, y: hy, radius, length: state.length };

    // Head: the SVG's eyes point up (+y), so rotate +y onto the heading.
    entry.head.position.set(hx, hy, 0);
    entry.head.rotation.z = state.angle - Math.PI / 2;
    entry.head.scale.set(side, side, 1);
    entry.head.renderOrder = order + 2;

    // Tail: last point, tip (-y in the SVG) pointing away from the body. Drawn over the body,
    // so a body point that appears as the snake grows comes out from under it.
    const tailVisible = count > 1;
    entry.tail.visible = tailVisible;
    if (tailVisible) {
      entry.tail.position.set(pts[2 * count - 2] as number, pts[2 * count - 1] as number, 0);
      entry.tail.rotation.z = tailAngle + Math.PI / 2;
      entry.tail.scale.set(side, side, 1);
      entry.tail.renderOrder = order + 1;
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
    body.renderOrder = order;
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
    const state = existing?.state ?? {
      points: [],
      pathLength: 0,
      bodyLength: 0,
      blended: false,
      angle: 0,
      radius: 1,
      length: 0,
    };
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
