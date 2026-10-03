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
const { SourceSearchService } = require('../src/source-search');
const { collectSearchFiles, planSearchJobs } = require('../src/source-search-plan');
Module._resolveFilename = originalResolve;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-source-inventory-'));
const root = { root: tmp, scope: 'workspace', label: 'test' };
const args = ['--files', '--null', '--glob', '*.go', '--', tmp];
const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
};
async function rejects(promise, code, label) {
    let error;
    try { await promise; } catch (caught) { error = caught; }
    eq(label, error && error.code, code);
}

async function run() {
    console.log('== exact metadata before the first search ==');
    fs.mkdirSync(path.join(tmp, 'pkg'));
    fs.mkdirSync(path.join(tmp, 'ignored'));
    fs.writeFileSync(path.join(tmp, '.ignore'), 'ignored/\n');
    fs.writeFileSync(path.join(tmp, 'ignored', 'skip.go'), 'unsearched');
    fs.writeFileSync(path.join(tmp, 'pkg', 'skip.txt'), 'not Go');
    const texts = new Map([
        ['small.go', 'package pkg'],
        ['中文 with space.go', '// 中文😀\n'],
        ['with\nnewline.go', '// split filename'],
        ['.hidden.go', '// explicit glob includes hidden Go files'],
    ]);
    for (const [name, text] of texts) fs.writeFileSync(path.join(tmp, 'pkg', name), text);
    let active = 0;
    let peak = 0;
    let statCalls = 0;
    const statFile = async (file) => {
        active++;
        statCalls++;
        peak = Math.max(peak, active);
        try { return await fs.promises.stat(file); }
        finally { active--; }
    };
    const inventory = await collectSearchFiles('rg', args, root, { statFile });
    eq('metadata enumeration follows the same ignore and include rules', inventory.map((file) => path.basename(file.file)).sort(), [...texts.keys()].sort());
    eq('metadata measures byte sizes including Unicode exactly', inventory.reduce((sum, file) => sum + file.size, 0), [...texts.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0));
    eq('each candidate is measured once without reading source text', statCalls, texts.size);
    assert('space and newline filenames stay intact', inventory.some((file) => file.file.endsWith('with\nnewline.go')));
    const filtered = await collectSearchFiles('rg', args, root, { includeFile: (file) => !file.endsWith('small.go') });
    eq('source exclusions are applied before size statistics', filtered.length, texts.size - 1);

    const largeFile = path.join(tmp, 'pkg', 'large.go');
    fs.writeFileSync(largeFile, Buffer.alloc(1024 * 1024, 32));
    const starts = [];
    const logs = [];
    const service = new SourceSearchService({
        getWorkspaceRoots: () => [tmp],
        log: (message) => logs.push(message),
        runRipgrep: async (_command, commandArgs) => {
            starts.push(commandArgs.slice(commandArgs.indexOf('--') + 1));
            return {};
        },
    });
    await service.search({ query: 'needle', scope: 'workspace' });
    eq('the first content search starts with the largest real file', starts[0], [largeFile]);
    assert('the first query logs measured files, packages and bytes', logs.some((message) => /5 files, 1 packages, \d+ bytes, metadata \d+ ms/.test(message)));
    assert('ignored files never become explicit shard targets', starts.flat().every((file) => !file.includes('/ignored/') && !file.endsWith('skip.txt')));

    console.log('\n== fresh metadata after file and filter changes ==');
    starts.length = 0;
    const added = path.join(tmp, 'pkg', 'new-largest.go');
    fs.writeFileSync(added, Buffer.alloc(2 * 1024 * 1024, 32));
    fs.unlinkSync(largeFile);
    await service.search({ query: 'needle', scope: 'workspace' });
    eq('new files affect the next query immediately', starts[0], [added]);
    assert('removed files are absent from the next search', !starts.flat().includes(largeFile));
    const grown = path.join(tmp, 'pkg', 'small.go');
    fs.writeFileSync(grown, Buffer.alloc(3 * 1024 * 1024, 32));
    starts.length = 0;
    await service.search({ query: 'needle', scope: 'workspace' });
    eq('changed file sizes immediately change task priority', starts[0], [grown]);
    starts.length = 0;
    await service.search({ query: 'needle', scope: 'workspace', config: { sourceSearchExcludedFilePatterns: ['small.go', 'new-largest.go'] } });
    assert('changed exclusions affect statistics and task targets immediately', starts.flat().every((file) => file !== grown && file !== added));

    const disappearing = path.join(tmp, 'pkg', 'disappearing.go');
    fs.writeFileSync(disappearing, 'temporary');
    const afterDeletion = await collectSearchFiles('rg', args, root, { statFile: async (file) => {
        if (file === disappearing) fs.unlinkSync(file);
        return fs.promises.stat(file);
    } });
    assert('a file deleted during statistics is skipped safely', !afterDeletion.some((file) => file.file === disappearing));
    await rejects(collectSearchFiles('rg', args, root, {
        statFile: async () => { throw Object.assign(new Error('metadata denied'), { code: 'EACCES' }); },
    }), 'EACCES', 'metadata failures are reported instead of using a default weight');

    console.log('\n== bounded metadata reads and cancellation ==');
    const many = path.join(tmp, 'many');
    fs.mkdirSync(many);
    for (let index = 0; index < 300; index++) fs.writeFileSync(path.join(many, `part${index}.go`), 'package many');
    peak = 0;
    statCalls = 0;
    const manyArgs = ['--files', '--null', '--glob', '*.go', '--', many];
    const full = await collectSearchFiles('rg', manyArgs, root, { statFile });
    eq('metadata includes every file in a large package', full.length, 300);
    assert('metadata stat operations have bounded concurrency', peak <= 16 && peak > 1);
    const jobs = planSearchJobs(full.map((file) => ({ ...file, root })), 8);
    assert('a large package is distributed across multiple tasks', jobs.length > 1);
    eq('splitting keeps every file exactly once', new Set(jobs.flatMap((job) => job.files.map((file) => file.file))).size, 300);

    const controller = new AbortController();
    const release = deferred();
    const running = deferred();
    let began = 0;
    const canceled = collectSearchFiles('rg', manyArgs, root, { signal: controller.signal, statFile: async (file) => {
        began++;
        if (began === 16) running.resolve();
        await release.promise;
        return fs.promises.stat(file);
    } });
    const timeout = setTimeout(() => running.resolve(), 2000);
    await running.promise;
    clearTimeout(timeout);
    controller.abort();
    release.resolve();
    await rejects(canceled, 'SEARCH_CANCELLED', 'canceling during metadata terminates file enumeration');
    eq('cancellation starts no further stat requests', began, 16);
    await rejects(collectSearchFiles('rg', manyArgs, root, { signal: controller.signal }), 'SEARCH_CANCELLED', 'pre-canceled statistics do not start enumeration');

    let scans = 0;
    const metadataStarted = deferred();
    const serviceController = new AbortController();
    const canceledService = new SourceSearchService({
        getWorkspaceRoots: () => [tmp],
        collectFiles: (_command, _args, _root, options) => new Promise((resolve) => {
            options.signal.addEventListener('abort', () => resolve([]), { once: true });
            metadataStarted.resolve();
        }),
        runRipgrep: async () => { scans++; return {}; },
    });
    const search = canceledService.search({ query: 'needle', scope: 'workspace' }, { signal: serviceController.signal });
    await metadataStarted.promise;
    serviceController.abort();
    await rejects(search, 'SEARCH_CANCELLED', 'service cancellation interrupts the planning phase');
    eq('canceled statistics never launch content scans', scans, 0);
    await rejects(collectSearchFiles(path.join(tmp, 'missing-rg'), [], root), 'ENOENT', 'enumeration spawn errors propagate');
}

run().then(done).catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
