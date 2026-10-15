import { deflateSync } from "node:zlib";

// A placeholder mark for the directory listings: a blue rounded square and a
// white plus. It is not the Better Giving logo. Both the SVG and the PNG are
// 512×512 so a listing can use either.

const SIZE = 512;
const RADIUS = 96;
const BLUE = [0x1d, 0x4e, 0xd8] as const;

export const ICON_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" role="img" aria-label="Better Giving placeholder icon">
<title>Better Giving placeholder icon</title>
<rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" fill="#1D4ED8"/>
<rect x="216" y="96" width="80" height="320" fill="#FFFFFF"/>
<rect x="96" y="216" width="320" height="80" fill="#FFFFFF"/>
</svg>
`;

let png: Uint8Array<ArrayBuffer> | undefined;

/** 512×512 RGBA PNG of {@link ICON_SVG}. Built once per process. */
export function iconPng(): Uint8Array<ArrayBuffer> {
	png ??= renderPng();
	return png;
}

function insideRound(x: number, y: number): boolean {
	const left = x < RADIUS;
	const right = x >= SIZE - RADIUS;
	const top = y < RADIUS;
	const bottom = y >= SIZE - RADIUS;
	if (!left && !right) return true;
	if (!top && !bottom) return true;
	const cx = left ? RADIUS : SIZE - RADIUS;
	const cy = top ? RADIUS : SIZE - RADIUS;
	const dx = x + 0.5 - cx;
	const dy = y + 0.5 - cy;
	return dx * dx + dy * dy <= RADIUS * RADIUS;
}

function pixel(x: number, y: number): readonly number[] {
	if (!insideRound(x, y)) return [0, 0, 0, 0];
	const plus =
		(x >= 216 && x < 296 && y >= 96 && y < 416) ||
		(x >= 96 && x < 416 && y >= 216 && y < 296);
	return plus ? [255, 255, 255, 255] : [...BLUE, 255];
}

function renderPng(): Uint8Array<ArrayBuffer> {
	const stride = 1 + SIZE * 4;
	const raw = Buffer.alloc(SIZE * stride);
	for (let y = 0; y < SIZE; y++) {
		const row = y * stride;
		raw[row] = 0;
		for (let x = 0; x < SIZE; x++) {
			const [r, g, b, a] = pixel(x, y);
			const at = row + 1 + x * 4;
			raw[at] = r ?? 0;
			raw[at + 1] = g ?? 0;
			raw[at + 2] = b ?? 0;
			raw[at + 3] = a ?? 0;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(SIZE, 0);
	ihdr.writeUInt32BE(SIZE, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	const packed = Buffer.concat([
		signature,
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
	const copy = new ArrayBuffer(packed.byteLength);
	new Uint8Array(copy).set(packed);
	return new Uint8Array(copy);
}

function chunk(type: string, data: Buffer): Buffer {
	const typeBytes = Buffer.from(type);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	return Buffer.concat([length, typeBytes, data, crc]);
}

function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc ^= data[i] ?? 0;
		for (let bit = 0; bit < 8; bit++) {
			const mask = -(crc & 1);
			crc = (crc >>> 1) ^ (0xedb88320 & mask);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}
