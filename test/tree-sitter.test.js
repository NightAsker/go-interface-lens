'use strict';

const { buildDeclarationIR } = require('../src/ast');
const { parseGoSyntaxTree } = require('../src/tree-sitter-runtime');
const { assert, eq, done } = require('./harness');

async function main() {
    const source = [
        'package gateway',
        'type Gateway interface {',
        '    Load() map[string]interface{}',
        '}',
        'type Local struct{}',
        'func (Local) Load() map[string]any {',
        '    return map[string]any{}',
        '}',
    ].join('\n');

    const tree = await parseGoSyntaxTree(source);
    let parsed;
    try {
        parsed = buildDeclarationIR(tree.rootNode);
        console.log('== Tree-sitter Go WASM: single-file parse result ==');
        console.log('  S-expression:', tree.rootNode.toString());
        console.log(
            '  declaration IR:',
            JSON.stringify({
                parser: parsed.parser,
                packageName: parsed.packageName,
                interfaceSignature: parsed.interfaces.get('Gateway').methods.get('Load'),
                methodSignature: parsed.types.get('Local').methods.get('Load'),
                hasSyntaxError: parsed.hasSyntaxError,
            })
        );
    } finally {
        tree.delete();
    }

    eq('runtime is Tree-sitter Go WASM', parsed.parser, 'tree-sitter-go-wasm');
    assert('valid Go file has no syntax errors', !parsed.hasSyntaxError);
    eq(
        'method body braces do not truncate an interface result type',
        parsed.types.get('Local').methods.get('Load'),
        '()(map[string]any)'
    );
    assert('package-level declarations are extracted', parsed.interfaces.has('Gateway'));
    assert('method body declarations are not part of declaration IR', !parsed.types.has('return'));

    done();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
