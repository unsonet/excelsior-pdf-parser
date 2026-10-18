import { stringifyPseudoJson } from '@unsonet/js-utils';

/**
 * PDFTRACE/1 diagnostics for Excelsior PDF.
 *
 * This module has no I/O or PDF-processing side effects. The caller supplies a
 * snapshot from the current page. By default the builder returns a plain JS data
 * object; set minify: true to serialize it with stringifyPseudoJson.
 */

export type DebugLevel = 'summary' | 'trace' | 'ops' | 'tables' | 'L0' | 'L1' | 'L2' | 'L3';

export type Region = { x1: number; y1: number; x2: number; y2: number };

export type OperationWindow = { from: number; to: number };

export type OperationWindowInput =
    | OperationWindow
    | number[]
    | readonly [number, number];

export interface DebugOptions {
    /** summary=L0, trace=L1, ops=L2, tables=L3. Defaults to summary. */
    level?: DebugLevel;
    /** Region in the extractor's page coordinate frame; affects extractor text and graphics. */
    region?: Region;
    /** Zero-based PDF.js OperatorList indices. Defaults to the first 48 operations at level ops. */
    opWindow?: OperationWindowInput;
    onReport?: (report: DebugReport) => void;
    /** Maximum text/graphic/table items shown in detailed sections. Default: 80. */
    maxItems?: number;
    /** Maximum decimal digits in numeric report values. Omitted = preserve source precision. */
    numberDigits?: number;
    /** Set true only when PDF.js and extractor text transforms are known to share a coordinate frame. */
    compareTextPositions?: boolean;
    /** Optional caller-supplied reference HTML, included only at level tables. */
    expectedHtml?: string | Record<number, string>;
    /** Return compact pseudo-JSON text instead of a JavaScript object. Default: false. */
    minify?: boolean;
}

interface DebugPageSnapshot {
    pageNumber: number;
    pageSize: { width: number; height: number; rotation?: number };
    opList: { fnArray: ArrayLike<number>; argsArray: ArrayLike<any> };
    pdfjsOps: Record<string, number>;
    /** Copy captured before the extractor filters/mutates PDF.js text items. */
    pdfjsItems?: any[];
    /** Internal text items created by the Excelsior operator interpreter. */
    items?: any[];
    edges?: any[];
    rectangles?: any[];
    lineMaxWidth?: number;
    tableGroups?: any[];
    tables?: Array<{ group: any; array: any[][] }>;
    region?: Region;
    level?: DebugLevel;
    maxItems?: number;
    opWindow?: OperationWindow;
    compareTextPositions?: boolean;
    /** Can be supplied if the interpreter has actual per-operator execution status. */
    opStatus?: Array<'handled' | 'ignored' | 'unhandled' | 'unknown' | undefined>;
}

/** Structured report returned by buildDebugReport when minify is omitted/false. */
export interface DebugReportData {
    format: 'PDFTRACE/1';
    page: { number: number; viewport: [number, number]; rotationDeg: number | null };
    [key: string]: any;
}

/** Event payload used by the optional extractor-level onReport callback. */
export type DebugReport = { page: number; data: DebugReportData | string };

const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_OP_WINDOW = 48;
const NUMBER_DIGITS = 3;

/**
 * Normalize public opWindow syntax to the internal object representation.
 */
function normalizeOperationWindow(
    requested?: OperationWindowInput,
): OperationWindow | undefined {
    if (requested == null) {
        return undefined;
    }

    let from: number;
    let to: number;

    if (Array.isArray(requested)) {
        if (requested.length !== 2) {
            throw new TypeError(
                'debug.opWindow must be { from, to } or [from, to].',
            );
        }

        [from, to] = requested;
    } else {
        const window = requested as OperationWindow;
        from = window.from;
        to = window.to;
    }

    if (!Number.isFinite(from) || !Number.isFinite(to)) {
        throw new TypeError(
            'debug.opWindow indices must be finite numbers.',
        );
    }

    return { from, to };
}

const MNEMONIC: Record<string, string> = {
    setLineWidth: 'w', setLineCap: 'J', setLineJoin: 'j', setMiterLimit: 'M', setDash: 'd',
    save: 'q', restore: 'Q', transform: 'cm', constructPath: 'path', closePath: 'h',
    stroke: 'S', closeStroke: 's', fill: 'f', eoFill: 'f*', fillStroke: 'B', eoFillStroke: 'B*',
    closeFillStroke: 'b', closeEOFillStroke: 'b*',
    beginText: 'BT', endText: 'ET', setCharSpacing: 'Tc', setWordSpacing: 'Tw', setHScale: 'Tz',
    setLeading: 'TL', setFont: 'Tf', setTextRenderingMode: 'Tr', setTextRise: 'Ts',
    moveText: 'Td', setLeadingMoveText: 'TD', setTextMatrix: 'Tm', nextLine: 'T*',
    showText: 'Tj', showSpacedText: 'TJ', nextLineShowText: "'", nextLineSetSpacingShowText: '"',
    setFillRGBColor: 'rg', setStrokeRGBColor: 'RG', setFillGray: 'g', setStrokeGray: 'G',
    setFillCMYKColor: 'k', setStrokeCMYKColor: 'K', setFillColorN: 'scn', setStrokeColorN: 'SCN',
    setFillColor: 'sc', setStrokeColor: 'SC', paintImageXObject: 'Do',
    paintFormXObjectBegin: 'Form{', paintFormXObjectEnd: '}Form', shadingFill: 'sh',
    dependency: 'dep', beginMarkedContent: 'BMC', beginMarkedContentProps: 'BDC', endMarkedContent: 'EMC',
    setFlatness: 'i', setRenderingIntent: 'ri', beginCompat: 'BX', endCompat: 'EX',
    markPoint: 'MP', markPointProps: 'DP', clip: 'W', eoClip: 'W*', endPath: 'n',
    setGState: 'gs', setFillColorSpace: 'cs', setStrokeColorSpace: 'CS',
};

/**
 * Matches the operator-specific branches in the current extractor snapshot.
 * Keep this map in sync with the actual operator interpreter branches. It is a
 * capability map, not a claim that a particular page item was rendered correctly.
 */
const EXTRACTOR_HANDLED_OPS = new Set([
    'beginText', 'constructPath', 'eoFill', 'fill', 'moveText', 'paintImageXObject',
    'restore', 'save', 'setCharSpacing', 'setFillCMYKColor', 'setFillColor', 'setFillGray',
    'setFillRGBColor', 'setFont', 'setGState', 'setLeadingMoveText', 'setLineWidth',
    'setStrokeCMYKColor', 'setStrokeColor', 'setStrokeGray', 'setStrokeRGBColor',
    'setTextMatrix', 'setTextRenderingMode', 'setWordSpacing', 'showText', 'stroke', 'transform',
]);

/** Operators intentionally ignored by the current extractor, rather than accidentally missing. */
const EXTRACTOR_IGNORED_OPS = new Set([
    'dependency', 'beginMarkedContent', 'beginMarkedContentProps', 'endMarkedContent',
    'setFlatness', 'setRenderingIntent', 'beginCompat', 'endCompat', 'markPoint',
    'markPointProps', 'endText',
]);

/** Omitted from the human-sized histogram only; this is not the parser support map. */
const SUMMARY_NOISE_OPS = new Set([
    'dependency', 'beginMarkedContent', 'beginMarkedContentProps', 'endMarkedContent',
    'setFlatness', 'setRenderingIntent', 'beginCompat', 'endCompat', 'markPoint',
    'markPointProps', 'endText',
]);

