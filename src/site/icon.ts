import { crc32, deflateSync } from "node:zlib";

// A stand-in mark until the Better Giving logo is supplied. Not a brand asset.

export const ICON_SIZE = 512;
export const ICON_COLOR = "#1B4D3E";

const GREEN = [0x1b, 0x4d, 0x3e] as const;

export const ICON_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}" role="img" aria-label="Placeholder icon">
<title>Placeholder icon</title>
<rect width="${ICON_SIZE}" height="${ICON_SIZE}" rx="96" fill="${ICON_COLOR}"/>
<circle cx="256" cy="256" r="120" fill="#ffffff"/>
<circle cx="256" cy="256" r="48" fill="${ICON_COLOR}"/>
</svg>
`;

function dist2(x: number, y: number, cx: number, cy: number): number {
	const dx = x + 0.5 - cx;
	const dy = y + 0.5 - cy;
	return dx * dx + dy * dy;
}

/** 512×512 PNG of the same placeholder mark. */
export const ICON_PNG: Uint8Array = renderPng();

function renderPng(): Uint8Array {
	const size = ICON_SIZE;
	const row = 1 + size * 4;
	const raw = Buffer.alloc(size * row);
	for (let y = 0; y < size; y++) {
		const start = y * row;
		raw[start] = 0;
		for (let x = 0; x < size; x++) {
			const pixel = colorAt(x, y);
			const at = start + 1 + x * 4;
			raw[at] = pixel[0];
			raw[at + 1] = pixel[1];
			raw[at + 2] = pixel[2];
			raw[at + 3] = pixel[3];
		}
	}
	return png(size, size, raw);
}

function colorAt(
	x: number,
	y: number,
): readonly [number, number, number, number] {
	if (!inRoundedRect(x, y, ICON_SIZE, 96)) return [0, 0, 0, 0];
	const fromCenter = dist2(x, y, 256, 256);
	if (fromCenter <= 48 * 48) return [GREEN[0], GREEN[1], GREEN[2], 255];
	if (fromCenter <= 120 * 120) return [255, 255, 255, 255];
	return [GREEN[0], GREEN[1], GREEN[2], 255];
}

function inRoundedRect(
	x: number,
	y: number,
	size: number,
	radius: number,
): boolean {
	if (x < 0 || y < 0 || x >= size || y >= size) return false;
	const left = x < radius;
	const right = x >= size - radius;
	const top = y < radius;
	const bottom = y >= size - radius;
	if (!left && !right) return true;
	if (!top && !bottom) return true;
	const cx = left ? radius : size - radius;
	const cy = top ? radius : size - radius;
	return dist2(x, y, cx, cy) <= radius * radius;
}

function png(width: number, height: number, raw: Buffer): Uint8Array {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

function chunk(type: string, data: Buffer): Buffer {
	const name = Buffer.from(type, "ascii");
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	name.copy(head, 4);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0, 0);
	return Buffer.concat([head, data, crc]);
}
