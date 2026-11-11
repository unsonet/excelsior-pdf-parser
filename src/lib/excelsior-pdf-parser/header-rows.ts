import { findMod, isSequentialIndexRow } from "@unsonet/js-utils";
import { filterBlocks } from "./filter-blocks";
import { isVisibleVector } from "./pdf-vector-utils";
import { isHeaderIndicator } from "./header-indicator";
import { DEBUG_LOG } from "./pdf-log";

export function countProperties(arr) {
    const result = {};

    arr.forEach(obj => {
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                if (!result[key]) {
                    result[key] = {};
                }
                const value = obj[key];
                if (!result[key][value]) {
                    result[key][value] = 0;
                }
                result[key][value]++;
            }
        }
    });

    return result;
}

export function isCaptionBlock(options) {
    const {
        block,
        edges,
        coordinates,
        lineMaxWidth,
    } = options;

    if (!block || !edges?.length || !coordinates?.length) {
        return false;
    }

    const verticalEdges = edges.filter(edge => {
        return (
            isVisibleVector(edge) &&
            edge.width < lineMaxWidth &&
            edge.height > lineMaxWidth
        );
    });

    if (!verticalEdges.length) {
        return false;
    }

    // Exclude the candidate itself when calculating the content bounds.
    const otherCoordinates = coordinates.filter(item => {
        if (!item?.str?.trim()) {
            return false;
        }

        if (item === block) {
            return false;
        }

        if (
            block.index != null &&
            item.index === block.index
        ) {
            return false;
        }

        return true;
    });

    if (!otherCoordinates.length) {
        return false;
    }

    const getVerticalBounds = item => {
        const y1 = item.y;
        const y2 = item.y + item.height;

        return {
            minY: Math.min(y1, y2),
            maxY: Math.max(y1, y2),
        };
    };

    const otherBounds = otherCoordinates.map(getVerticalBounds);

    const contentMinY = Math.min(
        ...otherBounds.map(bounds => bounds.minY)
    );

    const contentMaxY = Math.max(
        ...otherBounds.map(bounds => bounds.maxY)
    );

    const blockBounds = getVerticalBounds(block);
    const verticalGapTolerance = Math.max(
        lineMaxWidth * 0.5,
        Math.min(Math.abs(block.height || 0), 10) * 0.5
    );

    // A caption below or above the table must be separated from
    // the remaining text, not merely aligned with its outer border.
    const outsideContentRange =
        blockBounds.maxY < contentMinY - verticalGapTolerance ||
        blockBounds.minY > contentMaxY + verticalGapTolerance;

    const horizontalEdges = edges.filter(edge => {
        return (
            isVisibleVector(edge) &&
            edge.height < lineMaxWidth &&
            edge.width > lineMaxWidth
        );
    });

    const overlapsBlockX = edge => {
        return (
            edge.x <= block.x + block.width &&
            edge.x + edge.width >= block.x
        );
    };

    // Preserve the previous behaviour for blocks inside the
    // content range. A single nearby border must not, however,
    // prevent an outside caption from being detected.
    const blockHasHorizontalBorder = horizontalEdges.some(edge => {
        const yMatchTop =
            Math.abs(edge.y - block.y) < lineMaxWidth * 2;

        const yMatchBottom =
            Math.abs(
                edge.y - (block.y + block.height)
            ) < lineMaxWidth * 2;

        return (
            (yMatchTop || yMatchBottom) &&
            overlapsBlockX(edge)
        );
    });

    const dividersInBlock = filterBlocks(
        verticalEdges,
        {
            x: [
                block.x + 1,
                block.x + block.width - 1,
            ],
            y: [
                contentMinY,
                contentMaxY,
            ],
            strictIntersecting: true,
        }
    );

    // Count distinct column separators, not their Y coordinates.
    // Several line segments at the same X represent one separator.
    const uniqueDividerXs = [
        ...new Set(
            dividersInBlock.map(edge => {
                return Math.round(edge.x * 10) / 10;
            })
        ),
    ];

    if (outsideContentRange) {
        const blockCenterY =
            (blockBounds.minY + blockBounds.maxY) / 2;

        const borderSideTolerance = Math.max(
            1,
            Math.min(
                lineMaxWidth * 0.5,
                Math.abs(block.height || 0) * 0.25
            )
        );

        const hasHorizontalBorderAbove = horizontalEdges.some(edge => {
            const edgeCenterY = edge.y + edge.height / 2;

            return (
                overlapsBlockX(edge) &&
                edgeCenterY > blockCenterY + borderSideTolerance
            );
        });

        const hasHorizontalBorderBelow = horizontalEdges.some(edge => {
            const edgeCenterY = edge.y + edge.height / 2;

            return (
                overlapsBlockX(edge) &&
                edgeCenterY < blockCenterY - borderSideTolerance
            );
        });

        // A genuine table cell is enclosed by boundaries on both
        // sides. A caption outside the table usually has only the
        // nearby outer table boundary on one side.
        if (
            hasHorizontalBorderAbove &&
            hasHorizontalBorderBelow
        ) {
            return false;
        }

        // A detached text block crossing multiple columns is a
        // caption, not content for the cell containing its left edge.
        return uniqueDividerXs.length >= 2;
    }

    if (blockHasHorizontalBorder) {
        return false;
    }

    // Keep the original heuristic for candidates within the content
    // range to avoid changing existing table-header behaviour.
    const uniqueY = [
        ...new Set(
            dividersInBlock.map(edge => edge.y)
        ),
    ];

    return uniqueY.length >= 2;
}

