/**
 * Command output as a person would see it in a terminal, for a model that reads it as text (21 §4.3). A pipe keeps
 * what a terminal would have acted on: every frame of a progress bar that redraws its line with a carriage return,
 * colour codes, backspaces of a spinner. They cost context and bury the lines that matter, so they are played out
 * here: each line ends up as the terminal would show it.
 */

/**
 * One escape sequence at the start of the match: CSI (`ESC [ … letter`), OSC and the other string sequences up to
 * their terminator, a character-set choice, or a two-character escape.
 */
const ESCAPE_SOURCE =
    '\\x1b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?|[PX^_][^\\x1b]*(?:\\x1b\\\\)?|[ -/]+[0-~]|[0-~])';
const ESCAPE_AT = new RegExp(ESCAPE_SOURCE, 'y');
/** Anything a terminal would act on rather than show, tab and line break aside. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this looks for
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/;
/** `ESC [ K` and its variants: erase in line. */
const ERASE_LINE = /^.\[([0-2]?)K$/;
/** The cursor moved within its line: to a column (`G`), back (`D`) or forward (`C`). */
const MOVE = /^.\[(\d*)([GDC])$/;

/** Identical lines in a row that stay as they are; a longer run is one line and a count. */
const REPEATS_KEPT = 3;
/** How far right of what is written the cursor can be sent (`ESC [ 999 C`): a terminal stops it at its width. */
const COLUMNS = 200;

/**
 * One line as a terminal would leave it: carriage returns, backspaces and cursor moves put the cursor where the
 * next characters go, erasing clears what was there, and every other escape sequence is dropped. Linear in the
 * length of the line, however often it is cleared: a progress display of thousands of frames is one line here.
 */
function renderLine(line: string): string {
    const cells: string[] = [];
    let column = 0;
    /** The cells before this one are known to be blank: clearing them again costs nothing. */
    let blank = 0;
    const clearToCursor = (): void => {
        const upTo = Math.min(column, cells.length);
        if (upTo > blank) {
            cells.fill(' ', blank, upTo);
            blank = upTo;
        }
    };
    for (let i = 0; i < line.length; ) {
        const code = line.charCodeAt(i);
        if (code === 0x1b) {
            ESCAPE_AT.lastIndex = i;
            const sequence = ESCAPE_AT.exec(line)?.[0];
            if (sequence === undefined) {
                i++;
                continue;
            }
            const erase = ERASE_LINE.exec(sequence);
            const move = MOVE.exec(sequence);
            if (erase) {
                // `1`, `2`: what is before the cursor is gone; `0` (the default), `2`: what is from it on.
                if (erase[1] === '1' || erase[1] === '2') {
                    clearToCursor();
                }
                if (erase[1] !== '1' && cells.length > column) {
                    cells.length = column;
                    blank = Math.min(blank, column);
                }
            } else if (move) {
                const count = Math.max(1, Number(move[1] || 1));
                const edge = Math.max(cells.length, COLUMNS);
                column =
                    move[2] === 'G'
                        ? Math.min(count - 1, edge)
                        : move[2] === 'D'
                          ? Math.max(0, column - count)
                          : Math.min(column + count, edge);
            }
            i += sequence.length;
        } else if (code === 13) {
            column = 0;
            i++;
        } else if (code === 8) {
            column = Math.max(0, column - 1);
            i++;
        } else if (code !== 9 && (code < 32 || code === 127)) {
            i++;
        } else {
            const char = String.fromCodePoint(line.codePointAt(i) ?? code);
            while (cells.length < column) {
                cells.push(' ');
            }
            cells[column] = char;
            blank = Math.min(blank, column);
            column++;
            i += char.length;
        }
    }
    return cells.join('').trimEnd();
}

/**
 * `text` as a terminal would show it: progress bars and spinners down to their last frame, colour and cursor codes
 * gone, and a line printed many times over once with a count. Output without any of this comes back as it is.
 */
export function renderTerminalText(text: string): string {
    const lines = text.split('\n');
    const rendered: string[] = [];
    let run = 0;
    const closeRun = (): void => {
        if (run > REPEATS_KEPT) {
            rendered.push(`[... the line above ${run} times in a row; ${run - 1} repeats left out ...]`);
        } else {
            for (let k = 1; k < run; k++) {
                rendered.push(rendered.at(-1) ?? '');
            }
        }
        run = 0;
    };
    for (const raw of lines) {
        const plain = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        const line = CONTROL.test(plain) ? renderLine(plain) : plain;
        if (run > 0 && line === rendered.at(-1) && line.trim() !== '') {
            run++;
            continue;
        }
        closeRun();
        rendered.push(line);
        run = 1;
    }
    closeRun();
    return rendered.join('\n');
}
