"use strict";
// 產生 build/icon.png 與 build/icon.ico：深色圓角方塊 + Claude 橘色儀表弧。
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "build");
fs.mkdirSync(OUT, { recursive: true });

function draw(size) {
  const ss = 4, N = size * ss;
  const px = new Float64Array(size * size * 4);
  const bg = [29, 28, 26], track = [62, 58, 54], orange = [224, 122, 82];
  const c = N / 2, rOuter = N * 0.36, rInner = N * 0.25, radius = N * 0.22, dotR = N * 0.075;
  const startA = (135 * Math.PI) / 180, sweep = (270 * Math.PI) / 180, fill = 0.68;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    // 圓角方塊
    const dx = Math.max(radius - x, 0, x - (N - 1 - radius)), dy = Math.max(radius - y, 0, y - (N - 1 - radius));
    if (dx * dx + dy * dy > radius * radius) continue;
    let col = bg;
    const vx = x + 0.5 - c, vy = y + 0.5 - c, r = Math.hypot(vx, vy);
    if (r >= rInner && r <= rOuter) {
      let a = Math.atan2(vy, vx) - startA;
      while (a < 0) a += 2 * Math.PI;
      if (a <= sweep) col = a <= sweep * fill ? orange : track;
    }
    if (r <= dotR) col = orange;
    const i = (Math.floor(y / ss) * size + Math.floor(x / ss)) * 4;
    px[i] += col[0]; px[i + 1] += col[1]; px[i + 2] += col[2]; px[i + 3] += 255;
  }
  const out = Buffer.alloc(size * size * 4), k = ss * ss;
  for (let i = 0; i < size * size; i++) {
    const a = px[i * 4 + 3] / k;
    for (let j = 0; j < 3; j++) out[i * 4 + j] = a ? Math.round(px[i * 4 + j] / k / (a / 255)) : 0;
    out[i * 4 + 3] = Math.round(a);
  }
  return out;
}

const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t.push(c >>> 0); } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const rgba = draw(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map(png);
fs.writeFileSync(path.join(OUT, "icon.png"), pngs[pngs.length - 1]);

const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return e;
});
fs.writeFileSync(path.join(OUT, "icon.ico"), Buffer.concat([header, ...dir, ...pngs]));
console.log("已產生 build/icon.png、build/icon.ico");
