/**
 * Reading web pages for `web_fetch`: a forgiving HTML parser that builds a light tree, and a converter from that tree
 * to markdown a model reads easily. It is not a browser: no scripts, no style sheets (only inline `display: none`),
 * and only the error recovery that matters most for text: paragraphs, list items, table cells and headings close
 * implicitly, and an end tag never closes elements outside the table cell it appears in.
 */

export interface HtmlElement {
    /** Lower-case tag name; `#document` for the root. */
    readonly name: string;
    /** Attribute values with character references decoded; the first of duplicate attributes wins. */
    readonly attrs: Readonly<Record<string, string>>;
    readonly children: HtmlNode[];
    readonly parent: HtmlElement | undefined;
}

/** Text nodes are strings with their character references already decoded. */
export type HtmlNode = HtmlElement | string;

export interface PageText {
    /** The page's `<title>`, whitespace collapsed; empty when it has none. */
    readonly title: string;
    readonly markdown: string;
}

const set = (names: string): ReadonlySet<string> => new Set(names.split(' '));

const VOID_ELEMENTS = set('area base br col embed hr img input keygen link meta param source track wbr');
/** Elements whose content is text up to their end tag. */
const RAW_TEXT = set('script style xmp iframe noembed noframes noscript title textarea');
/** Raw text elements whose text is kept, with character references decoded. */
const KEPT_RAW_TEXT = set('title textarea xmp');
/** Start tags that close an open `p`. */
const CLOSES_P = set(
    'address article aside blockquote center dd details dialog dir div dl dt fieldset figcaption figure footer form ' +
        'h1 h2 h3 h4 h5 h6 header hgroup hr li listing main menu nav ol p pre search section summary table ul xmp',
);
/** Text-level elements an open `p` may sit under when a block starts. */
const PHRASING = set(
    'a abbr b bdi bdo big cite code data del dfn em font i ins kbd label mark nobr q s samp small span strike strong ' +
        'sub sup time tt u var',
);
const HEADINGS = set('h1 h2 h3 h4 h5 h6');
/** A start tag closes the topmost open element named in `close`, unless one named in `scope` comes first. */
const IMPLIED_END: Readonly<
    Record<string, { readonly close: ReadonlySet<string>; readonly scope: ReadonlySet<string> }>
> = {
    li: { close: set('li'), scope: set('ul ol menu dir table') },
    dt: { close: set('dt dd'), scope: set('dl table') },
    dd: { close: set('dt dd'), scope: set('dl table') },
    tr: { close: set('tr'), scope: set('table thead tbody tfoot') },
    td: { close: set('td th'), scope: set('tr table') },
    th: { close: set('td th'), scope: set('tr table') },
    thead: { close: set('thead tbody tfoot'), scope: set('table') },
    tbody: { close: set('thead tbody tfoot'), scope: set('table') },
    tfoot: { close: set('thead tbody tfoot'), scope: set('table') },
    option: { close: set('option'), scope: set('select datalist optgroup') },
    optgroup: { close: set('optgroup option'), scope: set('select') },
};
const TABLE_PARTS = set('table caption thead tbody tfoot tr td th');
/** An end tag does not close elements outside these, so a stray `</div>` in a cell cannot end the table. */
const END_TAG_BARRIERS = set('td th caption table template button');
const LI_END_BARRIERS = set('td th caption table template button ul ol');
const TABLE_END_BARRIERS = set('table');
/** Malformed pages can nest without end; deeper elements are kept, but flat. */
const MAX_DEPTH = 400;

const CHAR_TAB = 9;
const CHAR_LF = 10;
const CHAR_FF = 12;
const CHAR_CR = 13;
const CHAR_SPACE = 32;
const CHAR_EXCLAMATION = 33;
const CHAR_DQUOTE = 34;
const CHAR_SQUOTE = 39;
const CHAR_SLASH = 47;
const CHAR_EQUALS = 61;
const CHAR_GT = 62;
const CHAR_QUESTION = 63;

function isSpace(code: number): boolean {
    return code === CHAR_SPACE || code === CHAR_TAB || code === CHAR_LF || code === CHAR_CR || code === CHAR_FF;
}

