# PDFTRACE/1 — Usage

`debug` is configured per `extractorRun` call. Diagnostics are disabled by default, do not modify the regular result object, and perform no I/O on their own. A report for each processed page is passed to the callback as a JSON string **with no newline characters**.

## Browser

```ts
import * as excelsiorPdfParserModule from '@unsonet/excelsior-pdf-parser';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.min.mjs';

const reports: string[] = [];
const excelsiorPdf = excelsiorPdfParserModule.init({
    pdfjs,
    workerSrc: 'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
});

await excelsiorPdf.extractorRun({
    dataArray: fileByteArray,
    pages: [1],
    debug: {
        level: 'ops', // summary/L0 | trace/L1 | ops/L2 | tables/L3
        onReport: ({ page, text }) => {
            reports.push(text); // Keep the text or immediately send/copy it in the application
        },
    },
});

const oneLineReport = reports[0];
// oneLineReport can be sent directly to an AI chat.
```

## Node.js

```ts
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import * as excelsiorPdfParserModule from '@unsonet/excelsior-pdf-parser';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const reports: Array<{ page: number; text: string }> = [];
const excelsiorPdf = excelsiorPdfParserModule.init({
    pdfjs,
    standardFontDataUrl: Path.join(
        process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts',
    ).replace(/\\/g, '/') + '/',
});

const dataArray = new Uint8Array(Fs.readFileSync('problem.pdf'));
await excelsiorPdf.extractorRun({
    dataArray,
    pages: [1],
    debug: {
        level: 'ops',
        onReport: (report) => reports.push(report),
    },
});

const oneLineReport = reports[0]?.text;
// Optional caller-owned I/O. Neither the library nor pdf-debug.ts performs it.
// Fs.writeFileSync('pdftrace.txt', oneLineReport ?? '', 'utf8');
```

## Levels

- **`summary` / `L0`** — Page dimensions and rotation, operator histogram, unknown IDs and types without a declared handler, lint signals, element and table counts, and the next diagnostic step. Does not include arrays of individual text elements or geometry.
- **`trace` / `L1`** — L0 plus PDF.js text, Excelsior text, and graphical geometry (up to 80 items of each detailed type by default).
- **`ops` / `L2`** — L1 plus an indexed `OperatorList` window. By default, the window is centered around the first operator type without a declared parser handler; if no such type exists, the first 48 operations are included.
- **`tables` / `L3`** — L2 plus group grids, boundary coordinates, merge data, and a bounded number of result rows. An optional `expectedHtml` compares the output against an HTML reference supplied by the caller.

Options: `maxItems` changes the limit for detailed items; `opWindow: { from, to }` specifies an inclusive range of zero-based `OperatorList` indices; `region: { x1,y1,x2,y2 }` restricts geometry and Excelsior text, but does not truncate the original `OperatorList` or PDF.js text; `compareTextPositions: true` enables a conservative check for matching **unique** strings. Repeated text is not matched by guesswork.

## Single-line JSON schema

Each line starts with `"format":"PDFTRACE/1"` and can be parsed with a regular `JSON.parse` call. The report includes a compact `legend` describing the purpose of indices and fields. Important rules:

- `ops.visible` is an array of tuples `[mnemonic, count, firstIndex]`; `firstIndex` and `opWindow.ops[].i` are zero-based indices into the PDF.js `OperatorList`, not byte offsets in the PDF.
- `ops.coverage.basis="declared"` means that operator types are checked against the current parser's declared handler map; it does not prove that every invocation is handled correctly. Unknown numeric IDs are distinguished from known operators without a declared handler. `excluded` means excluded from the compact histogram, not removed from the original log.
- Text items are tuples `[i, opIndexOrIndexes, transform, width, height, fontRef, dir, hasEOL, hasEOT, text]`. `opIndexOrIndexes` represents the actual association, if recorded by the integration; `null` means that the association was not preserved. `transform=[a,b,c,d,e,f]`, `width`, and `height` are not recalculated and may not use the same coordinate system as `page.viewport`.
- `⟦SP:n⟧` represents exactly `n` consecutive ordinary spaces; an original `⟦` marker is doubled. Newlines inside text are JSON-escaped and do not physically split the report line.
- Graphical spans preserve each original segment separately and do not join gaps. Geometry tuples include the index of the element in the array and, if attached by the parser, the index of the operation that produced it.
- `omittedByLevel` indicates which content types are excluded at the selected level; detailed sections also include counts of omitted records.
- `next.reason` can be `unknownPdfjsIds`, `noDeclaredHandler`, `noTableData`, or `tableDataPresent`. `next.opWindow` specifies the range for the next request.

## Output

`onReport` receives an object of the form `{ page, text }`. The `text` field is a compact JSON string with no physical newline characters, so it can be copied in full into a chat or sent over the network. The string is self-describing: it contains the format version and a brief `legend`; there is no need to provide the `pdf-debug.ts` source file.

Use `summary` for initial orientation, `ops` to diagnose the operation sequence, and `tables` when grouping and table extraction results are needed.