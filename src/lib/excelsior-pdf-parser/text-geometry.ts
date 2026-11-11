
export function isRotatedText(item) {
    const transform = item?.transform;

    if (!transform || transform.length < 4) {
        return false;
    }

    const [a, b, c, d] = transform;

    return (
        Math.abs(b) > Math.abs(a) * 2 &&
        Math.abs(c) > Math.abs(d) * 2
    );
}

// === Support for fully rotated (landscape, “sideways”) pages ===
//
// In agstat.pdf, the 90° rotation applied only to the column header text
// (to fit into a narrow column)—the table body remained as regular
// horizontal text. In rotated.pdf, the 90° rotation is applied to
// the ENTIRE table—headers, body, and numbers—because the table
// is physically wider than the page and the document’s author rotated it sideways.
//
// Instead of rewriting every function for constructing
// grid, we “unrotate” the entire page geometry back to
// its normal orientation BEFORE it enters the rest of the pipeline—
// then all subsequent logic (which already works perfectly for
// normal orientation) runs without any changes.

export function isRotatedTextItem(item) {
    const t = item?.transform;
    if (!t || t.length < 4) return false;
    return (
        Math.abs(t[0]) < 0.01 &&
        Math.abs(t[3]) < 0.01 &&
        (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01)
    );
}


export function isRotated90(item) {
    const t = item?.transform;
    if (!t || t.length < 4) return false;
    // a ≈ 0, d ≈ 0, and b/c are real nonzero values—a matrix of the form
    // [0, s, -s, 0] or [0, -s, s, 0], that is, a rotation of ±90°.
    return (
        Math.abs(t[0]) < 0.01 &&
        Math.abs(t[3]) < 0.01 &&
        (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01)
    );
}

export function normalizeRotatedAnchor(item) {
    // All of the geometry below (getMergedCoordinatePaddingObj and everything that
    // depends on it) strictly treats transform[4] as the “column coordinate”
    // and transform[5] as the “row coordinate.” This is true only for
    // unrotated text. For text rotated by 90°, the axis along
    // which the lines of a single cell actually follow one another is
    // transform[4], not [5] (and vice versa). There’s no need to change
    // width/height—they already correctly represent “line length” and
    // “line thickness” regardless of rotation.
    if (!item || !isRotated90(item)) return item;
    const t = item.transform;
    return { ...item, transform: [t[0], t[1], t[2], t[3], t[5], t[4]] };
}

export function isHorizontalText(item: any) {
    const transform = item?.transform;

    if (!transform || transform.length < 4) {
        return true;
    }

    const [a, b, c, d] = transform;

    return (
        Math.abs(b) <= Math.abs(a) * 0.2 &&
        Math.abs(c) <= Math.abs(d) * 0.2
    );
}

export function getTextAnchor(item) {
    return {
        x: Number(item?.transform?.[4] || 0),
        y: Number(item?.transform?.[5] || 0)
    };
}

export function getTextTransformDirection(item) {
    const transform = item?.transform;

    if (!transform || transform.length < 4) {
        return [1, 0];
    }

    const length = Math.hypot(
        transform[0],
        transform[1]
    );

    if (!length) {
        return [1, 0];
    }

    return [
        transform[0] / length,
        transform[1] / length
    ];
}

export function getTextNormal(item) {
    const [x, y] = getTextTransformDirection(item);

    return [
        -y,
        x
    ];
}

export function getTextLineDistance(firstItem, secondItem) {
    const first = getTextAnchor(firstItem);
    const second = getTextAnchor(secondItem);

    const normal = getTextNormal(firstItem);

    const dx = second.x - first.x;
    const dy = second.y - first.y;

    return Math.abs(
        dx * normal[0] +
        dy * normal[1]
    );
}

/**
 * A pdf.js element can be considered a fragment pair only if it appears on the same line:
 * A match of tokens (periods, spaces, numbers) without this condition is not considered “the same text.”
 */
export function isOnSameTextLine(candidate: any, fragment: any): boolean {
    if (!candidate?.transform || !fragment?.transform) return true;
    if (isRotatedTextItem(candidate) || isRotatedTextItem(fragment)) return true;

    const tolerance = Math.max(Math.max(candidate.height || 0, fragment.height || 0) * 0.75, 1);
    return Math.abs(candidate.transform[5] - fragment.transform[5]) <= tolerance;
}

export function isSameFont(a, b) {
    return typeof a?.fontName == 'string' &&
        typeof b?.fontName == 'string' &&
        a?.fontName === b?.fontName;
}

export function getItemRight(item: any): number {
    const rights = (item?.chars || [])
        .filter(
            (glyph: any) =>
                glyph && typeof glyph === 'object' && Number.isFinite(glyph.x) && Number.isFinite(glyph.charWidth)
        )
        .map((glyph: any) => glyph.x + glyph.charWidth);
    return rights.length ? Math.max(...rights) : item.transform[4] + (item.width || 0);
}

export function getTextContentItemId(textContentItem) {
    return textContentItem ? [textContentItem.transform[5], textContentItem.transform[4]].join('-') : null;
}