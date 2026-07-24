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
            `package noise\ntype Noise${i} struct{}\nfunc (Noise${i}) Method${i}(value int) int { return value }\n`
        );
    }
    const interfaceFile = path.join(apiDir, 'rare.go');
    fs.writeFileSync(interfaceFile, 'package api\ntype Rare interface { RareMethod(value string) error }\n');
    fs.writeFileSync(
        path.join(implDir, 'impl.go'),
        'package impl\ntype Impl struct{}\nfunc (Impl) RareMethod(value string) error { return nil }\n'
    );

    const config = () => ({
        excludedFolders: ['vendor'],
        excludedFilePatterns: [],
        excludedTypePatterns: [],
        searchDependencies: false,
        goModCache: '',
        astConcurrency: 2,
    });
    const index = new WorkspaceIndex(config, () => {}, { cacheDir: path.join(tmp, 'cache') });

    const buildStarted = process.hrtime.bigint();
    await index.ensureBuilt(root);
    const buildMs = Number(process.hrtime.bigint() - buildStarted) / 1e6;
    const parsedAfterStartup = index.getAstStats().parsed;

    const legacyStarted = process.hrtime.bigint();
    index.findImplementations('Rare', interfaceFile);
    const legacyQueryMs = Number(process.hrtime.bigint() - legacyStarted) / 1e6;

    const coldStarted = process.hrtime.bigint();
    const cold = await index.findImplementationsAst('Rare', interfaceFile);
    const coldMs = Number(process.hrtime.bigint() - coldStarted) / 1e6;

    const warmStarted = process.hrtime.bigint();
    const warm = await index.findImplementationsAst('Rare', interfaceFile);
    const warmMs = Number(process.hrtime.bigint() - warmStarted) / 1e6;

    console.log('== lazy AST performance (402 Go files) ==');
    console.log(`  startup regex index : ${buildMs.toFixed(1)}ms`);
    console.log(`  legacy warm query   : ${legacyQueryMs.toFixed(2)}ms`);
    console.log(`  AST cold query      : ${coldMs.toFixed(1)}ms`);
    console.log(`  AST cached query    : ${warmMs.toFixed(2)}ms`);
    console.log(`  AST files parsed    : ${index.getAstStats().parsed}`);

    assert('cold AST query finds implementation', cold.length === 1 && cold[0].name === 'Impl');
    assert('cached AST query preserves result', warm.length === 1 && warm[0].name === 'Impl');
    assert('startup regex indexing stays within broad budget', buildMs < 5000);
    assert('startup candidate indexing does not parse any file with WASM', parsedAfterStartup === 0);
    assert('cold candidate AST query stays within broad budget', coldMs < 2000);
    assert('cached query stays responsive', warmMs < 100);
    assert('query parses candidates instead of the whole workspace', index.getAstStats().parsed <= 4);

    index.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
