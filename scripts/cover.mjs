// Generates cover.png (800x534) for gladys-omnik: plain Node, no dependency.
// A sun over a solar panel, a cable to an inverter box with a power curve, its
// Wi-Fi logger sending waves, and a small moon (the inverter sleeps at night),
// on a warm sky gradient (no brand logo).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
const skyAt = (x, y) => {
  const t = (x / W) * 0.7 + (y / H) * 0.3;
  return [40 + 60 * t, 120 - 70 * t, 170 - 40 * t];
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    set(x, y, skyAt(x, y));
  }
}
const white = [255, 255, 255];
const dark = [28, 38, 64];
const sun = [255, 200, 50];
const glass = [70, 110, 190];
const green = [90, 210, 130];
const moon = [235, 235, 250];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

disc(400, 270, 260, white, 0.05);

// The sun and its rays.
disc(150, 110, 50, sun);
for (let k = 0; k < 8; k += 1) {
  const a = (k * Math.PI) / 4;
  line(
    150 + 66 * Math.cos(a),
    110 + 66 * Math.sin(a),
    150 + 92 * Math.cos(a),
    110 + 92 * Math.sin(a),
    10,
    sun,
  );
}

// The moon: a disc with a bite of sky (the inverter sleeps at night).
disc(690, 95, 38, moon);
disc(708, 82, 34, skyAt(708, 82));

// The solar panel: a tilted grid of cells on two legs.
for (let row = 0; row < 3; row += 1) {
  for (let col = 0; col < 4; col += 1) {
    const x = 60 + col * 56 + row * 16;
    const y = 240 + row * 46;
    box(x, y, x + 50, y + 40, 4, dark);
    box(x + 4, y + 4, x + 46, y + 36, 3, glass, 0.85);
  }
}
line(170, 378, 150, 460, 10, white);
line(240, 378, 260, 460, 10, white);

// The cable to the inverter.
line(318, 320, 400, 320, 8, white);

// The inverter: a white box with a screen showing a production curve.
box(400, 190, 600, 450, 24, white);
box(425, 220, 575, 330, 10, dark);
let previous;
for (let x = 435; x <= 565; x += 2) {
  const t = (x - 435) / 130;
  const y = 318 - 85 * Math.sin(Math.PI * t) ** 2;
  if (previous) line(previous[0], previous[1], x, y, 5, green);
  previous = [x, y];
}
// Its status light and vents.
disc(440, 365, 10, green);
for (let k = 0; k < 4; k += 1) {
  line(480, 360 + k * 18, 570, 360 + k * 18, 6, [200, 205, 215]);
}

// The Wi-Fi logger on the side of the inverter, and its waves.
box(600, 300, 650, 420, 10, white);
disc(625, 395, 7, green);
for (let k = 1; k <= 3; k += 1) {
  const r = 10 + k * 22;
  let last;
  for (let a = -Math.PI / 4; a <= Math.PI / 4 + 1e-9; a += Math.PI / 60) {
    const point = [625 + r * Math.sin(a), 290 - r * Math.cos(a)];
    if (last) line(last[0], last[1], point[0], point[1], 7, white);
    last = point;
  }
}

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
