'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { assert, eq, done } = require('./harness');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === 'vscode' ? path.join(__dirname, 'vscode-stub.js') : originalResolve.call(this, request, ...rest);
};
const { SourceSearchService, runRipgrepJson } = require('../src/source-search');
const vscode = require('vscode');
Module._resolveFilename = originalResolve;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-source-freshness-'));
const workspace = path.join(tmp, 'workspace');
const modCache = path.join(tmp, 'mod');
const dep1 = path.join(modCache, 'example.com', 'lib@v1.0.0');
const dep2 = path.join(modCache, 'example.com', 'lib@v2.0.0');
const local = path.join(tmp, 'local');
const stdlib = path.join(tmp, 'stdlib');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const hasFile = (result, file) => result.results.some((entry) => entry.file === file);
const scans = [];
let documents = [];
let watchers = 0;
const originalWatch = vscode.workspace.createFileSystemWatcher;
vscode.workspace.createFileSystemWatcher = () => { watchers++; throw new Error('source search must not register watchers'); };
const service = new SourceSearchService({
    getWorkspaceRoots: () => [workspace],
    getConfig: () => ({ goModCache: modCache }),
    getOpenDocuments: () => documents,
    runRipgrep: (...args) => { scans.push(args[1]); return runRipgrepJson(...args); },
});
const search = (query = 'needle', options = {}) => service.search({ query, scope: 'workspace', ...options });

