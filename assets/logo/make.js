// Renders the Sharelsen logo variants from one SVG definition.
// Concept: a photo (white card) of a black-and-brown dog in a sunny field, with an upload
// badge rising off the card's corner, on a warm gradient background.
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const OUT = process.argv[2] || ".";

const C = {
  gradientA: "#FFB347", // amber
  gradientB: "#FF5E8A", // pink
  gradientC: "#8E5CFF", // violet
  splashSolid: "#FF7A66", // solid stand-in for the gradient (splash background)
  card: "#FFFFFF",
  sky: "#BDE6FF",
  sun: "#FFD23F",
  grass: "#5CC96A",
  grassDark: "#3FAE52",
  dogBlack: "#242424",
  dogBrown: "#A9622D",
  eyeWhite: "#FFFFFF",
  nose: "#111111",
  tongue: "#FF7B9C",
  collar: "#E63946",
  tag: "#FFD23F",
  badge: "#2E7DFF",
  arrow: "#FFFFFF",
};

/** Full-colour artwork in a 1024 space, inside the adaptive-icon safe zone. */
function artwork() {
  return `
    <!-- photo card -->
    <rect x="262" y="332" width="500" height="400" rx="60" fill="${C.card}"/>
    <clipPath id="picture"><rect x="296" y="366" width="432" height="332" rx="36"/></clipPath>
    <g clip-path="url(#picture)">
      <rect x="296" y="366" width="432" height="332" fill="${C.sky}"/>
      <circle cx="660" cy="430" r="40" fill="${C.sun}"/>
      <path d="M296 700 L296 640 Q400 600 512 640 Q624 680 728 630 L728 700 Z" fill="${C.grassDark}"/>
      <path d="M296 700 L296 660 Q420 620 512 660 Q620 700 728 655 L728 700 Z" fill="${C.grass}"/>
      <g transform="translate(512 540) scale(1.12) translate(-512 -545)">
        <!-- ears -->
        <ellipse cx="398" cy="540" rx="48" ry="100" transform="rotate(18 398 540)" fill="${C.dogBlack}"/>
        <ellipse cx="626" cy="540" rx="48" ry="100" transform="rotate(-18 626 540)" fill="${C.dogBlack}"/>
        <!-- head -->
        <ellipse cx="512" cy="545" rx="118" ry="112" fill="${C.dogBlack}"/>
        <!-- brown markings: eyebrows, muzzle -->
        <ellipse cx="466" cy="490" rx="26" ry="14" fill="${C.dogBrown}"/>
        <ellipse cx="558" cy="490" rx="26" ry="14" fill="${C.dogBrown}"/>
        <ellipse cx="512" cy="600" rx="66" ry="48" fill="${C.dogBrown}"/>
        <!-- tongue -->
        <path d="M494 632 Q512 664 530 632 Z" fill="${C.tongue}"/>
        <!-- mouth -->
        <path d="M512 598 L512 616 M512 616 Q490 636 470 618 M512 616 Q534 636 554 618" stroke="${C.nose}" stroke-width="10" stroke-linecap="round" fill="none"/>
        <!-- nose -->
        <ellipse cx="512" cy="582" rx="24" ry="17" fill="${C.nose}"/>
        <!-- eyes -->
        <circle cx="466" cy="520" r="16" fill="${C.eyeWhite}"/>
        <circle cx="558" cy="520" r="16" fill="${C.eyeWhite}"/>
        <circle cx="470" cy="522" r="8" fill="${C.nose}"/>
        <circle cx="562" cy="522" r="8" fill="${C.nose}"/>
        <!-- collar with tag -->
        <path d="M414 650 Q512 700 610 650 L610 680 Q512 730 414 680 Z" fill="${C.collar}"/>
        <circle cx="512" cy="700" r="16" fill="${C.tag}"/>
      </g>
    </g>
    <!-- upload badge -->
    <circle cx="300" cy="330" r="150" fill="${C.card}"/>
    <circle cx="300" cy="330" r="118" fill="${C.badge}"/>
    <path d="M300 250 L370 320 L328 320 L328 410 L272 410 L272 320 L230 320 Z" fill="${C.arrow}"/>
  `;
}

