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
let excludedFolders = ['vendor'];
vscodeStub.workspace = Object.assign({}, realStub.workspace, {
    getConfiguration: () => ({
        get: (key, def) => {
            if (key === 'excludedFolders') return excludedFolders;
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
const { assert, eq, done } = require(path.join(__dirname, 'harness'));

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
        [
            'package processengine',
            'type Alias = interface { AliasMethod() }',
            'type Split interface',
            '{',
            'SplitMethod()',
            '}',
            'type Generic[P any] interface { GenericMethod(P) }',
            'type TypeSet interface { ~int | ~string }',
            'type EmbeddedTypeSet interface { TypeSet; ConstraintMethod() }',
            'type Mixed struct{}',
            'func (Mixed) AliasMethod() {}',
        ].join('\n')
    );
    const interfaceProvider = new extension._test.GoCodeLensProvider();
    const variantsDocument = fakeDocument(variantsPath);
    const interfaceLenses = await interfaceProvider.provideCodeLenses(variantsDocument);
    const implementationTargets = interfaceLenses
        .filter((lens) => lens.command.command === 'go-interface-lens.showImplementations')
        .map((lens) => lens.command.arguments[0]);
    console.log('\n== interface declaration variant lenses ==');
    assert('interface alias gets a lens', implementationTargets.includes('Alias'));
    assert('next-line interface brace gets a lens', implementationTargets.includes('Split'));
    assert('generic runtime interface gets a lens', implementationTargets.includes('Generic'));
    assert('type-set constraint does not get a lens', !implementationTargets.includes('TypeSet'));
    assert(
        'interface embedding a type set does not get a lens',
        !implementationTargets.includes('EmbeddedTypeSet')
    );
    assert(
        'one provider emits interface-method lenses from the shared AST',
        interfaceLenses.some(
            (lens) =>
                lens.command.command === 'go-interface-lens.showMethodImplementations' &&
                lens.command.arguments[0] === 'Alias' &&
                lens.command.arguments[1] === 'AliasMethod'
        )
    );
    assert(
        'one provider also emits receiver-method lenses from the shared AST',
        interfaceLenses.some(
            (lens) =>
                lens.command.command === 'go-interface-lens.gotoInterface' &&
                lens.command.arguments[0] === 'Mixed' &&
                lens.command.arguments[1] === 'AliasMethod'
        )
    );

    console.log('\n== shared document AST ==');
    const firstParsePromise = extension._test.parseDocument(variantsDocument);
    const cachedParsePromise = extension._test.parseDocument(variantsDocument);
    const firstParse = await firstParsePromise;
    const cachedParse = await cachedParsePromise;
    assert('same document version reuses its AST', firstParse === cachedParse);
    assert('same document version reuses its in-flight parse', firstParsePromise === cachedParsePromise);
    variantsDocument.version += 1;
    const changedParse = await extension._test.parseDocument(variantsDocument);
    assert('new document version invalidates its AST', changedParse !== cachedParse);

    const invalidBodyDocument = {
        version: 1,
        getText: () => 'package p\ntype Visible struct{}\nfunc (Visible) Run() { value := }\n',
    };
    const declarationParse = await extension._test.parseDocument(invalidBodyDocument);
    assert(
        'editor parsing retains method signatures',
        declarationParse.types.get('Visible').methods.has('Run')
    );
    assert(
        'editor parsing ignores syntax errors inside removed function bodies',
        !declarationParse.hasSyntaxError
    );

    let excludedDocumentReads = 0;
    const excludedDocument = {
        fileName: path.join(root, 'cache', 'overpass@v1.2.3', 'hidden.go'),
        uri: { fsPath: path.join(root, 'cache', 'overpass@v1.2.3', 'hidden.go') },
        version: 1,
        getText: () => {
            excludedDocumentReads += 1;
            return 'package hidden\ntype Hidden interface { Run() }\n';
        },
    };
    excludedFolders = ['*overpass*'];
    eq(
        'folder wildcard suppresses CodeLens before document parsing',
        await interfaceProvider.provideCodeLenses(excludedDocument),
        []
    );
    eq('excluded editor document never reaches Tree-sitter', excludedDocumentReads, 0);
    excludedFolders = ['vendor'];

    let backgroundBuilds = 0;
    extension._test.setWorkspaceIndex({
        ensureBuilt: async () => {
            backgroundBuilds += 1;
        },
    });
    await interfaceProvider.provideCodeLenses(fakeDocument(variantsPath));
    await new Promise((resolve) => setTimeout(resolve, 10));
    console.log('\n== interface-only file remains lazy ==');
    assert('rendering interface lenses performs no background workspace build', backgroundBuilds === 0);
    extension._test.setWorkspaceIndex(idx);

    idx.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
