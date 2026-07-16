'use strict';

const path = require('path');

const Module = require('module');
const origResolve = Module._resolveFilename;
const stubPath = path.join(__dirname, 'vscode-stub.js');
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return stubPath;
    return origResolve.call(this, request, ...rest);
};

const vscode = require(stubPath);
const ext = require(path.join(__dirname, '..', 'extension'));
const { assert, eq, done } = require(path.join(__dirname, 'harness'));

// Simulate one open workspace folder so resolveSearchRoots returns a root.
vscode.workspace.workspaceFolders = [{ uri: { fsPath: path.join(__dirname, 'fixtures') } }];
vscode.workspace.getWorkspaceFolder = () => ({ uri: { fsPath: path.join(__dirname, 'fixtures') } });

// Inject a fake index whose ensureBuilt resolves immediately, so timing is
// governed entirely by the `search` callback below.
ext._test.setWorkspaceIndex({
    ensureBuilt: async () => {},
});

eq('default progress feedback delay is responsive', ext._test.getProgressDelay(), 250);

// Shorten the delay so the "slow" case does not make the test slow.
ext._test.setProgressDelay(50);

const documentUri = { fsPath: path.join(__dirname, 'fixtures', 'pkg', 'store.go') };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    console.log('== fast search (< delay) shows NO progress bar ==');
    vscode.window._withProgressCalls = 0;
    const fast = await ext._test.withSearchProgress(documentUri, 'fast', async () => {
        return ['fast-result'];
    });
    eq('returns search result', fast, ['fast-result']);
    eq('progress NOT shown for fast search', vscode.window._withProgressCalls, 0);

    console.log('\n== slow search (> delay) DOES show progress bar ==');
    vscode.window._withProgressCalls = 0;
    const slow = await ext._test.withSearchProgress(documentUri, 'slow', async () => {
        await delay(150); // > 50ms delay
        return ['slow-result'];
    });
    eq('returns search result', slow, ['slow-result']);
    eq('progress shown exactly once for slow search', vscode.window._withProgressCalls, 1);

    console.log('\n== search rejection propagates (fast path) ==');
    let threw = false;
    try {
        await ext._test.withSearchProgress(documentUri, 'err', async () => {
            throw new Error('boom');
        });
    } catch (e) {
        threw = e.message === 'boom';
    }
    assert('error from fast search propagates', threw);

    done();
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
