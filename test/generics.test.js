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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-interface-generics-'));
    const root = path.join(tmp, 'project');
    const apiDir = path.join(root, 'api');
    const payloadDir = path.join(root, 'payload');
    const implDir = path.join(root, 'impl');
    fs.mkdirSync(apiDir, { recursive: true });
    fs.mkdirSync(payloadDir, { recursive: true });
    fs.mkdirSync(implDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/generics\n\ngo 1.23\n');

    const payloadFile = path.join(payloadDir, 'payload.go');
    fs.writeFileSync(
        payloadFile,
        [
            'package payload',
            'type AsyncTaskPayload interface {',
            '    GetTaskType() string',
            '    GetSlotKey() string',
            '}',
        ].join('\n')
    );

    const interfaceFile = path.join(apiDir, 'task.go');
    fs.writeFileSync(
        interfaceFile,
        [
            'package api',
            'import "context"',
            'import "encoding/json"',
            'import "example.com/generics/payload"',
            'type SingleStepTask[P payload.AsyncTaskPayload] interface {',
            '    Decode(context.Context, []byte) (P, error)',
            '    Validate(context.Context, P) error',
            '    Identity(P) string',
            '    Execute(context.Context, P) (json.RawMessage, error)',
            '}',
            'type Base[P any] interface { Put(P); Get() P }',
            'type Combined[P any] interface {',
            '    Base[P]',
            '    Channel(chan P)',
            '    Shape(struct { Value P })',
            '    Transform(map[string][]P) []P',
            '}',
            'type Pair[A, B any] interface { Join(A, map[A][]B) B }',
            'type Scalar interface { ~int | ~string }',
            'type ScalarTask[P Scalar] interface { ScalarValue(P) P }',
            'type ComparableTask[P interface { comparable }] interface { ComparableValue(P) P }',
            'type SliceOrStringTask[P ~[]byte | ~string] interface { SliceOrStringValue(P) P }',
            'type ExactIntTask[P int] interface { ExactIntValue(P) P }',
            'type DependentTask[A any, B ~[]A] interface { DependentValue(A, B) }',
            'type TextPayload interface { ~string; GetTaskType() string }',
            'type TextPayloadTask[P TextPayload] interface { TextPayloadValue(P) }',
        ].join('\n')
    );

    const implementationFile = path.join(implDir, 'task.go');
    fs.writeFileSync(
        implementationFile,
        [
            'package impl',
            'import "context"',
            'import "encoding/json"',
            'import "example.com/generics/payload"',
            'var _ payload.AsyncTaskPayload = (*GoodPayload)(nil)',
            'type GoodPayload struct{}',
            'func (*GoodPayload) GetTaskType() string { return "" }',
            'func (*GoodPayload) GetSlotKey() string { return "" }',
            'type BadPayload struct{}',
            'type Good struct{}',
            'func (Good) Decode(context.Context, []byte) (*GoodPayload, error) { return nil, nil }',
            'func (Good) Validate(context.Context, *GoodPayload) error { return nil }',
            'func (Good) Identity(*GoodPayload) string { return "" }',
            'func (Good) Execute(context.Context, *GoodPayload) (json.RawMessage, error) { return nil, nil }',
            'type Inconsistent struct{}',
            'func (Inconsistent) Decode(context.Context, []byte) (*GoodPayload, error) { return nil, nil }',
            'func (Inconsistent) Validate(context.Context, *BadPayload) error { return nil }',
            'func (Inconsistent) Identity(*GoodPayload) string { return "" }',
            'func (Inconsistent) Execute(context.Context, *GoodPayload) (json.RawMessage, error) { return nil, nil }',
            'type ViolatesConstraint struct{}',
            'func (ViolatesConstraint) Decode(context.Context, []byte) (*BadPayload, error) { return nil, nil }',
            'func (ViolatesConstraint) Validate(context.Context, *BadPayload) error { return nil }',
            'func (ViolatesConstraint) Identity(*BadPayload) string { return "" }',
            'func (ViolatesConstraint) Execute(context.Context, *BadPayload) (json.RawMessage, error) { return nil, nil }',
            'type ViolatesWithInt struct{}',
            'func (ViolatesWithInt) Decode(context.Context, []byte) (int, error) { return 0, nil }',
            'func (ViolatesWithInt) Validate(context.Context, int) error { return nil }',
            'func (ViolatesWithInt) Identity(int) string { return "" }',
            'func (ViolatesWithInt) Execute(context.Context, int) (json.RawMessage, error) { return nil, nil }',
            'type GenericTask[T payload.AsyncTaskPayload] struct{}',
            'func (GenericTask[X]) Decode(context.Context, []byte) (X, error) { var value X; return value, nil }',
            'func (GenericTask[Y]) Validate(context.Context, Y) error { return nil }',
            'func (GenericTask[Z]) Identity(Z) string { return "" }',
            'func (GenericTask[Q]) Execute(context.Context, Q) (json.RawMessage, error) { return nil, nil }',
            'type CombinedImpl[T any] struct{}',
            'func (CombinedImpl[X]) Put(X) {}',
            'func (CombinedImpl[Y]) Get() Y { var value Y; return value }',
            'func (CombinedImpl[Z]) Channel(chan Z) {}',
            'func (CombinedImpl[Q]) Shape(struct { Value Q }) {}',
            'func (CombinedImpl[R]) Transform(map[string][]R) []R { return nil }',
            'type BaseImpl[T any] struct{}',
            'func (BaseImpl[X]) Put(X) {}',
            'func (BaseImpl[Y]) Get() Y { var value Y; return value }',
            'type Wrapped[T any] struct { BaseImpl[T] }',
            'func (Wrapped[X]) Channel(chan X) {}',
            'func (Wrapped[Y]) Shape(struct { Value Y }) {}',
            'func (Wrapped[Z]) Transform(map[string][]Z) []Z { return nil }',
            'type PairImpl struct{}',
            'func (PairImpl) Join(int, map[int][]string) string { return "" }',
            'type WrongPair struct{}',
            'func (WrongPair) Join(int, map[string][]string) string { return "" }',
            'type UserID int',
            'type Labels []byte',
            'type Ints []int',
            'type ComparableRecord struct { ID int; Name string }',
            'type NonComparableRecord struct { Values []int }',
            'type ComparableArray [2]int',
            'type NonComparableArray [2][]int',
            'type ScalarInt struct{}',
            'func (ScalarInt) ScalarValue(int) int { return 0 }',
            'type ScalarNamedInt struct{}',
            'func (ScalarNamedInt) ScalarValue(UserID) UserID { return 0 }',
            'type ScalarString struct{}',
            'func (ScalarString) ScalarValue(string) string { return "" }',
            'type ScalarFloat struct{}',
            'func (ScalarFloat) ScalarValue(float64) float64 { return 0 }',
            'type ComparableInt struct{}',
            'func (ComparableInt) ComparableValue(int) int { return 0 }',
            'type ComparableStruct struct{}',
            'func (ComparableStruct) ComparableValue(ComparableRecord) ComparableRecord { return ComparableRecord{} }',
            'type NonComparableStruct struct{}',
            'func (NonComparableStruct) ComparableValue(NonComparableRecord) NonComparableRecord { return NonComparableRecord{} }',
            'type NonComparableSlice struct{}',
            'func (NonComparableSlice) ComparableValue([]int) []int { return nil }',
            'type ComparableArrayImpl struct{}',
            'func (ComparableArrayImpl) ComparableValue(ComparableArray) ComparableArray { return ComparableArray{} }',
            'type NonComparableArrayImpl struct{}',
            'func (NonComparableArrayImpl) ComparableValue(NonComparableArray) NonComparableArray { return NonComparableArray{} }',
            'type SliceBytes struct{}',
            'func (SliceBytes) SliceOrStringValue(Labels) Labels { return nil }',
            'type SliceString struct{}',
            'func (SliceString) SliceOrStringValue(string) string { return "" }',
            'type SliceInts struct{}',
            'func (SliceInts) SliceOrStringValue(Ints) Ints { return nil }',
            'type ExactBuiltinInt struct{}',
            'func (ExactBuiltinInt) ExactIntValue(int) int { return 0 }',
            'type ExactNamedInt struct{}',
            'func (ExactNamedInt) ExactIntValue(UserID) UserID { return 0 }',
            'type DependentGood struct{}',
            'func (DependentGood) DependentValue(int, []int) {}',
            'type DependentBad struct{}',
            'func (DependentBad) DependentValue(int, []string) {}',
            'type ValidTextPayload string',
            'func (ValidTextPayload) GetTaskType() string { return "" }',
            'type WrongUnderlyingPayload int',
            'func (WrongUnderlyingPayload) GetTaskType() string { return "" }',
            'type MissingMethodPayload string',
            'type ValidTextPayloadTask struct{}',
            'func (ValidTextPayloadTask) TextPayloadValue(ValidTextPayload) {}',
            'type WrongUnderlyingPayloadTask struct{}',
            'func (WrongUnderlyingPayloadTask) TextPayloadValue(WrongUnderlyingPayload) {}',
            'type MissingMethodPayloadTask struct{}',
            'func (MissingMethodPayloadTask) TextPayloadValue(MissingMethodPayload) {}',
        ].join('\n')
    );

    const index = new WorkspaceIndex(
        () => ({
            excludedFolders: [],
            excludedFilePatterns: [],
            excludedTypePatterns: [],
            searchDependencies: false,
            goModCache: '',
            astConcurrency: 2,
        }),
        () => {},
        { cacheDir: path.join(tmp, 'cache') }
    );
    await index.ensureBuilt(root);

    console.log('== generic interface implementations ==');
    const taskImplementations = (
        await index.findImplementationsAst('SingleStepTask', interfaceFile)
    )
        .map((result) => result.name)
        .sort();
    eq('generic task inference finds concrete and generic receivers', taskImplementations, [
        'GenericTask',
        'Good',
    ]);
    assert(
        'one type parameter must remain consistent across every interface method',
        !taskImplementations.includes('Inconsistent')
    );
    assert(
        'inferred type argument must satisfy its interface constraint',
        !taskImplementations.includes('ViolatesConstraint')
    );
    assert(
        'predeclared type arguments cannot bypass an interface constraint',
        !taskImplementations.includes('ViolatesWithInt')
    );

    const decodeImplementations = await index.findMethodImplementationsAst(
        'SingleStepTask',
        'Decode',
        interfaceFile
    );
    eq(
        'generic method navigation uses whole-interface matching',
        decodeImplementations.map((result) => result.name).sort(),
        ['GenericTask', 'Good']
    );
    assert(
        'generic method navigation points at the concrete method declaration',
        decodeImplementations.every((result) => result.file === implementationFile)
    );
    const reverse = await index.findInterfacesAst('Good', 'Decode', {
        receiverFile: implementationFile,
    });
    assert(
        'reverse navigation recognizes a generic interface instantiation',
        reverse.some((result) => result.name === 'SingleStepTask')
    );

    console.log('\n== generic embeds and multiple parameters ==');
    eq(
        'generic interface and struct embeds substitute their type arguments',
        (await index.findImplementationsAst('Combined', interfaceFile))
            .map((result) => result.name)
            .sort(),
        ['CombinedImpl', 'Wrapped']
    );
    eq(
        'multiple parameters infer independently inside nested composite types',
        (await index.findImplementationsAst('Pair', interfaceFile)).map(
            (result) => result.name
        ),
        ['PairImpl']
    );

    console.log('\n== generic type-set constraints ==');
    eq(
        'named union constraint accepts exact and matching underlying types',
        (await index.findImplementationsAst('ScalarTask', interfaceFile))
            .map((result) => result.name)
            .sort(),
        ['ScalarInt', 'ScalarNamedInt', 'ScalarString']
    );
    eq(
        'comparable rejects slices and structs containing slices',
        (await index.findImplementationsAst('ComparableTask', interfaceFile))
            .map((result) => result.name)
            .sort(),
        ['ComparableArrayImpl', 'ComparableInt', 'ComparableStruct']
    );
    eq(
        'inline union with approximation checks named underlying composite types',
        (await index.findImplementationsAst('SliceOrStringTask', interfaceFile))
            .map((result) => result.name)
            .sort(),
        ['SliceBytes', 'SliceString']
    );
    eq(
        'an exact type term excludes a named type with the same underlying type',
        (await index.findImplementationsAst('ExactIntTask', interfaceFile)).map(
            (result) => result.name
        ),
        ['ExactBuiltinInt']
    );
    eq(
        'a dependent type constraint is instantiated from the first inferred parameter',
        (await index.findImplementationsAst('DependentTask', interfaceFile)).map(
            (result) => result.name
        ),
        ['DependentGood']
    );
    eq(
        'method-set and type-set parts of one constraint are both enforced',
        (await index.findImplementationsAst('TextPayloadTask', interfaceFile)).map(
            (result) => result.name
        ),
        ['ValidTextPayloadTask']
    );

    index.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
