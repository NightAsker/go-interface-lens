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
const { runRipgrepFiles } = require('../src/file-search');
Module._resolveFilename = originalResolve;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-file-search-'));
const workspace = path.join(tmp, 'workspace');
const secondWorkspace = path.join(tmp, 'second-workspace');
const modCache = path.join(tmp, 'mod');
const dependency = path.join(modCache, 'github.com', 'acme', 'sdk@v1.2.0');
const oldDependency = path.join(modCache, 'github.com', 'acme', 'sdk@v1.0.0');
const localDependency = path.join(tmp, 'local-sdk');
const stdlib = path.join(tmp, 'go', 'src');
function write(root, relative, content = '') {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}
write(workspace, 'go.mod', 'module example.com/app\nrequire github.com/acme/sdk v1.2.0\nrequire example.com/local v0.0.0\nreplace example.com/local => ../local-sdk\n');
const client = write(workspace, 'pkg/client.go', 'needle target\n');
write(workspace, 'pkg/client_test.go', 'needle\n');
write(workspace, 'pkg/Client.JSON', 'needle\n');
write(workspace, 'pkg/client.pb.go');
write(workspace, 'pkg/special[1].go', 'needle [body]\n');
write(workspace, 'pkg/客户端😀.go');
write(workspace, 'pkg/client with\nnewline.go');
write(workspace, 'pkg/only-content.go', 'client needle\n');
write(workspace, 'client-directory/unrelated.go');
write(workspace, 'ignored/client.go');
write(workspace, '.ignore', 'ignored/\n');
write(workspace, 'pkg/.client-hidden.go');
write(secondWorkspace, 'go.mod', 'module example.com/second\n');
write(secondWorkspace, 'client.go', 'needle\n');
const sdkClient = write(dependency, 'api/client.go', 'needle\n');
write(dependency, 'client.yaml', 'needle\n');
write(oldDependency, 'old-client.go');
const localClient = write(localDependency, 'client.go', 'needle\n');
const standardClient = write(stdlib, 'net/http/client.go');
const service = new SourceSearchService({
    getWorkspaceRoots: () => [workspace, secondWorkspace],
    getConfig: () => ({ goModCache: modCache }),
});
function searchFiles(options, progress) {
    return service.search({
        ...options, query: '', fileNameQuery: options.query, fileNameRegex: !!(options.regex || options.useRegex),
    }, progress);
}
async function rejectsCode(promise, code, label) {
    let caught;
    try { await promise; } catch (error) { caught = error; }
    eq(label, caught?.code, code);
}