function round(value: number, digits = NUMBER_DIGITS): number | string {
    if (!Number.isFinite(value)) return String(value);
    const scale = 10 ** digits;
    return Math.round((value + Number.EPSILON) * scale) / scale;
}

function normalizeJson(value: any, numberDigits?: number): any {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return String(value);
        return numberDigits === undefined ? value : round(value, numberDigits);
    }
    if (typeof value === 'bigint') return String(value);
    if (value == null || typeof value === 'string' || typeof value === 'boolean') return value ?? null;
    if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<any>, (item) => normalizeJson(item, numberDigits));
    if (Array.isArray(value)) return value.map((item) => normalizeJson(item, numberDigits));
    if (value instanceof Map) return [...value.entries()].map(([k, v]) => [normalizeJson(k, numberDigits), normalizeJson(v, numberDigits)]);
    if (value instanceof Set) return [...value].map((item) => normalizeJson(item, numberDigits));
    if (typeof value === 'object') {
        const out: Record<string, any> = {};
        for (const [key, val] of Object.entries(value)) {
            if (typeof val !== 'function' && val !== undefined) out[key] = normalizeJson(val, numberDigits);
        }
        return out;
    }
    return String(value);
}

function normalizeNumberDigits(numberDigits?: number): number | undefined {
    if (numberDigits === undefined) return undefined;
    if (!Number.isInteger(numberDigits) || numberDigits < 0 || numberDigits > 100) {
        throw new RangeError('numberDigits must be an integer between 0 and 100');
    }
    return numberDigits;
}

function oneLine(value: any, numberDigits?: number): string {
    return JSON.stringify(normalizeJson(value, numberDigits))
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

function flattenArrayLike(value: any): any[] {
    if (Array.isArray(value)) return value;
    if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<any>);
    if (value && typeof value === 'object') {
        return Object.keys(value)
            .filter((key) => /^\d+$/.test(key))
            .sort((a, b) => Number(a) - Number(b))
            .map((key) => value[key]);
    }
    return value == null ? [] : [value];
}

function operationNames(pdfjsOps: Record<string, number>): Map<number, string> {
    const names = new Map<number, string>();
    for (const [name, id] of Object.entries(pdfjsOps || {})) {
        // PDF.js builds may expose a numeric reverse map; only accept symbolic keys.
        if (!/^\d+$/.test(name) && typeof id === 'number' && !names.has(id)) names.set(id, name);
    }
    return names;
}

function compactTextString(value: unknown): string {
    // Escape marker-like source text, then encode long runs of literal U+0020 spaces reversibly.
    return String(value ?? '')
        .replace(/⟦/g, '⟦⟦')
        .replace(/ {3,}/g, (run) => `⟦SP:${run.length}⟧`);
}

function inRegion(box: { x: number; y: number; width: number; height: number }, region?: Region): boolean {
    if (!region) return true;
    const left = Math.min(region.x1, region.x2);
    const right = Math.max(region.x1, region.x2);
    const top = Math.min(region.y1, region.y2);
    const bottom = Math.max(region.y1, region.y2);
    return box.x <= right && box.x + box.width >= left && box.y <= bottom && box.y + box.height >= top;
}

function textBox(item: any): { x: number; y: number; width: number; height: number } | null {
    const tr = flattenArrayLike(item?.transform);
    if (tr.length < 6) return null;
    const [a, b, c, d, e, f] = tr.map(Number);
    const width = Number(item?.width ?? 0);
    const height = Number(item?.height ?? 0);
    if (![a, b, c, d, e, f, width, height].every(Number.isFinite)) return null;
    const readLength = Math.hypot(a, b) || 1;
    const upLength = Math.hypot(c, d) || 1;
    const ux = a / readLength;
    const uy = b / readLength;
    const vx = c / upLength;
    const vy = d / upLength;
    const xs = [e, e + ux * width, e + vx * height, e + ux * width + vx * height];
    const ys = [f, f + uy * width, f + vy * height, f + uy * width + vy * height];
    return {
        x: Math.min(...xs), y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
    };
}

function glyphText(value: any): string {
    const values = flattenArrayLike(value);
    return values.map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'unicode' in item) return String(item.unicode ?? '');
        return '';
    }).join('');
}

function textAdjustmentParts(value: any, numberDigits?: number): any[] {
    const values = flattenArrayLike(value);
    const parts: any[] = [];
    let text = '';
    const flush = () => {
        if (text) parts.push(compactTextString(text));
        text = '';
    };
    for (const item of values) {
        if (typeof item === 'number') {
            flush();
            // Keep adjustments exact unless the caller explicitly asks to limit decimals.
            parts.push({ adjust: String(numberDigits === undefined ? item : round(item, numberDigits)) });
        } else if (Array.isArray(item) || ArrayBuffer.isView(item)) {
            for (const nested of textAdjustmentParts(item, numberDigits)) {
                if (typeof nested === 'string') text += nested;
                else { flush(); parts.push(nested); }
            }
        } else if (item && typeof item === 'object' && 'unicode' in item) {
            text += String(item.unicode ?? '');
        } else if (typeof item === 'string') {
            text += item;
        } else if (item != null) {
            flush();
            parts.push(normalizeJson(item));
        }
    }
    flush();
    return parts;
}

function isDefaultArgument(name: string, args: any): boolean {
    const first = flattenArrayLike(args)[0];
    switch (name) {
        case 'setCharSpacing': case 'setWordSpacing': case 'setTextRise':
        case 'setTextRenderingMode': case 'setLineCap': case 'setLineJoin': return first === 0;
        case 'setHScale': return first === 100;
        case 'setMiterLimit': return first === 10;
        case 'setDash': return flattenArrayLike(first).length === 0;
        case 'setLeading': return first === 0;
        default: return false;
    }
}

