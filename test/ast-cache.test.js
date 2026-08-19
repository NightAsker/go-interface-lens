'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { AstWorkerPool } = require('../src/ast-cache');
const { assert, eq, done } = require('./harness');

async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-interface-ast-cache-'));
    const cacheDir = path.join(tmp, 'cache');
    const files = Array.from({ length: 5 }, (_, index) => {
        const file = path.join(tmp, `type${index}.go`);
        fs.writeFileSync(
            file,
            `package p\ntype Type${index} struct{ RunField int }\nfunc (*Type${index}) Run(value string) error { return nil }\n`
        );
        return file;
    });

    console.log('== concurrent declaration AST cache ==');
    const defaults = new AstWorkerPool();
    eq('worker concurrency defaults to 32', defaults.concurrency, 32);
    defaults.dispose();
    const cpuProfiles = [
        { parallelism: 1, effective: 1 },
        { parallelism: 4, effective: 2 },
        { parallelism: 8, effective: 5 },
        { parallelism: 12, effective: 8 },
        { parallelism: 32, effective: 21 },
        { parallelism: 64, effective: 32 },
    ];
    for (const profile of cpuProfiles) {
        const pool = new AstWorkerPool({ parallelism: profile.parallelism });
        eq(
            `${profile.parallelism} CPU profile derives its effective worker ceiling`,
            pool.effectiveConcurrency,
            profile.effective
        );
        eq(`${profile.parallelism} CPU profile starts without workers`, pool.workers.length, 0);
        pool.dispose();
    }
    const configuredCeiling = new AstWorkerPool({ concurrency: 6, parallelism: 64 });
    eq('configured concurrency remains an adaptive worker ceiling', configuredCeiling.effectiveConcurrency, 6);
    configuredCeiling.dispose();
    const memoryBound = new AstWorkerPool({
        concurrency: 32,
        parallelism: 64,
        memoryLimitBytes: 2 * 1024 * 1024 * 1024,
        memoryCurrentBytes: 1024 * 1024 * 1024,
        workerMemoryBytes: 128 * 1024 * 1024,
        memoryReserveBytes: 512 * 1024 * 1024,
    });
    eq('cgroup memory headroom bounds the effective worker count', memoryBound.effectiveConcurrency, 4);
    memoryBound.dispose();
    const maximum = new AstWorkerPool({ concurrency: 100, parallelism: 64 });
    eq('worker concurrency is capped at 32', maximum.concurrency, 32);
    eq('CPU-derived effective concurrency is capped at 32', maximum.effectiveConcurrency, 32);
    maximum.dispose();
    const minimum = new AstWorkerPool({ concurrency: 0 });
    eq('worker concurrency is clamped to at least 1', minimum.concurrency, 1);
    minimum.dispose();

    const priorityQueue = new AstWorkerPool({ concurrency: 1 });
    priorityQueue._enqueue({ id: 1, priority: 100, sequence: 1 });
    priorityQueue._enqueue({ id: 2, priority: 200, sequence: 2 });
    priorityQueue._enqueue({ id: 3, priority: 200, sequence: 3 });
    eq('worker queue preserves priority and FIFO order', [
        priorityQueue._dequeue().id,
        priorityQueue._dequeue().id,
        priorityQueue._dequeue().id,
    ], [2, 3, 1]);
    priorityQueue.dispose();

    const promotedQueue = new AstWorkerPool({ concurrency: 1 });
    promotedQueue._enqueue({ id: 4, key: 'low', priority: 10, sequence: 4 });
    promotedQueue._enqueue({ id: 5, key: 'normal', priority: 100, sequence: 5 });
    assert(
        'queued AST work can be promoted by its exact in-flight key',
        promotedQueue._promoteQueuedJob('low', 200)
    );
    eq('promoted low-priority work moves ahead of normal work', [
        promotedQueue._dequeue().id,
        promotedQueue._dequeue().id,
    ], [4, 5]);
    promotedQueue.dispose();

    const inflightPromotion = new AstWorkerPool({ concurrency: 1 });
    const ensurePromotionWorkers = inflightPromotion._ensureWorkers.bind(inflightPromotion);
    inflightPromotion._ensureWorkers = () => {};
    const promotionText = 'package p\ntype Promoted struct{}\nfunc (Promoted) Run() {}\n';
    const lowPriorityParse = inflightPromotion.parseFile(files[4], promotionText, 10);
    const normalPriorityParse = inflightPromotion.parseFile(files[4], promotionText, 100);
    assert(
        'higher-priority request before enqueue shares the existing parse promise',
        normalPriorityParse === lowPriorityParse
    );
    while (inflightPromotion.queue.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    eq('early foreground priority is applied when the job enters the queue', inflightPromotion.queue[0].priority, 100);
    const queuedHighPriorityParse = inflightPromotion.parseFile(files[4], promotionText, 200);
    assert(
        'higher-priority request after enqueue still shares the parse promise',
        queuedHighPriorityParse === lowPriorityParse
    );
    eq('queued in-flight parse is promoted to foreground priority', inflightPromotion.queue[0].priority, 200);
    inflightPromotion._ensureWorkers = ensurePromotionWorkers;
    inflightPromotion._ensureWorkers(1);
    inflightPromotion._dispatch();
    await queuedHighPriorityParse;
    eq('priority promotion does not duplicate Tree-sitter parsing', inflightPromotion.stats.parsed, 1);
    inflightPromotion.dispose();

    const first = new AstWorkerPool({ concurrency: 2, cacheDir, log: () => {} });
    eq('worker pool starts without parser workers', first.workers.length, 0);
    await Promise.all([
        first.parseFile(files[0], undefined, 10),
        first.parseFile(files[0], undefined, 200),
    ]);
    eq('running requests with raised priority remain deduplicated', first.stats.parsed, 1);
    const parsed = await first.parseFiles(files.map((file) => ({ file })), 100);
    eq('all candidate files parsed', parsed.size, files.length);
    eq('worker concurrency is bounded', first.stats.maxActive, 2);
    assert('pointer metadata survives worker serialization', parsed.get(files[0]).types.get('Type0').pointerMethods.has('Run'));
    assert('field selector metadata survives worker serialization', parsed.get(files[0]).types.get('Type0').fieldNames.has('RunField'));

    const adaptive = new AstWorkerPool({
        concurrency: 16,
        parallelism: 12,
        idleTimeoutMs: 20,
    });
    eq('adaptive pool leaves CPU headroom', adaptive.effectiveConcurrency, 8);
    eq('adaptive pool remains empty before the first parse', adaptive.workers.length, 0);
    await adaptive.parseFiles(
        files.map((file, index) => ({
            file,
            text: `package p\ntype Adaptive${index} struct{}\nfunc (Adaptive${index}) Run() {}\n`,
        })),
        100
    );
    assert('adaptive pool grows beyond one worker for a burst', adaptive.stats.maxWorkers > 1);
    assert('adaptive pool respects its CPU-aware soft limit', adaptive.stats.maxWorkers <= 8);
    await new Promise((resolve) => setTimeout(resolve, 50));
    eq('idle adaptive workers shrink back to one reusable worker', adaptive.workers.length, 1);
    adaptive.dispose();

    await first.parseFile(files[0], undefined, 100);
    assert('second query hits memory cache', first.stats.memoryHits >= 1);
    await first.flush();
    const packFiles = fs
        .readdirSync(first.astCacheDir)
        .filter((file) => file.startsWith('pack-') && file.endsWith('.json'));
    assert(
        'persistent AST cache batches parsed files into fewer cache packs',
        packFiles.length > 0 && packFiles.length < files.length
    );
    first.dispose();

    const second = new AstWorkerPool({ concurrency: 2, cacheDir, log: () => {} });
    await second.parseFile(files[0], undefined, 100);
    eq('new worker pool restores persistent cache', second.stats.diskHits, 1);

    const overlayText = 'package p\ntype Type0 struct{}\nfunc (Type0) Stop() {}\n';
    const overlay = await second.parseFile(files[0], overlayText, 100);
    assert('unsaved overlay is parsed independently', overlay.types.get('Type0').methods.has('Stop'));
    second.clearOverlay(files[0]);
    const disk = await second.parseFile(files[0], undefined, 100);
    assert('closing overlay restores disk AST', disk.types.get('Type0').methods.has('Run'));
    assert('field selector metadata restores from the persistent AST cache', disk.types.get('Type0').fieldNames.has('RunField'));

    const corruptEntry = second.persisted.get(files[1]);
    fs.writeFileSync(second._cachePackFile(corruptEntry.pack), '{broken');
    second.packMemory.clear();
    const parsedBeforeRecovery = second.stats.parsed;
    const recovered = await second.parseFile(files[1], undefined, 100);
    assert('a corrupt AST pack is reparsed without failing the query', recovered.types.has('Type1'));
    eq('corrupt pack recovery reparses only the requested file', second.stats.parsed, parsedBeforeRecovery + 1);
    await second.flush();

    console.log('\n== cacheable prefetched dependency sources ==');
    const prefetchedCacheDir = path.join(tmp, 'prefetched-cache');
    const prefetchedText = fs.readFileSync(files[3], 'utf8');
    const prefetchedFirst = new AstWorkerPool({
        concurrency: 2,
        cacheDir: prefetchedCacheDir,
        log: () => {},
    });
    await prefetchedFirst.parseDiskFile(files[3], prefetchedText, 10);
    await prefetchedFirst.flush();
    eq('prefetched disk source is parsed once on its first load', prefetchedFirst.stats.parsed, 1);
    prefetchedFirst.dispose();

    const prefetchedSecond = new AstWorkerPool({
        concurrency: 2,
        cacheDir: prefetchedCacheDir,
        log: () => {},
    });
    await prefetchedSecond.parseDiskFile(files[3], prefetchedText, 10);
    eq('prefetched dependency source restores from persistent AST cache', prefetchedSecond.stats.diskHits, 1);
    eq('prefetched dependency source is not reparsed after restart', prefetchedSecond.stats.parsed, 0);
    prefetchedSecond.dispose();

    const boundedCacheDir = path.join(tmp, 'bounded-cache');
    const bounded = new AstWorkerPool({
        concurrency: 1,
        cacheDir: boundedCacheDir,
        maxMemoryEntries: 2,
        maxDiskEntries: 2,
    });
    await bounded.parseFiles(files.slice(0, 3).map((file) => ({ file })), 100);
    eq('memory AST cache evicts its least-recently-used entry', bounded.memory.size, 2);
    eq('disk AST manifest evicts its oldest entry', bounded.persisted.size, 2);
    await bounded.flush();
    const boundedManifest = JSON.parse(fs.readFileSync(bounded.cacheFile, 'utf8'));
    eq('bounded disk manifest persists only retained entries', boundedManifest.files.length, 2);
    const boundedPacks = fs
        .readdirSync(bounded.astCacheDir)
        .filter((file) => file.startsWith('pack-') && file.endsWith('.json'));
    assert('bounded disk cache removes packs that no retained entry references', boundedPacks.length <= 1);
    bounded.clear();
    assert('clear removes the packed AST cache directory', !fs.existsSync(bounded.astCacheDir));
    bounded.dispose();

    second.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
