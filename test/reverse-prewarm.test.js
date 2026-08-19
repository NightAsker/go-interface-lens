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

function writeGo(directory, filename, source) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, filename), `${source.join('\n')}\n`);
}

function astReads(stats) {
    return {
        parsed: stats.parsed,
        memoryHits: stats.memoryHits,
        diskHits: stats.diskHits,
    };
}

async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reverse-prewarm-'));
    const root = path.join(tmp, 'workspace');
    const contractDir = path.join(root, 'contract');
    const modelDir = path.join(root, 'model');
    const aliasDir = path.join(root, 'alias');
    const implementationDir = path.join(root, 'implementation');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/prewarm\n\ngo 1.22\n');

    writeGo(modelDir, 'message.go', [
        'package model',
        'type MessageExt struct{}',
        'type OtherMessage struct{}',
    ]);
    writeGo(aliasDir, 'alias.go', [
        'package alias',
        'import model "example.com/prewarm/model"',
        'type ConsumeMessage = model.MessageExt',
    ]);
    const contractFile = path.join(contractDir, 'handler.go');
    const contractSource = [
        'package contract',
        'import "context"',
        'import model "example.com/prewarm/model"',
        'type Lifecycle interface { Close() error }',
        'type Handler interface {',
        '    Lifecycle',
        '    HandleMessage(context.Context, *model.MessageExt) error',
        '}',
        'type WrongHandler interface {',
        '    HandleMessage(context.Context, *model.OtherMessage) error',
        '}',
    ];
    writeGo(contractDir, 'handler.go', contractSource);

    const implementationFile = path.join(implementationDir, 'handler.go');
    const closeFile = path.join(implementationDir, 'close.go');
    writeGo(implementationDir, 'handler.go', [
        'package implementation',
        'import "context"',
        'import pb "example.com/prewarm/alias"',
        'type MessageSyncHandler struct{}',
        'func (*MessageSyncHandler) HandleMessage(context.Context, *pb.ConsumeMessage) error { return nil }',
    ]);
    writeGo(implementationDir, 'close.go', [
        'package implementation',
        'func (*MessageSyncHandler) Close() error { return nil }',
        'type ValueLifecycle struct{}',
        'func (ValueLifecycle) Close() error { return nil }',
    ]);

    // Enough independent files to force the adaptive worker pool above one
    // active parser while the complete workspace is prewarmed.
    for (let i = 0; i < 24; i++) {
        writeGo(path.join(root, `noise${i}`), 'noise.go', [
            `package noise${i}`,
            `type Noise${i} struct{}`,
            `func (Noise${i}) NoiseMethod${i}() int { return ${i} }`,
        ]);
    }

    const logs = [];
    const index = new WorkspaceIndex(
        () => ({
            excludedFolders: ['vendor'],
            excludedFilePatterns: [],
            excludedTypePatterns: [],
            searchDependencies: false,
            goModCache: '',
            astConcurrency: 4,
        }),
        (message) => logs.push(message),
        {
            cacheDir: path.join(tmp, 'cache'),
            prewarmBatchFiles: 4,
            postPrewarmWorkers: 1,
            memorySampleIntervalMs: 5,
        }
    );
    await index.ensureBuilt(root);

    console.log('== complete multi-worker reverse prewarm ==');
    assert('reverse prewarm API is available', typeof index.prewarmReverseInterfaces === 'function');
    const firstWarm = index.prewarmReverseInterfaces();
    const sharedWarm = index.prewarmReverseInterfaces();
    assert('concurrent prewarm requests share one promise', firstWarm === sharedWarm);
    const warmed = await firstWarm;
    assert('prewarm covers every workspace Go file', warmed.workspaceFiles >= 28);
    assert('prewarm computes concrete reverse relationships', warmed.relationships >= 3);
    assert(
        'prewarm computes concrete forward implementation relationships',
        warmed.implementationRelationships >= 2
    );
    eq('prewarm builds forward and reverse maps in one relationship pass', warmed.relationshipPasses, 1);
    assert('workspace prewarm uses multiple bounded batches', warmed.workspaceBatchCount > 1);
    assert(
        'every workspace batch respects the configured input-file limit',
        warmed.maxWorkspaceBatchInputFiles <= 4
    );
    eq('completed prewarm does not retain parsed AST files', warmed.retainedAstFiles, 0);
    eq('completed prewarm does not retain a semantic AST view', index._reversePrewarm.view, null);
    assert(
        'completed prewarm shrinks parser workers to its idle baseline',
        index.astPool.workers.length <= 1
    );
    assert(
        'relationship prewarm verifies narrowed interface/type candidates',
        warmed.relationshipCandidateChecks < warmed.receiverMethods * warmed.workspaceInterfaces
    );
    assert(
        'prewarm reports actionable phase timings',
        warmed.phaseTimings &&
            Number.isFinite(warmed.phaseTimings.workspaceAstMs) &&
            Number.isFinite(warmed.phaseTimings.relationshipMs)
    );
    assert('Tree-sitter prewarm uses multiple workers', index.getAstStats().maxActive > 1);
    assert(
        'prewarm completion is logged',
        logs.some((line) => line.includes('Workspace interface relation prewarm complete'))
    );
    assert(
        'prewarm logs peak RSS and its delta from the activation baseline',
        logs.some(
            (line) =>
                line.includes('Workspace interface relation prewarm memory:') &&
                line.includes('peakRss=') &&
                line.includes('rssDelta=')
        )
    );
    assert(
        'prewarm exposes sampled memory high-water statistics',
        warmed.memoryPeak &&
            Number.isFinite(warmed.memoryPeak.rssBytes) &&
            warmed.memoryPeak.rssBytes >= warmed.memoryBaseline.rssBytes
    );

    console.log('\n== prewarmed results are directly reusable ==');
    const beforeHandleQuery = astReads(index.getAstStats());
    const handleInterfaces = await index.findInterfacesAst('MessageSyncHandler', 'HandleMessage', {
        receiverFile: implementationFile,
    });
    eq('cross-package alias and embedded interface resolve completely', handleInterfaces.map((item) => item.name), ['Handler']);
    eq('prewarmed HandleMessage query performs no AST reads', astReads(index.getAstStats()), beforeHandleQuery);

    const beforeCloseQuery = astReads(index.getAstStats());
    const closeInterfaces = await index.findInterfacesAst('MessageSyncHandler', 'Close', {
        receiverFile: closeFile,
    });
    eq('embedded method is indexed for both interfaces', closeInterfaces.map((item) => item.name).sort(), ['Handler', 'Lifecycle']);
    eq('prewarmed Close query performs no AST reads', astReads(index.getAstStats()), beforeCloseQuery);
    assert('prewarm reports ready state', index.getReversePrewarmStats().ready === true);

    const beforeForwardMethodQuery = astReads(index.getAstStats());
    const lifecycleMethodImplementations = await index.findMethodImplementationsAst(
        'Lifecycle',
        'Close',
        contractFile
    );
    eq(
        'prewarmed interface method query resolves the concrete declaration',
        lifecycleMethodImplementations.map((item) => `${item.name}:${item.file}`).sort(),
        [`*MessageSyncHandler:${closeFile}`, `ValueLifecycle:${closeFile}`].sort()
    );
    eq(
        'prewarmed interface method query performs no AST reads',
        astReads(index.getAstStats()),
        beforeForwardMethodQuery
    );

    const beforeForwardQuery = astReads(index.getAstStats());
    const handlerImplementations = await index.findImplementationsAst('Handler', contractFile);
    eq(
        'prewarmed interface query returns its complete implementation set',
        handlerImplementations.map((item) => item.name),
        ['*MessageSyncHandler']
    );
    eq(
        'prewarmed interface query performs no AST reads',
        astReads(index.getAstStats()),
        beforeForwardQuery
    );

    const beforeValueForwardQuery = astReads(index.getAstStats());
    const lifecycleImplementations = await index.findImplementationsAst(
        'Lifecycle',
        contractFile
    );
    eq(
        'prewarmed interface query preserves pointer and value method sets',
        lifecycleImplementations.map((item) => item.name).sort(),
        ['*MessageSyncHandler', 'ValueLifecycle'].sort()
    );
    eq(
        'prewarmed value implementation query performs no AST reads',
        astReads(index.getAstStats()),
        beforeValueForwardQuery
    );

    const beforeNegativeForwardQuery = astReads(index.getAstStats());
    eq(
        'prewarmed interface query retains a complete negative result',
        await index.findImplementationsAst('WrongHandler', contractFile),
        []
    );
    eq(
        'prewarmed negative interface query performs no AST reads',
        astReads(index.getAstStats()),
        beforeNegativeForwardQuery
    );

    console.log('\n== persistent relationship snapshot ==');
    const restoredIndex = new WorkspaceIndex(
        () => ({
            excludedFolders: ['vendor'],
            excludedFilePatterns: [],
            excludedTypePatterns: [],
            searchDependencies: false,
            goModCache: '',
            astConcurrency: 4,
        }),
        () => {},
        { cacheDir: path.join(tmp, 'cache') }
    );
    await restoredIndex.ensureBuilt(root);
    restoredIndex._buildReversePrewarm = async () => {
        throw new Error('unchanged restart rebuilt relationships instead of restoring its snapshot');
    };
    const restoredWarm = await restoredIndex.prewarmReverseInterfaces();
    assert('unchanged restart restores the complete relationship snapshot', restoredWarm.snapshotRestored);
    assert(
        'snapshot restoration reports its own phase timing',
        Number.isFinite(restoredWarm.phaseTimings.snapshotReadMs)
    );
    const beforeRestoredQuery = astReads(restoredIndex.getAstStats());
    eq(
        'restored snapshot answers interface implementations directly',
        (await restoredIndex.findImplementationsAst('Handler', contractFile)).map(
            (item) => item.name
        ),
        ['*MessageSyncHandler']
    );
    eq(
        'restored relationship query performs no AST reads',
        astReads(restoredIndex.getAstStats()),
        beforeRestoredQuery
    );
    restoredIndex.dispose();

    console.log('\n== edits invalidate and rebuild the complete batched relation map ==');
    const changedContract = [...contractSource];
    changedContract.splice(changedContract.indexOf('}'), 0, '    Reset() error');
    const changedContractText = `${changedContract.join('\n')}\n`;
    fs.writeFileSync(contractFile, changedContractText);
    index.updateFileText(contractFile, changedContractText);
    assert('workspace edit invalidates ready prewarm results', index.getReversePrewarmStats().ready === false);
    const readsBeforeIncrementalWarm = astReads(index.getAstStats());
    const incrementallyWarmed = await index.prewarmReverseInterfaces();
    assert('edit rebuild remains batched after the old AST view is released', !incrementallyWarmed.incremental);
    assert('edit rebuild still uses multiple bounded batches', incrementallyWarmed.workspaceBatchCount > 1);
    assert(
        'edit rebuild retains no complete AST state',
        incrementallyWarmed.retainedAstFiles === 0 && index._reversePrewarm.view === null
    );
    assert(
        'batched rebuild uses the persistent AST cache for unchanged files',
        index.getAstStats().memoryHits + index.getAstStats().diskHits >
            readsBeforeIncrementalWarm.memoryHits + readsBeforeIncrementalWarm.diskHits
    );
    const beforeChangedQuery = astReads(index.getAstStats());
    const changedInterfaces = await index.findInterfacesAst('MessageSyncHandler', 'HandleMessage', {
        receiverFile: implementationFile,
    });
    eq('rebuilt relation map applies the complete changed method set', changedInterfaces, []);
    eq('rebuilt negative result also performs no AST reads', astReads(index.getAstStats()), beforeChangedQuery);
    const beforeChangedForwardQuery = astReads(index.getAstStats());
    eq(
        'rebuilt forward relation map removes an implementation with a missing method',
        await index.findImplementationsAst('Handler', contractFile),
        []
    );
    eq(
        'rebuilt forward negative result also performs no AST reads',
        astReads(index.getAstStats()),
        beforeChangedForwardQuery
    );

    index.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
