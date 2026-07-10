'use strict';

/**
 * Lightweight Go source scanner.
 *
 * The goal is NOT to build a full AST. We only need to reason about brace
 * nesting and identifier boundaries while ignoring content that lives inside
 * comments and string / rune literals. The original implementation counted
 * `{` / `}` literally on the raw text, which broke whenever a brace appeared
 * inside a comment or string. This module fixes that class of bug cheaply.
 */

/**
 * Strip Go comments and string/rune literals from a single logical line,
 * returning a "code only" version of the line where braces can be counted
 * safely. Multi-line constructs (block comments, raw strings) are handled by
 * carrying state across lines via the returned `state`.
 *
 * @param {string} line
 * @param {{inBlockComment:boolean,inRawString:boolean}} state
 * @returns {{code:string,state:{inBlockComment:boolean,inRawString:boolean}}}
 */
function stripLine(line, state) {
    let inBlockComment = state.inBlockComment;
    let inRawString = state.inRawString;

    let out = '';
    let i = 0;
    const n = line.length;

    while (i < n) {
        const ch = line[i];
        const next = i + 1 < n ? line[i + 1] : '';

        if (inBlockComment) {
            if (ch === '*' && next === '/') {
                inBlockComment = false;
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }

        if (inRawString) {
            // Raw strings end at the next backtick. They do not process escapes.
            if (ch === '`') {
                inRawString = false;
            }
            i += 1;
            continue;
        }

        // Line comment: rest of the line is a comment.
        if (ch === '/' && next === '/') {
            break;
        }

        // Block comment start.
        if (ch === '/' && next === '*') {
            inBlockComment = true;
            i += 2;
            continue;
        }

        // Raw string start.
        if (ch === '`') {
            inRawString = true;
            i += 1;
            continue;
        }

        // Interpreted string.
        if (ch === '"') {
            i += 1;
            while (i < n) {
                if (line[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (line[i] === '"') {
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }

        // Rune literal.
        if (ch === "'") {
            i += 1;
            while (i < n) {
                if (line[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (line[i] === "'") {
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }

        out += ch;
        i += 1;
    }

    return {
        code: out,
        state: { inBlockComment, inRawString },
    };
}

/**
 * Produce a "code-only" view of every line in the given text. Comments and
 * string literals are blanked out so callers can safely count braces / match
 * identifiers without false positives.
 *
 * @param {string} text
 * @returns {string[]} one entry per original line
 */
function codeLines(text) {
    const lines = text.split('\n');
    const result = new Array(lines.length);
    let state = { inBlockComment: false, inRawString: false };
    for (let i = 0; i < lines.length; i++) {
        const { code, state: nextState } = stripLine(lines[i], state);
        result[i] = code;
        state = nextState;
    }
    return result;
}

/**
 * Count the net brace delta of a code-only line (i.e. `{` minus `}`).
 * @param {string} codeLine
 * @returns {number}
 */
function braceDelta(codeLine) {
    let delta = 0;
    for (let i = 0; i < codeLine.length; i++) {
        if (codeLine[i] === '{') delta += 1;
        else if (codeLine[i] === '}') delta -= 1;
    }
    return delta;
}

module.exports = { stripLine, codeLines, braceDelta };
