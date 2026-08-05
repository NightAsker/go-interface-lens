'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const originalResolve = Module._resolveFilename;
const stubPath = path.join(__dirname, 'vscode-stub.js');
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return stubPath;
    return originalResolve.call(this, request, ...rest);
};

const { WorkspaceIndex } = require('../src/indexer');
const { assert, eq, done } = require('./harness');

const config = () => ({
    excludedFolders: ['vendor'],
    excludedFilePatterns: [],
    excludedTypePatterns: [],
    searchDependencies: false,
    goModCache: '',
    astConcurrency: 2,
});

async function buildObservedIndex(root, cacheDir) {
    const index = new WorkspaceIndex(config, () => {}, { cacheDir });
    let indexed = 0;
    let restored = 0;
    const indexText = index._indexText.bind(index);
    const restoreCandidateFile = index._restoreCandidateFile.bind(index);
    index._indexText = (...args) => {
        indexed += 1;
        return indexText(...args);
    };
    index._restoreCandidateFile = (...args) => {
        restored += 1;
        return restoreCandidateFile(...args);
    };
    await index.ensureBuilt(root);
    return { index, indexed, restored };
}

async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-interface-candidate-cache-'));
    const root = path.join(tmp, 'project');
    const apiDir = path.join(root, 'api');
    const implDir = path.join(root, 'impl');
    const cacheDir = path.join(tmp, 'cache');
    fs.mkdirSync(apiDir, { recursive: true });
    fs.mkdirSync(implDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/cache\n\ngo 1.22\n');

    const apiFile = path.join(apiDir, 'service.go');
    const implFile = path.join(implDir, 'impl.go');
    fs.writeFileSync(
        apiFile,
        [
            'package api',
            'import "io"',
            'type Service interface { Run() error }',
            'type ReaderHolder struct { io.Reader }',
        ].join('\n')
    );
    fs.writeFileSync(
        implFile,
        ['package impl', 'type Impl struct{}', 'func (Impl) Run() error { return nil }'].join('\n')
    );

    console.log('== persistent lightweight candidate index ==');
    const first = await buildObservedIndex(root, cacheDir);
    eq('first build reads every Go source', first.indexed, 2);
    eq('first build has no persisted candidates to restore', first.restored, 0);
    const cacheFile = first.index._candidateCacheFile(root);
    assert('first build writes a workspace-scoped candidate cache', fs.existsSync(cacheFile));
    first.index.dispose();

    const second = await buildObservedIndex(root, cacheDir);
    eq('unchanged restart reads no Go source text', second.indexed, 0);
    eq('unchanged restart restores every candidate entry', second.restored, 2);
    const apiMetadata = second.index._candidateMetadataByFile.get(apiFile);
    assert('cached imports survive serialization', apiMetadata.imports.get('io') === 'io');
    assert('cached embedded references survive serialization', apiMetadata.embeddedReferences.has('io.Reader'));
    const implementations = await second.index.findImplementationsAst('Service', apiFile);
    eq('restored candidates still drive precise AST lookup', implementations.map((item) => item.name), ['Impl']);
    second.index.dispose();

    fs.appendFileSync(implFile, '\nfunc (Impl) Stop() {}\n');
    const third = await buildObservedIndex(root, cacheDir);
    eq('incremental restart reads only the changed file', third.indexed, 1);
    eq('incremental restart restores the unchanged file', third.restored, 1);
    assert('changed method is present in the refreshed candidate index', third.index._candidateFilesByMethod.has('Stop'));
    third.index.dispose();

    fs.unlinkSync(apiFile);
    const fourth = await buildObservedIndex(root, cacheDir);
    eq('deleted source is removed from the in-memory index', fourth.index.files.size, 1);
    const payload = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    eq('deleted source is removed from the persisted index', payload.files.length, 1);
    fourth.index.clear();
    assert('clearing the extension cache removes the candidate cache', !fs.existsSync(cacheFile));
    fourth.index.dispose();

    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
