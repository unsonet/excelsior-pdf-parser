import { findMod } from "@unsonet/js-utils";
import { isVisibleVector, isFillBandRemnant } from "./pdf-vector-utils";
import { isHorizontalText } from "./text-geometry";

export function isNumericLikeText(value: any): boolean {
    return /^[\s$€£]?[-−]?\d[\d\s.,]*%?$/.test(String(value || '').trim());
}

// Are there any lines that pass through the interior of the area
// (the table border and the fill border along the edge are not counted)?
export function hasRulesInsideRegion(
    group: any,
    region: { left: number; right: number; top: number; bottom: number },
    margin: number,
    lineMaxWidth: number
): boolean {
    const fillRectangles = (group?.rectangles || []).filter((rect: any) => rect?.fillColor);
    const width = region.right - region.left;
    const height = region.top - region.bottom;

    return (group?.edges || []).some((edge: any) => {
        if (!isVisibleVector(edge) || edge['_isFakeLine'] || isFillBandRemnant(edge, fillRectangles)) {
            return false;
        }
        if (edge.height < lineMaxWidth && edge.width > lineMaxWidth) {
            const y = edge.y + edge.height / 2;
            const overlap = Math.min(edge.x + edge.width, region.right) - Math.max(edge.x, region.left);
            return y > region.bottom + margin && y < region.top - margin && overlap >= width * 0.5;
        }
        if (edge.width < lineMaxWidth && edge.height > lineMaxWidth) {
            const x = edge.x + edge.width / 2;
            const overlap = Math.min(edge.y + edge.height, region.top) - Math.max(edge.y, region.bottom);
            return x > region.left + margin && x < region.right - margin && overlap >= height * 0.5;
        }
        return false;
    });
}

