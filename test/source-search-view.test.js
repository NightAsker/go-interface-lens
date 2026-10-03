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

    set innerHTML(value) {
        this.html = value;
        this.children = [];
    }

    get innerHTML() {
        return this.html;
    }

    appendChild(child) {
        this.children.push(child);
        child.parent = this;
        return child;
    }

    remove() {
        this.parent.children = this.parent.children.filter((child) => child !== this);
    }

    insertBefore(child, next) {
        if (!next) return this.appendChild(child);
        this.children.splice(this.children.indexOf(next), 0, child);
        child.parent = this;
        return child;
    }

    replaceWith(child) {
        this.parent.insertBefore(child, this);
        this.remove();
    }

    querySelector(selector) {
        const existing = this.querySelectorAll(selector)[0];
        if (existing) return existing;
        const child = new Element(selector);
        child.className = selector.slice(1);
        return this.appendChild(child);
    }

    querySelectorAll(selector) {
        return this.children.flatMap((child) => [
            ...((child.className || '').split(' ').includes(selector.slice(1)) ? [child] : []),
            ...child.querySelectorAll(selector),
        ]);
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
    let now = 0;
    let nextTimer = 0;
    const timers = new Map();
    function tick(ms) {
        const end = now + ms;
        while (true) {
            const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
            if (!next || next[1].at > end) break;
            now = next[1].at;
            timers.delete(next[0]);
            next[1].callback();
        }
        now = end;
    }

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
        setTimeout(callback, delay) {
            const id = ++nextTimer;
            timers.set(id, { callback, at: now + delay });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        console,
    }, { filename: 'source-search-webview.js' });
    return { elements, messages, window, html, tick };
}

