'use strict';

const fs = require('fs');
const { parentPort } = require('worker_threads');
const { parseGoFile, serializeParsedFile } = require('./ast');

parentPort.on('message', (job) => {
    try {
        const text = job.text === undefined ? fs.readFileSync(job.file, 'utf8') : job.text;
        parentPort.postMessage({ id: job.id, parsed: serializeParsedFile(parseGoFile(text)) });
    } catch (err) {
        parentPort.postMessage({
            id: job.id,
            error: { message: err.message || String(err), code: err.code },
        });
    }
});