// Displays the grid of a borderless table based on text alignment.
// Returns ONLY the geometry: tableGroup.coordinates blocks are neither created nor modified.
export function inferTextAlignedGrid(tableGroup: any, currentColumnCount: number, lineMaxWidth: number): any {
    const MIN_HEADER_CELLS = 6;
    const MIN_BODY_CELLS = 5;
    const MIN_NUMERIC_CELLS = 3;
    const BODY_FILL_RATIO = 0.75;
    const MAX_SPARSE_ROWS = 2;

    const reject = (reason: string, details: any = {}) => {
        return null;
    };

    if (!Array.isArray(tableGroup?.x) || !Array.isArray(tableGroup?.y)) {
        return reject('group has no bounds');
    }

    const groupLeft = Math.min(...tableGroup.x);
    const groupRight = Math.max(...tableGroup.x);
    const groupTop = Math.max(...tableGroup.y);
    const groupBottom = Math.min(...tableGroup.y);

    // 1. Single-line horizontal blocks within a group (for geometry display only).
    const allBlocks = (tableGroup.coordinates || []).filter(
        (block: any) =>
            block?.str?.trim() &&
            !String(block.str).includes('\n') &&
            [block.x, block.y, block.width, block.height].every(Number.isFinite) &&
            isHorizontalText(block) &&
            block.x >= groupLeft - lineMaxWidth &&
            block.x + block.width <= groupRight + lineMaxWidth &&
            block.y >= groupBottom - lineMaxWidth &&
            block.y <= groupTop + lineMaxWidth
    );
    const unit = +findMod(allBlocks.map((block: any) => block.height)) || 0;
    if (allBlocks.length < MIN_HEADER_CELLS * 2 || !(unit > 0)) {
        return reject('not enough text', { blocks: allBlocks.length });
    }
    const tolerance = unit * 0.3;

    // 2. Fragments within a broader block of the same line are not included in the column output.
    const blocks = allBlocks.filter(
        (candidate: any, index: number) =>
            !allBlocks.some(
                (other: any, otherIndex: number) =>
                    otherIndex !== index &&
                    Math.abs(other.y - candidate.y) <= tolerance &&
                    other.width > candidate.width + tolerance &&
                    other.x <= candidate.x + tolerance &&
                    other.x + other.width >= candidate.x + candidate.width - tolerance
            )
    );

    // 3. Visual lines along the baseline.
    const rows: Array<{ y: number; blocks: any[] }> = [];
    [...blocks]
        .sort((first: any, second: any) => second.y - first.y || first.x - second.x)
        .forEach((block: any) => {
            const row = rows.find(candidate => Math.abs(candidate.y - block.y) <= tolerance);
            if (row) {
                row.blocks.push(block);
            } else {
                rows.push({ y: block.y, blocks: [block] });
            }
        });
    rows.forEach(row => row.blocks.sort((first: any, second: any) => first.x - second.x));

    // 4. The first row of data and the header rows above it.
    const numericCells = (row: any): number =>
        row.blocks.filter((block: any) => isNumericLikeText(block.str)).length;

    const firstBodyIndex = rows.findIndex(
        row => row.blocks.length >= MIN_BODY_CELLS && numericCells(row) >= MIN_NUMERIC_CELLS
    );
    if (firstBodyIndex < 1) {
        return reject('no data row below a header candidate');
    }

    let headerBottomIndex = -1;
    for (let index = firstBodyIndex - 1; index >= 0; index--) {
        if (rows[index].y - rows[firstBodyIndex].y > unit * 3) {
            break;
        }
        if (rows[index].blocks.length >= MIN_HEADER_CELLS) {
            headerBottomIndex = index;
            break;
        }
    }
    if (headerBottomIndex < 0) {
        return reject('no header line above the first data row');
    }

    const headerBottom = rows[headerBottomIndex];
    const upperRow = headerBottomIndex > 0 ? rows[headerBottomIndex - 1] : null;
    const headerTop =
        upperRow && upperRow.blocks.length >= 3 && upperRow.y - headerBottom.y <= unit * 2.5 ? upperRow : null;
    const headerLines = headerTop ? [headerTop, headerBottom] : [headerBottom];

    // 5. Column start positions: the left edge of the cell in the bottom row of the header,
    //    shifted to the left if there is an overlapping cell above it.
    const starts: number[] = [];
    headerBottom.blocks.forEach((block: any) => {
        const overlappingTop = (headerTop ? headerTop.blocks : []).filter(
            (top: any) => top.x < block.x + block.width && top.x + top.width > block.x
        );
        const start = Math.min(block.x, ...overlappingTop.map((top: any) => top.x));
        if (!starts.length || start - starts[starts.length - 1] >= unit) {
            starts.push(start);
        }
    });
    if (starts.length < 4 || starts.length <= currentColumnCount) {
        return reject('text alignment is not finer than the current grid', {
            textColumns: starts.length,
            currentColumns: currentColumnCount
        });
    }

    const margin = unit * 0.5;
    const innerBounds = starts.slice(1).map((start: number) => start - margin);
    const columnOf = (x: number): number => {
        let column = 0;
        while (column < innerBounds.length && x >= innerBounds[column]) {
            column++;
        }
        return column;
    };

    // 6. Body rows: dense rows; up to MAX_SPARSE_ROWS sparse rows are allowed in a row;
    const minPopulated = Math.ceil(starts.length * BODY_FILL_RATIO);
    const populated = (row: any): number => new Set(row.blocks.map((block: any) => columnOf(block.x))).size;

    let lastBodyIndex = firstBodyIndex;
    let sparseRun = 0;
    for (let index = firstBodyIndex; index < rows.length; index++) {
        if (populated(rows[index]) >= minPopulated) {
            lastBodyIndex = index;
            sparseRun = 0;
        } else if (++sparseRun > MAX_SPARSE_ROWS) {
            break;
        }
    }
    const bodyRows = rows.slice(firstBodyIndex, lastBodyIndex + 1);
    if (bodyRows.length < 2) {
        return reject('fewer than two dense data rows');
    }

    // 7. Column and row boundaries.
    const contentBlocks = [...headerLines, ...bodyRows].flatMap((row: any) => row.blocks);
    const bounds = [
        Math.min(...contentBlocks.map((block: any) => block.x)) - margin,
        ...innerBounds,
        Math.max(...contentBlocks.map((block: any) => block.x + block.width)) + margin
    ];

    const baselines = bodyRows.map((row: any) => row.y);
    const lastPitch = baselines[baselines.length - 2] - baselines[baselines.length - 1];
    const headerBaseline = Math.min(...headerLines.flatMap((row: any) => row.blocks).map((block: any) => block.y));
    const headerTopEdge =
        Math.max(...headerLines.flatMap((row: any) => row.blocks).map((block: any) => block.y + block.height)) +
        unit * 0.25;

    const rowBoundaries = [
        headerTopEdge,
        (headerBaseline + baselines[0]) / 2,
        ...baselines.slice(1).map((baseline: number, index: number) => (baselines[index] + baseline) / 2),
        baselines[baselines.length - 1] - lastPitch / 2
    ];

    const left = bounds[0];
    const right = bounds[bounds.length - 1];
    const top = rowBoundaries[0];
    const bottom = rowBoundaries[rowBoundaries.length - 1];

    // If actual rulers pass through the body, that's not the case here.
    if (hasRulesInsideRegion(tableGroup, { left, right, top: rowBoundaries[1], bottom }, unit, lineMaxWidth)) {
        return reject('ruling lines inside the inferred body');
    }


    const headerRange = `${rowBoundaries[0]}-${rowBoundaries[1]}`;
    const headerBlocks = (tableGroup.coordinates || []).filter(
        (block: any) =>
            block?.str?.trim() &&
            Number.isFinite(block.x) &&
            Number.isFinite(block.y) &&
            block.y > rowBoundaries[1] &&
            block.y <= rowBoundaries[0] &&
            block.x >= left &&
            block.x <= right
    );

    return {
        cols: bounds,
        rows: rowBoundaries,
        x: [left, right],
        y: [bottom, top],
        headerRows: { [headerRange]: headerBlocks },
        // “Full” lines so that `createMatrix` doesn't merge cells.
        verticles: bounds.map((x: number) => ({ x, lines: [{ top: bottom, bottom: top }] })),
        horizons: rowBoundaries.map((y: number) => ({ y, lines: [{ left, right }] }))
    };
}