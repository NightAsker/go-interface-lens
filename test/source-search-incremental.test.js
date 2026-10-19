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
const { collectSearchFiles } = require('../src/source-search-plan');
const { watchSourceRoots } = require('../src/source-search-inventory');
Module._resolveFilename = originalResolve;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-source-incremental-'));
const services = [];
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
};
async function rejects(promise, code, label) {
    let error;
    try { await promise; } catch (caught) { error = caught; }
    eq(label, error?.code, code);
}
function fixture(root, extra = {}) {
    const listeners = new Set();
    const measured = [];
    const scans = [];
    const watches = [];
    let enumerations = 0;
    const service = new SourceSearchService({
        getWorkspaceRoots: () => [root],
        watchRoots: (roots, listener) => {
            const watch = { roots, disposed: false };
            watches.push(watch);
            listeners.add(listener);
            return { dispose() { watch.disposed = true; listeners.delete(listener); } };
        },
        statFile: (file) => { measured.push(file); return fs.promises.stat(file); },
        collectFiles: (...args) => { enumerations++; return collectSearchFiles(...args); },
        runRipgrep: (...args) => { scans.push(args[1].slice(args[1].indexOf('--') + 1)); return runRipgrepJson(...args); },
        ...extra,
    });
    services.push(service);
    return {
        service, measured, scans, watches,
        get enumerations() { return enumerations; },
        emit(file, type = 'change') { for (const listener of listeners) listener({ file, type }); },
        search(query = 'needle', options = {}, progress = {}) { return service.search({ query, scope: 'workspace', ...options }, progress); },
    };
}
const hasFile = (result, file) => result.results.some((entry) => entry.file === file);

