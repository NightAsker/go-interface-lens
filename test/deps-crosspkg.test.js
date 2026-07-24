'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const Module = require('module');
const origResolve = Module._resolveFilename;
const stubPath = path.join(__dirname, 'vscode-stub.js');
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return stubPath;
    return origResolve.call(this, request, ...rest);
};

const { WorkspaceIndex } = require(path.join(__dirname, '..', 'src', 'indexer'));
const { stripPackageQualifiers } = require(path.join(__dirname, '..', 'src', 'signatures'));
const { assert, eq, done } = require(path.join(__dirname, 'harness'));

console.log('== stripPackageQualifiers ==');
eq(
    'qualified type stripped to match local type',
    stripPackageQualifiers('(@{context}.Context)(acme.Result,error)'),
    stripPackageQualifiers('(@{context}.Context)(Result,error)')
);
eq('plain type unchanged', stripPackageQualifiers('(int)(string)'), '(int)(string)');

async function main() {
    // Real-world scenario: implementation in the project references the
    // interface's return type with a package qualifier (dep.Result), while the
    // dependency interface declares it as the package-local `Result`.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xpkg-test-'));
    const proj = path.join(tmp, 'proj');
    const cache = path.join(tmp, 'cache');

    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(
        path.join(proj, 'go.mod'),
        ['module example.com/proj', 'go 1.21', 'require github.com/acme/iface v1.3.0'].join('\n')
    );
    const execFile = path.join(proj, 'exec.go');
    fs.writeFileSync(
        execFile,
        [
            'package impl',
            'import "context"',
            'type Exec struct{}',
            'func (e *Exec) Execute(ctx context.Context, code string) (acme.Result, error) { return acme.Result{}, nil }',
            'func (e *Exec) Code() string { return "" }',
        ].join('\n')
    );

    const dir = path.join(cache, 'github.com', 'acme', 'iface@v1.3.0');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'action.go'),
        [
            'package iface',
            'import "context"',
            'type IActionExecutorWithCode interface {',
            '\tExecute(ctx context.Context, code string) (Result, error)',
            '\tCode() string',
            '}',
        ].join('\n')
    );

    const cfg = () => ({
        excludedFolders: ['vendor'],
        excludedFilePatterns: [],
        excludedTypePatterns: [],
        searchDependencies: true,
        goModCache: cache,
    });

    const idx = new WorkspaceIndex(cfg, () => {});
    await idx.ensureBuilt(proj);

    console.log('\n== goto interface across package boundary (qualifier mismatch) ==');
    const found = await idx.findInterfacesAst('Exec', 'Execute', { receiverFile: execFile });
    console.log('  got:', found.map((r) => r.name));
    assert(
        'finds dependency interface despite Result vs acme.Result',
        found.some((r) => r.name === 'IActionExecutorWithCode' && r.external === true)
    );

    idx.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });

    await crossPkgImplementations();
    await looseNotShadowedByStrict();
    done();
}

// Regression: a same-package implementation (matches strictly) must NOT hide a
// cross-package implementation (matches only loosely). Previously the loose pass
// ran only when the strict pass found nothing, so the cross-package `Exporter`
// was silently dropped whenever the same-package `Runner` matched.
async function looseNotShadowedByStrict() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-test-'));
    const eng = path.join(tmp, 'engine');
    const exp = path.join(tmp, 'export');
    fs.mkdirSync(eng, { recursive: true });
    fs.mkdirSync(exp, { recursive: true });

    // Interface + a same-package implementation using the bare type name.
    const interfaceFile = path.join(eng, 'engine.go');
    fs.writeFileSync(
        interfaceFile,
        [
            'package processengine',
            'type FlowContext struct{}',
            'type Action interface {',
            '\tExecuteAction(context *FlowContext)',
            '}',
            'type Runner struct{}',
            'func (r *Runner) ExecuteAction(context *FlowContext) {}',
        ].join('\n')
    );
    // Cross-package implementation qualifying the type (processengine.FlowContext).
    fs.writeFileSync(
        path.join(exp, 'export.go'),
        [
            'package process_export',
            'import "example.com/proj/engine/processengine"',
            'type Exporter struct{}',
            'func (e *Exporter) ExecuteAction(context *processengine.FlowContext) {}',
        ].join('\n')
    );

    const cfg = () => ({
        excludedFolders: ['vendor'],
        excludedFilePatterns: [],
        excludedTypePatterns: [],
        searchDependencies: false,
        goModCache: '',
    });
    const idx = new WorkspaceIndex(cfg, () => {});
    await idx.ensureBuilt(eng);
    await idx.ensureBuilt(exp);

    console.log('\n== loose (cross-package) impl is not shadowed by a strict (same-package) impl ==');
    const impls = (await idx.findImplementationsAst('Action', interfaceFile))
        .map((r) => r.name)
        .sort();
    console.log('  got:', impls);
    assert('same-package *Runner is found (strict)', impls.includes('*Runner'));
    assert('cross-package *Exporter is found (loose, not shadowed)', impls.includes('*Exporter'));

    const methodImpls = (
        await idx.findMethodImplementationsAst('Action', 'ExecuteAction', interfaceFile)
    )
        .map((r) => r.name)
        .sort();
    console.log('  method impls:', methodImpls);
    assert('method search finds *Runner', methodImpls.includes('*Runner'));
    assert('method search finds *Exporter (not shadowed)', methodImpls.includes('*Exporter'));

    idx.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
}

