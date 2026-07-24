'use strict';

const path = require('path');

// Redirect `require('vscode')` to the headless stub.
const Module = require('module');
const origResolve = Module._resolveFilename;
const stubPath = path.join(__dirname, 'vscode-stub.js');
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return stubPath;
    return origResolve.call(this, request, ...rest);
};

const { WorkspaceIndex } = require(path.join(__dirname, '..', 'src', 'indexer'));
const { parseFile } = require(path.join(__dirname, '..', 'src', 'parser'));
const { parseGoFile } = require(path.join(__dirname, '..', 'src', 'ast'));
const { assert, done } = require(path.join(__dirname, 'harness'));

const cfg = () => ({
    excludedFolders: ['mocks', 'mock', 'testdata', 'vendor'],
    excludedFilePatterns: ['_mock.go', 'mock_', '.pb.go', '_test.go'],
    excludedTypePatterns: ['Mock', 'mock', 'Stub', 'Fake'],
    // Disable dependency search so this test never touches the real module cache.
    searchDependencies: false,
});

async function main() {
    const idx = new WorkspaceIndex(cfg, () => {});
    const root = path.join(__dirname, 'fixtures');
    await idx.ensureBuilt(root);

    console.log('== findImplementations(Store) ==');
    const impls = idx.findImplementations('Store').map((r) => r.name).sort();
    console.log('  got:', impls);
    assert('includes PostgresStore', impls.includes('PostgresStore'));
    assert('includes MemStore (cross-dir)', impls.includes('MemStore'));
    assert('excludes PartialStore (missing Put)', !impls.includes('PartialStore'));
    assert('excludes WrongSigStore (wrong signatures)', !impls.includes('WrongSigStore'));

    console.log('\n== findMethodImplementations(Store, Put) ==');
    const puts = idx.findMethodImplementations('Store', 'Put').map((r) => r.name).sort();
    console.log('  got:', puts);
    assert('Put impls include PostgresStore', puts.includes('PostgresStore'));
    assert('Put impls exclude PartialStore', !puts.includes('PartialStore'));
    assert('Put impls exclude WrongSigStore', !puts.includes('WrongSigStore'));

    console.log('\n== findInterfaces(PostgresStore, Get) ==');
    const ifaces = (await idx.findInterfaces('PostgresStore', 'Get')).map((r) => r.name).sort();
    console.log('  got:', ifaces);
    assert('finds Store interface', ifaces.includes('Store'));

    console.log('\n== embedded stdlib interface: full impl found, partial rejected ==');
    const customImpls = idx.findImplementations('Custom').map((r) => r.name).sort();
    console.log('  got:', customImpls);
    assert('PartialCustom NOT reported as implementing Custom', !customImpls.includes('PartialCustom'));
    assert('FullCustom (Read+Extra) reported as implementing Custom', customImpls.includes('FullCustom'));

    console.log('\n== interface method inverted index ==');
    const readCandidates = (idx._interfacesByMethod.get('Read') || []).map(
        (key) => idx._interfaceDecls.get(key).name
    );
    assert('embedded io.Reader method indexes Custom', readCandidates.includes('Custom'));
    assert('goto-interface lookup finds inherited Read method', idx.hasLocalInterface('FullCustom', 'Read'));

    console.log('\n== method location resolution ==');
    const one = idx.findMethodImplementations('Store', 'Get').find((r) => r.name === 'PostgresStore');
    assert('PostgresStore.Get has a valid line', one && one.line >= 0);
    assert('PostgresStore.Get points at store.go', one && one.file.endsWith('store.go'));

    idx.dispose();

    await chunkedIndexBuildYields();
    await invertedIndexStopsAfterFirstMatch();
    await sameNameDifferentPackages();
    await sameNameInterfacesStayPackageScoped();
    await sameNameTypesKeepIndependentSignatures();
    await packageScopedEmbedsResolveLocally();
    await gotoInterfaceCrossPackage();
    promotedMethodImplementationLocation();
    typeAliasesCanonicalizeSignatures();
    predeclaredAliasesRespectShadowing();
    predeclaredAliasesCanonicalizeCompositeResults();
    unsavedDocumentOverlay();
    done();
}

