console.log('Playground running');

import * as Fs from 'fs';
import * as Path from 'path';
import * as ExcelsiorPdf from '../lib/excelsior-pdf-parser/excelsior-pdf-parser';

(async () => {
    try {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.min.mjs');

        const pdfFile = Path.resolve(__dirname, '../../assets/sample-tables-3.pdf');
        const dataBuffer = Fs.readFileSync(pdfFile);
        const dataArray = new Uint8Array(dataBuffer);

        const excelsiorPdf = ExcelsiorPdf.init({ pdfjs, workerSrc: 'pdfjs-dist/legacy/build/pdf.worker.min.mjs' });

        excelsiorPdf.extractorRun({
            dataArray,
            onSuccess: (result:any) => console.log(result),
            onError: (err:any) => console.error('Error:', err.stack),
        });
    } catch (err) {
        console.error('An error occurred:', err);
    }
})();
