import { PAGE_BACKGROUND } from "../constants";

export interface PdfPathOps {
    moveTo: number;
    lineTo: number;
    curveTo: number;
    curveTo2: number;
    curveTo3: number;
    closePath: number;
    rectangle: number;
}

//pdfjs.Util.transform
export function transformFn(m1: number[], m2: number[]): number[] {
    return [
        m1[0] * m2[0] + m1[2] * m2[1],
        m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3],
        m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
        m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
}

//pdfjs.Util.applyTransform
export function applyTransformFn(p: number[], m: number[]): number[] {
    const x = p[0] * m[0] + p[1] * m[2] + m[4];
    const y = p[0] * m[1] + p[1] * m[3] + m[5];

    return [x, y];
}

// Converts an element's (transform, width, height) into a true
// axis-aligned bounding box in device coordinates—by projecting onto
// the element's actual reading/rising directions (the same logic we
// have already applied in extractCoordinates/buildSegment). This is necessary because
// both `width` and `height` for ANY text element (including
// native elements from `pageTextContent.items` in pdf.js itself)
// are measured along the element’s READING direction, not along
// the device’s fixed X/Y axes—for horizontal text, this
// is the same, but for rotated text (as in rotated.pdf), it is not.
export function getDeviceBBox(
    transform: number[],
    width: number,
    height: number,
): { x: number; y: number; width: number; height: number } {
    const [a, b, c, d, e, f] = transform;

    const readingLen = Math.hypot(a, b) || 1;
    const ascentLen = Math.hypot(c, d) || 1;

    const readingUnit = [a / readingLen, b / readingLen];
    const ascentUnit = [c / ascentLen, d / ascentLen];

    const corners: number[][] = [];

    for (const t of [0, width]) {
        for (const s of [0, height]) {
            corners.push([
                e + readingUnit[0] * t + ascentUnit[0] * s,
                f + readingUnit[1] * t + ascentUnit[1] * s,
            ]);
        }
    }

    const xs = corners.map((point) => point[0]);
    const ys = corners.map((point) => point[1]);

    return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
    };
}

// ===== HELPERS for compatibility of pdfjs-dist v5.1+ / v6+ (Node.js fake worker) =====
export function extractArrayLike(value: any): any[] {
    if (Array.isArray(value)) {
        return value;
    }

    if (!value || typeof value !== 'object') {
        return [];
    }

    if (typeof value.length === 'number') {
        return Array.from(value);
    }

    const keys = Object.keys(value)
        .filter((key) => /^\d+$/.test(key))
        .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

    return keys.map((key) => value[key]);
}

export function normalizeNumericArgs(args: any): any[] {
    // New format: [ { "0": x, "1": y, ... } ] (array with one Array-like object)
    if (
        Array.isArray(args) &&
        args.length === 1 &&
        args[0] &&
        typeof args[0] === 'object' &&
        !Array.isArray(args[0])
    ) {
        return extractArrayLike(args[0]);
    }

    // Old format: Array-like object without wrapper
    if (!Array.isArray(args) && args && typeof args === 'object') {
        return extractArrayLike(args);
    }

    return args;
}

export function grayToRGB(value: number): number[] {
    const gray = Math.round(Math.max(0, Math.min(1, value)) * 255);

    return [gray, gray, gray];
}

export function cmykToRGB(
    c: number,
    m: number,
    y: number,
    k: number,
): number[] {
    c = Math.max(0, Math.min(1, c));
    m = Math.max(0, Math.min(1, m));
    y = Math.max(0, Math.min(1, y));
    k = Math.max(0, Math.min(1, k));

    return [
        Math.round(255 * (1 - Math.min(1, c + k))),
        Math.round(255 * (1 - Math.min(1, m + k))),
        Math.round(255 * (1 - Math.min(1, y + k))),
    ];
}

export function normalizeGenericColorArgs(args: any): number[] {
    const values = normalizeNumericArgs(args).filter(
        (value) => typeof value === 'number',
    );

    if (values.length === 1) {
        return grayToRGB(values[0]);
    }

    if (values.length === 3) {
        return values.map((value) =>
            Math.round(Math.max(0, Math.min(1, value)) * 255),
        );
    }

    if (values.length === 4) {
        return cmykToRGB(values[0], values[1], values[2], values[3]);
    }

    return [];
}