function pathDescription(args: any, names: Map<number, string>, pdfjsOps: Record<string, number>, includeCoords = false): any {
    const values = flattenArrayLike(args);
    const isArrayLike = (value: any): boolean => Array.isArray(value) || ArrayBuffer.isView(value);
    const opId = (name: string) => pdfjsOps?.[name];
    const oldCommandName = (code: any): string => {
        if (typeof code !== 'number') return `?${String(code)}`;
        const resolved = names.get(code);
        if (resolved === 'moveTo') return 'm';
        if (resolved === 'lineTo') return 'l';
        if (resolved === 'curveTo') return 'c';
        if (resolved === 'curveTo2') return 'v';
        if (resolved === 'curveTo3') return 'y';
        if (resolved === 'closePath') return 'h';
        if (resolved === 'rectangle') return 're';
        const knownIds: Record<number, string> = {
            [opId('moveTo') ?? -100]: 'm', [opId('lineTo') ?? -101]: 'l',
            [opId('curveTo') ?? -102]: 'c', [opId('curveTo2') ?? -103]: 'v',
            [opId('curveTo3') ?? -104]: 'y', [opId('closePath') ?? -105]: 'h',
            [opId('rectangle') ?? -106]: 're',
        };
        return knownIds[code] || `op${code}`;
    };
    const paintName = (paint: any): string | number | null => {
        if (typeof paint !== 'number') return paint == null ? null : String(paint);
        const name = names.get(paint);
        return name ? MNEMONIC[name] || name : paint;
    };

    // Newer PDF.js: [paintOperatorId, [Float32Array(packed DrawOPS + coordinates)], bbox].
    // Some versions/builds expose the packed Float32Array directly instead of wrapping it.
    if (typeof values[0] === 'number' && values.length >= 3 && isArrayLike(values[1])) {
        const paint = values[0];
        const bbox = flattenArrayLike(values[values.length - 1]);
        const middle = flattenArrayLike(values[1]);
        const packed = middle.length === 1 && isArrayLike(middle[0])
            ? flattenArrayLike(middle[0])
            : middle;

        // An intermediate PDF.js shape has separate command and coordinate arrays:
        // [paintOperatorId, pathOps, coords, bbox]. OPS IDs are 13..19, not DrawOPS 0..4.
        const splitPath = values.length >= 4 && isArrayLike(values[2]) &&
            packed.every((entry) => typeof entry === 'number' && entry >= 13);
        if (splitPath) {
            const pathOps = packed;
            const coords = flattenArrayLike(values[2]);
            const counts: Record<string, number> = {};
            for (const code of pathOps) {
                const label = oldCommandName(code);
                counts[label] = (counts[label] || 0) + 1;
            }
            const result: Record<string, any> = {
                paint: paintName(paint), bbox: bbox.length >= 4 ? bbox.slice(0, 4) : null,
                commands: counts, commandCount: pathOps.length, coordinateCount: coords.length, argForm: 'paint+split-ops',
            };
            if (includeCoords) {
                result.pathOps = pathOps;
                result.coords = coords;
            }
            return result;
        }

        // DrawOPS is a packed variable-arity stream: m(0)=2 coords, l(1)=2,
        // cubic(2)=6, quadratic(3)=4, close(4)=0. Preserve the raw stream as-is.
        const drawNames: Record<number, { name: string; coordinates: number }> = {
            0: { name: 'm', coordinates: 2 },
            1: { name: 'l', coordinates: 2 },
            2: { name: 'c', coordinates: 6 },
            3: { name: 'q', coordinates: 4 },
            4: { name: 'h', coordinates: 0 },
        };
        const counts: Record<string, number> = {};
        const decodeErrors: any[] = [];
        for (let i = 0; i < packed.length;) {
            const codeIndex = i;
            const code = Number(packed[i++]);
            const command = drawNames[code];
            if (!command) {
                decodeErrors.push({ at: codeIndex, code });
                break;
            }
            counts[command.name] = (counts[command.name] || 0) + 1;
            const remaining = packed.length - i;
            if (remaining < command.coordinates) {
                decodeErrors.push({ at: codeIndex, code, expected: command.coordinates, remaining });
                break;
            }
            i += command.coordinates;
        }
        const result: Record<string, any> = {
            paint: paintName(paint), bbox: bbox.length >= 4 ? bbox.slice(0, 4) : null,
            commands: counts, commandCount: Object.values(counts).reduce((sum, count) => sum + count, 0),
            packedValueCount: packed.length, argForm: 'paint+packed-drawops',
        };
        if (decodeErrors.length) result.decodeErrors = decodeErrors;
        if (includeCoords) result.pathData = packed;
        return result;
    }

    // Older PDF.js: [OPS.moveTo/lineTo/...[], coordinateArray, bbox?].
    if (values.length >= 2 && isArrayLike(values[0]) && isArrayLike(values[1])) {
        const pathOps = flattenArrayLike(values[0]);
        const coords = flattenArrayLike(values[1]);
        const bbox = flattenArrayLike(values[2]);
        const counts: Record<string, number> = {};
        for (const code of pathOps) {
            const label = oldCommandName(code);
            counts[label] = (counts[label] || 0) + 1;
        }
        const result: Record<string, any> = {
            paint: null, bbox: bbox.length >= 4 ? bbox.slice(0, 4) : null,
            commands: counts, commandCount: pathOps.length, coordinateCount: coords.length, argForm: 'legacy-split-ops',
        };
        if (includeCoords) {
            result.pathOps = pathOps;
            result.coords = coords;
        }
        return result;
    }

    return { raw: normalizeJson(args), argForm: 'unknown' };
}

function compactOperationArgs(name: string, args: any, names: Map<number, string>, pdfjsOps: Record<string, number>, includePathCoords: boolean, numberDigits?: number): any {
    const values = flattenArrayLike(args);
    if (name === 'showText') {
        const glyphs = flattenArrayLike(values[0]);
        return { text: compactTextString(glyphText(glyphs)), glyphs: glyphs.length };
    }
    if (name === 'showSpacedText') {
        const parts = textAdjustmentParts(values[0], numberDigits);
        return { parts };
    }
    if (name === 'nextLineShowText') {
        const glyphs = flattenArrayLike(values[0]);
        return { text: compactTextString(glyphText(glyphs)), glyphs: glyphs.length };
    }
    if (name === 'nextLineSetSpacingShowText') {
        const glyphs = flattenArrayLike(values[2]);
        return {
            charSpacing: values[0] ?? null,
            wordSpacing: values[1] ?? null,
            text: compactTextString(glyphText(glyphs)),
            glyphs: glyphs.length,
        };
    }
    if (name === 'constructPath') return pathDescription(args, names, pdfjsOps, includePathCoords);

    // Preserve arrays and all scalar arguments. Replace glyph records with Unicode only.
    const simplify = (value: any): any => {
        if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value as ArrayLike<any>, simplify);
        if (value && typeof value === 'object') {
            if ('unicode' in value) return String(value.unicode ?? '');
            const out: Record<string, any> = {};
            for (const [key, val] of Object.entries(value)) {
                if (typeof val !== 'function' && val !== undefined) out[key] = simplify(val);
            }
            return out;
        }
        return value;
    };
    return simplify(args);
}

function summarizeOps(snapshot: DebugPageSnapshot): any {
    const { opList, pdfjsOps } = snapshot;
    const names = operationNames(pdfjsOps);
    const counts = new Map<string, { count: number; first: number }>();
    const allCounts = new Map<string, { count: number; first: number }>();
    const excluded = new Map<string, { count: number; first: number; reason: string }>();
    const unknown = new Map<number, { count: number; first: number }>();
    let defaultCount = 0;
    let noiseCount = 0;

    for (let i = 0; i < opList.fnArray.length; i++) {
        const id = Number(opList.fnArray[i]);
        const name = names.get(id);
        if (!name) {
            const old = unknown.get(id) || { count: 0, first: i };
            old.count++;
            unknown.set(id, old);
            continue;
        }
        const all = allCounts.get(name) || { count: 0, first: i };
        all.count++;
        allCounts.set(name, all);

        const args = opList.argsArray[i];
        const reason = SUMMARY_NOISE_OPS.has(name) ? 'display-noise' : isDefaultArgument(name, args) ? 'default-state' : null;
        if (reason) {
            const old = excluded.get(name) || { count: 0, first: i, reason };
            old.count++;
            excluded.set(name, old);
            if (reason === 'display-noise') noiseCount++;
            else defaultCount++;
            continue;
        }
        const shown = counts.get(name) || { count: 0, first: i };
        shown.count++;
        counts.set(name, shown);
    }

    const compactCounts = (map: Map<string, { count: number; first: number }>) => [...map.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)
        .map(([name, value]) => [MNEMONIC[name] || name, value.count, value.first]);

    const ignored: any[] = [];
    const unhandled: any[] = [];
    let handledTypeCount = 0;
    for (const [name, info] of [...allCounts.entries()].sort((a, b) => a[1].first - b[1].first)) {
        const entry = [MNEMONIC[name] || name, info.count, info.first];
        if (EXTRACTOR_HANDLED_OPS.has(name)) handledTypeCount++;
        else if (EXTRACTOR_IGNORED_OPS.has(name)) ignored.push(entry);
        else unhandled.push(entry);
    }

    const actualStatus = snapshot.opStatus;
    let runtimeCoverage: any = null;
    if (actualStatus) {
        const statuses = { handled: 0, ignored: 0, unhandled: 0, unknown: 0, unreported: 0 };
        actualStatus.forEach((status) => {
            if (status && status in statuses) statuses[status as keyof typeof statuses]++;
            else statuses.unreported++;
        });
        runtimeCoverage = statuses;
    }

    return {
        total: opList.fnArray.length,
        visible: compactCounts(counts),
        excluded: {
            total: [...excluded.values()].reduce((sum, entry) => sum + entry.count, 0),
            displayNoise: noiseCount,
            defaultState: defaultCount,
        },
        coverage: {
            basis: actualStatus ? 'runtime' : 'declared',
            encounteredTypes: allCounts.size + unknown.size,
            declaredHandledTypes: handledTypeCount,
            intentionallyIgnored: ignored,
            noDeclaredHandlerTypes: unhandled,
            unknownPdfjsIds: [...unknown.entries()].map(([id, value]) => [id, value.count, value.first]),
            runtime: runtimeCoverage,
        },
    };
}

