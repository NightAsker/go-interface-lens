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

function astReads(stats) {
    return {
        parsed: stats.parsed,
        memoryHits: stats.memoryHits,
        diskHits: stats.diskHits,
    };
}

async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-interface-lazy-deps-'));
    const root = path.join(tmp, 'project');
    const modCache = path.join(tmp, 'pkg', 'mod');
    const depDir = path.join(modCache, 'example.com', 'dep@v1.0.0');
    const aliasDepDir = path.join(modCache, 'example.com', 'aliasdep@v1.0.0');
    const depImplDir = path.join(modCache, 'example.com', 'depimpl@v1.0.0');
    const staleDepImplDir = path.join(modCache, 'example.com', 'depimpl@v0.9.0');
    const ifaceDepDir = path.join(modCache, 'example.com', 'iface@v1.0.0');
    const wrapperDir = path.join(modCache, 'example.com', 'wrapper@v1.0.0');
    const goRoot = path.join(tmp, 'goroot');
    const standardDir = path.join(goRoot, 'src', 'standard', 'sort');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(depDir, { recursive: true });
    fs.mkdirSync(aliasDepDir, { recursive: true });
    fs.mkdirSync(depImplDir, { recursive: true });
    fs.mkdirSync(staleDepImplDir, { recursive: true });
    fs.mkdirSync(ifaceDepDir, { recursive: true });
    fs.mkdirSync(wrapperDir, { recursive: true });
    fs.mkdirSync(standardDir, { recursive: true });
    fs.writeFileSync(
        path.join(root, 'go.mod'),
        'module example.com/project\n\ngo 1.22\n\nrequire (\n\texample.com/dep v1.0.0\n\texample.com/aliasdep v1.0.0\n\texample.com/depimpl v1.0.0\n\texample.com/iface v1.0.0\n\texample.com/wrapper v1.0.0\n)\n'
    );
    const implementationFile = path.join(root, 'impl.go');
    fs.writeFileSync(
        implementationFile,
        [
            'package project',
            'import "context"',
            'import dep "example.com/dep"',
            'import aliasdep "example.com/aliasdep"',
            'type ExternalImpl struct{}',
            'func (ExternalImpl) ExternalOnly(value string) error { return nil }',
            'func (ExternalImpl) Extra() error { return nil }',
            'func (ExternalImpl) Convert(value dep.Result) dep.Result { return value }',
            'func (ExternalImpl) Accept(value aliasdep.ExternalID) {}',
            'func (ExternalImpl) AcceptBytes(value aliasdep.Bytes) {}',
            'func (ExternalImpl) HandleMessage(ctx context.Context, msg *aliasdep.ConsumeMessage) error { return nil }',
            'type WrongAliasImpl struct{}',
            'func (WrongAliasImpl) Accept(value aliasdep.Other) {}',
        ].join('\n') + '\n'
    );
    fs.writeFileSync(path.join(depDir, 'go.mod'), 'module example.com/dep\n\ngo 1.22\n');
    fs.writeFileSync(path.join(aliasDepDir, 'go.mod'), 'module example.com/aliasdep\n\ngo 1.22\n');
    fs.writeFileSync(path.join(depImplDir, 'go.mod'), 'module example.com/depimpl\n\ngo 1.22\n');
    fs.writeFileSync(path.join(staleDepImplDir, 'go.mod'), 'module example.com/depimpl\n\ngo 1.22\n');
    fs.writeFileSync(path.join(ifaceDepDir, 'go.mod'), 'module example.com/iface\n\ngo 1.22\n');
    fs.writeFileSync(path.join(wrapperDir, 'go.mod'), 'module example.com/wrapper\n\ngo 1.22\n');
    fs.writeFileSync(
        path.join(aliasDepDir, 'alias.go'),
        [
            'package aliasdep',
            'import dep "example.com/dep"',
            'type ID = string',
            'type ExternalID = ID',
            'type Bytes = []byte',
            'type Other = int',
            'type ConsumeMessage = dep.MessageExt',
        ].join('\n') + '\n'
    );
    const dependencyFile = path.join(depDir, 'external.go');
    fs.writeFileSync(
        dependencyFile,
        [
            'package dep',
            'import "context"',
            'type Result struct{}',
            'type MessageExt struct { Result; Consumer int }',
            'type External interface { Base; Convert(Result) Result; ExternalOnly(value string) error }',
            'type ExternalAlias = External',
            'type IHandler interface { HandleMessage(context.Context, *MessageExt) error }',
        ].join('\n') + '\n'
    );
    fs.writeFileSync(
        path.join(depDir, 'base.go'),
        'package dep\ntype Base interface { Extra() error }\n'
    );
    const dependencyImplementationFile = path.join(depImplDir, 'handler.go');
    fs.writeFileSync(
        dependencyImplementationFile,
        [
            'package depimpl',
            'import "context"',
            'import dep "example.com/dep"',
            'type ConsumeMessage = dep.MessageExt',
            'type DependencyHandler struct{}',
            'func (*DependencyHandler) HandleMessage(ctx context.Context, msg *ConsumeMessage) error { return nil }',
            'type PartialHandler struct{}',
            'func (*PartialHandler) HandleMessage(ctx context.Context, msg *ConsumeMessage) error { return nil }',
            'type WrongHandler struct{}',
            'func (*WrongHandler) HandleMessage(ctx context.Context, msg *ConsumeMessage) int { return 0 }',
        ].join('\n') + '\n'
    );
    fs.writeFileSync(
        path.join(depImplDir, 'extra.go'),
        [
            'package depimpl',
            'func (*DependencyHandler) DependencyOnly() error { return nil }',
        ].join('\n') + '\n'
    );
    fs.writeFileSync(
        path.join(staleDepImplDir, 'handler.go'),
        [
            'package depimpl',
            'import "context"',
            'import dep "example.com/dep"',
            'type StaleHandler struct{}',
            'func (*StaleHandler) HandleMessage(ctx context.Context, msg *dep.MessageExt) error { return nil }',
            'func (*StaleHandler) DependencyOnly() error { return nil }',
        ].join('\n') + '\n'
    );
    fs.writeFileSync(
        path.join(wrapperDir, 'wrapper.go'),
        [
            'package wrapper',
            'import impl "example.com/depimpl"',
            'type EmbeddedDependencyHandler struct { *impl.DependencyHandler }',
        ].join('\n') + '\n'
    );
    fs.writeFileSync(
        path.join(ifaceDepDir, 'handler.go'),
        [
            'package iface',
            'import "context"',
            'import dep "example.com/dep"',
            'type RemoteHandler interface {',
            '    HandleMessage(context.Context, *dep.MessageExt) error',
            '}',
        ].join('\n') + '\n'
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
    const handlerInterfaces = await index.findInterfacesAst('ExternalImpl', 'HandleMessage', {
        receiverFile: implementationFile,
    });
    assert(
        'reverse lookup resolves a dependency interface through another dependency package alias',
        handlerInterfaces.some((result) => result.name === 'IHandler')
    );
    const lockedDirs = index._resolveLockedDirs(modCache);
    const cachedCandidates = index._dependencyInterfaceCandidates(
        modCache,
        'ExternalOnly',
        lockedDirs
    );
    assert(
        'dependency candidate grep is shared across receiver queries',
        cachedCandidates ===
            index._dependencyInterfaceCandidates(modCache, 'ExternalOnly', lockedDirs)
    );
    await cachedCandidates;

    const localInterfaceFile = path.join(root, 'local.go');
    const localSource = [
        'package project',
        'import "context"',
        'import dep "example.com/dep"',
        'import sort "standard/sort"',
        'type LocalExternal interface { Extra() error; Convert(dep.Result) dep.Result; ExternalOnly(value string) error }',
        'type Sortable interface { Len() int; Less(int, int) bool; Swap(int, int) }',
        'type AliasInput interface { Accept(value string) }',
        'type CompositeAliasInput interface { AcceptBytes(value []uint8) }',
        'type LocalHandler interface { HandleMessage(context.Context, *dep.MessageExt) error }',
        'type DependencyHandlerContract interface {',
        '    HandleMessage(context.Context, *dep.MessageExt) error',
        '    DependencyOnly() error',
        '}',
        'type EmbeddedExternal struct { dep.External }',
        'type EmbeddedExternalAlias struct { dep.ExternalAlias }',
        'type EmbeddedSort struct { sort.Interface }',
    ].join('\n') + '\n';
    fs.writeFileSync(localInterfaceFile, localSource);
    index.updateFileText(localInterfaceFile, localSource);

    const mergedHandlerInterfaces = await index.findInterfacesAst('ExternalImpl', 'HandleMessage', {
        receiverFile: implementationFile,
    });
    const mergedHandlerNames = mergedHandlerInterfaces.map((result) => result.name).sort();
    assert('reverse lookup retains a matching workspace interface', mergedHandlerNames.includes('LocalHandler'));
    assert('reverse lookup also searches an unrelated dependency interface when a local match exists', mergedHandlerNames.includes('RemoteHandler'));

    const dependencyPrewarmPriorities = [];
    const loadExternalDirectoryForPrewarm = index._loadExternalDirectory.bind(index);
    index._loadExternalDirectory = (directory, importPath, priority) => {
        dependencyPrewarmPriorities.push(priority);
        return loadExternalDirectoryForPrewarm(directory, importPath, priority);
    };
    try {
        await index.prewarmReverseInterfaces();
    } finally {
        index._loadExternalDirectory = loadExternalDirectoryForPrewarm;
    }
    const prewarmStats = index.getReversePrewarmStats();
    assert(
        'locked dependency implementation prewarm stays at background priority',
        dependencyPrewarmPriorities.length > 0 &&
            dependencyPrewarmPriorities.every(
                (priority) => Number.isFinite(priority) && priority <= 10
            )
    );
    assert(
        'complete relation prewarm includes locked dependency implementation files',
        prewarmStats.dependencyFiles > 0
    );
    const astReadsAfterPrewarm = astReads(index.getAstStats());
    const buildWorkspaceImplementationContext = index._buildImplementationAstContext;
    const dependencyImplementationCandidates = index._dependencyImplementationCandidates;
    const dependencyInterfaceCandidates = index._dependencyInterfaceCandidates;
    const dependencyTypeReferenceCandidates = index._dependencyTypeReferenceCandidates;
    index._buildImplementationAstContext = async () => {
        throw new Error('workspace implementation context was rebuilt after prewarm');
    };
    index._dependencyImplementationCandidates = async () => {
        throw new Error('dependency implementations were scanned after complete prewarm');
    };
    index._dependencyInterfaceCandidates = async () => {
        throw new Error('dependency interfaces were scanned after complete prewarm');
    };
    index._dependencyTypeReferenceCandidates = async () => {
        throw new Error('dependency type references were scanned after complete prewarm');
    };
    let dependencyImplementations;
    let dependencyMethodImplementations;
    try {
        dependencyImplementations = await index.findImplementationsAst(
            'DependencyHandlerContract',
            localInterfaceFile
        );
        dependencyMethodImplementations = await index.findMethodImplementationsAst(
            'DependencyHandlerContract',
            'HandleMessage',
            localInterfaceFile
        );
    } finally {
        index._buildImplementationAstContext = buildWorkspaceImplementationContext;
        index._dependencyImplementationCandidates = dependencyImplementationCandidates;
        index._dependencyInterfaceCandidates = dependencyInterfaceCandidates;
        index._dependencyTypeReferenceCandidates = dependencyTypeReferenceCandidates;
    }
    assert(
        'dependency implementation lookup reuses the prewarmed workspace context',
        Array.isArray(dependencyImplementations)
    );
    const dependencyImplementation = dependencyImplementations.find(
        (result) => result.name === '*DependencyHandler'
    );
    assert('implementation lookup finds a concrete type in a locked dependency', !!dependencyImplementation);
    assert('dependency implementation result is marked external', dependencyImplementation && dependencyImplementation.external);
    assert('dependency implementation points at its declaration package', dependencyImplementation && dependencyImplementation.file.startsWith(depImplDir));
    assert('dependency implementation rejects a type missing another interface method', !dependencyImplementations.some((result) => result.name === '*PartialHandler'));
    assert('dependency implementation rejects a wrong anchor signature', !dependencyImplementations.some((result) => result.name === '*WrongHandler'));
    assert('dependency implementation excludes an unlocked cached module version', !dependencyImplementations.some((result) => result.name === '*StaleHandler'));
    assert('dependency implementation includes a type using promoted methods from another dependency', dependencyImplementations.some((result) => result.name === 'EmbeddedDependencyHandler'));
    eq(
        'prewarmed dependency implementation queries perform no AST reads',
        astReads(index.getAstStats()),
        astReadsAfterPrewarm
    );
    const dependencyMethod = dependencyMethodImplementations.find(
        (result) => result.name === '*DependencyHandler'
    );
    assert('method implementation lookup also searches dependencies', !!dependencyMethod);
    assert('dependency method navigation points at the method declaration', dependencyMethod && dependencyMethod.file === dependencyImplementationFile);
    const embeddedDependencyMethod = dependencyMethodImplementations.find(
        (result) => result.name === 'EmbeddedDependencyHandler'
    );
    assert('promoted dependency method navigation follows the contributing declaration', embeddedDependencyMethod && embeddedDependencyMethod.file === dependencyImplementationFile);

    const aliasImplementations = await index.findImplementationsAst('AliasInput', localInterfaceFile);
    eq(
        'cross-package alias chains in signatures resolve lazily without false positives',
        aliasImplementations.map((result) => result.name),
        ['ExternalImpl']
    );
    const aliasInterfaces = await index.findInterfacesAst('ExternalImpl', 'Accept', {
        receiverFile: implementationFile,
    });
    assert(
        'reverse lookup resolves an alias declared in a dependency package',
        aliasInterfaces.some((result) => result.name === 'AliasInput')
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

    const localOnlyIndex = new WorkspaceIndex(
        () => ({ ...config(), searchDependencies: false }),
        () => {},
        { cacheDir: path.join(tmp, 'local-only-cache') }
    );
    await localOnlyIndex.ensureBuilt(root);
    const localOnlyImplementations = await localOnlyIndex.findImplementationsAst(
        'DependencyHandlerContract',
        localInterfaceFile
    );
    assert(
        'disabling dependency search excludes dependency concrete implementations',
        !localOnlyImplementations.some((result) => result.external)
    );
    const localOnlyInterfaces = await localOnlyIndex.findInterfacesAst(
        'ExternalImpl',
        'HandleMessage',
        { receiverFile: implementationFile }
    );
    assert(
        'disabling dependency search retains local interfaces and excludes remote ones',
        localOnlyInterfaces.some((result) => result.name === 'LocalHandler') &&
            !localOnlyInterfaces.some((result) => result.name === 'RemoteHandler')
    );

    index.dispose();
    localOnlyIndex.dispose();
    if (previousGoRoot === undefined) delete process.env.GOROOT;
    else process.env.GOROOT = previousGoRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
