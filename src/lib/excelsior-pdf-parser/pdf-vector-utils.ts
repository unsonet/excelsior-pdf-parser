
import { parseRGB } from '@unsonet/js-utils';

const NESTED_RECT_TOLERANCE = 0.5;

export function isSameFillColor(a: any, b: any): boolean {
    return !!a?.fillColor && a.fillColor === b?.fillColor;
}

export function isStrictlyContained(
    outer: any,
    inner: any,
    tolerance: number = NESTED_RECT_TOLERANCE,
): boolean {
    const innerRight = inner.x + inner.width;
    const innerBottom = inner.y + inner.height;
    const outerRight = outer.x + outer.width;
    const outerBottom = outer.y + outer.height;

    const contained =
        inner.x >= outer.x - tolerance &&
        inner.y >= outer.y - tolerance &&
        innerRight <= outerRight + tolerance &&
        innerBottom <= outerBottom + tolerance;

    if (!contained) {
        return false;
    }
    // We filter out duplicates/matching rectangles:
    // the nested one must be noticeably smaller in at least one axis.
    const strictlySmaller =
        innerRight - inner.x < outerRight - outer.x - tolerance ||
        innerBottom - inner.y < outerBottom - outer.y - tolerance;

    return strictlySmaller;
}

export function isVisibleVector(item: any): boolean {
    const color = item?.fillColor || item?.strokeColor;
    const numbers = parseRGB(color);

    return numbers?.length ? !(numbers.length == 4 && numbers[numbers.length - 1] == 0) : false;//!BUG in twotables_1.pdf if strict ===
}

export function hasVectorColor(item: any): boolean {
    return !!(item?.fillColor || item?.strokeColor);
}

/**
* Determines if the area between two points is filled using the evenodd rule.
*
* @param {Object} edgeStart - The starting point of the edge.
* @param {Object} edgeEnd - The end point of the edge.
* @param {Array} allEdges - All edges to verify crossings.
* @returns {boolean} - True if the area is filled.
*/
export function isEdgeFilledEvenOdd(
    edgeStart: any,
    edgeEnd: any,
    allEdges: any[],
): boolean {
    // Check if the start and end points match
    if (edgeStart.x === edgeEnd.x && edgeStart.y === edgeEnd.y) {
        // If it is a closed path, treat it as a filled area
        return true;
    }

    let intersections = 0;
    // Check intersections with other edges
    allEdges.forEach((edge) => {
        if (
            edge !== edgeStart &&
            edge !== edgeEnd &&
            doEdgesIntersect(edge, edgeStart, edgeEnd)
        ) {
            intersections++;
        }
    });
    // Evenodd rule: if the number of intersections is odd, the area is flooded
    return intersections % 2 === 1;
}


/**
 * Checks the intersection of two segments.
 *
 * @param {Object} edge - Edge for verification.
 * @param {Object} edgeStart - The starting point of the current edge.
 * @param {Object} edgeEnd - The end point of the current edge.
 * @returns {boolean} - True if the segments intersect.
 */
function doEdgesIntersect(
    edge: any,
    edgeStart: any,
    edgeEnd: any,
): boolean {
    // Determine the coordinates of the segments
    const x1 = edgeStart.x;
    const y1 = edgeStart.y;
    const x2 = edgeEnd.x;
    const y2 = edgeEnd.y;
    const x3 = edge.x;
    const y3 = edge.y;
    const x4 = edge.x + edge.width;
    const y4 = edge.y + edge.height;

    // We use the axial intersection test
    const o1 = orientation(x1, y1, x2, y2, x3, y3);
    const o2 = orientation(x1, y1, x2, y2, x4, y4);
    const o3 = orientation(x3, y3, x4, y4, x1, y1);
    const o4 = orientation(x3, y3, x4, y4, x2, y2);

    // Crossing check
    if (o1 !== o2 && o3 !== o4) {
        return true;
    }

    return false;
}

/**
 * Defines the orientation of the three points (rotation direction).
 *
 * @param {number} x1 - The x coordinate of the first point.
 * @param {number} y1 - The y coordinate of the first point.
 * @param {number} x2 - The x coordinate of the second point.
 * @param {number} y2 - The y coordinate of the second point.
 * @param {number} x3 - The x coordinate of the third point.
 * @param {number} y3 - The y coordinate of the third point.
 * @returns {number} - 0: collinear, 1: clockwise, 2: counterclockwise.
 */
function orientation(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
): number {
    const val =
        (y2 - y1) * (x3 - x2) -
        (x2 - x1) * (y3 - y2);

    if (val === 0) {
        return 0;// collinear
    }

    return val > 0 ? 1 : 2;// clockwise or counterclockwise
}


// A thin, filled shape of the same color as the fill that touches it
// — is a remnant of the fill strip, not a line.
export function isFillBandRemnant(edge: any, fillRectangles: any[]): boolean {
    if (!edge?.fillColor || edge.strokeColor) {
        return false;
    }
    const thickness = Math.min(edge.width, edge.height);
    if (!(thickness > 0.3)) {
        return false; // Hairlines remain lines
    }
    const gap = Math.max(thickness, 1);
    return fillRectangles.some(
        (rect: any) =>
            rect.fillColor === edge.fillColor &&
            rect.x <= edge.x + edge.width + gap &&
            rect.x + rect.width >= edge.x - gap &&
            rect.y <= edge.y + edge.height + gap &&
            rect.y + rect.height >= edge.y - gap
    );
}