function compactOps(snapshot: DebugPageSnapshot, requested?: OperationWindow, maxItems = DEFAULT_MAX_ITEMS, numberDigits?: number): any {
    const total = snapshot.opList.fnArray.length;
    const from = Math.max(0, Math.floor(requested?.from ?? 0));
    const requestedTo = Math.floor(requested?.to ?? Math.min(total - 1, DEFAULT_OP_WINDOW - 1));
    const to = total ? Math.min(total - 1, requestedTo) : -1;
    const validRange = total > 0 && from < total && to >= from;
    const names = operationNames(snapshot.pdfjsOps);
    const rows: any[] = [];
    const allEntries = validRange ? to - from + 1 : 0;
    const shownTo = validRange ? Math.min(to, from + Math.max(0, maxItems) - 1) : -1;

    for (let i = from; i <= shownTo; i++) {
        const id = Number(snapshot.opList.fnArray[i]);
        const name = names.get(id) || `op:${id}`;
        const args = snapshot.opList.argsArray[i];
        rows.push({
            i,
            op: MNEMONIC[name] || name,
            args: compactOperationArgs(name, args, names, snapshot.pdfjsOps, true, numberDigits),
            status: snapshot.opStatus?.[i] || (names.has(id)
                ? EXTRACTOR_HANDLED_OPS.has(name) ? 'mapped-type'
                    : EXTRACTOR_IGNORED_OPS.has(name) ? 'ignored-by-design' : 'no-declared-handler'
                : 'unknown-pdfjs-id'),
        });
    }
    return {
        requested: requested ? [requested.from, requested.to] : null,
        actual: validRange ? [from, to] : [],
        totalInRange: allEntries,
        shown: rows.length,
        omitted: Math.max(0, allEntries - rows.length),
        ops: rows,
    };
}

function compactText(
    items: any[],
    source: 'pdfjs' | 'extractor',
    region?: Region,
    maxItems = DEFAULT_MAX_ITEMS,
    maxRows = Number.MAX_SAFE_INTEGER,
): any {
    const selected = (items || []).map((item, index) => ({ item, index }))
        .filter(({ item }) => item && typeof item.str === 'string' && item.str.length > 0 && item.transform)
        .map(({ item, index }) => {
            const transform = flattenArrayLike(item.transform).slice(0, 6).map((v) => Number(v));
            const box = textBox(item);
            return { item, index, transform, box };
        })
        .filter(({ box }) => source === 'pdfjs' || !region || (box ? inRegion(box, region) : true));

    const fonts = new Map<string, string>();
    const fontId = (font: any): string => {
        const value = String(font ?? '-');
        if (!fonts.has(value)) fonts.set(value, `f${fonts.size + 1}`);
        return fonts.get(value)!;
    };
    selected.sort((a, b) => {
        const ay = Number(a.transform[5] ?? 0), by = Number(b.transform[5] ?? 0);
        return by - ay || Number(a.transform[4] ?? 0) - Number(b.transform[4] ?? 0) || a.index - b.index;
    });

    const rowGroups: typeof selected[] = [];
    for (const cell of selected) {
        const row = rowGroups[rowGroups.length - 1];
        if (row && Math.abs(Number(row[0].transform[5]) - Number(cell.transform[5])) <= 0.6) row.push(cell);
        else rowGroups.push([cell]);
    }

    const output: any[] = [];
    let emitted = 0;
    outer: for (const row of rowGroups.slice(0, maxRows)) {
        row.sort((a, b) => Number(a.transform[4]) - Number(b.transform[4]) || a.index - b.index);
        const compactRow: any[] = [];
        for (const { item, index, transform } of row) {
            if (emitted >= maxItems) break outer;
            const sourceOps = item.__pdfTraceOpIndexes != null
                ? item.__pdfTraceOpIndexes
                : item.__pdfTraceOpIndex != null ? [item.__pdfTraceOpIndex] : [];
            const extraOps = flattenArrayLike(sourceOps).filter((v) => Number.isInteger(v));
            const opRef = extraOps.length === 0 ? null : extraOps.length === 1 ? extraOps[0] : extraOps;
            compactRow.push([
                index,
                opRef,
                transform,
                Number(item.width ?? 0),
                Number(item.height ?? 0),
                fontId(item.fontName),
                item.dir ?? 'ltr',
                item.hasEOL === true,
                item.hasEOT === undefined ? null : item.hasEOT === true,
                compactTextString(item.str),
            ]);
            emitted++;
        }
        if (compactRow.length) output.push([Number(row[0].transform[5]), compactRow]);
        if (emitted >= maxItems) break;
    }

    return {
        frame: source === 'pdfjs' ? 'pdfjs.raw' : 'excelsior.current.raw',
        schema: ['i', 'op', 'tr[a,b,c,d,e,f]', 'w', 'h', 'f', 'dir', 'eol', 'eot', 's'], rowGrouping: 'approximate visual rows by tr[5] within 0.6; i is the original array index',
        fonts: [...fonts.entries()].map(([name, id]) => [id, name]),
        itemCount: selected.length,
        rowCount: rowGroups.length,
        shownRows: output.length,
        omittedRows: Math.max(0, rowGroups.length - output.length),
        shownItems: emitted,
        omittedItems: Math.max(0, selected.length - emitted),
        rows: output,
    };
}

function compactColor(color: any, numberDigits?: number): string | null {
    if (color == null || color === '') return null;
    const value = String(color).trim();
    const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(value);
    if (rgb) {
        const hex = rgb.slice(1, 4).map((channel) => Math.max(0, Math.min(255, Math.round(Number(channel))))
            .toString(16).padStart(2, '0')).join('');
        const short = `#${hex}`;
        const alpha = rgb[4] == null ? 1 : Number(rgb[4]);
        return alpha === 1 ? short : `${short}@${round(alpha, numberDigits ?? 2)}`;
    }
    return value;
}

