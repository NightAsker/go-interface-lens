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

async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-interface-lazy-index-'));
    const root = path.join(tmp, 'project');
    const apiDir = path.join(root, 'api');
    const implDir = path.join(root, 'impl');
    const wrongDir = path.join(root, 'wrong');
    const baseDir = path.join(root, 'base');
    fs.mkdirSync(apiDir, { recursive: true });
    fs.mkdirSync(implDir, { recursive: true });
    fs.mkdirSync(wrongDir, { recursive: true });
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/project\n\ngo 1.22\n');

    const interfaceFile = path.join(apiDir, 'service.go');
    fs.writeFileSync(
        interfaceFile,
        [
            'package api',
            'import "context"',
            'import base "example.com/project/base"',
            'type Service interface {',
            '    Run(',
            '        context.Context,',
            '        func(value string) error,',
            '    ) error',
            '}',
            'type Closer interface { Close() error }',
            'type Result struct{}',
            'type Exporter interface { Export() Result }',
            'type Combined interface {',
            '    base.Remote',
            '    Local() error',
            '}',
            'type Number interface { ~int | int64 }',
        ].join('\n')
    );
    fs.writeFileSync(
        path.join(baseDir, 'base.go'),
        [
            'package base',
            'type Remote interface { Remote() error }',
            'type Base struct{}',
            'func (Base) Remote() error { return nil }',
        ].join('\n')
    );

    const implementationFile = path.join(implDir, 'worker.go');
    fs.writeFileSync(
        implementationFile,
        [
            'package impl',
            'import ctx "context"',
            'type Worker struct{}',
            'func',
            '(',
            '    worker *Worker,',
            ')',
            'Run(',
            '    _ ctx.Context,',
            '    callback func(string) error,',
            ') error { return callback("") }',
        ].join('\n')
    );

    fs.writeFileSync(
        path.join(wrongDir, 'wrong.go'),
        [
            'package wrong',
            'type Wrong struct{}',
            'func (Wrong) Run(value string) error { return nil }',
            'type Result struct{}',
            'type WrongExporter struct{}',
            'func (WrongExporter) Export() Result { return Result{} }',
        ].join('\n')
    );
    fs.writeFileSync(
        path.join(implDir, 'embed.go'),
        [
            'package impl',
            'type Base struct{}',
            'func (*Base) Close() error { return nil }',
            'type ValueEmbed struct { Base }',
            'type PointerEmbed struct { *Base }',
        ].join('\n')
    );
    fs.writeFileSync(
        path.join(implDir, 'export.go'),
        [
            'package impl',
            'import api "example.com/project/api"',
            'type GoodExporter struct{}',
            'func (GoodExporter) Export() api.Result { return api.Result{} }',
        ].join('\n')
    );
    fs.writeFileSync(
        path.join(implDir, 'combined.go'),
        [
            'package impl',
            'import base "example.com/project/base"',
            'type Direct struct{}',
            'func (Direct) Remote() error { return nil }',
            'func (Direct) Local() error { return nil }',
            'type Promoted struct { base.Base }',
            'func (Promoted) Local() error { return nil }',
            'type Partial struct{}',
            'func (Partial) Local() error { return nil }',
        ].join('\n')
    );

    const config = () => ({
        excludedFolders: ['vendor'],
        excludedFilePatterns: [],
        excludedTypePatterns: [],
        searchDependencies: false,
        goModCache: '',
        astConcurrency: 2,
    });
    const logs = [];
    const index = new WorkspaceIndex(config, (message) => logs.push(message), {
        cacheDir: path.join(tmp, 'cache'),
    });
    await index.ensureBuilt(root);

    console.log('== regex recall followed by lazy AST filtering ==');
    assert(
        'legacy receiver regex misses deliberately split declaration',
        !index.findImplementations('Service', interfaceFile).some((result) => result.name === 'Worker')
    );
    const implementations = await index.findImplementationsAst('Service', interfaceFile);
    eq('AST finds only the structurally valid implementation', implementations.map((r) => r.name), ['*Worker']);
    assert('AST query parsed candidate files in workers', index.getAstStats().parsed > 0);

    const parsedBeforeCacheHit = index.getAstStats().parsed;
    await index.findImplementationsAst('Service', interfaceFile);
    eq('second implementation query uses query cache', index.getAstStats().parsed, parsedBeforeCacheHit);

    const methods = await index.findMethodImplementationsAst('Service', 'Run', interfaceFile);
    eq('method query navigates to split receiver declaration', methods.map((r) => r.name), ['*Worker']);
    assert('method result points at implementation file', methods[0].file === implementationFile);

    const reverse = await index.findInterfacesAst('Worker', 'Run', { receiverFile: implementationFile });
    eq('reverse AST lookup finds the interface', reverse.map((r) => r.name), ['Service']);

    const constraints = await index.findImplementationsAst('Number', interfaceFile);
    eq('constraint interface is not treated as a runtime interface', constraints, []);
    const closers = await index.findImplementationsAst('Closer', interfaceFile);
    eq(
        'value and pointer embedding produce distinct Go method sets',
        closers.map((result) => result.name).sort(),
        ['*Base', '*ValueEmbed', 'PointerEmbed']
    );
    const exporters = await index.findImplementationsAst('Exporter', interfaceFile);
    eq(
        'package import paths reject an unrelated same-named local type',
        exporters.map((result) => result.name),
        ['GoodExporter']
    );
    const combined = await index.findImplementationsAst('Combined', interfaceFile);
    eq(
        'workspace imported interfaces and promoted imported methods resolve lazily',
        combined.map((result) => result.name).sort(),
        ['Direct', 'Promoted']
    );

    console.log('\n== unsaved AST overlay invalidation ==');
    const diskImplementation = fs.readFileSync(implementationFile, 'utf8');
    index.updateOverlay(
        implementationFile,
        `${diskImplementation}\ntype OverlayWorker struct{}\n` +
            'func (OverlayWorker) Run(_ ctx.Context, callback func(string) error) error { return nil }\n'
    );
    const withOverlay = await index.findImplementationsAst('Service', interfaceFile);
    assert(
        'unsaved implementation participates in AST filtering',
        withOverlay.some((result) => result.name === 'OverlayWorker')
    );
    index.clearOverlay(implementationFile);
    const afterClose = await index.findImplementationsAst('Service', interfaceFile);
    assert(
        'closing unsaved overlay restores disk query result',
        !afterClose.some((result) => result.name === 'OverlayWorker')
    );
    assert('query timing is logged', logs.some((line) => line.includes('AST implementation query Service')));

    index.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