console.log('== source search Webview interactions ==');
const harness = createWebviewHarness();
eq('Webview announces readiness', harness.messages[0] && harness.messages[0].type, 'ready');
assert('native input clear button is hidden', /#query::\-webkit-search-cancel-button[\s\S]*display:\s*none/.test(harness.html));
assert('result tree uses the workbench font', /\.results\s*\{[^}]*font-family:\s*var\(--workbench-font-family\)/.test(harness.html));
assert('workbench font maps to the VS Code UI font', /--workbench-font-family:\s*var\(--vscode-font-family\b/.test(harness.html));
assert('result styles do not opt into the editor font', !/--vscode-editor-font-family/.test(harness.html));
assert('result rows inherit the native sidebar foreground', /--result-fg:\s*var\(--vscode-sideBar-foreground,\s*var\(--vscode-foreground\)\)/.test(harness.html));
assert('regular search results do not use excluded-item gray', !/--vscode-list-deemphasizedForeground/.test(harness.html));
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

console.log('\n== native match previews ==');
const previews = createWebviewHarness();
const searchTerm = 'CheckLocalLifeUpgrade';
function renderMatch(text, options = {}, ranges) {
    const column = Math.max(0, text.indexOf(searchTerm)) + 1;
    previews.window.dispatch('message', { data: {
        type: 'searchStarted', options: { query: searchTerm, ...options },
    } });
    previews.window.dispatch('message', { data: { type: 'appendResults', results: [{
        file: '/workspace/core/conversation/handler.go', line: 660, column, text, ranges,
        scope: 'workspace',
    }] } });
    return previews.elements.results.querySelectorAll('.match')[0];
}
const longLine = '\tvar skipNotify = !strings.IsBlank(r.Extra[define.CORE_INFO_FROM_SYNC]) && localLifeBcMainStore && !paasTcc.CheckLocalLifeUpgrade(ctx, shopId)';
const longRow = renderMatch(longLine);
assert('long handler preview starts near the match at a word boundary', longRow.innerHTML.includes('…localLifeBcMainStore &amp;&amp; !paasTcc.<mark>CheckLocalLifeUpgrade</mark>'));
assert('long handler preview omits the unrelated prefix', !longRow.innerHTML.includes('skipNotify'));
longRow.dispatch('click');
const opened = previews.messages.at(-1);
eq('cropped result opens the original file and line', [opened.type, opened.match.file, opened.match.line], ['openMatch', '/workspace/core/conversation/handler.go', 660]);
eq('cropped result opens the original column', opened.match.column, longLine.indexOf(searchTerm) + 1);
eq('cropping preserves the full source for opening and export', opened.match.text, longLine);
previews.elements['open-editor'].dispatch('click');
eq('export keeps the full original source line', previews.messages.at(-1).results[0].text, longLine);

const shortRow = renderMatch('\tmainStoreGray = paasTcc.CheckLocalLifeUpgrade(ctx, shopId)');
assert('short context stays intact without an ellipsis', shortRow.innerHTML.includes('mainStoreGray = paasTcc.<mark>CheckLocalLifeUpgrade</mark>'));
assert('short context only removes indentation', !shortRow.innerHTML.includes('…') && !shortRow.innerHTML.includes('\t'));
const wholeWordRow = renderMatch('CheckLocalLifeUpgradeBuyer CheckLocalLifeUpgrade', { wholeWord: true });
assert('whole-word preview centers on the actual match', wholeWordRow.innerHTML.includes('CheckLocalLifeUpgradeBuyer <mark>CheckLocalLifeUpgrade</mark>'));
eq('whole-word preview does not highlight a larger identifier', (wholeWordRow.innerHTML.match(/<mark>/g) || []).length, 1);

const anchoredText = '\t\tCheckLocalLifeUpgrade';
const anchoredRow = renderMatch(anchoredText, { query: '^\\s+CheckLocalLifeUpgrade', useRegex: true }, [{ start: 0, end: anchoredText.length }]);
assert('anchored regex keeps whitespace inside the actual match', anchoredRow.innerHTML.includes('<mark>' + anchoredText + '</mark>'));
const repeatedRow = renderMatch('CheckLocalLifeUpgrade + CheckLocalLifeUpgrade');
eq('multiple visible matches retain their highlights', (repeatedRow.innerHTML.match(/<mark>/g) || []).length, 2);
const unicodeText = '\t// 中文😀 检查: CheckLocalLifeUpgrade';
const unicodeStart = unicodeText.indexOf(searchTerm);
const unicodeRow = renderMatch(unicodeText, {}, [{ start: unicodeStart, end: unicodeStart + searchTerm.length }]);
assert('Unicode context keeps the match highlight aligned', unicodeRow.innerHTML.includes('中文😀 检查: <mark>CheckLocalLifeUpgrade</mark>'));
const escapedRow = renderMatch('<tag>& CheckLocalLifeUpgrade("<script>")');
assert('preview escapes source markup', escapedRow.innerHTML.includes('&lt;tag&gt;&amp; <mark>CheckLocalLifeUpgrade</mark>(&quot;&lt;script&gt;&quot;)'));

renderMatch(longLine + ' + trailingContext'.repeat(40)).dispatch('click');
eq('preview is bounded to the native 250 characters', previews.messages.at(-1).match.preview.text.length, 250);
assert('bounded preview still shows the searched identifier', previews.messages.at(-1).match.preview.text.includes(searchTerm));
const noMatch = renderMatch('plain source', { query: '[' , useRegex: true });
assert('invalid fallback regex still renders the source safely', noMatch.innerHTML.includes('plain source'));
const zeroLength = renderMatch('abc', { query: '^', useRegex: true });
assert('zero-length regex preview terminates and preserves the line', zeroLength.innerHTML.includes('<mark></mark>abc'));

console.log('\n== incremental result batches ==');
const incremental = createWebviewHarness();
const post = (data) => incremental.window.dispatch('message', { data });
const add = (file, line, scope = 'workspace') => post({ type: 'appendResults', results: [{ file, line, scope, text: 'needle', column: 1 }] });
post({ type: 'searchStarted', options: { query: 'needle' } });
add('/z.go', 10, 'dependency');
const untouched = incremental.elements.results.querySelectorAll('.file')[0];
untouched.querySelector('.file-head').dispatch('click');
add('/b.go', 20);
add('/a.go', 30);
const initialFiles = incremental.elements.results.querySelectorAll('.file');
eq('streamed workspace files sort before dependencies', initialFiles.map((file) => file.querySelector('.matches').children[0].innerHTML.match(/line-number">(\d+)/)[1]), ['30', '20', '10']);
assert('new batches preserve unaffected file nodes', initialFiles[2] === untouched);
assert('unaffected files retain their collapsed state', untouched.classList.contains('collapsed'));
add('/a.go', 2);
const updated = incremental.elements.results.querySelectorAll('.file');
assert('appending a match only rebuilds its own file', updated[0] !== initialFiles[0] && updated[1] === initialFiles[1] && updated[2] === untouched);
eq('out-of-order batches keep matches sorted by source line', updated[0].querySelector('.matches').children.map((row) => row.innerHTML.match(/line-number">(\d+)/)[1]), ['2', '30']);
add('/a.go', 2);
assert('duplicate streamed matches do not rebuild a file', incremental.elements.results.querySelectorAll('.file')[0] === updated[0]);
post({ type: 'searchFinished', resultCount: 4, fileCount: 3 });
assert('streamed result totals are not double-counted', incremental.elements.status.innerHTML.includes('<strong>4</strong> results in <strong>3</strong> files'));

console.log('\n== search after typing pauses ==');
const typing = createWebviewHarness();
const query = typing.elements.query;
const searches = () => typing.messages.filter((message) => message.type === 'search');
const key = (key, extra = {}) => query.dispatch('keydown', { key, preventDefault() {}, ...extra });
function input(value, event = {}) {
    query.value = value;
    query.dispatch('input', event);
}
function configure(searchOnType, searchOnTypeDebouncePeriod) {
    typing.window.dispatch('message', { data: { type: 'searchConfiguration', searchOnType, searchOnTypeDebouncePeriod } });
}

input('Load');
typing.tick(299);
eq('typing waits for the default debounce period', searches().length, 0);
input('LoadComplete');
typing.tick(299);
eq('further typing restarts the delay', searches().length, 0);
typing.tick(1);
eq('pause searches the latest query once', searches().map((message) => message.options.query), ['LoadComplete']);
typing.tick(1000);
eq('an unchanged query does not repeatedly search', searches().length, 1);

input('Pasted text', { inputType: 'insertFromPaste' });
typing.tick(300);
eq('pasting also triggers automatic search', searches().at(-1).options.query, 'Pasted text');
input('Immediate');
const beforeEnter = searches().length;
key('Enter');
eq('Enter submits before the timer expires', searches().length, beforeEnter + 1);
typing.tick(500);
eq('Enter cancels the duplicate delayed search', searches().length, beforeEnter + 1);

for (const [id, option] of [['case', 'matchCase'], ['word', 'wholeWord'], ['regex', 'regex']]) {
    input('filtered ' + id);
    const before = searches().length;
    typing.elements[id].dispatch('click', { preventDefault() {}, stopPropagation() {} });
    eq(`${id} immediately searches while typing is pending`, searches().length, before + 1);
    eq(`${id} includes the new option`, searches().at(-1).options[option], true);
    typing.tick(500);
    eq(`${id} cancels the delayed duplicate`, searches().length, before + 1);
}
input('scoped');
const beforeScope = searches().length;
typing.elements.scope.value = 'workspace';
typing.elements.scope.dispatch('change');
eq('scope immediately searches the selected scope', searches().at(-1).options.scope, 'workspace');
typing.tick(500);
eq('scope cancels the delayed duplicate', searches().length, beforeScope + 1);

input('pending');
const beforeClear = searches().length;
input('');
eq('clearing input immediately clears results', typing.messages.at(-1).type, 'clearResults');
typing.tick(500);
eq('clearing input cancels queued searches', searches().length, beforeClear);
key('Enter');
eq('empty Enter clears instead of searching', typing.messages.at(-1).type, 'clearResults');
typing.window.dispatch('message', { data: { type: 'clearResults' } });
eq('clearing restores the initial prompt', typing.elements.status.textContent, 'Type to search source');

input('cancel pending');
key('Escape');
eq('Escape clears an idle query', query.value, '');
typing.tick(500);
eq('Escape cancels a queued search', searches().length, beforeClear);
typing.window.dispatch('message', { data: { type: 'searchStarted', options: { query: 'running' } } });
input('next query');
key('Escape');
eq('Escape cancels an active search', typing.messages.at(-1).type, 'cancel');
typing.tick(500);
eq('Escape does not restart an active search from its queued timer', searches().length, beforeClear);

input('zhong');
query.dispatch('compositionstart');
typing.tick(500);
eq('starting composition cancels an earlier timer', searches().length, beforeClear);
input('中文', { isComposing: true });
key('Enter', { isComposing: true });
key('Escape', { isComposing: true });
typing.tick(500);
eq('composition input and confirmation do not search', searches().length, beforeClear);
eq('composition Escape does not clear the input', query.value, '中文');
query.dispatch('compositionend');
key('Enter', { keyCode: 229 });
input('中文');
typing.tick(299);
eq('committed composition waits for the debounce', searches().length, beforeClear);
typing.tick(1);
eq('committed composition searches once', searches().length, beforeClear + 1);
eq('composition searches the committed characters', searches().at(-1).options.query, '中文');

configure(true, 650);
input('custom delay');
const beforeSettings = searches().length;
typing.tick(649);
eq('native custom debounce period is respected', searches().length, beforeSettings);
typing.tick(1);
eq('custom debounce eventually submits', searches().length, beforeSettings + 1);
input('disabled pending');
configure(false, 650);
typing.tick(1000);
eq('disabling native search-on-type cancels its queued search', searches().length, beforeSettings + 1);
input('manual');
typing.tick(1000);
eq('disabled native search-on-type waits for Enter', searches().length, beforeSettings + 1);
key('Enter');
eq('Enter still works with automatic searching disabled', searches().at(-1).options.query, 'manual');
configure(true, 300);
input('updated delay');
configure(true, 100);
typing.tick(100);
eq('updating the native delay reschedules pending input', searches().at(-1).options.query, 'updated delay');

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
        eq('ready Webview receives the pending focus request', outgoing.at(-1), { type: 'focusQuery' });
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

async function testNativeSearchConfiguration() {
    console.log('\n== native search settings ==');
    const vscode = require(stubPath);
    const originalWorkspace = vscode.workspace;
    const settings = { searchOnType: false, searchOnTypeDebouncePeriod: 450 };
    let changed;
    let disposed = false;
    vscode.workspace = {
        ...originalWorkspace,
        getConfiguration(section) {
            eq('reads VS Code native search configuration', section, 'search');
            return { get: (key, fallback) => settings[key] ?? fallback };
        },
        onDidChangeConfiguration(listener) {
            changed = listener;
            return { dispose() { disposed = true; } };
        },
    };
    const provider = new SourceSearchViewProvider();
    try {
        const configured = createWebviewHarness();
        configured.elements.query.value = 'manual setting';
        configured.elements.query.dispatch('input');
        configured.tick(1000);
        eq('initial Webview respects a disabled native setting', configured.messages.filter((message) => message.type === 'search').length, 0);
        const outgoing = [];
        provider.resolveWebviewView({ webview: {
            postMessage(message) {
                outgoing.push(message);
                configured.window.dispatch('message', { data: message });
            },
        } });
        await provider._handleMessage({ type: 'ready' });
        eq('ready Webview receives current native settings', outgoing.at(-1), { type: 'searchConfiguration', ...settings });
        const before = outgoing.length;
        changed({ affectsConfiguration: () => false });
        eq('unrelated setting updates do not affect search', outgoing.length, before);
        settings.searchOnType = true;
        changed({ affectsConfiguration: (key) => key === 'search.searchOnType' });
        configured.elements.query.dispatch('input');
        configured.tick(449);
        eq('host setting update preserves the custom delay', configured.messages.filter((message) => message.type === 'search').length, 0);
        configured.tick(1);
        eq('host setting updates enable automatic search without reload', configured.messages.at(-1).type, 'search');
    } finally {
        provider.dispose();
        vscode.workspace = originalWorkspace;
    }
    assert('disposing the view removes its settings listener', disposed);
}

async function testOverlappingSearches() {
    console.log('\n== overlapping automatic searches ==');
    for (const ending of ['AbortError', 'Error', 'success']) {
        const requests = [];
        const provider = new SourceSearchViewProvider({ engine: {
            search(options, callbacks) {
                return new Promise((resolve, reject) => requests.push({ options, ...callbacks, resolve, reject }));
            },
        } });
        const outgoing = [];
        provider._view = { webview: { postMessage: (message) => outgoing.push(message) } };
        const first = provider._startSearch({ query: 'old' });
        const second = provider._startSearch({ query: 'new' });
        assert(`${ending}: the newer search aborts the previous one`, requests[0].signal.aborted);
        const before = outgoing.length;
        requests[0].onBatch([{ file: 'old.go', text: 'old' }]);
        requests[0].onProgress({ totalMatches: 999 });
        if (ending === 'success') requests[0].resolve([{ file: 'old.go', text: 'old' }]);
        else requests[0].reject(Object.assign(new Error('old search ended'), { name: ending }));
        await first;
        eq(`${ending}: stale search callbacks and completion do not change the new search`, outgoing.length, before);
        requests[1].resolve({ totalMatches: 2, totalFiles: 1 });
        await second;
        eq(`${ending}: the latest search reports its own totals`, outgoing.at(-1), {
            type: 'searchFinished', resultCount: 2, fileCount: 1, truncated: false,
        });
        provider.dispose();
    }
    let resume;
    let searchesStarted = 0;
    const provider = new SourceSearchViewProvider({
        onSearch: () => new Promise((resolve) => { resume = resolve; }),
        engine: { search() { searchesStarted++; } },
    });
    const pending = provider._startSearch({ query: 'cancel before engine starts' });
    await provider._handleMessage({ type: 'clearResults' });
    resume();
    await pending;
    eq('clearing during search setup prevents the cancelled engine from starting', searchesStarted, 0);
    provider.dispose();
}

testSearchFocus().then(testNativeSearchConfiguration).then(testOverlappingSearches).then(done).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
