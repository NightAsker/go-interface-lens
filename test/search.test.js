'use strict';

const path = require('path');

// Redirect `require('vscode')` to the headless stub so we can drive
// resolveSearchRoots with simulated workspace configurations.
const Module = require('module');
const origResolve = Module._resolveFilename;
const stubPath = path.join(__dirname, 'vscode-stub.js');
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return stubPath;
    return origResolve.call(this, request, ...rest);
};

const vscode = require(stubPath);
const {
    resolveSearchRoots,
    splitSearchTargets,
    resolveRipgrepProcessConcurrency,
    createConcurrencyGate,
} = require(path.join(__dirname, '..', 'src', 'search'));
const { eq, assert, done } = require(path.join(__dirname, 'harness'));

const uri = (p) => ({ fsPath: p });

console.log('== resolveSearchRoots ==');

// Case 1: dependency file OUTSIDE workspace, project open as a workspace folder.
// The interface lives in a dep package; implementations live in the project.
vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/home/me/project' } }];
vscode.workspace.getWorkspaceFolder = () => undefined; // dep file not in workspace
{
    const roots = resolveSearchRoots(uri('/go/pkg/mod/dep@v1/iface.go')).sort();
    console.log('  got:', roots);
    assert('includes project workspace root', roots.includes('/home/me/project'));
    assert("includes dependency file's own dir", roots.includes('/go/pkg/mod/dep@v1'));
}

// Case 2: file inside the workspace -> just the workspace folders.
vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/home/me/project' } }];
vscode.workspace.getWorkspaceFolder = () => ({ uri: { fsPath: '/home/me/project' } });
{
    const roots = resolveSearchRoots(uri('/home/me/project/pkg/a.go'));
    console.log('  got:', roots);
    eq('single project root, de-duplicated', roots, ['/home/me/project']);
}

// Case 3: multi-root workspace, dep file outside all of them.
vscode.workspace.workspaceFolders = [
    { uri: { fsPath: '/home/me/svcA' } },
    { uri: { fsPath: '/home/me/svcB' } },
];
vscode.workspace.getWorkspaceFolder = () => undefined;
{
    const roots = resolveSearchRoots(uri('/go/pkg/mod/dep/x.go')).sort();
    console.log('  got:', roots);
    assert('includes svcA', roots.includes('/home/me/svcA'));
    assert('includes svcB', roots.includes('/home/me/svcB'));
    assert('includes dep dir', roots.includes('/go/pkg/mod/dep'));
}

// Case 4: no workspace at all -> fall back to the file's directory.
vscode.workspace.workspaceFolders = undefined;
vscode.workspace.getWorkspaceFolder = () => undefined;
{
    const roots = resolveSearchRoots(uri('/tmp/loose/file.go'));
    console.log('  got:', roots);
    eq('fallback to file dir', roots, ['/tmp/loose']);
}

console.log('\n== ripgrep target sharding ==');

eq('empty target list creates no process group', splitSearchTargets([]), []);
eq('one target keeps a single ripgrep process', splitSearchTargets(['/a']), [['/a']]);
const dependencyTargets = Array.from({ length: 18 }, (_, index) => `/dep-${index}`);
eq(
    'dependency directories are distributed across sixteen ripgrep processes',
    splitSearchTargets(dependencyTargets, 16),
    [
        ['/dep-0', '/dep-16'],
        ['/dep-1', '/dep-17'],
        ...Array.from({ length: 14 }, (_, index) => [`/dep-${index + 2}`]),
    ]
);
eq(
    'an explicit lower process ceiling remains supported',
    splitSearchTargets(['/a', '/b', '/c'], 2),
    [['/a', '/c'], ['/b']]
);
eq('ripgrep concurrency follows available CPUs', resolveRipgrepProcessConcurrency(12), 12);
eq('ripgrep concurrency is capped at sixteen', resolveRipgrepProcessConcurrency(64), 16);

async function testSharedConcurrencyGate() {
    const gate = createConcurrencyGate(3);
    let active = 0;
    let peak = 0;
    await Promise.all(
        Array.from({ length: 12 }, () =>
            gate(async () => {
                active++;
                peak = Math.max(peak, active);
                await new Promise((resolve) => setImmediate(resolve));
                active--;
            })
        )
    );
    eq('shared process gate enforces its global ceiling', peak, 3);
}

testSharedConcurrencyGate()
    .then(done)
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
