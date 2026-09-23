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

const { SourceSearchService, createMatcher, matchTextLines, resolveSourceRoots } = require('../src/source-search');
const { eq, assert, done } = require('./harness');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-interface-source-search-'));
const workspace = path.join(tmp, 'workspace');
const modCache = path.join(tmp, 'mod');
const dependency = path.join(modCache, 'github.com', 'acme', 'client@v1.2.0');
fs.mkdirSync(path.join(workspace, 'pkg'), { recursive: true });
fs.mkdirSync(dependency, { recursive: true });
fs.writeFileSync(
    path.join(workspace, 'go.mod'),
    'module example.com/app\n\nrequire github.com/acme/client v1.2.0\n'
);
fs.writeFileSync(
    path.join(workspace, 'pkg', 'service.go'),
    'package pkg\n\nfunc Run() {\n\tclient.Call()\n}\n'
);
fs.writeFileSync(path.join(workspace, 'go.sum'), 'github.com/acme/client v1.2.0 h1:test\n');
fs.writeFileSync(
    path.join(dependency, 'client.go'),
    'package client\n\nfunc Call() {}\n'
);

console.log('== source search helpers ==');
eq('literal matcher is case insensitive by default', matchTextLines('One one', createMatcher('one', {}))[0].ranges.length, 2);
eq('whole word matcher excludes a larger identifier', matchTextLines('Run Runner', createMatcher('Run', { wholeWord: true })).length, 1);
assert('regex matcher reports the matched range', matchTextLines('abc123', createMatcher('\\d+', { regex: true }))[0].ranges[0].text === '123');

console.log('== source root resolution ==');
const roots = resolveSourceRoots({
    workspaceRoots: [workspace],
    scope: 'all',
    config: { searchDependencies: true, goModCache: modCache },
});
assert('includes workspace root', roots.some((root) => root.root === workspace && root.scope === 'workspace'));
assert('includes the exact locked dependency version', roots.some((root) => root.root === dependency && root.scope === 'dependency'));
const noModuleWorkspace = path.join(tmp, 'no-module-workspace');
fs.mkdirSync(noModuleWorkspace, { recursive: true });
const explicitRoots = resolveSourceRoots({
    workspaceRoots: [noModuleWorkspace],
    scope: 'dependency',
    config: { searchDependencies: true, goModCache: modCache },
});
assert('explicit module cache is searchable without a go.mod', explicitRoots.some((root) => root.root === modCache));

console.log('== rg-backed search ==');
const service = new SourceSearchService({
    getConfig: () => ({
        searchDependencies: true,
        goModCache: modCache,
        excludedFolders: ['vendor'],
        excludedFilePatterns: [],
    }),
    getWorkspaceRoots: () => [workspace],
    getOpenDocuments: () => [],
});

service
    .search({ query: 'client', scope: 'all' })
    .then((result) => {
        eq('search finds workspace and dependency files', result.totalFiles, 4);
        assert('workspace source result is tagged as workspace', result.results.some((item) => item.scope === 'workspace'));
        assert('dependency source result is tagged as dependency', result.results.some((item) => item.scope === 'dependency'));
        assert('result includes one-based line information', result.results.every((item) => item.matches[0].line >= 1));

        return service.search({
            query: 'CALL',
            scope: 'workspace',
            caseSensitive: true,
            getOpenDocuments: undefined,
        });
    })
    .then((result) => {
        eq('case-sensitive workspace search can return no match', result.totalMatches, 0);
        fs.rmSync(tmp, { recursive: true, force: true });
        done();
    })
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
