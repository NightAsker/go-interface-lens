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
const { assert, eq, done } = require(path.join(__dirname, 'harness'));

const modCache = path.join(__dirname, 'fixtures3', 'modcache');
const projRoot = path.join(__dirname, 'fixtures3', 'proj');

// Config points goModCache at the simulated module cache and enables dep search.
const cfg = () => ({
    excludedFolders: ['mocks', 'mock', 'testdata', 'vendor'],
    excludedFilePatterns: ['_mock.go', 'mock_', '.pb.go', '_test.go'],
    excludedTypePatterns: ['Mock', 'mock', 'Stub', 'Fake'],
    searchDependencies: true,
    goModCache: modCache,
});

async function main() {
    // Only the PROJECT is indexed (the interface lives in the module cache,
    // which is intentionally NOT indexed — it must be found on demand).
    const idx = new WorkspaceIndex(cfg, () => {});
    await idx.ensureBuilt(projRoot);
    const receiverFile = path.join(projRoot, 'executor.go');

    console.log('== goto interface: interface in module cache, impl in project ==');
    const found = await idx.findInterfacesAst('ProjectExecutor', 'Execute', { receiverFile });
    const names = found.map((r) => r.name).sort();
    console.log('  got:', names);
    assert('finds IActionExecutorWithCode from module cache', names.includes('IActionExecutorWithCode'));
    const ext = found.find((r) => r.name === 'IActionExecutorWithCode');
    assert('marked as external', ext && ext.external === true);
    assert('external file path is in module cache', ext && ext.file.startsWith(modCache));

    console.log('\n== signature-aware: Code() string must not match Coder.Code() int ==');
    const byCode = await idx.findInterfacesAst('ProjectExecutor', 'Code', { receiverFile });
    const codeNames = byCode.map((r) => r.name).sort();
    console.log('  got:', codeNames);
    assert('matches IActionExecutorWithCode (Code() string)', codeNames.includes('IActionExecutorWithCode'));
    assert('does NOT match Coder (Code() int)', !codeNames.includes('Coder'));

    console.log('\n== dependency search finds a single-line interface ==');
    const byInline = await idx.findInterfacesAst('ProjectExecutor', 'Inline', { receiverFile });
    assert('finds InlineExecutor declared on one line', byInline.some((r) => r.name === 'InlineExecutor'));
    assert(
        'finds same-file interface inheriting the method',
        byInline.some((r) => r.name === 'ExtendedInlineExecutor')
    );

    console.log('\n== dependency search disabled -> no external results ==');
    const idx2 = new WorkspaceIndex(
        () => ({ ...cfg(), searchDependencies: false }),
        () => {}
    );
    await idx2.ensureBuilt(projRoot);
    const none = await idx2.findInterfacesAst('ProjectExecutor', 'Execute', { receiverFile });
    eq('no interfaces when dep search off', none.map((r) => r.name), []);

    idx.dispose();
    idx2.dispose();
    done();
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
