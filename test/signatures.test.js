'use strict';

const {
    BUILTIN_INTERFACES,
    inferTypeParameterBindings,
    looseSignatureEqual,
    resolveInterfaceMethods,
    resolveTypeMethods,
    satisfies,
    splitNormalizedSignature,
} = require('../src/signatures');
const { assert, eq, done } = require('./harness');

console.log('== semantic signature comparison ==');
assert(
    'one missing self-package qualifier can match loosely',
    looseSignatureEqual(
        '(@{context}.Context)(@{example.com/acme}.Result,error)',
        '(@{context}.Context)(Result,error)'
    )
);
assert(
    'different imported packages in the same slot remain distinct',
    !looseSignatureEqual('()(alpha.Result)', '()(beta.Result)')
);
assert('different arity never matches loosely', !looseSignatureEqual('(int)()', '(int,string)()'));
eq('nested commas stay in one parameter slot', splitNormalizedSignature('(map[string]int)()').params, [
    'map[string]int',
]);

console.log('\n== embedded method sets ==');
const interfaces = new Map([
    [
        'Closer',
        {
            methods: new Map(),
            embeds: ['io.Closer'],
        },
    ],
]);
const closer = resolveInterfaceMethods('Closer', interfaces);
eq('known embedded interface expands its methods', [...closer.methods], [['Close', '()(error)']]);
assert('expanded interface is satisfied by an exact method set', satisfies(closer.methods, closer.methods));

const types = new Map([
    ['Base', { methods: new Map([['Run', '()()']]), embeds: [] }],
    ['Derived', { methods: new Map(), embeds: ['Base'] }],
]);
assert('embedded local type promotes methods', resolveTypeMethods('Derived', types).has('Run'));

console.log('\n== Tree-sitter-normalized builtins ==');
eq(
    'context.Context.Done uses whitespace-free channel normalization',
    BUILTIN_INTERFACES.get('context.Context').get('Done'),
    '()(<-chan(struct{}))'
);
eq(
    'context.Context.Deadline keeps canonical import identity',
    BUILTIN_INTERFACES.get('context.Context').get('Deadline'),
    '()(@{time}.Time,bool)'
);

console.log('\n== generic interface inference ==');
const genericParameters = [{ marker: '$0' }, { marker: '$1' }];
const genericMethods = new Map([
    ['Decode', '(chan($0),map[$0][]$1)($1)'],
    ['Shape', '(struct{Value:$0;Items:[]$1})()'],
    ['Transform', '(func($0)$1)($0)'],
]);
const genericImplementation = new Map([
    ['Decode', '(chan(*Payload),map[*Payload][]string)(string)'],
    ['Shape', '(struct{Value:*Payload;Items:[]string})()'],
    ['Transform', '(func(*Payload)string)(*Payload)'],
]);
eq(
    'nested and repeated type parameters share one inferred binding',
    [...inferTypeParameterBindings(
        genericMethods,
        genericImplementation,
        genericParameters
    )],
    [
        ['$0', '*Payload'],
        ['$1', 'string'],
    ]
);
const inconsistentGenericImplementation = new Map(genericImplementation);
inconsistentGenericImplementation.set(
    'Transform',
    '(func(*OtherPayload)string)(*OtherPayload)'
);
assert(
    'a type parameter cannot resolve to different types across methods',
    !inferTypeParameterBindings(
        genericMethods,
        inconsistentGenericImplementation,
        genericParameters
    )
);

done();