function promotedMethodImplementationLocation() {
    const idx = new WorkspaceIndex(cfg, () => {});
    const file = '/synthetic/promoted/service.go';
    idx.files.set(
        file,
        parseFile(
            [
                'package promoted',
                'type Service interface { Run() }',
                'type Base struct{}',
                'func (Base) Run() {}',
                'type Derived struct { Base }',
            ].join('\n')
        )
    );

    console.log('\n== promoted method implementation location ==');
    const implementations = idx.findImplementations('Service', file).map((r) => r.name);
    const methods = idx.findMethodImplementations('Service', 'Run', file).map((r) => r.name);
    assert('Derived satisfies Service through Base', implementations.includes('Derived'));
    assert('method search includes promoted implementation Derived', methods.includes('Derived'));
    idx.dispose();
}

function typeAliasesCanonicalizeSignatures() {
    const idx = new WorkspaceIndex(cfg, () => {});
    const file = '/synthetic/aliases/service.go';
    idx.files.set(
        file,
        parseFile(
            [
                'package aliases',
                'type ID = string',
                'type Consumer interface { Use(ID) }',
                'type Impl struct{}',
                'func (Impl) Use(string) {}',
            ].join('\n')
        )
    );

    console.log('\n== type aliases canonicalize signatures ==');
    const implementations = idx.findImplementations('Consumer', file).map((r) => r.name);
    assert('method using alias matches its canonical target', implementations.includes('Impl'));
    idx.dispose();
}

function predeclaredAliasesRespectShadowing() {
    const idx = new WorkspaceIndex(cfg, () => {});
    const builtinFile = '/synthetic/predeclared/builtin.go';
    const shadowFile = '/synthetic/shadow/shadow.go';
    idx.files.set(
        builtinFile,
        parseGoFile(
            [
                'package predeclared',
                'type Consumer interface { Use(byte, rune, any) }',
                'type Impl struct{}',
                'func (Impl) Use(uint8, int32, interface{}) {}',
            ].join('\n')
        )
    );
    idx.files.set(
        shadowFile,
        parseGoFile(
            [
                'package shadow',
                'type byte string',
                'type Consumer interface { Use(byte) }',
                'type Impl struct{}',
                'func (Impl) Use(uint8) {}',
            ].join('\n')
        )
    );

    console.log('\n== predeclared aliases respect package shadowing ==');
    assert(
        'byte/rune/any match their predeclared targets',
        idx.findImplementations('Consumer', builtinFile).some((result) => result.name === 'Impl')
    );
    assert(
        'package-local byte declaration is not rewritten to uint8',
        idx.findImplementations('Consumer', shadowFile).length === 0
    );
    idx.dispose();
}

function predeclaredAliasesCanonicalizeCompositeResults() {
    const idx = new WorkspaceIndex(cfg, () => {});
    const source = [
        'package predeclared',
        'type CompositeResults interface {',
        '    Empty() interface{}',
        '    Map() map[string]interface{}',
        '    Slice() []interface{}',
        '    PointerMap() *map[string]interface{}',
        '    Nested() map[string][]interface{}',
        '}',
        'type Impl struct{}',
        'func (Impl) Empty() any { return nil }',
        'func (Impl) Map() map[string]any { return nil }',
        'func (Impl) Slice() []any { return nil }',
        'func (Impl) PointerMap() *map[string]any { return nil }',
        'func (Impl) Nested() map[string][]any { return nil }',
    ].join('\n');
    const astFile = '/synthetic/predeclared/composite-results-ast.go';
    const lightweightFile = '/synthetic/predeclared/composite-results-lightweight.go';
    idx.files.set(astFile, parseGoFile(source));

    console.log('\n== any canonicalizes inside unparenthesized composite results ==');
    assert(
        'declaration AST matches interface{} and any recursively inside result types',
        idx.findImplementations('CompositeResults', astFile).some((result) => result.name === 'Impl')
    );
    idx.files.delete(astFile);
    idx._invalidateMerged();
    idx.files.set(lightweightFile, parseFile(source));
    assert(
        'lightweight index matches interface{} and any recursively inside result types',
        idx.findImplementations('CompositeResults', lightweightFile).some(
            (result) => result.name === 'Impl'
        )
    );
    idx.dispose();
}

