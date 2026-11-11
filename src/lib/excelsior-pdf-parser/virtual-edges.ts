import { uniqueArr, checkRectangleRanges, getOnePercentOfAbsoluteDifference, findMod, findAverage } from "@unsonet/js-utils";
import { getAverageBorderSize } from "./pdf-grid-utils";
import { verifySameResult } from "./pdf-log";
import { hasVectorColor } from "./pdf-vector-utils";
import { createRangeIndex, getBoxRange } from "./range-index";

//Function for generating virtual edges
export function generateVirtualEdges(options) {
    let {
        cols, rows, coordinates, assuredEdges, lineMaxWidth,
        paddingSize, headerRows,
        protectedRows = [],
        leaderBoundaries = []
    } = options;
    cols = [...cols].sort((a, b) => a - b);
    rows = [...rows].sort((a, b) => a - b);
    let verticalAssuredEdges = [];
    let horizontalAssuredEdges = [];
    let headerRowsKeys = uniqueArr(Object.keys(headerRows).map(item => item.split('-').map(i => +i)).flat());
    assuredEdges = assuredEdges.filter(edge => {
        let isVisible = hasVectorColor(edge);
        if (isVisible) {
            if ((edge.height < lineMaxWidth) && (edge.width > lineMaxWidth)) {
                //if (!headerRowsKeys.includes(edge.y)) {//!BUG table.pdf
                horizontalAssuredEdges.push(edge);
                //}
            } else if ((edge.width < lineMaxWidth) && (edge.height > lineMaxWidth)) {
                verticalAssuredEdges.push(edge);
            }
        }
        return isVisible;
    });

    let borderSize = getAverageBorderSize(assuredEdges, lineMaxWidth);
    let deletedEdges = [];

    /**
    * Removes the phantom edge lines of the grid — lines outside the real ones
    * table borders (lines/rectangles) that appeared due to "hanging"
    * text next to the table (footnotes, legends, captions).
    * Such text is completely separated from the nearest real border by a gap,
    * whereas the text of the real cells is adjacent to the borders of its row.
    * We only touch tables with visible horizontal lines: in tables
    * without lines (borderless) the outer rows are formed exclusively by coordinates and are always legitimate.
    */
    function removePhantomBoundaryRows(gridRows) {
        if (!gridRows.length || !horizontalAssuredEdges.length) {
            return gridRows;
        }
        const realYs = [...new Set(horizontalAssuredEdges.map(edge => edge.y))].sort((a, b) => a - b);
        const edgeTolerance = Math.max(lineMaxWidth, borderSize * 2, 1);
        // The text of this cell may slightly extend beyond the border line,  
        // but it does not “float” away from it.  The gap is larger — the size of the tear‑off block.
        const detachTolerance = Math.max(borderSize, 0.5);

        function hasContent(coordinate) {
            return coordinate && (coordinate.str?.trim() || coordinate.imageName);
        }

        function getBox(coordinate) {
            return {
                top: Math.min(coordinate.y, coordinate.y + coordinate.height),
                bottom: Math.max(coordinate.y, coordinate.y + coordinate.height),
            };
        }

        function isPhantomRow(rowY, inwardDir) {
            // The bottom line is phantom only if there is no real line behind the table.
            const hasRealEdge = horizontalAssuredEdges.some(
                edge => Math.abs(edge.y - rowY) <= edgeTolerance
            );
            if (hasRealEdge) {
                return false;
            }
            // The nearest real boundary inside the table
            const inwardRealYs = realYs.filter(y => inwardDir > 0 ? y > rowY : y < rowY);
            if (!inwardRealYs.length) {
                return false;
            }
            const nearestRealY = inwardDir > 0 ? Math.min(...inwardRealYs) : Math.max(...inwardRealYs);
            const content = (coordinates || []).filter(hasContent);
            // The content should not protrude beyond the boundaries of the last row of the grid.
            const hasOutsideContent = content.some(coordinate => {
                const box = getBox(coordinate);
                return inwardDir > 0 ? box.top < rowY : box.bottom > rowY;
            });
            if (hasOutsideContent) {
                return false;
            }
            // The entire strip between the phantom line and the real border should 
            // consist only of text, separated from the real border by a gap.
            const bandCoordinates = content.filter(coordinate => {
                const box = getBox(coordinate);
                return inwardDir > 0
                    ? (box.bottom > rowY && box.top < nearestRealY)
                    : (box.top < rowY && box.bottom > nearestRealY);
            });
            return bandCoordinates.every(coordinate => {
                const box = getBox(coordinate);
                const gap = inwardDir > 0 ? nearestRealY - box.bottom : box.top - nearestRealY;

                // detachTolerance used to be scaled based on the frame stroke width
                // (~0.5–1pt)—this only works for groups with absolutely no actual
                // lines. But as soon as a group contains even one real line
                // (for example, the line under the header in sales_order.pdf), the normal, completely
                // normal indentation of the cell’s text from it (here—7pt at a font size of
                // ~8pt) is much greater than 0.5–1pt and was erroneously considered “detached”
                // content—which caused the actual header border (and subsequently the bottom
                // border of the group) were cropped as phantom elements. Compare the gap with
                // the scale of the text itself (its own height): only a gap
                // that is several times greater than the line height indicates a real separation,
                // rather than the typical cell padding next to the border.
                const contentHeight = Math.max(box.bottom - box.top, 1);
                const contentAwareTolerance = Math.max(detachTolerance, contentHeight * 2);

                return gap > contentAwareTolerance; //!BUG in sales_invoice.pdf (false footer) old: return gap > detachTolerance;
            });
        }

        if (gridRows.length < 2) {
            return gridRows;
        }
        const firstRowY = gridRows[0];
        const lastRowY = gridRows[gridRows.length - 1];
        const filtered = gridRows.filter(rowY => {
            if (rowY === firstRowY && isPhantomRow(rowY, +1)) {
                return false;
            }
            if (rowY === lastRowY && isPhantomRow(rowY, -1)) {
                return false;
            }
            return true;
        });
        // We don’t allow the grid to degenerate into fewer than two rows.
        return filtered.length >= 2 ? filtered : gridRows;
    }

    rows = removePhantomBoundaryRows(rows);//!BUG sales_order.pdf

    // inside generateVirtualEdges — immediately after removePhantomBoundaryRows(rows)
    // intersectingElements depends ONLY on the textBlock, not on the position in the grid.
    // We calculate it once per coordinate instead of recalculating in each grid cell.
    // Vertical lines that cross the row of a text block. Sides of filled rectangles
    // (fake lines) are not drawn lines: counting them made every row of a table with
    // visible cell fills look "crossed by 3+ lines" and all text-inferred column
    // boundaries were deleted.
    const verticalEdgesIndex = createRangeIndex(verticalAssuredEdges, (v: any) => getBoxRange(v.y, v.height));
    const verticalIntersectorsByCoordinate = coordinates.map(textBlock => {
        const isIntersector = (vector: any): boolean => {
            if (vector['_isFakeLine']) return false; //!BUG wrong column length (background_lines_2.pdf)
            const res: any = checkRectangleRanges(vector, { y: [textBlock.y, textBlock.y + textBlock.height] }, { axis: 'y', strict: true, strictIntersecting: true });
            return res.isContained || (!res.biggestArgument && res.isIntersecting);
        };
        const [from, to] = getBoxRange(textBlock.y, textBlock.height);
        const found = verticalEdgesIndex.query(from, to).map(i => verticalAssuredEdges[i]).filter(isIntersector);
        verifySameResult('vertical intersectors', found, () => verticalAssuredEdges.filter(isIntersector));
        return found;
    });

    const horizontalEdgesIndex = createRangeIndex(horizontalAssuredEdges, (v: any) => getBoxRange(v.x, v.width));
    const horizontalIntersectorsByCoordinate = coordinates.map(textBlock => {
        const isIntersector = (vector: any): boolean => {
            //if (vector['_isFakeLine']) return false;
            const res: any = checkRectangleRanges(vector, { x: [textBlock.x, textBlock.x + textBlock.width] }, { axis: 'x', strict: true, strictIntersecting: true });
            return res.isContained || (!res.biggestArgument && res.isIntersecting);
        };
        const [from, to] = getBoxRange(textBlock.x, textBlock.width);
        const found = horizontalEdgesIndex.query(from, to).map(i => horizontalAssuredEdges[i]).filter(isIntersector);
        verifySameResult('horizontal intersectors', found, () => horizontalAssuredEdges.filter(isIntersector));
        return found;
    });

    let isIntersecting = (rect1, rect2) => {
        return (checkRectangleRanges(rect1, rect2, { axis: ['x', 'y'], strictIntersecting: true }) as Array<any>).every(item => item.isIntersecting);
    }

    let headerCoordinatesIndexes = Object.values(headerRows).flat().map((item: any) => item.index);
    let isHeader = (textBlock) => {
        return headerCoordinatesIndexes.includes(textBlock.index);
    };

    function getGridIndex(grid, coordinate) {
        for (let i = 0; i < grid.length - 1; i++) {
            if (coordinate >= grid[i] && coordinate < grid[i + 1]) {
                return i;
            }
        }
        return -1;
    }

    function getRelatedAssuredEdge(edge, assuredEdges) {
        let res;
        let toleranceList = [-(borderSize / 2)];

        for (let index = 0; index < toleranceList.length; index++) {
            const tolerance = toleranceList[index];
            res = assuredEdges.find(vector => {
                let res = (checkRectangleRanges(
                    vector,
                    { x: [edge.x, edge.x + edge.width], y: [edge.y, edge.y + edge.height] },
                    { axis: ['x', 'y'], strict: true, strictIntersecting: true, tolerance }
                ) as Array<any>).every(res => {
                    return res.isContained || (!res.biggestArgument && res.isIntersecting);
                });
                return res;
            });
            if (res) {
                break;
            }
        }
        let positionTolerance = 0.005;
        if (!res) {
            res = assuredEdges.find(item => {
                return (getOnePercentOfAbsoluteDifference(edge.x, item.x) <= positionTolerance) &&
                    (getOnePercentOfAbsoluteDifference(edge.y, item.y) <= positionTolerance);
            });
        }

        return res;
    }

    // ---------------------------------------------------------------------
    // Validating a virtual edge with a real line.
    // getRelatedAssuredEdge does not detect hairline lines (lineWidth = 0) or lines
    // whose edges are shifted by ~1pt due to cols/rows averaging. Therefore, we additionally
    // calculate what proportion of the virtual edge is actually covered by the drawn lines.
    // --------- ------------------------------------------------------------
    const REAL_LINE_BACKED_RATIO = 0.85;   // >= 85% of the edge’s length is covered by an actual line
    const REAL_LINE_MARGINAL_RATIO = 0.15; // < 15% – the line merely “touches” the edge with its tip
    const realLineAxisTolerance = Math.max(borderSize * 3, 1.5);

    function measureRealLineCoverage(edge: any, isHorizontal: boolean): number {
        const pool = isHorizontal ? horizontalAssuredEdges : verticalAssuredEdges;

        const edgeStart = isHorizontal ? edge.x : edge.y;
        const edgeLength = isHorizontal ? edge.width : edge.height;
        const edgeEnd = edgeStart + edgeLength;
        const edgeAxis = isHorizontal
            ? edge.y + edge.height / 2
            : edge.x + edge.width / 2;

        if (!(edgeLength > 0)) {
            return 0;
        }

        const intervals: Array<[number, number]> = [];

        for (const candidate of pool) {
            const candidateAxis = isHorizontal
                ? candidate.y + candidate.height / 2
                : candidate.x + candidate.width / 2;

            if (Math.abs(candidateAxis - edgeAxis) > realLineAxisTolerance) {
                continue;
            }

            const candidateStart = isHorizontal ? candidate.x : candidate.y;
            const candidateEnd =
                candidateStart + (isHorizontal ? candidate.width : candidate.height);

            const from = Math.max(edgeStart, candidateStart);
            const to = Math.min(edgeEnd, candidateEnd);

            if (to > from) {
                intervals.push([from, to]);
            }
        }

        if (!intervals.length) {
            return 0;
        }

        intervals.sort((a, b) => a[0] - b[0]);

        let covered = 0;
        let [currentFrom, currentTo] = intervals[0];

        for (let index = 1; index < intervals.length; index++) {
            const [from, to] = intervals[index];

            if (from <= currentTo) {
                currentTo = Math.max(currentTo, to);
            } else {
                covered += currentTo - currentFrom;
                currentFrom = from;
                currentTo = to;
            }
        }
        covered += currentTo - currentFrom;

        return covered / edgeLength;
    }

    function isEdgeBackedByRealLine(
        edge: any,
        relatedAssuredEdge: any,
        isHorizontal: boolean
    ): boolean {
        const coverage = measureRealLineCoverage(edge, isHorizontal);

        // 1. The actual lines cover (almost) the entire edge.
        if (coverage >= REAL_LINE_BACKED_RATIO) {
            return true;
        }

        // 2. The old logic didn't find anything.
        if (!relatedAssuredEdge) {
            return false;
        }

        // 3. The old logic found a “connected” edge. We retain this behavior,
        //    except when a long line merely touches the edge with its tip
        //    (for example, label 46.6..594.4 and column 18.5..47.5 intersected by 0.9pt).
        const edgeLength = isHorizontal ? edge.width : edge.height;
        const relatedLength = isHorizontal
            ? relatedAssuredEdge.width
            : relatedAssuredEdge.height;

        const isMarginalTouch =
            coverage < REAL_LINE_MARGINAL_RATIO && relatedLength >= edgeLength;

        return !isMarginalTouch;
    }

    // ---- Merged cells: virtual vertical edges that no real line backs --------
    // Rows are assigned exactly as extractTableData() does: by text baseline.
    const columnCount = cols.length - 1;
    const MERGE_CROSS_TOLERANCE = Math.max(borderSize * 2, 1);
    const MIN_NEIGHBOUR_COLUMN_COVERAGE = 0.8;
    const ENABLE_EMPTY_NEIGHBOUR_MERGE = true;

    const getColumnIndexByX = (x: number): number => {
        for (let c = 0; c < columnCount; c++) {
            if (x >= cols[c] && x < cols[c + 1]) {
                return c;
            }
        }

        return -1;
    };

    const getBlockLeft = (block: any): number => {
        return Number(block?.transform?.[4] ?? block?.x);
    }
    const getBlockRight = (block: any): number => {
        return getBlockLeft(block) + Number(block?.width ?? 0);
    };

    // rows are sorted ascending here, so mergeRowInfos[j] is the row
    // between rows[j] (bottom) and rows[j + 1] (top)
    const mergeRowInfos = rows.slice(1).map((topY, index) => {
        const bottomY = rows[index];

        const blocks = coordinates.filter(block => {
            if (!block?.str?.trim()) {
                return false;
            }

            const baseline = Number(block?.transform?.[5] ?? block?.y);

            return Number.isFinite(baseline)
                && baseline > bottomY
                && baseline <= topY;
        });

        const columns = new Set<number>(
            blocks
                .map(block => getColumnIndexByX(getBlockLeft(block)))
                .filter(column => column >= 0)
        );

        return { blocks, columns };
    });

    const populatedRows = mergeRowInfos.filter(row => row.blocks.length > 0);

    const columnCoverage = Array.from({ length: columnCount }, (_, column) =>
        populatedRows.length
            ? populatedRows.filter(row => row.columns.has(column)).length
            / populatedRows.length
            : 0
    );

    // ---- Boxed rows: closed by real rules, but no real inner vertical line --------
    const realHorizontalLines = horizontalAssuredEdges.filter(edge => !edge['_isFakeLine']);
    const realVerticalLines = verticalAssuredEdges.filter(edge => !edge['_isFakeLine']);
    const boxTolerance = Math.max(borderSize * 2, 1);
    // Joints: x positions where one segment of a horizontal rule ends and the next one begins,
    // on at least two rules. Tables drawn cell by cell have such joints even without vertical rules.
    const jointXs: number[] = (() => {
        const axes: Array<{ y: number; segments: Array<{ from: number; to: number }> }> = [];
        realHorizontalLines.forEach(edge => {
            const y = edge.y + edge.height / 2;
            let axis = axes.find(candidate => Math.abs(candidate.y - y) <= 1.5);
            if (!axis) {
                axis = { y, segments: [] };
                axes.push(axis);
            }
            axis.segments.push({ from: edge.x, to: edge.x + edge.width });
        });

        const clusters: Array<{ x: number; axes: Set<number> }> = [];
        axes.forEach((axis, axisIndex) => {
            const sorted = [...axis.segments].sort((a, b) => a.from - b.from);
            for (let index = 1; index < sorted.length; index++) {
                if (Math.abs(sorted[index].from - sorted[index - 1].to) > 1) continue;
                const x = (sorted[index].from + sorted[index - 1].to) / 2;
                let cluster = clusters.find(candidate => Math.abs(candidate.x - x) <= 1.5);
                if (!cluster) {
                    cluster = { x, axes: new Set<number>() };
                    clusters.push(cluster);
                }
                cluster.axes.add(axisIndex);
            }
        });
        return clusters.filter(cluster => cluster.axes.size >= 2).map(cluster => cluster.x);
    })();
    const headerBottom = headerRowsKeys.length ? Math.min(...headerRowsKeys) : -Infinity;
    const realVerticalXs = realVerticalLines.map((edge: any) => edge.x + edge.width / 2);


    // Share of the interval [from, to] covered by the lines that lie on `axis`
    const getLineCoverage = (
        lines: any[],
        isHorizontal: boolean,
        axis: number,
        from: number,
        to: number
    ): number => {
        const length = to - from;

        if (!(length > 0)) {
            return 0;
        }

        let covered = 0;

        lines.forEach(edge => {
            const center = isHorizontal
                ? edge.y + edge.height / 2
                : edge.x + edge.width / 2;

            if (Math.abs(center - axis) > boxTolerance) {
                return;
            }

            const start = isHorizontal ? edge.x : edge.y;
            const end = start + (isHorizontal ? edge.width : edge.height);

            covered += Math.max(0, Math.min(end, to) - Math.max(start, from));
        });

        return Math.min(1, covered / length);
    };

    const isBoxedRowWithoutInnerLines = (rowIndex: number): boolean => {
        const bottom = rows[rowIndex];
        const top = rows[rowIndex + 1];

        if (!Number.isFinite(bottom) || !Number.isFinite(top) || cols.length < 3) {
            return false;
        }

        const left = cols[0];
        const right = cols[cols.length - 1];

        const isClosed =
            getLineCoverage(realHorizontalLines, true, top, left, right) >= 0.85
            && getLineCoverage(realHorizontalLines, true, bottom, left, right) >= 0.85
            && getLineCoverage(realVerticalLines, false, left, bottom, top) >= 0.8
            && getLineCoverage(realVerticalLines, false, right, bottom, top) >= 0.8;

        if (!isClosed) {
            return false;
        }

        for (let boundary = 1; boundary < cols.length - 1; boundary++) {
            if (getLineCoverage(realVerticalLines, false, cols[boundary], bottom, top) >= 0.25) {
                return false;
            }
        }

        return true;
    };

    function getVirtualBoundaryMergeReason(
        borderIndex: number,
        rowIndex: number
    ): string | null {
        const row = mergeRowInfos[rowIndex];

        if (!row || !row.blocks.length || borderIndex < 1 || borderIndex > columnCount - 1) {
            return null;
        }

        const x = cols[borderIndex];
        const leftColumn = borderIndex - 1;
        const rightColumn = borderIndex;

        // A block that starts in the right column means two separate cells.
        if (row.columns.has(rightColumn)) {
            return null;
        }

        // 1. Visible text runs across the separator.
        //    block.width already excludes trailing spaces.
        const getVisibleRight = (block: any): number => {
            const left = getBlockLeft(block);
            const rights = (block.chars || [])
                .filter(
                    (glyph: any) =>
                        glyph &&
                        typeof glyph === 'object' &&
                        typeof glyph.unicode === 'string' &&
                        glyph.unicode.trim() &&
                        Number.isFinite(glyph.x) &&
                        Number.isFinite(glyph.charWidth)
                )
                .map((glyph: any) => glyph.x + glyph.charWidth);
            return rights.length ? Math.max(...rights) : left + Number(block.width);
        };

        const crossesBoundary = row.blocks.some((block: any) => {
            const left = getBlockLeft(block);
            const right = getVisibleRight(block);
            return (
                Number.isFinite(left) &&
                Number.isFinite(right) &&
                left < x - MERGE_CROSS_TOLERANCE &&
                right > x + MERGE_CROSS_TOLERANCE
            );
        });
        if (crossesBoundary) {
            return 'text-crosses-boundary';
        }

        // 2. The row is closed by real rules but has no real inner vertical line:
        //    a column without text of its own is absorbed by its left neighbour.
        if (isBoxedRowWithoutInnerLines(rowIndex)) {
            return 'empty-cell-in-boxed-row';
        }

        // 3. The only empty column of the row is the right neighbour of a
        //    multiline cell, and that column is normally filled in other rows.
        if (!ENABLE_EMPTY_NEIGHBOUR_MERGE) {
            return null;
        }

        const emptyColumns: number[] = [];

        for (let column = 0; column < columnCount; column++) {
            if (!row.columns.has(column)) {
                emptyColumns.push(column);
            }
        }

        if (emptyColumns.length !== 1 || emptyColumns[0] !== rightColumn) {
            return null;
        }

        const hasMultilineLeftCell = row.blocks.some(block =>
            getColumnIndexByX(getBlockLeft(block)) === leftColumn
            && String(block.str || '').includes('\n')
        );

        return hasMultilineLeftCell
            && columnCoverage[rightColumn] >= MIN_NEIGHBOUR_COLUMN_COVERAGE
            ? 'empty-neighbour-of-multiline-cell'
            : null;
    }

    const verticalBlockers = coordinates.filter(
        (_, k) => uniqueArr(verticalIntersectorsByCoordinate[k], 'x').length > 2
    );
    let verticalEdges = [];
    for (let i = 0; i < cols.length; i++) {
        // The left and right boundaries of the table are not suppressed
        // (same as isOuterBoundary for the first/last row)
        const isOuterBoundary = (i === 0 || i === cols.length - 1);

        for (let j = 0; j < rows.length - 1; j++) {
            let x = cols[i];
            let nextY = rows[j + 1];
            let y = rows[j];
            let edge = { x: x, y: y, width: borderSize, height: nextY - y };
            let isIntersectingTextBlock = false;

            // Does not depend on textBlock; count once per edge
            let relatedAssuredEdge = getRelatedAssuredEdge(edge, verticalAssuredEdges);
            if (relatedAssuredEdge) {
                if (!edge['strokeColor']) {
                    edge['strokeColor'] = relatedAssuredEdge.strokeColor || relatedAssuredEdge.fillColor;
                    edge['_isFakeLine'] = true;
                }
            }

            // A joint is a column boundary where the row has text on both sides: a group header
            // that spans several columns has no text beside the joint and stays merged.
            const rowInfo = mergeRowInfos[j];
            let isJointBoundary = false;

            if (!isOuterBoundary && rowInfo && jointXs.some(jointX => Math.abs(jointX - x) <= 2)) {
                if (rows[j] >= headerBottom - 0.5) {
                    // Header row: both neighbouring columns carry their own labels. A group label that
                    // spans several columns has no text beside the joint and stays merged.
                    isJointBoundary = rowInfo.columns.has(i - 1) && rowInfo.columns.has(i);
                } else {
                    // Body row: the columns of a group are kept as long as the row has any text inside the
                    // group, so that an empty cell does not turn into a colspan.
                    const leftRule = Math.max(cols[0], ...realVerticalXs.filter((ruleX: number) => ruleX < x - 2));
                    const rightRule = Math.min(
                        cols[cols.length - 1],
                        ...realVerticalXs.filter((ruleX: number) => ruleX > x + 2)
                    );
                    isJointBoundary = isJointBoundary = rowInfo.blocks.some((block: any) => {
                        const left = getBlockLeft(block);
                        const right = getBlockRight(block);

                        const overlapsGroup =
                            left < rightRule + 1 &&
                            right > leftRule - 1;

                        const crossesJoint =
                            left < x - 1 &&
                            right > x + 1;

                        return overlapsGroup && !crossesJoint;
                    });
                }
            }

            let isProtectedEdge =
                isOuterBoundary ||
                isJointBoundary || //! BUG in missing_values.pdf (wrong border-top in cells)
                isEdgeBackedByRealLine(edge, relatedAssuredEdge, false);

            const mergeReason = isProtectedEdge
                ? null
                : getVirtualBoundaryMergeReason(i, j);
            const isSuppressedByMerge = mergeReason !== null;

            if (isSuppressedByMerge) {
                deletedEdges.push(edge);
            }

            if (!isProtectedEdge) {
                for (const textBlock of verticalBlockers) {
                    const edgeOnSameAxis = (
                        checkRectangleRanges(edge, { y: [textBlock.y, textBlock.y + textBlock.height] }, { axis: 'y', strict: true, strictIntersecting: true }) as any
                    ).isIntersecting;
                    if (edgeOnSameAxis) {
                        isIntersectingTextBlock = true;
                        deletedEdges.push(edge);
                        break;
                    }
                }
            }

            if (!isIntersectingTextBlock && !isSuppressedByMerge) {
                let newEdge: any = edge;

                if (!newEdge.used) {
                    newEdge.used = true;
                    verticalEdges.push(newEdge);
                }
            }
        }
    }

    let sortedRowsForGap = [...rows].sort((a, b) => a - b);
    let rowGapsForSuppression = sortedRowsForGap.slice(1).map((y, i) => y - sortedRowsForGap[i]).filter(g => g > 0);
    let modalRowHeightForSuppression = +findMod(rowGapsForSuppression) || findAverage(rowGapsForSuppression) || 20;
    let yProximityTolerance = modalRowHeightForSuppression * 1.5;

    let leaderProtectedCount = 0;
    const horizontalBlockers = coordinates.filter((textBlock, k) => {
        let intersectingGridItems = uniqueArr(horizontalIntersectorsByCoordinate[k], 'y');
        if (!isHeader(textBlock)) {
            intersectingGridItems = intersectingGridItems.filter(
                item =>
                    !headerRowsKeys.some(key =>
                        (checkRectangleRanges({ y: item.y }, { y: key }, { axis: ['y'], strictIntersecting: true, tolerance: 1 }) as Array<any>).every(
                            res => res.isIntersecting
                        )
                    )
            );
        }
        return intersectingGridItems.length > 3;
    });
    let horizontalEdges = [];
    for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < cols.length - 1; j++) {
            let x = cols[j];
            let nextX = cols[j + 1];
            let y = rows[i];
            let edge = { x: x, y: y, width: nextX - x, height: borderSize };
            let isIntersectingTextBlock: any = false;
            let isOuterBoundary = (i === 0 || i === rows.length - 1);

            // A row boundary synthesized from a text gap has no line behind it by
            // definition, so the "text crosses many lines" heuristic must not drop it.
            const isSynthesizedBoundary = protectedRows.some(
                (y: number) => Math.abs(y - rows[i]) < 0.01
            );


            // Count once per edge
            let relatedAssuredEdge = getRelatedAssuredEdge(edge, horizontalAssuredEdges);
            if (relatedAssuredEdge) {
                if (!edge['strokeColor']) {
                    edge['strokeColor'] = relatedAssuredEdge.strokeColor || relatedAssuredEdge.fillColor;
                    edge['_isFakeLine'] = true;
                }
            }

            const isLeaderBoundary = leaderBoundaries.some(boundary => {
                if (Math.abs(boundary.y - rows[i]) >= 0.01) {
                    return false;
                }
                const overlap = Math.min(edge.x + edge.width, boundary.x2) - Math.max(edge.x, boundary.x1);
                return overlap >= edge.width * 0.5;
            });
            if (isLeaderBoundary) {
                leaderProtectedCount++;
            }
            let isProtectedEdge =
                isOuterBoundary ||
                isSynthesizedBoundary ||
                isLeaderBoundary ||
                isEdgeBackedByRealLine(edge, relatedAssuredEdge, true);

            if (!isProtectedEdge) {
                for (const textBlock of horizontalBlockers) {
                    const edgeOnSameAxis = (
                        checkRectangleRanges(edge, { x: [textBlock.x, textBlock.x + textBlock.width] }, { axis: 'x', strict: true, strictIntersecting: true }) as any
                    ).isIntersecting;
                    if (edgeOnSameAxis) {
                        isIntersectingTextBlock = true;
                        deletedEdges.push(edge);
                        break;
                    }
                }
            }

            if (!isIntersectingTextBlock) {
                let newEdge: any = edge;
                if (!newEdge.used) {
                    newEdge.used = true;
                    horizontalEdges.push(newEdge);
                }
            }
        }
    }

    let edges = [...verticalEdges, ...horizontalEdges];
    return edges;
}

export function createLinesFromRectangle(rectangle, borderSize) {
    const { y, x, width, height } = rectangle;
    const color = rectangle.strokeColor || rectangle.fillColor || "rgba(0,0,0,0)";
    const _isFakeLine = true;
    const edges = [
        { x: x, y: y, width: width, height: borderSize, transform: [1, 0, 0, 1, 0, 0], strokeColor: color, _isFakeLine },
        { x: x + width, y: y, width: borderSize, height: height, transform: [1, 0, 0, 1, 0, 0], strokeColor: color, _isFakeLine },
        { x: x, y: y + height, width: width, height: borderSize, transform: [1, 0, 0, 1, 0, 0], strokeColor: color, _isFakeLine },
        { x: x, y: y, width: borderSize, height: height, transform: [1, 0, 0, 1, 0, 0], strokeColor: color, _isFakeLine }
    ];
    return edges;
}