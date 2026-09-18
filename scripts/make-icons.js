// PWA 아이콘 생성기 — 의존성 없이 PNG 를 직접 쓴다.
//
// 왜 스크립트로 두는가: 아이콘을 바이너리로만 커밋해 두면 브랜드 색이 바뀔 때
// 무엇으로 어떻게 만들었는지 아무도 모른다. 여기서 다시 뽑을 수 있게 남긴다.
//
//   node scripts/make-icons.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'icons');

// index.html 의 theme-color 와 같은 값을 쓴다. 한쪽만 바꾸면 설치 화면과 앱 색이 어긋난다.
const BG = [0x31, 0x82, 0xF6];
const FG = [0xFF, 0xFF, 0xFF];

// ---------- PNG 인코더 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function png(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // 스캔라인마다 필터 바이트(0) 를 앞에 붙여야 한다 — 빠뜨리면 이미지가 어긋나 보인다
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 그리기 ----------
// 브랜드 마크가 "○" 라 흰 링을 그린다. 4x4 초과표본으로 계단 현상을 없앤다.
function draw(size, { ringScale, radiusPx }) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const rOuter = size * ringScale / 2;
  const rInner = rOuter - Math.max(2, size * 0.075);
  const corner = radiusPx == null ? 0 : radiusPx;
  const SS = 4;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inShape = 0, inRing = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;

          // 배경(둥근 사각형). corner=0 이면 꽉 찬 사각형 = maskable 용 풀블리드
          let bgHit = true;
          if (corner > 0) {
            const qx = Math.max(corner - px, px - (size - corner), 0);
            const qy = Math.max(corner - py, py - (size - corner), 0);
            bgHit = qx * qx + qy * qy <= corner * corner;
          }
          if (bgHit) inShape++;

          const d = Math.hypot(px - cx, py - cy);
          if (bgHit && d <= rOuter && d >= rInner) inRing++;
        }
      }
      const total = SS * SS;
      const aBg = inShape / total, aRing = inRing / total;
      const i = (y * size + x) * 4;
      // 링을 배경 위에 합성
      buf[i]     = Math.round(BG[0] * (1 - aRing) + FG[0] * aRing);
      buf[i + 1] = Math.round(BG[1] * (1 - aRing) + FG[1] * aRing);
      buf[i + 2] = Math.round(BG[2] * (1 - aRing) + FG[2] * aRing);
      buf[i + 3] = Math.round(255 * aBg);
    }
  }
  return png(size, size, buf);
}

fs.mkdirSync(OUT, { recursive: true });

const jobs = [
  // 일반 아이콘 — 모서리를 둥글게
  ['icon-192.png', 192, { ringScale: 0.62, radiusPx: 192 * 0.22 }],
  ['icon-512.png', 512, { ringScale: 0.62, radiusPx: 512 * 0.22 }],
  // 🔴 maskable 은 안드로이드가 바깥을 잘라낸다. 배경은 꽉 채우고(radiusPx:0)
  //    마크는 중앙 80% 안전영역 안에 들어오게 작게 그린다.
  ['icon-maskable-512.png', 512, { ringScale: 0.46, radiusPx: 0 }],
  // iOS 는 자기가 모서리를 깎으므로 꽉 찬 사각형을 준다
  ['apple-touch-icon.png', 180, { ringScale: 0.60, radiusPx: 0 }],
];

for (const [name, size, opts] of jobs) {
  const buf = draw(size, opts);
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log('  ' + name.padEnd(26) + size + 'x' + size + '  ' + (buf.length / 1024).toFixed(1) + 'KB');
}
console.log('\n아이콘 ' + jobs.length + '개 생성 → icons/');
console.log('⚠️  새 파일은 server.js 의 PUBLIC_FILES 화이트리스트에도 등록해야 서빙된다.');