function unsavedDocumentOverlay() {
    const idx = new WorkspaceIndex(cfg, () => {});
    const file = '/synthetic/overlay/service.go';
    idx.files.set(
        file,
        parseFile(['package overlay', 'type Service interface { Run() }', 'type Impl struct{}'].join('\n'))
    );

    console.log('\n== unsaved document overlay ==');
    assert('disk snapshot has no implementation', idx.findImplementations('Service', file).length === 0);
    idx.updateOverlay(
        file,
        ['package overlay', 'type Service interface { Run() }', 'type Impl struct{}', 'func (Impl) Run() {}'].join('\n')
    );
    assert('overlay makes unsaved method searchable', idx.findImplementations('Service', file).some((r) => r.name === 'Impl'));
    idx.clearOverlay(file);
    assert('clearing overlay restores disk snapshot', idx.findImplementations('Service', file).length === 0);
    idx.dispose();
}

async function chunkedIndexBuildYields() {
    const idx = new WorkspaceIndex(cfg, () => {});
    const fixtureDir = path.join(__dirname, 'fixtures', 'pkg');
    const files = [path.join(fixtureDir, 'store.go'), path.join(fixtureDir, 'embed.go')];
    const previousSlice = WorkspaceIndex.INDEX_TIME_SLICE_MS;
    let yields = 0;

    WorkspaceIndex.INDEX_TIME_SLICE_MS = 0;
    idx._yieldToEventLoop = async () => {
        yields += 1;
    };
    try {
        await idx._indexFilesInChunks(files);
    } finally {
        WorkspaceIndex.INDEX_TIME_SLICE_MS = previousSlice;
    }

    console.log('\n== chunked index build yields ==');
    assert('indexes every file through async batches', idx.files.size === files.length);
    assert('yields between synchronous parse slices', yields === files.length);
    idx.dispose();
}

async function invertedIndexStopsAfterFirstMatch() {
    const idx = new WorkspaceIndex(cfg, () => {});
    idx.files.set(
        '/synthetic/interfaces.go',
        parseFile(
            [
                'package synthetic',
                'type First interface { Run() }',
                'type Second interface { Run() }',
                'type Unrelated interface { Other() }',
                'type Runner struct{}',
                'func (r *Runner) Run() {}',
            ].join('\n')
        )
    );
    idx._merged();

    const runCandidates = idx._interfacesByMethod.get('Run') || [];
    let resolvedCandidates = 0;
    const resolve = idx._resolveInterfaceMethodsCached.bind(idx);
    idx._resolveInterfaceMethodsCached = (...args) => {
        resolvedCandidates += 1;
        return resolve(...args);
    };

    console.log('\n== inverted lookup stops after first match ==');
    assert('Run index excludes interfaces with other methods', runCandidates.length === 2);
    assert('existence lookup finds a matching interface', idx.hasLocalInterface('Runner', 'Run'));
    assert('existence lookup stops after the first match', resolvedCandidates === 1);

    const all = (await idx.findInterfaces('Runner', 'Run')).map((r) => r.name).sort();
    assert('full goto-interface query still returns every match', all.join(',') === 'First,Second');
    idx.dispose();
}

