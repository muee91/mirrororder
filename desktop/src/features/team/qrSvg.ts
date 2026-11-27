/**
 * Minimal zero-dependency ISO/IEC 18004 Byte-mode QR Code encoder (Versions 1..10, ECC-M).
 */

const VERSION_CAPACITY_M = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const DATA_CODEWORDS_M = [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216];
const EC_PER_BLOCK_M = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_M: Array<[number, number, number, number]> = [
  [0, 0, 0, 0],
  [1, 16, 0, 0],
  [1, 28, 0, 0],
  [1, 44, 0, 0],
  [2, 32, 0, 0],
  [2, 43, 0, 0],
  [4, 27, 0, 0],
  [4, 31, 0, 0],
  [2, 38, 2, 39],
  [3, 36, 2, 37],
  [4, 43, 1, 44],
];
const ALIGNMENT_POSITIONS: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen);
  const res = new Array<number>(data.length + ecLen).fill(0);
  for (let i = 0; i < data.length; i += 1) res[i] = data[i];
  for (let i = 0; i < data.length; i += 1) {
    const coef = res[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j += 1) {
        res[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return res.slice(data.length);
}

function encodeBits(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((val >> i) & 1);
  };
  push(0b0100, 4); // Byte mode
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacityBits = DATA_CODEWORDS_M[version] * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bits.length < capacityBits) {
    push(padBytes[padIdx % 2], 8);
    padIdx += 1;
  }
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  return codewords;
}

function interleaveCodewords(data: number[], version: number): number[] {
  const [g1Count, g1Len, g2Count, g2Len] = BLOCKS_M[version];
  const ecLen = EC_PER_BLOCK_M[version];
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < g1Count; i += 1) {
    const block = data.slice(offset, offset + g1Len);
    offset += g1Len;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, ecLen));
  }
  for (let i = 0; i < g2Count; i += 1) {
    const block = data.slice(offset, offset + g2Len);
    offset += g2Len;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, ecLen));
  }
  const result: number[] = [];
  const maxData = Math.max(g1Len, g2Len);
  for (let i = 0; i < maxData; i += 1) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < ecLen; i += 1) {
    for (const block of ecBlocks) result.push(block[i]);
  }
  return result;
}

function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // ECC-M = 00
  let d = data << 10;
  const poly = 0b10100110111;
  for (let i = 14; i >= 10; i -= 1) {
    if ((d >> i) & 1) d ^= poly << (i - 10);
  }
  return ((data << 10) | d) ^ 0b101010000010010;
}

export function encodeQrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const version = VERSION_CAPACITY_M.findIndex((cap, v) => v >= 1 && bytes.length <= cap);
  if (version < 1) throw new Error("二维码内容过长");
  const size = 17 + version * 4;
  const grid = Array.from({ length: size }, () => new Array<number>(size).fill(-1));
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const setModule = (r: number, c: number, dark: boolean, lock = true) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    grid[r][c] = dark ? 1 : 0;
    if (lock) reserved[r][c] = true;
  };

  const placeFinder = (top: number, left: number) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const inBox = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark =
          inBox &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        setModule(top + r, left + c, dark);
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  const align = ALIGNMENT_POSITIONS[version];
  for (const r of align) {
    for (const c of align) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dark = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
          setModule(r + dr, c + dc, dark);
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i += 1) {
    setModule(6, i, i % 2 === 0);
    setModule(i, 6, i % 2 === 0);
  }
  setModule(size - 8, 8, true);

  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      reserved[8][i] = true;
      reserved[i][8] = true;
    }
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }

  const codewords = interleaveCodewords(encodeBits(bytes, version), version);
  const bitStream: number[] = [];
  for (const cw of codewords) {
    for (let b = 7; b >= 0; b -= 1) bitStream.push((cw >> b) & 1);
  }

  let bitIdx = 0;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let step = 0; step < size; step += 1) {
      const r = up ? size - 1 - step : step;
      for (const dc of [0, -1]) {
        const c = col + dc;
        if (!reserved[r][c]) {
          grid[r][c] = bitIdx < bitStream.length ? bitStream[bitIdx++] : 0;
        }
      }
    }
    up = !up;
  }

  const maskFn = (mask: number, r: number, c: number): boolean => {
    switch (mask) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  };

  let bestMask = 0;
  let bestScore = Infinity;
  let bestGrid: number[][] = grid;

  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = grid.map((row, r) =>
      row.map((val, c) => (reserved[r][c] ? val : val ^ (maskFn(mask, r, c) ? 1 : 0))),
    );
    const fmt = formatBits(mask);
    for (let i = 0; i < 15; i += 1) {
      const bit = (fmt >> (14 - i)) & 1;
      if (i < 6) candidate[8][i] = bit;
      else if (i < 8) candidate[8][i + 1] = bit;
      else candidate[size - 15 + i][8] = bit;

      if (i < 8) candidate[size - 1 - i][8] = bit;
      else if (i < 9) candidate[8][15 - i] = bit;
      else candidate[8][15 - i - 1] = bit;
    }
    let darkCount = 0;
    for (const row of candidate) for (const cell of row) if (cell === 1) darkCount += 1;
    const score = Math.abs((darkCount * 100) / (size * size) - 50);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestGrid = candidate;
    }
  }
  void bestMask;
  void TOTAL_CODEWORDS;
  return bestGrid.map((row) => row.map((cell) => cell === 1));
}

export function qrSvgData(text: string): { viewBox: string; path: string; size: number } {
  const matrix = encodeQrMatrix(text);
  const quiet = 4;
  const total = matrix.length + quiet * 2;
  const parts: string[] = [];
  for (let r = 0; r < matrix.length; r += 1) {
    for (let c = 0; c < matrix.length; c += 1) {
      if (matrix[r][c]) parts.push(`M${c + quiet},${r + quiet}h1v1h-1z`);
    }
  }
  return {
    viewBox: `0 0 ${total} ${total}`,
    path: parts.join(""),
    size: total,
  };
}
