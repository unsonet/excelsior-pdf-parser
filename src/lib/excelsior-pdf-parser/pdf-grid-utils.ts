
import {
    findAverage,
    findMod,
    uniqueArr,
} from '@unsonet/js-utils';

import { isVisibleVector } from './pdf-vector-utils';

//Function for combining close coordinates
export function mergeCoordinates(
    coordinates: any[],
    fixedCoordinates: number[],
    options: any,
): number[] {
    const {
        threshold = 2.5,
        averageMerge = false,
        specialMode = false,
        preferLarger = false,
    } = options;

    if (!coordinates || coordinates.length === 0) {
        return [];
    }

    const mergedCoordinates: number[] = [];
    let i = 0;

    while (i < coordinates.length) {
        const currentCoordinate = coordinates[i];
        const isFixed = fixedCoordinates.includes(currentCoordinate);
        const tempCoords = [currentCoordinate];
        let j = i + 1;

        while (
            j < coordinates.length &&
            Math.abs(coordinates[j] - currentCoordinate) < threshold
        ) {
            if (fixedCoordinates.includes(coordinates[j])) {
                tempCoords.push(coordinates[j]);
                break;
            }

            if (
                specialMode &&
                !isFixed &&
                !fixedCoordinates.includes(coordinates[j])
            ) {
                j++;
                continue;
            }

            tempCoords.push(coordinates[j]);
            j++;
        }

        if (tempCoords.length > 1) {
            if (tempCoords.some((coord) => fixedCoordinates.includes(coord))) {
                //If there is a fixed coordinate, it has priority
                mergedCoordinates.push(
                    ...tempCoords.filter((coord) => fixedCoordinates.includes(coord)),
                );
            } else if (averageMerge) {
                const average =
                    tempCoords.reduce((sum, coord) => sum + coord, 0) /
                    tempCoords.length;

                mergedCoordinates.push(average);
            } else {
                const maxCoordinate = Math.max(...tempCoords);
                const minCoordinate = Math.min(...tempCoords);

                mergedCoordinates.push(
                    preferLarger ? maxCoordinate : minCoordinate,
                );
            }
        } else {
            mergedCoordinates.push(currentCoordinate);
        }

        i = j;
    }

    return uniqueArr(mergedCoordinates);
}

export function getAverageBorderSize(
    edges: any[],
    lineMaxWidth: number,
): number {
    const defaultBorderSize = 0.57;
    const widths: number[] = [];

    for (let index = 0; index < edges.length; index++) {
        const item = edges[index];

        if (item.height < lineMaxWidth) {
            widths.push(item.height);
        }

        if (item.width < lineMaxWidth) {
            widths.push(item.width);
        }
    }

    return +findMod(widths) || defaultBorderSize;
}

export function calculateEdgeToleranceValue(
    edges: any[],
    lineMaxWidth: number,
): number | null {
    const horizontalEdges = (edges || []).filter(
        (edge) =>
            isVisibleVector(edge) &&
            edge.height < lineMaxWidth &&
            edge.width > lineMaxWidth,
    );

    if (horizontalEdges.length < 2) {
        return null;
    }

    const ys = uniqueArr(horizontalEdges.map((edge) => edge.y)).sort(
        (a, b) => a - b,
    );

    const gaps = ys
        .slice(1)
        .map((y, index) => y - ys[index])
        .filter((gap) => gap > 0);

    if (!gaps.length) {
        return null;
    }

    return +findMod(gaps) || findAverage(gaps);
}

