// -----------------------------------------------------------------------------
// Comment-preserving edits to conf/<chain>.json5.
//
// The chain configs are hand-annotated: comments explain why a factory is
// configured the way it is, which fee was verified how, what to fill in later.
// Parsing with JSON5 and re-serialising would throw all of that away, so this
// module edits the TEXT: it finds the right object by scanning the JSON5
// structure (strings and comments skipped, braces balanced) and splices new
// members in before its closing brace, matching the surrounding indentation.
//
// Every edit is checked before anything is written: the new text must parse,
// every factory that was configured before must still be there unchanged, and
// every factory added must now be there. Anything else throws and the file on
// disk is untouched.
//
// Factory groups may be flat (`v2: { Name: {…} }`) or legacy
// (`v2: { abi: […], list: { Name: {…} } }`); entries go into `list` when the
// group already uses one, so a file stays in one style.
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import JSON5 from 'json5';
import { factoryGroupEntries, type FactoryEntry, type FactoryGroup } from './config.ts';

export type FactoryAddition = {
    group: 'v2' | 'v2fee' | 'solidly' | 'v3' | 'algebra';
    /** Config key. Made unique within the group if taken (suffix _2, _3, …). */
    key: string;
    entry: FactoryEntry;
    /** One line, rendered as a // comment above the entry. */
    comment?: string;
    /** More comment lines, below `comment` (e.g. ones carried over from a moved entry). */
    moreComments?: string[];
};

// ---- a minimal JSON5 structure scanner --------------------------------------

type Member = { key: string; keyStart: number; valueStart: number; valueEnd: number };

/** Index of the first char at or after i that is not whitespace or a comment. */
function skipTrivia(t: string, i: number): number {
    for (;;) {
        while (i < t.length && /\s/.test(t[i])) i++;
        if (t.startsWith('//', i)) { while (i < t.length && t[i] !== '\n') i++; continue; }
        if (t.startsWith('/*', i)) { const e = t.indexOf('*/', i + 2); if (e < 0) throw new Error('unterminated /* comment'); i = e + 2; continue; }
        return i;
    }
}

/** End (exclusive) of the string literal starting at i. */
function skipString(t: string, i: number): number {
    const q = t[i];
    for (let j = i + 1; j < t.length; j++) {
        if (t[j] === '\\') { j++; continue; }
        if (t[j] === q) return j + 1;
    }
    throw new Error('unterminated string');
}

/**
 * End (exclusive) of the value starting at i — the end of its last real token,
 * never of a trailing comment, so a comma inserted there cannot land inside
 * `fee: 0.003 // note`.
 */
function skipValue(t: string, i: number): number {
    let depth = 0;
    let lastEnd = i;
    for (let j = i; j < t.length; ) {
        const c = t[j];
        if (/\s/.test(c) || t.startsWith('//', j) || t.startsWith('/*', j)) { j = skipTrivia(t, j); continue; }
        if (c === '"' || c === "'") { j = skipString(t, j); lastEnd = j; continue; }
        if (c === '{' || c === '[') { depth++; j++; lastEnd = j; continue; }
        if (c === '}' || c === ']') {
            if (depth === 0) return lastEnd;
            depth--; j++; lastEnd = j;
            if (depth === 0) return j;
            continue;
        }
        if (c === ',' && depth === 0) return lastEnd;
        j++; lastEnd = j;
    }
    throw new Error('unterminated value');
}

/** Members of the object whose `{` is at `open`; also returns the index of its `}`. */
function members(t: string, open: number): { list: Member[]; close: number } {
    if (t[open] !== '{') throw new Error(`expected { at ${open}`);
    const list: Member[] = [];
    let i = open + 1;
    for (;;) {
        i = skipTrivia(t, i);
        if (t[i] === '}') return { list, close: i };
        if (t[i] === ',') { i++; continue; }
        const keyStart = i;
        let key: string;
        if (t[i] === '"' || t[i] === "'") { const e = skipString(t, i); key = JSON5.parse(t.slice(i, e)); i = e; }
        else { const m = /^[A-Za-z_$][\w$]*/.exec(t.slice(i)); if (!m) throw new Error(`bad key at ${i}: ${t.slice(i, i + 20)}`); key = m[0]; i += key.length; }
        i = skipTrivia(t, i);
        if (t[i] !== ':') throw new Error(`expected : after key "${key}"`);
        const valueStart = skipTrivia(t, i + 1);
        const valueEnd = skipValue(t, valueStart);
        list.push({ key, keyStart, valueStart, valueEnd });
        i = valueEnd;
    }
}

