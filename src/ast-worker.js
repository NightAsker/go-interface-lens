'use strict';

const fs = require('fs');
const { parentPort } = require('worker_threads');
const { parseGoFile, parseGoDeclarations, serializeParsedFile } = require('./ast');
const { initializeGoParser } = require('./tree-sitter-runtime');

const ready = initializeGoParser();
ready.then(() => parentPort.postMessage({ type: 'ready' })).catch((error) => {
    setImmediate(() => {
        throw error;
    });
});

parentPort.on('message', async (job) => {
    try {
        await ready;
        const text = job.text === undefined ? fs.readFileSync(job.file, 'utf8') : job.text;
        let parsed;
        let optimization = null;
        if (job.declarationOnly) {
            const result = await parseGoDeclarations(text);
            parsed = result.parsed;
            optimization = result.optimization;
        } else {
            parsed = await parseGoFile(text);
        }
        parentPort.postMessage({
            id: job.id,
            parsed: serializeParsedFile(parsed),
            optimization,
        });
    } catch (err) {
        parentPort.postMessage({
            id: job.id,
            error: { message: err.message || String(err), code: err.code },
        });
    }
});