function compactGraphics(edges: any[], rectangles: any[], lineMaxWidth = 5, region?: Region, maxItems = DEFAULT_MAX_ITEMS, numberDigits?: number): any {
    type LineGroup = {
        orientation: 'H' | 'V'; axis: number; thickness: number;
        stroke: string | null; fill: string | null; spans: Array<[number, number | null, number, number]>;
    };
    const groupedLines = new Map<string, LineGroup>();
    const diagonalOrOther: any[] = [];
    let noColor = 0;
    let horizontal = 0;
    let vertical = 0;
    let other = 0;
    let regionEdgeCount = 0;

    for (let index = 0; index < (edges || []).length; index++) {
        const edge = edges[index];
        const box = {
            x: Number(edge?.x ?? 0), y: Number(edge?.y ?? 0),
            width: Number(edge?.width ?? 0), height: Number(edge?.height ?? 0),
        };
        if (region && !inRegion(box, region)) continue;
        regionEdgeCount++;
        const w = box.width;
        const h = box.height;
        const isH = h < lineMaxWidth && w > lineMaxWidth;
        const isV = w < lineMaxWidth && h > lineMaxWidth;
        const stroke = compactColor(edge?.strokeColor, numberDigits);
        const fill = compactColor(edge?.fillColor, numberDigits);
        if (stroke == null && fill == null) noColor++;

        if (!isH && !isV) {
            other++;
            if (diagonalOrOther.length < maxItems) {
                diagonalOrOther.push([index, Number.isInteger(edge?.__pdfTraceOpIndex) ? edge.__pdfTraceOpIndex : null, box.x, box.y, w, h, stroke, fill, edge?.lineWidth == null ? null : Number(edge.lineWidth)]);
            }
            continue;
        }

        if (isH) horizontal++;
        else vertical++;
        const orientation = isH ? 'H' : 'V';
        const axis = isH ? box.y + h / 2 : box.x + w / 2;
        const thickness = isH ? h : w;
        const key = [orientation, round(axis, numberDigits ?? NUMBER_DIGITS), round(thickness, numberDigits ?? NUMBER_DIGITS), stroke ?? '-', fill ?? '-'].join('|');
        const group = groupedLines.get(key) || {
            orientation, axis, thickness, stroke, fill, spans: [],
        };
        const [spanStart, spanEnd] = isH ? [box.x, box.x + w] : [box.y, box.y + h];
        group.spans.push([index, Number.isInteger(edge?.__pdfTraceOpIndex) ? edge.__pdfTraceOpIndex : null, spanStart, spanEnd]);
        groupedLines.set(key, group);
    }

    // Store every segment endpoint; unlike a visual line merger this does not bridge gaps.
    const allLineGroups = [...groupedLines.values()]
        .sort((a, b) => a.orientation.localeCompare(b.orientation) || (a.orientation === 'H' ? b.axis - a.axis : a.axis - b.axis))
        .map((line) => {
            const spans = line.spans.sort((a, b) => a[2] - b[2] || a[0] - b[0]);
            return {
                orientation: line.orientation,
                axis: line.axis,
                thickness: line.thickness,
                strokeColor: line.stroke,
                fillColor: line.fill,
                segmentCount: spans.length,
                spansShown: Math.min(spans.length, maxItems),
                spansOmitted: Math.max(0, spans.length - maxItems),
                spans: spans.slice(0, maxItems),
            };
        });
    const shownLineGroups = allLineGroups.slice(0, maxItems);

    const rectGroups = new Map<string, { fill: string | null; stroke: string | null; lineWidth: number | null; boxes: any[]; count: number }>();
    let rectCount = 0;
    for (let index = 0; index < (rectangles || []).length; index++) {
        const rect = rectangles[index];
        const box = {
            x: Number(rect?.x ?? 0), y: Number(rect?.y ?? 0),
            width: Number(rect?.width ?? 0), height: Number(rect?.height ?? 0),
        };
        if (region && !inRegion(box, region)) continue;
        rectCount++;
        const fill = compactColor(rect?.fillColor, numberDigits);
        const stroke = compactColor(rect?.strokeColor, numberDigits);
        const lineWidth = rect?.lineWidth == null ? null : Number(rect.lineWidth);
        const key = [fill ?? '-', stroke ?? '-', lineWidth ?? '-'].join('|');
        const group = rectGroups.get(key) || { fill, stroke, lineWidth, boxes: [], count: 0 };
        group.count++;
        if (group.boxes.length < maxItems) group.boxes.push([index, Number.isInteger(rect?.__pdfTraceOpIndex) ? rect.__pdfTraceOpIndex : null, box.x, box.y, box.width, box.height]);
        rectGroups.set(key, group);
    }

    const allRectGroupValues = [...rectGroups.values()].map((group) => ({
        fillColor: group.fill,
        strokeColor: group.stroke,
        lineWidth: group.lineWidth,
        count: group.count,
        shown: group.boxes.length,
        omitted: Math.max(0, group.count - group.boxes.length),
        boxes: group.boxes,
    }));
    const rectGroupValues = allRectGroupValues.slice(0, maxItems);
    return {
        frame: 'excelsior.geometry.current',
        edgeCount: region ? regionEdgeCount : (edges || []).length,
        horizontal, vertical, other, noColor,
        lineGroupCount: allLineGroups.length,
        lineGroupsShown: shownLineGroups.length,
        lineGroupsOmitted: Math.max(0, allLineGroups.length - shownLineGroups.length),
        lineGroups: shownLineGroups,
        otherEdgesShown: diagonalOrOther.length,
        otherEdgesOmitted: Math.max(0, other - diagonalOrOther.length),
        otherEdges: diagonalOrOther,
        rectangleCount: rectCount,
        rectangleGroupCount: allRectGroupValues.length,
        rectangleGroupsShown: rectGroupValues.length,
        rectangleGroupsOmitted: Math.max(0, allRectGroupValues.length - rectGroupValues.length),
        rectangleGroups: rectGroupValues,
        limits: { maxItemsPerGroup: maxItems, lineSegmentsAreNotMerged: true },
    };
}
function lintItems(
    items: any[],
    pdfjsItems: any[],
    page: { width: number; height: number },
    compareTextPositions = false,
): any {
    const text = (items || []).map((item, index) => ({ item, index }))
        .filter(({ item }) => item?.transform && typeof item.str === 'string' && item.str.length > 0);
    const issues: any[] = [];
    const sampleText = (item: any) => compactTextString(String(item?.str ?? '').trim().slice(0, 32));

    const nonFinite = text.filter(({ item }) => {
        const tr = flattenArrayLike(item.transform);
        return tr.length < 6 || ![tr[0], tr[1], tr[2], tr[3], tr[4], tr[5], item.width, item.height].every((v) => Number.isFinite(Number(v)));
    });
    if (nonFinite.length) issues.push({
        type: 'non-finite-geometry', count: nonFinite.length,
        samples: nonFinite.slice(0, 4).map(({ item, index }) => ({ i: index, op: item.__pdfTraceOpIndex ?? item.__pdfTraceOpIndexes ?? null, text: sampleText(item) })),
    });

    const badHeight = text.filter(({ item }) => {
        const tr = flattenArrayLike(item.transform).map(Number);
        if (tr.length < 6) return false;
        const transformSize = Math.hypot(tr[2], tr[3]);
        const height = Number(item.height);
        return Number.isFinite(transformSize) && Number.isFinite(height) && transformSize > 0 && Math.abs(height - transformSize) > transformSize * 0.5;
    });
    if (badHeight.length) issues.push({
        type: 'height-differs-from-transform-scale', count: badHeight.length,
        samples: badHeight.slice(0, 5).map(({ item, index }) => ({
            i: index, op: item.__pdfTraceOpIndex ?? item.__pdfTraceOpIndexes ?? null, text: sampleText(item), height: item.height,
            transformSize: Math.hypot(Number(item.transform[2]), Number(item.transform[3])),
        })),
        meaning: 'review-only; width/height and matrix scale may use different conventions',
    });

    const anchors = new Map<string, Array<{ item: any; index: number }>>();
    for (const entry of text) {
        const tr = flattenArrayLike(entry.item.transform).map(Number);
        if (tr.length < 6 || !Number.isFinite(tr[4]) || !Number.isFinite(tr[5])) continue;
        const key = `${Math.round(tr[4] * 2)}|${Math.round(tr[5] * 2)}`;
        const list = anchors.get(key) || [];
        list.push(entry);
        anchors.set(key, list);
    }
    const collisions = [...anchors.values()].filter((entries) => entries.length > 1 && new Set(entries.map(({ item }) => String(item.str).trim())).size > 1);
    if (collisions.length) issues.push({
        type: 'coincident-text-origins-review', count: collisions.length,
        samples: collisions.slice(0, 4).map((entries) => entries.slice(0, 4).map(({ item, index }) => ({ i: index, op: item.__pdfTraceOpIndex ?? item.__pdfTraceOpIndexes ?? null, text: sampleText(item) }))),
        meaning: 'possible overlap/overprint; intentional overlays are possible',
    });

    const outside = text.filter(({ item }) => {
        const box = textBox(item);
        return box && (box.x + box.width < -1 || box.y + box.height < -1 || box.x > page.width + 1 || box.y > page.height + 1);
    });
    if (outside.length) issues.push({
        type: 'text-bbox-outside-viewport', count: outside.length,
        samples: outside.slice(0, 4).map(({ item, index }) => {
            const box = textBox(item)!;
            return { i: index, op: item.__pdfTraceOpIndex ?? item.__pdfTraceOpIndexes ?? null, text: sampleText(item), bbox: [box.x, box.y, box.width, box.height] };
        }),
    });

    const pdfjsText = (pdfjsItems || []).filter((item) => typeof item?.str === 'string' && item.str.trim() && item?.transform);
    let positionComparison: any = { status: 'not-run' };
    if (compareTextPositions) {
        const countByText = (list: any[]) => {
            const map = new Map<string, any[]>();
            for (const item of list) {
                const key = String(item.str).trim();
                const values = map.get(key) || [];
                values.push(item);
                map.set(key, values);
            }
            return map;
        };
        const a = countByText(text.map(({ item }) => item));
        const b = countByText(pdfjsText);
        const mismatches: any[] = [];
        let checked = 0;
        let ambiguous = 0;
        for (const [str, sourceItems] of a.entries()) {
            const refs = b.get(str) || [];
            if (sourceItems.length !== 1 || refs.length !== 1) {
                if (refs.length) ambiguous++;
                continue;
            }
            checked++;
            const x = flattenArrayLike(sourceItems[0].transform).map(Number);
            const y = flattenArrayLike(refs[0].transform).map(Number);
            if (x.length >= 6 && y.length >= 6 && Math.hypot(x[4] - y[4], x[5] - y[5]) > 2) {
                mismatches.push({ text: compactTextString(str.slice(0, 32)), extractor: [x[4], x[5]], pdfjs: [y[4], y[5]] });
            }
        }
        positionComparison = {
            status: 'performed', coordinateFrameAssumedEqual: true, checkedUniqueTexts: checked,
            ambiguousRepeatedTexts: ambiguous, mismatches: mismatches.slice(0, 8), mismatchCount: mismatches.length,
        };
        if (mismatches.length) issues.push({ type: 'text-position-mismatch', count: mismatches.length, samples: mismatches.slice(0, 5) });
    }

    const missingOpRef = text.filter(({ item }) => item.__pdfTraceOpIndex == null && item.__pdfTraceOpIndexes == null).length;
    return {
        issues,
        counts: {
            textItemsChecked: text.length,
            missingSourceOpReference: missingOpRef,
            pdfjsTextItems: pdfjsText.length,
        },
        pdfjsPositionComparison: positionComparison,
    };
}