export function calculateToleranceValue(coordinates) {
    //Find the modulus of text height
    let modeTextHeight = findMod(coordinates.map(item => item.height));

    // The baseline of a single visual line may vary by tenths of a point
    // (Td ty = ±0.014 em); this must be a SINGLE line key. Otherwise, the even/odd
    // processing described below will measure the jitter instead of the spacing between lines.
    const baselineJitter = Math.min(0.5, modeTextHeight * 0.1);
    const sortedBaselines = [...new Set<number>(coordinates.map(item => item.y))].sort((a, b) => a - b);
    const baselineKeys = new Map<number, number>();
    let clusterStart = -Infinity;

    for (const baseline of sortedBaselines) {
        if (baseline - clusterStart > baselineJitter) {
            clusterStart = baseline;
        }
        baselineKeys.set(baseline, clusterStart);
    }

    //Create an object with y-coordinates grouping
    let obj = coordinates.reduce((prev, cur) => {
        const key = baselineKeys.get(cur.y);
        prev[key] = [...(prev[key] || []), cur.y + cur.height];
        return prev;
    }, {});

    //Sort object keys
    let sortedKeys = Object.keys(obj).sort((a: any, b: any) => a - b);
    //Create a data array by alternating keys and values
    let data = sortedKeys.reduce((prev, key: any, index) => {
        let value = +findMod(obj[key]);
        key = +key;
        if (index % 2) {
            prev.push(key);
        } else {
            prev.push(value);
        }
        return prev;
    }, [])
        .sort((a, b) => a - b);

    //Calculate distances between elements of a data array and filter them out
    let distances = data.slice(1).reduce((prev, cur, index) => {
        let distance = cur - data[index];
        if (distance < modeTextHeight * 2 && distance > modeTextHeight / 2) {
            prev.push(distance);
        }
        return prev;
    }, []);

    //Calculate the average of the distances and divide by 2
    let averageDistance = (findAverage(distances) + (+findMod(distances))) / 2;//old: findAverage(distances)/2 

    return averageDistance;
}

/**
 * Pairs of adjacent grid lines that coincide with the edges of a narrow fill strip
 * (a decorative cell fill-edge, ~5pt wide) are merged into a single line.
 * Actual lines with a gap of 5–8pt are not merged by `mergeCoordinates` (threshold = `lineMaxWidth`),
 * which causes each strip to generate a phantom column/row.
 */
export function collapseStripGridLines(
    lines: number[],
    rectangles: any[],
    edges: any[],
    lineMaxWidth: number,
    axis: 'x' | 'y'
): number[] {
    const minGap = lineMaxWidth + 0.01;   // уже должны были смержиться
    const maxGap = lineMaxWidth * 1.6;    // 8 при lineMaxWidth = 5
    const visibleEdges = (edges || []).filter((edge: any) => isVisibleVector(edge));
    const distToStroke = (value: number): number => {
        let best = Infinity;
        for (const edge of visibleEdges) {
            const axisValue = axis === 'x' ? edge.x : edge.y;
            const perpendicular = axis === 'x' ? edge.height : edge.width;
            if (perpendicular > lineMaxWidth * 1.5) continue; // fill, not a line
            best = Math.min(best, Math.abs(axisValue - value));
        }
        return best;
    };
    const fillRects = (rectangles || []).filter(
        (rect: any) => rect?.fillColor && isVisibleVector(rect)
    );
    const sorted = [...new Set(lines.filter(Number.isFinite))].sort((a, b) => a - b);
    const removed = new Set<number>();
    for (let i = 0; i < sorted.length - 1; i++) {
        const first = sorted[i];
        const second = sorted[i + 1];
        if (removed.has(first)) continue;
        const gap = second - first;
        if (gap <= minGap || gap > maxGap) continue;
        const isStripEdgePair = fillRects.some((rect: any) => {
            const start = axis === 'x'
                ? Math.min(rect.x, rect.x + rect.width)
                : Math.min(rect.y, rect.y + rect.height);
            const end = axis === 'x'
                ? Math.max(rect.x, rect.x + rect.width)
                : Math.max(rect.y, rect.y + rect.height);
            const stripThickness = axis === 'x' ? Math.abs(rect.width) : Math.abs(rect.height);
            if (stripThickness > maxGap) return false;
            return Math.abs(start - first) <= 0.8 && Math.abs(end - second) <= 0.8;
        });
        if (!isStripEdgePair) continue;
        // Keep the line closest to the actual stroke (158.561 > 152.039; 514.919 > 520.32)
        const keepFirst = distToStroke(first) <= distToStroke(second) - 0.01;
        removed.add(keepFirst ? second : first);
    }
    const result = sorted.filter((value) => !removed.has(value));
    if (result.length !== sorted.length) {
        console.error('[STRIP LINES COLLAPSED]', {
            axis,
            removed: sorted.filter((v) => removed.has(v)).map((v) => +v.toFixed(2)),
        });
    }
    return result.length >= 2 ? result : sorted;
}
