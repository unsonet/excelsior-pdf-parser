#!/usr/bin/env node
'use strict';

// Polyfill DOMMatrix before any pdfjs code runs
const { DOMMatrix } = require('@thednp/dommatrix');
if (typeof globalThis.DOMMatrix === 'undefined') {
  (globalThis as any).DOMMatrix = DOMMatrix;
}

import * as Fs from 'fs';
import * as Path from 'path';
import { init } from '../lib/excelsior-pdf-parser/excelsior-pdf-parser';
import { parsePseudoJson } from '@unsonet/js-utils';

type OutputFormat = 'json' | 'html' | 'array' | 'raw';

interface CliOptions {
  input?: string;
  output?: string;
  config?: string;
  pages?: string;
  format?: OutputFormat;
  silent?: boolean;
  pretty?: boolean;
  help?: boolean;
}

const VALID_FORMATS: OutputFormat[] = ['json', 'html', 'array', 'raw'];

function showHelp(programName: string): void {
  console.log(`
Usage: ${programName} [options] <input>

Options:
  -i, --input <path>      Path to the PDF file (can be specified as positional argument)
  -o, --output <path>     Output file path. If omitted, prints to stdout
  -c, --config <json>     Pseudo-JSON configuration (e.g. '{pages:[1,2]}')
  -p, --pages <pages>     Shortcut for pages: comma-separated numbers or {from:1,to:3}
  -f, --format <format>   Output format: json (default), html, array, raw
  -s, --silent            Suppress progress output
  -P, --pretty            Pretty-print JSON output
  -h, --help              Show this help message

Examples:
  ${programName} ./document.pdf
  ${programName} -i ./document.pdf -o ./tables.json -c "{pages: {from: 1, to: 3}}"
  ${programName} ./document.pdf --format html --output ./tables.html
  ${programName} -i ./doc.pdf -p "[1, 3, 5]" -f array --pretty
`);
}

function parseCliArgs(argv: string[]): CliOptions {
  const args: CliOptions = {};
  const argsList = argv.slice(2);

  for (let i = 0; i < argsList.length; i++) {
    const arg = argsList[i];
    const nextArg = argsList[i + 1];

    switch (arg) {
      case '--input':
      case '-i':
        args.input = nextArg;
        i++;
        break;
      case '--output':
      case '-o':
        args.output = nextArg;
        i++;
        break;
      case '--config':
      case '-c':
        args.config = nextArg;
        i++;
        break;
      case '--pages':
      case '-p':
        args.pages = nextArg;
        i++;
        break;
      case '--format':
      case '-f':
        args.format = nextArg as OutputFormat;
        i++;
        break;
      case '--silent':
      case '-s':
        args.silent = true;
        break;
      case '--pretty':
      case '-P':
        args.pretty = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (!arg.startsWith('-') && !args.input) {
          args.input = arg;
        } else if (arg.startsWith('-')) {
          console.warn(`Warning: Unknown argument "${arg}"`);
        }
        break;
    }
  }

  return args;
}

function validateArgs(args: CliOptions): void {
  if (!args.input) {
    console.error('Error: Input PDF file is required.\n');
    showHelp(Path.basename(process.argv[1]));
    process.exit(1);
  }

  if (!Fs.existsSync(args.input)) {
    console.error(`Error: File not found: ${args.input}`);
    process.exit(1);
  }

  if (args.format && !VALID_FORMATS.includes(args.format)) {
    console.error(
      `Error: Invalid format "${args.format}". Valid formats: ${VALID_FORMATS.join(', ')}`
    );
    process.exit(1);
  }
}

