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
const { SourceSearchService } = require('../src/source-search');
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
        this.selectCalls = 0;
    }

    focus() {
        this.focusCalls++;
    }

    select() {
        this.selectCalls++;
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

    set className(value) {
        this.classList.values = new Set(value.split(/\s+/).filter(Boolean));
    }

    get className() {
        return [...this.classList.values].join(' ');
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
        'query', 'search-box', 'clear-query', 'scope', 'search-toggle', 'query-details', 'details-toggle',
        'scope-row', 'file-name-row', 'file-name-query', 'file-name-regex', 'results', 'status', 'progress', 'open-editor', 'empty',
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

console.log('\n== collapse and expand all source search results ==');
const resultCollapse = createWebviewHarness();
const resultPost = (data) => resultCollapse.window.dispatch('message', { data });
const collapseState = () => resultCollapse.messages.filter((message) => message.type === 'resultCollapseState').at(-1);
const setResultCollapse = (collapsed) => resultPost({ type: 'setResultsCollapsed', collapsed });
eq('empty view disables the native result toolbar action', collapseState(), { type: 'resultCollapseState', hasResults: false, collapsed: false });
resultPost({ type: 'searchStarted', options: { query: 'needle' } });
resultPost({ type: 'appendResults', results: [
    { file: '/workspace/service.go', scope: 'workspace', line: 10, text: 'needle' },
] });
eq('workspace-only results enable the native collapse action', collapseState(), { type: 'resultCollapseState', hasResults: true, collapsed: false });
resultPost({ type: 'appendResults', results: [
    { file: '/go/pkg/mod/acme/client.go', scope: 'dependency', line: 20, text: 'needle' },
    { file: '/goroot/src/net/http/client.go', scope: 'stdlib', line: 30, text: 'needle' },
] });
const resultFiles = () => resultCollapse.elements.results.querySelectorAll('.file');
const fileFor = (needle) => resultFiles().find((file) => file.innerHTML.includes(needle));
const originalNodes = resultFiles();
setResultCollapse(true);
assert('native collapse command collapses dependency file rows', fileFor('/go/pkg/mod/acme/client.go').classList.contains('collapsed'));
assert('native collapse command collapses workspace file rows', fileFor('/workspace/service.go').classList.contains('collapsed'));
assert('native collapse command collapses standard-library rows', fileFor('/goroot/src/net/http/client.go').classList.contains('collapsed'));
assert('collapsing preserves existing file nodes', resultFiles().every((file, index) => file === originalNodes[index]));
eq('collapsed results switch the native toolbar to expand', collapseState(), { type: 'resultCollapseState', hasResults: true, collapsed: true });
assert('collapsed rows expose their expanded state', resultFiles().every((file) => file.getAttribute('aria-expanded') === 'false'));
resultPost({ type: 'appendResults', results: [
    { file: '/workspace/handler.go', scope: 'workspace', line: 30, text: 'needle' },
    { file: '/go/pkg/mod/acme/transport.go', scope: 'dependency', line: 30, text: 'needle' },
    { file: '/goroot/src/io/io.go', scope: 'stdlib', line: 30, text: 'needle' },
    { file: '/other.go', line: 30, text: 'needle' },
] });
assert('new result batches from every scope honor the active collapsed state', resultFiles().every((file) => file.classList.contains('collapsed')));
fileFor('/workspace/service.go').querySelector('.file-head').dispatch('click');
eq('manually expanding a workspace file restores the native collapse action', collapseState().collapsed, false);
resultPost({ type: 'appendResults', results: [{ file: '/workspace/service.go', scope: 'workspace', line: 21, text: 'needle' }] });
assert('streaming preserves a manually expanded workspace file', !fileFor('/workspace/service.go').classList.contains('collapsed'));
setResultCollapse(false);
assert('native expand command expands every result scope', resultFiles().every((file) => !file.classList.contains('collapsed')));
assert('expanded rows expose their expanded state', resultFiles().every((file) => file.getAttribute('aria-expanded') === 'true'));
for (const expected of [true, false, true, false]) {
    setResultCollapse(!collapseState().collapsed);
    assert(`repeated toolbar clicks ${expected ? 'collapse' : 'expand'} every result`, resultFiles().every((file) => file.classList.contains('collapsed') === expected));
    eq('toolbar state follows each repeated click', collapseState().collapsed, expected);
}
setResultCollapse(true);
resultPost({ type: 'searchStarted', options: { query: 'new query' } });
eq('new searches disable the result toolbar while results reset', collapseState().hasResults, false);
resultPost({ type: 'appendResults', results: [{ file: '/workspace/service.go', scope: 'workspace', line: 20, text: 'new query' }] });
assert('new searches start with expanded results', !fileFor('/workspace/service.go').classList.contains('collapsed'));
resultPost({ type: 'clearResults' });
eq('clearing results disables the native result toolbar', collapseState().hasResults, false);

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

assert('clear-query button starts hidden', typing.elements['clear-query'].hidden);
input('Load');
assert('typing shows the clear-query button', !typing.elements['clear-query'].hidden);
assert('typing reserves room for the clear-query button', typing.elements['search-box'].classList.contains('has-query'));
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
const focusBeforeClear = query.focusCalls;
typing.elements['clear-query'].dispatch('click', { preventDefault() {}, stopPropagation() {} });
eq('clear-query button empties the input', query.value, '');
assert('clear-query button hides after clearing', typing.elements['clear-query'].hidden);
assert('clearing releases the reserved button space', !typing.elements['search-box'].classList.contains('has-query'));
eq('clear-query button keeps input focus', query.focusCalls, focusBeforeClear + 1);
eq('clear-query button immediately clears results', typing.messages.at(-1).type, 'clearResults');
typing.tick(500);
eq('clear-query button cancels queued searches', searches().length, beforeClear);
input('backspace clear');
input('');
assert('deleting the query hides the clear-query button', typing.elements['clear-query'].hidden);
eq('deleting the query also clears results', typing.messages.at(-1).type, 'clearResults');
typing.tick(500);
eq('deleting the query cancels its queued search', searches().length, beforeClear);
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
        eq('first shortcut selects the existing query', harness.elements.query.selectCalls, 1);
        eq('focusing preserves the existing query', harness.elements.query.value, 'LoadComplete');

        await provider.focusSearch();
        eq('repeating shortcut focuses an already visible input', harness.elements.query.focusCalls, 2);
        eq('repeating shortcut selects the existing query for replacement', harness.elements.query.selectCalls, 2);
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

async function testNativeResultToolbar() {
    console.log('\n== native result toolbar ==');
    const manifest = require('../package.json');
    const view = manifest.contributes.views['go-interface-lens'][0];
    eq('sidebar container uses the compact Source Search title', manifest.contributes.viewsContainers.activitybar[0].title, 'Source Search');
    eq('view title matches its container title', view.name, 'Source Search');
    eq('moved views keep the compact Source Search title', view.contextualTitle, 'Source Search');
    for (const [action, icon, title] of [['clearSourceSearch', 'clear-all', 'Clear Search'], ['collapseAllResults', 'collapse-all', 'Collapse All'], ['expandAllResults', 'expand-all', 'Expand All']]) {
        const command = 'go-interface-lens.' + action;
        const contribution = manifest.contributes.commands.find((item) => item.command === command);
        const menu = manifest.contributes.menus['view/title'].find((item) => item.command === command);
        eq(`${action} uses the native workbench icon`, contribution.icon, '$(' + icon + ')');
        eq(`${action} uses the matching toolbar tooltip`, contribution.title, title);
        assert(`${action} is in the native title toolbar`, menu.group.startsWith('navigation'));
        assert(`${action} is limited to the source search view`, menu.when.includes('view == go-interface-lens.sourceSearch'));
    }

    const vscode = require(stubPath);
    const originalCommands = vscode.commands;
    const calls = [];
    vscode.commands = { async executeCommand(...args) { calls.push(args); } };
    const provider = new SourceSearchViewProvider();
    const outgoing = [];
    provider._view = { webview: { postMessage(message) { outgoing.push(message); } } };
    try {
        await provider._handleMessage({ type: 'resultCollapseState', hasResults: true, collapsed: false });
        eq('search results enable the native collapse icon', calls.at(-1), ['setContext', 'goInterfaceLens.sourceSearchResultState', 'expanded']);
        provider.setResultsCollapsed(true);
        eq('native collapse command reaches the Webview', outgoing.at(-1), { type: 'setResultsCollapsed', collapsed: true });
        await provider._handleMessage({ type: 'resultCollapseState', hasResults: true, collapsed: true });
        eq('collapsed results select the native expand icon', calls.at(-1), ['setContext', 'goInterfaceLens.sourceSearchResultState', 'collapsed']);
        provider.setResultsCollapsed(false);
        eq('native expand command reaches the Webview', outgoing.at(-1), { type: 'setResultsCollapsed', collapsed: false });
        await provider._handleMessage({ type: 'resultCollapseState', hasResults: false, collapsed: false });
        eq('empty results disable the native toolbar action', calls.at(-1), ['setContext', 'goInterfaceLens.sourceSearchResultState', 'empty']);
        await provider._handleMessage({ type: 'resultCollapseState', hasResults: true, collapsed: true });
        provider.dispose();
        eq('disposing the view clears the native toolbar state', calls.at(-1), ['setContext', 'goInterfaceLens.sourceSearchResultState', 'empty']);
    } finally {
        provider.dispose();
        vscode.commands = originalCommands;
    }
}

async function testNativeSearchClear() {
    console.log('\n== native toolbar clears the current search ==');
    const clearing = createWebviewHarness();
    let callbacks;
    let finish;
    const provider = new SourceSearchViewProvider({ engine: {
        search(_options, handlers) {
            callbacks = handlers;
            return new Promise((resolve) => { finish = resolve; });
        },
    } });
    const outgoing = [];
    provider._view = { webview: { postMessage(message) {
        outgoing.push(message);
        clearing.window.dispatch('message', { data: message });
    } } };
    clearing.elements.query.value = 'needle';
    clearing.elements.scope.value = 'workspace';
    const pending = provider._startSearch({ query: 'needle', scope: 'workspace', matchCase: true, wholeWord: true });
    try {
        callbacks.onBatch([{ file: '/workspace/service.go', scope: 'workspace', line: 10, text: 'needle' }]);
        clearing.elements.query.value = 'pending next query';
        clearing.elements.query.dispatch('input');
        const focusBefore = clearing.elements.query.focusCalls;
        provider.clearSearch();
        assert('native clear aborts the active engine search', callbacks.signal.aborted);
        eq('native clear empties the current search text', clearing.elements.query.value, '');
        eq('native clear returns focus to the input', clearing.elements.query.focusCalls, focusBefore + 1);
        assert('native clear hides the input clear button', clearing.elements['clear-query'].hidden);
        eq('native clear asks the host to clear its results', clearing.messages.at(-1).type, 'clearResults');
        await provider._handleMessage(clearing.messages.at(-1));
        eq('native clear removes the displayed results', clearing.elements.results.querySelectorAll('.file').length, 0);
        eq('native clear restores the initial search prompt', clearing.elements.status.textContent, 'Type to search source');
        eq('native clear preserves the selected search scope', clearing.elements.scope.value, 'workspace');
        eq('native clear preserves match case', clearing.elements.case.getAttribute('aria-pressed'), 'true');
        eq('native clear preserves whole word', clearing.elements.word.getAttribute('aria-pressed'), 'true');
        const searchesBefore = clearing.messages.filter((message) => message.type === 'search').length;
        clearing.tick(1000);
        eq('native clear cancels pending automatic searches', clearing.messages.filter((message) => message.type === 'search').length, searchesBefore);
        const outgoingBefore = outgoing.length;
        callbacks.onBatch([{ file: '/workspace/stale.go', text: 'needle' }]);
        finish({ totalMatches: 999, totalFiles: 999 });
        await pending;
        eq('cancelled search callbacks cannot restore cleared results', outgoing.length, outgoingBefore);
    } finally {
        finish({ totalMatches: 0, totalFiles: 0 });
        await pending;
        provider.dispose();
    }
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

async function testFileNameOptions() {
    console.log('\n== file name condition in expanded search options ==');
    const ui = createWebviewHarness();
    const click = (id) => ui.elements[id].dispatch('click', { preventDefault() {}, stopPropagation() {} });
    const searches = () => ui.messages.filter((message) => message.type === 'search');
    click('search-toggle');
    eq('expanding the arrow reveals scope and file name together', [ui.elements['scope-row'].hidden, ui.elements['file-name-row'].hidden], [false, false]);
    eq('expanded arrow exposes its expanded state', ui.elements['search-toggle'].getAttribute('aria-expanded'), 'true');
    assert('expanded arrow rotates the right chevron down', /\.search-toggle\[aria-expanded="true"\] \.codicon\s*\{[^}]*transform:\s*rotate\(90deg\)/.test(ui.html));
    assert('file name is placed between content search and the scope selector', ui.html.indexOf('id="query"') < ui.html.indexOf('id="file-name-query"') && ui.html.indexOf('id="file-name-query"') < ui.html.indexOf('id="scope"'));
    ui.elements.query.value = 'needle';
    ui.elements.scope.value = 'dependency';
    ui.elements['file-name-query'].value = '^client.*\\.go$';
    ui.elements['file-name-query'].dispatch('input');
    ui.tick(299);
    eq('filename typing waits for the native debounce', searches().length, 0);
    ui.tick(1);
    eq('all three conditions are sent in one search', [searches().at(-1).options.query, searches().at(-1).options.scope, searches().at(-1).options.fileNameQuery], ['needle', 'dependency', '^client.*\\.go$']);
    click('file-name-regex');
    eq('filename regex can be enabled independently of content regex', [searches().at(-1).options.fileNameRegex, searches().at(-1).options.regex], [true, false]);
    click('search-toggle');
    eq('collapsing the arrow hides scope and filename together', [ui.elements['scope-row'].hidden, ui.elements['file-name-row'].hidden], [true, true]);
    eq('collapsing resets the arrow direction state', ui.elements['search-toggle'].getAttribute('aria-expanded'), 'false');
    eq('collapsing options retains the active filename condition', ui.elements['file-name-query'].value, '^client.*\\.go$');
    click('search-toggle');
    ui.elements.query.value = '';
    ui.elements.query.dispatch('input');
    ui.tick(300);
    eq('empty content still submits a filename search', [searches().at(-1).options.query, searches().at(-1).options.fileNameQuery], ['', '^client.*\\.go$']);
    assert('filename-only queries enable the shared clear button', !ui.elements['clear-query'].hidden);
    ui.elements.scope.value = 'workspace';
    ui.elements.scope.dispatch('change');
    eq('scope changes also refresh filename-only searches', searches().at(-1).options.scope, 'workspace');
    ui.elements['file-name-query'].dispatch('compositionstart');
    ui.elements['file-name-query'].value = '客户端';
    ui.elements['file-name-query'].dispatch('input', { isComposing: true });
    const beforeComposition = searches().length;
    ui.tick(500);
    eq('filename IME input does not search before commit', searches().length, beforeComposition);
    ui.elements['file-name-query'].dispatch('compositionend');
    ui.elements['file-name-query'].dispatch('keydown', { key: 'Enter', preventDefault() {} });
    eq('Enter searches filenames immediately after composition', searches().at(-1).options.fileNameQuery, '客户端');
    ui.tick(500);
    eq('Enter cancels the duplicate delayed filename search', searches().length, beforeComposition + 1);
    ui.elements.query.value = 'needle';
    ui.elements['file-name-query'].dispatch('input');
    click('clear-query');
    eq('shared clear resets both text conditions', [ui.elements.query.value, ui.elements['file-name-query'].value], ['', '']);
    eq('clear preserves the selected scope and filename regex', [ui.elements.scope.value, ui.elements['file-name-regex'].getAttribute('aria-pressed')], ['workspace', 'true']);
    const beforeClear = searches().length;
    ui.tick(500);
    eq('clearing cancels the pending filename debounce', searches().length, beforeClear);

    console.log('\n== filename-only results use the source search view ==');
    const entry = {
        file: '/sdk/client.go', relativePath: 'client.go', scope: 'dependency', rootLabel: 'sdk@v1.2.0',
        fileNameOnly: true, fileNameRanges: [{ start: 0, end: 6 }], matches: [],
    };
    let forwarded;
    const provider = new SourceSearchViewProvider({ engine: { async search(options, progress) {
        forwarded = options;
        progress.onBatch([entry]);
        return { totalFiles: 1, totalMatches: 1 };
    } } });
    provider._post = (message) => ui.window.dispatch('message', { data: message });
    try {
        await provider._startSearch({ query: '', fileNameQuery: '^client', fileNameRegex: true, scope: 'dependency' });
        assert('host accepts a filename query when content is empty', forwarded?.fileNameQuery === '^client' && forwarded.fileNameRegex && forwarded.scope === 'dependency');
        const file = ui.elements.results.querySelectorAll('.file')[0];
        assert('filename-only results render in the existing tree', !!file);
        assert('file name matches are highlighted', file.innerHTML.includes('<mark>client</mark>.go'));
        eq('filename-only results have no empty content rows', file.querySelectorAll('.match').length, 0);
        eq('file count is shown without a content result count', ui.elements.status.textContent, '1 file');
        file.querySelector('.file-head').dispatch('click');
        eq('clicking a filename-only result opens the file directly', ui.messages.at(-1), { type: 'openMatch', match: { file: entry.file } });
        ui.elements['open-editor'].dispatch('click');
        assert('export preserves filename-only result metadata', ui.messages.at(-1).results[0].fileNameOnly);
    } finally {
        provider.dispose();
    }
    const manifest = require('../package.json');
    eq('only the original Source Search view is contributed', manifest.contributes.views['go-interface-lens'].map((view) => view.id), ['go-interface-lens.sourceSearch']);
}

async function testFileNameLineNavigation() {
    console.log('\n== filename:line search and editor navigation ==');
    const ui = createWebviewHarness();
    const root = path.resolve(__dirname, '..');
    const file = path.join(root, 'producer.go');
    const engine = new SourceSearchService({
        getWorkspaceRoots: () => [root],
        runRipgrepFiles: async (_command, _args, _root, handlers) => {
            handlers.onFile(file + '.bak');
            handlers.onFile(file);
        },
        runRipgrep: async (_command, _args, _root, handlers) => {
            for (const candidate of [file + '.bak', file]) {
                handlers.onMatch({ file: candidate, line: 3, column: 7, text: 'prefix needle' });
            }
        },
    });
    const provider = new SourceSearchViewProvider({ engine });
    provider._post = (message) => ui.window.dispatch('message', { data: message });
    const vscode = require(stubPath);
    const originalPosition = vscode.Position;
    const originalSelection = vscode.Selection;
    const originalOpen = vscode.workspace.openTextDocument;
    const originalShow = vscode.window.showTextDocument;
    let opened;
    vscode.Position = class { constructor(line, character) { this.line = line; this.character = character; } };
    vscode.Selection = class { constructor(anchor, active) { this.anchor = anchor; this.active = active; } };
    vscode.workspace.openTextDocument = async (file) => ({ file });
    vscode.window.showTextDocument = async (document, options) => { opened = { document, options }; };
    const submit = async (fileNameQuery, query = '') => {
        ui.elements.query.value = query;
        ui.elements['file-name-query'].value = fileNameQuery;
        ui.elements.scope.value = 'workspace';
        ui.elements['file-name-query'].dispatch('keydown', { key: 'Enter', preventDefault() {} });
        const request = ui.messages.at(-1);
        eq('input sends the complete filename:line expression', request.options.fileNameQuery, fileNameQuery);
        await provider._handleMessage(request);
    };
    const head = () => ui.elements.results.querySelectorAll('.file')[0].querySelector('.file-head');
    try {
        await submit('producer.go:116');
        eq('only the exact filename is rendered', ui.elements.results.querySelectorAll('.file').length, 1);
        head().dispatch('click');
        eq('file click carries the requested line', ui.messages.at(-1), { type: 'openMatch', match: { file, line: 116 } });
        await provider._handleMessage(ui.messages.at(-1));
        eq('line 116 opens at the zero-based editor position 115:0', [opened.document.file, opened.options.selection.active.line, opened.options.selection.active.character], [file, 115, 0]);
        head().dispatch('keydown', { key: 'Enter', preventDefault() {} });
        await provider._handleMessage(ui.messages.at(-1));
        eq('keyboard activation uses the same target line', opened.options.selection.active.line, 115);
        ui.elements['open-editor'].dispatch('click');
        eq('export preserves the requested line', ui.messages.at(-1).results[0].targetLine, 116);

        await submit('producer.go:12');
        head().dispatch('click');
        await provider._handleMessage(ui.messages.at(-1));
        eq('changing the suffix replaces the previous target line', opened.options.selection.active.line, 11);

        await submit('producer.go:116', 'needle');
        const row = ui.elements.results.querySelectorAll('.match')[0];
        assert('content preview retains its actual matching line', row.innerHTML.includes('line-number">3:'));
        row.dispatch('click');
        await provider._handleMessage(ui.messages.at(-1));
        eq('content result navigation honors the explicit filename line', [opened.options.selection.active.line, opened.options.selection.active.character], [115, 0]);
        let forwarded;
        provider.onOpenMatch = async (match) => { forwarded = match; };
        await provider._handleMessage(ui.messages.at(-1));
        eq('extension navigation callback also receives the explicit target', [forwarded.line, forwarded.column], [116, 1]);
        provider.onOpenMatch = undefined;

        await submit('producer.go');
        head().dispatch('click');
        await provider._handleMessage(ui.messages.at(-1));
        eq('removing the suffix restores opening at the start of the file', [opened.options.selection.active.line, opened.options.selection.active.character], [0, 0]);
    } finally {
        provider.dispose();
        engine.dispose();
        vscode.Position = originalPosition;
        vscode.Selection = originalSelection;
        vscode.workspace.openTextDocument = originalOpen;
        vscode.window.showTextDocument = originalShow;
    }
}

testSearchFocus().then(testNativeSearchConfiguration).then(testNativeResultToolbar).then(testNativeSearchClear).then(testOverlappingSearches).then(testFileNameOptions).then(testFileNameLineNavigation).then(done).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