function isLetter(code: number): boolean {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

// Character references ---------------------------------------------------------------------------------------

/** Names for consecutive code points from `start`. */
function run(start: number, names: string): Array<[string, string]> {
    return names.split(' ').map((name, index) => [name, String.fromCodePoint(start + index)]);
}

/** The named references pages use in practice: HTML 4's full set plus common punctuation of HTML 5. */
const NAMED_REFERENCES: Readonly<Record<string, string>> = Object.assign(
    Object.create(null) as Record<string, string>,
    Object.fromEntries([
        ...run(
            0xa0,
            'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 ' +
                'acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest',
        ),
        ...run(
            0xc0,
            'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH ' +
                'Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave ' +
                'aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ' +
                'ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml',
        ),
        ...run(0x391, 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho'),
        ...run(0x3a3, 'Sigma Tau Upsilon Phi Chi Psi Omega'),
        ...run(
            0x3b1,
            'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau ' +
                'upsilon phi chi psi omega',
        ),
        ...run(0x2190, 'larr uarr rarr darr harr'),
        ...run(0x21d0, 'lArr uArr rArr dArr hArr'),
        ...run(0x2002, 'ensp emsp'),
        ...run(0x2009, 'thinsp'),
        ...run(0x200c, 'zwnj zwj lrm rlm'),
        ...run(0x2013, 'ndash mdash'),
        ...run(0x2018, 'lsquo rsquo sbquo'),
        ...run(0x201c, 'ldquo rdquo bdquo'),
        ...run(0x2020, 'dagger Dagger bull'),
        ...run(0x2032, 'prime Prime'),
        ...run(0x2039, 'lsaquo rsaquo'),
        ...run(0x2264, 'le ge'),
        ['amp', '&'],
        ['lt', '<'],
        ['gt', '>'],
        ['quot', '"'],
        ['apos', "'"],
        ['hellip', '…'],
        ['permil', '‰'],
        ['euro', '€'],
        ['trade', '™'],
        ['minus', '−'],
        ['ne', '≠'],
        ['asymp', '≈'],
        ['equiv', '≡'],
        ['infin', '∞'],
        ['sum', '∑'],
        ['radic', '√'],
        ['isin', '∈'],
        ['and', '∧'],
        ['or', '∨'],
        ['cap', '∩'],
        ['cup', '∪'],
        ['sdot', '⋅'],
        ['loz', '◊'],
        ['check', '✓'],
        ['cross', '✗'],
        ['starf', '★'],
        ['star', '☆'],
        ['crarr', '↵'],
    ]),
);

const REFERENCE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g;

/** Decodes numeric and the common named character references; unknown names stay as written. */
export function decodeEntities(text: string): string {
    if (!text.includes('&')) {
        return text;
    }
    return text.replace(REFERENCE, (whole, decimal?: string, hex?: string, name?: string) => {
        if (name !== undefined) {
            return NAMED_REFERENCES[name] ?? whole;
        }
        const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? '', 16);
        if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
            return '�';
        }
        return String.fromCodePoint(code);
    });
}

// Parsing ------------------------------------------------------------------------------------------------------

interface StartTag {
    readonly name: string;
    readonly attrs: Record<string, string>;
    readonly selfClosing: boolean;
    /** Index just past the tag. */
    readonly end: number;
}