export function normalizeColorArgs(args: any): number[] {
    if (
        Array.isArray(args) &&
        args.length === 1 &&
        typeof args[0] === 'string' &&
        args[0].startsWith('#')
    ) {
        let hex = args[0].slice(1);

        if (hex.length === 3) {
            hex = hex
                .split('')
                .map((char) => char + char)
                .join('');
        }

        const num = parseInt(hex, 16);

        return [
            (num >> 16) & 255,
            (num >> 8) & 255,
            num & 255,
        ];
    }

    let arr = normalizeNumericArgs(args);
    // Old format: args = [{"0":128,"1":128,"2":128}]
    if (
        Array.isArray(arr) &&
        arr.length === 1 &&
        arr[0] &&
        typeof arr[0] === 'object' &&
        !Array.isArray(arr[0])
    ) {
        arr = extractArrayLike(arr[0]);
    }

    return Array.isArray(arr)
        ? arr.filter((value) => typeof value === 'number')
        : [];
}

export function normalizeFontArgs(args: any): [string, number] {
    if (!Array.isArray(args) || args.length === 0) {
        return ['', 0];
    }
    // New format pdfjs@6: [["g_d0_f3", 8], ["g_d0_f2", 8]]
    if (Array.isArray(args[0]) && args.length >= 1) {
        return [args[0][0], args[0][1]];
    }
    // Old format: ["g_d0_f1", 8]
    if (typeof args[0] === 'string') {
        return [args[0], args[1] || 0];
    }
    // Fallback
    const normalized = normalizeNumericArgs(args);

    if (Array.isArray(normalized[0])) {
        return [normalized[0][0], normalized[0][1]];
    }

    return [normalized[0], normalized[1]];
}

/**
 * Extracts closed axial subpaths from pathOps/pathCoords
 * (moveTo → lineTo×N → closePath) that describe rectangles, and replaces
 * each with a single OPS.rectangle. Non‑convertible subpaths (curves,
 * non‑closed, non‑degenerate) are copied unchanged.
 */
export function extractClosedSubpathRectangles(
    pathOps: number[],
    pathCoords: number[],
    OPS: PdfPathOps,
): { ops: number[]; coords: number[] } {
    const coordCountFor = (op: number): number => {
        if (op === OPS.rectangle) return 4;
        if (op === OPS.moveTo || op === OPS.lineTo) return 2;
        if (op === OPS.curveTo) return 6;
        if (op === OPS.curveTo2 || op === OPS.curveTo3) return 4;

        return 0; // closePath and others without coordinates
    };

    const trySubpathToRect = (
        points: number[][],
    ): [number, number, number, number] | null => {
        if (points.length < 4) { // moveTo + at least 3 corners
            return null;
        }

        const xs = points.map((point) => point[0]);
        const ys = points.map((point) => point[1]);

        const x1 = Math.min(...xs);
        const x2 = Math.max(...xs);
        const y1 = Math.min(...ys);
        const y2 = Math.max(...ys);

        if (x2 - x1 < 0.01 || y2 - y1 < 0.01) {
            return null;
        }
        // all segments are axial and on the perimeter of the bbox; the path perimeter is equal to the bbox perimeter
        let perimeter = 0;

        for (let k = 0; k < points.length; k++) {
            const [ax, ay] = points[k];
            const [bx, by] = points[(k + 1) % points.length];

            const dx = bx - ax;
            const dy = by - ay;

            if (Math.abs(dx) > 1e-4 && Math.abs(dy) > 1e-4) {
                return null;
            }

            perimeter += Math.abs(dx) + Math.abs(dy);
        }

        for (const [px, py] of points) {
            const onVertical =
                (Math.abs(px - x1) < 0.01 || Math.abs(px - x2) < 0.01) &&
                py >= y1 - 0.01 &&
                py <= y2 + 0.01;

            const onHorizontal =
                (Math.abs(py - y1) < 0.01 || Math.abs(py - y2) < 0.01) &&
                px >= x1 - 0.01 &&
                px <= x2 + 0.01;

            if (!onVertical && !onHorizontal) {
                return null;
            }
        }

        if (
            Math.abs(perimeter - 2 * ((x2 - x1) + (y2 - y1))) > 0.5
        ) {
            return null;
        }

        return [x1, y1, x2 - x1, y2 - y1];
    };

    const outOps: number[] = [];
    const outCoords: number[] = [];

    let coordIndex = 0;
    let opIndex = 0;

    while (opIndex < pathOps.length) {
        if (pathOps[opIndex] !== OPS.moveTo) {
            const op = pathOps[opIndex];

            outOps.push(op);

            const coordCount = coordCountFor(op);

            for (let k = 0; k < coordCount; k++) {
                outCoords.push(pathCoords[coordIndex++]);
            }

            opIndex++;
            continue;
        }
        // collect the subpath up to closePath / the next moveTo
        const points: number[][] = [
            [pathCoords[coordIndex], pathCoords[coordIndex + 1]],
        ];

        coordIndex += 2;

        const subOps: number[] = [OPS.moveTo];
        const subCoords: number[] = [...points[0]];

        let closed = false;
        let hasCurves = false;

        opIndex++;

        while (opIndex < pathOps.length) {
            const op = pathOps[opIndex];

            if (op === OPS.closePath) {
                closed = true;
                opIndex++;
                break;
            }

            if (op === OPS.moveTo) {
                break;
            }

            subOps.push(op);

            const coordCount = coordCountFor(op);

            for (let k = 0; k < coordCount; k++) {
                subCoords.push(pathCoords[coordIndex]);
            }

            if (op === OPS.lineTo) {
                points.push([
                    pathCoords[coordIndex],
                    pathCoords[coordIndex + 1],
                ]);
            }

            if (op >= OPS.curveTo && op <= OPS.curveTo3) {
                hasCurves = true;
            }

            coordIndex += coordCount;
            opIndex++;
        }

        const rect = closed && !hasCurves ? trySubpathToRect(points) : null;

        if (rect) {
            outOps.push(OPS.rectangle);
            outCoords.push(...rect);
        } else {
            outOps.push(...subOps, ...(closed ? [OPS.closePath] : []));
            outCoords.push(...subCoords);
        }
    }

    return { ops: outOps, coords: outCoords };
}

