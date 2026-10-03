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
const { SourceSearchService, planSearchJobs, runRipgrepJson } = require('../src/source-search');
Module._resolveFilename = originalResolve;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-source-parallel-'));
const root = (name, scope = 'workspace') => ({ root: path.join(tmp, name), scope, label: name });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
};
function match(file, line = 1, text = 'needle') {
    return { file, line, column: 1, text, ranges: [{ start: 0, end: 6, text: 'needle' }] };
}
function fakeService(roots, runRipgrep, extra = {}) {
    const service = new SourceSearchService({
        parallelism: 8, runRipgrep,
        collectFiles: async (_command, args) => args.slice(args.indexOf('--') + 1).map((directory) => ({ file: path.join(directory, 'service.go'), size: 1024 })),
        ...extra,
    });
    service.resolveRoots = () => roots;
    return service;
}
async function rejectsCode(promise, code, label) {
    let caught;
    try { await promise; } catch (error) { caught = error; }
    eq(label, caught && caught.code, code);
}

async function run() {
    console.log('== workload-based search tasks ==');
    const roots = Array.from({ length: 200 }, (_, i) => root('pkg' + i));
    const files = roots.map((root, index) => ({ root, file: path.join(root.root, 'service.go'), size: index === 0 ? 80 * 1024 * 1024 : 1024 }));
    const jobs = planSearchJobs(files, 8);
    eq('largest measured file starts first in its own task', jobs[0].files.map((file) => file.file), [files[0].file]);
    eq('every file occurs in exactly one task', new Set(jobs.flatMap((job) => job.files.map((item) => item.file))).size, files.length);
    eq('job construction does not duplicate files', jobs.reduce((sum, job) => sum + job.files.length, 0), files.length);
    assert('small packages share tasks to reduce process startup', jobs.some((job) => job.files.length > 1));
    assert('task command lines and file counts are bounded', jobs.every((job) => job.pathBytes <= 24000 && job.files.length <= 256));
    const largePackage = Array.from({ length: 64 }, (_, index) => ({ root: roots[0], file: path.join(roots[0].root, `part${index}.go`), size: 1024 * 1024 }));
    const split = planSearchJobs(largePackage, 8);
    assert('a single large package is split across several balanced tasks', split.length >= 4 && Math.max(...split.map((job) => job.bytes)) <= 8 * 1024 * 1024);
    const tiny = files.slice(1, 101).map((file) => ({ ...file, file: path.join(tmp, 'tiny', path.basename(file.root.root) + '.go'), size: 1 }));
    const sameBytes = [{ root: roots[0], file: path.join(tmp, 'single', 'one.go'), size: 100 }];
    const countsMatter = planSearchJobs([...sameBytes, ...tiny], 8);
    assert('many small files contribute to scheduling weight', countsMatter[0].files.length > 1);

    console.log('\n== bounded native threads and dynamic queue ==');
    let activeThreads = 0;
    let peakThreads = 0;
    let activeProcesses = 0;
    let peakProcesses = 0;
    const pending = [];
    let drain = false;
    const many = roots.slice(0, 12);
    const service = fakeService(many, async (_command, args, _root, handlers) => {
        const threads = Number(args[args.indexOf('--threads') + 1]);
        activeThreads += threads;
        activeProcesses++;
        peakThreads = Math.max(peakThreads, activeThreads);
        peakProcesses = Math.max(peakProcesses, activeProcesses);
        const gate = deferred();
        pending.push(gate);
        if (!drain) await gate.promise;
        for (const file of args.slice(args.indexOf('--') + 1)) handlers.onMatch(match(file));
        activeThreads -= threads;
        activeProcesses--;
        return { stats: { bytes_searched: 4096 } };
    });
    const search = service.search({ query: 'needle' });
    await tick();
    eq('four processes start within the total thread budget', [pending.length, activeThreads], [4, 8]);
    pending[3].resolve();
    await tick();
    eq('a free worker takes another package without waiting for the slowest', pending.length, 5);
    drain = true;
    for (const gate of pending) gate.resolve();
    const combined = await search;
    assert('all processes share a maximum of eight scan threads', peakThreads <= 8);
    assert('at most four ripgrep processes run concurrently', peakProcesses <= 4);
    eq('parallel task results merge without losses', combined.totalMatches, many.length);
    eq('merged results have a stable file order', combined.results.map((entry) => entry.file), combined.results.map((entry) => entry.file).sort((a, b) => a.localeCompare(b)));
    let singleThreads;
    await fakeService([roots[0]], async (_command, args) => {
        singleThreads = Number(args[args.indexOf('--threads') + 1]);
        return { stats: { bytes_searched: 1024 } };
    }).search({ query: 'needle' });
    eq('one large workspace uses all available native scan threads', singleThreads, 8);

    const startOrder = [];
    const measuredService = fakeService(many, async (_command, args, entry, handlers) => {
        startOrder.push(entry.root);
        const bytes = entry.root === many[11].root ? 100000000 : 1024;
        return { stats: { bytes_searched: bytes } };
    }, { collectFiles: async () => many.map((entry) => ({ file: path.join(entry.root, 'service.go'), size: entry.root === many[11].root ? 100000000 : 1024 })) });
    await measuredService.search({ query: 'needle' });
    eq('the first query starts the largest measured package without history', startOrder[0], many[11].root);

    console.log('\n== streaming, limits and scope priority ==');
    const batchSeen = deferred();
    const finishEngine = deferred();
    let engineFinished = false;
    let batches = 0;
    const streaming = fakeService([roots[0]], async (_command, _args, entry, handlers) => {
        handlers.onMatch(match(path.join(entry.root, 'service.go')));
        await finishEngine.promise;
        engineFinished = true;
        return { stats: { bytes_searched: 1234 } };
    });
    const streamSearch = streaming.search({ query: 'needle' }, { onBatch(batch) {
        batches++;
        assert('first result is delivered while the engine is still searching', !engineFinished);
        eq('streamed batch includes the result', batch[0].matches.length, 1);
        batchSeen.resolve();
    } });
    const timeout = setTimeout(() => batchSeen.resolve(), 1000);
    await batchSeen.promise;
    clearTimeout(timeout);
    eq('a small batch streams without waiting for the engine to finish', batches, 1);
    finishEngine.resolve();
    await streamSearch;
    eq('final completion does not repeat already delivered results', batches, 1);

    let startedScopes = [];
    let abortObserved = false;
    const scopeRoots = [root('dep', 'dependency'), root('project')];
    const capped = fakeService(scopeRoots, async (_command, _args, entry, handlers) => {
        startedScopes.push(entry.scope);
        handlers.onMatch(match(path.join(entry.root, 'service.go')));
        abortObserved = handlers.signal.aborted;
        handlers.onMatch(match(path.join(entry.root, 'late.go')));
        return {};
    });
    const limited = await capped.search({ query: 'needle', maxResults: 1 });
    eq('workspace matches consume the budget before dependencies', startedScopes, ['workspace']);
    eq('global result limit applies across late process output', limited.totalMatches, 1);
    assert('reaching the result cap immediately cancels scan processes', abortObserved && limited.truncated);
    const fileLimited = await capped.search({ query: 'needle', maxFiles: 1, maxResults: 100 });
    eq('global file limit is honored', fileLimited.totalFiles, 1);
    assert('file-limit termination is marked truncated', fileLimited.truncated);

    const firstBatchGate = deferred();
    let remainingScanStopped = false;
    const callbackFailure = fakeService([roots[0]], async (_command, _args, entry, handlers) => {
        handlers.signal.addEventListener('abort', () => { remainingScanStopped = true; firstBatchGate.resolve(); }, { once: true });
        handlers.onMatch(match(path.join(entry.root, 'service.go')));
        await firstBatchGate.promise;
        return {};
    });
    await rejectsCode(callbackFailure.search({ query: 'needle' }, {
        onBatch() { throw Object.assign(new Error('delivery failed'), { code: 'DELIVERY_FAILED' }); },
    }), 'DELIVERY_FAILED', 'batch-delivery errors are propagated');
    assert('failed delivery also stops the running scan', remainingScanStopped);

    console.log('\n== cancellation and worker errors ==');
    const stop = new AbortController();
    let canceled = 0;
    let starts = 0;
    const cancellable = fakeService(many, (_command, _args, _root, handlers) => new Promise((resolve) => {
        starts++;
        handlers.signal.addEventListener('abort', () => { canceled++; resolve({}); }, { once: true });
    }));
    const canceledSearch = cancellable.search({ query: 'needle' }, { signal: stop.signal });
    await tick();
    stop.abort();
    await rejectsCode(canceledSearch, 'SEARCH_CANCELLED', 'user cancellation rejects with a cancellation error');
    eq('cancellation stops all active workers and starts no queued work', [canceled, starts], [4, 4]);
    await rejectsCode(cancellable.search({ query: 'needle' }, { signal: stop.signal }), 'SEARCH_CANCELLED', 'pre-canceled query starts no work');
    eq('pre-canceled search does not launch workers', starts, 4);

    let siblingsStopped = 0;
    const failed = fakeService(many, async (_command, _args, entry, handlers) => {
        if (entry.root === many[0].root) throw Object.assign(new Error('read failure'), { code: 'TEST_FAILURE' });
        await new Promise((resolve) => handlers.signal.addEventListener('abort', () => { siblingsStopped++; resolve(); }, { once: true }));
        return {};
    });
    await rejectsCode(failed.search({ query: 'needle' }), 'TEST_FAILURE', 'worker errors fail the overall search');
    eq('failed worker cancels its active siblings before returning', siblingsStopped, 3);

    console.log('\n== merging overlays and overlapping roots ==');
    const parent = root('project');
    const nested = { ...root('project/nested'), scope: 'dependency' };
    const diskFile = path.join(parent.root, 'dirty.go');
    const overlayService = fakeService([parent, nested], async (_command, _args, _entry, handlers) => {
        handlers.onMatch(match(diskFile));
        handlers.onMatch(match(path.join(nested.root, 'same.go')));
        return {};
    }, { getOpenDocuments: () => [{ uri: { fsPath: diskFile }, isDirty: true, getText: () => 'needle unsaved\nneedle again' }] });
    const overlays = await overlayService.search({ query: 'needle', maxResults: 10 });
    eq('dirty text replaces disk text without losing budget', overlays.totalMatches, 3);
    const dirty = overlays.results.find((entry) => entry.file === diskFile);
    eq('only unsaved source lines are retained for a dirty file', dirty.matches.map((item) => item.text), ['needle unsaved', 'needle again']);
    assert('dirty result remains labeled as unsaved', dirty.unsaved);
    eq('overlapping roots are deduplicated and retain workspace priority', overlays.results.find((entry) => entry.file.endsWith('same.go')).scope, 'workspace');
    overlayService.getOpenDocuments = () => [{ uri: { fsPath: diskFile }, isDirty: true, getText: () => 'no longer matches' }];
    const removed = await overlayService.search({ query: 'needle' });
    assert('a dirty file without matches does not leak disk matches into the stream', !removed.results.some((entry) => entry.file === diskFile));

    console.log('\n== actual ripgrep process stream and shutdown ==');
    const controller = new AbortController();
    let pid;
    let matches = 0;
    const script = `const record={type:'match',data:{path:{text:${JSON.stringify(path.join(tmp, 'service.go'))}},line_number:1,lines:{text:'needle'},submatches:[{start:0,end:6,match:{text:'needle'}}]}}; record.data.line_number=process.pid; process.stdout.write(JSON.stringify(record)+'\\n'); setInterval(()=>process.stdout.write(JSON.stringify(record)+'\\n'),20);`;
    const childSearch = runRipgrepJson(process.execPath, ['-e', script], { root: tmp }, {
        signal: controller.signal,
        onMatch(record) { pid = record.line; matches++; controller.abort(); },
    });
    await rejectsCode(childSearch, 'SEARCH_CANCELLED', 'canceling live JSON output terminates the child');
    eq('no output is delivered after cancellation', matches, 1);
    let alive = true;
    try { process.kill(pid, 0); } catch (_) { alive = false; }
    assert('cancel promise settles after the process exits', !alive);
    await rejectsCode(runRipgrepJson(path.join(tmp, 'missing-rg'), [], { root: tmp }), 'ENOENT', 'spawn failure is propagated');

    console.log('\n== real search result parity and filters ==');
    const actual = path.join(tmp, 'actual');
    fs.mkdirSync(path.join(actual, 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(actual, 'ignored'), { recursive: true });
    fs.writeFileSync(path.join(actual, '.ignore'), 'ignored/\n');
    fs.writeFileSync(path.join(actual, 'ignored', 'skip.go'), 'needle');
    fs.writeFileSync(path.join(actual, 'pkg', '.hidden.go'), 'needle');
    fs.writeFileSync(path.join(actual, 'pkg', 'skip.txt'), 'needle');
    fs.writeFileSync(path.join(actual, 'pkg', 'a.go'), 'needle\nneedle\nno match');
    fs.writeFileSync(path.join(actual, 'pkg', 'b.go'), 'no match\nneedle');
    const realService = new SourceSearchService({ getWorkspaceRoots: () => [actual] });
    const streamed = [];
    const realResult = await realService.search({ query: 'needle', scope: 'workspace' }, {
        onBatch(batch) { for (const entry of batch) for (const item of entry.matches) streamed.push(entry.file + ':' + item.line); },
    });
    // rg's explicit *.go include glob also includes hidden Go files; ignored
    // directories still stay excluded. Preserve the existing search semantics.
    const expected = [path.join(actual, 'pkg', '.hidden.go') + ':1', path.join(actual, 'pkg', 'a.go') + ':1', path.join(actual, 'pkg', 'a.go') + ':2', path.join(actual, 'pkg', 'b.go') + ':2'];
    eq('streaming preserves rg ignore rules, hidden files, and include globs', streamed.sort(), expected);
    eq('streamed and final match totals agree', streamed.length, realResult.totalMatches);
    const excluded = await realService.search({ query: 'needle', scope: 'workspace', config: { sourceSearchExcludedFilePatterns: ['b.go'] } });
    eq('source-search file exclusions are preserved', excluded.totalMatches, 3);
}

run().then(done).catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