/** Reads a start tag whose name begins at `start` (just past `<`); quoted attribute values may contain `>`. */
function readStartTag(html: string, start: number): StartTag {
    const length = html.length;
    let pos = start;
    while (pos < length) {
        const code = html.charCodeAt(pos);
        if (isSpace(code) || code === CHAR_SLASH || code === CHAR_GT) {
            break;
        }
        pos++;
    }
    const name = html.slice(start, pos).toLowerCase();
    const attrs = Object.create(null) as Record<string, string>;
    for (;;) {
        while (pos < length) {
            const code = html.charCodeAt(pos);
            if (code === CHAR_SLASH && html.charCodeAt(pos + 1) === CHAR_GT) {
                return { name, attrs, selfClosing: true, end: pos + 2 };
            }
            if (!isSpace(code) && code !== CHAR_SLASH) {
                break;
            }
            pos++;
        }
        if (pos >= length) {
            return { name, attrs, selfClosing: false, end: length };
        }
        if (html.charCodeAt(pos) === CHAR_GT) {
            return { name, attrs, selfClosing: false, end: pos + 1 };
        }
        const nameStart = pos;
        while (pos < length) {
            const code = html.charCodeAt(pos);
            if (isSpace(code) || code === CHAR_SLASH || code === CHAR_GT || (code === CHAR_EQUALS && pos > nameStart)) {
                break;
            }
            pos++;
        }
        const attrName = html.slice(nameStart, pos).toLowerCase();
        while (pos < length && isSpace(html.charCodeAt(pos))) {
            pos++;
        }
        let value = '';
        if (html.charCodeAt(pos) === CHAR_EQUALS) {
            pos++;
            while (pos < length && isSpace(html.charCodeAt(pos))) {
                pos++;
            }
            const quote = html.charCodeAt(pos);
            if (quote === CHAR_DQUOTE || quote === CHAR_SQUOTE) {
                const close = html.indexOf(quote === CHAR_DQUOTE ? '"' : "'", pos + 1);
                value = html.slice(pos + 1, close < 0 ? length : close);
                pos = close < 0 ? length : close + 1;
            } else {
                const valueStart = pos;
                while (pos < length && !isSpace(html.charCodeAt(pos)) && html.charCodeAt(pos) !== CHAR_GT) {
                    pos++;
                }
                value = html.slice(valueStart, pos);
            }
        }
        if (attrName !== '' && !(attrName in attrs)) {
            attrs[attrName] = decodeEntities(value);
        }
    }
}

const rawTextEnds = new Map<string, RegExp>();

/** Where the raw text that starts at `from` ends: the index of its end tag, or the end of `html`. */
function rawTextEnd(html: string, name: string, from: number): number {
    let pattern = rawTextEnds.get(name);
    if (pattern === undefined) {
        pattern = new RegExp(`</${name}[\\s/>]`, 'gi');
        rawTextEnds.set(name, pattern);
    }
    pattern.lastIndex = from;
    return pattern.exec(html)?.index ?? html.length;
}

