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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-interface-lazy-deps-'));
    const root = path.join(tmp, 'project');
    const modCache = path.join(tmp, 'pkg', 'mod');
    const depDir = path.join(modCache, 'example.com', 'dep@v1.0.0');
    const aliasDepDir = path.join(modCache, 'example.com', 'aliasdep@v1.0.0');
    const goRoot = path.join(tmp, 'goroot');
    const standardDir = path.join(goRoot, 'src', 'standard', 'sort');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(depDir, { recursive: true });
    fs.mkdirSync(aliasDepDir, { recursive: true });
    fs.mkdirSync(standardDir, { recursive: true });
    fs.writeFileSync(
        path.join(root, 'go.mod'),
        'module example.com/project\n\ngo 1.22\n\nrequire (\n\texample.com/dep v1.0.0\n\texample.com/aliasdep v1.0.0\n)\n'
    );
    const implementationFile = path.join(root, 'impl.go');
    fs.writeFileSync(
        implementationFile,
        [
            'package project',
            'import dep "example.com/dep"',
            'import aliasdep "example.com/aliasdep"',
            'type ExternalImpl struct{}',
            'func (ExternalImpl) ExternalOnly(value string) error { return nil }',
            'func (ExternalImpl) Extra() error { return nil }',
            'func (ExternalImpl) Convert(value dep.Result) dep.Result { return value }',
            'func (ExternalImpl) Accept(value aliasdep.ExternalID) {}',
            'func (ExternalImpl) AcceptBytes(value aliasdep.Bytes) {}',
            'type WrongAliasImpl struct{}',
            'func (WrongAliasImpl) Accept(value aliasdep.Other) {}',
        ].join('\n') + '\n'
    );
    fs.writeFileSync(path.join(depDir, 'go.mod'), 'module example.com/dep\n\ngo 1.22\n');
    fs.writeFileSync(path.join(aliasDepDir, 'go.mod'), 'module example.com/aliasdep\n\ngo 1.22\n');
    fs.writeFileSync(
        path.join(aliasDepDir, 'alias.go'),
        'package aliasdep\ntype ID = string\ntype ExternalID = ID\ntype Bytes = []byte\ntype Other = int\n'
    );
    const dependencyFile = path.join(depDir, 'external.go');
    fs.writeFileSync(
        dependencyFile,
        [
            'package dep',
            'type Result struct{}',
            'type External interface { Base; Convert(Result) Result; ExternalOnly(value string) error }',
            'type ExternalAlias = External',
        ].join('\n') + '\n'
    );
    fs.writeFileSync(
        path.join(depDir, 'base.go'),
        'package dep\ntype Base interface { Extra() error }\n'
    );
    fs.writeFileSync(
        path.join(standardDir, 'sort.go'),
        'package sort\ntype Interface interface { Len() int; Less(int, int) bool; Swap(int, int) }\n'
    );

    const config = () => ({
        excludedFolders: ['vendor'],
        excludedFilePatterns: [],
        excludedTypePatterns: [],
        searchDependencies: true,
        goModCache: modCache,
        astConcurrency: 2,
    });
    const previousGoRoot = process.env.GOROOT;
    process.env.GOROOT = goRoot;
    const index = new WorkspaceIndex(config, () => {}, { cacheDir: path.join(tmp, 'cache') });
    await index.ensureBuilt(root);

    console.log('== lazy AST dependency filtering ==');
    const interfaces = await index.findInterfacesAst('ExternalImpl', 'ExternalOnly', {
        receiverFile: implementationFile,
    });
    eq('module-cache interface found through AST filtering', interfaces.map((result) => result.name), ['External']);
    assert('dependency result marked external', interfaces[0].external);
    assert('dependency navigation points at locked module version', interfaces[0].file === dependencyFile);

    const localInterfaceFile = path.join(root, 'local.go');
    const localSource = [
        'package project',
        'import dep "example.com/dep"',
        'import sort "standard/sort"',
        'type LocalExternal interface { Extra() error; Convert(dep.Result) dep.Result; ExternalOnly(value string) error }',
        'type Sortable interface { Len() int; Less(int, int) bool; Swap(int, int) }',
        'type AliasInput interface { Accept(value string) }',
        'type CompositeAliasInput interface { AcceptBytes(value []uint8) }',
        'type EmbeddedExternal struct { dep.External }',
        'type EmbeddedExternalAlias struct { dep.ExternalAlias }',
        'type EmbeddedSort struct { sort.Interface }',
    ].join('\n') + '\n';
    fs.writeFileSync(localInterfaceFile, localSource);
    index.updateFileText(localInterfaceFile, localSource);

    const aliasImplementations = await index.findImplementationsAst('AliasInput', localInterfaceFile);
    eq(
        'cross-package alias chains in signatures resolve lazily without false positives',
        aliasImplementations.map((result) => result.name),
        ['ExternalImpl']
    );
    const compositeAliasImplementations = await index.findImplementationsAst(
        'CompositeAliasInput',
        localInterfaceFile
    );
    eq(
        'cross-package composite aliases retain and normalize their complete type',
        compositeAliasImplementations.map((result) => result.name),
        ['ExternalImpl']
    );

    const implementations = await index.findImplementationsAst('LocalExternal', localInterfaceFile);
    eq(
        'dependency interface and alias embeds are resolved from locked source',
        implementations.map((result) => result.name).sort(),
        ['EmbeddedExternal', 'EmbeddedExternalAlias', 'ExternalImpl']
    );
    const parsedBeforeMethodQuery = index.getAstStats().parsed;
    const methodImplementations = await index.findMethodImplementationsAst(
        'LocalExternal',
        'ExternalOnly',
        localInterfaceFile
    );
    eq(
        'dependency-promoted methods remain navigable',
        methodImplementations.map((result) => result.name).sort(),
        ['EmbeddedExternal', 'EmbeddedExternalAlias', 'ExternalImpl']
    );
    assert(
        'dependency-promoted method points at locked interface source',
        methodImplementations.some((result) => result.file === dependencyFile)
    );
    eq(
        'dependency declaration AST is reused across queries',
        index.getAstStats().parsed,
        parsedBeforeMethodQuery
    );
    const sortable = await index.findImplementationsAst('Sortable', localInterfaceFile);
    eq('non-hardcoded standard-library interface resolves from GOROOT source', sortable.map((r) => r.name), [
        'EmbeddedSort',
    ]);

    index.dispose();
    if (previousGoRoot === undefined) delete process.env.GOROOT;
    else process.env.GOROOT = previousGoRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
