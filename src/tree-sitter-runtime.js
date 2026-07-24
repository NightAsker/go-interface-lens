'use strict';

const path = require('path');

const wasmDirectory = path.join(__dirname, '..', 'vendor', 'tree-sitter');
const { Parser, Language } = require(path.join(wasmDirectory, 'tree-sitter.js'));
const runtimeWasm = path.join(wasmDirectory, 'tree-sitter.wasm');
const goGrammarWasm = path.join(wasmDirectory, 'tree-sitter-go.wasm');

let initialization;

async function initializeGoParser() {
    if (!initialization) {
        initialization = (async () => {
            await Parser.init({
                locateFile: (file) =>
                    file === 'tree-sitter.wasm' ? runtimeWasm : path.join(wasmDirectory, file),
            });
            const language = await Language.load(goGrammarWasm);
            const parser = new Parser();
            parser.setLanguage(language);
            return { parser, language };
        })();
    }
    return initialization;
}

async function parseGoSyntaxTree(text) {
    const { parser } = await initializeGoParser();
    parser.reset();
    const tree = parser.parse(text);
    if (!tree) throw new Error('Tree-sitter failed to parse Go source');
    return tree;
}

function getWasmPaths() {
    return { runtimeWasm, goGrammarWasm };
}

module.exports = { initializeGoParser, parseGoSyntaxTree, getWasmPaths };