/** Parses an HTML document or fragment into a tree under a `#document` element. */
export function parseHtml(html: string): HtmlElement {
    const root: HtmlElement = { name: '#document', attrs: {}, children: [], parent: undefined };
    const stack: HtmlElement[] = [root];
    const current = (): HtmlElement => stack[stack.length - 1] as HtmlElement;
    const addText = (raw: string): void => {
        if (raw !== '') {
            current().children.push(decodeEntities(raw));
        }
    };
    const append = (name: string, attrs: Record<string, string>): HtmlElement => {
        const parent = current();
        const element: HtmlElement = { name, attrs, children: [], parent };
        parent.children.push(element);
        return element;
    };
    /** Pops the stack down to and including the topmost open element `names` accepts, unless a barrier comes first. */
    const closeTo = (names: ReadonlySet<string> | string, barriers: ReadonlySet<string>): void => {
        for (let index = stack.length - 1; index > 0; index--) {
            const name = (stack[index] as HtmlElement).name;
            if (typeof names === 'string' ? name === names : names.has(name)) {
                stack.length = index;
                return;
            }
            if (barriers.has(name)) {
                return;
            }
        }
    };
    const closeParagraph = (): void => {
        for (let index = stack.length - 1; index > 0; index--) {
            const name = (stack[index] as HtmlElement).name;
            if (name === 'p') {
                stack.length = index;
                return;
            }
            if (!PHRASING.has(name)) {
                return;
            }
        }
    };
    const length = html.length;
    let pos = 0;
    while (pos < length) {
        const lt = html.indexOf('<', pos);
        if (lt < 0) {
            addText(html.slice(pos));
            break;
        }
        addText(html.slice(pos, lt));
        const next = html.charCodeAt(lt + 1);
        if (html.startsWith('<!--', lt)) {
            const end = html.indexOf('-->', lt + 4);
            pos = end < 0 ? length : end + 3;
        } else if (html.startsWith('<![CDATA[', lt)) {
            const end = html.indexOf(']]>', lt + 9);
            current().children.push(html.slice(lt + 9, end < 0 ? length : end));
            pos = end < 0 ? length : end + 3;
        } else if (next === CHAR_EXCLAMATION || next === CHAR_QUESTION) {
            // A doctype, another declaration or a processing instruction.
            const end = html.indexOf('>', lt + 2);
            pos = end < 0 ? length : end + 1;
        } else if (next === CHAR_SLASH && isLetter(html.charCodeAt(lt + 2))) {
            const end = html.indexOf('>', lt + 2);
            const name = (/^[^\s/>]+/.exec(html.slice(lt + 2, end < 0 ? length : end))?.[0] ?? '').toLowerCase();
            pos = end < 0 ? length : end + 1;
            if (name === 'br') {
                append('br', {});
            } else {
                closeTo(
                    name,
                    TABLE_PARTS.has(name) ? TABLE_END_BARRIERS : name === 'li' ? LI_END_BARRIERS : END_TAG_BARRIERS,
                );
            }
        } else if (isLetter(next)) {
            const tag = readStartTag(html, lt + 1);
            pos = tag.end;
            const { name } = tag;
            if (CLOSES_P.has(name)) {
                closeParagraph();
            }
            if (name === 'a') {
                // Links do not nest: a new one ends the one still open.
                closeTo('a', END_TAG_BARRIERS);
            }
            const implied = IMPLIED_END[name];
            if (implied) {
                closeTo(implied.close, implied.scope);
            }
            if (HEADINGS.has(name) && HEADINGS.has(current().name)) {
                stack.pop();
            }
            const element = append(name, tag.attrs);
            if (RAW_TEXT.has(name) && !tag.selfClosing) {
                const end = rawTextEnd(html, name, pos);
                if (KEPT_RAW_TEXT.has(name)) {
                    element.children.push(decodeEntities(html.slice(pos, end)));
                }
                const close = end < length ? html.indexOf('>', end) : -1;
                pos = close < 0 ? length : close + 1;
            } else if (!VOID_ELEMENTS.has(name) && !tag.selfClosing && stack.length < MAX_DEPTH) {
                stack.push(element);
            }
        } else {
            addText('<');
            pos = lt + 1;
        }
    }
    return root;
}

// Tree helpers -------------------------------------------------------------------------------------------------

/** Never rendered, and not searched for content either. */
const DROPPED = set(
    'script style noscript template svg math head title meta link base iframe object embed canvas audio video ' +
        'picture source track map button select option optgroup datalist input textarea meter progress',
);
/** Site navigation and other page furniture, left out unless the page has little else. */
const CHROME = set('nav aside footer');
const CHROME_ROLES = set('navigation complementary contentinfo banner');
const BLOCKS = set(
    'address article aside body caption center dd details dialog dir div dl dt fieldset figcaption figure footer ' +
        'form header hgroup html legend main nav p search section summary tbody tfoot thead tr',
);

function isElement(node: HtmlNode | undefined): node is HtmlElement {
    return node !== undefined && typeof node !== 'string';
}

export function hasClass(element: HtmlElement, name: string): boolean {
    return element.attrs.class?.split(/\s+/).includes(name) === true;
}

function isHidden(element: HtmlElement): boolean {
    return (
        'hidden' in element.attrs ||
        /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(element.attrs.style ?? '') ||
        (element.name === 'dialog' && !('open' in element.attrs))
    );
}

/**
 * The first element below `root`, in document order, that `match` accepts. Dropped elements (scripts, the head…) are
 * not searched unless `everywhere` is set.
 */
export function findFirst(
    root: HtmlElement,
    match: (element: HtmlElement) => boolean,
    everywhere = false,
): HtmlElement | undefined {
    for (const child of root.children) {
        if (!isElement(child) || (!everywhere && DROPPED.has(child.name))) {
            continue;
        }
        if (match(child)) {
            return child;
        }
        const found = findFirst(child, match, everywhere);
        if (found) {
            return found;
        }
    }
    return undefined;
}

