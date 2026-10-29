import { PRODUCT_HUNT } from "../../site";

/**
 * Product Hunt's badge with a snake circling it: a string of the arena's green beads running
 * round it, a bigger, brighter one for its head. It stands still for reduced motion.
 */
export function ProductHuntBadge() {
  return (
    <a
      href={PRODUCT_HUNT.url}
      className="ph-badge"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="ZeroSnake Arena on Product Hunt"
    >
      <img src={PRODUCT_HUNT.badge} alt="" width={250} height={54} />
      <svg className="ph-snake" viewBox="0 0 264 68" aria-hidden="true">
        <rect
          className="ph-snake-body"
          x="3.5"
          y="3.5"
          width="257"
          height="61"
          rx="13.5"
          pathLength="100"
        />
        <rect
          className="ph-snake-head"
          x="3.5"
          y="3.5"
          width="257"
          height="61"
          rx="13.5"
          pathLength="100"
        />
      </svg>
    </a>
  );
}
