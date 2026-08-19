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

function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

function moduleDir(cacheRoot, importPath, version) {
    return path.join(cacheRoot, ...`${importPath}@${version}`.split('/'));
}

async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-interface-package-exclusions-'));
    const project = path.join(tmp, 'project');
    const cacheRoot = path.join(tmp, 'modcache');
    const cacheDir = path.join(tmp, 'cache');
    const overpassDir = moduleDir(cacheRoot, 'code.byted.org/overpass', 'v1.0.0');
    const keepDir = moduleDir(cacheRoot, 'code.byted.org/keep', 'v1.0.0');
    const bundleDir = moduleDir(cacheRoot, 'code.byted.org/bundle', 'v1.0.0');

    write(
        path.join(project, 'go.mod'),
        [
            'module example.com/project',
            'go 1.22',
            'require (',
            '  code.byted.org/overpass v1.0.0',
            '  code.byted.org/keep v1.0.0',
            '  code.byted.org/bundle v1.0.0',
            ')',
        ].join('\n')
    );
    const interfaceFile = path.join(project, 'api', 'action.go');
    write(interfaceFile, 'package api\ntype Action interface { Run() error }\n');

    write(path.join(overpassDir, 'go.mod'), 'module code.byted.org/overpass\ngo 1.22\n');
    write(
        path.join(overpassDir, 'slow.go'),
        'package overpass\ntype Slow struct{}\nfunc (Slow) Run() error { return nil }\n'
    );
    write(path.join(keepDir, 'go.mod'), 'module code.byted.org/keep\ngo 1.22\n');
    const keepFile = path.join(keepDir, 'fast.go');
    write(
        keepFile,
        'package keep\ntype Fast struct{}\nfunc (Fast) Run() error { return nil }\n'
    );
    write(path.join(bundleDir, 'go.mod'), 'module code.byted.org/bundle\ngo 1.22\n');
    const allowedBundleFile = path.join(bundleDir, 'allowed', 'allowed.go');
    const excludedBundleFile = path.join(bundleDir, 'internal', 'generated', 'generated.go');
    write(
        allowedBundleFile,
        'package allowed\ntype Allowed struct{}\nfunc (Allowed) Run() error { return nil }\n'
    );
    write(
        excludedBundleFile,
        'package generated\ntype Generated struct{}\nfunc (Generated) Run() error { return nil }\n'
    );

    const settings = {
        excludedFolders: [],
        excludedFilePatterns: [],
        excludedTypePatterns: [],
        excludedPackagePatterns: [
            'code.byted.org/overpass*',
            'code.byted.org/bundle/internal/*',
            'example.com/?/api',
        ],
        searchDependencies: true,
        goModCache: cacheRoot,
        astConcurrency: 2,
    };
    const index = new WorkspaceIndex(() => settings, () => {}, { cacheDir });
    await index.ensureBuilt(project);

    console.log('== package import-path wildcard matching ==');
    assert('star matches the module itself', index._isPackageExcluded('code.byted.org/overpass'));
    assert(
        'star spans slash-separated subpackages',
        index._isPackageExcluded('code.byted.org/overpass/client/v2')
    );
    assert('unrelated package stays enabled', !index._isPackageExcluded('code.byted.org/keep'));
    assert('question mark matches one character', index._isPackageExcluded('example.com/x/api'));
    assert('question mark does not match two characters', !index._isPackageExcluded('example.com/xy/api'));

    console.log('\n== excluded locked modules never enter dependency rg scans ==');
    const searchDirs = index._dependencySearchDirs(cacheRoot).map(path.normalize).sort();
    assert('excluded module root is removed', !searchDirs.includes(path.normalize(overpassDir)));
    assert('allowed locked module remains', searchDirs.includes(path.normalize(keepDir)));
    assert('partially excluded module remains available for candidate filtering', searchDirs.includes(path.normalize(bundleDir)));

    const candidates = await index._dependencyImplementationCandidates(
        cacheRoot,
        'Run',
        searchDirs
    );
    assert('allowed module candidate remains', candidates.includes(keepFile));
    assert('allowed subpackage candidate remains', candidates.includes(allowedBundleFile));
    assert('excluded module never reaches candidate results', !candidates.some((file) => file.startsWith(overpassDir)));
    assert('excluded subpackage is removed after rg', !candidates.includes(excludedBundleFile));

    console.log('\n== navigation and recursive external loading honor exclusions ==');
    const implementations = await index.findImplementationsAst('Action', interfaceFile);
    assert('allowed dependency implementation is navigable', implementations.some((item) => item.name === 'Fast'));
    assert('excluded dependency implementation is absent', !implementations.some((item) => item.name === 'Slow'));
    assert('excluded dependency subpackage implementation is absent', !implementations.some((item) => item.name === 'Generated'));

    let resolutions = 0;
    index._resolveExternalImportDirectory = async () => {
        resolutions += 1;
        return overpassDir;
    };
    eq(
        'excluded recursive import is rejected before filesystem resolution',
        await index._loadExternalPackage('code.byted.org/overpass/client', 100),
        null
    );
    eq('excluded recursive import performs no resolution work', resolutions, 0);

    console.log('\n== pattern changes invalidate dependency candidate identities ==');
    const oldRequest = index._dependencyImplementationCandidates(cacheRoot, 'Run', searchDirs);
    settings.excludedPackagePatterns = ['code.byted.org/overpass*'];
    const newSearchDirs = index._dependencySearchDirs(cacheRoot);
    const newRequest = index._dependencyImplementationCandidates(cacheRoot, 'Run', newSearchDirs);
    assert('in-memory dependency candidate identity changes with package patterns', oldRequest !== newRequest);
    const unfilteredBundle = await newRequest;
    assert('new configuration can restore a formerly excluded subpackage', unfilteredBundle.includes(excludedBundleFile));

    index.dispose();

    const onlyExcludedProject = path.join(tmp, 'only-excluded');
    write(
        path.join(onlyExcludedProject, 'go.mod'),
        [
            'module example.com/only-excluded',
            'go 1.22',
            'require code.byted.org/overpass v1.0.0',
        ].join('\n')
    );
    write(path.join(onlyExcludedProject, 'main.go'), 'package onlyexcluded\n');
    const onlyExcluded = new WorkspaceIndex(
        () => ({ ...settings, excludedPackagePatterns: ['code.byted.org/overpass*'] }),
        () => {}
    );
    await onlyExcluded.ensureBuilt(onlyExcludedProject);
    eq(
        'all excluded locks stop dependency scanning instead of scanning the whole cache',
        onlyExcluded._dependencySearchDirs(cacheRoot),
        null
    );
    onlyExcluded.dispose();

    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
