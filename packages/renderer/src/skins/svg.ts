// Default ZeroSnake skin, ported from zerosnake/frontend/public/assets/skins/skin_default.
// Inlined so the package needs no asset pipeline. Stops with id="changeableOuterColor"
// are recoloured per snake (see textures.ts).

export const DEFAULT_HEAD_SVG = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
<defs>
  <radialGradient id="paint0_radial_219_39" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(512 512) rotate(90) scale(352)">
    <stop stop-color="#010101"/>
    <stop id="changeableOuterColor" offset="1" stop-color="#F1F1F1" stop-opacity="0.866667"/>
  </radialGradient>
  <radialGradient id="paint1_radial_219_39" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(294.5 164.5) rotate(90) scale(135 134.5)">
    <stop offset="0.03" stop-color="#010101"/>
    <stop id="changeableOuterColor" offset="0.93" stop-color="#F1F1F1"/>
  </radialGradient>
  <radialGradient id="paint2_radial_219_39" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(729.5 164.5) rotate(90) scale(135 134.5)">
    <stop offset="0.03" stop-color="#010101"/>
    <stop id="changeableOuterColor" offset="0.93" stop-color="#F1F1F1"/>
  </radialGradient>
  <filter id="glowEffect" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="150" result="coloredBlur"/>
  </filter>
</defs>

<!-- Glow Paths -->
<path d="M864 512C864 706.404 706.404 864 512 864C317.596 864 160 706.404 160 512C160 317.596 317.596 160 512 160C706.404 160 864 317.596 864 512Z"
      fill="url(#paint0_radial_219_39)"
      filter="url(#glowEffect)"/>
<path d="M429 250C429 324.559 368.782 385 294.5 385C220.218 385 160 324.559 160 250C160 175.442 220.218 115 294.5 115C368.782 115 429 175.442 429 250Z"
      fill="url(#paint1_radial_219_39)"
      filter="url(#glowEffect)"/>
<path d="M864 250C864 324.559 803.782 385 729.5 385C655.218 385 595 324.559 595 250C595 175.442 655.218 115 729.5 115C803.782 115 864 175.442 864 250Z"
      fill="url(#paint2_radial_219_39)"
      filter="url(#glowEffect)"/>

<!-- Main Paths -->
<path d="M864 512C864 706.404 706.404 864 512 864C317.596 864 160 706.404 160 512C160 317.596 317.596 160 512 160C706.404 160 864 317.596 864 512Z"
      fill="url(#paint0_radial_219_39)"
      stroke="white" stroke-width="30"/>
<path d="M429 250C429 324.559 368.782 385 294.5 385C220.218 385 160 324.559 160 250C160 175.442 220.218 115 294.5 115C368.782 115 429 175.442 429 250Z"
      fill="url(#paint1_radial_219_39)"
      stroke="white" stroke-width="30"/>
<path d="M864 250C864 324.559 803.782 385 729.5 385C655.218 385 595 324.559 595 250C595 175.442 655.218 115 729.5 115C803.782 115 864 175.442 864 250Z"
      fill="url(#paint2_radial_219_39)"
      stroke="white" stroke-width="30"/>
</svg>`;

export const DEFAULT_BODY_SVG = `<svg width="1023" height="1024" viewBox="0 0 1023 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
<defs>
  <radialGradient id="paint0_radial_219_36" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(511.5 512) rotate(90) scale(352 351.5)">
    <stop stop-color="#010101"/>
    <stop id="changeableOuterColor" offset="1" stop-color="#F1F1F1" stop-opacity="0.866667"/>
  </radialGradient>
  <filter id="glowEffect" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="100" result="coloredBlur"/>
  </filter>
</defs>
<!-- Glow Path -->
<path d="M863 512C863 706.404 705.628 864 511.5 864C317.372 864 160 706.404 160 512C160 317.596 317.372 160 511.5 160C705.628 160 863 317.596 863 512Z"
      fill="url(#paint0_radial_219_36)"
      filter="url(#glowEffect)"
      />
<!-- Main Body Path -->
<path d="M863 512C863 706.404 705.628 864 511.5 864C317.372 864 160 706.404 160 512C160 317.596 317.372 160 511.5 160C705.628 160 863 317.596 863 512Z"
      fill="url(#paint0_radial_219_36)"
      stroke="white"
      stroke-width="30"/>
</svg>`;

export const DEFAULT_TAIL_SVG = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
<defs>
  <radialGradient id="paint0_radial_219_32" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(513 512) rotate(-90) scale(193.5 193.5)">
    <stop stop-color="#010101"/>
    <stop id="changeableOuterColor" offset="1" stop-color="#F1F1F1" stop-opacity="0.866667"/>
  </radialGradient>
  <filter id="glowEffect" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="150" result="coloredBlur"/>
  </filter>
</defs>

<!-- Glow Path (from the main filled shape) -->
<path d="M581.782 844C550.99 897.333 474.01 897.333 443.218 844L190.772 406.75C159.98 353.417 198.47 286.75 260.054 286.75L764.947 286.75C826.531 286.75 865.02 353.417 834.228 406.75L581.782 844Z"
      fill="url(#paint0_radial_219_32)"
      filter="url(#glowEffect)"/>

<!-- Main Filled Shape -->
<path d="M581.782 844C550.99 897.333 474.01 897.333 443.218 844L190.772 406.75C159.98 353.417 198.47 286.75 260.054 286.75L764.947 286.75C826.531 286.75 865.02 353.417 834.228 406.75L581.782 844Z"
      fill="url(#paint0_radial_219_32)"/>
<!-- Stroke Path (rendered on top) -->
<path d="M568.792 836.5C543.773 879.833 481.227 879.833 456.208 836.5L203.762 399.25C178.743 355.917 210.017 301.75 260.054 301.75L764.947 301.75C814.984 301.75 846.257 355.917 821.238 399.25L568.792 836.5Z"
      stroke="white"
      stroke-width="30"/>
</svg>`;

// Soft halo behind food, from zerosnake/frontend/public/assets/glow.svg.
export const GLOW_SVG = `<svg width="1023" height="1024" viewBox="0 0 1023 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
<defs>
  <radialGradient id="paint0_radial_219_36" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(511.5 512) rotate(90) scale(352 351.5)">
    <stop stop-color="#010101"/>
    <stop id="changeableOuterColor" offset="1" stop-color="#F1F1F1" stop-opacity="0.866667"/>
  </radialGradient>
  <filter id="glowEffect" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="100" result="coloredBlur"/>
  </filter>
</defs>
<!-- Glow Path -->
<path d="M863 512C863 706.404 705.628 864 511.5 864C317.372 864 160 706.404 160 512C160 317.596 317.372 160 511.5 160C705.628 160 863 317.596 863 512Z"
      fill="url(#paint0_radial_219_36)"
      filter="url(#glowEffect)"
      />
</svg>`;
