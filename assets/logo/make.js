// Renders the Sharelsen logo variants from one SVG definition.
// Concept: a photo (card with sun and mountains) with an upload badge rising off its corner.
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const BLUE = "#208AEF";
const WHITE = "#FFFFFF";
const OUT = process.argv[2] || ".";

/**
 * Artwork in a 1024x1024 coordinate space, designed to sit inside the adaptive-icon safe
 * zone (central ~66%) so nothing is clipped by circular launcher masks.
 * `ink` is the colour of the "paper" shapes, `hole` the colour of details cut into them.
 */
function artwork(ink, hole) {
  return `
    <!-- photo card -->
    <rect x="262" y="332" width="500" height="400" rx="60" fill="${ink}"/>
    <!-- picture area inset from the card so a white frame shows on every side -->
    <clipPath id="picture"><rect x="296" y="366" width="432" height="332" rx="36"/></clipPath>
    <g clip-path="url(#picture)">
      <!-- sun -->
      <circle cx="632" cy="446" r="42" fill="${hole}"/>
      <!-- mountains -->
      <path d="M296 720 L296 630 L410 520 L505 600 L575 545 L728 665 L728 720 Z" fill="${hole}"/>
    </g>
    <!-- upload badge overlapping the card's top-left corner -->
    <circle cx="300" cy="330" r="150" fill="${hole}"/>
    <circle cx="300" cy="330" r="118" fill="${ink}"/>
    <!-- up arrow -->
    <path d="M300 250 L370 320 L328 320 L328 410 L272 410 L272 320 L230 320 Z" fill="${hole}"/>
  `;
}

function svg({ size, background, ink, hole, scale = 1, radius = 0 }) {
  const s = 1024 * scale;
  const offset = (1024 - s) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
    ${background ? `<rect width="1024" height="1024" rx="${radius}" fill="${background}"/>` : ""}
    <g transform="translate(${offset} ${offset}) scale(${scale})">${artwork(ink, hole)}</g>
  </svg>`;
}

async function render(name, opts, trim = false) {
  let img = sharp(Buffer.from(svg(opts)), { density: 300 });
  if (trim) {
    // Trim to the artwork, then normalise its width for the splash screen.
    const trimmed = await img.trim().png().toBuffer();
    img = sharp(trimmed).resize({ width: 480 });
  } else {
    img = img.resize(opts.size, opts.size);
  }
  await img.png().toFile(path.join(OUT, name));
  const meta = await sharp(path.join(OUT, name)).metadata();
  console.log(name, meta.width, "x", meta.height);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // Plain app icon: full-bleed blue, artwork slightly larger since no launcher mask applies.
  await render("icon.png", { size: 1024, background: BLUE, ink: WHITE, hole: BLUE, scale: 1.12 });
  // Adaptive icon foreground: transparent background, artwork inside the safe zone.
  await render("android-icon-foreground.png", { size: 1024, background: null, ink: WHITE, hole: "rgba(0,0,0,0)", scale: 0.92 });
  // Monochrome (themed icons): single-colour alpha mask, same geometry.
  await render("android-icon-monochrome.png", { size: 1024, background: null, ink: WHITE, hole: "rgba(0,0,0,0)", scale: 0.92 });
  // Splash: the artwork alone, trimmed, shown on the blue splash background.
  await render("splash-icon.png", { size: 1024, background: null, ink: WHITE, hole: "rgba(0,0,0,0)", scale: 1 }, true);
  // Preview for review: icon as it would look in a circular launcher mask, plus splash mock.
  const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="520" viewBox="0 0 1400 520">
    <rect width="1400" height="520" fill="#F5F7FA"/>
    <clipPath id="c"><circle cx="260" cy="260" r="200"/></clipPath>
    <g clip-path="url(#c)"><rect x="60" y="60" width="400" height="400" fill="${BLUE}"/>
      <g transform="translate(60 60) scale(0.390625)"><g transform="translate(40 40) scale(0.92)">${artwork(WHITE, BLUE)}</g></g></g>
    <clipPath id="sq"><rect x="560" y="60" width="400" height="400" rx="90"/></clipPath>
    <g clip-path="url(#sq)"><rect x="560" y="60" width="400" height="400" fill="${BLUE}"/>
      <g transform="translate(560 60) scale(0.390625)"><g transform="translate(-61 -61) scale(1.12)">${artwork(WHITE, BLUE)}</g></g></g>
    <rect x="1060" y="60" width="280" height="400" rx="30" fill="${BLUE}"/>
    <g transform="translate(1130 190) scale(0.14)">${artwork(WHITE, BLUE)}</g>
  </svg>`;
  await sharp(Buffer.from(preview)).png().toFile(path.join(OUT, "preview.png"));
  console.log("preview.png written");
  // Editable vector source of the full icon, kept in the repo.
  fs.writeFileSync(path.join(OUT, "logo.svg"), svg({ size: 1024, background: BLUE, ink: WHITE, hole: BLUE, scale: 1.12, radius: 180 }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
