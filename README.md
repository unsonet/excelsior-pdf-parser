
<center>[<img src="https://unsonet.github.io/excelsior-pdf-demo/src/assets/img/excelsior-pdf.png" width="200" />](https://unsonet.github.io/excelsior-pdf-demo/src/assets/img/excelsior-pdf.png)</center>

# 📄 Excelsior PDF (parser)
Excelsior PDF is a powerful JavaScript/TypeScript library for extracting table data from PDF files. It works in both browser and Node.js environments, detects tables with or without borders, supports merged cells, handles watermark-protected documents, and does all of this without using neural networks.

## 🔍 Live Demo
Try it in action: [DEMO](https://unsonet.github.io/excelsior-pdf/)

## 🚀 Features

- 📐 Detects tables with or without vector borders
- 🧠 Identifies table headers with high accuracy
- 🔗 Handles merged cells (rowspan/colspan)
- 💧 Works with watermarked documents
- ⚡ Runs without neural networks — fast and lightweight
- 🌐 Compatible with both browser and Node.js
- 🖥️ Built-in CLI for server-side extraction (JSON, HTML, Array, Raw)
- 🧰 Can be used as a general-purpose PDF parser
- ❌ No OCR — does not extract text from images

## 📦 Installation


```bash
npm install @unsonet/excelsior-pdf-parser
```

## 🧩 Dependencies
Excelsior PDF is built on top of [Mozilla's pdf.js](https://github.com/mozilla/pdf.js).
You must provide a compatible pdfjs instance and its workerSrc during initialization.
[A pre-built version of pdf.js](https://www.npmjs.com/package/pdfjs-dist) is available for download from npm:

```bash
npm install pdfjs-dist
```

> **Version compatibility:** Excelsior PDF automatically adapts to internal changes in `pdfjs-dist`. Tested and working with **v3.11.174 through v6.2.108** (latest). Both browser (legacy) and Node.js (legacy) builds are supported.


## 🛠️ Basic Usage


### Browser

```js
import * as excelsiorPdfParserModule from '@unsonet/excelsior-pdf-parser';

let pdfjs = await import('pdfjs-dist/legacy/build/pdf.min.mjs');
// Or: https://cdn.jsdelivr.net/npm/pdfjs-dist@latest/legacy/build/pdf.min.js

let excelsiorPdf = excelsiorPdfParserModule.init({
  pdfjs,
  workerSrc: 'pdfjs-dist/legacy/build/pdf.worker.min.mjs'
  // Or: https://cdn.jsdelivr.net/npm/pdfjs-dist@latest/legacy/build/pdf.worker.min.js
});

excelsiorPdf.extractorRun({
  dataArray: fileByteArray,
  onProgress: () => {},
  onSuccess: (results) => { console.log(results) },
  onError: (error) => {}
}); // Returns Promise in addition to callbacks
```

### Node.js

```js
import * as Fs from 'fs';
import * as Path from 'path';
import * as excelsiorPdfParserModule from '@unsonet/excelsior-pdf-parser';

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const standardFontDataUrl = Path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts')
  .replace(/\\/g, '/') + '/';

const excelsiorPdf = excelsiorPdfParserModule.init({
  pdfjs,
  standardFontDataUrl // Required for correct text metrics in Node.js
});

const dataBuffer = Fs.readFileSync('your-file.pdf');
const dataArray = new Uint8Array(dataBuffer);

const results = await excelsiorPdf.extractorRun({
  dataArray,
  onProgress: (p) => console.log(`Page ${p.currentPage}/${p.numPages}`)
});
console.log(results.extractorResults);
```

> See [`@unsonet/excelsior-pdf-demo`](https://unsonet.github.io/excelsior-pdf-demo) for a complete browser example.

## 🖥️ CLI Usage

Excelsior PDF includes a command-line interface for quick server-side extraction without writing code.

### Global install
```bash
npm install -g @unsonet/excelsior-pdf
excelsior-pdf-parser ./document.pdf -o ./tables.json
```

### NPX (no install)
```bash
npx @unsonet/excelsior-pdf ./document.pdf -o ./tables.json
```

### Options

| Flag | Description |
|------|-------------|
| `-i, --input <path>` | Path to the PDF file (can also be passed as positional argument) |
| `-o, --output <path>` | Output file path. If omitted, prints to stdout |
| `-c, --config <json>` | Pseudo-JSON config, e.g. `{pages:[1,2]}` |
| `-p, --pages <pages>` | Page range: comma-separated numbers or `{from:1,to:3}` |
| `-f, --format <format>` | Output format: `json` (default), `html`, `array`, `raw` |
| `-s, --silent` | Suppress progress output |
| `-P, --pretty` | Pretty-print JSON output |
| `-h, --help` | Show help message |

### Examples

```bash
# Extract all tables as JSON
excelsior-pdf-parser ./document.pdf

# Extract pages 1–3 as pretty-printed JSON
excelsior-pdf-parser ./document.pdf -p "{from:1,to:3}" -P -o ./tables.json

# Export as HTML with borders
excelsior-pdf-parser ./document.pdf -f html -o ./tables.html

# Extract specific pages as raw internal structure
excelsior-pdf-parser -i ./doc.pdf -p "[1, 3, 5]" -f array --pretty
```

## 📘 Output Structure

> The CLI can output the same data in four formats: `json` (array of objects per row), `html` (rendered `<table>`), `array` (2D cell matrix), and `raw` (full internal structure for debugging).

### 🧾 TypeScript Typings
Below is the core structure returned by the extract() function. You can use these typings in your own project to get full IntelliSense and type safety.


```ts


// ✅ Main extraction result structure

interface Results {
  documentProxy: PDFDocumentProxy     //PDF document proxy from pdf.js
  extractorResults: ExtractorResults  //The full structured output from Excelsior PDF
}

interface ExtractorResults {
  pageTables: PageTable[];  // One entry per PDF page with detected tables
  numPages: number;         // Total number of pages in the PDF
  currentPage: number;      // For progress tracking
}

interface PageTable {
  page: number;             // PDF page number (1-based)
  tableGroups: TableGroup[]; // Detected tables on this page
  pageGroup: TableGroup;     // Full-page geometry snapshot
}

interface TableGroup {
  // 📐 Geometry of the table
  y: number[];             // Vertical bounds (top/bottom)
  x: number[];             // Horizontal bounds (left/right)
  rows: number[];          // Y-coordinates of row separators
  cols: number[];          // X-coordinates of column separators

  // 🧱 Visual elements and structure
  edges: Vector[];         // Vector borders (lines)
  rectangles: Vector[];    // Background rectangles
  coordinates: Coordinate[]; // All text blocks within table bounds
  rectanglesEdges: Vector[]; // Rects detected as lines

  // 🧠 Metadata
  alias: GridAlias;        // Maps imprecise coordinates to normalized grid
  paddingSize: number;     // Tolerance in pixels between cells
  borderSize: number;      // Detected border width (if present)
  headerRows: HeaderRows;  // Header zones and their coordinates

  // 📊 Logical structure
  verticles: LineGroup[];  // Detected vertical lines (with top-bottom info)
  horizons: LineGroup[];   // Detected horizontal lines (with left-right info)
  merges: Record<string, MergeData>; // Merged cells
  mergeAlias: Record<string, string>; // Shortcut mapping for merged keys
  matrix: number[][];      // Cell matrix (1 = present)

  // 📦 Extracted content
  tableData?: {
    table: TableContent;   // Parsed table content (array, html, json)
    width: number;         // Number of columns
    height: number;        // Number of rows
  };
}
```

#### Supporting Interfaces


```ts
interface Vector {
  x: number;
  y: number;
  width: number;
  height: number;
  transform?: number[];     // Optional transform matrix
  strokeColor?: string;     // For edges
  fillColor?: string;       // For rectangles
}

interface Coordinate {
  index: number;
  str: string;              // Full string content
  x: number;
  y: number;
  width: number;
  height: number;
  chars: Glyph[];           // Character-level info
  transform: number[];
  fontName: string;
  templateStr?: string;     // Template-matching string
  contained?: boolean;      // Used for header detection
}

interface Glyph {
  originalCharCode: number;
  fontChar: string;
  unicode: string;
  width: number;
  isSpace: boolean;
  isInFont: boolean;
  x?: number;
  y?: number;
  charWidth?: number;
}

interface GridAlias {
  rows: Record<string, number>; // Fuzzy match aliasing
  cols: Record<string, number>;
}

interface HeaderRows {
  [key: string]: Coordinate[];  // Key = row range (e.g., "524.48-496.43")
}

interface LineGroup {
  x?: number;
  y?: number;
  lines: LineSegment[];
}

interface LineSegment {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

interface MergeData {
  row: number;
  col: number;
  arr: string[];         // Merged string values
  width: number;
  height: number;
}

interface TableContent {
  array: Cell[][];       // 2D raw cell array
  html: string;          // Rendered HTML
  json: any[];           // Parsed rows as objects (based on headers)
}

interface Cell {
  str: string;           // Cell content
  fillColor?: string;    // Optional for highlighting/annotation
}
```

## 💡 Use Cases
- Extracting data from invoices and reports
- Converting PDFs to CSV or Excel
- Web-based PDF viewers with table highlighting
- Data analysis pipelines from PDF sources

## ⚠️ Limitations
- 📷 No OCR — does not extract text from image-based PDFs
- 🧾 Works best with machine-readable PDFs
- 🔤 In Node.js, `standardFontDataUrl` must point to `pdfjs-dist/standard_fonts` for accurate text metrics. Without it, fallback fonts may cause slight coordinate drift.

## 🤝 Contributing
Contributions are welcome! Bug reports, feature requests, and pull requests are appreciated. Help us make Excelsior PDF the go-to solution for table extraction from PDFs.

## 📜 License
MIT — free to use, modify, and distribute.

## 🙏 Acknowledgements
Special thanks to [ronnywang/pdf-table-extractor](https://github.com/ronnywang/pdf-table-extractor) —
this project was a major inspiration and reference during development.

## 💬 Contact
Maintained by [@unsonet](https://github.com/unsonet).
If you're using Excelsior PDF in production — let us know, we'd love to hear about it!