/** Single-colour silhouette for Android's themed (monochrome) icon: white with cut-outs. */
function monoArtwork() {
  const ink = "#FFFFFF";
  const hole = "rgba(0,0,0,0)";
  return `
    <rect x="262" y="332" width="500" height="400" rx="60" fill="${ink}"/>
    <clipPath id="pm"><rect x="296" y="366" width="432" height="332" rx="36"/></clipPath>
    <g clip-path="url(#pm)">
      <g transform="translate(512 540) scale(1.12) translate(-512 -545)">
        <ellipse cx="398" cy="540" rx="48" ry="100" transform="rotate(18 398 540)" fill="${hole}"/>
        <ellipse cx="626" cy="540" rx="48" ry="100" transform="rotate(-18 626 540)" fill="${hole}"/>
        <ellipse cx="512" cy="545" rx="118" ry="112" fill="${hole}"/>
        <ellipse cx="512" cy="600" rx="64" ry="46" fill="${ink}"/>
        <ellipse cx="512" cy="582" rx="24" ry="17" fill="${hole}"/>
        <circle cx="466" cy="520" r="16" fill="${ink}"/>
        <circle cx="558" cy="520" r="16" fill="${ink}"/>
      </g>
    </g>
    <circle cx="300" cy="330" r="150" fill="${hole}"/>
    <circle cx="300" cy="330" r="118" fill="${ink}"/>
    <path d="M300 250 L370 320 L328 320 L328 410 L272 410 L272 320 L230 320 Z" fill="${hole}"/>
  `;
}

const gradientDef = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.gradientA}"/>
      <stop offset="0.55" stop-color="${C.gradientB}"/>
      <stop offset="1" stop-color="${C.gradientC}"/>
    </linearGradient>
  </defs>`;

function svg({ size, background, body, scale = 1, radius = 0 }) {
  const s = 1024 * scale;
  const offset = (1024 - s) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
    ${gradientDef}
    ${background ? `<rect width="1024" height="1024" rx="${radius}" fill="${background}"/>` : ""}
    ${body ? `<g transform="translate(${offset} ${offset}) scale(${scale})">${body}</g>` : ""}
  </svg>`;
}

async function render(name, opts, trim = false) {
  let img = sharp(Buffer.from(svg(opts)), { density: 300 });
  if (trim) {
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
  await render("icon.png", { size: 1024, background: "url(#bg)", body: artwork(), scale: 1.12 });
  await render("android-icon-background.png", { size: 1024, background: "url(#bg)", body: null });
  await render("android-icon-foreground.png", { size: 1024, background: null, body: artwork(), scale: 0.92 });
  await render("android-icon-monochrome.png", { size: 1024, background: null, body: monoArtwork(), scale: 0.92 });
  await render("splash-icon.png", { size: 1024, background: null, body: artwork(), scale: 1 }, true);
  fs.writeFileSync(path.join(OUT, "logo.svg"), svg({ size: 1024, background: "url(#bg)", body: artwork(), scale: 1.12, radius: 180 }));

  const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="520" viewBox="0 0 1400 520">
    ${gradientDef}
    <rect width="1400" height="520" fill="#F5F7FA"/>
    <clipPath id="c"><circle cx="260" cy="260" r="200"/></clipPath>
    <g clip-path="url(#c)"><rect x="60" y="60" width="400" height="400" fill="url(#bg)"/>
      <g transform="translate(60 60) scale(0.390625)"><g transform="translate(40 40) scale(0.92)">${artwork()}</g></g></g>
    <clipPath id="sq"><rect x="560" y="60" width="400" height="400" rx="90"/></clipPath>
    <g clip-path="url(#sq)"><rect x="560" y="60" width="400" height="400" fill="url(#bg)"/>
      <g transform="translate(560 60) scale(0.390625)"><g transform="translate(-61 -61) scale(1.12)">${artwork()}</g></g></g>
    <rect x="1060" y="60" width="280" height="400" rx="30" fill="${C.splashSolid}"/>
    <g transform="translate(1130 190) scale(0.14)">${artwork()}</g>
  </svg>`;
  await sharp(Buffer.from(preview)).png().toFile(path.join(OUT, "preview.png"));
  console.log("preview.png written");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
