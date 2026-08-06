'use strict';

const { parseGoFile, serializeParsedFile, deserializeParsedFile } = require('../src/ast');
const { assert, eq, done } = require('./harness');

function parse(lines) {
    return parseGoFile(lines.join('\n'));
}

async function main() {
console.log('== declaration AST: multiline and pointer method sets ==');
const service = await parse([
    'package service',
    'import ctx "context"',
    'type Runner interface {',
    '    Run(',
    '        context ctx.Context,',
    '        callback func(value string) error,',
    '    ) (result map[string][]byte, err error)',
    '}',
    'type Worker struct{}',
    'func',
    '(',
    '    worker *Worker,',
    ')',
    'Run(',
    '    context ctx.Context,',
    '    callback func(string) error,',
    ') (map[string][]byte, error) { return nil, nil }',
]);
eq('package name parsed', service.packageName, 'service');
assert('multiline interface found', service.interfaces.has('Runner'));
assert('multiline receiver method found', service.types.get('Worker').methods.has('Run'));
assert('pointer receiver retained', service.types.get('Worker').pointerMethods.has('Run'));
eq(
    'multiline AST signatures match structurally',
    service.types.get('Worker').methods.get('Run'),
    service.interfaces.get('Runner').methods.get('Run')
);
assert(
    'import alias canonicalized to path',
    service.interfaces.get('Runner').methods.get('Run').includes('@{context}.Context')
);

console.log('\n== declaration AST: grouped types, aliases, and embedding ==');
const grouped = await parse([
    'package p',
    'type (',
    '    Base struct{}',
    '    Derived struct { *Base }',
    '    Alias = Derived',
    '    Closer interface { Close() error }',
    ')',
    'func (Base) Value() {}',
    'func (*Base) Close() error { return nil }',
]);
assert('grouped struct parsed', grouped.types.has('Base'));
eq('pointer embed parsed', grouped.types.get('Derived').embeds, ['Base']);
assert('pointer embed marker retained', grouped.types.get('Derived').pointerEmbeds.has('Base'));
eq('type alias parsed', grouped.aliases.get('Alias'), 'Derived');
assert('grouped interface parsed', grouped.interfaces.has('Closer'));
assert('value receiver retained', !grouped.types.get('Base').pointerMethods.has('Value'));
assert('pointer receiver distinguished', grouped.types.get('Base').pointerMethods.has('Close'));

console.log('\n== declaration AST: import identity and constraints ==');
const imports = await parse([
    'package p',
    'import model "example.com/acme/model"',
    'type Store interface { Save(model.User) error }',
    'type Number interface { ~int | int64 }',
    'type NamedNumber interface { Number; Value() int }',
    'type UserID int',
    'type Impl struct{}',
    'func (Impl) Save(value model.User) error { return nil }',
]);
eq(
    'same import path has the same signature identity',
    imports.types.get('Impl').methods.get('Save'),
    imports.interfaces.get('Store').methods.get('Save')
);
assert('constraint interface marked non-basic', imports.interfaces.get('Number').constraint);
eq('type-set union terms are retained', imports.interfaces.get('Number').typeElements, ['~int|int64']);
assert('a locally embedded type set keeps the outer interface non-basic', imports.interfaces.get('NamedNumber').constraint);
eq('named type underlying type is retained', imports.types.get('UserID').underlying, 'int');

console.log('\n== declaration AST: generic interfaces and receivers ==');
const generics = await parse([
    'package p',
    'import task "example.com/common/task"',
    'type Base[T any] interface { Base(T) }',
    'type SingleStepTask[P task.AsyncTaskPayload, R interface { comparable; ~int | ~string }] interface {',
    '    Base[P]',
    '    Decode(body []byte) (P, error)',
    '    Channel(chan P)',
    '    Shape(struct { Payload P; Results []R })',
    '}',
    'type GenericImpl[T task.AsyncTaskPayload, R any] struct{}',
    'func (GenericImpl[X, Y]) Decode([]byte) (X, error) { panic("unused") }',
    'func (GenericImpl[A, B]) Channel(chan A) {}',
    'func (GenericImpl[C, D]) Shape(struct { Payload C; Results []D }) {}',
]);
const genericInterface = generics.interfaces.get('SingleStepTask');
eq('generic interface parameters retain declaration order', genericInterface.typeParameters.map((p) => p.marker), ['$0', '$1']);
eq(
    'qualified type-parameter constraint retains import identity',
    genericInterface.typeParameters[0].constraint,
    '@{example.com/common/task}.AsyncTaskPayload'
);
eq('generic interface embed retains its arguments', genericInterface.embedArguments.get('Base'), ['$0']);
eq(
    'inline type-set constraint elements are retained',
    genericInterface.typeParameters[1].constraintTypeElements,
    ['comparable', '~int|~string']
);
eq('generic channel element keeps a type-variable boundary', genericInterface.methods.get('Channel'), '(chan($0))()');
eq(
    'generic anonymous struct fields keep names and type-variable boundaries',
    genericInterface.methods.get('Shape'),
    '(struct{Payload:$0;Results:[]$1})()'
);
eq(
    'receiver type parameter names normalize by position across methods',
    generics.types.get('GenericImpl').methods.get('Shape'),
    '(struct{Payload:$0;Results:[]$1})()'
);

console.log('\n== declaration AST: complete field normalization ==');
const normalized = await parse([
    'package p',
    'import q "example.com/model"',
    'type T struct{}',
    'type Box[V any] struct{}',
    'type ResponseA struct{}',
    'type ResponseB struct{}',
    'type Shape interface {',
    '    Pointer(x *T)',
    '    Slice(x []T)',
    '    Array(x [3]T)',
    '    Variadic(x ...T)',
    '    Receive(x <-chan T)',
    '    Send(x chan<- T)',
    '    Qualified(x *q.Value)',
    '    Map(x map[string]T)',
    '    Generic(x Box[T])',
    '    Grouped(a, b *T)',
    '    Callback(fn func(x *T) (result []T))',
    '    Unicode(值 *T)',
    '    Contract(x interface { Second(y []T); First(value *T) })',
    '    NestedStruct(x struct { Callback func(value *T); Name string })',
    '    Result() (resp *ResponseA, err error)',
    '    SliceResult() (items []ResponseA, err error)',
    '}',
    'type Impl struct{}',
    'func (Impl) Pointer(y *T) {}',
    'func (Impl) Slice(y []T) {}',
    'func (Impl) Array(y [3]T) {}',
    'func (Impl) Variadic(y ...T) {}',
    'func (Impl) Receive(y <-chan T) {}',
    'func (Impl) Send(y chan<- T) {}',
    'func (Impl) Qualified(y *q.Value) {}',
    'func (Impl) Map(y map[string]T) {}',
    'func (Impl) Generic(y Box[T]) {}',
    'func (Impl) Grouped(x, y *T) {}',
    'func (Impl) Callback(callback func(y *T) (output []T)) {}',
    'func (Impl) Unicode(参数 *T) {}',
    'func (Impl) Contract(value interface { First(arg *T); Second(arg []T) }) {}',
    'func (Impl) NestedStruct(value struct { Callback func(arg *T); Name string }) {}',
    'func (Impl) Result() (*ResponseA, error) { return nil, nil }',
    'func (Impl) SliceResult() ([]ResponseA, error) { return nil, nil }',
]);
for (const methodName of normalized.interfaces.get('Shape').methods.keys()) {
    eq(
        `${methodName} ignores field names without losing its type`,
        normalized.types.get('Impl').methods.get(methodName),
        normalized.interfaces.get('Shape').methods.get(methodName)
    );
}

const distinctResults = await parse([
    'package p',
    'type ResponseA struct{}',
    'type ResponseB struct{}',
    'type Wanted interface { Build() (resp *ResponseA, err error) }',
    'type Wrong struct{}',
    'func (Wrong) Build() (resp *ResponseB, err error) { return nil, nil }',
    'type StructWanted interface { Use(struct { X int }) }',
    'type StructWrong struct{}',
    'func (StructWrong) Use(struct { Y int }) {}',
    'type SliceWanted interface { List() (items []ResponseA, err error) }',
    'type SliceWrong struct{}',
    'func (SliceWrong) List() (items []ResponseB, err error) { return nil, nil }',
]);
assert(
    'named pointer result types remain distinguishable',
    distinctResults.interfaces.get('Wanted').methods.get('Build') !==
        distinctResults.types.get('Wrong').methods.get('Build')
);
assert(
    'anonymous struct field names remain part of type identity',
    distinctResults.interfaces.get('StructWanted').methods.get('Use') !==
        distinctResults.types.get('StructWrong').methods.get('Use')
);
assert(
    'named slice result types remain distinguishable',
    distinctResults.interfaces.get('SliceWanted').methods.get('List') !==
        distinctResults.types.get('SliceWrong').methods.get('List')
);

console.log('\n== declaration AST: unparenthesized composite result types ==');
const compositeResultCases = [
    ['EmptyInterface', 'interface{}'],
    ['Any', 'any'],
    ['MapInterface', 'map[string]interface{}'],
    ['MapAny', 'map[string]any'],
    ['SliceInterface', '[]interface{}'],
    ['SliceAny', '[]any'],
    ['PointerInterface', '*interface{}'],
    ['PointerMapInterface', '*map[string]interface{}'],
    ['NestedContainers', 'map[string][]interface{}'],
    ['ArrayInterface', '[2]interface{}'],
    ['SendChannel', 'chan<- interface{}'],
    ['ReceiveChannel', '<-chan interface{}'],
    ['Callback', 'func() interface{}'],
    ['AnonymousStruct', 'struct { Value interface{} }'],
    ['AnonymousInterface', 'interface { Value() interface{} }'],
    ['GenericComposite', 'Box[map[string]interface{}]'],
];
const compositeResults = await parse([
    'package p',
    'type Box[T any] struct{}',
    'type CompositeResults interface {',
    ...compositeResultCases.map(([name, result]) => `    ${name}() ${result}`),
    '}',
    'type CompositeImpl struct{}',
    ...compositeResultCases.map(
        ([name, result]) =>
            `func (CompositeImpl) ${name}() ${result} { type MustStayLocal struct{}; panic(\"unused\") }`
    ),
]);
for (const [methodName] of compositeResultCases) {
    eq(
        `${methodName} keeps the complete result type before the method body`,
        compositeResults.types.get('CompositeImpl').methods.get(methodName),
        compositeResults.interfaces.get('CompositeResults').methods.get(methodName)
    );
}
assert(
    'method bodies after composite result types remain excluded',
    !compositeResults.types.has('MustStayLocal')
);

console.log('\n== declaration AST skips function bodies ==');
const localDeclarations = await parse([
    'package p',
    'type PackageType struct{}',
    'func Build() any {',
    '    type LocalType struct{}',
    '    local := func() { type NestedType struct{} }',
    '    return local',
    '}',
]);
assert('package type retained', localDeclarations.types.has('PackageType'));
assert('local type is not indexed as a package declaration', !localDeclarations.types.has('LocalType'));
assert('nested function type is not indexed', !localDeclarations.types.has('NestedType'));

console.log('\n== declaration AST cache serialization ==');
const restored = deserializeParsedFile(serializeParsedFile(service));
eq(
    'serialized signature restored',
    restored.interfaces.get('Runner').methods.get('Run'),
    service.interfaces.get('Runner').methods.get('Run')
);
assert('serialized pointer metadata restored', restored.types.get('Worker').pointerMethods.has('Run'));
assert('serialized struct metadata restored', restored.types.get('Worker').struct);

done();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
