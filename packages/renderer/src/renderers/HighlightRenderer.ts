import { CircleGeometry, Mesh, MeshBasicMaterial, RingGeometry, type Scene } from "three";
import type { Highlight } from "../types.ts";

const FILL_OPACITY = 0.07;
const RING_OPACITY = 0.55;
/** Ring width as a fraction of the highlight radius. */
const RING_WIDTH = 0.012;

/**
 * A translucent disc with an outline around one snake's head, e.g. its vision radius. Drawn
 * above the arena floor and below food and snakes.
 */
export class HighlightRenderer {
  private readonly fill: Mesh<CircleGeometry, MeshBasicMaterial>;
  private readonly ring: Mesh<RingGeometry, MeshBasicMaterial>;

  constructor(private readonly scene: Scene) {
    this.fill = new Mesh(
      new CircleGeometry(1, 128),
      new MeshBasicMaterial({ transparent: true, opacity: FILL_OPACITY, depthWrite: false }),
    );
    this.fill.renderOrder = -5;
    this.ring = new Mesh(
      new RingGeometry(1 - RING_WIDTH, 1, 128),
      new MeshBasicMaterial({ transparent: true, opacity: RING_OPACITY, depthWrite: false }),
    );
    this.ring.renderOrder = -4;
    this.hide();
    scene.add(this.fill, this.ring);
  }

  /** Centres the highlight on `at`, or hides it when there is nothing to show. */
  update(highlight: Highlight | undefined, at: { x: number; y: number } | undefined): void {
    if (!highlight || !at || !(highlight.radius > 0)) {
      this.hide();
      return;
    }
    const color = highlight.color ?? "#ffffff";
    for (const mesh of [this.fill, this.ring]) {
      mesh.visible = true;
      mesh.position.set(at.x, at.y, 0);
      mesh.scale.set(highlight.radius, highlight.radius, 1);
      mesh.material.color.set(color);
    }
  }

  destroy(): void {
    this.scene.remove(this.fill, this.ring);
    for (const mesh of [this.fill, this.ring]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }

  private hide(): void {
    this.fill.visible = false;
    this.ring.visible = false;
  }
}