function extractOutputData(
  extractorResults: any,
  format: OutputFormat
): { content: string; isHtml: boolean } {
  const pageTables = extractorResults?.pageTables || [];

  if (format === 'raw') {
    return { content: JSON.stringify(extractorResults, null, 2), isHtml: false };
  }

  const pages = pageTables.map((pageTable: any) => {
    return (pageTable.tableGroups || [])
      .map((group: any) => {
        const tableData = group?.tableData;
        if (!tableData) return null;

        switch (format) {
          case 'html':
            return tableData.table?.html || '';
          case 'array':
            return tableData.table?.array || [];
          case 'json':
          default:
            return tableData.table?.json || [];
        }
      })
      .filter(Boolean);
  });

  if (format === 'html') {
    const flatHtml: string[] = pages.flat().filter(Boolean);
    const content =
      flatHtml.length === 1
        ? flatHtml[0]
        : flatHtml.join('\n<!-- page-break -->\n');
    return { content, isHtml: true };
  }

  return { content: JSON.stringify(pages, null, 2), isHtml: false };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv);

  if (args.help) {
    showHelp(Path.basename(process.argv[1]));
    process.exit(0);
  }

  validateArgs(args);

  let config: any = {};
  if (args.config) {
    try {
      config = parsePseudoJson(args.config);
      if (typeof config !== 'object' || config === null) {
        throw new Error('Config must be an object');
      }
    } catch (err: any) {
      console.error(`Error: Invalid config format. ${err.message}`);
      process.exit(1);
    }
  }

  if (args.pages) {
    try {
      config.pages = parsePseudoJson(args.pages);
    } catch (err: any) {
      console.error(`Error: Invalid pages format. ${err.message}`);
      process.exit(1);
    }
  }

  const format = args.format || 'json';
  const outputPath = args.output ? Path.resolve(args.output) : null;
  const isStdOut = !outputPath;

  try {
    const pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs');
const pdfjs = Object.assign({}, pdfjsModule.default || {}, pdfjsModule);

    const standardFontDataUrl = Path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts')
      .replace(/\\/g, '/') + '/';

    const dataBuffer = Fs.readFileSync(Path.resolve(args.input));
    const dataArray = Uint8Array.from(dataBuffer);

    const excelsiorPdf = init({ pdfjs, standardFontDataUrl });

    const result: any = await new Promise((resolve, reject) => {
      
      excelsiorPdf.extractorRun({
        dataArray,
        pages: config.pages,
        onProgress: (progress: any) => {
          if (!args.silent && process.stderr.isTTY) {
            process.stderr.write(
              `\rProcessing: page ${progress.currentPage}/${progress.numPages}...`
            );
          }
        },
        onSuccess: (data: any) => resolve(data),
        onError: (err: any) => reject(err),
      });
    });

    if (!args.silent && process.stderr.isTTY) {
      process.stderr.write('\n');
    }

    let { content } = extractOutputData(result.extractorResults, format);

    if (!extractOutputData(result.extractorResults, format).isHtml && !args.pretty && !isStdOut) {
      content = JSON.stringify(JSON.parse(content));
    }

    if (outputPath) {
      Fs.writeFileSync(outputPath, content, 'utf-8');
      if (!args.silent) {
        console.error(`✓ Results written to ${outputPath}`);
      }
    } else {
      console.log(content);
    }
  } catch (err: any) {
    if (!args.silent && process.stderr.isTTY) {
      process.stderr.write('\n');
    }
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
  }
}

main();
// # CLI Build
// nx run excelsior-pdf-parser:webpack:build

// # Launching via nx
// nx run excelsior-pdf-parser:cli -- --input ./assets/sample.pdf

// # Launch Immediately After Build
// node dist/libs/excelsior-pdf-parser/node/cli.cjs.js ./assets/sample.pdf -o result.json

// # Various Scenarios
// node dist/libs/excelsior-pdf-parser/node/cli.cjs.js \
//   --input ./doc.pdf \
//   --output ./tables.html \
//   --format html \
//   --config "{pages: {from: 1, to: 3}}"

// node dist/libs/excelsior-pdf-parser/node/cli.cjs.js \
//   -i ./doc.pdf \
//   -p "[1, 3, 5]" \
//   -f array \
//   -P

// # Output to stdout (without --output)
// node dist/libs/excelsior-pdf-parser/node/cli.cjs.js -i ./doc.pdf -c "{pages: [2]}"