/** The elements below `root` that `match` accepts, without looking inside the ones it accepted. */
export function findAll(root: HtmlElement, match: (element: HtmlElement) => boolean): HtmlElement[] {
    const found: HtmlElement[] = [];
    const visit = (element: HtmlElement): void => {
        for (const child of element.children) {
            if (!isElement(child) || DROPPED.has(child.name)) {
                continue;
            }
            if (match(child)) {
                found.push(child);
            } else {
                visit(child);
            }
        }
    };
    visit(root);
    return found;
}

/** The text of an element as written, without dropped elements; `<br>` and block ends become line breaks. */
export function plainText(root: HtmlElement): string {
    let text = '';
    const visit = (element: HtmlElement): void => {
        for (const child of element.children) {
            if (typeof child === 'string') {
                text += child;
            } else if (child.name === 'br') {
                text += '\n';
            } else if (!DROPPED.has(child.name)) {
                visit(child);
                if (BLOCKS.has(child.name) && !text.endsWith('\n')) {
                    text += '\n';
                }
            }
        }
    };
    visit(root);
    return text;
}

/** Runs of whitespace, no-break spaces included, as one space. */
export function collapseSpace(text: string): string {
    return text.replace(/\s+/g, ' ');
}

// Markdown -----------------------------------------------------------------------------------------------------

interface Prefix {
    readonly first: string;
    readonly rest: string;
    used: boolean;
}

/**
 * Collects markdown lines. Text gathers into the current line until a block boundary flushes it; list items and
 * quotes prefix every line written inside them, a list item's marker only its first line. In inline mode everything
 * stays on one line (link texts, headings, table cells).
 */
class Writer {
    readonly inline: boolean;
    readonly #lines: string[] = [];
    readonly #prefixes: Prefix[] = [];
    #text = '';
    /** A blank line goes before the next line. */
    #blank = false;
    /** Something was written since the last block boundary. */
    #dirty = false;

    constructor(inline: boolean) {
        this.inline = inline;
    }

    /** Text with its whitespace collapsed; a space after another one, or at the start of a line, is dropped. */
    text(value: string): void {
        const skip = value.startsWith(' ') && (this.#text === '' || this.#text.endsWith(' '));
        this.#text += skip ? value.slice(1) : value;
    }

    /** Markup such as a link or a code span, written as it is. */
    raw(value: string): void {
        this.#text += value;
    }

    lineBreak(): void {
        if (this.inline) {
            this.text(' ');
        } else if (!this.#flush() && this.#dirty) {
            this.#blank = true;
        }
    }

    /** A paragraph boundary: what follows starts after a blank line. */
    block(): void {
        if (this.inline) {
            this.text(' ');
            return;
        }
        this.#flush();
        if (this.#dirty) {
            this.#blank = true;
            this.#dirty = false;
        }
    }

    /** A boundary without a blank line, as between list items. */
    tight(): void {
        if (this.inline) {
            this.text(' ');
            return;
        }
        this.#flush();
        this.#blank = false;
        this.#dirty = false;
    }

    /** A whole line written as it is, such as a heading, a table row or a line of code. */
    line(content: string): void {
        if (this.inline) {
            this.text(collapseSpace(` ${content} `));
            return;
        }
        this.#flush();
        this.#emit(content);
    }

    push(first: string, rest: string): void {
        this.#flush();
        this.#prefixes.push({ first, rest, used: false });
    }

    pop(): void {
        this.#flush();
        this.#prefixes.pop();
    }

    result(): string {
        if (this.inline) {
            return this.#text.trim();
        }
        this.#flush();
        return this.#lines.join('\n').trimEnd();
    }

    #flush(): boolean {
        const text = this.#text.trim();
        this.#text = '';
        if (text === '') {
            return false;
        }
        this.#emit(text);
        return true;
    }

    #emit(content: string): void {
        if (this.#blank && this.#lines.length > 0) {
            // The gap before a quote or list item that has not started yet belongs to the text around it.
            const levels = this.#prefixes.filter((level) => level.used);
            this.#lines.push(
                levels
                    .map((level) => level.rest)
                    .join('')
                    .trimEnd(),
            );
        }
        this.#blank = false;
        let prefix = '';
        for (const level of this.#prefixes) {
            prefix += level.used ? level.rest : level.first;
            level.used = true;
        }
        this.#lines.push(prefix + content);
        this.#dirty = true;
    }
}

