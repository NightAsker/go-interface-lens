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

async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-interface-lazy-deps-'));
    const root = path.join(tmp, 'project');
    const modCache = path.join(tmp, 'pkg', 'mod');
    const depDir = path.join(modCache, 'example.com', 'dep@v1.0.0');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(depDir, { recursive: true });
    fs.writeFileSync(
        path.join(root, 'go.mod'),
        'module example.com/project\n\ngo 1.22\n\nrequire example.com/dep v1.0.0\n'
    );
    const implementationFile = path.join(root, 'impl.go');
    fs.writeFileSync(
        implementationFile,
        'package project\ntype ExternalImpl struct{}\nfunc (ExternalImpl) ExternalOnly(value string) error { return nil }\n'
    );
    fs.writeFileSync(path.join(depDir, 'go.mod'), 'module example.com/dep\n\ngo 1.22\n');
    const dependencyFile = path.join(depDir, 'external.go');
    fs.writeFileSync(
        dependencyFile,
        'package dep\ntype External interface { ExternalOnly(value string) error }\n'
    );

    const config = () => ({
        excludedFolders: ['vendor'],
        excludedFilePatterns: [],
        excludedTypePatterns: [],
        searchDependencies: true,
        goModCache: modCache,
        astConcurrency: 2,
    });
    const index = new WorkspaceIndex(config, () => {}, { cacheDir: path.join(tmp, 'cache') });
    await index.ensureBuilt(root);

    console.log('== lazy AST dependency filtering ==');
    const interfaces = await index.findInterfacesAst('ExternalImpl', 'ExternalOnly', {
        receiverFile: implementationFile,
    });
    eq('module-cache interface found through AST filtering', interfaces.map((result) => result.name), ['External']);
    assert('dependency result marked external', interfaces[0].external);
    assert('dependency navigation points at locked module version', interfaces[0].file === dependencyFile);

    index.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
