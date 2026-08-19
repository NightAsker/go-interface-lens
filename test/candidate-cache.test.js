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

async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-interface-workspace-candidates-'));
    const root = path.join(tmp, 'project');
    const apiDir = path.join(root, 'api');
    const implDir = path.join(root, 'impl');
    const noiseDir = path.join(root, 'noise');
    const cacheDir = path.join(tmp, 'cache');
    fs.mkdirSync(apiDir, { recursive: true });
    fs.mkdirSync(implDir, { recursive: true });
    fs.mkdirSync(noiseDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/cache\n\ngo 1.22\n');

    const apiFile = path.join(apiDir, 'service.go');
    const implFile = path.join(implDir, 'impl.go');
    fs.writeFileSync(apiFile, 'package api\ntype Service interface { Run() error }\n');
    fs.writeFileSync(
        implFile,
        'package impl\ntype Impl struct{}\nfunc (Impl) Run() error { return nil }\n'
    );
    for (let i = 0; i < 50; i++) {
        fs.writeFileSync(
            path.join(noiseDir, `noise-${i}.go`),
            `package noise\ntype Noise${i} struct{}\nfunc (Noise${i}) Other${i}() {}\n`
        );
    }

    console.log('== query-driven workspace candidate cache ==');
    const obsoleteRelation = path.join(cacheDir, 'interface-relations-v1-old.json');
    const obsoleteDependencyBatch = path.join(cacheDir, 'dependency-candidates-v1-old.json');
    const obsoleteCandidateIndex = path.join(cacheDir, 'candidate-index-v4-old.json');
    const unrelatedCache = path.join(cacheDir, 'unrelated.json');
    fs.writeFileSync(obsoleteRelation, '{}');
    fs.writeFileSync(obsoleteDependencyBatch, '{}');
    fs.writeFileSync(obsoleteCandidateIndex, '{}');
    fs.writeFileSync(unrelatedCache, '{}');

    const first = new WorkspaceIndex(config, () => {}, { cacheDir });
    await first.ensureBuilt(root);
    assert('removed relation cache artifacts are cleaned during upgrade', !fs.existsSync(obsoleteRelation));
    assert('removed dependency batch artifacts are cleaned during upgrade', !fs.existsSync(obsoleteDependencyBatch));
    assert('removed candidate index artifacts are cleaned during upgrade', !fs.existsSync(obsoleteCandidateIndex));
    assert('upgrade cleanup preserves unrelated cache files', fs.existsSync(unrelatedCache));
    eq('root registration reads no workspace source files', first.files.size, 0);
    eq('root registration starts no AST workers', first.astPool.workers.length, 0);
    assert(
        'root registration does not create a persistent full-workspace candidate cache',
        !fs.readdirSync(cacheDir).some((name) => name.startsWith('candidate-index-'))
    );

    const firstCandidateRequest = first._workspaceCandidateFiles('implementation', 'Run');
    const sharedCandidateRequest = first._workspaceCandidateFiles('implementation', 'Run');
    assert('identical workspace candidate scans share one in-flight promise', firstCandidateRequest === sharedCandidateRequest);
    const candidates = await firstCandidateRequest;
    eq('rg returns only the matching implementation file', candidates, [implFile]);

    const implementations = await first.findImplementationsAst('Service', apiFile);
    eq('on-demand candidates drive precise AST lookup', implementations.map((item) => item.name), ['Impl']);
    assert('unrelated source files never enter the AST worker pool', first.getAstStats().parsed <= 2);
    await first.astPool.flush();
    first.dispose();

    const restored = new WorkspaceIndex(config, () => {}, { cacheDir });
    await restored.ensureBuilt(root);
    eq('restart still reads no workspace source files during root registration', restored.files.size, 0);
    eq('restart still starts without AST workers', restored.astPool.workers.length, 0);
    const restoredResults = await restored.findImplementationsAst('Service', apiFile);
    eq('restored AST cache preserves query results', restoredResults.map((item) => item.name), ['Impl']);
    assert('candidate packages restore declarations from the AST disk cache', restored.getAstStats().diskHits > 0);

    const updatedSource = 'package impl\ntype Impl struct{}\nfunc (Impl) Stop() error { return nil }\n';
    fs.writeFileSync(implFile, updatedSource);
    restored.updateFileText(implFile, updatedSource);
    eq('file changes invalidate workspace candidate scans', restored._workspaceCandidateCache.size, 0);
    const stopped = await restored.findImplementationsAst('Service', apiFile);
    eq('file changes invalidate cached query results', stopped, []);

    restored.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
