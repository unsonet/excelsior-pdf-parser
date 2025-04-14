
<center><img src="https://unsonet.github.io/excelsior-pdf/src/img/excelsior-pdf.png" width="200" /></center>

# 📄 Excelsior PDF
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
- 🧰 Can be used as a general-purpose PDF parser
- ❌ No OCR — does not extract text from images

## 📦 Installation


```bash
npm install @unsonet/excelsior-pdf
```

## 🧩 Dependencies
Excelsior PDF is built on top of [Mozilla's pdf.js](https://github.com/mozilla/pdf.js).
You must provide a compatible pdfjs instance and its workerSrc during initialization.

## 🛠️ Basic Usage
### 1. Initialization



```js
import ExcelsiorPdf from '@unsonet/excelsior-pdf';
let pdfjs = await import(`https://cdn.jsdelivr.net/npm/pdfjs-dist@latest/legacy/build/pdf.min.js`);

let excelsiorPdf = ExcelsiorPDF.init({
	pdfjs,
	workerSrc: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@latest/legacy/build/pdf.worker.min.js'
});
```
### 2. Load PDF and extract tables


```js
import * as Fs from 'fs';

let pdfFile = 'your-file.pdf';
let dataBuffer = Fs.readFileSync(pdfFile);
let dataArray = new Uint8Array(dataBuffer);

excelsiorPdf.extractorRun({ 
	dataArray: fileByteArray, 
	onProgress:()=>{}, 
	onSuccess:(results)=>{console.log(results)}, 
	onError:(error)=>{} 
}); //In addition to callback functions, it also returns Promise
```
> You can also see an example for the browser in the public folder of the current repository

## 📘 Output Structure


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