function dumpGrid(group: any, maxItems = DEFAULT_MAX_ITEMS): any {
    const horizons = group?.horizons || [];
    const verticles = group?.verticles || [];
    const matrix = group?.matrix || [];
    const rowCount = Math.max(horizons.length - 1, 0);
    const columnCount = Math.max(verticles.length - 1, 0);
    const merges = Object.entries(group?.merges || {})
        .filter(([, merge]: [string, any]) => Number(merge?.width ?? 1) > 1 || Number(merge?.height ?? 1) > 1);
    return {
        rows: rowCount,
        columns: columnCount,
        y: horizons.slice(0, maxItems).map((h: any) => h?.y ?? null),
        x: verticles.slice(0, maxItems).map((v: any) => v?.x ?? null),
        coordinatesOmitted: {
            y: Math.max(0, horizons.length - maxItems),
            x: Math.max(0, verticles.length - maxItems),
        },
        headerRows: Object.keys(group?.headerRows || {}).slice(0, maxItems),
        mergeCount: merges.length,
        merges: merges.slice(0, maxItems).map(([key, merge]: [string, any]) => [key, Number(merge.height ?? 1), Number(merge.width ?? 1)]),
        mergesOmitted: Math.max(0, merges.length - maxItems),
        matrixRowsShown: Math.min(matrix.length, maxItems),
        matrixRowsOmitted: Math.max(0, matrix.length - maxItems),
        matrixColumnsShown: Math.min(columnCount, maxItems),
        matrix: matrix.slice(0, maxItems).map((row: any[]) => (row || []).slice(0, maxItems).map((value: any) => value ? '#' : '.').join('')),
        matrixColumnsOmitted: Math.max(0, columnCount - maxItems),
    };
}

function tableToCompact(array: any[][], merges: Record<string, any> = {}, mergeAlias: Record<string, string> = {}, maxItems = DEFAULT_MAX_ITEMS): any {
    const sourceRows = Array.isArray(array) ? array : [];
    const rowCount = sourceRows.length;
    const columnCount = Math.max(0, ...sourceRows.map((row) => Array.isArray(row) ? row.length : 0));
    const rowLimit = Math.min(rowCount, maxItems);
    const columnLimit = Math.min(columnCount, maxItems);
    const rows = sourceRows.slice(0, rowLimit).map((row, ri) => (row || []).slice(0, columnLimit).map((cell, ci) => {
        const key = `${ri}-${ci}`;
        if (mergeAlias?.[key]) return '~';
        const merge = merges?.[key];
        const height = Number(merge?.height ?? 1);
        const width = Number(merge?.width ?? 1);
        const span = height > 1 || width > 1 ? `{${height > 1 ? `r${height}` : ''}${width > 1 ? `c${width}` : ''}}` : '';
        return compactTextString(String(cell?.str ?? cell ?? '').trim()) + span;
    }));
    return {
        rows,
        rowCount,
        columnCount,
        shownRows: rows.length,
        omittedRows: Math.max(0, rowCount - rows.length),
        shownColumns: columnLimit,
        omittedColumns: Math.max(0, columnCount - columnLimit),
    };
}

function decodeHtmlEntities(value: string): string {
    const named: Record<string, string> = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
        ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', ndash: '\u2013', mdash: '\u2014',
    };
    return value.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi, (whole, entity: string) => {
        if (entity[0] === '#') {
            const hex = entity[1]?.toLowerCase() === 'x';
            const cp = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
            if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff) {
                try { return String.fromCodePoint(cp); } catch { return whole; }
            }
            return whole;
        }
        return named[entity.toLowerCase()] ?? whole;
    });
}

