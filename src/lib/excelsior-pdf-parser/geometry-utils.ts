export function boxesIntersect(first: number[], second: number[], tolerance: number): boolean {
    return (
        first[0] <= second[2] + tolerance &&
        first[2] >= second[0] - tolerance &&
        first[1] <= second[3] + tolerance &&
        first[3] >= second[1] - tolerance
    );
}

export function isRectangleWithinBox(
    x: number,
    y: number,
    width: number,
    height: number,
    box: number[],
    tolerance: number
): boolean {
    return (
        x >= box[0] - tolerance &&
        y >= box[1] - tolerance &&
        x + width <= box[2] + tolerance &&
        y + height <= box[3] + tolerance
    );
}

// Union length of intervals.
export function getCoveredLength(intervals: Array<[number, number]>): number {
    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let currentFrom = -Infinity;
    let currentTo = -Infinity;
    for (const [from, to] of sorted) {
        if (from > currentTo) {
            if (currentTo > currentFrom) covered += currentTo - currentFrom;
            currentFrom = from;
            currentTo = to;
        } else {
            currentTo = Math.max(currentTo, to);
        }
    }
    if (currentTo > currentFrom) covered += currentTo - currentFrom;
    return covered;
}

export function getVisibleGlyphEdge(item: any, fromEnd: boolean): { left: number; right: number; y: number } | null {
    const chars = Array.isArray(item?.chars) ? item.chars : [];
    const step = fromEnd ? -1 : 1;

    for (let index = fromEnd ? chars.length - 1 : 0; index >= 0 && index < chars.length; index += step) {
        const glyph = chars[index];
        const isVisible =
            glyph && typeof glyph === 'object' && typeof glyph.unicode === 'string' && glyph.unicode.trim().length > 0;

        if (isVisible && Number.isFinite(glyph.x) && Number.isFinite(glyph.charWidth)) {
            return {
                left: glyph.x,
                right: glyph.x + glyph.charWidth,
                y: Number.isFinite(glyph.y) ? glyph.y : item.transform[5],
            };
        }
    }

    return null;
}