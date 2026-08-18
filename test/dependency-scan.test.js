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
const { scanDependencyFilesForMethods } = require('../src/search');
const { assert, eq, done } = require('./harness');

async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-interface-dependency-scan-'));
    const modCache = path.join(tmp, 'pkg', 'mod');
    const depDir = path.join(modCache, 'example.com', 'dep@v1.0.0');
    fs.mkdirSync(depDir, { recursive: true });

    const directFile = path.join(depDir, 'direct.go');
    const multilineFile = path.join(depDir, 'multiline.go');
    const interfaceFile = path.join(depDir, 'interfaces.go');
    fs.writeFileSync(
        directFile,
        [
            'package dep',
            'type Direct struct{}',
            'func (Direct) DirectMethod() {}',
        ].join('\n') + '\n'
    );
    fs.writeFileSync(
        multilineFile,
        [
            'package dep',
            'type Multiline struct{}',
            'func (',
            '    receiver *Multiline',
            ') HandleMessage(value string) error { return nil }',
        ].join('\n') + '\n'
    );
    fs.writeFileSync(
        interfaceFile,
        [
            'package dep',
            'type Inline interface { InlineMethod(); Other() }',
            'type Expanded interface {',
            '    HandleMessage(',
            '        value string,',
            '    ) error',
            '}',
        ].join('\n') + '\n'
    );

    console.log('== line-oriented dependency method scan ==');
    const scanned = await scanDependencyFilesForMethods(
        modCache,
        ['DirectMethod', 'HandleMessage', 'InlineMethod'],
        100,
        [depDir]
    );
    assert('successful scan is explicitly complete', scanned.complete === true);
    assert('successful scan is not marked timed out', scanned.timedOut === false);
    assert(
        'direct receiver method is mapped to its source file',
        scanned.filesByMethod.get('DirectMethod').has(directFile)
    );
    assert(
        'multiline receiver method is retained by compensation parsing',
        scanned.filesByMethod.get('HandleMessage').has(multilineFile)
    );
    assert(
        'multiline interface method remains a dependency candidate',
        scanned.filesByMethod.get('HandleMessage').has(interfaceFile)
    );
    assert(
        'compact inline interface method remains a dependency candidate',
        scanned.filesByMethod.get('InlineMethod').has(interfaceFile)
    );
    assert(
        'only multiline receiver candidates require compensation',
        scanned.multilineFiles === 1
    );

    console.log('\n== incomplete command output ==');
    const partialMessage = JSON.stringify({
        type: 'match',
        data: {
            path: { text: directFile },
            lines: { text: 'func (Direct) DirectMethod() {}\n' },
        },
    });
    const incomplete = await scanDependencyFilesForMethods(
        modCache,
        ['DirectMethod'],
        100,
        [depDir],
        {
            execute: async () => ({
                stdout: partialMessage,
                complete: false,
                timedOut: true,
                error: new Error('timed out'),
            }),
        }
    );
    assert('partial stdout is marked incomplete', incomplete.complete === false);
    assert('timeout metadata survives candidate parsing', incomplete.timedOut === true);
    assert(
        'partial candidates may be retained for local work without claiming completeness',
        incomplete.filesByMethod.get('DirectMethod').has(directFile)
    );

    console.log('\n== persistent immutable dependency candidates ==');
    const cacheDir = path.join(tmp, 'cache');
    const config = () => ({
        excludedFolders: [],
        excludedFilePatterns: [],
        excludedTypePatterns: [],
        searchDependencies: true,
        goModCache: modCache,
        astConcurrency: 2,
    });
    const firstIndex = new WorkspaceIndex(config, () => {}, { cacheDir });
    const first = await firstIndex._dependencyImplementationBatchCandidates(
        modCache,
        ['DirectMethod'],
        [depDir]
    );
    assert('first immutable dependency scan is complete', first.complete === true);
    assert('first immutable dependency scan is not a disk hit', first.cached !== true);
    firstIndex.dispose();

    fs.unlinkSync(directFile);
    const restoredIndex = new WorkspaceIndex(config, () => {}, { cacheDir });
    const restored = await restoredIndex._dependencyImplementationBatchCandidates(
        modCache,
        ['DirectMethod'],
        [depDir]
    );
    assert('dependency candidate scan restores from persistent cache', restored.cached === true);
    eq('persistent candidate cache restores the original file', restored.files, [directFile]);
    restoredIndex.dispose();

    const clearIndex = new WorkspaceIndex(config, () => {}, { cacheDir });
    clearIndex.clear();
    assert(
        'cache clear removes dependency candidates before they are loaded in this process',
        !fs
            .readdirSync(cacheDir)
            .some((file) => file.startsWith('dependency-candidates-'))
    );
    clearIndex.dispose();

    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