function lineIndent(t: string, i: number): string {
    const ls = t.lastIndexOf('\n', i - 1) + 1;
    return /^[ \t]*/.exec(t.slice(ls))![0];
}

/**
 * Insert `body` (already-indented member text, no trailing comma) as the last
 * member of the object whose `{` is at `open`.
 */
function appendMember(t: string, open: number, render: (indent: string) => string): string {
    const { list, close } = members(t, open);
    const closeIndent = lineIndent(t, close);
    const indent = list.length ? lineIndent(t, list[0].keyStart) : closeIndent + '  ';
    const body = render(indent);
    if (list.length === 0) {
        // `{` … `}` possibly with comments in between: keep them, add after.
        const inner = t.slice(open + 1, close).replace(/\s+$/, '');
        return t.slice(0, open + 1) + inner + '\n' + body + ',\n' + closeIndent + t.slice(close);
    }
    // After the last value: ensure a comma, keep any comment trailing it.
    const last = list[list.length - 1];
    let after = t.slice(last.valueEnd, close);           // e.g. ",   // note\n  " or "\n  "
    if (!/^\s*,/.test(after)) after = ',' + after;
    after = after.replace(/\s+$/, '');
    return t.slice(0, last.valueEnd) + after + '\n' + body + ',\n' + closeIndent + t.slice(close);
}

// ---- rendering --------------------------------------------------------------

function renderValue(v: unknown): string {
    if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        return '{ ' + Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${k}: ${renderValue(x)}`).join(', ') + ' }';
    }
    return JSON.stringify(v);
}

function renderEntry(indent: string, a: FactoryAddition): string {
    const inner = indent + '  ';
    const fields = Object.entries(a.entry).filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${inner}${k}: ${renderValue(v)},`);
    const key = /^[A-Za-z_$][\w$]*$/.test(a.key) ? a.key : renderValue(a.key);
    const notes = [...(a.comment ? [a.comment] : []), ...(a.moreComments ?? [])];
    return notes.map(c => `${indent}// ${c.replace(/\n/g, ' ')}\n`).join('') +
        `${indent}${key}: {\n${fields.join('\n')}\n${indent}}`;
}

// ---- the edit ---------------------------------------------------------------

function snapshot(raw: any): Map<string, string> {
    const out = new Map<string, string>();
    for (const [group, g] of Object.entries(raw?.factories ?? {})) {
        if (!g || typeof g !== 'object') continue;
        for (const [name, entry] of factoryGroupEntries(g as FactoryGroup, `factories.${group}`)) {
            out.set(`${group}\u0000${name}`, JSON.stringify(entry));
        }
    }
    return out;
}

/**
 * Return `text` with `additions` spliced in. Pure — no I/O — so it can be
 * tested on every conf in the repo. Throws if the result would not parse or
 * would lose or alter any existing factory.
 */
type Loc = { group: Member; legacy?: Member; target: number };

/** factories.<group> (created if missing) and where new entries go in it. */
function locateGroup(t: string, group: FactoryAddition['group'], create: true): { t: string; loc: Loc };
function locateGroup(t: string, group: FactoryAddition['group'], create: false): { t: string; loc: Loc | null };
function locateGroup(t: string, group: FactoryAddition['group'], create: boolean): { t: string; loc: Loc | null } {
    const root = skipTrivia(t, 0);
    if (t[root] !== '{') throw new Error('config does not start with an object');
    let fac = members(t, root).list.find(m => m.key === 'factories');
    if (!fac) {
        if (!create) return { t, loc: null };
        t = appendMember(t, root, (ind) => `${ind}factories: {\n${ind}}`);
        fac = members(t, root).list.find(m => m.key === 'factories')!;
    }
    if (t[fac.valueStart] !== '{') throw new Error('factories is not an object');
    let grp = members(t, fac.valueStart).list.find(m => m.key === group);
    if (!grp) {
        if (!create) return { t, loc: null };
        t = appendMember(t, fac.valueStart, (ind) => `${ind}${group}: {\n${ind}}`);
        grp = members(t, fac.valueStart).list.find(m => m.key === group)!;
    }
    if (t[grp.valueStart] !== '{') throw new Error(`factories.${group} is not an object`);
    // Legacy groups keep their list: wrapper.
    const legacy = members(t, grp.valueStart).list.find(m => m.key === 'list');
    const useList = !!legacy && t[legacy.valueStart] === '{';
    return { t, loc: { group: grp, legacy: useList ? legacy : undefined, target: useList ? legacy!.valueStart : grp.valueStart } };
}

