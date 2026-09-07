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
const { createFolderMatcher } = require('../src/path-filter');
const {
    grepImplementationFilesForMethod,
    grepInterfaceFilesForMethod,
    grepGoFilesForTypeNames,
} = require('../src/search');
const { assert, eq, done } = require('./harness');

function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

async function main() {
    console.log('== excluded folder wildcard matching ==');
    const matcher = createFolderMatcher([
        'vendor',
        '*overpass*',
        'generated-?',
        'code.byted.org/client-*',
    ]);
    assert('exact folder names remain supported', matcher('/project/vendor/pkg'));
    assert(
        'star matches a keyword inside a versioned module directory',
        matcher('/go/pkg/mod/code.byted.org/overpass@v1.2.3/client')
    );
    assert('question mark matches one directory character', matcher('/project/generated-a'));
    assert('question mark does not match multiple characters', !matcher('/project/generated-api'));
    assert(
        'slash-containing patterns match a directory subpath at any depth',
        matcher('/go/pkg/mod/code.byted.org/client-http@v2.0.0/internal')
    );
    assert('unrelated directory paths remain enabled', !matcher('/project/pkg/service'));

    console.log('\n== excluded paths never enter Tree-sitter requests ==');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-interface-folder-exclusions-'));
    const root = path.join(tmp, 'project');
    const allowedFile = path.join(root, 'allowed', 'worker.go');
    const excludedFile = path.join(
        root,
        'cache',
        'code.byted.org',
        'overpass@v1.2.3',
        'worker.go'
    );
    write(path.join(root, 'go.mod'), 'module example.com/project\n\ngo 1.22\n');
    write(
        allowedFile,
        'package allowed\ntype Worker struct{}\nfunc (Worker) Run() error { return nil }\n'
    );
    write(
        excludedFile,
        'package overpass\ntype Hidden struct{}\nfunc (Hidden) Run() error { return nil }\n'
    );

    const settings = {
        excludedFolders: ['*overpass*'],
        excludedFilePatterns: [],
        excludedTypePatterns: [],
        excludedPackagePatterns: [],
        searchDependencies: false,
        goModCache: '',
        astConcurrency: 1,
    };
    const index = new WorkspaceIndex(() => settings, () => {});
    await index.ensureBuilt(root);
    eq('registering a root does not read workspace source files', index.files.size, 0);
    const candidates = await index._workspaceCandidateFiles('implementation', 'Run');
    assert('allowed workspace file is found on demand', candidates.includes(allowedFile));
    assert('wildcard-matched workspace file is not a candidate', !candidates.includes(excludedFile));

    const packageKey = 'stale-candidate-package';
    index._packageFiles.set(packageKey, new Set([allowedFile, excludedFile]));
    const originalParseFiles = index.astPool.parseFiles.bind(index.astPool);
    let received = [];
    index.astPool.parseFiles = async (requests) => {
        received = requests.map((request) => request.file);
        return new Map();
    };
    await index._parseAstPackages(new Set([packageKey]), 200);
    eq('AST request keeps the allowed file only', received, [allowedFile]);
    assert('stale excluded candidates are blocked before Tree-sitter', !received.includes(excludedFile));
    index.astPool.parseFiles = originalParseFiles;

    console.log('\n== path exclusions precede candidate source reads ==');
    const excludedByFile = path.join(root, 'allowed', 'worker_mock.go');
    const excludedByPackage = path.join(root, 'private', 'generated', 'worker.go');
    const excludedByComplexFolder = path.join(root, 'client-http', 'nested', 'generated', 'worker.go');
    const excludedByLiteralFolder = path.join(root, '[skip]', 'worker.go');
    const allowedSimilarFolder = path.join(root, 'worker_mock.go', 'worker.go');
    const allowedSimilarName = path.join(root, 'overpass.go');
    const allowedLiteralName = path.join(root, 's', 'worker.go');
    const included = [allowedFile, allowedSimilarFolder, allowedSimilarName, allowedLiteralName].sort();
    const excluded = [excludedFile, excludedByFile, excludedByPackage, excludedByComplexFolder, excludedByLiteralFolder];
    const source = [
        'package sample',
        'type Worker struct{}',
        'func (Worker) Run() error { return nil }',
        'type Service interface { Run() error }',
        'type Related = Worker',
    ].join('\n');
    for (const file of [...included, ...excluded]) write(file, source);
    settings.excludedFolders = ['*overpass*', 'client-*/generated', '[skip]'];
    settings.excludedFilePatterns = ['_mock.go'];
    settings.excludedPackagePatterns = ['example.com/project/private/*'];
    const arity = { params: 0, results: 1 };
    const readFile = fs.promises.readFile;
    let reads = [];
    fs.promises.readFile = async function (file, ...args) {
        if (String(file).endsWith('.go')) reads.push(String(file));
        return readFile.call(this, file, ...args);
    };
    try {
        for (const kind of ['implementation', 'interface']) {
            reads = [];
            const found = await index._workspaceCandidateFiles(kind, 'Run', arity);
            eq(`${kind} search retains allowed paths`, found.sort(), included);
            eq(`${kind} arity prefilter reads only allowed files`, reads.sort(), included);
        }
        for (const method of ['_dependencyImplementationCandidates', '_dependencyInterfaceCandidates']) {
            reads = [];
            const found = await index[method](root, 'Run', [root], arity);
            eq(`${method} retains allowed paths`, found.sort(), included);
            eq(`${method} skips excluded source reads`, reads.sort(), included);
        }
        eq('workspace type-reference candidates honor the same exclusions',
            (await index._workspaceTypeReferenceCandidates(['Worker'])).sort(), included);
        eq('dependency type-reference candidates honor the same exclusions',
            (await index._dependencyTypeReferenceCandidates(root, ['Worker'], [root])).sort(), included);
    } finally {
        fs.promises.readFile = readFile;
    }

    console.log('\n== directory glob pushdown and bounded results ==');
    for (const search of [grepImplementationFilesForMethod, grepInterfaceFilesForMethod]) {
        const found = await search(root, 'Run', 100, undefined, undefined, undefined,
            { excludedFolders: ['*overpass*'] });
        assert(`${search.name} excludes directories in ripgrep without a result predicate`, !found.includes(excludedFile));
        assert(`${search.name} retains similarly named files`, found.includes(allowedSimilarName));
        eq(`${search.name} handles an explicitly excluded search root`,
            await search(path.dirname(excludedFile), 'Run', 100, undefined, arity, undefined,
                { excludedFolders: ['*overpass*'] }), []);
        eq(`${search.name} filters before applying the result cap`,
            await search(root, 'Run', 1, undefined, arity, undefined,
                { includeFile: (file) => file === allowedFile }), [allowedFile]);
    }
    assert('type-reference ripgrep skips excluded directories',
        !(await grepGoFilesForTypeNames(root, ['Worker'], 100, undefined, undefined,
            { excludedFolders: ['*overpass*'] })).includes(excludedFile));

    console.log('\n== file and folder settings change candidate cache identities ==');
    const oldWorkspace = index._workspaceCandidateFiles('implementation', 'Run', arity);
    const oldDependency = index._dependencyImplementationCandidates(root, 'Run', [root], arity);
    settings.excludedFilePatterns = [];
    const newWorkspace = index._workspaceCandidateFiles('implementation', 'Run', arity);
    const newDependency = index._dependencyImplementationCandidates(root, 'Run', [root], arity);
    assert('file rule changes refresh workspace candidate searches', oldWorkspace !== newWorkspace);
    assert('file rule changes refresh dependency candidate searches', oldDependency !== newDependency);
    assert('removing the file rule restores its candidates', (await newWorkspace).includes(excludedByFile));
    await newDependency;
    settings.excludedFolders = [];
    const withFolders = index._dependencyImplementationCandidates(root, 'Run', [root], arity);
    assert('folder rule changes refresh dependency candidate searches', newDependency !== withFolders);
    assert('removing the folder rule restores its candidates', (await withFolders).includes(excludedFile));

    index.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