export function normalizeShowTextArgs(args: any): any[] {
    if (!args || !args.length) {
        return [];
    }

    let glyphs = args[0];
    // If pdfjs returned the string directly
    if (typeof glyphs === 'string') {
        return glyphs.split('').map((char) => ({
            unicode: char,
            width: 500,
            isSpace: char === ' ',
            isLineBreak: char === '\n',
            isInFont: true,
        }));
    }
    // Array of arrays — flatten
    if (
        Array.isArray(glyphs) &&
        glyphs.length > 0 &&
        Array.isArray(glyphs[0])
    ) {
        glyphs = glyphs.flat();
    }
    // Make sure that \n is marked as isLineBreak
    if (Array.isArray(glyphs)) {
        return glyphs.map((glyph) => {
            if (typeof glyph === 'number') {
                return glyph;
            }

            if (typeof glyph === 'object' && glyph !== null) {
                if (glyph.unicode === '\n' && !glyph.isLineBreak) {
                    return { ...glyph, isLineBreak: true };
                }

                return glyph;
            }

            return glyph;
        });
    }

    return [];
}

export function normalizeDependencyArgs(args: any): string[] {
    if (!Array.isArray(args)) {
        return [];
    }

    if (args.length > 0 && Array.isArray(args[0])) {
        return args.map((pair) => pair[0]).filter(Boolean);
    }

    return args.filter((item) => typeof item === 'string');
}




export function parseCssColor(
  color: string | null | undefined
): [number, number, number, number] | null {
  if (!color) {
    return null;
  }
  const value = color.trim().toLowerCase().replace(/\s+/g, '');

  const rgb = value.match(/^rgba?\((\d*\.?\d+),(\d*\.?\d+),(\d*\.?\d+)(?:,(\d*\.?\d+))?\)$/);
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
  }

  const hex = value.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hex) {
    const digits = hex[1].length <= 4 ? [...hex[1]].map(char => char + char).join('') : hex[1];
    return [
      parseInt(digits.slice(0, 2), 16),
      parseInt(digits.slice(2, 4), 16),
      parseInt(digits.slice(4, 6), 16),
      digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1
    ];
  }
  return null;
}

// Colour as it looks on a white page: translucent colours are blended.
export function toVisibleRgb(color: [number, number, number, number]): number[] {
  const alpha = Math.min(1, Math.max(0, color[3]));
  return color.slice(0, 3).map(channel => channel * alpha + 255 * (1 - alpha));
}

export function isSameVisibleColor(
  first: string | null | undefined,
  second: string | null | undefined,
  tolerance = 2
): boolean {
  const firstColor = parseCssColor(first ?? PAGE_BACKGROUND);
  const secondColor = parseCssColor(second ?? PAGE_BACKGROUND);
  if (!firstColor || !secondColor) {
    return (first ?? PAGE_BACKGROUND) === (second ?? PAGE_BACKGROUND);
  }
  const a = toVisibleRgb(firstColor);
  const b = toVisibleRgb(secondColor);
  return a.every((channel, index) => Math.abs(channel - b[index]) <= tolerance);
}

// A border painted in the colour of a fill it touches is only the edge of
// that fill, not a separate line. A missing fill (null) is the white page.
export function isBorderAbsorbedByFills(
  borderColor: string | null | undefined,
  fills: Array<string | null | undefined>
): boolean {
  if (!borderColor) {
    return true;
  }
  const parsed = parseCssColor(borderColor);
  if (parsed && parsed[3] < 0.05) {
    return true;
  }
  return fills.some(fill => isSameVisibleColor(borderColor, fill));
}