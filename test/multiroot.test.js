'use strict';

const path = require('path');

const Module = require('module');
const origResolve = Module._resolveFilename;
const stubPath = path.join(__dirname, 'vscode-stub.js');
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return stubPath;
    return origResolve.call(this, request, ...rest);
};

const { WorkspaceIndex } = require(path.join(__dirname, '..', 'src', 'indexer'));
const { assert, done } = require(path.join(__dirname, 'harness'));

const cfg = () => ({
    excludedFolders: ['mocks', 'mock', 'testdata', 'vendor'],
    excludedFilePatterns: ['_mock.go', 'mock_', '.pb.go', '_test.go'],
    excludedTypePatterns: ['Mock', 'mock', 'Stub', 'Fake'],
});

async function main() {
    // Interface declared in a dependency dir, implementation in a project dir.
    // withIndex() would call ensureBuilt() for BOTH roots; simulate that here.
    const idx = new WorkspaceIndex(cfg, () => {});
    const depRoot = path.join(__dirname, 'fixtures2', 'dep');
    const projRoot = path.join(__dirname, 'fixtures2', 'proj');
    await idx.ensureBuilt(depRoot);
    await idx.ensureBuilt(projRoot);

    console.log('== interface in dependency, implementation in project ==');
    const impls = idx.findImplementations('IActionExecutorWithCode').map((r) => r.name).sort();
    console.log('  got:', impls);
    assert('ProjectExecutor found across roots', impls.includes('ProjectExecutor'));

    idx.dispose();
    done();
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
