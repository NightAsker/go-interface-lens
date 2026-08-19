'use strict';

const {
    hasCompatibleMethodArity,
    scanMethodDeclarationArities,
} = require('../src/go-arity');
const { assert, eq, done } = require('./harness');

console.log('== receiver method arity prefilter ==');
const implementationSource = [
    'package sample',
    'type Worker[T any] struct{}',
    'func',
    '(',
    '    receiver *Worker[int],',
    ')',
    'Run(',
    '    first, second int,',
    '    callback func(int, int) (string, error),',
    '    values map[string]func(int, int) error,',
    ') (',
    '    left, right error,',
    ') {',
    '    Run(1, 2, 3)',
    '}',
].join('\n');
eq(
    'grouped names and nested function types count as Go parameter slots',
    scanMethodDeclarationArities(implementationSource, 'Run', 'implementation'),
    { arities: [{ params: 4, results: 2 }], uncertain: false }
);
assert(
    'matching implementation arity is retained',
    hasCompatibleMethodArity(
        implementationSource,
        'Run',
        'implementation',
        { params: 4, results: 2 }
    )
);
assert(
    'body calls do not satisfy a different declaration arity',
    !hasCompatibleMethodArity(
        implementationSource,
        'Run',
        'implementation',
        { params: 3, results: 0 }
    )
);

console.log('\n== interface method arity prefilter ==');
const interfaceSource = [
    'package sample',
    'type Callback interface {',
    '    Run(value func(int, int) (string, error)) func(int, int) error',
    '}',
    'type Grouped interface {',
    '    Run(first, second int) (left, right int)',
    '}',
].join('\n');
eq(
    'unparenthesized function results remain one result slot',
    scanMethodDeclarationArities(interfaceSource, 'Run', 'interface'),
    {
        arities: [
            { params: 1, results: 1 },
            { params: 2, results: 2 },
        ],
        uncertain: false,
    }
);
assert(
    'any matching declaration keeps an interface candidate file',
    hasCompatibleMethodArity(
        interfaceSource,
        'Run',
        'interface',
        { params: 2, results: 2 }
    )
);
assert(
    'a file with only incompatible declaration arities is rejected',
    !hasCompatibleMethodArity(
        interfaceSource,
        'Run',
        'interface',
        { params: 3, results: 1 }
    )
);

console.log('\n== conservative fallback ==');
assert(
    'an incomplete matching declaration is retained for Tree-sitter fallback',
    hasCompatibleMethodArity(
        'package sample\ntype Worker struct{}\nfunc (Worker) Run(',
        'Run',
        'implementation',
        { params: 1, results: 0 }
    )
);

done();