async function run() {
    console.log('== live file changes without inventory events ==');
    const small = path.join(workspace, 'pkg', 'small.go');
    const ignored = path.join(workspace, 'ignored', 'skip.go');
    const added = path.join(workspace, 'pkg', '中文 with\nnewline.go');
    const ignoreFile = path.join(workspace, '.ignore');
    write(path.join(workspace, 'go.mod'), 'module example.com/app\nrequire example.com/lib v1.0.0\n');
    write(small, 'needle one\nother\n');
    write(ignored, 'needle ignored\n');
    write(ignoreFile, 'ignored/\n');
    const first = await search();
    eq('first direct search honors ignore rules', first.totalMatches, 1);
    eq('one workspace starts one content scan', scans.length, 1);
    eq('search starts at the root, without enumerating candidate paths', scans[0].slice(scans[0].indexOf('--') + 1), [workspace]);
    eq('changing the keyword reads current content', (await search('other')).totalMatches, 1);
    write(small, 'needle changed\n' + '// padding\n'.repeat(200));
    write(added, 'needle new\n');
    const expanded = await search();
    assert('new Unicode, space and newline paths are discovered', hasFile(expanded, added));
    eq('edits are visible without save or watcher events', expanded.results.find((entry) => entry.file === small).matches[0].text, 'needle changed');
    fs.unlinkSync(added);
    assert('removed files disappear on the next query', !hasFile(await search(), added));

    const oldDirectory = path.join(workspace, 'old');
    const newDirectory = path.join(workspace, 'renamed');
    write(path.join(oldDirectory, 'nested', 'a.go'), 'needle moved');
    await search();
    fs.renameSync(oldDirectory, newDirectory);
    const moved = await search();
    assert('directory renames discover new descendants', hasFile(moved, path.join(newDirectory, 'nested', 'a.go')));
    assert('directory renames remove old descendants', moved.results.every((entry) => !entry.file.startsWith(oldDirectory + path.sep)));
    fs.rmSync(newDirectory, { recursive: true });
    assert('deleted directory descendants disappear', (await search()).results.every((entry) => !entry.file.startsWith(newDirectory + path.sep)));
    write(ignoreFile, '');
    assert('ignore edits can reveal files immediately', hasFile(await search(), ignored));
    write(ignoreFile, 'ignored/\n');
    assert('ignore edits can hide files immediately', !hasFile(await search(), ignored));

    console.log('\n== query filters and unsaved text ==');
    documents = [{ uri: { fsPath: small }, isDirty: true, getText: () => 'needle unsaved\n' }];
    const overlay = await search();
    eq('unsaved text replaces on-disk matches', overlay.results.find((entry) => entry.file === small).matches.map((item) => item.text), ['needle unsaved']);
    assert('unsaved results keep their label', overlay.results.find((entry) => entry.file === small).unsaved);
    documents = [];
    eq('closing an unsaved document restores disk content', (await search()).results.find((entry) => entry.file === small).matches[0].text, 'needle changed');
    const textFile = path.join(workspace, 'notes.txt');
    write(textFile, 'needle text');
    eq('custom include globs take effect in the next scan', (await search('needle', { includeGlobs: ['*.txt'] })).results.map((entry) => entry.file), [textFile]);
    assert('file exclusions take effect in the next scan', !hasFile(await search('needle', { config: { sourceSearchExcludedFilePatterns: ['small.go'] } }), small));
    const excluded = path.join(workspace, 'pkg', 'blocked', 'a.go');
    write(excluded, 'needle excluded');
    assert('folder path exclusions still filter direct scan output', !hasFile(await search('needle', { config: { sourceSearchExcludedFolders: ['pkg/blocked'] } }), excluded));
    eq('case-sensitive options reach rg', (await search('NEEDLE', { caseSensitive: true })).totalMatches, 0);
    write(small, 'needle needleExtra\n');
    eq('whole-word options reach rg', (await search('needle', { wholeWord: true })).results.find((entry) => entry.file === small).matches[0].ranges.length, 1);
    eq('regex options reach rg', (await search('needleE\\w+', { regex: true })).results.find((entry) => entry.file === small).matches[0].ranges[0].text, 'needleExtra');

    console.log('\n== locked dependencies, local replaces and standard library ==');
    write(path.join(dep1, 'lib.go'), 'needle old version');
    write(path.join(dep2, 'lib.go'), 'needle new version');
    const locked1 = await search('needle', { scope: 'all' });
    assert('only the locked dependency version is searched', hasFile(locked1, path.join(dep1, 'lib.go')) && !hasFile(locked1, path.join(dep2, 'lib.go')));
    const dependencyAdded = path.join(dep1, 'new', 'added.go');
    write(dependencyAdded, 'needle added dependency');
    write(path.join(dep1, 'lib.go'), 'needle edited dependency');
    const changed = await search('needle', { scope: 'dependency' });
    assert('dependency additions appear without watchers', hasFile(changed, dependencyAdded));
    eq('dependency edits appear without watchers', changed.results.find((entry) => entry.file === path.join(dep1, 'lib.go')).matches[0].text, 'needle edited dependency');
    write(path.join(dep1, '.ignore'), 'new/\n');
    assert('dependency ignore changes apply immediately', !hasFile(await search('needle', { scope: 'dependency' }), dependencyAdded));
    write(path.join(dep1, '.ignore'), '');
    assert('dependency files can be unignored immediately', hasFile(await search('needle', { scope: 'dependency' }), dependencyAdded));
    fs.unlinkSync(dependencyAdded);
    assert('dependency deletions disappear immediately', !hasFile(await search('needle', { scope: 'dependency' }), dependencyAdded));
    write(path.join(workspace, 'go.mod'), 'module example.com/app\nrequire example.com/lib v2.0.0\n');
    const locked2 = await search('needle', { scope: 'all' });
    assert('go.mod version changes update search roots', hasFile(locked2, path.join(dep2, 'lib.go')) && !hasFile(locked2, path.join(dep1, 'lib.go')));
    write(path.join(local, 'local.go'), 'needle local replace');
    write(path.join(workspace, 'go.mod'), 'module example.com/app\nrequire example.com/lib v2.0.0\nreplace example.com/lib => ../local\n');
    assert('external local replacements are searched', hasFile(await search('needle', { scope: 'dependency' }), path.join(local, 'local.go')));
    write(path.join(local, 'added.go'), 'needle new local');
    assert('new local replacement sources appear without events', hasFile(await search('needle', { scope: 'dependency' }), path.join(local, 'added.go')));
    const noModule = path.join(tmp, 'no-module');
    fs.mkdirSync(noModule);
    assert('an explicitly configured module cache remains searchable without go.mod', hasFile(await search('needle', { scope: 'dependency', workspaceRoots: [noModule] }), path.join(dep2, 'lib.go')));
    scans.length = 0;
    await search('needle', { scope: 'all', maxResults: 1 });
    eq('reaching the workspace cap starts no dependency scan', scans.length, 1);
    write(path.join(stdlib, 'fmt', 'print.go'), 'needle standard library');
    assert('standard-library scopes search GOROOT directly', hasFile(await search('needle', { scope: 'stdlib', stdlibRoot: stdlib }), path.join(stdlib, 'fmt', 'print.go')));
    write(path.join(stdlib, 'fmt', 'new.go'), 'needle new standard library file');
    assert('standard-library additions appear without events', hasFile(await search('needle', { scope: 'stdlib', stdlibRoot: stdlib }), path.join(stdlib, 'fmt', 'new.go')));
    eq('source searches never register file-system watchers', watchers, 0);
}

run().then(done).catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
    service.dispose();
    vscode.workspace.createFileSystemWatcher = originalWatch;
    fs.rmSync(tmp, { recursive: true, force: true });
});