async function run() {
    console.log('== file name search with real ripgrep ==');
    const batches = [];
    const result = await searchFiles({ query: 'client', scope: 'all' }, { onBatch: (batch) => batches.push(...batch) });
    eq('streamed files agree with the final result without duplicates', batches.length, result.totalFiles);
    assert('workspace files are found by basename', result.results.some((file) => file.file === client && file.scope === 'workspace'));
    assert('second workspace is included', result.results.some((file) => file.file === path.join(secondWorkspace, 'client.go')));
    assert('non-Go file names are included', result.results.some((file) => file.name === 'Client.JSON') && result.results.some((file) => file.name === 'client.yaml'));
    assert('generated and test file names remain searchable', result.results.some((file) => file.name === 'client_test.go') && result.results.some((file) => file.name === 'client.pb.go'));
    assert('SDK locked version is included', result.results.some((file) => file.file === sdkClient && file.scope === 'dependency'));
    assert('local replace SDK is included', result.results.some((file) => file.file === localClient && file.scope === 'dependency'));
    assert('older SDK versions are excluded', !result.results.some((file) => file.file.startsWith(oldDependency + path.sep)));
    assert('content and parent directory names do not match', !result.results.some((file) => file.name === 'only-content.go' || file.name === 'unrelated.go'));
    assert('ignore files and hidden paths follow rg file listing rules', !result.results.some((file) => file.file.includes('/ignored/') || file.name === '.client-hidden.go'));
    assert('newline and spaces in file names survive enumeration', result.results.some((file) => file.name === 'client with\nnewline.go'));
    assert('workspace batches arrive before SDK batches', batches.slice(batches.findIndex((file) => file.scope === 'dependency')).every((file) => file.scope === 'dependency'));
    assert('display paths are relative to the owning SDK', result.results.some((file) => file.file === sdkClient && file.relativePath === path.join('api', 'client.go') && file.rootLabel === 'sdk@v1.2.0'));

    eq('anchored regex matches basenames across project and SDK', (await searchFiles({ query: '^client\\.go$', regex: true })).totalFiles, 4);
    eq('regex alternation searches generated and test file names', (await searchFiles({ query: '(_test|\\.pb)\\.go$', useRegex: true, scope: 'workspace' })).totalFiles, 2);
    eq('literal punctuation is escaped by default', (await searchFiles({ query: 'special[1].go', scope: 'workspace' })).totalFiles, 1);
    eq('case-sensitive matching is supported', (await searchFiles({ query: 'Client', caseSensitive: true, scope: 'workspace' })).totalFiles, 1);
    const unicode = await searchFiles({ query: '端😀', scope: 'workspace' });
    eq('Unicode filename ranges use JavaScript character offsets', unicode.results[0]?.fileNameRanges, [{ start: 2, end: 5 }]);
    eq('zero-width regex terminates and returns files', (await searchFiles({ query: '^', regex: true, scope: 'workspace' })).totalFiles > 0, true);
    eq('empty queries return no files', (await searchFiles({ query: '' })).totalFiles, 0);
    await rejectsCode(searchFiles({ query: '[', regex: true }), 'INVALID_REGEX', 'invalid regex is reported directly');
    const deps = await searchFiles({ query: 'client', scope: 'dependency' });
    assert('SDK-only search excludes workspace files', deps.totalFiles > 0 && deps.results.every((file) => file.scope === 'dependency'));
    eq('dependency setting disables SDK scans', (await searchFiles({ query: 'client', scope: 'dependency', config: { searchDependencies: false } })).totalFiles, 0);
    eq('standard library supports a dedicated scope', (await searchFiles({ query: '^client\\.go$', regex: true, scope: 'stdlib', stdlibRoot: stdlib })).results.map((file) => file.file), [standardClient]);
    const overlap = await searchFiles({ query: 'client', scope: 'workspace', workspaceRoots: [workspace, path.join(workspace, 'pkg')] });
    eq('overlapping workspace roots are deduplicated', overlap.totalFiles, new Set(overlap.results.map((file) => file.file)).size);

    console.log('\n== content, scope and file name use AND semantics ==');
    const combined = await service.search({ query: 'needle', fileNameQuery: '^client\\.go$', fileNameRegex: true, scope: 'workspace' });
    eq('all three conditions narrow results to matching workspace files', combined.results.map((file) => file.file).sort(), [client, path.join(secondWorkspace, 'client.go')].sort());
    assert('combined results retain content matches for navigation', combined.results.every((file) => !file.fileNameOnly && file.matches[0].text.includes('needle')));
    eq('a matching name does not bypass the content condition', (await service.search({ query: 'absent-content', fileNameQuery: 'client', scope: 'workspace' })).totalFiles, 0);
    eq('matching content does not bypass the name condition', (await service.search({ query: 'needle', fileNameQuery: 'absent-name', scope: 'workspace' })).totalFiles, 0);
    const sdkCombined = await service.search({ query: 'needle', fileNameQuery: '^client\\.go$', fileNameRegex: true, scope: 'dependency' });
    eq('SDK scope intersects content and name conditions', sdkCombined.results.map((file) => file.file).sort(), [sdkClient, localClient].sort());
    const yaml = await service.search({ query: 'needle', fileNameQuery: '^client\\.yaml$', fileNameRegex: true });
    eq('file name filters can select non-Go content', yaml.results.map((file) => file.file), [path.join(dependency, 'client.yaml')]);
    const caseSensitive = await service.search({ query: 'needle', fileNameQuery: 'Client', caseSensitive: true, scope: 'workspace' });
    eq('match case applies to both content and file names', caseSensitive.results.map((file) => file.file), [path.join(workspace, 'pkg', 'Client.JSON')]);
    eq('literal content and filename punctuation stay literal', (await service.search({ query: '[body]', fileNameQuery: 'special[1].go', scope: 'workspace' })).totalFiles, 1);
    eq('content regex is independent of the filename regex toggle', (await service.search({ query: 'needle\\s+target', regex: true, fileNameQuery: 'client.go', scope: 'workspace' })).totalFiles, 1);
    await rejectsCode(service.search({ query: 'needle', fileNameQuery: '[', fileNameRegex: true }), 'INVALID_REGEX', 'invalid filename regex is rejected during a content search');
    const filteredLimit = await service.search({ query: 'needle', fileNameQuery: '^client\\.yaml$', fileNameRegex: true, maxResults: 1 });
    eq('excluded filenames do not consume the shared result limit', filteredLimit.results[0]?.file, path.join(dependency, 'client.yaml'));
    service.getOpenDocuments = () => [client, path.join(workspace, 'pkg', 'only-content.go')].map((file) => ({
        uri: { fsPath: file }, isDirty: true, getText: () => 'unsaved-only',
    }));
    eq('filename filtering also applies to unsaved content', (await service.search({ query: 'unsaved-only', fileNameQuery: '^client\\.go$', fileNameRegex: true, scope: 'workspace' })).results.map((file) => file.file), [client]);
    service.getOpenDocuments = () => [{ uri: { fsPath: client }, isDirty: true, getText() { throw new Error('filename search must not read content'); } }];
    assert('filename-only search never reads open document contents', (await searchFiles({ query: 'client', scope: 'workspace' })).totalFiles > 0);
    service.getOpenDocuments = () => [];
    eq('source-search file exclusions also apply to filename results', (await searchFiles({ query: 'client', scope: 'workspace', config: { sourceSearchExcludedFilePatterns: ['client.go'] } })).results.some((file) => file.file === client), false);

    console.log('\n== fresh scans and limits ==');
    const added = write(workspace, 'added-client.txt');
    assert('new files appear on the next search', (await searchFiles({ query: 'client', scope: 'workspace' })).results.some((file) => file.file === added));
    fs.renameSync(added, path.join(workspace, 'renamed.txt'));
    assert('renamed files are removed on the next search', !(await searchFiles({ query: 'client', scope: 'workspace' })).results.some((file) => file.file === added));
    fs.unlinkSync(path.join(workspace, 'renamed.txt'));
    fs.writeFileSync(path.join(workspace, '.ignore'), 'pkg/\nignored/\n');
    assert('changed ignore rules take effect on the next search', !(await searchFiles({ query: 'client', scope: 'workspace' })).results.some((file) => file.file === client));
    fs.writeFileSync(path.join(workspace, '.ignore'), 'ignored/\n');
    const capped = await searchFiles({ query: 'client', config: { sourceSearchMaxFiles: 2 } });
    eq('file limit caps the number of results', capped.totalFiles, 2);
    assert('limit reports truncation and preserves project priority', capped.truncated && capped.results.every((file) => file.scope === 'workspace'));

    console.log('\n== streaming, cancellation and failure ==');
    let finish;
    let notify;
    const gate = new Promise((resolve) => { finish = resolve; });
    const received = new Promise((resolve) => { notify = resolve; });
    const streaming = new SourceSearchService({
        getWorkspaceRoots: () => [workspace],
        runRipgrepFiles: async (_command, args, _root, handlers) => {
            assert('file search enumerates paths without a content query', args.includes('--files') && args.includes('--null') && !args.includes('-e') && !args.includes('*.go'));
            handlers.onFile(client);
            await gate;
        },
    });
    const search = streaming.search({ query: '', fileNameQuery: 'client', scope: 'workspace' }, { onBatch(batch) { notify(batch); } });
    eq('first file streams before enumeration finishes', (await received)[0].file, client);
    finish();
    await search;
    streaming.dispose();

    const cancelled = new AbortController();
    cancelled.abort();
    await rejectsCode(searchFiles({ query: 'client' }, { signal: cancelled.signal }), 'SEARCH_CANCELLED', 'pre-cancelled search does not start');
    const liveCancel = new AbortController();
    let pid;
    let calls = 0;
    const script = "process.stdout.write(process.pid + '\\0'); setInterval(() => process.stdout.write('late\\0'), 10);";
    await rejectsCode(runRipgrepFiles(process.execPath, ['-e', script], { root: tmp }, {
        signal: liveCancel.signal,
        onFile(file) { pid = Number(path.basename(file)); calls++; liveCancel.abort(); },
    }), 'SEARCH_CANCELLED', 'cancellation stops a live filename stream');
    eq('no late paths are delivered after abort', calls, 1);
    let alive = true;
    try { process.kill(pid, 0); } catch (_) { alive = false; }
    assert('cancellation settles after the child exits', !alive);
    await rejectsCode(runRipgrepFiles(path.join(tmp, 'missing-rg'), [], { root: tmp }), 'ENOENT', 'missing ripgrep is reported');
    await rejectsCode(runRipgrepFiles(process.execPath, ['-e', 'process.exit(2)'], { root: tmp }), 'RIPGREP_FAILED', 'enumeration errors are reported');
    await rejectsCode(searchFiles({ query: 'client' }, { onBatch() { throw Object.assign(new Error('delivery failed'), { code: 'DELIVERY_FAILED' }); } }), 'DELIVERY_FAILED', 'batch delivery failures propagate');
    service.dispose();
    await rejectsCode(searchFiles({ query: 'client' }), 'SEARCH_CANCELLED', 'disposed search service rejects future queries');
}

run().then(done).catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
    service.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
});
