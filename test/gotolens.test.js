'use strict';

// Verifies that declaration AST CodeLenses appear immediately. Exact interface
// matching happens lazily after click.

const path = require('path');
const fs = require('fs');
const os = require('os');

// Extend the shared headless `vscode` stub with the few APIs the CodeLens
// provider and extension activation touch. We install our own resolver so the
// additions live only in this test process.
const Module = require('module');
const origResolve = Module._resolveFilename;
const realStub = require(path.join(__dirname, 'vscode-stub.js'));

class Range {
    constructor(sl, sc, el, ec) {
        this.start = { line: sl, character: sc };
        this.end = { line: el, character: ec };
    }
}
class CodeLens {
    constructor(range, command) {
        this.range = range;
        this.command = command;
    }
}
class EventEmitter {
    constructor() {
        this.event = () => ({ dispose() {} });
    }
    fire() {}
}

const vscodeStub = Object.assign({}, realStub, {
    Range,
    CodeLens,
    EventEmitter,
    Position: class {
        constructor(l, c) {
            this.line = l;
            this.character = c;
        }
    },
    Selection: class {
        constructor(a, b) {
            this.anchor = a;
            this.active = b;
        }
    },
    languages: { registerCodeLensProvider: () => ({ dispose() {} }) },
    commands: { registerCommand: () => ({ dispose() {} }) },
});
// getConfiguration is read by extension.js; provide a permissive config.
vscodeStub.workspace = Object.assign({}, realStub.workspace, {
    getConfiguration: () => ({
        get: (key, def) => {
            if (key === 'excludedFolders') return ['vendor'];
            if (key === 'excludedFilePatterns') return [];
            if (key === 'excludedTypePatterns') return [];
            if (key === 'searchDependencies') return false;
            if (key === 'goModCache') return '';
            return def;
        },
    }),
    getWorkspaceFolder: () => undefined,
});

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'vscode') return vscodeStub;
    return origLoad.call(this, request, ...rest);
};
// Keep origResolve referenced (satisfies lint) though _load short-circuits vscode.
void origResolve;

const { WorkspaceIndex } = require(path.join(__dirname, '..', 'src', 'indexer'));
const extension = require(path.join(__dirname, '..', 'extension.js'));
const { assert, done } = require(path.join(__dirname, 'harness'));

// A fake document over a real on-disk Go file.
function fakeDocument(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split('\n');
    return {
        uri: { fsPath: filePath, scheme: 'file' },
        fileName: filePath,
        version: 1,
        getText: () => text,
        lineAt: (i) => ({ text: lines[i] || '' }),
    };
}

async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gotolens-'));
    const root = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(root, 'penalty'), { recursive: true });

    fs.writeFileSync(
        path.join(root, 'iface.go'),
        ['package processengine', 'type FlowContext struct{}', 'type Action interface { ExecuteAction(context *FlowContext) }'].join('\n')
    );
    const implPath = path.join(root, 'penalty', 'p.go');
    fs.writeFileSync(
        implPath,
        [
            'package penalty',
            'import "x/processengine"',
            'type PenaltyPushBackboneActionV2 struct{}',
            // Has a matching interface (Action).
            'func (',
            '    action *PenaltyPushBackboneActionV2,',
            ') ExecuteAction(context *processengine.FlowContext) {}',
            'type Lonely struct{}',
            // No interface declares this method; the action still appears and
            // the lazy AST query returns an empty result after click.
            'func (l *Lonely) NoSuchInterfaceMethod(x int) string { return "" }',
        ].join('\n')
    );

    const cfg = () => ({
        excludedFolders: ['vendor'],
        excludedFilePatterns: [],
        excludedTypePatterns: [],
        searchDependencies: false,
        goModCache: '',
    });
    const idx = new WorkspaceIndex(cfg, () => {});
    await idx.ensureBuilt(root);
    // Inject our prebuilt index and make resolveSearchRoots resolve to exactly
    // `root` (so areRootsBuilt matches the root we built). getWorkspaceFolder
    // must return the owning folder, otherwise resolveSearchRoots also appends
    // the file's own directory as a separate (unbuilt) root.
    extension._test.setWorkspaceIndex(idx);
    const folder = { uri: { fsPath: root } };
    vscodeStub.workspace.workspaceFolders = [folder];
    vscodeStub.workspace.getWorkspaceFolder = () => folder;

    const provider = new extension._test.GoGotoInterfaceLensProvider();
    const lenses = await provider.provideCodeLenses(fakeDocument(implPath), { isCancellationRequested: false });
    const titles = lenses.map((l) => `${l.command.arguments[0]}.${l.command.arguments[1]}`);

    console.log('== immediate AST goto-interface lenses ==');
    console.log('  lenses for:', titles);
    assert(
        'lens shown for method WITH a matching interface',
        titles.includes('PenaltyPushBackboneActionV2.ExecuteAction')
    );
    assert(
        'lens shown before lazy AST checks a method with no interface',
        titles.includes('Lonely.NoSuchInterfaceMethod')
    );

    const variantsPath = path.join(root, 'variants.go');
    fs.writeFileSync(
        variantsPath,
        ['package processengine', 'type Alias = interface { AliasMethod() }', 'type Split interface', '{', 'SplitMethod()', '}'].join('\n')
    );
    const interfaceProvider = new extension._test.GoInterfaceLensProvider();
    const variantsDocument = fakeDocument(variantsPath);
    const interfaceLenses = interfaceProvider.provideCodeLenses(variantsDocument);
    const implementationTargets = interfaceLenses
        .filter((lens) => lens.command.command === 'go-interface-lens.showImplementations')
        .map((lens) => lens.command.arguments[0]);
    console.log('\n== interface declaration variant lenses ==');
    assert('interface alias gets a lens', implementationTargets.includes('Alias'));
    assert('next-line interface brace gets a lens', implementationTargets.includes('Split'));

    console.log('\n== shared document AST ==');
    const firstParse = extension._test.parseDocument(variantsDocument);
    const cachedParse = extension._test.parseDocument(variantsDocument);
    assert('same document version reuses its AST', firstParse === cachedParse);
    variantsDocument.version += 1;
    const changedParse = extension._test.parseDocument(variantsDocument);
    assert('new document version invalidates its AST', changedParse !== cachedParse);

    let prewarmCalls = 0;
    let workerWarmupCalls = 0;
    extension._test.setWorkspaceIndex({
        areRootsBuilt: () => false,
        ensureBuilt: async () => {
            prewarmCalls += 1;
        },
        warmAstWorkers: async () => {
            workerWarmupCalls += 1;
        },
    });
    interfaceProvider.provideCodeLenses(fakeDocument(variantsPath));
    await new Promise((resolve) => setImmediate(resolve));
    console.log('\n== interface-only file prewarming ==');
    assert('interface lens starts one background workspace build', prewarmCalls === 1);
    assert('interface lens warms AST workers after the workspace build', workerWarmupCalls === 1);
    extension._test.setWorkspaceIndex(idx);

    idx.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
