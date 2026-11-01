// -----------------------------------------------------------------------------
// Duplicate keys in a JSON5 document. JSON5.parse keeps the LAST of two equal
// keys in an object and says nothing.
//
// Polygon, 2026-10-31: conf/polygon.json5 had `JetswapV2` twice in factories.v2
// — 0x668ad0ed (457 pairs, fee 0.001) and, 107 lines later, 0xd54187ea. The
// loader only ever saw the second, so Jetswap's 457 pairs were never scored,
// and `yarn cleanup --yes` would have deleted them as orphans.
// -----------------------------------------------------------------------------

type Tok = { t: '{' | '}' | '[' | ']' | ':' | ',' | 'key' | 'val'; v?: string; line: number };

function tokenize(src: string): Tok[] {
    const out: Tok[] = [];
    let i = 0, line = 1;
    while (i < src.length) {
        const c = src[i];
        if (c === '\n') { line++; i++; continue; }
        if (/\s/.test(c)) { i++; continue; }
        if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            const stop = end < 0 ? src.length : end + 2;
            for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
            i = stop; continue;
        }
        if ('{}[]:,'.includes(c)) { out.push({ t: c as Tok['t'], line }); i++; continue; }
        if (c === '"' || c === "'") {
            const start = line;
            let s = '';
            i++;
            while (i < src.length && src[i] !== c) {
                if (src[i] === '\\') { s += src[i + 1]; i += 2; continue; }
                if (src[i] === '\n') line++;
                s += src[i++];
            }
            i++;
            out.push({ t: 'key', v: s, line: start });
            continue;
        }
        let s = '';
        while (i < src.length && !/[\s{}[\]:,/'"]/.test(src[i])) s += src[i++];
        if (!s) { i++; continue; }
        out.push({ t: 'key', v: s, line });
    }
    return out;
}

/** Every key that appears twice in the same object: its path, and the lines of both. */
export function findDuplicateKeys(src: string): Array<{ path: string; key: string; lines: [number, number] }> {
    const toks = tokenize(src);
    const dupes: Array<{ path: string; key: string; lines: [number, number] }> = [];
    // One frame per open object/array: the keys seen so far (objects) and the path to it.
    const stack: Array<{ obj: boolean; keys: Map<string, number>; path: string; idx: number }> = [];
    let pendingKey: string | null = null;
    for (let i = 0; i < toks.length; i++) {
        const k = toks[i];
        const top = stack[stack.length - 1];
        if (k.t === '{' || k.t === '[') {
            const name = top ? (top.obj ? pendingKey ?? '?' : String(top.idx)) : '';
            stack.push({ obj: k.t === '{', keys: new Map(), path: top ? (top.path ? `${top.path}.${name}` : name) : '', idx: 0 });
            pendingKey = null;
        } else if (k.t === '}' || k.t === ']') {
            stack.pop();
        } else if (k.t === ',') {
            if (top && !top.obj) top.idx++;
            pendingKey = null;
        } else if (k.t === 'key' && top?.obj && toks[i + 1]?.t === ':' && pendingKey === null) {
            const prev = top.keys.get(k.v!);
            if (prev !== undefined) dupes.push({ path: top.path, key: k.v!, lines: [prev, k.line] });
            else top.keys.set(k.v!, k.line);
            pendingKey = k.v!;
            i++; // the ':'
        }
    }
    return dupes;
}
