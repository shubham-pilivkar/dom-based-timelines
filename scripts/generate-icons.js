// Generate the toolbar icons at 16, 48, 128 px. Pure-JS via pngjs so
// the build stays free of native deps. The design is a brand-blue
// rounded square with a centered red "REC" dot ringed in white —
// readable at 16 px and recognisable at 128 px.
//
// Run: npm run icons

import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'public', 'icons');

const BG = [79, 140, 255];   // brand accent (#4f8cff)
const DOT = [239, 68, 68];   // record-red (#ef4444)
const RING = [255, 255, 255];

// Anti-aliased disk: returns coverage 0..1 at a given distance.
function diskAlpha(dist, radius) {
  if (dist <= radius - 0.5) return 1;
  if (dist >= radius + 0.5) return 0;
  return radius + 0.5 - dist;
}

// Anti-aliased ring (annulus).
function ringAlpha(dist, inner, outer) {
  return Math.max(0, Math.min(diskAlpha(dist, outer) - diskAlpha(dist, inner), 1));
}

// Rounded-square coverage: 1 inside, 0 outside, AA at edges.
function squircleAlpha(x, y, size, corner) {
  const half = size / 2;
  // Distance from centre, projected onto the rounded-rect surface.
  const dx = Math.abs(x - half + 0.5) - (half - corner);
  const dy = Math.abs(y - half + 0.5) - (half - corner);
  const inset = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - corner;
  // Negative = inside; positive = outside.
  if (inset <= -0.5) return 1;
  if (inset >= 0.5) return 0;
  return 0.5 - inset;
}

function generate(size) {
  const png = new PNG({ width: size, height: size });
  const cx = size / 2 - 0.5;
  const cy = size / 2 - 0.5;
  const dotR = size * 0.22;
  const ringInner = size * 0.30;
  const ringOuter = size * 0.36;
  const corner = size * 0.20;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);

      // Compose: transparent → blue background → white ring → red dot.
      let r = 0, g = 0, b = 0, a = 0;

      const bgA = squircleAlpha(x, y, size, corner);
      if (bgA > 0) {
        r = BG[0]; g = BG[1]; b = BG[2]; a = Math.round(bgA * 255);
      }

      const ringA = ringAlpha(dist, ringInner, ringOuter);
      if (ringA > 0) {
        r = r * (1 - ringA) + RING[0] * ringA;
        g = g * (1 - ringA) + RING[1] * ringA;
        b = b * (1 - ringA) + RING[2] * ringA;
        a = Math.max(a, Math.round(ringA * 255));
      }

      const dotA = diskAlpha(dist, dotR);
      if (dotA > 0) {
        r = r * (1 - dotA) + DOT[0] * dotA;
        g = g * (1 - dotA) + DOT[1] * dotA;
        b = b * (1 - dotA) + DOT[2] * dotA;
        a = Math.max(a, Math.round(dotA * 255));
      }

      png.data[idx] = Math.round(r);
      png.data[idx + 1] = Math.round(g);
      png.data[idx + 2] = Math.round(b);
      png.data[idx + 3] = a;
    }
  }
  return PNG.sync.write(png);
}

for (const size of [16, 48, 128]) {
  const buf = generate(size);
  const out = path.join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(out, buf);
  console.log(`wrote ${out} (${buf.length} bytes)`);
}