async function run() {
    console.log('== reuse inventories and update only changed metadata ==');
    const root = path.join(tmp, 'workspace');
    const small = path.join(root, 'pkg', 'small.go');
    const large = path.join(root, 'pkg', 'large.go');
    const ignored = path.join(root, 'ignored', 'skip.go');
    const ignoreFile = path.join(root, '.ignore');
    write(small, 'needle one\nother\n');
    write(large, 'needle two\n' + '// padding\n'.repeat(200));
    write(ignored, 'needle ignored\n');
    write(ignoreFile, 'ignored/\n');
    const f = fixture(root);
    const first = await f.search();
    eq('first query measures all eligible files exactly once', f.measured.length, 2);
    eq('first query searches the largest measured file first', f.scans[0], [large]);
    eq('first query honors ignore rules', first.totalMatches, 2);
    const second = await f.search('other');
    eq('changing the keyword reads current file content', second.totalMatches, 1);
    eq('changing the keyword reuses the enumeration', f.enumerations, 1);
    eq('changing the keyword performs no stat calls', f.measured.length, 2);
    await f.search('needle', { caseSensitive: true, wholeWord: true });
    await f.search('needle.*', { regex: true });
    eq('case, whole-word and regex options reuse the file inventory', [f.enumerations, f.measured.length], [1, 2]);

    const before = f.scans.length;
    write(small, 'needle grown\n' + '// changed\n'.repeat(500));
    f.emit(small);
    f.emit(small);
    f.emit(small);
    const grown = await f.search();
    eq('save event bursts stat only the changed file once', f.measured.slice(2), [small]);
    eq('content edits do not enumerate the tree again', f.enumerations, 1);
    eq('updated size immediately changes scheduling priority', f.scans[before], [small]);
    eq('new source text is searched after a save', grown.results.find((entry) => entry.file === small).matches[0].text, 'needle grown');

    console.log('\n== additions, deletions, directory moves and ignore rules ==');
    const added = path.join(root, 'pkg', '中文 with\nnewline.go');
    const ignoredAdded = path.join(root, 'ignored', 'new.go');
    write(added, 'needle new\n');
    write(ignoredAdded, 'needle hidden\n');
    f.emit(added, 'create');
    f.emit(ignoredAdded, 'create');
    let measured = f.measured.length;
    const expanded = await f.search();
    eq('new files trigger one membership refresh', f.enumerations, 2);
    eq('membership refresh reuses all unchanged file sizes', f.measured.slice(measured), [added]);
    assert('new Unicode/newline path is included', hasFile(expanded, added));
    assert('new ignored files never become explicit search targets', !hasFile(expanded, ignoredAdded));
    fs.unlinkSync(added);
    f.emit(added, 'delete');
    measured = f.measured.length;
    const removed = await f.search();
    assert('deleted file is removed from the next query', !hasFile(removed, added));
    eq('deletion needs neither enumeration nor stat', [f.enumerations, f.measured.length], [2, measured]);

    const oldDirectory = path.join(root, 'old');
    const newDirectory = path.join(root, 'renamed');
    write(path.join(oldDirectory, 'a.go'), 'needle a');
    write(path.join(oldDirectory, 'nested', 'b.go'), 'needle b');
    f.emit(oldDirectory, 'create');
    await f.search();
    fs.renameSync(oldDirectory, newDirectory);
    f.emit(oldDirectory, 'delete');
    f.emit(newDirectory, 'create');
    const moved = await f.search();
    assert('directory rename removes all old descendants', moved.results.every((entry) => !entry.file.startsWith(oldDirectory + path.sep)));
    assert('directory rename discovers all new descendants', hasFile(moved, path.join(newDirectory, 'nested', 'b.go')));
    const enumerated = f.enumerations;
    measured = f.measured.length;
    fs.rmSync(newDirectory, { recursive: true });
    f.emit(newDirectory, 'delete');
    const deletedDirectory = await f.search();
    assert('directory deletion drops descendant files', deletedDirectory.results.every((entry) => !entry.file.startsWith(newDirectory + path.sep)));
    eq('directory deletion reuses all other metadata', [f.enumerations, f.measured.length], [enumerated, measured]);

    write(ignoreFile, '');
    f.emit(ignoreFile);
    measured = f.measured.length;
    const unignored = await f.search();
    assert('editing ignore rules discovers previously ignored files', hasFile(unignored, ignored) && hasFile(unignored, ignoredAdded));
    eq('ignore changes stat only newly eligible files', f.measured.slice(measured).sort(), [ignored, ignoredAdded].sort());
    write(ignoreFile, 'ignored/\n');
    f.emit(ignoreFile);
    measured = f.measured.length;
    const reignored = await f.search();
    assert('newly ignored files are excluded from explicit tasks', !hasFile(reignored, ignored));
    eq('hiding files with an ignore rule does not restat other files', f.measured.length, measured);

    console.log('\n== query-specific overlays and invalidation ==');
    f.service.getOpenDocuments = () => [{ uri: { fsPath: small }, isDirty: true, getText: () => 'needle unsaved\n' }];
    const overlay = await f.search();
    assert('dirty content replaces cached disk content', overlay.results.find((entry) => entry.file === small).unsaved);
    f.service.getOpenDocuments = () => [];
    const diskAgain = await f.search();
    eq('closing a dirty document restores its cached disk entry', diskAgain.results.find((entry) => entry.file === small).matches[0].text, 'needle grown');
    const txt = path.join(root, 'notes.txt');
    write(txt, 'needle text');
    const customGlobs = await f.search('needle', { includeGlobs: ['*.txt'] });
    eq('changing include globs rebuilds membership', customGlobs.results.map((entry) => entry.file), [txt]);
    assert('changing globs disposes the previous watcher coverage', f.watches[0].disposed);
    const excluded = await f.search('needle', { config: { sourceSearchExcludedFilePatterns: ['small.go'] } });
    assert('changing source exclusions rebuilds membership', !hasFile(excluded, small) && hasFile(excluded, large));
    const beforeClear = f.enumerations;
    f.service.clearCache();
    await f.search();
    eq('manual cache clearing rebuilds the next inventory', f.enumerations, beforeClear + 1);

    console.log('\n== roots and locked dependency versions ==');
    const workspace = path.join(tmp, 'modules');
    const modCache = path.join(tmp, 'mod');
    const dep1 = path.join(modCache, 'example.com', 'lib@v1.0.0');
    const dep2 = path.join(modCache, 'example.com', 'lib@v2.0.0');
    write(path.join(workspace, 'go.mod'), 'module example.com/app\nrequire example.com/lib v1.0.0\n');
    write(path.join(dep1, 'lib.go'), 'needle old version');
    write(path.join(dep2, 'lib.go'), 'needle new version');
    write(path.join(workspace, 'app.go'), 'needle workspace');
    const workspaceOnly = fixture(workspace, { getConfig: () => ({ goModCache: modCache }) });
    await workspaceOnly.search('needle', { scope: 'all', maxResults: 1 });
    eq('reaching the workspace result cap starts no dependency watcher', workspaceOnly.watches.flatMap((watch) => watch.roots), [workspace]);
    const deps = fixture(workspace, { getConfig: () => ({ goModCache: modCache }) });
    const locked1 = await deps.search('needle', { scope: 'all' });
    assert('first dependency inventory includes the locked version', hasFile(locked1, path.join(dep1, 'lib.go')));
    eq('module versions share one module-cache watcher', deps.watches.flatMap((watch) => watch.roots).sort(), [workspace, modCache].sort());
    const initialEnumerations = deps.enumerations;
    await deps.search('old', { scope: 'all' });
    eq('workspace and dependency inventories both survive keyword changes', deps.enumerations, initialEnumerations);
    write(path.join(workspace, 'go.mod'), 'module example.com/app\nrequire example.com/lib v2.0.0\n');
    deps.emit(path.join(workspace, 'go.mod'));
    const locked2 = await deps.search('needle', { scope: 'all' });
    assert('changed go.mod switches dependency membership immediately', hasFile(locked2, path.join(dep2, 'lib.go')) && !hasFile(locked2, path.join(dep1, 'lib.go')));
    assert('changed roots dispose previous watchers', deps.watches[0].disposed);
    const stdlib = path.join(tmp, 'stdlib');
    write(path.join(stdlib, 'std.go'), 'needle standard library');
    const standard = await deps.search('needle', { scope: 'stdlib', stdlibRoot: stdlib });
    eq('switching scope rebuilds the eligible roots', standard.results.map((entry) => entry.file), [path.join(stdlib, 'std.go')]);
    write(path.join(stdlib, 'std.go'), 'needle updated standard library\n');
    deps.emit(path.join(stdlib, 'std.go'));
    const updatedStandard = await deps.search('updated', { scope: 'stdlib', stdlibRoot: stdlib });
    eq('external roots also receive incremental content changes', updatedStandard.totalMatches, 1);

    console.log('\n== events during metadata reads and failed refreshes ==');
    const racingRoot = path.join(tmp, 'racing');
    const racingFile = path.join(racingRoot, 'service.go');
    write(racingFile, 'needle initial');
    const started = deferred();
    const release = deferred();
    let stats = 0;
    let deny = false;
    let pauseFile;
    let pauseStarted;
    let pauseRelease;
    const racing = fixture(racingRoot, { statFile: async (file) => {
        stats++;
        if (deny) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        const stat = await fs.promises.stat(file);
        if (stats === 1) { started.resolve(); await release.promise; }
        if (file === pauseFile) {
            pauseFile = undefined;
            pauseStarted.resolve();
            await pauseRelease.promise;
        }
        return stat;
    } });
    const inFlight = racing.search();
    await started.promise;
    write(racingFile, 'needle updated\n' + '// larger\n'.repeat(100));
    racing.emit(racingFile);
    release.resolve();
    await inFlight;
    eq('an event during an initial build is applied before scanning', stats, 2);
    const cachedSize = [...racing.service.inventory.state.entries.values()][0].files.get(racingFile).size;
    eq('a newer metadata event cannot be overwritten by an older stat', cachedSize, fs.statSync(racingFile).size);
    deny = true;
    racing.emit(racingFile);
    await rejects(racing.search(), 'EACCES', 'metadata refresh errors propagate');
    deny = false;
    const recovered = await racing.search();
    eq('failed updates stay pending and can be retried', recovered.totalMatches, 1);
    eq('retry does not need a new enumeration', racing.enumerations, 1);

    const addedDuringRefresh = path.join(racingRoot, 'new.go');
    write(addedDuringRefresh, 'needle new');
    pauseFile = addedDuringRefresh;
    pauseStarted = deferred();
    pauseRelease = deferred();
    racing.emit(addedDuringRefresh, 'create');
    const scanCount = racing.scans.length;
    const adding = racing.search();
    await pauseStarted.promise;
    write(addedDuringRefresh, 'needle grown\n' + '// large\n'.repeat(1000));
    racing.emit(addedDuringRefresh);
    pauseRelease.resolve();
    await adding;
    eq('edits to a new file during enumeration update its scheduling size', racing.scans[scanCount], [addedDuringRefresh]);

    console.log('\n== concurrent builds, cancellation and cleanup ==');
    const simultaneousRoot = path.join(tmp, 'simultaneous');
    write(path.join(simultaneousRoot, 'service.go'), 'needle other');
    const buildStarted = deferred();
    const buildRelease = deferred();
    const simultaneous = fixture(simultaneousRoot, { statFile: async (file) => {
        buildStarted.resolve();
        await buildRelease.promise;
        return fs.promises.stat(file);
    } });
    const one = simultaneous.search('needle');
    await buildStarted.promise;
    const two = simultaneous.search('other');
    buildRelease.resolve();
    const both = await Promise.all([one, two]);
    eq('concurrent queries share one inventory build', simultaneous.enumerations, 1);
    eq('concurrent queries still run their own content matching', both.map((result) => result.totalMatches), [1, 1]);
    simultaneous.emit(path.join(tmp, 'gitconfig'), 'reconfigure');
    await simultaneous.search();
    eq('Git configuration changes rebuild coverage and inventory', simultaneous.enumerations, 2);

    const cancelledRoot = path.join(tmp, 'cancelled');
    write(path.join(cancelledRoot, 'service.go'), 'needle');
    const cancelStarted = deferred();
    const cancelRelease = deferred();
    let cancelStats = 0;
    const cancellable = fixture(cancelledRoot, { statFile: async (file) => {
        if (++cancelStats === 1) { cancelStarted.resolve(); await cancelRelease.promise; }
        return fs.promises.stat(file);
    } });
    const controller = new AbortController();
    const stopped = cancellable.search('needle', {}, { signal: controller.signal });
    const stoppedCheck = rejects(stopped, 'SEARCH_CANCELLED', 'cancelled metadata build rejects promptly');
    await cancelStarted.promise;
    const replacement = cancellable.search();
    controller.abort();
    await stoppedCheck;
    cancelRelease.resolve();
    const replaced = await replacement;
    eq('a replacement query retries a cancelled shared build', replaced.totalMatches, 1);
    eq('a cancelled partial inventory is never reused', cancellable.enumerations, 2);

    const noWatcher = fixture(root, { watchRoots() { throw new Error('watch unavailable'); } });
    await noWatcher.search();
    await noWatcher.search();
    eq('an unavailable watcher falls back to fresh enumeration', noWatcher.enumerations, 2);
    f.service.dispose();
    assert('disposing the service releases every watcher', f.watches.every((watch) => watch.disposed));
    await rejects(f.search(), 'SEARCH_CANCELLED', 'disposed services cannot start another search');

    console.log('\n== VS Code watcher coverage and lifecycle ==');
    const vscode = require('./vscode-stub');
    const originalPattern = vscode.RelativePattern;
    const originalWatch = vscode.workspace.createFileSystemWatcher;
    const watched = [];
    const events = [];
    const globalConfig = path.join(tmp, 'test-gitconfig');
    const globalIgnore = path.join(tmp, 'global-rules', '[rules].ignore');
    write(globalConfig, `[core]\nexcludesfile = ${globalIgnore}\n`);
    write(globalIgnore, '*.generated.go\n');
    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    vscode.RelativePattern = class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } };
    vscode.workspace.createFileSystemWatcher = (pattern) => {
        const watcher = { pattern, disposed: false, listeners: {} };
        watched.push(watcher);
        return {
            ...Object.fromEntries(['onDidCreate', 'onDidChange', 'onDidDelete'].map((event) => [event, (listener) => {
                watcher.listeners[event] = listener;
                return { dispose() {} };
            }])),
            dispose() { watcher.disposed = true; },
        };
    };
    Module._resolveFilename = function (request, ...rest) {
        return request === 'vscode' ? path.join(__dirname, 'vscode-stub.js') : originalResolve.call(this, request, ...rest);
    };
    try {
        const watcher = watchSourceRoots([root], (event) => events.push(event));
        const recursive = watched.filter((entry) => entry.pattern.pattern === '**/*');
        eq('only actual source roots are watched recursively', recursive.map((entry) => entry.pattern.base), [root]);
        assert('parent ignore inputs have exact-name watchers', watched.some((entry) => entry.pattern.base === path.dirname(root) && entry.pattern.pattern.includes('.ignore')));
        recursive[0].listeners.onDidChange({ fsPath: small });
        eq('native watcher events are forwarded with their path', events[0], { type: 'change', file: small });
        const ancestor = watched.find((entry) => entry.pattern.base === path.dirname(root));
        ancestor.listeners.onDidChange({ fsPath: path.join(path.dirname(root), '.ignore') });
        eq('ancestor ignore events invalidate membership', events[1].type, 'invalidate');
        const global = watched.find((entry) => entry.pattern.base === path.dirname(globalIgnore) && entry.pattern.pattern === '*');
        assert('custom Git ignore files have non-recursive watchers', !!global);
        global.listeners.onDidChange({ fsPath: path.join(path.dirname(globalIgnore), 'unrelated') });
        eq('custom ignore watchers filter paths literally', events.length, 2);
        global.listeners.onDidChange({ fsPath: globalIgnore });
        eq('custom global ignore changes invalidate membership', events[2], { type: 'invalidate', file: globalIgnore });
        watcher.dispose();
        assert('disposing native coverage closes every watcher', watched.every((entry) => entry.disposed));
    } finally {
        Module._resolveFilename = originalResolve;
        vscode.RelativePattern = originalPattern;
        vscode.workspace.createFileSystemWatcher = originalWatch;
        if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    }
}

run().then(done).catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
    for (const service of services) service.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
});