// Regression: "goto interface" from an implementation must find an interface
// that lives in ANOTHER workspace package, even though the implementation
// qualifies the interface's type (`processengine.FlowContext`) while the
// interface declares it bare (`FlowContext`). Previously in-workspace interfaces
// were compared strictly only, so this cross-package pair was never linked.
async function gotoInterfaceCrossPackage() {
    const fs = require('fs');
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goto-xpkg-'));
    const root = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(root, 'penalty'), { recursive: true });

    fs.writeFileSync(
        path.join(root, 'iface.go'),
        ['package processengine', 'type FlowContext struct{}', 'type Action interface { ExecuteAction(context *FlowContext) }'].join('\n')
    );
    fs.writeFileSync(
        path.join(root, 'penalty', 'p.go'),
        [
            'package penalty',
            'import "x/processengine"',
            'type PenaltyPushBackboneActionV2 struct{}',
            'func (action *PenaltyPushBackboneActionV2) ExecuteAction(context *processengine.FlowContext) {}',
        ].join('\n')
    );
    // A different-package interface whose type is a DIFFERENT package's same-named
    // type must NOT be linked (guards against a false positive).
    fs.writeFileSync(
        path.join(root, 'other.go'),
        ['package other', 'type Doer interface { ExecuteAction(context *unrelated.FlowContext) }'].join('\n')
    );

    const localCfg = () => ({
        excludedFolders: ['vendor'],
        excludedFilePatterns: [],
        excludedTypePatterns: [],
        searchDependencies: false,
    });
    const idx = new WorkspaceIndex(localCfg, () => {});
    await idx.ensureBuilt(root);

    console.log('\n== goto interface finds a cross-package (in-workspace) interface ==');
    const ifaces = (await idx.findInterfaces('PenaltyPushBackboneActionV2', 'ExecuteAction')).map((r) => r.name).sort();
    console.log('  got:', ifaces);
    assert('finds Action in another package (bare vs qualified type)', ifaces.includes('Action'));
    assert('does NOT link Doer (different-package type in same slot)', !ifaces.includes('Doer'));

    idx.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
}

// Regression: types that share a bare name but live in different packages must
// each be reported independently.
async function sameNameDifferentPackages() {
    const fs = require('fs');
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samename-'));
    const root = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(root, 'a'), { recursive: true });
    fs.mkdirSync(path.join(root, 'b'), { recursive: true });

    fs.writeFileSync(
        path.join(root, 'iface.go'),
        ['package engine', 'type FlowContext struct{}', 'type Action interface { ExecuteAction(ctx *FlowContext) }'].join('\n')
    );
    fs.writeFileSync(
        path.join(root, 'a', 'h.go'),
        [
            'package a',
            'import "x/engine"',
            'type Handler struct{}',
            'func (h *Handler) ExecuteAction(ctx *engine.FlowContext) {}',
        ].join('\n')
    );
    fs.writeFileSync(
        path.join(root, 'b', 'h.go'),
        [
            'package b',
            'import "x/engine"',
            'type Handler struct{}',
            'func (h *Handler) ExecuteAction(ctx *engine.FlowContext) {}',
        ].join('\n')
    );

    const localCfg = () => ({
        excludedFolders: ['vendor'],
        excludedFilePatterns: [],
        excludedTypePatterns: [],
        searchDependencies: false,
    });
    const idx = new WorkspaceIndex(localCfg, () => {});
    await idx.ensureBuilt(root);

    console.log('\n== same-named types in different packages are each counted ==');
    const impls = idx.findImplementations('Action');
    const files = impls.map((r) => r.file).sort();
    console.log('  got:', impls.length, 'impls');
    assert('two Handler implementations reported (one per package)', impls.length === 2);
    assert('both distinct files present', files.some((f) => f.endsWith(path.join('a', 'h.go'))) && files.some((f) => f.endsWith(path.join('b', 'h.go'))));

    const methodImpls = idx.findMethodImplementations('Action', 'ExecuteAction');
    assert('method search also reports both', methodImpls.length === 2);

    idx.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
}