/** Append one factory to its group; returns the new text and the key used (made unique). */
function insertFactory(t: string, a: FactoryAddition): { t: string; key: string } {
    const r = locateGroup(t, a.group, true);
    t = r.t;
    const { group, legacy, target } = r.loc;
    const taken = new Set([
        ...members(t, group.valueStart).list.map(m => m.key),
        ...(legacy ? members(t, legacy.valueStart).list.map(m => m.key) : []),
    ]);
    let key = a.key;
    for (let n = 2; taken.has(key); n++) key = `${a.key}_${n}`;
    return { t: appendMember(t, target, (ind) => renderEntry(ind, { ...a, key })), key };
}

/**
 * The member holding factories.<group>.<key>: the flat one if present (it is
 * the one config.ts uses when both spellings exist), else the one in list:.
 */
function findFactoryMember(t: string, group: FactoryAddition['group'], key: string): Member | null {
    const { loc } = locateGroup(t, group, false);
    if (!loc) return null;
    const flat = members(t, loc.group.valueStart).list.find(m => m.key === key && m.key !== 'list' && m.key !== 'abi');
    if (flat) return flat;
    return loc.legacy ? members(t, loc.legacy.valueStart).list.find(m => m.key === key) ?? null : null;
}

/** Text of every comment between a and b (strings skipped), without the markers. */
function commentsIn(t: string, a: number, b: number): string[] {
    const out: string[] = [];
    for (let i = a; i < b; ) {
        const c = t[i];
        if (c === '"' || c === "'") { i = skipString(t, i); continue; }
        if (t.startsWith('//', i)) { let e = t.indexOf('\n', i); if (e < 0 || e > b) e = b; out.push(t.slice(i + 2, e).trim()); i = e; continue; }
        if (t.startsWith('/*', i)) { const e = t.indexOf('*/', i + 2); out.push(t.slice(i + 2, e).replace(/\s+/g, ' ').trim()); i = e + 2; continue; }
        i++;
    }
    return out.filter(Boolean);
}

/** Insert a `// comment` line above the line that holds index i, at that line's indentation. */
function commentAbove(t: string, i: number, comment: string): string {
    const ls = t.lastIndexOf('\n', i - 1) + 1;
    const ind = lineIndent(t, i);
    return t.slice(0, ls) + `${ind}// ${comment.replace(/\n/g, ' ')}\n` + t.slice(ls);
}

const renderNumber = (n: number) => String(Number(n.toPrecision(12)));

export type FactoryEdit =
    /** Set (or add) `fee` on an entry; a bare-address entry becomes `{ address, fee }`. */
    | { kind: 'setFee'; group: FactoryAddition['group']; key: string; address: string; fee: number; comment?: string }
    /** Set (or add) several fields at once; the comment goes above the entry. */
    | { kind: 'setFields'; group: FactoryAddition['group']; key: string; address: string; fields: Record<string, string | number | boolean>; comment?: string }
    /** Take the entry out of `group` and add `entry` to `to` (key kept unless taken). A one-line note stays where it was. */
    | { kind: 'move'; group: FactoryAddition['group']; key: string; address: string; to: FactoryAddition['group']; entry: FactoryEntry; comment?: string; note?: string }
    /** Take the entry out of `group` altogether. A one-line note stays where it was; comments above it stay too. */
    | { kind: 'remove'; group: FactoryAddition['group']; key: string; address: string; note?: string };

