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
        { cacheDir: path.join(tmp, 'cache') }
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
    assert('Tree-sitter prewarm uses multiple workers', index.getAstStats().maxActive > 1);
    assert('prewarm completion is logged', logs.some((line) => line.includes('Reverse interface prewarm complete')));

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

    console.log('\n== edits invalidate and rebuild the complete relation map ==');
    const changedContract = [...contractSource];
    changedContract.splice(changedContract.indexOf('}'), 0, '    Reset() error');
    const changedContractText = `${changedContract.join('\n')}\n`;
    fs.writeFileSync(contractFile, changedContractText);
    index.updateFileText(contractFile, changedContractText);
    assert('workspace edit invalidates ready prewarm results', index.getReversePrewarmStats().ready === false);
    await index.prewarmReverseInterfaces();
    const beforeChangedQuery = astReads(index.getAstStats());
    const changedInterfaces = await index.findInterfacesAst('MessageSyncHandler', 'HandleMessage', {
        receiverFile: implementationFile,
    });
    eq('rebuilt relation map applies the complete changed method set', changedInterfaces, []);
    eq('rebuilt negative result also performs no AST reads', astReads(index.getAstStats()), beforeChangedQuery);

    index.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
