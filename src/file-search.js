'use strict';

const path = require('path');
const { spawn } = require('child_process');

function runRipgrepFiles(command, args, rootInfo, handlers = {}) {
    return new Promise((resolve, reject) => {
        const { signal } = handlers;
        if (signal?.aborted) return reject(Object.assign(new Error('Search cancelled'), { code: 'SEARCH_CANCELLED' }));
        let buffer = '';
        let stderr = '';
        let failure;
        const child = spawn(command, args, { cwd: rootInfo.root, stdio: ['ignore', 'pipe', 'pipe'] });
        const abort = () => { if (!child.killed) child.kill(); };
        signal?.addEventListener('abort', abort, { once: true });
        const consume = (file) => {
            if (!file || failure || signal?.aborted) return;
            try {
                handlers.onFile?.(path.resolve(rootInfo.root, file));
            } catch (error) {
                failure = error;
                abort();
            }
        };
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            if (failure || signal?.aborted) return;
            buffer += chunk;
            let start = 0;
            let end;
            // Null delimiters preserve file names containing spaces or newlines.
            while ((end = buffer.indexOf('\0', start)) >= 0) {
                consume(buffer.slice(start, end));
                start = end + 1;
                if (failure || signal?.aborted) { buffer = ''; return; }
            }
            buffer = buffer.slice(start);
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-65536); });
        child.on('error', (error) => { failure = error; });
        child.on('close', (code) => {
            signal?.removeEventListener('abort', abort);
            if (failure) return reject(failure);
            if (signal?.aborted) return reject(Object.assign(new Error('Search cancelled'), { code: 'SEARCH_CANCELLED' }));
            if (code === 0 || code === 1) return resolve();
            const error = new Error(stderr.trim() || `ripgrep exited with code ${code}`);
            error.code = 'RIPGREP_FAILED';
            reject(error);
        });
    });
}

module.exports = { runRipgrepFiles };