const sortedJson = (v: unknown): string => JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);

/**
 * Return `text` with `edits` applied — pure, like addFactoriesToText, and
 * checked the same way: the result must parse, the edited factories must read
 * back exactly as intended, and every other factory must be unchanged.
 */
export function editFactoriesInText(text: string, edits: FactoryEdit[]): { text: string; moved: Array<{ from: string; to: string; key: string }> } {
    const beforeSnap = snapshot(JSON5.parse(text));
    const expected = new Map(beforeSnap);
    let t = text;
    const moved: Array<{ from: string; to: string; key: string }> = [];

    for (const e of edits) {
        const id = `${e.group}\u0000${e.key}`;
        const prior = beforeSnap.get(id);
        if (!prior) throw new Error(`factories.${e.group}.${e.key} is not in the config — nothing written`);
        const priorEntry = JSON.parse(prior) as string | FactoryEntry;
        const priorAddr = typeof priorEntry === 'string' ? priorEntry : priorEntry.address;
        if (priorAddr.toLowerCase() !== e.address.toLowerCase()) {
            throw new Error(`factories.${e.group}.${e.key} is ${priorAddr}, not ${e.address} — nothing written`);
        }
        const m = findFactoryMember(t, e.group, e.key);
        if (!m) throw new Error(`could not locate factories.${e.group}.${e.key} in the text — nothing written`);

        if (e.kind === 'setFee' || e.kind === 'setFields') {
            const fields: Record<string, string | number | boolean> = e.kind === 'setFee' ? { fee: Number(renderNumber(e.fee)) } : e.fields;
            const render = (v: string | number | boolean) => typeof v === 'number' ? renderNumber(v) : renderValue(v);
            let commented = !e.comment;
            for (const [name, value] of Object.entries(fields)) {
                const cur = findFactoryMember(t, e.group, e.key)!;
                if (t[cur.valueStart] !== '{') {
                    // bare address string → { address: '0x…', <name>: <value> }
                    t = t.slice(0, cur.valueStart) + `{ address: ${t.slice(cur.valueStart, cur.valueEnd)}, ${name}: ${render(value)} }` + t.slice(cur.valueEnd);
                    continue;
                }
                const inner = members(t, cur.valueStart);
                const f = inner.list.find(x => x.key === name);
                if (f) {
                    t = t.slice(0, f.valueStart) + render(value) + t.slice(f.valueEnd);
                    // A lone fee change is noted right above the fee line, as before.
                    if (!commented && e.kind === 'setFee') { t = commentAbove(t, f.keyStart, e.comment!); commented = true; }
                } else if (!t.slice(cur.valueStart, inner.close).includes('\n')) {
                    // one-line entry: `{ address: '0x…' }` → `{ address: '0x…', fee: X }`
                    const last = inner.list[inner.list.length - 1];
                    const rest = t.slice(last.valueEnd, inner.close).replace(/^\s*,/, '');
                    t = t.slice(0, last.valueEnd) + `, ${name}: ${render(value)}` + rest + t.slice(inner.close);
                } else {
                    t = appendMember(t, cur.valueStart, (ind) => `${ind}${name}: ${render(value)}`);
                }
            }
            if (!commented) t = commentAbove(t, findFactoryMember(t, e.group, e.key)!.keyStart, e.comment!);
            const obj = typeof priorEntry === 'string' ? { address: priorEntry } : priorEntry;
            expected.set(id, JSON.stringify({ ...obj, ...fields }));
        } else {
            // Remove the member: from the start of its line (or the key) through its
            // value, the comma after it, and the rest of that line when only a
            // comment follows. Comments ABOVE it stay; the note takes its place.
            const ls = t.lastIndexOf('\n', m.keyStart - 1) + 1;
            const from = /^[ \t]*$/.test(t.slice(ls, m.keyStart)) ? ls : m.keyStart;
            let to = m.valueEnd;
            const tail = /^[ \t]*,?[ \t]*(\/\/[^\n]*)?\n?/.exec(t.slice(to))!;
            to += tail[0].length;
            if (!tail[0].includes(',') && !tail[0].endsWith('\n')) {
                // something else follows on the same line — keep it, drop only the comma if any
                to = m.valueEnd;
            }
            const carried = commentsIn(t, m.keyStart, to);
            const ind = lineIndent(t, m.keyStart);
            const note = e.note ? `${from === ls ? ind : ''}// ${e.note.replace(/\n/g, ' ')}\n` : '';
            t = t.slice(0, from) + note + t.slice(to);
            expected.delete(id);
            if (e.kind === 'remove') continue;
            const ins = insertFactory(t, { group: e.to, key: e.key, entry: e.entry, comment: e.comment, moreComments: carried });
            t = ins.t;
            expected.set(`${e.to}\u0000${ins.key}`, JSON.stringify(e.entry, (_k, x) => x === undefined ? undefined : x));
            moved.push({ from: e.group, to: e.to, key: ins.key });
        }
    }

    let after: any;
    try { after = JSON5.parse(t); }
    catch (err) { throw new Error(`edited config no longer parses (${(err as Error).message}) — nothing written`); }
    const afterSnap = snapshot(after);
    for (const [k, v] of expected) {
        const got = afterSnap.get(k);
        if (!got || sortedJson(JSON.parse(got)) !== sortedJson(JSON.parse(v))) {
            throw new Error(`factory ${k.replace('\u0000', '.')} does not read back as intended — nothing written\n  want ${v}\n  got  ${got}`);
        }
    }
    if (afterSnap.size !== expected.size) {
        throw new Error(`expected ${expected.size} factories after the edit, found ${afterSnap.size} — nothing written`);
    }
    return { text: t, moved };
}