// The editor command supplies the interface's source file, so two packages may
// safely declare different interfaces with the same bare name. Their method sets
// must never be unioned into a synthetic interface requiring both methods.
async function sameNameInterfacesStayPackageScoped() {
    const idx = new WorkspaceIndex(cfg, () => {});
    const aFile = '/synthetic/a/service.go';
    const bFile = '/synthetic/b/service.go';
    idx.files.set(
        aFile,
        parseFile(
            [
                'package a',
                'type Service interface { A() }',
                'type ImplA struct{}',
                'func (ImplA) A() {}',
            ].join('\n')
        )
    );
    idx.files.set(
        bFile,
        parseFile(
            [
                'package b',
                'type Service interface { B() }',
                'type ImplB struct{}',
                'func (ImplB) B() {}',
            ].join('\n')
        )
    );

    console.log('\n== same-named interfaces remain package-scoped ==');
    const aImpls = idx.findImplementations('Service', aFile);
    const bImpls = idx.findImplementations('Service', bFile);
    assert('a.Service finds only ImplA', aImpls.length === 1 && aImpls[0].name === 'ImplA');
    assert('b.Service finds only ImplB', bImpls.length === 1 && bImpls[0].name === 'ImplB');

    const aMethods = idx.findMethodImplementations('Service', 'A', aFile);
    assert('method lookup uses the selected interface package', aMethods.length === 1 && aMethods[0].name === 'ImplA');

    const fromA = await idx.findInterfaces('ImplA', 'A', { receiverFile: aFile });
    assert('reverse lookup keeps receiver identity package-scoped', fromA.length === 1 && fromA[0].file === aFile);
    idx.dispose();
}

// Same-named receiver types in different packages may declare incompatible
// signatures. One package's method must not overwrite the other's method in the
// merged index and hide a valid implementation.
async function sameNameTypesKeepIndependentSignatures() {
    const idx = new WorkspaceIndex(cfg, () => {});
    const ifaceFile = '/synthetic/contracts/iface.go';
    const goodFile = '/synthetic/a/handler.go';
    const wrongFile = '/synthetic/b/handler.go';
    idx.files.set(ifaceFile, parseFile('package contracts\ntype IntHandler interface { Handle(int) }'));
    idx.files.set(
        goodFile,
        parseFile('package a\ntype Handler struct{}\nfunc (Handler) Handle(v int) {}')
    );
    idx.files.set(
        wrongFile,
        parseFile('package b\ntype Handler struct{}\nfunc (Handler) Handle(v string) {}')
    );

    console.log('\n== same-named types retain package-specific signatures ==');
    const impls = idx.findImplementations('IntHandler', ifaceFile);
    assert('valid a.Handler is not overwritten by b.Handler', impls.length === 1 && impls[0].file === goodFile);

    const methods = idx.findMethodImplementations('IntHandler', 'Handle', ifaceFile);
    assert('method lookup excludes the incompatible same-named type', methods.length === 1 && methods[0].file === goodFile);
    idx.dispose();
}

// Unqualified embeds resolve in the declaration's own package. Package-aware
// symbol keys must preserve method promotion without borrowing a same-named
// Parent/Base from a neighbouring package.
async function packageScopedEmbedsResolveLocally() {
    const idx = new WorkspaceIndex(cfg, () => {});
    const aFile = '/synthetic/a/embed.go';
    const bFile = '/synthetic/b/embed.go';
    idx.files.set(
        aFile,
        parseFile(
            [
                'package a',
                'type Parent interface { A() }',
                'type Service interface { Parent; B() }',
                'type Base struct{}',
                'func (Base) A() {}',
                'type Impl struct { Base }',
                'func (Impl) B() {}',
            ].join('\n')
        )
    );
    idx.files.set(
        bFile,
        parseFile(
            [
                'package b',
                'type Parent interface { X() }',
                'type Base struct{}',
                'func (Base) X() {}',
                'type Impl struct { Base }',
                'func (Impl) B() {}',
            ].join('\n')
        )
    );

    console.log('\n== package-local embeds remain isolated ==');
    const impls = idx.findImplementations('Service', aFile);
    assert('a.Impl promotes a.Base.A and satisfies a.Service', impls.length === 1 && impls[0].file === aFile);
    idx.dispose();
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
