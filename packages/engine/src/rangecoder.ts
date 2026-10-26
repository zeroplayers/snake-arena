/**
 * Adaptive binary range coder (the one LZMA uses) plus a few context models on top of it. Every
 * value is coded bit by bit against a probability that adapts to what came before, so repetitive
 * data (a bot holding the same turn, small counters, the shared high bytes of nearby floats)
 * costs a fraction of a bit, and the engine needs no compression library.
 *
 * Encoder and decoder must create the same models in the same order and code the same sequence
 * of values; the replay format does exactly that.
 */

const TOP = 0x1000000; // 2^24
const PROB_BITS = 11;
const PROB_ONE = 1 << PROB_BITS;
const MOVE_BITS = 5;

function probs(n: number): Uint16Array {
  return new Uint16Array(n).fill(PROB_ONE >>> 1);
}

export class RangeEncoder {
  /** Up to 33 bits; plain number arithmetic keeps it exact. */
  private low = 0;
  private range = 0xffffffff;
  private cache = 0;
  private cacheSize = 1;
  private out = new Uint8Array(1024);
  private length = 0;

  bit(p: Uint16Array, i: number, bit: number): void {
    const prob = p[i] as number;
    const bound = (this.range >>> PROB_BITS) * prob;
    if (bit === 0) {
      this.range = bound;
      p[i] = prob + ((PROB_ONE - prob) >>> MOVE_BITS);
    } else {
      this.low += bound;
      this.range -= bound;
      p[i] = prob - (prob >>> MOVE_BITS);
    }
    while (this.range < TOP) {
      this.range = (this.range * 256) >>> 0;
      this.shiftLow();
    }
  }

  /** Flushes the coder; the encoder can't be used afterwards. */
  finish(): Uint8Array {
    for (let i = 0; i < 5; i++) this.shiftLow();
    return this.out.slice(0, this.length);
  }

  private shiftLow(): void {
    if (this.low < 0xff000000 || this.low >= 0x100000000) {
      const carry = this.low >= 0x100000000 ? 1 : 0;
      let temp = this.cache;
      do {
        this.push((temp + carry) & 0xff);
        temp = 0xff;
      } while (--this.cacheSize !== 0);
      this.cache = Math.floor(this.low / TOP) & 0xff;
    }
    this.cacheSize++;
    this.low = (this.low % TOP) * 256;
  }

  private push(byte: number): void {
    if (this.length === this.out.length) {
      const grown = new Uint8Array(this.out.length * 2);
      grown.set(this.out);
      this.out = grown;
    }
    this.out[this.length++] = byte;
  }
}

export class RangeDecoder {
  private range = 0xffffffff;
  private code = 0;
  private pos: number;

  constructor(
    private readonly bytes: Uint8Array,
    offset = 0,
  ) {
    this.pos = offset;
    for (let i = 0; i < 5; i++) this.code = (this.code * 256 + this.byte()) >>> 0;
  }

  bit(p: Uint16Array, i: number): number {
    const prob = p[i] as number;
    const bound = (this.range >>> PROB_BITS) * prob;
    let bit: number;
    if (this.code < bound) {
      this.range = bound;
      p[i] = prob + ((PROB_ONE - prob) >>> MOVE_BITS);
      bit = 0;
    } else {
      this.code -= bound;
      this.range -= bound;
      p[i] = prob - (prob >>> MOVE_BITS);
      bit = 1;
    }
    while (this.range < TOP) {
      this.range = (this.range * 256) >>> 0;
      this.code = (this.code * 256 + this.byte()) >>> 0;
    }
    return bit;
  }

  private byte(): number {
    if (this.pos > this.bytes.length + 4) throw new Error("range decoder: truncated input");
    return this.bytes[this.pos++] ?? 0;
  }
}

// --- Models ------------------------------------------------------------------------------------

/** A single adaptive bit, with `contexts` independent probabilities. */
export class BitModel {
  private readonly p: Uint16Array;

  constructor(contexts = 1) {
    this.p = probs(contexts);
  }

