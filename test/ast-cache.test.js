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
        { parallelism: 1, warm: 1, background: 1, foreground: 0 },
        { parallelism: 4, warm: 2, background: 1, foreground: 1 },
        { parallelism: 8, warm: 5, background: 3, foreground: 2 },
        { parallelism: 12, warm: 8, background: 5, foreground: 3 },
        { parallelism: 32, warm: 21, background: 14, foreground: 7 },
        { parallelism: 64, warm: 32, background: 16, foreground: 16 },
    ];
    for (const profile of cpuProfiles) {
        const pool = new AstWorkerPool({ parallelism: profile.parallelism });
        eq(
            `${profile.parallelism} CPU profile derives its warm worker baseline`,
            pool.warmConcurrency,
            profile.warm
        );
        eq(
            `${profile.parallelism} CPU profile derives its background parser lane`,
            pool.backgroundConcurrency,
            profile.background
        );
        eq(
            `${profile.parallelism} CPU profile retains foreground capacity`,
            pool.foregroundReserve,
            profile.foreground
        );
        pool.dispose();
    }
    const twelveCpu = new AstWorkerPool({ parallelism: 12 });
    eq('12 CPU warmup starts the adaptive baseline', await twelveCpu.warmup(), 8);
    eq('adaptive warmup does not grow to the configured ceiling', twelveCpu.stats.maxWorkers, 8);
    twelveCpu.dispose();
    const configuredCeiling = new AstWorkerPool({ concurrency: 6, parallelism: 64 });
    eq('configured concurrency remains an adaptive worker ceiling', configuredCeiling.warmConcurrency, 6);
    eq('configured ceiling keeps a proportional background lane', configuredCeiling.backgroundConcurrency, 4);
    configuredCeiling.dispose();
    const maximum = new AstWorkerPool({ concurrency: 100, parallelism: 64 });
    eq('worker concurrency is capped at 32', maximum.concurrency, 32);
    eq('CPU-derived warm concurrency is capped at 32', maximum.warmConcurrency, 32);
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
    promotedQueue._enqueue({ id: 4, key: 'background', priority: 10, sequence: 4 });
    promotedQueue._enqueue({ id: 5, key: 'normal', priority: 100, sequence: 5 });
    assert(
        'queued AST work can be promoted by its exact in-flight key',
        promotedQueue._promoteQueuedJob('background', 200)
    );
    eq('promoted background work moves ahead of normal work', [
        promotedQueue._dequeue().id,
        promotedQueue._dequeue().id,
    ], [4, 5]);
    promotedQueue.dispose();

    const reservedForeground = new AstWorkerPool({
        concurrency: 4,
        warmConcurrency: 4,
        parallelism: 8,
    });
    const dispatched = [];
    reservedForeground.workers = Array.from({ length: 4 }, (_, workerIndex) => ({
        worker: {
            postMessage(message) {
                dispatched.push({ workerIndex, id: message.id });
            },
            terminate() {},
        },
        busy: false,
        job: null,
        failed: false,
        retiring: false,
        ready: true,
        readyPromise: Promise.resolve(true),
        resolveReady() {},
    }));
    for (let id = 1; id <= 6; id++) {
        reservedForeground._enqueue({
            id,
            key: `background-${id}`,
            priority: 10,
            sequence: id,
            file: files[id % files.length],
            resolve() {},
            reject() {},
        });
    }
    reservedForeground._dispatch();
    assert(
        'background parsing reserves ready workers for a first foreground query',
        reservedForeground.stats.active < reservedForeground.effectiveConcurrency
    );
    const backgroundActive = reservedForeground.stats.active;
    assert(
        'background prewarm still uses multiple workers while preserving foreground capacity',
        backgroundActive > 1
    );
    const promotedID = reservedForeground.queue.find((job) => job.key === 'background-6').id;
    assert(
        'queued prewarm work is promoted when the foreground needs the same file',
        reservedForeground._promoteQueuedJob('background-6', 200)
    );
    eq(
        'promoted foreground work starts immediately without waiting for a background parse',
        reservedForeground.stats.active,
        backgroundActive + 1
    );
    assert(
        'the reserved worker receives the exact promoted job',
        dispatched.some((item) => item.id === promotedID)
    );
    reservedForeground.dispose();

    const boundedBackground = new AstWorkerPool({
        concurrency: 8,
        warmConcurrency: 4,
        parallelism: 12,
    });
    let activeCalls = 0;
    let maxBackgroundCalls = 0;
    boundedBackground.parseDiskFile = async (file) => {
        activeCalls += 1;
        maxBackgroundCalls = Math.max(maxBackgroundCalls, activeCalls);
        await new Promise((resolve) => setTimeout(resolve, 2));
        activeCalls -= 1;
        return file;
    };
    const backgroundRequests = Array.from({ length: 24 }, (_, index) => ({
        file: `background-file-${index}`,
    }));
    await boundedBackground.parseFiles(backgroundRequests, 10);
    assert(
        'background cache restoration uses a wider bounded I/O lane',
        maxBackgroundCalls > boundedBackground.backgroundConcurrency &&
            maxBackgroundCalls <= boundedBackground.backgroundIOConcurrency
    );

    activeCalls = 0;
    let maxBackgroundParserCalls = 0;
    boundedBackground.parseFile = async (file) => {
        activeCalls += 1;
        maxBackgroundParserCalls = Math.max(maxBackgroundParserCalls, activeCalls);
        await new Promise((resolve) => setTimeout(resolve, 2));
        activeCalls -= 1;
        return file;
    };
    await boundedBackground.parseFiles(
        backgroundRequests.map((request, index) => ({
            ...request,
            text: `package p\ntype Overlay${index} struct{}\n`,
        })),
        10
    );
    assert(
        'background overlay parsing remains inside the reserved parser lane',
        maxBackgroundParserCalls <= boundedBackground.backgroundConcurrency
    );

    activeCalls = 0;
    let maxForegroundCalls = 0;
    boundedBackground.parseFile = async (file) => {
        activeCalls += 1;
        maxForegroundCalls = Math.max(maxForegroundCalls, activeCalls);
        await new Promise((resolve) => setTimeout(resolve, 2));
        activeCalls -= 1;
        return file;
    };
    await boundedBackground.parseFiles(
        backgroundRequests.map((request, index) => ({
            ...request,
            text: `package p\ntype Foreground${index} struct{}\n`,
        })),
        200
    );
    assert(
        'foreground batch parsing retains full parallel fan-out',
        maxForegroundCalls >= boundedBackground.effectiveConcurrency
    );
    boundedBackground.dispose();

    const inflightPromotion = new AstWorkerPool({ concurrency: 1 });
    const ensurePromotionWorkers = inflightPromotion._ensureWorkers.bind(inflightPromotion);
    inflightPromotion._ensureWorkers = () => {};
    const promotionText = 'package p\ntype Promoted struct{}\nfunc (Promoted) Run() {}\n';
    const backgroundParse = inflightPromotion.parseFile(files[4], promotionText, 10);
    const earlyForegroundParse = inflightPromotion.parseFile(files[4], promotionText, 100);
    assert(
        'foreground request before enqueue shares the background parse promise',
        earlyForegroundParse === backgroundParse
    );
    while (inflightPromotion.queue.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    eq('early foreground priority is applied when the job enters the queue', inflightPromotion.queue[0].priority, 100);
    const queuedForegroundParse = inflightPromotion.parseFile(files[4], promotionText, 200);
    assert(
        'foreground request after enqueue still shares the parse promise',
        queuedForegroundParse === backgroundParse
    );
    eq('queued in-flight parse is promoted to foreground priority', inflightPromotion.queue[0].priority, 200);
    inflightPromotion._ensureWorkers = ensurePromotionWorkers;
    inflightPromotion._ensureWorkers(1);
    inflightPromotion._dispatch();
    await queuedForegroundParse;
    eq('priority promotion does not duplicate Tree-sitter parsing', inflightPromotion.stats.parsed, 1);
    inflightPromotion.dispose();

    const first = new AstWorkerPool({ concurrency: 2, cacheDir, log: () => {} });
    eq('worker warmup starts every parser worker', await first.warmup(), 2);
    eq('worker warmup does not parse workspace files', first.stats.parsed, 0);
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
        warmConcurrency: 2,
        parallelism: 12,
        idleTimeoutMs: 20,
    });
    eq('adaptive pool leaves CPU headroom', adaptive.effectiveConcurrency, 8);
    eq('adaptive pool prewarms only its baseline', await adaptive.warmup(), 2);
    await adaptive.parseFiles(
        files.map((file, index) => ({
            file,
            text: `package p\ntype Adaptive${index} struct{}\nfunc (Adaptive${index}) Run() {}\n`,
        })),
        100
    );
    assert('adaptive pool grows beyond its warm baseline for a burst', adaptive.stats.maxWorkers > 2);
    assert('adaptive pool respects its CPU-aware soft limit', adaptive.stats.maxWorkers <= 8);
    await new Promise((resolve) => setTimeout(resolve, 50));
    eq('idle adaptive workers shrink back to the warm baseline', adaptive.workers.length, 2);
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
