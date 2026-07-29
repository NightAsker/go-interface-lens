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
            `package p\ntype Type${index} struct{}\nfunc (*Type${index}) Run(value string) error { return nil }\n`
        );
        return file;
    });

    console.log('== concurrent declaration AST cache ==');
    const defaults = new AstWorkerPool();
    eq('worker concurrency defaults to 16', defaults.concurrency, 16);
    eq('default warmup starts only the baseline workers', await defaults.warmup(), 4);
    eq('default warmup keeps the remaining capacity lazy', defaults.stats.maxWorkers, 4);
    defaults.dispose();
    const maximum = new AstWorkerPool({ concurrency: 100 });
    eq('worker concurrency is capped at 32', maximum.concurrency, 32);
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

    const first = new AstWorkerPool({ concurrency: 2, cacheDir, log: () => {} });
    eq('worker warmup starts every parser worker', await first.warmup(), 2);
    eq('worker warmup does not parse workspace files', first.stats.parsed, 0);
    await Promise.all([
        first.parseFile(files[0], undefined, 100),
        first.parseFile(files[0], undefined, 100),
    ]);
    eq('concurrent requests for one file are deduplicated', first.stats.parsed, 1);
    const parsed = await first.parseFiles(files.map((file) => ({ file })), 100);
    eq('all candidate files parsed', parsed.size, files.length);
    eq('worker concurrency is bounded', first.stats.maxActive, 2);
    assert('pointer metadata survives worker serialization', parsed.get(files[0]).types.get('Type0').pointerMethods.has('Run'));

    const adaptive = new AstWorkerPool({ concurrency: 16, warmConcurrency: 2 });
    eq('adaptive pool prewarms only its baseline', await adaptive.warmup(), 2);
    await adaptive.parseFiles(
        files.map((file, index) => ({
            file,
            text: `package p\ntype Adaptive${index} struct{}\nfunc (Adaptive${index}) Run() {}\n`,
        })),
        100
    );
    assert('adaptive pool grows beyond its warm baseline for a burst', adaptive.stats.maxWorkers > 2);
    assert('adaptive pool never exceeds configured concurrency', adaptive.stats.maxWorkers <= 16);
    adaptive.dispose();

    await first.parseFile(files[0], undefined, 100);
    assert('second query hits memory cache', first.stats.memoryHits >= 1);
    await first.flush();
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

    second.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