export function determineHeaderRows(options) {
    let {
        coordinates,
        rows,
        edges,
        rectangles,
        lineMaxWidth,
        customConditionFn,
        cols,
        separatorRows = [],
    } = options;

    let allPropertiesCounter = countProperties(coordinates?.filter(item => item?.str) || []);

    let targetPropertiesWeight = {
        'fillColor': 1,
        'strokeColor': 1,
        'fontName': 1,
        'height': 0.9
    };
    const TOP_ROW_UNIFORM_SHARE = 0.75;

    let targetProperties = Object.keys(targetPropertiesWeight).filter(prop => Object.keys(allPropertiesCounter?.[prop] || {})?.length > 1);
    let modeProperties = targetProperties.reduce((prev, cur) => {
        let keys = Object.keys(allPropertiesCounter[cur]);
        let values = Object.values(allPropertiesCounter[cur]) as Array<any>;
        prev[cur] = keys.find(item => allPropertiesCounter[cur][item] == Math.max(...values));
        return prev;
    }, {});

    let headersCombo: Array<any> = [];
    let defaultHeaderRows = {};

    let setDefaultHeaderRows = (headersCombo) => {
        for (let index = 0; index < headersCombo.length; index++) {
            const item = headersCombo[index];
            if (index == 0) {
                defaultHeaderRows[item.rangeStr] = item.textBlocks;
            } else {
                //The number of text items in the current row is greater than the number of items in the previous row (merged headers indicator)
                if (headersCombo[index - 1] && item?.textBlocks?.length > headersCombo?.[index - 1]?.textBlocks?.length) {
                    defaultHeaderRows[item.rangeStr] = item.textBlocks;
                } else {
                    break;
                }
            }
        }
    };

    function getOccupiedColumnBins(blocks, colsArr) {
        const sortedCols = [...(colsArr || [])].sort((a, b) => a - b);
        const bins = new Set();
        (blocks || []).forEach(block => {
            if (!block) return;
            const centerX = (block.x ?? 0) + (block.width || 0) / 2;
            for (let ci = 0; ci < sortedCols.length - 1; ci++) {
                if (centerX >= sortedCols[ci] && centerX < sortedCols[ci + 1]) {
                    bins.add(ci);
                    break;
                }
            }
        });
        return bins;
    }

    let cumulativeOccupiedCols = new Set();

    const maxVerticalBorderWidth = (edges || []).reduce(
        (max, edge) =>
            isVisibleVector(edge) && edge.width < lineMaxWidth && edge.height > lineMaxWidth
                ? Math.max(edge.width, max)
                : max,
        0
    );

    const taggedElements = [
        ...(coordinates || []).map(item => Object.assign({}, item, { vectorType: 'coordinate' })),
        ...(edges || []).map(item => Object.assign({}, item, { vectorType: 'edge' })),
        ...(rectangles || []).map(item => Object.assign({}, item, { vectorType: 'rectangle' }))
    ];

    let headerRows = rows.sort((a, b) => b - a).reduce((prev, item, index, arr) => {
        let nextItem = arr[index + 1];
        if (nextItem) {
            let range = [item, nextItem];
            let rangeStr = range.join('-');

            const medianBorderWidth = maxVerticalBorderWidth;

            const rangeMargin = Math.max(medianBorderWidth * 2, 0.5);//old:(medianBorderWidth * 2)
            let textBlocks = filterBlocks(coordinates.filter(item => item?.str), {
                'y': range.map((r, i) => (i == 0 ? r - rangeMargin : r + rangeMargin)),
                strictIntersecting: true
            });
            // GUARD: single-block line at the edge of the table = caption?
            if (textBlocks.length === 1 && edges?.length) {
                let isFirstOrLastRow = (index === 0) || (index >= arr.length - 2);
                if (!isFirstOrLastRow) return prev;

                let tb = textBlocks[0];

                if (isCaptionBlock({
                    block: tb,
                    edges,
                    coordinates,
                    lineMaxWidth
                })) {
                    return prev;
                }
            }
            // --- END GUARD ---

            let currentHeaderCombo = headersCombo[headersCombo.length - 1];
            let lastTruthHeaderCombo = headersCombo?.findLast(item => item.isHeader == true);
            let hasDuplicateCopies = currentHeaderCombo ? textBlocks.some(item => currentHeaderCombo.textBlocks.map(item => JSON.stringify(item)).includes(JSON.stringify(item))) : false;//contains duplicate header values

            // The number of text blocks in a row is an unreliable indicator that the “header”
            // has ended: a rowspan cell (e.g., “State”) may fall within
            // the textBlocks of only ONE of its rows—depending on where
            // the text is physically rendered within the tall merged cell.
            // Therefore, adjacent header rows sometimes have FEWER raw elements
            // than the data row following them, and the old “count
            // is increasing” check erroneously continued to treat the data row as part of the header.
            //
            // Instead of the number of elements, we compare which GRID COLUMNS are occupied:
            // if the already confirmed part of the header (cumulatively) covers ALL
            // columns, and the next row BY ITSELF (without taking previous rows into account)
            // also covers ALL columns—then there is nothing left to split; this is
            // data. The exception is an enumeration row (1,2,3... / a,b,c... /
            // i,ii,iii...), which is often used simply for navigating
            // columns and should not conclude the header.
            let hasColsInfo = Array.isArray(cols) && cols.length > 1;
            let rowOccupiedCols = hasColsInfo ? getOccupiedColumnBins(textBlocks, cols) : null;
            let fullColsCount = hasColsInfo ? (cols.length - 1) : 0;


            let isSequential = isSequentialIndexRow(
                [...textBlocks]
                    .sort((a, b) => a.x - b.x)
                    .map(block => (block?.str || '').trim())
                    .filter(Boolean)
            )

            const followsHeader =
                currentHeaderCombo != undefined
                && !!lastTruthHeaderCombo
                && currentHeaderCombo == lastTruthHeaderCombo;

            // A numbering row ("1 | 2= (3 to 6)+14 | 3 | ...") labels the columns.
            // Blocks are sorted left to right: the Tj order of such rows is not spatial.
            const isIndexRow =
                hasColsInfo
                && textBlocks.length > 1
                && isSequential;

            // Directly under the header and spanning most of the columns: part of the header,
            // even though it has no more blocks than the header row above it.
            const continuesHeaderAsIndexRow =
                isIndexRow
                && followsHeader
                && rowOccupiedCols.size >= Math.ceil(fullColsCount * 0.7);


            let columnsSignalHeaderEnded = !!(
                hasColsInfo &&
                followsHeader &&
                cumulativeOccupiedCols.size >= fullColsCount &&
                rowOccupiedCols.size >= fullColsCount &&
                !isIndexRow
            );

            if (
                textBlocks?.length && !columnsSignalHeaderEnded
                && (//The number of text items in the current row is greater than the number of items in the previous row (merged headings indicator)
                    continuesHeaderAsIndexRow
                    || (
                        followsHeader
                            ? (currentHeaderCombo.textBlocks.length < textBlocks.length || hasDuplicateCopies)
                            : true
                    )
                )
            ) {

                let propertiesCounter = countProperties(textBlocks);
                let currentTargetProperties = targetProperties.filter(prop => Object.keys(propertiesCounter?.[prop] || {})?.length > 1);
                let headerConditions = [];

                // A plain integer (for example, the year “2010” or a column
                // number) is a typical form for a HEADER, not for data. A fractional
                // number (23.65, 0.86), on the other hand, is a typical form for actual table values.
                // Previously, the regular expression treated both variants as “numbers,” which caused a string
                // with year headers (“2010 | 2009 | 2008”) to be mistakenly classified under
                // the same heuristic as an actual data string, and it was moved from
                // the header to the body of the table.
                let numericBlocksCount = textBlocks.filter(textBlock =>
                    /^[-+]?\d+[.,]\d+$/.test(
                        String(textBlock?.str || '').trim()
                    )
                ).length;

                let isMajorityNumericRow =
                    textBlocks.length > 0 &&
                    numericBlocksCount > textBlocks.length / 2;

                // Header cells of a ruled table are separated by visible vertical rules running through the row.
                // Stacked lines of a paragraph (footnotes, captions) are split into columns by text alignment only.
                let rowHasColumnRules = false;

                if (index === 0 && textBlocks.length >= 4) {
                    const rowLeft = Math.min(...textBlocks.map(block => block.x));
                    const rowRight = Math.max(...textBlocks.map(block => block.x + block.width));
                    const rowHeight = range[0] - range[1];
                    const dividerXs = new Set<number>();

                    for (const edge of edges) {
                        const isVerticalRule =
                            isVisibleVector(edge) && !edge['_isFakeLine'] && edge.width < lineMaxWidth && edge.height > lineMaxWidth;
                        if (!isVerticalRule) {
                            continue;
                        }

                        const center = edge.x + edge.width / 2;
                        const overlap = Math.min(edge.y + edge.height, range[0]) - Math.max(edge.y, range[1]);
                        const coversRow = overlap >= rowHeight * 0.5;
                        const isBetweenCells = center > rowLeft + 1 && center < rowRight - 1;

                        if (coversRow && isBetweenCells) {
                            dividerXs.add(Math.round(center));
                        }
                    }

                    rowHasColumnRules = dividerXs.size >= 3;
                    DEBUG_LOG && console.error('[TOP ROW STYLE]', { range, blocks: textBlocks.length, dividers: dividerXs.size });
                }

                textBlocks?.forEach(textBlock => {


                    const boundaryY = (element: any) =>
                        element.vectorType === 'rectangle' && element.y + element.height <= textBlock.y + 0.5
                            ? element.y + element.height
                            : element.y;

                    let bottomElementsCache: any[] | null = null;
                    const getBottomElements = (): any[] => {
                        if (!bottomElementsCache) {
                            bottomElementsCache = filterBlocks(taggedElements, {
                                x: [textBlock.x, textBlock.x + textBlock.width],
                                y: [textBlock.y, 0],
                                strictIntersecting: true
                            })
                                .filter((item: any) => (item.vectorType == 'coordinate' ? true : isVisibleVector(item)))//old:item.strokeColor || item.fillColor
                                .sort((a: any, b: any) => boundaryY(b) - boundaryY(a));//old:  (b.y - a.y)
                        }
                        return bottomElementsCache;
                    };


                    if (customConditionFn) {
                        let customCondition = customConditionFn({
                            textBlock, item, nextItem
                        });
                        headerConditions.push(customCondition);
                    }

                    let hasUniformStr = Object.values(propertiesCounter?.['str'] || {})
                        .reduce((prev, cur) => Number(prev) + Number(cur), 0) === textBlocks?.length;

                    let hasDistinctStyle = true;
                    if (targetProperties.length) {
                        let styleChecks = targetProperties.map(prop => {
                            let propExceptions = ['height'];
                            if (propExceptions.includes(prop)) return true;
                            return textBlock?.[prop] !== modeProperties[prop];
                        });
                        hasDistinctStyle = styleChecks.length > 2
                            ? findMod(styleChecks) === 'true'
                            : styleChecks.some(item => item);
                    }

                    // Rowspan cells (for example, rotated column headers that span
                    // both rows of the header) will always be “unique” in height within
                    // the range of a SINGLE sub-row—their own height (~100+) is much
                    // greater than the height of the range itself (~45–70), and cannot
                    // coincide with any other element within it. The check “most elements share this
                    // height" essentially checks for typicality WITHIN a single row, not whether
                    // “an element spans multiple rows”—and the absolute threshold
                    // (total * 0.1) also depends on the total number of
                    // elements that fell within the range, which is why the same rowspan block
                    // could pass the check in a narrow range but fail in a wider one.
                    // If the block’s own height is significantly greater than the height of the current
                    // range—this is a structural indicator of a rowspan—and we simply skip this check
                    // for it.
                    let rowRangeHeight = Math.abs(range[0] - range[1]);
                    let spansBeyondThisRow = (textBlock?.height || 0) > rowRangeHeight * 1.1;

                    let hasMajorityStyle = true;

                    if (!spansBeyondThisRow) {
                        if (currentTargetProperties.length) {
                            hasMajorityStyle = currentTargetProperties.every(prop => {
                                // Cell height depends on the number of text lines in the cell, so it
                                // says nothing about the cell style (hasDistinctStyle already makes the
                                // same exception). Without it a header cell whose height is unique in
                                // the row fails once the row has 11+ cells: the threshold is
                                // total * 0.1, which is > 1 for 11 blocks.
                                if (prop === 'height') {
                                    return true;
                                }

                                const weight = 1 - targetPropertiesWeight[prop];
                                const counts = Object.values(propertiesCounter?.[prop] || {}) as number[];
                                const total = counts.reduce((sum, value) => sum + Number(value), 0);
                                const count = Number(propertiesCounter?.[prop]?.[textBlock?.[prop]] || 0);

                                // Top row only: a minority of cells may use another font/fill (here "вес кг/м2" in a larger,
                                // different font) as long as the bulk of the row shares one style.
                                const topRowIsMostlyUniform =
                                    index === 0 &&
                                    textBlocks.length >= 4 &&
                                    rowHasColumnRules &&
                                    total > 0 &&
                                    Math.max(...counts) / total >= TOP_ROW_UNIFORM_SHARE;



                                return count > total * (weight || 1) //the number of cells with target properties exceeds the number of cells with other properties
                                    || topRowIsMostlyUniform;


                            });

                        } else if (targetProperties.length) {
                            // currentTargetProperties is empty: within THIS line, none of the
                            // globally variable properties (font/height/...) change—
                            // the line is completely uniform. Previously, this left hasMajorityStyle
                            // set to true “by default” (there was nothing to check), which meant
                            // that ANY uniform line of DATA (and most of them are—one
                            // font and one height for all its cells) automatically passed
                            // this check, as if it were typical for a header. Instead of the default,
                            // we compare the row’s single style against the GLOBAL trend across the
                            // entire table: if the row’s style matches the most frequent style in
                            // the entire table—this is a sign of regular data, not a header.
                            hasMajorityStyle = targetProperties.some(
                                prop => textBlock?.[prop] !== modeProperties[prop]
                            );
                        }
                    }

                    let hasBottomBorder = true;
                    const needsBottomBorder = !isMajorityNumericRow && hasMajorityStyle && hasDistinctStyle && hasUniformStr;

                    if (needsBottomBorder) {
                        if (edges || rectangles) {
                            const bottomElements = getBottomElements();
                            hasBottomBorder = [bottomElements[0], bottomElements[1]].some(item =>
                                ['rectangle', 'edge'].includes(item?.vectorType)
                            );
                            // Multi-line header cell. The second line of this
                            // cell appears below the first line (text within the current table row), and the border follows it.

                            if (!hasBottomBorder) {
                                const rowBottom = range[1] - medianBorderWidth * 2;

                                const isCurrentRowText = (item: any) =>
                                    item?.vectorType === 'coordinate' &&
                                    (item.index === textBlock.index || item.y >= rowBottom);

                                const hasStackedLines = bottomElements.some(
                                    (item: any) => isCurrentRowText(item) && item.index !== textBlock.index
                                );

                                if (hasStackedLines) {
                                    const firstOutsideRow = bottomElements.find(
                                        (item: any) => !isCurrentRowText(item)
                                    );
                                    hasBottomBorder = ['rectangle', 'edge'].includes(firstOutsideRow?.vectorType);
                                }
                            }
                        }
                        // A row boundary synthesized from a full-width text gap separates this row
                        // from the one below as reliably as a drawn line, even though no line exists.
                        if (!hasBottomBorder && separatorRows.some(y => Math.abs(y - range[1]) < 0.01)) {
                            hasBottomBorder = true;
                        }
                        // Text-only table: no visible rule or fill anywhere in the group, so a header has nothing to
                        // rest on. The topmost range counts as a header when ALL hold:
                        //   - it has at least 3 blocks and its font/colour differs from the body's dominant one;
                        //   - at least 3 of the following ranges are populated and their typical block count
                        //     (median) is not smaller than 80% of the header's, i.e. the body has the same columns.
                        // A page of plain text (uniform style, few blocks per line) does not pass this.
                        if (!hasBottomBorder && index === 0 && textBlocks.length >= 3 && arr.length >= 5) {
                            const hasVisibleVectors = [...(edges || []), ...(rectangles || [])].some(vector =>
                                isVisibleVector(vector),
                            );
                            const differsFromBody = ['fontName', 'fillColor', 'strokeColor'].some(
                                prop => modeProperties[prop] !== undefined && textBlock?.[prop] !== modeProperties[prop],
                            );

                            if (!hasVisibleVectors && differsFromBody) {
                                const bodyBlockCounts: number[] = [];
                                for (let next = 1; next < Math.min(arr.length - 1, 13); next++) {
                                    bodyBlockCounts.push(
                                        coordinates.filter(
                                            (block: any) => block?.str?.trim() && block.y <= arr[next] && block.y > arr[next + 1],
                                        ).length,
                                    );
                                }
                                const populated = bodyBlockCounts.filter(count => count > 0).sort((a, b) => a - b);
                                const median = populated[Math.floor(populated.length / 2)] || 0;

                                if (populated.length >= 3 && median >= textBlocks.length * 0.8) {
                                    hasBottomBorder = true;
                                }
                            }
                        }
                    }

                    let isIndicator = isHeaderIndicator(textBlock?.['str']);//cell value corresponds to a word in the indicator

                    // A row consisting mostly of numeric values is a data row,
                    // not a table header.
                    let condition =
                        !isMajorityNumericRow &&
                        (
                            (hasMajorityStyle &&
                                hasDistinctStyle &&
                                hasUniformStr &&
                                hasBottomBorder) ||
                            isIndicator
                        );

                    headerConditions.push(condition);
                });

                let isHeader = continuesHeaderAsIndexRow || headerConditions.every(item => item);

                if (isHeader) {
                    prev[rangeStr] = textBlocks;
                    if (headersCombo.length) {
                        headersCombo.forEach(item => { prev[item.rangeStr] = item.textBlocks; item.isHeader = true; });
                    }
                    headersCombo.push({ rangeStr, textBlocks, isHeader });
                    if (hasColsInfo && rowOccupiedCols) {
                        rowOccupiedCols.forEach(c => cumulativeOccupiedCols.add(c));
                    }
                }

                //old:headersCombo.push({ rangeStr, textBlocks, isHeader });//BUG 06-sales-order
            } else {
                if (!textBlocks?.length) {
                    setDefaultHeaderRows(headersCombo);
                    headersCombo = [];
                    cumulativeOccupiedCols = new Set();
                }
            }
        }

        if (index == arr.length) {
            setDefaultHeaderRows(headersCombo);
        }

        return prev;
    }, {});

    return headerRows;
}
