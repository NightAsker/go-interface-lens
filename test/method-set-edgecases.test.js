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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-interface-method-sets-'));
    const root = path.join(tmp, 'project');
    const apiDir = path.join(root, 'api');
    const implDir = path.join(root, 'impl');
    const pbDir = path.join(root, 'pb');
    const promotionDir = path.join(root, 'promotion');
    const protoDir = path.join(root, 'proto');
    const typesDir = path.join(root, 'types');
    fs.mkdirSync(apiDir, { recursive: true });
    fs.mkdirSync(implDir, { recursive: true });
    fs.mkdirSync(pbDir, { recursive: true });
    fs.mkdirSync(promotionDir, { recursive: true });
    fs.mkdirSync(protoDir, { recursive: true });
    fs.mkdirSync(typesDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/methodsets\n\ngo 1.23\n');

    fs.writeFileSync(path.join(protoDir, 'message.go'), 'package proto\ntype MessageExt struct{}\n');
    fs.writeFileSync(
        path.join(typesDir, 'message.go'),
        [
            'package types',
            'import "example.com/methodsets/proto"',
            'type MessageExt struct {',
            '    proto.MessageExt',
            '    Consumer int',
            '}',
        ].join('\n')
    );
    fs.writeFileSync(
        path.join(pbDir, 'alias.go'),
        [
            'package pb',
            'import "example.com/methodsets/types"',
            'type ConsumeMessage = types.MessageExt',
        ].join('\n')
    );

    const interfaceFile = path.join(apiDir, 'contracts.go');
    const interfaceSource = [
        'package api',
        'import "context"',
        'import "example.com/methodsets/types"',
        'type Sealed interface {',
        '    hidden()',
        '    Visible()',
        '}',
        'type Carrier struct{}',
        'func (Carrier) hidden() {}',
        'func (Carrier) Visible() {}',
        'type Workflow interface { Step(); Finish() }',
        'type Stepper interface { Step() }',
        'type Runner interface { Run() }',
        'type IHandler interface {',
        '    HandleMessage(context.Context, *types.MessageExt) error',
        '}',
    ];
    fs.writeFileSync(interfaceFile, interfaceSource.join('\n'));

    const implementationFile = path.join(implDir, 'implementations.go');
    fs.writeFileSync(
        implementationFile,
        [
            'package impl',
            'import "context"',
            'import "example.com/methodsets/api"',
            'import "example.com/methodsets/pb"',
            'type Direct struct{}',
            'func (Direct) hidden() {}',
            'func (Direct) Visible() {}',
            'type Embedded struct { api.Carrier }',
            'type Partial struct{}',
            'func (Partial) Step() {}',
            'type MessageSyncHandler struct{}',
            'func (*MessageSyncHandler) HandleMessage(ctx context.Context, msg *pb.ConsumeMessage) error {',
            '    return nil',
            '}',
        ].join('\n')
    );

    const promotionFile = path.join(promotionDir, 'promotion.go');
    const promotionSource = [
        'package promotion',
        'type Deep struct{}',
        'func (Deep) Run() {}',
        'type Branch struct { Deep }',
        'type Middle struct { Branch }',
        'type Shallow struct{}',
        'func (Shallow) Run() {}',
        'type ShallowerWins struct { Middle; Shallow }',
        'type ShadowedByField struct { Deep; Run int }',
        'type Other struct{}',
        'func (Other) Run() {}',
        'type Ambiguous struct { Deep; Other }',
    ];
    fs.writeFileSync(promotionFile, promotionSource.join('\n'));

    const config = () => ({
        excludedFolders: [],
        excludedFilePatterns: [],
        excludedTypePatterns: [],
        searchDependencies: false,
        goModCache: '',
        astConcurrency: 2,
    });
    const index = new WorkspaceIndex(config, () => {}, { cacheDir: path.join(tmp, 'cache') });
    await index.ensureBuilt(root);

    console.log('== unexported method identity includes the declaring package ==');
    const sealed = (await index.findImplementationsAst('Sealed', interfaceFile))
        .map((result) => result.name)
        .sort();
    eq('direct cross-package private method does not implement a sealed interface', sealed, [
        'Carrier',
        'Embedded',
    ]);

    const hiddenMethods = await index.findMethodImplementationsAst(
        'Sealed',
        'hidden',
        interfaceFile
    );
    eq(
        'private method navigation excludes a same-spelled method from another package',
        hiddenMethods.map((result) => result.name).sort(),
        ['Carrier', 'Embedded']
    );
    const embeddedHidden = hiddenMethods.find((result) => result.name === 'Embedded');
    assert(
        'promoted private method keeps the original package identity and declaration location',
        embeddedHidden &&
            embeddedHidden.file === interfaceFile &&
            embeddedHidden.line === interfaceSource.indexOf('func (Carrier) hidden() {}')
    );

    const directInterfaces = await index.findInterfacesAst('Direct', 'hidden', {
        receiverFile: implementationFile,
    });
    assert(
        'reverse lookup does not cross package boundaries for private methods',
        !directInterfaces.some((result) => result.name === 'Sealed')
    );
    const carrierInterfaces = await index.findInterfacesAst('Carrier', 'hidden', {
        receiverFile: interfaceFile,
    });
    assert(
        'reverse lookup still matches private methods inside their declaring package',
        carrierInterfaces.some((result) => result.name === 'Sealed')
    );

    console.log('\n== reverse lookup requires the complete interface method set ==');
    const partialInterfaces = (
        await index.findInterfacesAst('Partial', 'Step', { receiverFile: implementationFile })
    )
        .map((result) => result.name)
        .sort();
    eq('a matching anchor method is insufficient when another method is missing', partialInterfaces, [
        'Stepper',
    ]);

    console.log('\n== reverse lookup expands aliases from the receiver signature ==');
    const handlers = await index.findImplementationsAst('IHandler', interfaceFile);
    assert(
        'forward lookup resolves a cross-package alias in the implementation signature',
        handlers.some((result) => result.name === '*MessageSyncHandler')
    );
    const handlerInterfaces = await index.findInterfacesAst(
        'MessageSyncHandler',
        'HandleMessage',
        { receiverFile: implementationFile }
    );
    assert(
        'reverse lookup resolves the same cross-package alias from the receiver signature',
        handlerInterfaces.some((result) => result.name === 'IHandler')
    );

    console.log('\n== promoted selectors honor fields, depth, and ambiguity ==');
    const runners = (await index.findImplementationsAst('Runner', interfaceFile))
        .map((result) => result.name)
        .sort();
    assert('the unique shallower method wins over a deeper promoted method', runners.includes('ShallowerWins'));
    assert('a named field shadows a promoted method with the same name', !runners.includes('ShadowedByField'));
    assert('two methods at the same shallowest depth remain ambiguous', !runners.includes('Ambiguous'));

    const runMethods = await index.findMethodImplementationsAst('Runner', 'Run', interfaceFile);
    const shallower = runMethods.find((result) => result.name === 'ShallowerWins');
    assert(
        'method navigation follows the shallowest contributing declaration',
        shallower &&
            shallower.file === promotionFile &&
            shallower.line === promotionSource.indexOf('func (Shallow) Run() {}')
    );

    index.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
