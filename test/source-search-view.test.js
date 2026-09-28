'use strict';

const path = require('path');
const Module = require('module');
const vm = require('vm');
const { assert, eq, done } = require('./harness');

const originalResolve = Module._resolveFilename;
const stubPath = path.join(__dirname, 'vscode-stub.js');
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return stubPath;
    return originalResolve.call(this, request, ...rest);
};

const { SourceSearchViewProvider } = require('../src/source-search-view');
Module._resolveFilename = originalResolve;

class ClassList {
    constructor() {
        this.values = new Set();
    }

    toggle(name, force) {
        const enabled = force === undefined ? !this.values.has(name) : !!force;
        if (enabled) this.values.add(name);
        else this.values.delete(name);
        return enabled;
    }

    contains(name) {
        return this.values.has(name);
    }
}

class Element {
    constructor(id) {
        this.id = id;
        this.value = '';
        this.hidden = false;
        this.innerHTML = '';
        this.textContent = '';
        this.listeners = new Map();
        this.classList = new ClassList();
        this.attributes = new Map();
        this.focusCalls = 0;
    }

    focus() {
        this.focusCalls++;
    }

    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    dispatch(type, event = {}) {
        for (const listener of this.listeners.get(type) || []) listener(event);
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    getAttribute(name) {
        return this.attributes.get(name);
    }

    appendChild(child) {
        return child;
    }

    querySelectorAll() {
        return [];
    }
}

function createWebviewHarness() {
    const provider = new SourceSearchViewProvider();
    const html = provider._getHtml({ cspSource: 'https:' });
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
    const ids = [
        'query', 'scope', 'search-toggle', 'query-details', 'details-toggle',
        'scope-row', 'results', 'status', 'progress', 'open-editor', 'empty',
        'regex', 'case', 'word',
    ];
    const elements = Object.fromEntries(ids.map((id) => [id, new Element(id)]));
    elements.scope.value = 'all';
    const messages = [];
    const document = {
        getElementById(id) {
            return elements[id];
        },
        querySelector() {
            return new Element('search-row');
        },
        createElement(tag) {
            return new Element(tag);
        },
    };
    const window = {
        listeners: new Map(),
        addEventListener(type, listener) {
            this.listeners.set(type, listener);
        },
        dispatch(type, event) {
            const listener = this.listeners.get(type);
            if (listener) listener(event);
        },
    };
    const vscode = {
        postMessage(message) {
            messages.push(message);
        },
    };

    try {
        new Function('acquireVsCodeApi', 'document', 'window', script);
        assert('generated Webview script parses', true);
    } catch (error) {
        assert('generated Webview script parses', false);
        throw error;
    }

    vm.runInNewContext(script, {
        document,
        window,
        acquireVsCodeApi: () => vscode,
        console,
    }, { filename: 'source-search-webview.js' });
    return { elements, messages, window, html };
}

console.log('== source search Webview interactions ==');
const harness = createWebviewHarness();
eq('Webview announces readiness', harness.messages[0] && harness.messages[0].type, 'ready');
assert('native input clear button is hidden', /#query::\-webkit-search-cancel-button[\s\S]*display:\s*none/.test(harness.html));
assert('result tree uses the workbench font', /\.results\s*\{[^}]*font-family:\s*var\(--workbench-font-family\)/.test(harness.html));
assert('workbench font maps to the VS Code UI font', /--workbench-font-family:\s*var\(--vscode-font-family\b/.test(harness.html));
assert('result styles do not opt into the editor font', !/--vscode-editor-font-family/.test(harness.html));
assert('result rows use native deemphasized foreground', /--result-fg:\s*var\(--vscode-list-deemphasizedForeground\b/.test(harness.html));
assert('match highlights keep the native result text color', /mark\s*\{[^}]*color:\s*inherit/.test(harness.html));
assert('file paths use native deemphasized opacity', /\.file-path\s*\{[^}]*color:\s*var\(--result-fg\)[^}]*opacity:\s*\.7[^}]*font-size:\s*\.9em/.test(harness.html));
assert('line numbers use native deemphasized opacity', /\.line-number\s*\{[^}]*color:\s*var\(--result-fg\)[^}]*font-size:\s*\.9em[^}]*[^}]*opacity:\s*\.7/.test(harness.html));
assert('dependency results have a visible source label', /\.scope-label\.dependency/.test(harness.html) && /text:\s*'Dependency'/.test(harness.html));
assert('workspace results sort before dependency results', /\[\.\.\.files\.values\(\)\]\.sort\(\(left, right\) => scopeRank\(left\.scope\)/.test(harness.html));

harness.elements.query.value = 'LoadComplete';
const enter = {
    key: 'Enter',
    prevented: false,
    preventDefault() {
        this.prevented = true;
    },
};
harness.elements.query.dispatch('keydown', enter);
const enterSearch = harness.messages[harness.messages.length - 1];
assert('Enter prevents the browser submit', enter.prevented);
eq('Enter sends a search message', enterSearch.type, 'search');
eq('Enter sends the typed query', enterSearch.options.query, 'LoadComplete');

for (const [id, option] of [['case', 'matchCase'], ['word', 'wholeWord'], ['regex', 'regex']]) {
    harness.elements[id].dispatch('click', {
        preventDefault() {},
        stopPropagation() {},
    });
    assert(`${id} toggles its selected state`, harness.elements[id].classList.contains('active'));
    const message = harness.messages[harness.messages.length - 1];
    eq(`${id} sends its search option`, message.options[option], true);
}

async function testSearchFocus() {
    console.log('\n== source search shortcut focus ==');
    const vscode = require(stubPath);
    const originalCommands = vscode.commands;
    const commands = [];
    vscode.commands = { async executeCommand(command) { commands.push(command); } };
    const provider = new SourceSearchViewProvider();
    const outgoing = [];
    const showCalls = [];

    function createView(visible = true) {
        let receive;
        let visibilityChanged;
        const view = {
            visible,
            webview: {
                cspSource: 'https:',
                postMessage(message) {
                    outgoing.push(message);
                    harness.window.dispatch('message', { data: message });
                    return Promise.resolve(true);
                },
                onDidReceiveMessage(listener) {
                    receive = listener;
                    return { dispose() {} };
                },
            },
            onDidChangeVisibility(listener) {
                visibilityChanged = listener;
                return { dispose() {} };
            },
            show(preserveFocus) {
                showCalls.push(preserveFocus);
                view.visible = true;
                visibilityChanged();
            },
        };
        provider.resolveWebviewView(view);
        return { view, ready: () => receive({ type: 'ready' }), visibilityChanged: () => visibilityChanged() };
    }

    try {
        await provider.focusSearch();
        eq('shortcut opens the specific search view', commands, ['go-interface-lens.sourceSearch.focus']);
        eq('first shortcut waits for the view to be created', outgoing.length, 0);
        const first = createView();
        eq('focus message waits for Webview readiness', outgoing.length, 0);
        first.ready();
        eq('ready Webview receives the pending focus request', outgoing, [{ type: 'focusQuery' }]);
        eq('first shortcut focuses the query input', harness.elements.query.focusCalls, 1);
        eq('focusing preserves the existing query', harness.elements.query.value, 'LoadComplete');

        await provider.focusSearch();
        eq('repeating shortcut focuses an already visible input', harness.elements.query.focusCalls, 2);
        eq('show transfers focus to the Webview', showCalls, [false]);

        first.view.visible = false;
        first.visibilityChanged();
        await provider.focusSearch();
        eq('shortcut refocuses a retained hidden Webview', harness.elements.query.focusCalls, 3);
        first.visibilityChanged();
        eq('unrequested visibility events do not steal focus', harness.elements.query.focusCalls, 3);

        provider.dispose();
        await provider.focusSearch();
        const reloaded = createView(false);
        reloaded.ready();
        eq('recreated hidden Webview defers input focus', harness.elements.query.focusCalls, 3);
        reloaded.view.visible = true;
        reloaded.visibilityChanged();
        eq('pending focus is delivered once the reloaded view is visible', harness.elements.query.focusCalls, 4);

        commands.length = 0;
        vscode.commands.executeCommand = async (command) => {
            commands.push(command);
            if (command === 'go-interface-lens.sourceSearch.focus') throw new Error('Unknown command');
        };
        await provider.focusSearch();
        eq('compatible editors can fall back to opening the container', commands, [
            'go-interface-lens.sourceSearch.focus', 'workbench.view.extension.go-interface-lens',
        ]);
        eq('fallback also focuses the query input', harness.elements.query.focusCalls, 5);

        provider.dispose();
        const passive = createView();
        passive.ready();
        eq('loading without a shortcut request does not steal focus', harness.elements.query.focusCalls, 5);
    } finally {
        provider.dispose();
        vscode.commands = originalCommands;
    }
}

testSearchFocus().then(done).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
