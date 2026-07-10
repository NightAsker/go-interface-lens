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
const { assert, eq, done } = require(path.join(__dirname, 'harness'));

function writeGo(dir, file, contents) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), contents);
}

async function main() {
    // Build a temp project whose go.mod locks iface@v1.3.0, and a fake module
    // cache containing BOTH v1.2.0 and v1.3.0 of the same interface.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-ver-'));
    const proj = path.join(tmp, 'proj');
    const cache = path.join(tmp, 'modcache');

    // Project: go.mod + an implementation of the interface.
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(
        path.join(proj, 'go.mod'),
        ['module example.com/proj', 'go 1.21', 'require github.com/acme/iface v1.3.0'].join('\n')
    );
    writeGo(
        proj,
        'executor.go',
        [
            'package impl',
            'import "context"',
            'type ProjectExecutor struct{}',
            'func (e *ProjectExecutor) Execute(ctx context.Context, code string) (string, error) { return "", nil }',
            'func (e *ProjectExecutor) Code() string { return "" }',
        ].join('\n')
    );

    // Cache: v1.2.0 (STALE) and v1.3.0 (LOCKED) both declare the interface, on
    // different declaration lines so we can tell which file was returned.
    const ifaceBody = (extraLeadingLines) =>
        [
            ...extraLeadingLines,
            'package iface',
            'import "context"',
            'type IActionExecutorWithCode interface {',
            '\tExecute(ctx context.Context, code string) (string, error)',
            '\tCode() string',
            '}',
        ].join('\n');

    const v12dir = path.join(cache, 'github.com', 'acme', 'iface@v1.2.0');
    const v13dir = path.join(cache, 'github.com', 'acme', 'iface@v1.3.0');
    writeGo(v12dir, 'action.go', ifaceBody(['// v1.2.0 STALE VERSION - should NOT be returned']));
    writeGo(v13dir, 'action.go', ifaceBody([]));

    const cfg = () => ({
        excludedFolders: ['mocks', 'mock', 'testdata', 'vendor'],
        excludedFilePatterns: ['_mock.go', 'mock_', '.pb.go', '_test.go'],
        excludedTypePatterns: ['Mock', 'mock', 'Stub', 'Fake'],
        searchDependencies: true,
        goModCache: cache,
    });

    const idx = new WorkspaceIndex(cfg, () => {});
    await idx.ensureBuilt(proj);

    console.log('== only go.mod-locked version is returned ==');
    const found = await idx.findInterfaces('ProjectExecutor', 'Execute');
    console.log(
        '  got files:',
        found.map((r) => r.file.replace(cache + path.sep, ''))
    );
    assert('finds the interface', found.length >= 1);
    assert(
        'result comes from LOCKED v1.3.0',
        found.some((r) => r.file.startsWith(v13dir))
    );
    assert(
        'STALE v1.2.0 is NOT returned',
        !found.some((r) => r.file.startsWith(v12dir))
    );
    eq('exactly one result (no version duplication)', found.length, 1);

    idx.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
