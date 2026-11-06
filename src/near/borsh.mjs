// Just enough Borsh to encode NEAR transactions.
const MASK64 = (1n << 64n) - 1n;

export class BorshWriter {
  constructor() { this.chunks = []; }
  u8(n) { this.chunks.push(Buffer.from([n & 0xff])); return this; }
  u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); this.chunks.push(b); return this; }
  u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n) & MASK64); this.chunks.push(b); return this; }
  u128(n) {
    const v = BigInt(n);
    if (v < 0n || v >= 1n << 128n) throw new RangeError('u128 out of range');
    return this.u64(v & MASK64).u64(v >> 64n);
  }
  fixed(buf) { this.chunks.push(Buffer.from(buf)); return this; }
  bytes(buf) { this.u32(buf.length); return this.fixed(buf); }
  string(s) { return this.bytes(Buffer.from(s, 'utf8')); }
  toBuffer() { return Buffer.concat(this.chunks); }
}
