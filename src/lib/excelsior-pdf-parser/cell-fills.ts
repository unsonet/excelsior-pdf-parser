import { parseRGB } from "@unsonet/js-utils";
import { isVisibleVector } from "./pdf-vector-utils";

export function compositeCellColors(colorStrings) {
    let layers = colorStrings
        .map(c => parseRGB(c))
        .filter(c => c && c.length >= 3)
        .map(c => ({ r: c.r, g: c.g, b: c.b, a: c.a !== undefined ? c.a : 1 }));

    if (!layers.length) return null;
    if (layers.length === 1) {
        let l = layers[0];
        return l.a >= 0.999 ? `rgb(${l.r},${l.g},${l.b})` : `rgba(${l.r},${l.g},${l.b},${l.a})`;
    }

    let r = layers[0].r, g = layers[0].g, b = layers[0].b, a = layers[0].a;
    for (let i = 1; i < layers.length; i++) {
        let l = layers[i];
        let outA = l.a + a * (1 - l.a);
        if (outA > 0.001) {
            r = (l.r * l.a + r * a * (1 - l.a)) / outA;
            g = (l.g * l.a + g * a * (1 - l.a)) / outA;
            b = (l.b * l.a + b * a * (1 - l.a)) / outA;
        }
        a = outA;
    }

    r = Math.round(Math.max(0, Math.min(255, r)));
    g = Math.round(Math.max(0, Math.min(255, g)));
    b = Math.round(Math.max(0, Math.min(255, b)));
    a = Math.min(1, Math.max(0, a));

    if (a >= 0.999) return `rgb(${r},${g},${b})`;
    return `rgba(${r},${g},${b},${parseFloat(a.toFixed(3))})`;
}

/**
* Fill colour of every table cell, taken from the filled rectangles of the page
* in paint order (a later rectangle covers an earlier one).
*
* The text based fill (extractCoordinates) only exists for cells with text, and
* only when the text block lies completely inside the rectangle. Empty cells and
* header cells that stick out of the band got no fill that way.
*/
export function computeCellFills(options: {
    verticles: any[];
    horizons: any[];
    merges: Record<string, any>;
    mergeAlias: Record<string, string>;
    rectangles: any[];
}): Record<string, string> {
    const { verticles, horizons, merges, mergeAlias, rectangles } = options;
    const fills: Record<string, string> = {};

    const painted = (rectangles || []).filter(rect =>
        rect?.fillColor
        && isVisibleVector(rect)
        && Number(rect.width) > 0
        && Number(rect.height) > 0
    );

    if (!painted.length) {
        return fills;
    }

    const MIN_COVERAGE = 0.4;       // share of the cell area covered by the rectangle
    const CENTER_TOLERANCE = 0.15;  // share of the cell height

    for (let row = 0; row < horizons.length - 1; row++) {
        for (let col = 0; col < verticles.length - 1; col++) {
            const key = `${row}-${col}`;

            if (mergeAlias[key]) {
                continue;
            }

            const span = merges[key];
            const rowSpan = span?.height || 1;
            const colSpan = span?.width || 1;

            const left = verticles[col]?.x;
            const right = verticles[col + colSpan]?.x;
            const top = horizons[row]?.y;
            const bottom = horizons[row + rowSpan]?.y;

            if (![left, right, top, bottom].every(Number.isFinite)) {
                continue;
            }

            const x1 = Math.min(left, right);
            const x2 = Math.max(left, right);
            const y1 = Math.min(top, bottom);
            const y2 = Math.max(top, bottom);
            const area = (x2 - x1) * (y2 - y1);

            if (!(area > 0)) {
                continue;
            }

            const centerX = (x1 + x2) / 2;
            const centerY = (y1 + y2) / 2;
            const tolerance = (y2 - y1) * CENTER_TOLERANCE;
            const layers: string[] = [];

            for (const rect of painted) {
                const rectRight = rect.x + rect.width;
                const rectTop = rect.y + rect.height;

                const overlapX = Math.max(0, Math.min(x2, rectRight) - Math.max(x1, rect.x));
                const overlapY = Math.max(0, Math.min(y2, rectTop) - Math.max(y1, rect.y));

                const centerInside =
                    centerX >= rect.x
                    && centerX <= rectRight
                    && centerY >= rect.y - tolerance
                    && centerY <= rectTop + tolerance;

                if (overlapX * overlapY / area >= MIN_COVERAGE && centerInside) {
                    layers.push(rect.fillColor);
                }
            }

            if (!layers.length) {
                // Shading drawn piece by piece (a rectangle per text line plus side pads): no single piece
                // covers MIN_COVERAGE of a tall merged cell, but the pieces of one colour together do.
                const byColor = new Map<string, { area: number; hasCenter: boolean }>();
                for (const rect of painted) {
                    const rectRight = rect.x + rect.width;
                    const rectTop = rect.y + rect.height;
                    const overlapX = Math.max(0, Math.min(x2, rectRight) - Math.max(x1, rect.x));
                    const overlapY = Math.max(0, Math.min(y2, rectTop) - Math.max(y1, rect.y));
                    if (!(overlapX * overlapY > 0)) {
                        continue;
                    }
                    const centerInside =
                        centerX >= rect.x &&
                        centerX <= rectRight &&
                        centerY >= rect.y - tolerance &&
                        centerY <= rectTop + tolerance;
                    const entry = byColor.get(rect.fillColor) || { area: 0, hasCenter: false };
                    entry.area += overlapX * overlapY;
                    entry.hasCenter = entry.hasCenter || centerInside;
                    byColor.set(rect.fillColor, entry);
                }

                let bestColor: string | null = null;
                let bestArea = 0;
                for (const [color, entry] of Array.from(byColor.entries())) {
                    if (entry.hasCenter && entry.area / area >= MIN_COVERAGE && entry.area > bestArea) {
                        bestArea = entry.area;
                        bestColor = color;
                    }
                }
                if (bestColor) {
                    layers.push(bestColor);
                }
            }

            if (layers.length) {
                const color = compositeCellColors(layers);
                if (color) {
                    fills[key] = color;
                }
            }
        }
    }

    return fills;
}