const LINK_PROTOCOLS = set('http: https: mailto: ftp:');
/** A page whose chosen part has less text than this is converted again, whole, when that says much more. */
const SHORT_TEXT = 200;

interface RenderOptions {
    readonly base: string;
    /** Keep navigation, sidebars and footers. */
    readonly chrome: boolean;
    readonly inline?: boolean;
    /** Inside a link: nested links are only text. */
    readonly inLink?: boolean;
}

/** A code span around `text`, with a fence longer than any run of backticks inside it. */
function codeSpan(text: string): string {
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((ticks) => ticks.length));
    const fence = '`'.repeat(longest + 1);
    const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
    return `${fence}${padded}${fence}`;
}

/** The language a code block names in its classes (`language-ts`, `lang-py`, GitHub's `highlight-source-js`). */
function codeLanguage(pre: HtmlElement): string {
    const code = pre.children.find((child): child is HtmlElement => isElement(child) && child.name === 'code');
    for (const element of [pre, code, pre.parent]) {
        const match = /(?:^|\s)(?:language|lang|highlight-source)-([\w+#.-]+)/.exec(element?.attrs.class ?? '');
        if (match?.[1]) {
            return match[1].toLowerCase();
        }
    }
    return '';
}

function tableRows(table: HtmlElement): HtmlElement[] {
    const rows: HtmlElement[] = [];
    const visit = (element: HtmlElement): void => {
        for (const child of element.children) {
            if (!isElement(child) || isHidden(child)) {
                continue;
            }
            if (child.name === 'tr') {
                rows.push(child);
            } else if (child.name !== 'table') {
                visit(child);
            }
        }
    };
    visit(table);
    return rows;
}

function cellsOf(row: HtmlElement): HtmlElement[] {
    return row.children.filter(
        (child): child is HtmlElement => isElement(child) && (child.name === 'td' || child.name === 'th'),
    );
}

class Renderer {
    readonly #options: RenderOptions;
    readonly #out: Writer;

    constructor(options: RenderOptions) {
        this.#options = options;
        this.#out = new Writer(options.inline === true);
    }

    result(): string {
        return this.#out.result();
    }

    children(element: HtmlElement): void {
        for (const child of element.children) {
            if (typeof child === 'string') {
                this.#out.text(collapseSpace(child));
            } else {
                this.element(child);
            }
        }
    }

    element(element: HtmlElement): void {
        const { name } = element;
        if (DROPPED.has(name) || isHidden(element)) {
            return;
        }
        if (!this.#options.chrome && (CHROME.has(name) || CHROME_ROLES.has(element.attrs.role ?? ''))) {
            return;
        }
        switch (name) {
            case 'br':
                this.#out.lineBreak();
                return;
            case 'hr':
                this.#out.block();
                this.#out.line('---');
                this.#out.block();
                return;
            case 'h1':
            case 'h2':
            case 'h3':
            case 'h4':
            case 'h5':
            case 'h6':
                this.#heading(element, Number(name.slice(1)));
                return;
            case 'ul':
            case 'ol':
            case 'menu':
            case 'dir':
                this.#list(element);
                return;
            case 'li':
                this.#item(element, '- ');
                return;
            case 'pre':
            case 'xmp':
            case 'listing':
                this.#pre(element);
                return;
            case 'code':
            case 'kbd':
            case 'samp':
            case 'tt': {
                const text = collapseSpace(plainText(element)).trim();
                if (text !== '') {
                    this.#out.raw(codeSpan(text));
                }
                return;
            }
            case 'a':
                this.#link(element);
                return;
            case 'blockquote':
                this.#quote(element);
                return;
            case 'table':
                this.#table(element);
                return;
            case 'td':
            case 'th':
                this.#spaced(element);
                return;
            case 'img':
                return;
        }
        if (BLOCKS.has(name)) {
            this.#out.block();
            this.children(element);
            this.#out.block();
            return;
        }
        this.children(element);
    }

    /** The children of an element as words among the text around them. */
    #spaced(element: HtmlElement): void {
        this.#out.text(' ');
        this.children(element);
        this.#out.text(' ');
    }

    /** The children of `element` on one line. */
    #inlineOf(element: HtmlElement, inLink = this.#options.inLink === true): string {
        const renderer = new Renderer({ ...this.#options, inline: true, inLink });
        renderer.children(element);
        return renderer.result();
    }

    #heading(element: HtmlElement, level: number): void {
        if (this.#out.inline) {
            this.#spaced(element);
            return;
        }
        const text = this.#inlineOf(element);
        if (text !== '') {
            this.#out.block();
            this.#out.line(`${'#'.repeat(level)} ${text}`);
            this.#out.block();
        }
    }

    #list(element: HtmlElement): void {
        if (this.#out.inline) {
            this.#spaced(element);
            return;
        }
        const ordered = element.name === 'ol';
        const start = Number.parseInt(element.attrs.start ?? '1', 10);
        let number = Number.isFinite(start) ? start : 1;
        // A list nested in an item follows the item's first line directly.
        if (element.parent?.name === 'li') {
            this.#out.tight();
        } else {
            this.#out.block();
        }
        let first = true;
        for (const child of element.children) {
            if (typeof child === 'string') {
                this.#out.text(collapseSpace(child));
            } else if (child.name !== 'li') {
                this.element(child);
            } else if (!isHidden(child)) {
                if (!first) {
                    this.#out.tight();
                }
                first = false;
                this.#item(child, ordered ? `${number++}. ` : '- ');
            }
        }
        this.#out.block();
    }

    #item(element: HtmlElement, marker: string): void {
        if (this.#out.inline) {
            this.#spaced(element);
            return;
        }
        this.#out.push(marker, ' '.repeat(marker.length));
        this.children(element);
        this.#out.pop();
    }

    #pre(element: HtmlElement): void {
        const text = plainText(element);
        if (this.#out.inline) {
            this.#out.text(collapseSpace(` ${text} `));
            return;
        }
        const code = text.replace(/^\r?\n/, '').trimEnd();
        if (code === '') {
            return;
        }
        let fence = '```';
        while (code.includes(fence)) {
            fence += '`';
        }
        this.#out.block();
        this.#out.line(fence + codeLanguage(element));
        for (const line of code.split(/\r?\n/)) {
            this.#out.line(line);
        }
        this.#out.line(fence);
        this.#out.block();
    }

    #link(element: HtmlElement): void {
        if (this.#options.inLink) {
            this.children(element);
            return;
        }
        let text = this.#inlineOf(element, true);
        if (text === '') {
            const image = findFirst(element, (child) => child.name === 'img' && Boolean(child.attrs.alt?.trim()));
            text = collapseSpace(image?.attrs.alt ?? element.attrs['aria-label'] ?? element.attrs.title ?? '').trim();
        }
        if (text === '') {
            return;
        }
        const written = plainText(element);
        if (/^\s/.test(written)) {
            this.#out.text(' ');
        }
        const href = this.#href(element.attrs.href);
        if (href === undefined) {
            this.#out.text(text);
        } else {
            this.#out.raw(`[${text.replace(/[[\]]/g, '\\$&')}](${href})`);
        }
        if (/\s$/.test(written)) {
            this.#out.text(' ');
        }
    }

    /** An absolute URL for a link; none for in-page anchors, scripts and other schemes. */
    #href(value: string | undefined): string | undefined {
        const href = value?.trim();
        if (!href || href.startsWith('#')) {
            return undefined;
        }
        let url: URL;
        try {
            url = new URL(href, this.#options.base);
        } catch {
            return undefined;
        }
        if (!LINK_PROTOCOLS.has(url.protocol)) {
            return undefined;
        }
        return url.href.replace(/[()]/g, (char) => (char === '(' ? '%28' : '%29'));
    }

    #quote(element: HtmlElement): void {
        if (this.#out.inline) {
            this.#spaced(element);
            return;
        }
        this.#out.block();
        this.#out.push('> ', '> ');
        this.children(element);
        this.#out.pop();
        this.#out.block();
    }

    #table(element: HtmlElement): void {
        if (this.#out.inline) {
            this.#spaced(element);
            return;
        }
        const rows = tableRows(element);
        this.#out.block();
        // A table used for layout (one column, or tables inside it): its cells are read as ordinary blocks.
        const layout =
            element.attrs.role === 'presentation' ||
            rows.every((row) => cellsOf(row).length <= 1) ||
            findFirst(element, (child) => child.name === 'table') !== undefined;
        if (layout) {
            this.children(element);
            this.#out.block();
            return;
        }
        const caption = element.children.find(
            (child): child is HtmlElement => isElement(child) && child.name === 'caption',
        );
        const title = caption ? this.#inlineOf(caption) : '';
        if (title !== '') {
            this.#out.line(title);
        }
        let header = false;
        for (const row of rows) {
            const cells = cellsOf(row)
                .filter((cell) => !isHidden(cell))
                .map((cell) => this.#inlineOf(cell).replace(/\|/g, '\\|'));
            if (cells.every((cell) => cell === '')) {
                continue;
            }
            this.#out.line(`| ${cells.join(' | ')} |`);
            if (!header) {
                this.#out.line(`|${' --- |'.repeat(cells.length)}`);
                header = true;
            }
        }
        this.#out.block();
    }
}

