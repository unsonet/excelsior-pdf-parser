import { findMod, findClosestIndex, sortArrayOfObjects, splitByIndex, findAverage } from "@unsonet/js-utils";
import { filterBlocks } from "./filter-blocks";

export function getHandledGridItems(options) {
    let {
        gridItems,
        gridItemsType,
        coordinates,
        filterFn,
        assuredGridItems,
    } = options;
    //Removing duplicates and sorting coordinates
    gridItems = [...new Set(JSON.parse(JSON.stringify(gridItems)))].sort((a: any, b: any) => a - b);

    let gridItemsPairs = {};
    let alias = {};
    let paddingBorders = [];
    let paddingSizes = [];
    let paddingSize = 0;
    let modeTextHeight = findMod(coordinates.map(item => item.height));
    // Rows below the lowest assured border (drawn rule or band edge) have no
    // geometric evidence: typical for a ruled header followed by a body without
    // row lines. They must be split by the text itself instead of being collapsed
    // into one row.
    const lowestAssuredBorder = assuredGridItems.length
        ? Math.min(...assuredGridItems)
        : Infinity;

    const isTextOnlyRegion = (border: number): boolean =>
        gridItemsType === 'rows'
        && assuredGridItems.length > 2
        && border < lowestAssuredBorder - 0.01;
    let coordinatePaddings = coordinates.reduce((prev, cur) => {
        let secondLine = cur[gridItemsType === 'cols' ? 'x' : 'y'];
        let firstLine = gridItems?.[findClosestIndex(gridItems, secondLine, modeTextHeight * 2)];
        let diffTolerance = 0;
        if (firstLine) {
            let diff = Math.abs(firstLine - secondLine);
            if (diff > diffTolerance) {
                prev.push(diff);
            }
        }
        return prev;
    }, []);

    function findPropertyWithMaxScore(obj) {
        let maxScore = -Infinity;
        let resultProperty = null;

        for (let key in obj) {
            if (obj.hasOwnProperty(key)) {
                let [plusPoints, minusPoints] = obj[key];
                plusPoints = Array.isArray(plusPoints) ? plusPoints.length : plusPoints;
                minusPoints = Array.isArray(minusPoints) ? minusPoints.length : minusPoints;
                let totalScore = plusPoints - minusPoints;

                if (totalScore > maxScore) {
                    maxScore = totalScore;
                    resultProperty = key;
                }
            }
        }

        return resultProperty;
    }



    //Basic cycle for processing coordinate pairs
    for (let firstBorderIndex = 0; firstBorderIndex < gridItems.length; firstBorderIndex++) {
        for (let secondBorderIndex = firstBorderIndex + 1; secondBorderIndex < gridItems.length; secondBorderIndex++) {
            const firstBorder = gridItems[firstBorderIndex];
            const secondBorder = gridItems[secondBorderIndex];

            //Skipping incorrect pairs
            if (!(firstBorder && secondBorder) || (firstBorder === secondBorder)) {
                break;
            }

            //Filtering text blocks within a specified range
            // if null, the current boundaries intersect two text blocks on the same axis
            let textBlocks = filterBlocks(coordinates || [], {
                [gridItemsType === 'cols' ? 'x' : 'y']: [firstBorder, secondBorder],
                withoutOverlap: true,
                filterFn,
                strictIntersecting: true
            })
            //?.filter(item => ![firstBorder, secondBorder].includes(item[gridItemsType === 'cols' ? 'x' : 'y'])); //BUGFIX;

            let intersectsNextGridItem = textBlocks.intersectsNextGridItem;//intersection of two text blocks on the same axis

            let isLastBorder = (secondBorder === gridItems[gridItems.length - 1]);
            let isAssuredBorder = assuredGridItems.includes(secondBorder);
            let gridItemsPairsKeys = sortArrayOfObjects(
                Object.keys(gridItemsPairs),
                [{ isNumber: true, order: 'asc' }]
            );
            let gridItemRangeEnded =
                (assuredGridItems.length > 2 && !isTextOnlyRegion(secondBorder)
                    ? isAssuredBorder
                    : intersectsNextGridItem)
                && textBlocks.some(item => item.contained);
            function updateCycle(secondBorder) {
                //for optimization, we skip checking the boundaries that go before the current coordinate pair
                let foundSecondBorderIndex = gridItems.indexOf(secondBorder);
                foundSecondBorderIndex = foundSecondBorderIndex == -1 ? secondBorderIndex : foundSecondBorderIndex;
                firstBorderIndex = secondBorderIndex = foundSecondBorderIndex;
            }

            function addGridItemsPairs(firstBorder, secondBorder, textBlocks) {
                gridItemsPairs[firstBorder] = gridItemsPairs[firstBorder] || {};
                let keys = Object.keys(gridItemsPairs[firstBorder]);
                let dividedTextBlocks = subdivideTextBlocks(textBlocks, filterFn);
                let previousTextBlocks = keys[keys.length - 1] ? filterBlocks(coordinates || [], {
                    [gridItemsType === 'cols' ? 'x' : 'y']: [keys[keys.length - 1], secondBorder],
                    withoutOverlap: true,
                    filterFn,
                    strictIntersecting: true
                }) : textBlocks;

                let textBlocksIndexes = textBlocks.map((item) => item.index).sort((a, b) => a - b);
                let dividedTextBlocksIndexes = dividedTextBlocks.flat().sort((a, b) => a - b);
                let previousTextBlocksIndexes = previousTextBlocks.map((item) => item.index).sort((a, b) => a - b);

                //let isLastBorder = (secondBorder === gridItems[gridItems.length - 1]);
                //let isAssuredBorder = assuredGridItems.includes(secondBorder);
                //let gridItemRangeEnded = (assuredGridItems.length > 2 ? isAssuredBorder : intersectsNextGridItem) && textBlocks.some(item => item.contained);


                let hasDuplicateCopies = previousTextBlocks.some(item => textBlocks.map(item => JSON.stringify(item)).includes(JSON.stringify(item)));
                let isLastIterationPadding = (
                    (textBlocksIndexes.toString() == dividedTextBlocksIndexes.toString()) &&//the number of text blocks in the range has not changed since the previous iteration
                    !previousTextBlocksIndexes.length //the grown range segment does not contain text blocks
                );

                if (
                    isLastIterationPadding ||
                    (isLastBorder || gridItemRangeEnded)
                ) {
                    let newSecondBorder;
                    //if(isLastBorder || gridItemRangeEnded){
                    if (isLastIterationPadding || hasDuplicateCopies) {
                        newSecondBorder = +findPropertyWithMaxScore(gridItemsPairs[firstBorder]) || secondBorder;
                    } else {
                        newSecondBorder = secondBorder;
                    }
                    //}

                    gridItemsPairs[firstBorder] = newSecondBorder;
                    updateCycle(newSecondBorder);
                } else {
                    //Updating coordinate pair with the number of text blocks
                    gridItemsPairs[firstBorder][secondBorder] = gridItemsPairs[firstBorder][secondBorder] || dividedTextBlocks;
                }
            }

            if (textBlocks?.length || gridItemRangeEnded) {
                if (paddingBorders.includes(firstBorder)) {//process the last padding boundary
                    paddingBorders = paddingBorders.sort((a, b) => a - b);
                    //Calculate distances between paddingBorders
                    let distances = paddingBorders.reduce((prev, cur, index) => {
                        let distance = index == 0 ? 0 : cur - paddingBorders[index - 1];
                        prev.push(distance);
                        return prev;
                    }, []);

                    //Calculate the average of the distances
                    let averageDistance = distances.reduce((prev, cur) => prev + cur, 0) / distances.filter(item => item > 0).length;
                    let maxDistance = (modeTextHeight * 2);

                    if (averageDistance > maxDistance) {//Spaces are too large, boundaries need to be locked in
                        let distancesIndexes = distances.map((item, index) => index);
                        let firstSplitIndex = distances.findIndex(item => item > maxDistance);
                        let secondSplitIndex = distances.findLastIndex(item => item > maxDistance);

                        let firstIndexes = splitByIndex(distancesIndexes, firstSplitIndex == -1 ? 0 : firstSplitIndex, { exclude: true })[0];
                        let secondIndexes = splitByIndex(distancesIndexes, secondSplitIndex == -1 ? distances.length - 1 : secondSplitIndex, { exclude: true })[1];

                        let firstIndex = firstIndexes[1] || firstIndexes[0] || ((firstSplitIndex == 0) || (firstSplitIndex == -1) ? 0 : firstSplitIndex - 1);
                        let secondIndex = secondIndexes[secondIndexes.length - 2] || secondIndexes[secondIndexes.length - 1] || ((secondSplitIndex == paddingBorders.length - 1) || (secondSplitIndex == - 1) ? paddingBorders.length - 1 : secondSplitIndex + 1);

                        let newFirstBorder = paddingBorders[firstIndex]
                        let newSecondBorder = paddingBorders[secondIndex];

                        if (distances[firstIndex + 1] > maxDistance) {
                            let aliasValue = newFirstBorder + paddingSize;
                            updateAlias([newFirstBorder], alias, aliasValue);
                        }

                        if ((distances[secondIndex] > maxDistance) && newFirstBorder != newSecondBorder) {
                            let aliasValue = newSecondBorder - paddingSize;
                            updateAlias([newSecondBorder], alias, aliasValue);
                        }

                        gridItemsPairs[newFirstBorder] = newSecondBorder;
                        updateCycle(newSecondBorder);
                    } else {
                        let aliasValue = calculateAliasValue(paddingBorders, assuredGridItems);
                        //let newSecondBorder = paddingBorders[paddingBorders.length - 1];
                        //gridItemsPairs[firstBorder] = newSecondBorder;
                        updateAlias(paddingBorders, alias, aliasValue);
                    }
                    paddingBorders = [];
                } else {
                    if (
                        [firstBorder, secondBorder].every(item => { //all boundaries are guaranteed
                            return assuredGridItems.includes(item);
                        })
                    ) {
                        //calculate the alias
                        //if ((gridItemsPairsKeys.length > 1 ? +gridItemsPairs[gridItemsPairsKeys[gridItemsPairsKeys.indexOf(firstBorder + '') - 1]] <= +firstBorder : false)) {
                        if (gridItemsPairsKeys.length > 0) {
                            let keys = Object.keys(gridItemsPairs[firstBorder] || {});
                            if (!isLastBorder && keys.length && !isAssuredBorder) {
                                updateAlias([secondBorder], alias, (+keys[keys.length - 1] + secondBorder) / 2);
                                paddingSizes.push(Number(secondBorder) - Number(keys[keys.length - 1]));
                                paddingSize = getPaddingSize();
                            }
                        }

                        gridItemsPairs[firstBorder] = secondBorder;
                        updateCycle(secondBorder);

                    } else {
                        if (assuredGridItems.includes(secondBorder)) {
                            gridItemsPairs[firstBorder] = secondBorder;
                            updateCycle(secondBorder);
                        } else {
                            addGridItemsPairs(firstBorder, secondBorder, textBlocks);
                        }
                    }
                }
            } else {
                addPaddingBorders(paddingBorders, firstBorder, secondBorder);
                paddingSizes.push(secondBorder - firstBorder);
                paddingSize = getPaddingSize();
            }
        }
    }

    //Updating gridItems based on coordinate and alias pairs
    let gridItemsPairsKeys = sortArrayOfObjects(
        Object.keys(gridItemsPairs),
        [{ isNumber: true, order: 'asc' }]
    );
    gridItems = gridItemsPairsKeys.reduce((prev, cur) => {
        let key = +cur;
        let value = +gridItemsPairs[key];
        if (!prev.includes(value)) {
            if (!prev.includes(key)) prev.push(key);
            prev.push(value);
        }
        return prev;
    }, []);

    function getPaddingSize() {
        let paddingMode = +findMod([...paddingSizes, ...coordinatePaddings]);
        let paddingSize = findAverage([...paddingSizes, ...coordinatePaddings].filter(item => item <= paddingMode));
        return paddingSize;
    }

    paddingSize = getPaddingSize();
    gridItems = updateGridItems(gridItems, alias, assuredGridItems, paddingSize || null).sort((a: any, b: any) => a - b);

    return {
        gridItems,
        alias,
        paddingSize,
    };
}

