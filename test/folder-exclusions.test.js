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

    index.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