function insideSvg(element: HtmlElement): boolean {
    for (let parent = element.parent; parent !== undefined; parent = parent.parent) {
        if (parent.name === 'svg') {
            return true;
        }
    }
    return false;
}

function render(root: HtmlElement, base: string, chrome: boolean): string {
    const renderer = new Renderer({ base, chrome });
    renderer.children(root);
    return renderer.result();
}

/**
 * Converts a page to markdown: headings, paragraphs and line breaks, links as `[text](absolute url)`, lists, code
 * blocks and code spans, quotes, tables as rows. Scripts, styles, forms, media and hidden elements are left out. When
 * the page has a `<main>` (or a single `<article>`) only that is converted, and navigation, sidebars and footers are
 * dropped; when that leaves little text and the whole page has much more, the whole page is converted.
 */
export function htmlToMarkdown(html: string, url: string): PageText {
    const document = parseHtml(html);
    // The document's title, not the title of an inline SVG icon.
    const titleElement = findFirst(document, (element) => element.name === 'title' && !insideSvg(element), true);
    const title = collapseSpace(titleElement?.children.filter((child) => typeof child === 'string').join('') ?? '');
    let base = url;
    const baseHref = findFirst(document, (element) => element.name === 'base' && Boolean(element.attrs.href), true)
        ?.attrs.href;
    if (baseHref !== undefined) {
        try {
            base = new URL(baseHref, url).href;
        } catch {
            // An invalid base: links resolve against the page.
        }
    }
    const body = findFirst(document, (element) => element.name === 'body') ?? document;
    const main = findFirst(body, (element) => element.name === 'main' || element.attrs.role === 'main');
    const articles = main ? [] : findAll(body, (element) => element.name === 'article');
    const focus = main ?? (articles.length === 1 ? articles[0] : undefined);
    let markdown = render(focus ?? body, base, false);
    if (markdown.length < SHORT_TEXT) {
        // Little text where the content should be, as on pages a script fills in: what else does the page say?
        const whole = render(body, base, true);
        if (whole.length > markdown.length * 2) {
            markdown = whole;
        }
    }
    return { title: title.trim(), markdown };
}

/** The character encoding a page declares in its first bytes (`<meta charset>`, `http-equiv`, an XML declaration). */
export function declaredCharset(head: Uint8Array): string | undefined {
    const text = Buffer.from(head.subarray(0, 4096)).toString('latin1');
    const meta = /<meta\b[^>]*?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(text);
    if (meta?.[1]) {
        return meta[1].toLowerCase();
    }
    return /^\s*<\?xml\b[^>]*\bencoding\s*=\s*["']([\w.:-]+)/i.exec(text)?.[1]?.toLowerCase();
}