//Function for calculating the value of alias
export function calculateAliasValue(paddingBorders, assuredGridItems) {
    const length = paddingBorders.length;
    let assuredArr = paddingBorders.filter(item => assuredGridItems.includes(item));
    if (assuredArr.length > 0) {
        if (assuredArr.length === 1) {
            return assuredArr[0];
        } else {
            paddingBorders = assuredArr;
        }
    }

    if (length % 2 === 0) {
        //If the number of elements is even, return the arithmetic mean
        const sum = paddingBorders.reduce((acc, val) => acc + val, 0);
        return sum / length;
    } else {
        //If the number of elements is odd, return the middle element
        const middleIndex = Math.floor(length / 2);
        return paddingBorders[middleIndex];
    }
}

//Function for updating alias
export function updateAlias(paddingBorders, alias, aliasValue) {
    paddingBorders.forEach(item => {
        if (!alias[item] && aliasValue && (item != aliasValue)) {
            alias[item] = aliasValue;
        }
    });
}

//Function for adding paddingBorders
export function addPaddingBorders(paddingBorders, firstBorder, secondBorder) {
    [firstBorder, secondBorder].forEach(item => {
        if (!paddingBorders.includes(item)) {
            paddingBorders.push(item);
        }
    });
}

//Function for calculating the number of text blocks
export function subdivideTextBlocks(textBlocks, filterFn) {
    let contained = [];
    let doesNotContained = []
    for (let index = 0; index < textBlocks.length; index++) {
        const textBlock = textBlocks[index];
        if (textBlock.contained && (filterFn ? filterFn(textBlock, index, textBlocks) : true)) {
            contained.push(textBlock.index);
        } else {
            doesNotContained.push(textBlock.index);
        }
    }

    return [contained, doesNotContained];
}

//Function for updating gridItems
export function updateGridItems(gridItems, alias, assuredGridItems, defaultGap) {
    let aliasKeys = Object.keys(alias).map(item => +item);
    let distanceDifference = aliasKeys.map(item => item - alias[item]);
    let mode = +findMod(distanceDifference);
    defaultGap = aliasKeys.length ? defaultGap ? Math.min(defaultGap, findAverage(aliasKeys)) : findAverage(aliasKeys) : defaultGap || 1;

    gridItems = gridItems.map((item, index, arr) => {
        let currentAlias = alias[item];
        let value;
        let isAssuredBorder = assuredGridItems.includes(item);
        if (currentAlias) {
            value = currentAlias;
        } else {
            if (!isAssuredBorder) {
                if (item === arr[0]) {
                    value = mode ? item - mode : item - defaultGap;
                    alias[item] = value;
                } else if (item === arr[arr.length - 1]) {
                    value = mode ? item + mode : item + defaultGap;
                    alias[item] = value;
                } else {
                    value = item;
                }
            } else {
                value = item;
            }
        }
        return value;
    });

    return [...new Set(gridItems)];
}