/**
 * HTML table to the same logical rows used by tableToCompact(). Rowspans and
 * colspans occupy their complete grid footprint; covered positions become '~'.
 */
function htmlToCompact(html: string): string {
    const sourceRows = [...String(html ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    const grid: string[][] = [];
    const occupied = new Map<string, boolean>();
    for (let ri = 0; ri < sourceRows.length; ri++) {
        const row: string[] = grid[ri] || (grid[ri] = []);
        const cells = [...sourceRows[ri][1].matchAll(/<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/gi)];
        let col = 0;
        for (const cell of cells) {
            while (occupied.has(`${ri}-${col}`)) {
                row[col] = '~';
                col++;
            }
            const attrs = cell[2];
            const rowSpan = Math.max(1, Number(/\browspan\s*=\s*["']?(\d+)/i.exec(attrs)?.[1] ?? 1));
            const colSpan = Math.max(1, Number(/\bcolspan\s*=\s*["']?(\d+)/i.exec(attrs)?.[1] ?? 1));
            const rawText = cell[3]
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<[^>]*>/g, '');
            const text = compactTextString(decodeHtmlEntities(rawText).replace(/\r\n?/g, '\n').trim());
            const span = rowSpan > 1 || colSpan > 1 ? `{${rowSpan > 1 ? `r${rowSpan}` : ''}${colSpan > 1 ? `c${colSpan}` : ''}}` : '';
            row[col] = text + span;
            for (let dy = 0; dy < rowSpan; dy++) {
                const targetRow = ri + dy;
                grid[targetRow] ||= [];
                for (let dx = 0; dx < colSpan; dx++) {
                    const targetCol = col + dx;
                    if (dy === 0 && dx === 0) continue;
                    occupied.set(`${targetRow}-${targetCol}`, true);
                    grid[targetRow][targetCol] = '~';
                }
            }
            col += colSpan;
        }
        for (let c = 0; c < row.length; c++) {
            if (occupied.has(`${ri}-${c}`) && row[c] == null) row[c] = '~';
        }
    }
    const columnCount = Math.max(0, ...grid.map((row) => row.length));
    const normalized = grid.map((row, ri) => Array.from({ length: columnCount }, (_, ci) => {
        if (row[ci] != null) return row[ci];
        return occupied.has(`${ri}-${ci}`) ? '~' : '';
    }));
    return oneLine(normalized);
}

function tableGroupSummary(group: any, index: number, maxItems: number, suppliedArray?: any[][]): any {
    const tableData = group?.tableData;
    const array = suppliedArray ?? tableData?.table?.array;
    const horizons = group?.horizons || [];
    const verticles = group?.verticles || [];
    const xs = verticles.map((v: any) => Number(v?.x)).filter(Number.isFinite);
    const ys = horizons.map((h: any) => Number(h?.y)).filter(Number.isFinite);
    const mergeEntries = Object.entries(group?.merges || {})
        .filter(([, merge]: [string, any]) => Number(merge?.width ?? 1) > 1 || Number(merge?.height ?? 1) > 1);
    return {
        index,
        bbox: xs.length && ys.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null,
        rowCount: Math.max(0, horizons.length - 1),
        columnCount: Math.max(0, verticles.length - 1),
        x: xs.slice(0, maxItems),
        y: ys.slice(0, maxItems),
        hasTableData: Array.isArray(array),
        dimensions: Array.isArray(array) ? [array.length, Math.max(0, ...array.map((row: any) => Array.isArray(row) ? row.length : 0))] : null,
        mergeCount: mergeEntries.length,
        merges: mergeEntries.slice(0, maxItems).map(([key, merge]: [string, any]) => [key, Number(merge.height ?? 1), Number(merge.width ?? 1)]),
        mergesOmitted: Math.max(0, mergeEntries.length - maxItems),
        tableRows: Array.isArray(array) ? tableToCompact(array, group?.merges || {}, group?.mergeAlias || {}, maxItems) : null,
        grid: dumpGrid(group, maxItems),
    };
}

function visualRowCount(items: any[]): number {
    const yValues = (items || [])
        .filter((item) => item && typeof item.str === 'string' && item.str.length > 0 && flattenArrayLike(item.transform).length >= 6)
        .map((item) => Number(item.transform[5]))
        .filter(Number.isFinite)
        .sort((a, b) => b - a);
    let rows = 0;
    let lastY: number | null = null;
    for (const y of yValues) {
        if (lastY === null || Math.abs(lastY - y) > 0.6) {
            rows++;
            lastY = y;
        }
    }
    return rows;
}

function normalizeLevel(level: DebugLevel | undefined): 'summary' | 'trace' | 'ops' | 'tables' {
    if (level === 'L0') return 'summary';
    if (level === 'L1') return 'trace';
    if (level === 'L2') return 'ops';
    if (level === 'L3') return 'tables';
    return level || 'summary';
}

function nextStep(summary: any, snapshot: DebugPageSnapshot, groups: any[]): any {
    const unknown = summary.coverage.unknownPdfjsIds as any[];
    if (unknown.length) {
        const firstIndex = Math.min(...unknown.map((entry) => Number(entry[2])).filter(Number.isFinite));
        const from = Number.isFinite(firstIndex) ? Math.max(0, firstIndex - 8) : 0;
        const to = Number.isFinite(firstIndex)
            ? Math.min(snapshot.opList.fnArray.length - 1, firstIndex + 12)
            : Math.min(snapshot.opList.fnArray.length - 1, DEFAULT_OP_WINDOW - 1);
        return {
            level: 'ops',
            opWindow: [from, Math.max(from, to)],
            reason: 'unknownPdfjsIds',
        };
    }
    const unhandled = summary.coverage.noDeclaredHandlerTypes as any[];
    if (unhandled.length) {
        const firstIndex = Math.min(...unhandled.map((entry) => Number(entry[2])).filter(Number.isFinite));
        const from = Number.isFinite(firstIndex) ? Math.max(0, firstIndex - 8) : 0;
        const to = Number.isFinite(firstIndex) ? Math.min(snapshot.opList.fnArray.length - 1, firstIndex + 12) : Math.min(snapshot.opList.fnArray.length - 1, DEFAULT_OP_WINDOW - 1);
        return {
            level: 'ops',
            opWindow: [from, Math.max(from, to)],
            reason: 'noDeclaredHandler',
        };
    }
    if (!groups.some((group) => !!group?.tableData)) {
        return { level: 'trace', reason: 'noTableData' };
    }
    return { level: 'tables', reason: 'tableDataPresent' };
}

/** Build a structured report, or a compact pseudo-JSON string when minify=true. */
export function buildDebugReport(input: DebugPageSnapshot & DebugOptions & { minify: true }): string;
export function buildDebugReport(input: DebugPageSnapshot & DebugOptions & { minify?: false | undefined }): DebugReportData;
export function buildDebugReport(input: DebugPageSnapshot & DebugOptions): DebugReportData | string;
export function buildDebugReport(input: DebugPageSnapshot & DebugOptions): DebugReportData | string {
    const snapshot = input;
    const options = input;
    const level = normalizeLevel(options.level);
    const numberDigits = normalizeNumberDigits(options.numberDigits);
    const maxItems = Math.max(1, Math.floor(options.maxItems ?? DEFAULT_MAX_ITEMS));
    const opSummary = summarizeOps(snapshot);
    const textItems = snapshot.items || [];
    const pdfjsItems = snapshot.pdfjsItems || [];
    const groups = snapshot.tableGroups || (snapshot.tables || []).map((table) => table.group);
    const tables = snapshot.tables ?? groups.filter((group) => !!group?.tableData).map((group) => ({ group, array: group.tableData?.table?.array || [] }));
    const tablesFound = tables.length;
    const lint = lintItems(textItems, pdfjsItems, snapshot.pageSize, options.compareTextPositions === true);

    const report: Record<string, any> = {
        format: 'PDFTRACE/1',
        page: {
            number: snapshot.pageNumber,
            viewport: [snapshot.pageSize.width, snapshot.pageSize.height],
            rotationDeg: snapshot.pageSize.rotation ?? null,
        },
        legend: {
            idx: 'op.i and geometry op refs are zero-based OperatorList indexes; not PDF byte offsets',
            ops: 'PDF.js OperatorList-normalized operations, not raw PDF tokens; visible tuples=[mnemonic,count,firstIndex]; excluded only from histogram',
            coverage: 'basis=declared checks types against the declared handler map, not invocation success; runtime requires per-op instrumentation',
            coords: 'page.viewport=getViewport({scale:1}) size after rotation; text tr/w/h are raw values and may use another frame; tr=[a,b,c,d,e,f]',
            text: 'text row=[i,opIndexOrIndexes|null,tr,w,h,fontRef,dir,eol,eot,text]; fontRef maps through fonts; eol=PDF.js hasEOL; eot=extractor hasEOT or null',
            spaces: '⟦SP:n⟧=n literal spaces; literal ⟦ is doubled; JSON escapes newlines',
            graphics: 'edge spans=[edgeIndex,opIndex|null,start,end]; other edges=[edgeIndex,opIndex|null,x,y,w,h,stroke,fill,lineWidth]; rect boxes=[rectIndex,opIndex|null,x,y,w,h]',
            textFrames: 'pdfjs.raw=getTextContent; excelsior.current.raw=interpreter values at report time; frames may differ',
            nextReason: 'unknownPdfjsIds|noDeclaredHandler|noTableData|tableDataPresent',
            omitted: 'omittedByLevel codes: text,graphics,opArgs,tables; detailed sections expose their own omitted counts',
            tj: numberDigits === undefined
                ? 'TJ parts are text runs or {adjust:"number-as-string"}; adjustment precision is preserved'
                : `TJ numeric adjustments are rounded to at most ${numberDigits} decimal digits`,
            path: 'modern packed DrawOPS: 0=m,1=l,2=cubic,3=quadratic,4=close; legacy split commands use PDF.js OPS IDs',
            tables: 'table cells use {rN}/{cN} for rowspan/colspan; ~ marks a covered/alias cell; grid.matrix uses #=occupied, .=empty',
            levels: 'L0=summary, L1=trace, L2=ops, L3=tables'
        },
        ops: opSummary,
        textCounts: {
            pdfjs: pdfjsItems.filter((item) => item && typeof item.str === 'string' && item.str.length > 0).length,
            extractor: textItems.filter((item) => item && typeof item.str === 'string' && item.str.length > 0).length,
            extractorVisualRows: visualRowCount(textItems),
        },
        graphicsCounts: {
            edges: (snapshot.edges || []).length,
            rectangles: (snapshot.rectangles || []).length,
        },
        tables: {
            groups: groups.length,
            withTableData: tablesFound,
            withoutTableData: groups.length - tablesFound,
        },
        lint,
        omittedByLevel: level === 'summary'
            ? ['text', 'graphics', 'opArgs', 'tables']
            : level === 'trace'
                ? ['opArgs', 'tables']
                : level === 'ops'
                    ? ['tables']
                    : [],
        next: nextStep(opSummary, snapshot, groups),
    };

    if (level !== 'summary') {
        report.graphics = compactGraphics(snapshot.edges || [], snapshot.rectangles || [], snapshot.lineMaxWidth ?? 5, options.region, maxItems, numberDigits);
        report.pdfjsText = compactText(pdfjsItems, 'pdfjs', undefined, maxItems);
        report.extractorText = compactText(textItems, 'extractor', options.region, maxItems);
    }

    if (level === 'ops' || level === 'tables') {
        const firstUnhandled = (opSummary.coverage.noDeclaredHandlerTypes as any[])
            .map((entry) => Number(entry[2]))
            .filter(Number.isFinite)
            .sort((a, b) => a - b)[0];

        const requestedWindow = normalizeOperationWindow(options.opWindow);

        const selectedWindow = requestedWindow ?? (firstUnhandled == null
            ? {
                from: 0,
                to: Math.min(
                    snapshot.opList.fnArray.length - 1,
                    DEFAULT_OP_WINDOW - 1,
                ),
            }
            : {
                from: Math.max(0, firstUnhandled - 8),
                to: Math.min(
                    snapshot.opList.fnArray.length - 1,
                    firstUnhandled + 12,
                ),
            });

        report.opWindow = compactOps(
            snapshot,
            selectedWindow,
            maxItems,
            numberDigits,
        );

        if (!requestedWindow) {
            (report.opWindow as any).automatic = true;
            (report.opWindow as any).automaticReason = firstUnhandled == null
                ? 'firstOps'
                : `firstNoHandler:${firstUnhandled}`;
        }
    }

    if (level === 'tables') {
        report.tableDetails = groups.slice(0, maxItems).map((group, index) => {
            const table = tables.find((entry) => entry.group === group);
            return tableGroupSummary(group, index, maxItems, table?.array);
        });
        report.tableDetailsCount = groups.length;
        report.tableDetailsOmitted = Math.max(0, groups.length - Math.min(groups.length, maxItems));
        if (options.expectedHtml !== undefined) {
            const expectedRows: any[][] = JSON.parse(htmlToCompact(options.expectedHtml as any));
            const expectedColumns = Math.max(0, ...expectedRows.map((row) => row.length));
            report.expectedTable = {
                source: 'caller-html',
                rowCount: expectedRows.length,
                columnCount: expectedColumns,
                rowsShown: Math.min(expectedRows.length, maxItems),
                columnsShown: Math.min(expectedColumns, maxItems),
                rowsOmitted: Math.max(0, expectedRows.length - maxItems),
                columnsOmitted: Math.max(0, expectedColumns - maxItems),
                rows: expectedRows.slice(0, maxItems).map((row) => row.slice(0, maxItems)),
            };
        }
    }

    if (!options.minify) {
        return normalizeJson(report, numberDigits) as DebugReportData;
    }

    // Keep actual text payloads quoted even when they happen to look like a
    // safe bare token (for example "ABC"). Other safe words/enums remain
    // unquoted, and object keys are shortened by stringifyPseudoJson itself.
    const quoteTextValues = (key: string, path: string[]): boolean => {
        if (key === 'text' || key === 'str' || key === 's') return true;

        const root = path[0];
        if ((root === 'pdfjsText' || root === 'extractorText') &&
            path[1] === 'rows' && path[path.length - 1] === '9') {
            return true;
        }

        // TJ parts are compact arrays of text runs and {adjust: ...} entries.
        const partsIndex = path.indexOf('parts');
        if (partsIndex >= 0 && path.length === partsIndex + 2) return true;

        if (root === 'expectedTable' && path[1] === 'rows') return true;

        const tableRowsIndex = path.indexOf('tableRows');
        if (tableRowsIndex >= 0 && path[tableRowsIndex + 1] === 'rows') return true;

        return false;
    };

    return stringifyPseudoJson(normalizeJson(report), {
        quoteValues: quoteTextValues,
        ...(numberDigits === undefined ? {} : { numberDigits }),
    })
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

