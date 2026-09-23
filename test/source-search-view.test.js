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
    return { elements, messages, window };
}

console.log('== source search Webview interactions ==');
const harness = createWebviewHarness();
eq('Webview announces readiness', harness.messages[0] && harness.messages[0].type, 'ready');

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

done();