// Reverse direction: interface in a dependency dir (unqualified `Result`),
// implementation in the workspace (qualified `acme.Result`). findImplementations
// must still discover the implementation via loose (qualifier-insensitive)
// fallback, without falsely matching unrelated types.
async function crossPkgImplementations() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xpkg-impl-'));
    const proj = path.join(tmp, 'proj');
    const dep = path.join(tmp, 'dep');
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(dep, { recursive: true });

    const interfaceFile = path.join(dep, 'iface.go');
    fs.writeFileSync(
        interfaceFile,
        [
            'package acme',
            'import "context"',
            'type IActionExecutorWithCode interface {',
            '\tExecute(ctx context.Context, code string) (Result, error)',
            '\tCode() string',
            '}',
        ].join('\n')
    );
    fs.writeFileSync(
        path.join(proj, 'exec.go'),
        [
            'package impl',
            'import "context"',
            'type Exec struct{}',
            'func (e *Exec) Execute(ctx context.Context, code string) (acme.Result, error) { return acme.Result{}, nil }',
            'func (e *Exec) Code() string { return "" }',
        ].join('\n')
    );
    fs.writeFileSync(
        path.join(proj, 'other.go'),
        [
            'package impl',
            'type Unrelated struct{}',
            // Same method name, different arity — must NOT match even loosely.
            'func (u *Unrelated) Execute() {}',
        ].join('\n')
    );
    // Two DIFFERENT packages qualify a same-named type in the SAME slot: this is
    // the false positive that package-aware loose matching now rejects. The
    // interface here qualifies its result as `acme.Result`; a type returning
    // `other.Result` must NOT match it (a blind qualifier strip would wrongly
    // treat `acme.Result` and `other.Result` as identical).
    fs.writeFileSync(
        path.join(proj, 'wrongpkg.go'),
        [
            'package impl',
            'import "context"',
            'type WrongPkg struct{}',
            'func (w *WrongPkg) Do(ctx context.Context) (other.Result, error) { return other.Result{}, nil }',
        ].join('\n')
    );
    const doerFile = path.join(dep, 'iface2.go');
    fs.writeFileSync(
        doerFile,
        [
            'package acme',
            'import "context"',
            // Interface qualifies the SAME slot with a THIRD-party package
            // (`models.Result`), distinct from the implementation's
            // `other.Result`. Neither qualifier is the file's own package, so
            // self-qualifier stripping does not apply and package-aware loose
            // matching must reject the mismatch.
            'type Doer interface {',
            '\tDo(ctx context.Context) (models.Result, error)',
            '}',
        ].join('\n')
    );

    const cfg = () => ({
        excludedFolders: ['vendor'],
        excludedFilePatterns: [],
        excludedTypePatterns: [],
        searchDependencies: true,
        goModCache: '',
    });
    const idx = new WorkspaceIndex(cfg, () => {});
    await idx.ensureBuilt(proj);
    await idx.ensureBuilt(dep);

    console.log('\n== find implementations across package boundary ==');
    const impls = (await idx.findImplementationsAst('IActionExecutorWithCode', interfaceFile))
        .map((r) => r.name)
        .sort();
    console.log('  got:', impls);
    assert('finds *Exec despite Result vs acme.Result', impls.includes('*Exec'));
    assert('does NOT falsely match Unrelated', !impls.some((name) => name.endsWith('Unrelated')));

    console.log('\n== find METHOD implementations across package boundary ==');
    const methodImpls = (
        await idx.findMethodImplementationsAst(
            'IActionExecutorWithCode',
            'Execute',
            interfaceFile
        )
    )
        .map((r) => r.name)
        .sort();
    console.log('  got:', methodImpls);
    assert('finds *Exec.Execute despite Result vs acme.Result', methodImpls.includes('*Exec'));
    assert(
        'method search does NOT falsely match Unrelated',
        !methodImpls.some((name) => name.endsWith('Unrelated'))
    );

    console.log('\n== same-slot DIFFERENT-package types are not confused (no false positive) ==');
    const doers = (await idx.findImplementationsAst('Doer', doerFile))
        .map((r) => r.name)
        .sort();
    console.log('  got:', doers);
    assert(
        'WrongPkg (other.Result) does NOT match Doer (acme.Result)',
        !doers.some((name) => name.endsWith('WrongPkg'))
    );

    idx.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
