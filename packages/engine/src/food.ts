import { cos, sin, TAU } from "./math";
import type { Rng } from "./rng";
import type { Food, FoodKind, World } from "./types";

/**
 * Food storage. `world.food` is the source of truth; alongside it the engine keeps a spatial
 * index that is updated incrementally (pellets are added and eaten a few at a time, while
 * there may be thousands lying around). The index is a cache keyed by the world object and
 * checked against the array, its length and `nextFoodId` before use; a cloned or deserialised
 * world, or one whose food was edited by hand, just gets a fresh index. Results never depend on
 * the index's internal order.
 */
class FoodIndex {
  readonly cellSize: number;
  readonly cols: number;
  private readonly origin: number;
  readonly cells: (Food[] | undefined)[];
  /** Position of each pellet in `world.food`. */
  readonly slot = new Map<Food, number>();
  array: Food[];
  length: number;
  nextId: number;

  constructor(world: World) {
    const { arenaRadius, gridCellSize } = world.config;
    this.cellSize = gridCellSize;
    this.origin = arenaRadius + gridCellSize;
    this.cols = Math.max(1, Math.ceil((2 * this.origin) / gridCellSize));
    this.cells = new Array(this.cols * this.cols);
    this.array = world.food;
    this.length = world.food.length;
    this.nextId = world.nextFoodId;
    for (let i = 0; i < world.food.length; i++) this.insert(world.food[i] as Food, i);
  }

  col(v: number): number {
    const c = Math.floor((v + this.origin) / this.cellSize);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  private cell(f: Food): number {
    return this.col(f.y) * this.cols + this.col(f.x);
  }

  insert(f: Food, at: number): void {
    const k = this.cell(f);
    const bucket = this.cells[k];
    if (bucket) bucket.push(f);
    else this.cells[k] = [f];
    this.slot.set(f, at);
  }

  remove(f: Food): void {
    const bucket = this.cells[this.cell(f)] as Food[];
    const i = bucket.indexOf(f);
    bucket[i] = bucket[bucket.length - 1] as Food;
    bucket.pop();
    this.slot.delete(f);
  }

  sync(world: World): void {
    this.array = world.food;
    this.length = world.food.length;
    this.nextId = world.nextFoodId;
  }

  isValidFor(world: World): boolean {
    return (
      this.array === world.food &&
      this.length === world.food.length &&
      this.nextId === world.nextFoodId
    );
  }
}

export type { FoodIndex };

const indexes = new WeakMap<World, FoodIndex>();

/** The world's food index, rebuilt if anything changed behind the engine's back. */
export function foodIndex(world: World): FoodIndex {
  let index = indexes.get(world);
  if (!index?.isValidFor(world)) {
    index = new FoodIndex(world);
    indexes.set(world, index);
  }
  return index;
}

function liveIndex(world: World): FoodIndex | undefined {
  const index = indexes.get(world);
  if (index && !index.isValidFor(world)) {
    indexes.delete(world);
    return undefined;
  }
  return index;
}

export function addFood(world: World, x: number, y: number, value: number, kind: FoodKind): Food {
  const index = liveIndex(world);
  const food: Food = { id: world.nextFoodId++, x, y, value, kind };
  world.food.push(food);
  if (index) {
    index.insert(food, world.food.length - 1);
    index.sync(world);
  }
  return food;
}

/** Removes pellets by position in `world.food`; `slots` must be sorted ascending. */
export function removeFood(world: World, slots: readonly number[]): void {
  const index = liveIndex(world);
  const food = world.food;
  for (let q = slots.length - 1; q >= 0; q--) {
    const k = slots[q] as number;
    const gone = food[k] as Food;
    const last = food.pop() as Food;
    index?.remove(gone);
    if (k < food.length) {
      food[k] = last;
      index?.slot.set(last, k);
    }
  }
  index?.sync(world);
}

/** One ambient pellet uniformly inside the arena (slightly in from the wall). */
export function spawnAmbientFood(world: World, rng: Rng): Food {
  const r = world.config.arenaRadius * 0.98 * Math.sqrt(rng.next());
  const theta = rng.next() * TAU;
  return addFood(world, r * cos(theta), r * sin(theta), world.config.foodValue, "ambient");
}
