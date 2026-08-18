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
            'type WarmOnly interface { WarmMethod() error }',
        ].join('\n') + '\n'
    );
    const implementationFile = path.join(implDir, 'impl.go');
    fs.writeFileSync(
        implementationFile,
        [
            'package impl',
            'type Impl struct{}',
            'func (Impl) RareMethod(value string) error { return nil }',
            'type WarmImpl struct{}',
            'func (*WarmImpl) WarmMethod() error { return nil }',
        ].join('\n') + '\n'
    );

    const config = () => ({
        excludedFolders: ['vendor'],
        excludedFilePatterns: [],
        excludedTypePatterns: [],
        searchDependencies: false,
        goModCache: '',
        // Keep one ready worker for foreground navigation while verifying that
        // the reverse prewarm still parses concurrently on the remaining pool.
        astConcurrency: 4,
    });
    const index = new WorkspaceIndex(config, () => {}, { cacheDir: path.join(tmp, 'cache') });

    const buildStarted = process.hrtime.bigint();
    await index.ensureBuilt(root);
    const buildMs = Number(process.hrtime.bigint() - buildStarted) / 1e6;
    const parsedAfterStartup = index.getAstStats().parsed;
    const rareCandidates = index._candidatePackagesForMethods(['RareMethod']);

    const legacyStarted = process.hrtime.bigint();
    index.findImplementations('Rare', interfaceFile);
    const legacyQueryMs = Number(process.hrtime.bigint() - legacyStarted) / 1e6;

    const coldStarted = process.hrtime.bigint();
    const cold = await index.findImplementationsAst('Rare', interfaceFile);
    const coldMs = Number(process.hrtime.bigint() - coldStarted) / 1e6;

    const warmStarted = process.hrtime.bigint();
    const warm = await index.findImplementationsAst('Rare', interfaceFile);
    const warmMs = Number(process.hrtime.bigint() - warmStarted) / 1e6;
    const parsedAfterColdQuery = index.getAstStats().parsed;

    const prewarmStarted = process.hrtime.bigint();
    const reversePrewarm = await index.prewarmReverseInterfaces();
    const prewarmMs = Number(process.hrtime.bigint() - prewarmStarted) / 1e6;
    const readsBeforeForward = { ...index.getAstStats() };
    const forwardStarted = process.hrtime.bigint();
    const forward = await index.findImplementationsAst('WarmOnly', interfaceFile);
    const forwardMs = Number(process.hrtime.bigint() - forwardStarted) / 1e6;
    const readsAfterForward = { ...index.getAstStats() };
    const readsBeforeReverse = { ...readsAfterForward };
    const reverseStarted = process.hrtime.bigint();
    const reverse = await index.findInterfacesAst('Impl', 'RareMethod', {
        receiverFile: implementationFile,
    });
    const reverseMs = Number(process.hrtime.bigint() - reverseStarted) / 1e6;
    const readsAfterReverse = index.getAstStats();

    console.log('== lazy AST performance (402 Go files) ==');
    console.log(`  startup regex index : ${buildMs.toFixed(1)}ms`);
    console.log(`  legacy warm query   : ${legacyQueryMs.toFixed(2)}ms`);
    console.log(`  AST cold query      : ${coldMs.toFixed(1)}ms`);
    console.log(`  AST cached query    : ${warmMs.toFixed(2)}ms`);
    console.log(`  reverse prewarm     : ${prewarmMs.toFixed(1)}ms`);
    console.log(`  prewarmed forward   : ${forwardMs.toFixed(2)}ms`);
    console.log(`  prewarmed reverse   : ${reverseMs.toFixed(2)}ms`);
    console.log(`  AST files parsed    : ${index.getAstStats().parsed}`);

    assert('cold AST query finds implementation', cold.length === 1 && cold[0].name === 'Impl');
    assert('cached AST query preserves result', warm.length === 1 && warm[0].name === 'Impl');
    assert('startup regex indexing stays within broad budget', buildMs < 5000);
    assert('startup candidate indexing does not parse any file with WASM', parsedAfterStartup === 0);
    assert('cold candidate AST query stays within broad budget', coldMs < 2000);
    assert('cached query stays responsive', warmMs < 100);
    assert('cold query parses candidates instead of the whole workspace', parsedAfterColdQuery <= 4);
    assert('unrelated local embeds do not inflate candidates', rareCandidates.size <= 2);
    assert('reverse prewarm covers the complete workspace', reversePrewarm.workspaceFiles === 402);
    assert('reverse prewarm uses multiple AST workers', index.getAstStats().maxActive > 1);
    assert('reverse prewarm stays within a broad background budget', prewarmMs < 5000);
    assert(
        'prewarmed forward query finds the implementation',
        forward.length === 1 && forward[0].name === '*WarmImpl'
    );
    assert('prewarmed forward query stays responsive', forwardMs < 100);
    assert(
        'prewarmed forward query performs no AST reads',
        readsAfterForward.parsed === readsBeforeForward.parsed &&
            readsAfterForward.memoryHits === readsBeforeForward.memoryHits &&
            readsAfterForward.diskHits === readsBeforeForward.diskHits
    );
    assert('prewarmed reverse query finds the interface', reverse.length === 1 && reverse[0].name === 'Rare');
    assert('prewarmed reverse query stays responsive', reverseMs < 100);
    assert(
        'prewarmed reverse query performs no AST reads',
        readsAfterReverse.parsed === readsBeforeReverse.parsed &&
            readsAfterReverse.memoryHits === readsBeforeReverse.memoryHits &&
            readsAfterReverse.diskHits === readsBeforeReverse.diskHits
    );

    index.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
