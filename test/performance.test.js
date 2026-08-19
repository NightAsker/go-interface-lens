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
const { assert, done } = require('./harness');

async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-interface-ast-perf-'));
    const root = path.join(tmp, 'project');
    const noiseDir = path.join(root, 'noise');
    const apiDir = path.join(root, 'api');
    const implDir = path.join(root, 'impl');
    fs.mkdirSync(noiseDir, { recursive: true });
    fs.mkdirSync(apiDir, { recursive: true });
    fs.mkdirSync(implDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/perf\n\ngo 1.22\n');

    for (let i = 0; i < 400; i++) {
        fs.writeFileSync(
            path.join(noiseDir, `noise${i}.go`),
            `package noise\ntype Noise${i} struct{}\ntype Holder${i} struct { Noise${i} }\n` +
                `func (Noise${i}) Method${i}(value int) int { return value }\n`
        );
    }
    const interfaceFile = path.join(apiDir, 'rare.go');
    fs.writeFileSync(
        interfaceFile,
        [
            'package api',
            'type Rare interface { RareMethod(value string) error }',
            'type CachedOnly interface { CachedMethod() error }',
        ].join('\n') + '\n'
    );
    const implementationFile = path.join(implDir, 'impl.go');
    fs.writeFileSync(
        implementationFile,
        [
            'package impl',
            'type Impl struct{}',
            'func (Impl) RareMethod(value string) error { return nil }',
            'type CachedImpl struct{}',
            'func (*CachedImpl) CachedMethod() error { return nil }',
        ].join('\n') + '\n'
    );

    const config = () => ({
        excludedFolders: ['vendor'],
        excludedFilePatterns: [],
        excludedTypePatterns: [],
        searchDependencies: false,
        goModCache: '',
        astConcurrency: 4,
    });
    const cacheDir = path.join(tmp, 'cache');
    const index = new WorkspaceIndex(config, () => {}, { cacheDir });

    const buildStarted = process.hrtime.bigint();
    await index.ensureBuilt(root);
    const buildMs = Number(process.hrtime.bigint() - buildStarted) / 1e6;
    const parsedAfterStartup = index.getAstStats().parsed;
    const workersAfterStartup = index.astPool.workers.length;
    const rareCandidates = index._candidatePackagesForMethods(['RareMethod']);

    const coldStarted = process.hrtime.bigint();
    const cold = await index.findImplementationsAst('Rare', interfaceFile);
    const coldMs = Number(process.hrtime.bigint() - coldStarted) / 1e6;
    const parsedAfterColdQuery = index.getAstStats().parsed;

    const cachedStarted = process.hrtime.bigint();
    const cached = await index.findImplementationsAst('Rare', interfaceFile);
    const cachedMs = Number(process.hrtime.bigint() - cachedStarted) / 1e6;

    const second = await index.findImplementationsAst('CachedOnly', interfaceFile);
    const reverse = await index.findInterfacesAst('Impl', 'RareMethod', {
        receiverFile: implementationFile,
    });
    await index.astPool.flush();

    const restoredIndex = new WorkspaceIndex(config, () => {}, { cacheDir });
    await restoredIndex.ensureBuilt(root);
    const restoredWorkersBeforeQuery = restoredIndex.astPool.workers.length;
    const restoredStarted = process.hrtime.bigint();
    const restored = await restoredIndex.findImplementationsAst('CachedOnly', interfaceFile);
    const restoredMs = Number(process.hrtime.bigint() - restoredStarted) / 1e6;

    console.log('== lazy AST performance (402 Go files) ==');
    console.log(`  startup regex index : ${buildMs.toFixed(1)}ms`);
    console.log(`  AST cold query      : ${coldMs.toFixed(1)}ms`);
    console.log(`  AST cached query    : ${cachedMs.toFixed(2)}ms`);
    console.log(`  restored AST query  : ${restoredMs.toFixed(2)}ms`);
    console.log(`  AST files parsed    : ${index.getAstStats().parsed}`);

    assert('cold AST query finds implementation', cold.length === 1 && cold[0].name === 'Impl');
    assert('cached AST query preserves result', cached.length === 1 && cached[0].name === 'Impl');
    assert('second on-demand query finds its implementation', second.length === 1 && second[0].name === '*CachedImpl');
    assert('reverse on-demand query finds the interface', reverse.length === 1 && reverse[0].name === 'Rare');
    assert('startup regex indexing stays within broad budget', buildMs < 5000);
    assert('startup candidate indexing does not parse any file with WASM', parsedAfterStartup === 0);
    assert('startup does not create parser workers', workersAfterStartup === 0);
    assert('cold candidate AST query stays within broad budget', coldMs < 2000);
    assert('cached query stays responsive', cachedMs < 100);
    assert('cold query parses candidates instead of the whole workspace', parsedAfterColdQuery <= 4);
    assert('unrelated local embeds do not inflate candidates', rareCandidates.size <= 2);
    assert('restart remains lazy until a query arrives', restoredWorkersBeforeQuery === 0);
    assert('restart query restores declaration ASTs from disk', restoredIndex.getAstStats().diskHits > 0);
    assert('restored AST query preserves implementation results', restored.length === 1 && restored[0].name === '*CachedImpl');

    restoredIndex.dispose();
    index.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