/**
 * Every configured factory whose address is in `notes`, as `remove` edits
 * (the map's value is the note left in its place). Reads the raw text, so it
 * sees entries the blacklist filters out of loadChainConfig.
 */
export function removalsFor(text: string, notes: Map<string, string>): Array<Extract<FactoryEdit, { kind: 'remove' }>> {
    const out: Array<Extract<FactoryEdit, { kind: 'remove' }>> = [];
    for (const [id, json] of snapshot(JSON5.parse(text))) {
        const entry = JSON.parse(json) as string | FactoryEntry;
        const address = (typeof entry === 'string' ? entry : entry.address).toLowerCase();
        const note = notes.get(address);
        if (note === undefined) continue;
        const [group, key] = id.split('\u0000');
        out.push({ kind: 'remove', group: group as FactoryAddition['group'], key, address, note: note || undefined });
    }
    return out;
}

/** Apply edits to conf/<label>.json5 on disk (atomic rename). */
export function editFactoriesInConf(confDir: string, label: string, edits: FactoryEdit[]) {
    if (edits.length === 0) return { moved: [] };
    const p = path.join(confDir, `${label}.json5`);
    const { text, moved } = editFactoriesInText(fs.readFileSync(p, 'utf8'), edits);
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, p);
    return { moved };
}

/**
 * Return `text` with `additions` spliced in. Pure — no I/O — so it can be
 * tested on every conf in the repo. Throws if the result would not parse or
 * would lose or alter any existing factory.
 */
export function addFactoriesToText(text: string, additions: FactoryAddition[]): { text: string; added: Array<{ group: string; key: string }> } {
    const before = JSON5.parse(text);
    const beforeSnap = snapshot(before);
    let t = text;
    const added: Array<{ group: string; key: string }> = [];

    for (const a of additions) {
        const r = insertFactory(t, a);
        t = r.t;
        added.push({ group: a.group, key: r.key });
    }

    // Verify: parses, nothing lost or changed, everything added is present.
    let after: any;
    try { after = JSON5.parse(t); }
    catch (e) { throw new Error(`edited config no longer parses (${(e as Error).message}) — nothing written`); }
    const afterSnap = snapshot(after);
    for (const [k, v] of beforeSnap) {
        if (afterSnap.get(k) !== v) throw new Error(`edit would change existing factory ${k.replace('\u0000', '.')} — nothing written`);
    }
    for (let i = 0; i < added.length; i++) {
        const k = `${added[i].group}\u0000${added[i].key}`;
        const got = afterSnap.get(k);
        if (!got || JSON.parse(got).address?.toLowerCase() !== additions[i].entry.address.toLowerCase()) {
            throw new Error(`added factory ${added[i].group}.${added[i].key} is not readable back — nothing written`);
        }
    }
    if (afterSnap.size !== beforeSnap.size + added.length) {
        throw new Error(`expected ${beforeSnap.size + added.length} factories after the edit, found ${afterSnap.size} — nothing written`);
    }
    return { text: t, added };
}