  write(e: RangeEncoder, bit: boolean, ctx = 0): void {
    e.bit(this.p, ctx, bit ? 1 : 0);
  }

  read(d: RangeDecoder, ctx = 0): boolean {
    return d.bit(this.p, ctx) === 1;
  }
}

/** An unsigned integer of `bits` bits, coded most significant bit first through a binary tree. */
export class TreeModel {
  private readonly p: Uint16Array;

  constructor(
    private readonly bits: number,
    contexts = 1,
  ) {
    this.p = probs(contexts << bits);
  }

  write(e: RangeEncoder, value: number, ctx = 0): void {
    const base = ctx << this.bits;
    let m = 1;
    for (let i = this.bits - 1; i >= 0; i--) {
      const b = (value >>> i) & 1;
      e.bit(this.p, base + m, b);
      m = (m << 1) | b;
    }
  }

  read(d: RangeDecoder, ctx = 0): number {
    const base = ctx << this.bits;
    let m = 1;
    for (let i = 0; i < this.bits; i++) m = (m << 1) | d.bit(this.p, base + m);
    return m - (1 << this.bits);
  }
}

/** A non-negative safe integer as 7-bit groups, low first; each group position adapts apart. */
export class UintModel {
  private readonly groups = new TreeModel(8, 5);

  write(e: RangeEncoder, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`not a uint: ${value}`);
    let v = value;
    for (let i = 0; ; i++) {
      const low = v % 128;
      v = Math.floor(v / 128);
      this.groups.write(e, v > 0 ? low | 128 : low, Math.min(i, 4));
      if (v === 0) return;
    }
  }

  read(d: RangeDecoder): number {
    let value = 0;
    let scale = 1;
    for (let i = 0; ; i++) {
      const g = this.groups.read(d, Math.min(i, 4));
      value += (g & 127) * scale;
      if (g < 128) return value;
      scale *= 128;
    }
  }
}

/** A signed safe integer, zigzag-mapped onto {@link UintModel}. */
export class IntModel {
  private readonly uint = new UintModel();

  write(e: RangeEncoder, value: number): void {
    this.uint.write(e, value >= 0 ? value * 2 : -value * 2 - 1);
  }

  read(d: RangeDecoder): number {
    const z = this.uint.read(d);
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }
}

const view = new DataView(new ArrayBuffer(16));

/**
 * A float64, bit-exact (−0 included). Its 8 bytes are XORed with a reference value
 * (the previous value of the same field, say) and coded high byte first; each byte position has
 * its own model, split by whether the byte before it was zero. Close values share sign, exponent
 * and top mantissa bits, so those bytes XOR to zero and cost almost nothing.
 */
export class F64Model {
  private readonly bytes = new TreeModel(8, 16);

  write(e: RangeEncoder, value: number, ref = 0): void {
    view.setFloat64(0, value);
    view.setFloat64(8, ref);
    let zero = 1;
    for (let k = 0; k < 8; k++) {
      const b = view.getUint8(k) ^ view.getUint8(8 + k);
      this.bytes.write(e, b, k * 2 + zero);
      zero = b === 0 ? 1 : 0;
    }
  }

  read(d: RangeDecoder, ref = 0): number {
    view.setFloat64(8, ref);
    let zero = 1;
    for (let k = 0; k < 8; k++) {
      const b = this.bytes.read(d, k * 2 + zero);
      view.setUint8(k, b ^ view.getUint8(8 + k));
      zero = b === 0 ? 1 : 0;
    }
    return view.getFloat64(0);
  }
}

/** A string as its UTF-16 code units. */
export class StringModel {
  private readonly length = new UintModel();
  private readonly chars = new UintModel();

  write(e: RangeEncoder, s: string): void {
    this.length.write(e, s.length);
    for (let i = 0; i < s.length; i++) this.chars.write(e, s.charCodeAt(i));
  }

  read(d: RangeDecoder): string {
    const n = this.length.read(d);
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.chars.read(d));
    return s;
  }
}