/** Apply additions to conf/<label>.json5 on disk (atomic rename). */
export function addFactoriesToConf(confDir: string, label: string, additions: FactoryAddition[]): Array<{ group: string; key: string }> {
    if (additions.length === 0) return [];
    const p = path.join(confDir, `${label}.json5`);
    const { text, added } = addFactoriesToText(fs.readFileSync(p, 'utf8'), additions);
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, p);
    return added;
}

// ---- conf/<chain>-blacklist.json5 --------------------------------------------

/**
 * Return a blacklist file's text with `items` appended to its `factories`
 * array — comments, quoting style and existing entries untouched. Checked:
 * the result parses, the old entries are unchanged and in order, and exactly
 * the new ones follow them.
 */
export function appendToBlacklistText(text: string, items: Array<{ address: string; reason?: string; addedAt?: string }>): string {
    if (items.length === 0) return text;
    const before = JSON5.parse(text);
    let t = text;
    const root = skipTrivia(t, 0);
    if (t[root] !== '{') throw new Error('blacklist does not start with an object');
    let fac = members(t, root).list.find(m => m.key === 'factories');
    if (!fac) {
        t = appendMember(t, root, (ind) => `${ind}factories: [\n${ind}]`);
        fac = members(t, root).list.find(m => m.key === 'factories')!;
    }
    const open = fac.valueStart;
    if (t[open] !== '[') throw new Error('blacklist factories is not an array');
    // Elements of the array and its closing bracket.
    const elems: Array<{ start: number; end: number }> = [];
    let i = open + 1, close = -1;
    for (;;) {
        i = skipTrivia(t, i);
        if (t[i] === ']') { close = i; break; }
        if (t[i] === ',') { i++; continue; }
        const end = skipValue(t, i);
        elems.push({ start: i, end });
        i = end;
    }
    const closeIndent = lineIndent(t, close);
    const indent = elems.length ? lineIndent(t, elems[0].start) : closeIndent + '    ';
    const field = indent + '    ';
    const body = items.map(e => [
        `${indent}{`,
        `${field}address: ${JSON.stringify(e.address)},`,
        ...(e.reason ? [`${field}reason:  ${JSON.stringify(e.reason)},`] : []),
        ...(e.addedAt ? [`${field}addedAt: ${JSON.stringify(e.addedAt)},`] : []),
        `${indent}}`,
    ].join('\n')).join(',\n');
    if (elems.length === 0) {
        const inner = t.slice(open + 1, close).replace(/\s+$/, '');
        t = t.slice(0, open + 1) + inner + '\n' + body + ',\n' + closeIndent + t.slice(close);
    } else {
        const last = elems[elems.length - 1];
        let after = t.slice(last.end, close);
        if (!/^\s*,/.test(after)) after = ',' + after;
        after = after.replace(/\s+$/, '');
        t = t.slice(0, last.end) + after + '\n' + body + ',\n' + closeIndent + t.slice(close);
    }

    let parsed: any;
    try { parsed = JSON5.parse(t); }
    catch (err) { throw new Error(`edited blacklist no longer parses (${(err as Error).message}) — nothing written`); }
    const old = (before.factories ?? []) as unknown[];
    const now = (parsed.factories ?? []) as Array<{ address: string }>;
    if (now.length !== old.length + items.length) throw new Error(`expected ${old.length + items.length} blacklist entries, found ${now.length} — nothing written`);
    for (let k = 0; k < old.length; k++) {
        if (JSON.stringify(now[k]) !== JSON.stringify(old[k])) throw new Error(`blacklist entry ${k} would change — nothing written`);
    }
    for (let k = 0; k < items.length; k++) {
        if (now[old.length + k]?.address !== items[k].address) throw new Error(`new blacklist entry ${items[k].address} does not read back — nothing written`);
    }
    return t;
}
