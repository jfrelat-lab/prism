// emit.js — the JavaScript emitter ("tier-0" in these comments, for history).
//
// Compact, generic, LITERAL, no optimisation. Memory goes through a DataView so unaligned access is
// correct without proof, and every integer op is written in its canonical 32-bit form. Optimisation,
// when it comes, is a static pass over an IR of the whole program (roadmap P13.2) whose output must
// produce the same state as this one -- which is why this one stays literal.
//
// Value representation, chosen once and relied on everywhere:
//   * every integer type ≤ 32 bits is a JS int32 holding the two's-complement BIT PATTERN.
//     Signedness is applied at the operations where it is observable — /, %, >>, and comparisons —
//     not carried around as a tag. `unsigned` is therefore free on +, -, *, &, |, ^ and <<.
//   * a pointer is that same int32: an offset into the module's one ArrayBuffer.
//   * `float` is a JS number kept exact with Math.fround at every store and every operation;
//     `double` is a JS number unchanged.
//
// The one local-variable decision that matters for speed is made even in tier-0: a scalar whose
// address is never taken lives in a JS `var` and never touches memory. Everything else — arrays,
// structs, unions, anything with `&` applied to it — gets a shadow-stack slot.

import * as T from '../sema/types.js';
import { findField, constEval } from '../parse/parser.js';
import { FUNC_TAG } from '../link/module.js';
import { isWideLiteral, literalBytes, literalUnits } from '../util/charset.js';
import { needsFlattening, flattenGotos } from './flatten.js';
import { lowerBorlandAsm, emitInstruction, REGISTER_DECLS, BorlandAsmError, PSEUDO, PSEUDO_REFUSED,
  firstUndefinedRead, interruptJs } from '../asm/borland.js';

/*
 * The frame epilogue, emitted as a MARKER and resolved once the function's final frame size is known.
 *
 * It used to be written inline with `this.frameSize` as it stood at that moment — but slots are
 * allocated as emission proceeds, so an early `return` followed by any later allocation restored the
 * stack pointer to the wrong place. W_GetLumpinfo returned inside its loop with the frame at 16
 * bytes and then grew to 20 for a varargs buffer, leaking 4 bytes per call.
 *
 * Silent, cumulative, and fatal at a distance: Quake's own R_RenderView checks that the stack has not
 * drifted more than 10000 bytes, and died after 1238 frames of leaking 8 bytes each. A program
 * without that check would simply have run out of stack.
 */
const FRAME_RESTORE = '\u0000FRAME_RESTORE\u0000';

/*
 * C identifiers that JavaScript reserves. A C program is entitled to a variable called `in`, `new` or
 * `class`, and Quake has one: the emitted module died with "Unexpected token 'in'".
 *
 * Locals are already safe because they go out as `_v_name`, but PARAMETERS and function names keep
 * their own names, which is worth preserving — readable emitted code is this project's primary
 * debugging lever. So only the collisions are renamed, with a `$`: legal in a JS identifier, and not
 * something a C identifier produces.
 *
 * C's own keywords are absent from the list: a C program cannot use `if`, `for`, `void`, `const`,
 * `switch`, `enum` or `static` as a name in the first place. What is left is the JavaScript-only half.
 */
const JS_RESERVED = new Set([
  'in', 'new', 'class', 'delete', 'this', 'null', 'true', 'false', 'typeof', 'instanceof',
  'var', 'let', 'with', 'throw', 'try', 'catch', 'finally', 'super', 'import', 'export',
  'function', 'yield', 'await', 'async', 'debugger', 'arguments', 'eval',
  'package', 'private', 'protected', 'public', 'interface', 'implements',
  'undefined', 'NaN', 'Infinity',
]);

export const jsIdent = (n) => (JS_RESERVED.has(n) ? n + '$' : n);

/*
 * A PARAMETER's JavaScript name, prefixed.
 *
 * Locals already are (`_v_status`); parameters were not, and a parameter named M, F or D shadowed
 * the three the emitted module runs on -- the memory, the function table and the DataView. Lua's
 * ldump.c writes `static void dumpBlock (DumpState *D, ...)`, so every memory access inside it
 * became a method call on a guest pointer: "D.getInt32 is not a function", from a function whose C
 * mentions nothing of the sort.
 *
 * Prefixing is the whole fix, and it is the same one locals already had. Renaming the module's own
 * three to something C cannot spell would work too, but it would touch every emitted access instead
 * of one declaration.
 */
export const paramIdent = (n) => `_p_${jsIdent(n)}`;

/*
 * An index into a pointer, narrowed to the pointer's width.
 *
 * `p + n` is legal C when n is a `long long`, and the index has to come down to 32 bits before it can
 * be scaled. Tier-0 keeps a 64-bit integer as a BigInt, so the usual `x|0` threw "Cannot mix BigInt
 * and other types" — loudly, which is the point of the BigInt choice, and it surfaced only when
 * SQLite indexed a buffer with an i64 length.
 */
function indexJs(ty, v) {
  return is64(ty.decay(v.type ?? ty.INT)) ? `Number(BigInt.asIntN(32,${v.js}))` : `${v.js}|0`;
}


/** Enough of an expression to find it in the source. A node kind alone is not a search term. */
function describeExpr(e) {
  if (!e || typeof e !== 'object') return String(e);
  switch (e.n) {
    case 'ident': return `identifier '${e.name}'`;
    case 'call': return `a call to '${e.fn?.name ?? '?'}'`;
    case 'bin': return `${describeExpr(e.a)} ${e.op} ${describeExpr(e.b)}`;
    case 'unary': return `${e.op}${describeExpr(e.expr)}`;
    case 'cast': return `a cast of ${describeExpr(e.expr)}`;
    case 'member': return `${describeExpr(e.obj ?? e.base)}.${e.name ?? e.field}`;
    case 'index': return `${describeExpr(e.base)}[${describeExpr(e.index)}]`;
    case 'num': return String(e.value);
    case 'cond': return 'a ?: expression';
    default: return `'${e.n}'`;
  }
}

/** Whether evaluating an expression can change state or observe a change: a call, an assignment, ++/--. */
function sideEffects(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.n === 'call' || node.n === 'assign' || node.n === 'preinc' || node.n === 'postinc') return true;
  for (const k of Object.keys(node)) {
    if (k === 'type') continue;
    const v = node[k];
    if (Array.isArray(v) ? v.some(sideEffects) : (v && typeof v === 'object' && v.n && sideEffects(v))) return true;
  }
  return false;
}

export class EmitError extends Error {}

const unsup = (what) => { throw new EmitError(`tier-0 does not support ${what} yet`); };

// ---------------------------------------------------------------- load / store

/** The DataView accessor for a scalar type, and whether the loaded value needs no fixup. */
/*
 * Which DataView call reaches a value of this type, chosen by its WIDTH.
 *
 * It used to switch on the type's NAME, which fixed i386 into the one place every load and store
 * passes through: a pointer was getInt32, and so were `int`, `long` and an enum. Under a model
 * where an int is 2 bytes and an enum is 1, that reads and writes the wrong number of bytes -- the
 * deepest place the ABI was baked in, and the reason the backend looked like more work than it is.
 *
 * TWO CHOICES HERE ARE CONVENTIONS RATHER THAN CONSEQUENCES, and both are kept exactly as they were:
 *
 *   A 4-byte integer is getInt32 whether or not it is signed, because JavaScript's bitwise operators
 *   produce signed 32-bit values and the rest of the emitter is written to that. Narrower integers
 *   follow their own signedness, which is why `unsigned short` is getUint16.
 *
 *   `char` reads through its own signedness but always writes with setInt8. Writing is the same byte
 *   either way; the asymmetry is preserved because the emitted text is hashed by gates that compare
 *   whole programs, and a cosmetic difference there is noise nobody wants to re-verify.
 *
 * A 2-byte pointer is getUint16, not getInt16: an address is unsigned, and an offset at or above
 * 0x8000 read as a negative number would be a wrong answer rather than a narrower one.
 */
function accessor(t) {
  if (t.k === 'ptr' || t.k === 'func' || t.k === 'enum') {
    const size = t.k === 'func' ? 4 : t.size;
    const signed = t.k === 'enum' && t.signed;
    if (size === 4) return { get: 'getInt32', set: 'setInt32', endian: true };
    if (size === 2) return { get: signed ? 'getInt16' : 'getUint16', set: signed ? 'setInt16' : 'setUint16', endian: true };
    if (size === 1) return { get: signed ? 'getInt8' : 'getUint8', set: signed ? 'setInt8' : 'setUint8', endian: false };
    return null;
  }
  if (t.k !== 'scalar') return null;
  switch (t.name) {
    case 'float': return { get: 'getFloat32', set: 'setFloat32', endian: true };
    case 'double': return { get: 'getFloat64', set: 'setFloat64', endian: true };
    // An 8-byte long double (compile.longDouble 64, or Watcom's) IS a double; the 12-byte x87 one is not representable.
    case 'long double': return t.size === 8 ? { get: 'getFloat64', set: 'setFloat64', endian: true } : unsup('long double');
    // char's write side is setInt8 whatever its signedness; see above.
    case 'char': return { get: t.signed ? 'getInt8' : 'getUint8', set: 'setInt8', endian: false };
  }
  switch (t.size) {
    case 1: return { get: t.signed ? 'getInt8' : 'getUint8', set: t.signed ? 'setInt8' : 'setUint8', endian: false };
    case 2: return { get: t.signed ? 'getInt16' : 'getUint16', set: t.signed ? 'setInt16' : 'setUint16', endian: true };
    case 4: return { get: 'getInt32', set: 'setInt32', endian: true };
    case 8: return { get: t.signed ? 'getBigInt64' : 'getBigUint64', set: t.signed ? 'setBigInt64' : 'setBigUint64', endian: true };
  }
  return null;
}

/** Exported for tools/gate-accessor.mjs, which freezes the i386 answers and checks the dos16 ones. */
export { accessor as accessorFor };

/*
 * PAGED MEMORY, off by default and off for every target that does not ask.
 *
 * When a platform declares a memory map (src/env/memmap.js), every access goes through a one-line
 * translation instead of straight to the DataView: `D.setUint8(xw(a), v)` rather than
 * `D.setUint8(a, v)`. That is what lets a DOS program's 0xA0000 window mean something other than
 * plain memory -- a planar VGA's four planes, a VESA bank -- without the game being touched.
 *
 * A MODULE-LEVEL FLAG rather than a parameter, because loadExpr and storeExpr have 26 call sites
 * between them and threading an argument through all of them would be a large diff for a setting
 * that is constant for a whole compilation. compile.js sets it in a try/finally around emission.
 *
 * With it off, these emit exactly the string they emitted before -- which is checked rather than
 * asserted: the emitted JavaScript for MAME, Quake II and Jump 'n Bump hashes identically with the
 * feature present and unused.
 */
let PAGED = false;
export function setPaged(on) { PAGED = !!on; }

/*
 * A DEVICE WINDOW, for a real-mode program whose video memory is a device rather than memory: the
 * EGA's A000h window, where a read loads four latches and a write lands on up to four planes through
 * the bit mask and the logical function -- nothing an address translation (PAGED) can say. With the
 * window on, every integer load and store is a call to _r8u/_r16s/_w16... (defined in the module's
 * preamble, compile.js), which costs one comparison outside the window and hands the access to
 * M.win inside it. Floating point and 64-bit values stay direct: nothing reads video memory as those.
 * Off, the emitted text is exactly what it was.
 */
let WINDOW = false;
export function setWindow(on) { WINDOW = !!on; }
const WIN_GET = { getUint8: '_r8u', getInt8: '_r8s', getUint16: '_r16u', getInt16: '_r16s', getInt32: '_r32' };
const WIN_SET = { setUint8: '_w8', setInt8: '_w8', setUint16: '_w16', setInt16: '_w16', setInt32: '_w32' };

const loadExpr = (addr, t) => {
  const a = accessor(t);
  if (!a) unsup(`loading a ${T.typeName(t)}`);
  if (WINDOW && WIN_GET[a.get]) return `${WIN_GET[a.get]}(${addr})`;
  return `D.${a.get}(${PAGED ? `xr(${addr})` : addr}${a.endian ? ',1' : ''})`;
};
const storeExpr = (addr, t, val) => {
  const a = accessor(t);
  if (!a) unsup(`storing a ${T.typeName(t)}`);
  if (WINDOW && WIN_SET[a.set]) return `${WIN_SET[a.set]}(${addr},${val})`;
  return `D.${a.set}(${PAGED ? `xw(${addr})` : addr},${val}${a.endian ? ',1' : ''})`;
};

/** Types tier-0 cannot represent at all. Checked on every conversion, which is the one place every
 *  value must pass through — a check only on load/store misses a local kept in a JS var. */
const WIDE = new Set(['long double']);

/**
 * A 64-bit integer is a BigInt here. Lowering it to i32 pairs is the optimiser's job (roadmap P0.5c,
 * P13.2), or WASM's native i64 (P13.3); this is the compact/generic path: BigInt is correct by
 * construction (arbitrary precision plus an explicit 64-bit mask) where pairs need a twenty-function
 * helper library and a return-value convention. The cost is speed, measured before it is paid.
 *
 * The hazard is that JS throws on mixing BigInt with Number, so EVERY conversion in or out has to be
 * explicit — which is why `coerce` handles i64 before anything else.
 */
export const is64 = (t) => t && t.k === 'scalar' && (t.name === 'long long' || t.name === 'unsigned long long');
const mask64 = (js, t) => `BigInt.as${t.signed ? 'Int' : 'Uint'}N(64,${js})`;
const checkWide = (t) => { if (t && t.k === 'scalar' && WIDE.has(t.name) && t.size !== 8) unsup(t.name); };

/** Truncate/extend a 32-bit value to a narrower type, as an assignment or cast must. */
/** A `_seg` pointer with a real meaning: its value is a paragraph, and seg*16 is the address. */
const isSeg = (t) => t?.k === 'ptr' && t.model === 'seg' && t.real === true;
/** The byte address a pointer VALUE names: itself, or seg*16 for a _seg pointer. */
const addrOfPtr = (js, t) => (isSeg(t) ? `((${js})<<4)` : `(${js})`);

function coerce(ty, js, from, to) {
  checkWide(from); checkWide(to);

  // 64-bit conversions come first: nothing below may see a BigInt on one side and a Number on the
  // other, because JS throws rather than converting.
  if (is64(to)) {
    if (is64(from)) return mask64(js, to);
    if (T.isFloat(from)) return mask64(`BigInt(Math.trunc(${js}))`, to);
    return mask64(`BigInt(${T.isUnsigned(from) ? `(${js})>>>0` : `(${js})|0`})`, to);
  }
  if (is64(from)) {
    if (T.isFloat(to)) return to.name === 'float' ? `Math.fround(Number(${js}))` : `Number(${js})`;
    // Narrowing to 32 bits or less: truncate in BigInt, then leave the BigInt world exactly once.
    return coerce(ty, `Number(BigInt.asIntN(32,${js}))`, ty.INT, to);
  }
  if (T.isFloat(to)) {
    const v = T.isFloat(from) ? js : (T.isUnsigned(from) ? `(${js}>>>0)` : `(${js}|0)`);
    return to.name === 'float' ? `Math.fround(${v})` : `+(${v})`;
  }
  if (T.isFloat(from)) {
    // C truncates toward zero. `|0` does exactly that for the in-range case, which is all C defines.
    return T.isUnsigned(to) ? `((${js})>>>0)` : `((${js})|0)`;
  }
  /*
   * Between a _seg pointer and any other pointer, the number changes: a paragraph becomes an address
   * by *16, and an address becomes a paragraph by /16 (exact for the paragraph-aligned blocks a
   * memory manager hands out, which is where _seg values come from). To and from an INTEGER nothing
   * changes -- `(memptr)segstart` stores a paragraph number and `(unsigned)grsegs[i]` reads one.
   */
  const fromPtr = from.k === 'ptr' || from.k === 'array' || from.k === 'func';
  if (isSeg(to) && fromPtr && !isSeg(from)) return `((${js})>>>4)`;
  if (isSeg(from) && (to.k === 'ptr' || to.k === 'func') && !isSeg(to)) return `((${js})<<4)`;
  if (to.k === 'ptr' || to.k === 'func') return `(${js}|0)`;
  /*
   * A TWO-BYTE integer is truncated to two bytes whatever it is called. The cases below used to be
   * keyed on the type's NAME, which was the same thing while only `short` had two bytes; under a
   * 16-bit model `int`, `unsigned` and an enum have two as well, fell through to `|0`, and
   * `(int)0xBEEF` came out as 48879 (tools/gate-int16.mjs, against Watcom).
   */
  if (to.k === 'enum') {
    // An enum is as wide as its model makes it: 16-bit Watcom sizes it by its values, one byte for
    // `enum { red = 1 }`, and a conversion into it truncates to that.
    if (to.size === 1) return to.signed === false ? `((${js})&255)` : `((${js})<<24>>24)`;
    if (to.size === 2) return to.signed === false ? `((${js})&65535)` : `((${js})<<16>>16)`;
    return `(${js}|0)`;
  }
  if (to.k === 'void') return `(${js})`;
  switch (to.name) {
    case '_Bool': return `((${js})!==0?1:0)`;
    case 'char': return ty.CHAR.signed ? `((${js})<<24>>24)` : `((${js})&255)`;
    case 'signed char': return `((${js})<<24>>24)`;
    case 'unsigned char': return `((${js})&255)`;
    default:
      if (to.size === 2) return to.signed ? `((${js})<<16>>16)` : `((${js})&65535)`;
      return `((${js})|0)`;
  }
}

/**
 * An integer result, wrapped to its type's width. Only a two-byte type needs it: an i386 int wraps
 * by `|0` already and a smaller type never survives promotion, so i386 emits what it always did.
 *
 * Applied to every result that could otherwise leave its width: a truth test reads it unconverted
 * (`(u + 1) ?` with u = 65535 is false, and 65536 is not), and so does a WIDENING, whose conversion
 * assumes its source is already in range -- `(long)-us` with an unsigned short of 1 is 65535, and an
 * unfitted -1 widened to 0xFFFFFFFF (Borland, executed: gate-borland-int16). Only the
 * compound-assignment arithmetic needs nothing: it is always converted back to the lvalue's type.
 */
const fitInt = (ty, js, t) => (T.isInteger(t) && !is64(t) && t.size === 2 ? coerce(ty, js, t, t) : js);

// ---------------------------------------------------------------- the function emitter

export class FunctionEmitter {
  /** @param mod the Module @param decl the `func` AST node @param globals name -> {addr,type} */
  constructor(mod, decl, ctx) {
    this.mod = mod;
    this.decl = decl;
    this.ctx = ctx;                 // {globals: Map, funcs: Map, builtins: Set}
    /*
     * The ABI this function is emitted for. Only i386 reaches emission today -- compile.js refuses
     * anything else by name -- but the sizes and the integer promotions come from the table rather
     * than from constants baked in here, which is what makes the refusal the only thing left to
     * lift when the rest of P11.1 lands.
     */
    this.ty = T.makeTypes(ctx.model ?? 'i386', { signedChar: ctx.signedChar });
    /*
     * Which model each emitted function was actually emitted for. A set that holds anything but the
     * one the program was compiled for means some path built an emitter without the model -- which
     * is not hypothetical: compileProgram's ctx carried none, so under dos16l the parser typed for
     * 16 bits while this emitter quietly typed for i386. tools/gate-signedchar.mjs reads it.
     */
    (mod.emitModels ??= new Set()).add(`${this.ty.model}/${this.ty.CHAR.signed ? 'signed' : 'unsigned'}`);
    this.locals = new Map();        // name -> {kind:'var'|'slot', js?, off?, type}
    this.nameSeq = new Map();       // how many times a name has been declared in this function
    this.frameSize = 0;
    this.frameAlign = 4;        // the strictest alignment any slot in this frame asked for
    this.tmp = 0;
    this.out = [];
    this.loopDepth = 0;
    /*
     * A NESTED function is emitted as a top-level one taking the enclosing frame as a hidden first
     * parameter -- the "static link" a C compiler would put in a register. `parent` is the emitter
     * that owns that frame, and is consulted for any name this function does not declare itself.
     */
    this.parent = ctx.parentEmitter ?? null;
    this.nested = new Map();        // name -> { jsName, decl }
    this.extra = [];                // the nested functions' own emitted text
  }

  newTmp() { return `_t${this.tmp++}`; }

  /**
   * A local that must live in memory gets a frame slot, and the returned offset is its START.
   * Returning the post-bump frame size instead placed every aggregate one object too high — which
   * showed up as `*p` reading a[2] and as a DataView range error once the frame reached the top of
   * the buffer. Two symptoms, one off-by-its-own-size.
   */
  slot(size, align) {
    const off = Math.ceil(this.frameSize / align) * align;
    this.frameSize = off + size;
    /*
     * A slot's alignment is only as good as the FRAME's. Offsets inside the frame are aligned here,
     * but `_fp` is wherever the stack pointer happened to be -- so `__attribute__((aligned))`, which
     * means the target's maximum and is 16 on i386, was landing on a 4-byte boundary. gcc's
     * nest-align-1.c checks the address itself, and it was a wrong answer rather than a refusal.
     */
    if (align > this.frameAlign) this.frameAlign = align;
    return off;
  }

  emit() {
    let d = this.decl;

    /*
     * Borland inline assembly is lowered FIRST, into instructions and `if (flag) goto label`, so
     * that everything after this -- the escape analysis, flatten.js, the goto state machine -- sees
     * ordinary statements. Only in a model whose DGROUP sits at linear 0: there DS = SS = 0 and a near
     * address is its own linear address, which is what src/asm/borland.js is built on.
     */
    if (hasNode(d.body, 'asmborland')) {
      const model = this.ctx.model ?? 'i386';
      if (model !== 'dos16' && model !== 'dos16m') {
        unsup('Borland inline assembly outside a model with DGROUP at linear 0 (dos16, dos16m)');
      }
      let low;
      try { low = lowerBorlandAsm(d.body, { INT: this.ty.INT }); } catch (e) {
        if (e instanceof BorlandAsmError) unsup(`Borland inline assembly: ${e.message}`);
        throw e;
      }
      d = { ...d, body: low.body };
      this.decl = d;
      this.asm = low;
    }

    /*
     * THE REGISTER FILE -- one per invocation, shared by the asm, Borland's pseudo-registers (_AX,
     * _AL, _ES...) and geninterrupt -- exists in a real-mode model only, and only in a function that
     * touches it. Whoever touches it is held to one rule first: a register is read only after this
     * function wrote it, and not across a C call (src/asm/borland.js firstUndefinedRead).
     */
    const realMode = ['dos16', 'dos16m', 'dos16l'].includes(this.ctx.model ?? 'i386');
    const declared = new Set();
    collectDeclNames(d.body, declared);
    for (const p of d.type.params) if (p.name) declared.add(p.name);
    this.isPseudo = (name) => realMode && PSEUDO.has(name) && !declared.has(name) && !this.ctx.globals.has(name);
    /*
     * A Borland `interrupt` function begins with the registers of the code it interrupted: its
     * prologue pushes them all and reloads DS. So in one, a register holds a value on entry -- the
     * interrupted code's -- and reading it first is not the undefined read it is elsewhere
     * (SDL_TimingService's `TimerVal = _CX`). src/env/pcirq.js hands those registers over.
     */
    this.isInterrupt = realMode && !!d.type.ret?.cv?.interrupt;
    if (realMode && (this.asm || mentionsPseudo(d.body, this.isPseudo) || callsName(d.body, 'geninterrupt'))) {
      this.usesRegs = true;
      const why = firstUndefinedRead(d.body, { isPseudo: this.isPseudo, entryDefined: this.isInterrupt });
      if (why) unsup(`a register value only Borland's code could supply: ${why}`);
    }

    /*
     * A label below the top level means the state machine cannot see it, so lower the whole body to
     * labels and gotos first — see flatten.js. Only functions that need it pay: everything else keeps
     * its structured emission, which is both faster and readable.
     *
     * Quake needs this for nine functions, six of them in the span renderer, where a label sits
     * inside a `do` loop the gotos jump around.
     */
    /*
     * ...and so does a `setjmp` below the top level. The state machine resumes a longjmp at a
     * numbered point between TOP-LEVEL statements, so a call nested in a branch used to be lifted
     * out in front of the statement that held it -- registered whether or not the branch ran, and
     * resumed at a point from which the branch's own condition was evaluated again. SDLPoP's
     * start_game is `if (first_start) { first_start = 0; setjmp(buf); } else { ...; longjmp(buf, -1); }`:
     * the longjmp came back to the `if`, found first_start clear, and took the longjmp again, for
     * ever. Flattened, the call is a top-level statement and the resume point is just after it.
     */
    if (needsFlattening(d.body) || nestedSetjmp(d.body, this.ctx.builtins)) {
      let sw = 0;
      const newTemp = (disc) => {
        // The discriminant is evaluated ONCE, into a real local, because the dispatch chain that
        // replaces the switch would otherwise re-evaluate it per comparison.
        const name = `_sw${sw++}$${d.name}`;
        // The temp keeps the discriminant's OWN type. Forcing it to int truncated a `switch` on a
        // long long to 32 bits -- silently, because the case values were being truncated to match.
        const dt = disc?.type ? this.ty.promote(this.ty.decay(disc.type)) : this.ty.INT;
        const type = T.isInteger(dt) ? dt : this.ty.INT;
        return {
          decl: { n: 'decls', decls: [{ n: 'vardecl', name, type, storage: null, init: { expr: disc } }] },
          ref: { n: 'ident', name, type },
        };
      };
      d = { ...d, body: flattenGotos(d.body, { unsup, newTemp }) };
      this.decl = d;
    }
    // A struct RETURN uses the sret convention: the caller supplies the buffer, because the callee's
    // own frame is released before the value could be read out of it.
    this.sret = T.isRecord(d.type.ret);
    const params = d.type.params.map((p, i) => (p.name ? paramIdent(p.name) : `_unused${i}`));
    if (this.sret) params.unshift('_sret');
    /* The static link comes FIRST, before even the sret buffer: it is the frame, not an argument. */
    if (this.parent) params.unshift('_up');
    // A variadic function takes the caller-packed argument buffer as a hidden last parameter, which
    // is what `va_start` resolves to.
    this.variadic = !!d.type.variadic;
    if (this.variadic) params.push('_va');

    // A 16-bit segmented pointer anywhere in the signature or the body: no answer this emitter could
    // give would be right, because there is no segmented model to give it in. Refused whole, by name.
    const seg = T.segModel(d.type) ?? segModelIn(d.body);
    if (seg) unsup(`a 16-bit ${seg} pointer (Borland segmented model)`);
    // Every Borland asm statement was lowered at the top of emit(); one left here is a lowering bug.
    if (hasNode(d.body, 'asmborland')) unsup('Borland inline assembly');

    // Which locals escape? A scalar that is never `&`-taken can live in a JS var. Everything with
    // an address, and every aggregate, needs a slot. This single decision is the difference between
    // "a few times slower than native" and "tens of times".
    const escaped = new Set();
    collectAddressTaken(d.body, escaped);
    // A local the asm names is addressed, SS-relative, exactly as Borland addressed it.
    if (this.asm) for (const n of this.asm.names) escaped.add(n);
    this.escaped = escaped;
    /*
     * A nested function reaches the enclosing frame through MEMORY and nothing else, so every name
     * it mentions has to be in a slot rather than a JS variable. Collected before the body is
     * walked, because the decision is made when each declaration is emitted.
     */
    for (const it of nestedDefs(d.body)) collectNestedRefs(it.body, escaped);

    const pre = [];
    for (const p of d.type.params) {
      if (!p.name) continue;
      if (T.isRecord(p.type)) {
        // The caller already made a fresh copy, so the callee may modify it in place — no second
        // copy is needed, and `&param` is simply that address.
        this.locals.set(p.name, { kind: 'aggparam', js: paramIdent(p.name), type: p.type });
        continue;
      }
      if (p.type.k === 'array') unsup('an array parameter by value');
      /*
       * A VARIADIC function's named parameter whose address is taken lives where i386 cdecl puts
       * it: in the caller's argument block, just below the variadic ones (#packVarargs reserves the
       * room). Quake III's VM_Call hands &callnum to its bytecode interpreter, which reads the
       * arguments that follow callnum straight out of memory -- undefined in C, and exactly the
       * stack layout of the i386 compilers it was written for.
       */
      if (this.variadic && escaped.has(p.name)) {
        const at = this.#namedArgLayout(d.type).find((x) => x.p === p);
        const js = `((_va-${at.below})|0)`;
        this.locals.set(p.name, { kind: 'aggparam', js, type: p.type });
        this.vaNamed = (this.vaNamed ?? []).concat({ js, type: p.type, from: paramIdent(p.name) });
        continue;
      }
      if (escaped.has(p.name)) {
        const off = this.slot(p.type.size, p.type.align);
        this.locals.set(p.name, { kind: 'slot', off, type: p.type });
        pre.push({ off, type: p.type, from: paramIdent(p.name) });
      } else {
        this.locals.set(p.name, { kind: 'var', js: paramIdent(p.name), type: p.type });
      }
    }

    // `goto` is emitted as a state machine over the function's TOP-LEVEL statements: a labelled
    // `for(;;) switch(_pc)`, where a jump sets _pc and `continue`s. JS switch fallthrough reproduces
    // C label fallthrough exactly, and `continue _top` from inside a nested loop unwinds it — which
    // is what a goto out of a loop must do. A label nested inside a block or loop would need real
    // control-flow flattening and is still refused.
    this.labels = this.#planLabels(d.body);
    if (this.labels) {
      this.out.push('var _pc=0;');
      if (this.hasSetjmp) this.out.push('var _sjv=0;');
      this.out.push(this.hasSetjmp ? '_top: for(;;){ try{ switch(_pc){' : '_top: for(;;){ switch(_pc){');
      for (const [k, seg] of this.labels.segments.entries()) {
        // The registration runs at the END of the previous segment, which is where a fall-through
        // arrives from — so a setjmp is recorded before its own case is ever entered.
        if (seg.pre) {
          const env = this.#rvalForCall(seg.pre.args[0], this.ty.ptr(this.ty.INT));
          this.out.push(`_sjv=0; M.rt.__prism_setjmp(${env},_fp,${k});`);
        }
        this.out.push(`case ${k}:`);
        this.curSegment = k;
        for (const item of seg.items) this.#item(item, escaped);
      }
      if (this.hasSetjmp) {
        // A longjmp aimed at THIS frame resumes; anything else keeps unwinding. The stack pointer is
        // put back to this frame's base, because everything the abandoned path pushed is gone.
        this.out.push('} }catch(_e){ if(_e&&_e.__prismJmp===_fp){ _sjv=_e.val; _pc=_e.pc; M.sp=_e.sp; continue _top; } throw _e; } break _top; }');
      } else {
        this.out.push('} break _top; }');
      }
    } else {
      this.#block(d.body, escaped);
    }

    const body = [];
    // Aligning DOWN is always safe: it only moves the frame further from the stack pointer.
    body.push(this.frameAlign > 4
      ? `var _fp=(M.sp-${this.frameSize})&${~(this.frameAlign - 1)}|0;`
      : `var _fp=M.sp-${this.frameSize}|0;`);
    if (this.frameSize) body.push(`M.sp=_fp;`);
    // Under a 16-bit model the stack is a few kilobytes of DGROUP with the near heap right below it:
    // running past its floor would write the heap, silently. i386's megabyte is left unchecked.
    if (this.frameSize && this.ty.INT.size === 2) body.push(`if(_fp<${this.mod.stackLimit})M.stackOverflow(_fp);`);
    if (this.usesRegs) body.push(REGISTER_DECLS);
    if (this.usesRegs && this.isInterrupt) body.push('if(M.isrRegs)for(const _k of ["ax","bx","cx","dx","si","di","bp","es"])$r[_k]=M.isrRegs[_k]&65535;');
    for (const p of pre) body.push('  ' + storeExpr(`(_fp+${p.off}|0)`, p.type, coerce(this.ty, p.from, p.type, p.type)) + ';');
    for (const p of this.vaNamed ?? []) body.push('  ' + storeExpr(p.js, p.type, coerce(this.ty, p.from, p.type, p.type)) + ';');
    body.push(...this.out.map(l => '  ' + l));
    body.push('  ' + FRAME_RESTORE);
    body.push(`  return ${this.asm?.endsInAsm && d.type.ret.k !== 'void' ? this.#axReturn(d.type.ret)
      : d.type.ret.k === 'void' ? '' : (is64(d.type.ret) ? '0n' : '0')};`);

    // Now the frame's final size is known, so every epilogue marker becomes the one right value.
    // With no frame at all the restore is a no-op assignment and is dropped rather than emitted.
    const restore = this.frameSize ? `M.sp=_fp+${this.frameSize}|0;` : '';
    const text = body.join('\n').split(FRAME_RESTORE).join(restore);
    const self = `function ${jsIdent(d.name)}(${params.join(',')}){\n${text}\n}`;

    /*
     * The nested functions, now that every slot offset this frame will ever hand out is settled.
     * They are siblings in the emitted JavaScript, not closures: a closure would capture the JS
     * variables, and what a nested C function needs is the FRAME.
     */
    for (const { jsName, decl, scope } of this.nested.values()) {
      if (this.parent) unsup('a nested function inside a nested function');
      const child = new FunctionEmitter(this.mod, { ...decl, name: jsName },
        { ...this.ctx, parentEmitter: this, parentScope: scope });
      this.extra.push(child.emit());
      for (const x of child.extra) this.extra.push(x);
    }
    return this.extra.length ? [self, ...this.extra].join('\n') : self;
  }

  /**
   * Split a function body at its top-level labels. Returns null when the function has no labels, and
   * throws when a label sits inside a nested block — that case needs control-flow flattening.
   */
  #planLabels(body) {
    // A `label` node wraps the statement that follows it, so flatten it back into a marker plus
    // that statement before splitting.
    //
    // A statement containing a `setjmp` call also becomes a boundary: longjmp must resume just after
    // the call, and a numbered dispatch point is exactly what the goto machinery already provides.
    // The call itself is lifted out and replaced by `_sjv`, so `if (setjmp(e)) return;` becomes
    // "register, then fall into a case whose first act is to test _sjv".
    const flat = [];
    const walk = (items) => {
      for (const it of items) {
        if (it.n === 'label') { flat.push({ mark: it.name }); walk([it.body]); continue; }
        const sj = findSetjmpCall(it, this.ctx.builtins);
        if (sj) flat.push({ sj });
        flat.push(it);
      }
    };
    walk(body.items);
    const names = flat.filter(x => x.mark).map(x => x.mark);
    this.hasSetjmp = flat.some(x => x.sj);
    if (!names.length && !this.hasSetjmp) {
      // A goto with no TOP-LEVEL label means the label is nested inside a block or loop, which needs
      // real control-flow flattening. Say that, rather than the misleading "no label in this
      // function" this used to report.
      if (findGoto(body)) unsup('a label nested inside a block');
      return null;
    }

    // Every goto in the function must target one of these top-level labels.
    for (const target of collectGotoTargets(body)) {
      if (!names.includes(target)) unsup(`goto into a nested block ('${target}')`);
    }

    const segments = [{ pre: null, items: [] }];
    const index = new Map();
    for (const x of flat) {
      if (x.mark) { index.set(x.mark, segments.length); segments.push({ pre: null, items: [] }); continue; }
      if (x.sj) { segments.push({ pre: x.sj, items: [] }); continue; }
      segments[segments.length - 1].items.push(x);
    }
    return { segments, index };
  }

  // ------------------------------------------------------------- statements

  #block(node, escaped) {
    for (const item of node.items) this.#item(item, escaped);
  }

  #item(item, escaped) {
    switch (item.n) {
      case 'vardecl': return this.#localDecl(item, escaped);
      case 'typedef': case 'tagdecl': return;
      case 'func': {
        /*
         * A GNU nested function. It becomes a top-level JS function whose first parameter is this
         * frame, and every reference it makes to an enclosing local goes through that -- which is
         * why those locals were forced into slots before the body was walked.
         *
         * Emitted AFTER this function's body, because the slot offsets it will refer to are only
         * final once every declaration has been seen.
         */
        if (!item.body) return;
        const jsName = `${this.decl.name}$${item.name}`;
        /*
         * The visible locals are captured HERE, at the point of declaration, because that is C's
         * scope and not the one that will exist later: a nested function declared inside a block is
         * emitted after the whole body, by which time #scoped has unwound that block and the names
         * it could see are gone from the map.
         */
        this.nested.set(item.name, { jsName, decl: item, scope: new Map(this.locals) });
        return;
      }
      default: return this.#stmt(item, escaped);
    }
  }

  #localDecl(d, escaped) {
    /*
     * A FUNCTION declared at block scope declares the external function — it never creates an object,
     * and it needs no `extern` keyword to do so, because a function declaration is extern by default.
     * Requiring the keyword turned Doom's
     *
     *     void V_MarkRect(int, int, int, int);      // inside wipe_ScreenWipe's body
     *
     * into a local variable holding zero, and the next line called through it. The symptom was
     * "call through a non-function pointer 0x0" inside the melt effect, which pointed at the dispatch
     * table three lines below — the table was perfectly correct.
     *
     * Declaring nothing here is the fix: the name then resolves through the ordinary function lookup.
     */
    if (d.type.k === 'func') return;

    if (d.storage === 'extern') {
      // `extern` inside a block REFERS to the file-scope object; it does not create one. Giving it
      // a private global shadowed the real `v` and gcc's scope-1.c exists to catch exactly that.
      const g = this.ctx.globals.get(d.name);
      if (g) { this.locals.set(d.name, { kind: 'global', addr: g.addr, type: g.type }); return; }
      const f = this.ctx.funcs.get(d.name);
      if (f) { this.locals.set(d.name, { kind: 'global', addr: f.addr, type: f.type }); return; }
      // ...or to an object another OBJECT FILE defines -- an assembly module's public, a MakeOBJ
      // resource -- which no C unit declares at file scope: Keen Dreams' USL_CtlHButtonCustom
      // declares `extern char far gametext` inside the block that uses it.
      const linked = this.mod.symbols.get(d.name);
      if (linked?.kind === 'var') { this.locals.set(d.name, { kind: 'global', addr: linked.addr, type: d.type }); return; }
      // Nothing to bind to: leave the name unresolved so a use reports it rather than reading a
      // silently invented object.
      return;
    }
    if (d.storage === 'static') {
      // A static local is a global with a private name; its address must survive the call. The name
      // has to be unique within the FUNCTION, not just the block: two `static int i;` in sibling
      // blocks are two objects, and one symbol for both would silently share their storage.
      const sym = this.mod.defineGlobal(`${this.decl.name}.${this.#uniq(d.name)}`, d.type);
      this.locals.set(d.name, { kind: 'global', addr: sym.addr, type: d.type });
      if (d.init) this.initStatic(sym.addr, d.type, d.init);
      return;
    }
    checkWide(d.type);
    /*
     * A VARIABLE-LENGTH ARRAY: the extent is not known until the declaration runs, so the storage
     * cannot be a frame slot. It is alloca'd, which puts it on the same shadow stack the frame is on
     * and therefore releases it when the function returns -- which is exactly a VLA's lifetime.
     *
     * The local is then recorded as an ADDRESS IN A VARIABLE, which is the shape a by-value struct
     * parameter already uses, so indexing, decay and `&x` all work without another case.
     *
     * ONLY THE OUTERMOST extent may vary. `int a[n][m]` needs a row stride that is itself a runtime
     * value, and every index expression would have to carry it; that is a different feature and it
     * is refused rather than half-built.
     */
    if (d.type.k === 'array' && d.type.vla) {
      if (d.type.of.size == null || (d.type.of.k === 'array' && d.type.of.vla)) {
        unsup('a variable-length array of variable-length arrays');
      }
      if (d.init) unsup('an initialiser on a variable-length array');
      const count = this.#rval(d.type.vla);
      const js = `_vla${this.tmp++}`;
      /*
       * Re-executing the declaration ends the PREVIOUS object's lifetime -- that is what a loop or
       * a backward `goto` does -- so the previous instance is popped, but only when it is still the
       * topmost thing on the shadow stack. Then nothing else can be living below it, and the pop
       * cannot free storage some other declaration is still using.
       *
       * Without it a VLA in a `goto` loop allocates a million times and overflows the shadow stack
       * (gcc's 20040811-1.c). The two variables are function-scoped, so a recursive call gets its
       * own pair and sees no previous instance of its own.
       */
      this.out.unshift(`var ${js}_a=0,${js}_e=0;`);
      this.out.push(`if(${js}_a===M.sp)M.sp=${js}_e;`);
      this.out.push(`${js}_e=M.sp;`);
      this.out.push(`var ${js}=${js}_a=M.rt.alloca(Math.imul((${count.js})|0,${d.type.of.size})|0);`);
      this.locals.set(d.name, { kind: 'aggparam', js, type: d.type });
      return;
    }
    const isAggregate = d.type.k === 'array' || T.isRecord(d.type);
    if (isAggregate || escaped.has(d.name)) {
      if (d.type.size == null) unsup('a local of incomplete type');
      const off = this.slot(d.type.size, d.type.align);
      this.locals.set(d.name, { kind: 'slot', off, type: d.type });
      if (d.init) this.#initDynamic(`(_fp+${off}|0)`, d.type, d.init);
      return;
    }
    /*
     * A JS `var` is FUNCTION-scoped, so two C locals of the same name in different blocks cannot
     * share one. `$` is the separator because no C identifier can contain it.
     */
    const js = `_v_${this.#uniq(d.name)}`;
    this.locals.set(d.name, { kind: 'var', js, type: d.type });
    const init = d.init ? this.#rvalCoerced(d.init.expr, d.type) : (is64(d.type) ? '0n' : '0');
    this.out.push(`var ${js}=${init};`);
  }

  /**
   * A name unique within this function: `w`, then `w$1`, `w$2`.
   *
   * C lets a block redeclare a name it shadows, and the emitter's `locals` map and JS variable names
   * are both flat over the function. PuTTY's terminal.c has a `char buf[2]` inside a block of a
   * function whose outer `buf` is a struct, and every use of the outer one after that point resolved
   * to the inner type.
   */
  #uniq(name) {
    const n = this.nameSeq.get(name) ?? 0;
    this.nameSeq.set(name, n + 1);
    return n ? `${name}$${n}` : name;
  }

  /**
   * Run `fn` with a nested declaration scope: whatever it declares is forgotten on the way out, and
   * whatever it shadowed comes back. Costs one Map copy per block, which is compile time and small
   * beside the source this emitter writes.
   */
  #scoped(fn) {
    const outer = this.locals;
    this.locals = new Map(outer);
    try { fn(); } finally { this.locals = outer; }
  }

  #initDynamic(addr, type, init) {
    if (init.n === 'init') {
      const isAggregate = type.k === 'array' || T.isRecord(type);
      if (isAggregate) {
        // `struct box c = b;` and `char s[8] = "abc";` are copies, not stores.
        if (init.expr.n === 'str') {
          const src = this.#stringAddr(init.expr);
          const wideAll = init.expr.parts.some(pp => isWideLiteral(pp.v));
          const elem = wideAll ? 4 : 1;
          let n = 0;
          for (const part of init.expr.parts) n += literalBytes(part.v, wideAll).bytes.length;
          this.out.push(`M.copy(${addr},${src},${Math.min(n + elem, type.size)});`);
          return;
        }
        // A COMPLEX initialiser is an expression, not a place: `_Complex double z = 3.0 + 4.0i;`
        // computes a value whose address is the result, and a real one converts.
        if (T.isComplex(type)) {
          const v = this.#cxConvert(this.#rval(init.expr), type);
          this.out.push(`M.copy(${addr},${v.js},${type.size});`);
          return;
        }
        const r = this.#lval(init.expr);
        this.out.push(`M.copy(${addr},${r.addr},${type.size});`);
        return;
      }
      this.out.push(storeExpr(addr, type, this.#rvalCoerced(init.expr, type)) + ';');
      return;
    }
    // A brace initializer: zero the object, then write the listed members.
    this.out.push(`M.zero(${addr},${type.size});`);
    this.#initList(addr, type, init);
  }

  /**
   * Fill one elided aggregate from `items` starting at `i`, and return the index of the first item
   * it did not take. The dynamic twin of #staticElided, and it exists for the same reason: `struct s
   * s = { 1, 2, 3, 4 };` where the member is `int f[4]` hands the four scalars to the ARRAY, and
   * before this the member was handed the first one and storeExpr was asked for an int[4] accessor.
   */
  #initElided(addr, type, items, i) {
    if (type.k === 'array') {
      const n = type.n ?? 0;
      for (let idx = 0; idx < n && i < items.length; idx++) {
        const it = items[i];
        if (it.designators) return i;                 // a designator belongs to the outer object
        const off = `(${addr}+${idx * type.of.size}|0)`;
        if (it.value.n === 'initlist') { this.#initList(off, type.of, it.value); i++; }
        else if (this.#elidable(type.of, it)) i = this.#initElided(off, type.of, items, i);
        else { this.out.push(storeExpr(off, type.of, this.#rvalCoerced(it.value.expr, type.of)) + ';'); i++; }
      }
      return i;
    }
    const named = type.fields.filter(f => f.width !== 0
      && (f.name || (f.bits === undefined && T.isRecord(f.type))));
    const upto = type.k === 'union' ? Math.min(1, named.length) : named.length;
    for (let k = 0; k < upto && i < items.length; k++) {
      const it = items[i];
      if (it.designators) return i;
      const f = named[k];
      if (f.flexible) unsup('initialising a flexible array member in a local');
      if (f.bits !== undefined) {
        this.#initBitfield(addr, f, this.#rvalCoerced(it.value.expr, f.type));
        i++;
      } else {
        const off = `(${addr}+${f.offset}|0)`;
        if (it.value.n === 'initlist') { this.#initList(off, f.type, it.value); i++; }
        else if (this.#elidable(f.type, it)) i = this.#initElided(off, f.type, items, i);
        else if (T.isRecord(f.type) || f.type.k === 'array') { this.#initDynamic(off, f.type, it.value); i++; }
        else { this.out.push(storeExpr(off, f.type, this.#rvalCoerced(it.value.expr, f.type)) + ';'); i++; }
      }
    }
    return i;
  }

  #initList(addr, type, init) {
    if (type.k === 'array') {
      let idx = 0;
      for (let i = 0; i < init.items.length; i++) {
        const it = init.items[i];
        if (it.designators) idx = it.designators[0].index ?? idx;
        /*
         * A GNU RANGE designator, `[1 ... 5] = v`. The initialiser is evaluated ONCE -- gcc's
         * `[0 ... 3] = next()` calls next once and stores its result four times -- so the first
         * element is written the ordinary way and the rest are COPIES of it. That is also what makes
         * a braced list in a range cost one initialisation instead of one per element.
         */
        const hi = it.designators?.[0]?.indexHi;
        if (hi !== undefined) {
          if (hi - idx > 65536) unsup('an array range designator wider than 65536 elements');
          const first = `(${addr}+${idx * type.of.size}|0)`;
          if (it.value.n === 'initlist') this.#initList(first, type.of, it.value);
          else if (type.of.k === 'array' || T.isRecord(type.of)) this.#initDynamic(first, type.of, it.value);
          else this.out.push(storeExpr(first, type.of, this.#rvalCoerced(it.value.expr, type.of)) + ';');
          for (let k = idx + 1; k <= hi; k++) {
            this.out.push(`M.copy((${addr}+${k * type.of.size}|0),${first},${type.of.size});`);
          }
          idx = hi + 1;
          continue;
        }
        const off = `(${addr}+${idx * type.of.size}|0)`;
        if (it.value.n === 'initlist') this.#initList(off, type.of, it.value);
        // An element that takes items from THIS list with no braces of its own: `struct pt a[2] =
        // {1,2,3,4}` gives the first two to a[0]. Brace elision, C89 6.7.8p17.
        else if (this.#elidable(type.of, it)) i = this.#initElided(off, type.of, init.items, i) - 1;
        // An AGGREGATE element is a copy, not a store: `char name[23][8] = {"e2m1", ...}` gives each
        // row a string literal, and storeExpr has no accessor for a char[8]. Doom's D_DoomMain has
        // exactly that table, and it is the function that starts the game.
        else if (type.of.k === 'array' || T.isRecord(type.of)) this.#initDynamic(off, type.of, it.value);
        else this.out.push(storeExpr(off, type.of, this.#rvalCoerced(it.value.expr, type.of)) + ';');
        idx++;
      }
      return;
    }
    if (T.isRecord(type)) {
      // Bitfields ARE initialisable members and must not be filtered out: skipping them left
      // `struct { signed s:3; unsigned u:3; } x = {-1,-1}` completely unwritten.
      /*
       * The members an initialiser list walks, one per OFFSET.
       *
       * An anonymous union is flattened into its parent's field list by the parser, which is what
       * makes `v.c` resolve without a path -- but it also loses the grouping, and positional
       * initialisation needs it:
       *
       *     struct { int a, b; union { int c, d; }; struct S1 s; } v = {1, 2, 3, {4, 5}};
       *
       * Here `c` and `d` share an offset and between them take ONE item; the braced pair belongs to
       * `s`. Without the grouping the pair went to `d`, which overwrote `c` -- a silently wrong
       * object where the previous code had at least refused. Two members at one offset inside a
       * struct can only have come from a union.
       */
      /*
       * Two fields of a STRUCT at one offset can only have come from an anonymous union, which the
       * parser folds into the parent's field list -- so the second is dropped rather than given the
       * next item.
       *
       * BITFIELDS ARE THE EXCEPTION AND THEY ARE NOT RARE. `struct { unsigned a:1, b:2, c:3; }`
       * packs all three into one storage unit, so all three report offset 0, and deduplicating by
       * offset alone silently dropped every bitfield after the first: `{1, 2, 3}` initialised to
       * 1, 0, 0. Two of gcc's torture programs are exactly that (bf-sign-1.c, 20000113-1.c) and it
       * is a WRONG ANSWER rather than a refusal, which is the worst kind.
       */
      const seen = new Set();
      const named = type.fields.filter((f) => {
        if (!f.name || f.width === 0) return false;
        if (type.k === 'struct' && f.bits === undefined) {
          if (seen.has(f.offset)) return false;
          seen.add(f.offset);
        }
        return true;
      });
      let k = 0;
      for (let i = 0; i < init.items.length; i++) {
        const it = init.items[i];
        let f = named[k];
        if (it.designators?.[0]?.field) f = findField(type, it.designators[0].field);
        if (!f) break;
        const t = it.designators && it.designators.length > 1
          ? descendDesignators(f, it.designators.slice(1))
          : { off: f.offset, type: f.type, field: f };
        // An object with automatic storage has no room past its own size, so a flexible array
        // member cannot be filled in one -- gcc rejects it too.
        if (t.field.flexible) unsup('initialising a flexible array member in a local');
        if (t.field.bits !== undefined) {
          this.#initBitfield(addr, { ...t.field, offset: t.off }, this.#rvalCoerced(it.value.expr, t.type));
        } else {
          const off = `(${addr}+${t.off}|0)`;
          if (it.value.n === 'initlist') this.#initList(off, t.type, it.value);
          else if (this.#elidable(t.type, it)) i = this.#initElided(off, t.type, init.items, i) - 1;
          /*
           * An AGGREGATE member given a single expression is a COPY, not a store -- `.magic =
           * (jint16_t){0x1985}` and `.pos = other.pos` alike. A record rvalue is its address in
           * tier-0, so both are the same M.copy; going through storeExpr asked for a DataView
           * accessor for a struct and refused (gcc's 20030224-2.c).
           */
          else if (T.isRecord(t.type) || t.type.k === 'array') {
            const vt = it.value.expr?.type;
            if (vt && (T.isRecord(vt) || vt.k === 'array')) {
              const src = this.#lval(it.value.expr);
              this.out.push(`M.copy(${off},${src.addr},${t.type.size});`);
            } else {
              /*
               * A DESIGNATED aggregate given a bare scalar: `struct { int c; pthread_mutex_t m; } r
               * = { .m = 0 };`. #elidable says no because of the designator -- rightly, since a
               * designator names the outer object -- so the one item is elided into the member on
               * its own (gcc's pr33631.c).
               */
              this.#initElided(off, t.type, [{ ...it, designators: null }], 0);
            }
          } else this.out.push(storeExpr(off, t.type, this.#rvalCoerced(it.value.expr, t.type)) + ';');
        }
        k = named.indexOf(f) + 1;
      }
      return;
    }
    // A scalar in braces: `int x = { 1 };`
    if (init.items.length) {
      this.out.push(storeExpr(addr, type, this.#rvalCoerced(init.items[0].value.expr, type)) + ';');
    }
  }

  /**
   * Run the ordinary initialiser walk, but collect its statements instead of emitting them.
   *
   * This reuses every case #initDynamic already handles -- designators, brace elision, bitfields,
   * nested aggregates -- rather than growing a second, thinner implementation that would drift from
   * it. What it cannot reuse is a statement that is not a single expression: a loop or a block does
   * not fit inside a comma. That is refused BY NAME rather than hoisted, because hoisting would
   * silently move when the initialisers run.
   */
  #captureInit(at, type, init) {
    const saved = this.out;
    this.out = [];
    let captured;
    try {
      this.#initDynamic(at, type, init);
      captured = this.out;
    } finally { this.out = saved; }
    const steps = [];
    for (const line of captured) {
      const t = String(line).trim();
      if (!t) continue;
      /*
       * A temporary DECLARES itself at the top of whatever buffer was current when it was asked
       * for, and here that buffer is this capture -- so `var _t0=0;` would land inside the comma
       * expression, where JavaScript does not allow a declaration. It belongs to the function, so
       * it is put back at the top of the function, which is where #declareTmp meant to put it.
       */
      if (/^var \w+=0;$/.test(t)) { this.out.unshift(t); continue; }
      if (t.includes('\n') || /^(if|for|while|do|switch|\{)/.test(t) || t.endsWith('{')) {
        throw new EmitError('a compound literal whose initialiser needs a statement, not an expression');
      }
      steps.push(...topLevelStatements(t));
    }
    return steps;
  }

  /** Public: the driver uses this for file-scope initialisers too. */
  initStatic(addr, type, init) {
    // Static initialisers are written into the image at link time where they are constant, and
    // otherwise deferred to a start-up thunk. Tier-0 only handles the constant case.
    if (init.n === 'init') {
      if (this.#staticScalar(addr, type, init.expr)) return;
    }
    if (init.n === 'initlist') { this.#staticList(addr, type, init); return; }
    unsup(`a non-constant static initialiser (${describeExpr(init.expr ?? init)}) [type ${T.typeName(type)}]`);
  }

  /** One constant scalar, pointer or string into the image. Returns false if not constant. */
  #staticScalar(addr, type, expr) {
    // A COMPLEX object at file scope: both halves are constants, folded here because the ordinary
    // folder answers with one number and a complex constant is two.
    if (T.isComplex(type)) {
      const v = foldComplexConst(expr);
      if (!v) return false;
      const of = type.complexOf;
      writeConst(this.mod, addr, of, v.re);
      writeConst(this.mod, addr + of.size, of, v.im);
      return true;
    }
    // `(unsigned char *)"..."` is still a string literal. Peeling casts first costs nothing and is
    // what a program writes when it stores a literal into a typed pointer.
    while (expr.n === 'cast' && expr.expr?.n === 'str') expr = expr.expr;
    if (expr.n === 'str') {
      const wideAll = expr.parts.some(pp => isWideLiteral(pp.v));
      const elem = wideAll ? 4 : 1;
      const bytes = [];
      for (const part of expr.parts) bytes.push(...literalBytes(part.v, wideAll).bytes);
      if (type.k === 'array') {
        // The array holds the literal's bytes, plus a full-width terminator only if it fits.
        const n = Math.min(bytes.length, type.size);
        this.mod.u8.set(bytes.slice(0, n), addr);
        for (let k = 0; k < elem && bytes.length + k < type.size; k++) this.mod.u8[addr + bytes.length + k] = 0;
        return true;
      }
      writeConst(this.mod, addr, type, this.#stringAddr(expr));
      return true;
    }
    if (expr.n === 'labeladdr') {
      const k = this.labels?.index.get(expr.name);
      if (k === undefined) unsup(`the address of label '${expr.name}' in a static initialiser`);
      writeConst(this.mod, addr, type, k);
      return true;
    }

    // A 64-bit initialiser must be folded in BigInt: going through Number would silently lose the
    // low bits of anything past 2^53.
    if (is64(type)) {
      try { writeConst(this.mod, addr, type, constEval(expr)); return true; } catch { /* fall through */ }
    }

    // An ADDRESS CONSTANT is a legal static initialiser and c-testsuite leans on it heavily:
    // `int *p = &x;`, `.p = &x`, `&arr[2]`, `&s.field`, `name + 1`. It is constant because every
    // global already has its address by the time any initialiser is written.
    const a = this.#addrConst(expr);
    if (a !== null) { writeConst(this.mod, addr, type, a); return true; }

    try {
      writeConst(this.mod, addr, type, evalConstNumber(this.ty, expr));
      return true;
    } catch { return false; }
  }

  /** Fold a constant address expression, or return null if it is not one. */
  #addrConst(e) {
    switch (e.n) {
      case 'cast': return this.#addrConst(e.expr);
      case 'unary':
        if (e.op === '&') return this.#lvalAddrConst(e.expr);
        return null;
      case 'ident': {
        // An array or function name decays to its own address without needing `&`.
        const l = this.locals?.get(e.name);
        if (l) return l.kind === 'global' && l.type.k === 'array' ? l.addr : null;
        const g = this.ctx.globals?.get(e.name);
        if (g && g.type.k === 'array') return g.addr;
        const f = this.ctx.funcs?.get(e.name);
        if (f) { this.#noteBuiltinRef(e.name, f); return f.addr; }
        /*
         * The address of a LIBRARY function. PRISM's builtins are JavaScript in M.rt and have no
         * address of their own, but a program is entitled to take one: SQLite's unix layer builds a
         * table of syscall pointers — `{ "access", (sqlite3_syscall_ptr)access, 0 }` — so it can
         * swap them out under test.
         *
         * Giving the builtin a function-table slot is all it takes; an indirect call then finds the
         * runtime implementation the same way it finds a compiled one. Recorded here and bound after
         * emission, when M.rt exists.
         */
        return this.#builtinAddr(e.name);
      }
      /*
       * An indexed or selected ARRAY decays to its own address, and that is a constant when the
       * index is. Doom writes `cheat_powerup_seq[0]` — a row of a 2-D array — in a static
       * initialiser, which is ordinary C and was refused only because this case was missing.
       */
      case 'index': case 'member': {
        const t = e.type;
        if (t && (t.k === 'array' || t.k === 'func')) return this.#lvalAddrConst(e);
        return null;
      }
      // An ARRAY compound literal decays to its own address, with no `&` written.
      case 'compound':
        return e.type?.k === 'array' ? this.#lvalAddrConst(e) : null;
      case 'bin': {
        if (e.op !== '+' && e.op !== '-') return null;
        const base = this.#addrConst(e.a);
        if (base === null) return null;
        // The offset scales by the pointee, exactly as at run time.
        const elem = this.ty.decay(e.a.type ?? this.ty.INT);
        const step = elem.k === 'ptr' ? (elem.to.size ?? 1) : 1;
        let n;
        try { n = evalConstNumber(this.ty, e.b); } catch { return null; }
        return e.op === '+' ? base + n * step : base - n * step;
      }
    }
    return null;
  }

  /** The constant address of a static lvalue: a global, a member of one, an element of one. */
  /**
   * The address of a LIBRARY function. PRISM's builtins are JavaScript in M.rt and have no address
   * of their own, but a program is entitled to take one -- SQLite's unix layer builds a table of
   * syscall pointers so it can swap them out under test. A function-table slot is all it takes;
   * it is recorded here and bound after emission, when M.rt exists.
   */
  #builtinAddr(name) {
    if (!this.#noteBuiltinRef(name, null)) return null;
    return this.mod.defineFunc(name, null).addr;
  }

  /**
   * Record that a library function's ADDRESS is wanted, so its table slot is filled after emission.
   *
   * It has to happen even when the name ALREADY has a table entry, which is the case that was
   * missing: a prototype in <stdio.h> gives `puts` a slot the moment the header is parsed, so the
   * lookup succeeded and handed back an address nothing had bound. `sp = &puts; sp("hi")` then
   * reported an unbound slot, naming an index rather than the function.
   *
   * Returns whether the name is a builtin at all.
   */
  #noteBuiltinRef(name, f) {
    if (f?.defined) return false;                     // the program's own definition wins
    const b = this.ctx.builtins?.get(name);
    if (!b) return false;
    (this.ctx.builtinRefs ??= new Set()).add(name);
    return true;
  }

  #lvalAddrConst(e) {
    switch (e.n) {
      /*
       * `&(struct S){ 1, 2 }` at file scope. A compound literal outside a function has STATIC
       * storage duration (C99 6.5.2.5p5), so its address is an address constant -- it gets a real
       * object in the image, initialised the same way a named one would be.
       */
      case 'compound': {
        if (!e.type || e.type.size == null) return null;
        if (e.staticAddr !== undefined) return e.staticAddr;
        const addr = this.mod.alloc(e.type.size, e.type.align ?? 4);
        this.mod.zero?.(addr, e.type.size);
        try { this.initStatic(addr, e.type, e.init); } catch { return null; }
        e.staticAddr = addr;                    // one object per literal, however often it is named
        return addr;
      }
      case 'ident': {
        // A name in scope here first: a block-scope static is an object with a fixed address
        // (saga's `static const char *hintPtr = hintBuf;`), an automatic one is no constant at all.
        const l = this.locals?.get(e.name);
        if (l) return l.kind === 'global' ? l.addr : null;
        const g = this.ctx.globals?.get(e.name);
        if (g) return g.addr;
        const f = this.ctx.funcs?.get(e.name);
        if (f) { this.#noteBuiltinRef(e.name, f); return f.addr; }
        // `&puts` -- the same rule as the bare name in #addrConst, which is reached when the array
        // or function decays on its own.
        return this.#builtinAddr(e.name);
      }
      case 'member': {
        /*
         * Through a POINTER, which is constant whenever the pointer is -- and that is the offsetof
         * idiom, written by hand because C89 had no offsetof worth using:
         *
         *     #define offset(c, m) (((size_t)&((c *)8)->m) - 8)      // OpenDUNE, saveload.h:29
         *
         * The base is 8 rather than 0 to keep a null-dereference warning quiet; the subtraction
         * takes it back out. Refusing this refused every save/load table in the program.
         */
        if (e.arrow) {
          let base = this.#addrConst(e.base);
          if (base === null) { try { base = evalConstNumber(this.ty, e.base); } catch { return null; } }
          const pt = this.ty.decay(e.base.type ?? this.ty.INT);
          const rec = pt.k === 'ptr' ? pt.to : null;
          if (!rec || !T.isRecord(rec)) return null;
          const f = findField(rec, e.field);
          return f && f.bits === undefined ? base + f.offset : null;
        }
        const base = this.#lvalAddrConst(e.base);
        if (base === null) return null;
        const rec = e.base.type;
        if (!rec || !T.isRecord(rec)) return null;
        const f = findField(rec, e.field);
        return f && f.bits === undefined ? base + f.offset : null;
      }
      case 'index': {
        const base = this.#lvalAddrConst(e.base) ?? this.#addrConst(e.base);
        if (base === null) return null;
        /*
         * The element size, and it cannot always come from the expression's own type: nothing
         * annotates an `ident` node inside a file-scope initialiser, so `&S_sfx[69]` -- Heretic's
         * sound table pointing at its own entries -- arrived here with no type and was refused.
         * The declaration knows, so ask it.
         */
        let bt = this.ty.decay(e.base.type ?? this.ty.INT);
        if (bt.k !== 'ptr' && e.base.n === 'ident') {
          const g = this.ctx.globals?.get(e.base.name) ?? this.locals?.get(e.base.name);
          if (g?.type) bt = this.ty.decay(g.type);
        }
        if (bt.k !== 'ptr') return null;
        let n;
        try { n = evalConstNumber(this.ty, e.index); } catch { return null; }
        return base + n * (bt.to.size ?? 1);
      }
      case 'str': return this.#stringAddr(e);
    }
    return null;
  }

  /**
   * A file-scope brace initialiser, written straight into the image.
   *
   * Members are matched one-to-one against items, EXCEPT that an aggregate member handed a
   * non-braced item consumes as many following items as it needs. That is brace elision (C89
   * 6.7.8p17), and it is how most tables of structs are actually written:
   *
   *     struct { mobjtype_t type; int speed[2]; } MonsterMissileInfo[] = {
   *         { MT_IMPBALL, 10, 20 },        // speed[] takes the 10 and the 20, with no braces
   *
   * It is grafted onto the one-to-one walk rather than replacing it. Rewriting this as a pure stream
   * looked cleaner and broke three things the one-to-one version had right -- designators that go
   * backwards, flattened anonymous unions, and array designators with holes -- so the elision is
   * confined to the one branch that needs it.
   */
  #staticList(addr, type, init) {
    /*
     * `{ "ARTIBOX" }` -- a string literal in braces, initialising a whole character array.
     *
     * The braces belong to the ARRAY, not to its first element, so the string fills the object the
     * way it would without them. Heretic's status bar is a table of these:
     *
     *     char patcharti[][10] = { {"ARTIBOX"}, {"ARTIINVU"}, ... };
     *
     * Read element by element instead, the string decayed to its ADDRESS and the low byte of that
     * address landed in patcharti[i][0] -- so the game asked its WAD for a lump called "K" and died.
     * The unbraced form was already handled in #elidable; this is the same rule one level in.
     */
    if (type.k === 'array' && type.of.k === 'scalar' && (type.of.size === 1 || type.of.size === 4)
        && init.items.length === 1 && !init.items[0].designators) {
      let e = init.items[0].value?.expr;
      while (e && e.n === 'cast') e = e.expr;
      if (e && e.n === 'str') { this.#staticScalar(addr, type, e); return; }
    }
    if (type.k === 'array') {
      let idx = 0;
      for (let i = 0; i < init.items.length; i++) {
        const it = init.items[i];
        if (it.designators) idx = it.designators[0].index ?? idx;
        const hi = it.designators?.[0]?.indexHi;
        if (hi !== undefined) {                                   // `[1 ... 5] = v`
          if (hi - idx > 65536) unsup('an array range designator wider than 65536 elements');
          for (let k = idx; k <= hi; k++) {
            const at = addr + k * type.of.size;
            if (it.value.n === 'initlist') this.#staticList(at, type.of, it.value);
            else if (!this.#staticScalar(at, type.of, it.value.expr)) {
              unsup(`a non-constant static initialiser (${describeExpr(it.value.expr)}) ` +
                `into element ${k} of type ${T.typeName(type.of)}`);
            }
          }
          idx = hi + 1;
          continue;
        }
        if (it.value.n === 'initlist') {
          this.#staticList(addr + idx * type.of.size, type.of, it.value);
        } else if (this.#elidable(type.of, it)) {
          i = this.#staticElided(addr + idx * type.of.size, type.of, init.items, i) - 1;
        } else if (!this.#staticScalar(addr + idx * type.of.size, type.of, it.value.expr)) {
          unsup(`a non-constant static initialiser (${describeExpr(it.value.expr)}) ` +
            `into element ${idx} of type ${T.typeName(type.of)}`);
        }
        idx++;
      }
      return;
    }
    if (T.isRecord(type)) {
      // Bitfields are initialisable here too. The dynamic path was fixed first and this one was
      // not, so `struct s x = { -123, -456 };` at file scope still wrote nothing (gcc's bitfld-4.c).
      const named = type.fields.filter(f => f.width !== 0
        // An ANONYMOUS struct or union member is initialised positionally like any other; it just
        // has no name to be designated by. Dropping it gave its item to the NEXT member and left the
        // union unwritten (c-testsuite 00050).
        && (f.name || (f.bits === undefined && T.isRecord(f.type))));
      let k = 0;
      for (let i = 0; i < init.items.length; i++) {
        const it = init.items[i];
        let f = named[k];
        if (it.designators?.[0]?.field) f = findField(type, it.designators[0].field);
        if (!f) break;
        const t = it.designators && it.designators.length > 1
          ? descendDesignators(f, it.designators.slice(1))
          : { off: f.offset, type: f.type, field: f };
        /*
         * A FLEXIBLE array member writes past the struct's nominal size, which is exactly what the
         * extension is for. It has no length of its own, so it is given the one its initialiser
         * implies -- and the object was allocated that much larger, by flexibleExtra(), before any
         * of this ran.
         */
        const ft = t.field.flexible ? flexibleArrayType(t.type, it.value) : t.type;
        if (t.field.bits !== undefined) {
          let v;
          try { v = evalConstNumber(this.ty, it.value.expr); } catch { unsup('a non-constant bitfield initialiser'); }
          writeStaticBitfield(this.mod, addr, { ...t.field, offset: t.off }, v);
        } else if (it.value.n === 'initlist') {
          this.#staticList(addr + t.off, ft, it.value);
        } else if (this.#elidable(ft, it)) {
          i = this.#staticElided(addr + t.off, ft, init.items, i) - 1;
        } else if (!this.#staticScalar(addr + t.off, ft, it.value.expr)) {
          unsup(`a non-constant static initialiser (${describeExpr(it.value.expr)}) ` +
            `into field '${t.field.name}' of type ${T.typeName(t.type)}`);
        }
        k = named.indexOf(f) + 1;
      }
      return;
    }
    if (init.items.length) this.#staticScalar(addr, type, init.items[0].value.expr);
  }

  /**
   * Would this member take its initialiser from the enclosing list, with no braces of its own?
   *
   * Only for an aggregate given a bare expression — and NOT for a character array given a string
   * literal, which is a complete initialiser for the whole array rather than one element of it:
   * `{ "-phopow", &S_sfx[9], 32 }` fills `char name[8]` from the string and moves on.
   */
  #elidable(type, it) {
    if (type.k !== 'array' && !T.isRecord(type)) return false;
    if (it.designators) return false;
    /*
     * REFUSE a struct that contains a flattened anonymous union.
     *
     * The parser folds an anonymous union's members into the parent's field list, which is what
     * makes `v.c` resolve without a path -- and it destroys the grouping that positional
     * initialisation needs: `{1, 2, 3, {4, 5}}` must give the 3 to the union and the pair to the
     * next member, but a flat list of a, b, c, d, s gives the pair to `d` and overwrites `c`.
     *
     * Two named fields at one offset inside a struct can only have come from a union. Refusing keeps
     * the failure LOUD, which is the whole point: before elision existed this shape was refused, and
     * making it compile-but-wrong would have been a strictly worse outcome.
     */
    if (type.k === 'struct') {
      const at = new Set();
      for (const f of type.fields) {
        if (!f.name || f.width === 0) continue;
        if (at.has(f.offset)) return false;
        at.add(f.offset);
      }
    }
    let e = it.value.expr;
    while (e && e.n === 'cast') e = e.expr;
    if (!e) return false;
    if (e.n === 'str' && type.k === 'array' && type.of.k === 'scalar'
        && (type.of.size === 1 || type.of.size === 4)) return false;
    /*
     * A value that is ALREADY an aggregate is a copy, never a source of items to spread across the
     * member: `struct A a = { 2, b };` gives `b` to the whole struct-typed member, not its first
     * field. Missing this turned two of gcc's programs into WRONG ANSWERS the moment the dynamic
     * path learned elision -- the static path had never reached them, because a struct variable is
     * not a constant initialiser.
     */
    const et = e.type;
    if (et && (T.isRecord(et) || et.k === 'array')) return false;
    return true;
  }

  /**
   * Fill one elided aggregate from `items` starting at `i`, and return the index of the first item
   * it did not take. Recurses, because elision nests: a struct of arrays takes scalars all the way
   * down.
   */
  #staticElided(addr, type, items, i) {
    if (type.k === 'array') {
      const n = type.n ?? 0;
      for (let idx = 0; idx < n && i < items.length; idx++) {
        const it = items[i];
        if (it.designators) return i;                 // a designator belongs to the outer object
        if (it.value.n === 'initlist') { this.#staticList(addr + idx * type.of.size, type.of, it.value); i++; }
        else if (this.#elidable(type.of, it)) i = this.#staticElided(addr + idx * type.of.size, type.of, items, i);
        else if (this.#staticScalar(addr + idx * type.of.size, type.of, it.value.expr)) i++;
        else unsup(`a non-constant static initialiser (${describeExpr(it.value.expr)}) ` +
          `into element ${idx} of type ${T.typeName(type.of)}`);
      }
      return i;
    }
    // A union takes exactly one item, into its first member.
    const named = type.fields.filter(f => f.width !== 0
        // An ANONYMOUS struct or union member is initialised positionally like any other; it just
        // has no name to be designated by. Dropping it gave its item to the NEXT member and left the
        // union unwritten (c-testsuite 00050).
        && (f.name || (f.bits === undefined && T.isRecord(f.type))));
    const upto = type.k === 'union' ? Math.min(1, named.length) : named.length;
    for (let k = 0; k < upto && i < items.length; k++) {
      const it = items[i];
      if (it.designators) return i;
      const f = named[k];
      const ft = f.flexible ? flexibleArrayType(f.type, it.value) : f.type;
      if (f.bits !== undefined) {
        let v;
        try { v = evalConstNumber(this.ty, it.value.expr); } catch { unsup('a non-constant bitfield initialiser'); }
        writeStaticBitfield(this.mod, addr, f, v);
        i++;
      } else if (it.value.n === 'initlist') { this.#staticList(addr + f.offset, ft, it.value); i++; }
      else if (this.#elidable(ft, it)) i = this.#staticElided(addr + f.offset, ft, items, i);
      else if (this.#staticScalar(addr + f.offset, ft, it.value.expr)) i++;
      else unsup(`a non-constant static initialiser (${describeExpr(it.value.expr)}) ` +
        `into field '${f.name}' of type ${T.typeName(f.type)}`);
    }
    return i;
  }

  #stmt(s, escaped) {
    switch (s.n) {
      case 'empty': return;
      case 'block': {
        /*
         * A block that declares a VLA gives its storage back when it ENDS -- C's rule, and the one
         * that keeps two sibling VLA blocks inside a `goto` loop from allocating for ever (gcc's
         * pr43220.c). Only the fall-through exit restores; a `break` or `goto` out of the block
         * leaves the storage until the function returns, which leaks but never frees too early.
         */
        const vla = s.items.some(it => it.n === 'vardecl' && it.type?.vla)
          || s.items.some(it => it.n === 'decls' && it.decls?.some(d => d.type?.vla));
        const mark = vla ? `_bsp${this.tmp++}` : null;
        this.out.push(mark ? `{var ${mark}=M.sp;` : '{');
        this.#scoped(() => this.#block(s, escaped));
        this.out.push(mark ? `M.sp=${mark};}` : '}');
        return;
      }
      case 'exprstmt': this.out.push(this.#rval(s.expr).js + ';'); return;
      case 'decls': for (const d of s.decls) this.#item(d, escaped); return;
      case 'if': {
        this.out.push(`if(${this.#truth(s.cond)}){`);
        this.#stmt(s.then, escaped);
        if (s.els) { this.out.push('}else{'); this.#stmt(s.els, escaped); }
        this.out.push('}');
        return;
      }
      case 'while': {
        this.out.push(`while(${this.#truth(s.cond)}){`);
        this.loopDepth++; this.#stmt(s.body, escaped); this.loopDepth--;
        if (this.ctx.safepoints) this.out.push(this.#safepoint());
        this.out.push('}');
        return;
      }
      case 'do': {
        this.out.push('do{');
        this.loopDepth++; this.#stmt(s.body, escaped); this.loopDepth--;
        if (this.ctx.safepoints) this.out.push(this.#safepoint());
        this.out.push(`}while(${this.#truth(s.cond)});`);
        return;
      }
      case 'for': {
        // The init clause may declare, so it is emitted BEFORE the loop and the JS `for` gets an
        // empty init. `for (int i = ...)` opens a scope of its own, which is why the whole statement
        // is wrapped: the `i` it declares must not outlive the loop.
        this.#scoped(() => {
          if (s.init) this.#item(s.init.n === 'decls' ? s.init : s.init, escaped);
          const cond = s.cond ? this.#truth(s.cond) : 'true';
          const step = s.step ? this.#rval(s.step).js : '';
          this.out.push(`for(;${cond};${step}){`);
          this.loopDepth++; this.#stmt(s.body, escaped); this.loopDepth--;
          if (this.ctx.safepoints) this.out.push(this.#safepoint());
          this.out.push('}');
        });
        return;
      }
      case 'switch': {
        const d = this.#rval(s.disc);
        this.out.push(`switch(${d.js}|0){`);
        // The braces of the body are dropped on purpose: `switch(x){{case 0:...}}` is a syntax
        // error in JavaScript, where a switch's cases must be direct children.
        if (s.body.n === 'block') this.#scoped(() => this.#block(s.body, escaped));
        else this.#stmt(s.body, escaped);
        this.out.push('}');
        return;
      }
      case 'case': {
        if (s.hi !== null && s.hi !== undefined) {
          // GNU case ranges: expand, which is what gcc does too.
          for (let v = s.lo; v <= s.hi; v++) this.out.push(`case ${Number(v)}:`);
        } else this.out.push(`case ${Number(s.lo)}:`);
        this.#stmt(s.body, escaped);
        return;
      }
      case 'default': this.out.push('default:'); this.#stmt(s.body, escaped); return;
      case 'break': this.out.push('break;'); return;
      case 'continue': this.out.push('continue;'); return;
      case 'return': {
        const ret = this.decl.type.ret;
        if (!s.expr || ret.k === 'void') {
          this.out.push(FRAME_RESTORE);
          this.out.push('return;');
          return;
        }
        // The value is computed FIRST, into a temp, and only then is the frame released. Releasing
        // it first lets `return foo(x)` run foo on a frame that overlaps this one — foo's own locals
        // then overwrite the array whose address was just passed to it. Found by c-testsuite 00077,
        // never by a hand-written case, because it needs an aggregate local AND a call in a return.
        if (T.isRecord(ret)) {
          const src = this.#lval(s.expr);
          this.out.push(`M.copy(_sret,${src.addr},${ret.size});`);
          this.out.push(FRAME_RESTORE);
          this.out.push('return _sret;');
          return;
        }
        const v = this.#rvalCoerced(s.expr, ret);
        const t = this.newTmp(); this.#declareTmp(t);
        this.out.push(`${t}=${v};`);
        this.out.push(FRAME_RESTORE);
        this.out.push(`return ${t};`);
        return;
      }
      case 'label': {
        // Reached only when a label is nested; the planner rejects that, so this is the top-level
        // case where the marker has already opened a new switch arm.
        this.#stmt(s.body, escaped);
        return;
      }
      case 'asmins': {
        let js;
        try { js = emitInstruction(s.ins, this.#asmEnv()); } catch (e) {
          if (e instanceof BorlandAsmError) unsup(`Borland inline assembly: ${e.message}`);
          throw e;
        }
        if (js) this.out.push(js);
        return;
      }
      case 'goto': {
        const k = this.labels?.index.get(s.label);
        if (k === undefined) unsup(`goto '${s.label}'`);
        // A BACKWARD goto is a loop's back edge -- in Borland inline assembly, every `jnz` and `loop`
        // that closes a loop is one -- so it carries the safepoint a `while` does.
        const back = this.ctx.safepoints && k <= (this.curSegment ?? -1) ? this.#safepoint() : '';
        this.out.push(`{${back}_pc=${k}; continue _top;}`);
        return;
      }
      case 'gotoexpr': {
        // A computed goto is the state machine's natural form: the "address" of a label IS its _pc
        // value, so `goto *p` is simply a dispatch on p.
        if (!this.labels) unsup('a computed goto with no labels in this function');
        const v = this.#rval(s.expr);
        this.out.push(`{_pc=(${v.js})|0; continue _top;}`);
        return;
      }
      case 'asm': {
        // An asm whose template is empty emits no instructions — it exists only as a barrier — so
        // with no output operands the faithful translation is nothing at all. Its INPUTS are still
        // evaluated, because they are ordinary C expressions and may have side effects.
        const text = (s.template ?? []).map(t => t.replace(/^L?"|"$/g, '')).join('').trim();
        // An empty template emits no instructions, so with NO OUTPUT OPERANDS it is faithfully a
        // no-op — its inputs are still evaluated, being ordinary C expressions with possible side
        // effects.
        //
        // With an output operand it is NOT a no-op, and generalising to "empty template = nothing"
        // was wrong: a tied constraint carries a value through the shared register even with an
        // empty template, so `asm ("" : "=r" (i) : "0" (x))` copies x into i (gcc's 20030222-1.c).
        // Refusing is the honest answer until constraints are modelled.
        const outputs = (s.outputs ?? []).filter(o => o.expr);
        const inputs = (s.inputs ?? []).filter(o => o.expr);
        if (text === '') {
          /*
           * An empty template emits no instructions, so what it does is entirely in its CONSTRAINTS.
           *
           * A digit constraint on an input names the output it shares a register with, and with no
           * instructions in between the output simply ends up holding the input: `asm ("" : "=r"(i)
           * : "0"(x))` copies x into i. gcc's own 20030222-1.c and 990130-1.c are that and nothing
           * else -- they exist to stop the optimiser, and the value carried through the tie is the
           * whole observable effect.
           *
           * An output with no tie is left ALONE. gcc leaves whatever the register held, which is
           * undefined; keeping the variable's own value is the deterministic reading of that, and
           * inventing a number would be worse than either.
           *
           * Inputs are evaluated in order whether or not they are tied, being ordinary C expressions
           * that may have side effects -- 990130-1.c calls a function inside one.
           */
          /*
           * The OUTPUT lvalues are evaluated first, and exactly once. That is not tidiness: gcc's
           * 990130-1.c writes `asm("" : "+r"(*bar()))` and counts the calls to bar(), so an
           * implementation that only looks at inputs never calls it at all.
           */
          /* A constraint arrives as a STRING TOKEN, quotes and all -- `"0"`, not `0`. */
          const bare = (c) => String(c ?? '').replace(/^L?"|"$/g, '');
          const dests = outputs.map(op => ({
            place: this.#lvalPlace(op.expr),
            constraint: bare(op.constraint),
          }));
          const values = inputs.map(op => {
            const v = this.#rval(op.expr);
            const t = this.newTmp();
            this.#declareTmp(t);
            this.out.push(`${t}=${v.js};`);
            return { tmp: t, type: v.type, constraint: bare(op.constraint) };
          });
          for (let i = 0; i < values.length; i++) {
            const m = /^[%&]*(\d+)$/.exec(values[i].constraint);
            if (!m) continue;
            const d = dests[+m[1]];
            if (d) this.#storeAt(d.place, values[i].tmp, values[i].type);
          }
          return;
        }
        if (this.#gccAsmMoves(text, [...outputs, ...inputs])) return;
        return unsup('inline assembly');
      }
    }
    unsup(`statement '${s.n}'`);
  }

  /**
   * Evaluate an lvalue ONCE and keep where it lands, so a later store does not re-run the address.
   * `*bar()` must call bar exactly once however many times the place is written.
   */
  /**
   * GCC inline assembly, its smallest honest subset: AT&T `rdtsc` and `movl` from %eax or %edx into a
   * MEMORY operand ("m"). That is ET's unix_shared.c GetClockTicks -- rdtsc, then edx:eax stored into
   * two locals, both passed as "m" inputs and written anyway, as gcc lets them be. Any other template
   * is refused as before. Returns false, emitting nothing, when the template is outside the subset.
   */
  /*
   * Widened for MAME 0.34's two uses, still over EAX and EDX only:
   *
   *  - src/msdos/profiler.c: `pushl`/`popl` around rdtsc, and `movl %eax, _curr_cycles` -- a store
   *    to a C global by its ASSEMBLER name (DJGPP is COFF: a leading underscore), in a template
   *    with no operands, hence the single `%`.
   *  - src/msdos/osinline.h's vec_mult: `movl %1,%0 ; imull %2 ; movl %%edx,%%eax` with output
   *    "=&a" -- the high half of a signed 32x32 multiply. An operand whose constraint names a
   *    register class of one (a, d) IS that register; any other operand is read as a value, and a
   *    store to one needs "m".
   *
   * The registers are JavaScript temporaries, so a push/pop pair of the same register around the
   * code is the identity and emits nothing; an unbalanced one is refused.
   */
  #gccAsmMoves(text, operands) {
    const bare = (c) => String(c ?? '').replace(/^L?"|"$/g, '');
    const pinned = (n) => {
      const c = operands[n] ? bare(operands[n].constraint).replace(/[=+&%]/g, '') : null;
      return c === 'a' ? 'eax' : c === 'd' ? 'edx' : null;
    };
    // An operand as written: {reg}, {n} (a C operand), or {sym} (a global by assembler name).
    const operand = (s) => {
      let m = /^%%?(eax|edx)$/.exec(s);
      if (m) return { reg: m[1] };
      m = /^%(\d+)$/.exec(s);
      if (m && operands[+m[1]]) return pinned(+m[1]) ? { reg: pinned(+m[1]) } : { n: +m[1] };
      m = /^_([A-Za-z_]\w*)$/.exec(s);
      if (m && !operands.length && this.#knowsGlobal(m[1])) return { sym: m[1] };
      return null;
    };
    const plan = [], stack = [];
    // The template is the string token as written: its line breaks are still a backslash and an n.
    for (const l of text.replace(/\\[nt]/g, '\n').split(/[;\n]/).map((x) => x.trim()).filter(Boolean)) {
      if (l === 'rdtsc') { plan.push({ op: 'rdtsc' }); continue; }
      let m = /^(pushl|popl)\s+%%?(eax|edx)$/.exec(l);
      if (m) {
        if (m[1] === 'pushl') stack.push({ reg: m[2], at: plan.length });
        else {
          const top = stack.pop();
          if (!top || top.reg !== m[2]) return false;
          plan.push({ op: 'restore', reg: m[2], from: top });
        }
        continue;
      }
      m = /^imull\s+(\S+)$/.exec(l);
      if (m) {
        const by = operand(m[1]);
        if (!by || by.sym) return false;
        plan.push({ op: 'imul', by });
        continue;
      }
      m = /^movl\s+(\S+?)\s*,\s*(\S+)$/.exec(l);
      const src = m && operand(m[1]), dst = m && operand(m[2]);
      if (!src || !dst) return false;
      if (dst.n !== undefined && !/m/.test(bare(operands[dst.n].constraint))) return false;
      if (!src.reg && !dst.reg) return false;                 // memory to memory is not an instruction
      plan.push({ op: 'mov', src, dst });
    }
    if (!plan.length || stack.length) return false;
    const reg = { eax: this.newTmp(), edx: this.newTmp() };
    this.#declareTmp(reg.eax); this.#declareTmp(reg.edx);
    this.out.push(`${reg.eax}=0;${reg.edx}=0;`);
    // What a register held when it was pushed, for the pop that brings it back.
    for (const p of plan) if (p.op === 'restore') { p.from.t = this.newTmp(); this.#declareTmp(p.from.t); }
    const saves = plan.filter((p) => p.op === 'restore').map((p) => p.from);
    // Operands read as values are evaluated once, up front, as gcc loads them before the template.
    const value = new Map();
    const read = (o) => {
      if (o.reg) return reg[o.reg];
      if (o.sym) return this.#rval({ n: 'ident', name: o.sym }).js;
      if (!value.has(o.n)) {
        const v = this.#rval(operands[o.n].expr);
        const t = this.newTmp();
        this.#declareTmp(t);
        this.out.push(`${t}=${coerce(this.ty, v.js, v.type, this.ty.INT)};`);
        value.set(o.n, t);
      }
      return value.get(o.n);
    };
    for (const p of plan) for (const o of [p.src, p.by]) if (o && o.n !== undefined) read(o);
    plan.forEach((p, i) => {
      for (const s of saves) if (s.at === i) this.out.push(`${s.t}=${reg[s.reg]};`);
      if (p.op === 'rdtsc') {
        this.out.push(`{const _t=M.rt.__prism_rdtsc();${reg.eax}=Number(_t&0xffffffffn)>>>0;${reg.edx}=Number(_t>>32n&0xffffffffn)>>>0;}`);
      } else if (p.op === 'restore') {
        this.out.push(`${reg[p.reg]}=${p.from.t};`);
      } else if (p.op === 'imul') {
        this.out.push(`{const _p=BigInt(${reg.eax}|0)*BigInt(${read(p.by)}|0);${reg.eax}=Number(BigInt.asUintN(32,_p));${reg.edx}=Number(BigInt.asUintN(32,_p>>32n));}`);
      } else if (p.dst.reg) {
        this.out.push(`${reg[p.dst.reg]}=${read(p.src)}>>>0;`);
      } else {
        const e = p.dst.sym ? { n: 'ident', name: p.dst.sym } : operands[p.dst.n].expr;
        this.#storeAt(this.#lvalPlace(e), reg[p.src.reg], this.ty.UINT);
      }
    });
    // An OUTPUT pinned to a register receives what the register holds when the template ends.
    operands.forEach((op, n) => {
      if (/^[=+]/.test(bare(op.constraint)) && pinned(n)) {
        this.#storeAt(this.#lvalPlace(op.expr), reg[pinned(n)], this.ty.UINT);
      }
    });
    return true;
  }

  /** Whether `name` is an object the function can see: a local pinned as a global, or a global. */
  #knowsGlobal(name) {
    const l = this.locals.get(name);
    return (l && l.kind === 'global') || this.ctx.globals.has(name);
  }

  #lvalPlace(e) {
    const l = this.#lval(e);
    if (l.varJs) return { varJs: l.varJs, type: l.type };
    const t = this.newTmp();
    this.#declareTmp(t);
    this.out.push(`${t}=${l.addr};`);
    return { addr: t, type: l.type, bitfield: l.bitfield };
  }

  /** Store an already-computed JS value into a place from #lvalPlace. */
  #storeAt(place, js, fromType) {
    if (!place) return;
    if (place.bitfield) { this.#initBitfield(place.addr, place.bitfield, js); return; }
    const v = coerce(this.ty, js, fromType ?? place.type, place.type);
    if (place.varJs) { this.out.push(`${place.varJs}=${v};`); return; }
    this.out.push(storeExpr(place.addr, place.type, v) + ';');
  }

  #truth(e) {
    const v = this.#rval(e);
    // A complex value is true when EITHER half is non-zero.
    if (T.isComplex(this.ty.decay(v.type ?? this.ty.INT))) {
      const p = this.#cxParts(v, v.type.complexOf);
      return `(${p.pin},((${p.re})!==0||(${p.im})!==0))`;
    }
    // A BigInt is never `!== 0` in the Number sense — the comparison has to use 0n.
    return is64(this.ty.decay(v.type ?? this.ty.INT)) ? `(${v.js})!==0n` : `(${v.js})!==0`;
  }

  // ------------------------------------------------------------- expressions

  /** An lvalue: an address expression plus its type. */
  /** What src/asm/borland.js needs from this function: its names, and its memory. */
  #asmEnv() {
    const U = { 1: this.ty.UCHAR, 2: this.ty.USHORT, 4: this.ty.ULONG };
    const nearOf = (a) => (a >= 0 && a < 0x10000 ? a : null);
    return this._asmEnv ??= {
      symbol: (name) => {
        const l = this.locals.get(name);
        if (l) {
          if (l.kind === 'slot') return { addr: `(_fp+${l.off}|0)`, type: l.type, local: true, near: 0 };
          if (l.kind === 'global') return { addr: String(l.addr), type: l.type, local: false, near: nearOf(l.addr) };
          throw new BorlandAsmError(`the local '${name}', which has no stack slot`);
        }
        const g = this.ctx.globals.get(name);
        if (g) return { addr: String(g.addr), type: g.type, local: false, near: nearOf(g.addr) };
        if (this.ctx.funcs.get(name)) return { isFunc: true };
        throw new BorlandAsmError(`'${name}', which is not a variable in scope`);
      },
      load: (addr, size) => loadExpr(addr, U[size]),
      store: (addr, size, v) => storeExpr(addr, U[size], v),
      /*
       * `OFFSET local` in Borland inline assembly is the local's displacement from BP in BORLAND's
       * frame -- measured: `char emmname[9]` alone in its function gives DX = -10, not the address
       * (goldens/borland-offset.json). PRISM's frame is its own, so the displacement is answered only
       * where Borland's layout is known from measurement: the function's ONLY automatic, an array, a
       * struct or a four-byte scalar at -(size rounded to a word), a char at -1. Anything else --
       * a second local, an int that Borland may keep in SI -- returns null and stays refused.
       */
      borlandFrameOffset: (name) => {
        const autos = [];
        collectAutos(this.decl.body, autos);
        if (autos.length !== 1 || autos[0].name !== name) return null;
        const t = autos[0].type;
        if (t.k === 'array' || T.isRecord(t) || t.size === 4) return -(Math.ceil(t.size / 2) * 2);
        if (t.size === 1 && T.isInteger(t)) return -1;
        return null;
      },
    };
  }

  /** Falling off the end after an asm statement returns AX -- DX:AX for four bytes -- as Borland does. */
  #axReturn(t) {
    if (T.isInteger(t) && !is64(t) && t.size <= 2) {
      const sh = 32 - t.size * 8;
      return t.signed ? `(($r.ax<<${sh})>>${sh})` : `($r.ax&${t.size === 1 ? 255 : 65535})`;
    }
    if (T.isInteger(t) && !is64(t) && t.size === 4) return t.signed ? '(($r.dx<<16)|$r.ax)' : '((($r.dx<<16)|$r.ax)>>>0)';
    if (t.k === 'ptr' && t.size === 2) return '$r.ax';
    return unsup(`Borland inline assembly returning a ${T.typeName(t)} in registers`);
  }

  #lval(e) {
    switch (e.n) {
      case 'ident': {
        const l = this.locals.get(e.name);
        if (l) {
          if (l.kind === 'slot') return { addr: `(_fp+${l.off}|0)`, type: l.type };
          if (l.kind === 'global') return { addr: String(l.addr), type: l.type };
          if (l.kind === 'aggparam') return { addr: `(${l.js}|0)`, type: l.type };
          return { varJs: l.js, type: l.type };
        }
        /*
         * Not ours: it may be the ENCLOSING function's, reached through the static link. A slot
         * there is at the same offset in the frame `_up` points at; a JS variable there is
         * unreachable, which is why every name a nested function mentions was pinned to a slot.
         */
        if (this.parent) {
          const up = (this.ctx.parentScope ?? this.parent.locals).get(e.name);
          if (up) {
            if (up.kind === 'slot') return { addr: `(_up+${up.off}|0)`, type: up.type };
            if (up.kind === 'global') return { addr: String(up.addr), type: up.type };
            if (up.kind === 'aggparam') unsup(`the enclosing function's '${e.name}'`);
          }
        }
        const g = this.ctx.globals.get(e.name);
        if (g) return { addr: String(g.addr), type: g.type };
        const f = this.ctx.funcs.get(e.name);
        if (f) { this.#noteBuiltinRef(e.name, f); return { addr: String(f.addr), type: f.type, isFunc: true }; }
        // A library function named as a VALUE rather than called: `fp = puts`, `&puts`.
        const b = this.ctx.builtins?.get(e.name);
        if (b) {
          const addr = this.#builtinAddr(e.name);
          if (addr !== null) return { addr: String(addr), type: T.func(b.ret ?? this.ty.INT, []), isFunc: true };
        }
        /*
         * `__func__` is not a variable a program declares -- C99 6.4.2.2 says the compiler provides
         * it, as a static array holding the function's name. gcc's `__FUNCTION__` is the same thing
         * spelled older, and `__PRETTY_FUNCTION__` is too in C.
         */
        /*
         * Borland's pseudo-registers: `_AX = 3; geninterrupt(0x10);`. A name of the register file,
         * unsigned int for a word and unsigned char for a byte, as Borland types them. Only where the
         * program has not declared the name itself.
         */
        if (this.isPseudo?.(e.name)) {
          const r = PSEUDO.get(e.name);
          return { varJs: `$r.${r.acc}`, type: r.size === 2 ? this.ty.UINT : this.ty.UCHAR };
        }
        if (PSEUDO_REFUSED.has(e.name) && ['dos16', 'dos16m', 'dos16l'].includes(this.ctx.model ?? 'i386')) {
          unsup(`the pseudo-register ${e.name}, ${PSEUDO_REFUSED.get(e.name)}`);
        }
        if (/^(__func__|__FUNCTION__|__PRETTY_FUNCTION__)$/.test(e.name)) {
          const bytes = [...this.decl.name].map(c => c.charCodeAt(0) & 0xff);
          return { addr: String(this.mod.intern(bytes)), type: T.array(this.ty.CHAR, bytes.length + 1) };
        }
        throw new EmitError(`undeclared identifier '${e.name}'`);
      }
      /* `__real__ x = 5;` -- half of a complex object is an ordinary place. */
      case 'cxpart': {
        const base = this.#lval(e.expr);
        if (!T.isComplex(base.type)) unsup(`__real__/__imag__ of a ${T.typeName(base.type)}`);
        const of = base.type.complexOf;
        return { addr: e.part ? `(${base.addr}+${of.size}|0)` : base.addr, type: of };
      }
      case 'unary':
        if (e.op === '*') {
          const p = this.#rval(e.expr);
          const to = p.type.k === 'ptr' ? p.type.to : (p.type.k === 'array' ? p.type.of : null);
          if (!to) throw new EmitError('dereferencing a non-pointer');
          return { addr: `(${addrOfPtr(p.js, p.type)}|0)`, type: to };
        }
        break;
      case 'index': {
        const b = this.#rval(e.base);
        const i = this.#rval(e.index);
        const bt = this.ty.decay(b.type);
        if (bt.k !== 'ptr') throw new EmitError('subscripting a non-pointer');
        const es = bt.to.size ?? 1;
        return { addr: `(${addrOfPtr(b.js, bt)}+Math.imul(${indexJs(this.ty, i)},${es})|0)`, type: bt.to };
      }
      case 'member': {
        let recAddr, rec;
        if (e.arrow) {
          const p = this.#rval(e.base);
          rec = p.type.k === 'ptr' ? p.type.to : p.type;
          recAddr = `(${addrOfPtr(p.js, p.type)}|0)`;
        } else {
          const l = this.#lval(e.base);
          if (l.varJs) throw new EmitError('member access on a value with no address');
          rec = l.type;
          recAddr = l.addr;
        }
        const f = findField(rec, e.field);
        if (!f) {
          /*
           * What it DOES have, because the interesting case is never a typo -- it is a tag that
           * resolved to a different or an unfinished type, and the member list says which at a
           * glance instead of after an hour of reading headers.
           */
          const have = rec.complete === false ? '(incomplete)'
            : (rec.fields ?? []).map(x => x.name ?? '<anon>').join(' ') || '(no members)';
          throw new EmitError(`'${T.typeName(rec)}' has no member '${e.field}' -- it has: ${have}`);
        }
        if (f.bits !== undefined) return { addr: recAddr, type: f.type, bitfield: f };
        return { addr: `(${recAddr}+${f.offset}|0)`, type: f.type };
      }
      case 'str': {
        const addr = this.#stringAddr(e);
        return { addr: String(addr), type: e.type ?? T.array(this.ty.CHAR, null), isString: true };
      }
      case 'call': {
        // The call evaluates to the address of the sret buffer, so `f().field` and `x = f()` both
        // work — and it is evaluated exactly once, which is why the caller must not use this twice.
        const c = this.#rval(e);
        if (!T.isRecord(c.type)) throw new EmitError('a call returning a scalar is not an lvalue');
        return { addr: `(${c.js}|0)`, type: c.type };
      }
      /*
       * A struct-valued `?:` is not an lvalue in C, but tier-0 still needs an ADDRESS for it: struct
       * assignment copies from one. So materialise it — a slot in this frame, filled by whichever
       * branch runs, and the slot's address is the result.
       *
       * SQLite's generated parser writes exactly this shape, and refusing it left the entire SQL
       * parser unimplemented.
       */
      /*
       * A record-valued comma or assignment: `(a, s).f` and `(s = t).f` are both ordinary C, and
       * neither result is an lvalue -- but tier-0 needs an ADDRESS for a record all the same, for
       * exactly the reason the `cond` case below explains.
       *
       * Deliberately NOT the GNU lvalue extensions. `(a, b) = x` and `(a = b) = c` on scalars were
       * removed from gcc years ago and gcc 12 rejects them, so accepting them here would make PRISM
       * compile programs the reference will not -- a divergence in the direction no gate looks.
       * Restricting to records keeps this a tier-0 implementation detail rather than a dialect.
       */
      case 'comma': {
        // The parser leaves a comma's own type null, so the type is the RIGHT operand's.
        if (!T.isRecord(e.type ?? e.b?.type ?? this.ty.INT)) break;
        const left = this.#rval(e.a);
        const l = this.#lval(e.b);
        return { ...l, addr: `(${left.js},${l.addr})` };
      }
      case 'assign': {
        if (!T.isRecord(e.type ?? this.ty.INT)) break;
        const done = this.#rval(e);          // performs the assignment
        const l = this.#lval(e.lhs);         // then the object it wrote to
        return { ...l, addr: `(${done.js},${l.addr})` };
      }
      /*
       * A COMPOUND LITERAL, `(T){ ... }`. C99 6.5.2.5 makes it an lvalue with automatic storage and
       * the lifetime of the enclosing block, so a frame slot is not an implementation convenience --
       * it is the storage the standard describes.
       *
       * The initialisation is emitted IN PLACE, as a comma expression, rather than hoisted ahead of
       * the statement. That matters when the literal sits inside a branch or a `?:`: hoisting would
       * run its initialisers whether or not the branch is taken, and initialisers can have side
       * effects. OpenTyrian's file.c returns `(File){ f, errno, f == NULL }`, which reads errno.
       */
      case 'compound': {
        const t = e.type;
        if (!t || t.size == null) throw new EmitError('a compound literal of incomplete type');
        const off = this.slot(t.size, t.align);
        const at = `(_fp+${off}|0)`;
        const steps = this.#captureInit(at, t, e.init);
        return { addr: steps.length ? `(${steps.join(',')},${at})` : at, type: t };
      }
      /*
       * A record-valued statement expression. Same rule as the comma and the conditional above: the
       * result is not an lvalue, but a record travels as its address in tier-0, and `({...}).x` is
       * ordinary GNU C.
       */
      case 'stmtexpr': {
        if (!T.isRecord(e.type ?? this.ty.INT)) break;
        const v = this.#stmtExpr(e);
        return { addr: v.js, type: v.type };
      }
      case 'cond': {
        if (!T.isRecord(e.type ?? this.ty.INT)) break;
        const off = this.slot(e.type.size, e.type.align);
        const at = `(_fp+${off}|0)`;
        const a2 = this.#lval(e.then ?? e.cond);
        const b2 = this.#lval(e.els);
        return {
          addr: `(${this.#truth(e.cond)}?M.copy(${at},${a2.addr},${e.type.size}):` +
            `M.copy(${at},${b2.addr},${e.type.size}),${at})`,
          type: e.type,
        };
      }
    }
    /*
     * A CAST AS AN LVALUE, Borland's extension (and gcc's before 4.0): `(long)pcSound = 0;`
     * (id_sd.c), `*((char far *)*(char far **)outfile)++ = data;` (jam_io.c). It means
     * `*(T *)&obj` -- the object's own bytes, read and written as T -- so it is allowed only where
     * that says something: an integer, enum or pointer of the SAME size, and refused by name
     * otherwise. A local under such a cast is pinned to memory (collectAddressTaken), so the bytes
     * exist. Under PRISM's linear far pointers, `(long)farptr` read this way is the same number the
     * rvalue cast gives, which keeps the two consistent.
     */
    if (e.n === 'cast') {
      const inner = this.#lval(e.expr);
      const to = e.type, from = inner.type;
      const scalar = (t) => t && (T.isInteger(t) || t.k === 'enum' || t.k === 'ptr');
      if (inner.bitfield || !scalar(to) || !scalar(from)) {
        unsup(`a cast as an lvalue from ${T.typeName(from)} to ${T.typeName(to)}`);
      }
      if (to.size !== from.size) {
        unsup(`a cast as an lvalue from ${T.typeName(from)} to ${T.typeName(to)}, which differ in size`);
      }
      if (inner.varJs) throw new EmitError('internal: a cast lvalue on a variable that was not given a slot');
      return { ...inner, type: to };
    }
    /*
     * A COMPLEX value that is not a place -- `f(z * w)`, `return z + 1.0`, `(_Complex double)1` --
     * still has an address, because that is how a complex value travels here. Every caller that
     * asks for an lvalue wants somewhere to copy FROM, and this is it.
     */
    if (T.isComplex(e.type ?? this.ty.INT)) {
      const v = this.#rval(e);
      return { addr: v.js, type: v.type };
    }
    /*
     * An AST node name and nothing else is not a diagnostic. `'bin' is not an lvalue` sent me
     * reading a whole file for a variable called bin; the loc every node already carries says which
     * line, and the operator says which expression.
     */
    const where = e.loc ? ` at ${e.loc.file}:${e.loc.line}` : '';
    throw new EmitError(`'${e.n}'${e.op ? ` (${e.op})` : ''} is not an lvalue${where}`);
  }

  /*
   * A safepoint on a loop's back edge.
   *
   * This is the one thing that makes a loop in pure guest C observable. Neither profiler can see one:
   * a program spinning in its own code calls no runtime service and crosses no unit boundary, so
   * there is nothing to count. A check here is the only place the host can regain control.
   *
   * It is off by default and it is not free — a decrement and a compare on every iteration of every
   * loop, which is exactly the cost MIRAGE measured when it studied this. Emitting it as a budget
   * rather than a call keeps the common case to two operations and never leaves the loop.
   *
   * The general form of this is what would let Stop interrupt a `while (1);` — the same mechanism,
   * a different handler.
   */
  #safepoint() {
    if (!this.ctx.safepoints) return '';
    const id = this.mod.safepoints.length;
    this.mod.safepoints.push(`${this.decl.name}#${this.mod.safepoints.length}`);
    // A function with a register file hands it over: an interrupt delivered here gives its handler
    // the registers this code holds (src/env/pcirq.js).
    return `if(--M.spBudget<0)M.sp_(${id}${this.usesRegs ? ',$r' : ''});`;
  }

  #stringAddr(e) {
    // `L"a" "b"` is ONE wide string: the wideness of the concatenation is decided first, and every
    // part is then encoded at that width. Encoding each part at its own width put a 1-byte 'b' after
    // a 4-byte 'a' (20010325-1.c).
    const wide = e.parts.some(p => isWideLiteral(p.v));
    const bytes = [];
    for (const part of e.parts) bytes.push(...literalBytes(part.v, wide).bytes);
    // Module.intern appends ONE NUL byte; a wide string needs a full 4-byte terminator.
    for (let k = 1; k < (wide ? 4 : 1); k++) bytes.push(0);
    return this.mod.intern(bytes);
  }

  /** An rvalue: a JS expression plus its C type. */
  #rval(e) {
    switch (e.n) {
      // The mask must follow the literal's SIGNEDNESS: asIntN on `18446744073709551615ULL` gives
      // -1n, and `(double)` of that is -1 (gcc's 920710-1.c).
      case 'num': return is64(e.type)
        ? { js: `${e.type.signed ? BigInt.asIntN(64, e.value) : BigInt.asUintN(64, e.value)}n`, type: e.type }
        : { js: String(BigInt.asIntN(32, e.value)), type: e.type };
      case 'char': return { js: String(Number(e.value)), type: this.ty.INT };
      /*
       * offsetof is a constant, and constEval already knows how to walk the member path — including
       * through arrays and nested structs. It reached the emitter unhandled only because nothing had
       * used it in an ordinary expression before; SQLite uses it in 38 functions.
       */
      case 'offsetof': return { js: String(constEval(e)), type: this.ty.UINT };
      case 'float': return { js: e.type.name === 'float' ? `Math.fround(${e.value})` : String(e.value), type: e.type };
      // The element type comes from the literal, not from `char`: indexing `L"ab"` must read a
      // wchar_t. Hardcoding char here made `L"a" "b"[1]` read one byte (20010325-1.c).
      case 'str': return { js: String(this.#stringAddr(e)), type: this.ty.ptr(e.type?.of ?? this.ty.CHAR) };

      case 'ident': {
        const l = this.#lval(e);
        if (l.isFunc) return { js: l.addr, type: this.ty.ptr(l.type) };
        if (l.varJs) return { js: l.varJs, type: l.type };
        if (l.type.k === 'array') return { js: l.addr, type: this.ty.ptr(l.type.of) };
        if (l.type.k === 'func') return { js: l.addr, type: this.ty.ptr(l.type) };
        // A struct's "value" in tier-0 IS its address, exactly as an array's is: every legal
        // consumer of a struct rvalue -- assignment, an argument, a return, a member access,
        // sizeof -- wants the address and copies from it. Refusing here made `(void)tok;` fail,
        // which SQLite's generated parser writes to silence an unused-parameter warning.
        if (T.isRecord(l.type)) return { js: l.addr, type: l.type };
      return { js: loadExpr(l.addr, l.type), type: l.type };
      }

      case 'index': case 'member': {
        const l = this.#lval(e);
        // A bitfield read undergoes the INTEGER PROMOTIONS, and the promoted type is not the
        // declared one: `unsigned int u:7` becomes `int`, because an int represents every value a
        // 7-bit unsigned field can hold. Returning the declared type made `bit.u % 61` unsigned and
        // gcc's bitfld-1.c exists precisely to catch that.
        if (l.bitfield) return { js: this.#loadBitfield(l), type: bitfieldPromoted(this.ty, l.bitfield) };
        if (l.type.k === 'array') return { js: l.addr, type: this.ty.ptr(l.type.of) };
        if (T.isRecord(l.type)) return { js: l.addr, type: l.type };
        return { js: loadExpr(l.addr, l.type), type: l.type };
      }

      case 'unary': return this.#unary(e);
      case 'bin': return this.#binary(e);
      case 'assign': return this.#assign(e);
      case 'cast': {
        const v = this.#rval(e.expr);
        if (e.type.k === 'void') return { js: `(${v.js},0)`, type: T.VOID };
        if (T.isComplex(e.type) || T.isComplex(v.type)) return this.#cxConvert(v, e.type);
        return { js: coerce(this.ty, v.js, this.ty.decay(v.type), e.type), type: e.type };
      }
      case 'cond': {
        const c = this.#truth(e.cond);
        const a = e.then ? this.#rval(e.then) : null;
        const b = this.#rval(e.els);
        const type = a ? unifyCond(this.ty, a.type, b.type) : b.type;
        if (!a) { const t = this.newTmp(); return { js: `((${t}=${this.#rval(e.cond).js}),${t}!==0?${t}:${b.js})`, type, needsTmp: t }; }
        return { js: `(${c}?${coerceTo(this.ty, a, type)}:${coerceTo(this.ty, b, type)})`, type };
      }
      case 'comma': {
        const a = this.#rval(e.a), b = this.#rval(e.b);
        return { js: `(${a.js},${b.js})`, type: b.type };
      }
      case 'call': return this.#call(e);
      case 'preinc': case 'postinc': return this.#incdec(e);
      case 'labeladdr': {
        const k = this.labels?.index.get(e.name);
        if (k === undefined) unsup(`the address of label '${e.name}'`);
        return { js: String(k), type: this.ty.ptr(T.VOID) };
      }
      // `2.0i`: the constant IS the imaginary half.
      case 'imaginary':
        return this.#cxMake(e.type, T.isFloat(e.type.complexOf) ? '0' : '0', String(e.value));
      case 'cxpart': {
        const v = this.#rval(e.expr);
        if (!T.isComplex(v.type)) {
          // On a real operand: __real__ is the value, __imag__ is a zero of the same type.
          return e.part === 0 ? v : { js: `(${v.js},0)`, type: this.ty.decay(v.type) };
        }
        const of = v.type.complexOf;
        const t = this.newTmp(); this.#declareTmp(t);
        return { js: `(${t}=${v.js},${loadExpr(e.part ? `(${t}+${of.size}|0)` : t, of)})`, type: of };
      }
      case 'asmcc': return { js: `(${e.js}?1:0)`, type: this.ty.INT };
      case 'sizeoftype': return { js: String(e.target.size), type: this.ty.UINT };
      case 'sizeofexpr': {
        const t = e.expr.type;
        if (!t || t.size == null) throw new EmitError('sizeof an expression of unknown type');
        return { js: String(t.size), type: this.ty.UINT };
      }
      case 'alignoftype': return { js: String(e.target.align), type: this.ty.UINT };
      // `__alignof__ x` -- the alignment of the EXPRESSION's type, and like sizeof it does not
      // evaluate x.
      case 'alignofexpr': {
        const t = e.expr?.type;
        // A FUNCTION has no alignment here: its address is a table index, so `__alignof__(func)`
        // could only ever be a plausible-looking wrong number (gcc's align-3.c asks for 256).
        if (t?.k === 'func') unsup('__alignof__ of a function');
        if (!t || t.align == null) throw new EmitError('__alignof__ of an expression of unknown type');
        return { js: String(t.align), type: this.ty.UINT };
      }
      /*
       * As an rvalue. A record IS its address here -- that is how every record-valued expression
       * travels in tier-0, and it is what lets `return (File){...}` reach the sret buffer. A scalar
       * compound literal, `(int){3}`, is read back out of its slot.
       */
      case 'compound': {
        const l = this.#lval(e);
        if (T.isRecord(l.type) || l.type.k === 'array') return { js: l.addr, type: l.type };
        return { js: loadExpr(l.addr, l.type), type: l.type };
      }
      case 'stmtexpr': return this.#stmtExpr(e);
      case 'offsetof':
        return unsup(`'${e.n}'`);
    }
    throw new EmitError(`cannot emit expression '${e.n}'`);
  }

  #unary(e) {
    if (e.op === '&') {
      const l = this.#lval(e.expr);
      if (l.varJs) throw new EmitError(`internal: '&' on a variable that was not given a slot`);
      return { js: l.addr, type: this.ty.ptr(l.type) };
    }
    if (e.op === '*') {
      const l = this.#lval(e);
      if (l.type.k === 'array') return { js: l.addr, type: this.ty.ptr(l.type.of) };
      if (l.type.k === 'func') return { js: l.addr, type: this.ty.ptr(l.type) };
      // A record rvalue IS its address in tier-0, the same rule as an array's -- and `*p` on a
      // struct or union pointer is a place that rule was missing. csmith reaches it constantly
      // because it passes unions by value through pointers; the two sibling sites above already
      // had the guard.
      if (T.isRecord(l.type)) return { js: l.addr, type: l.type };
      return { js: loadExpr(l.addr, l.type), type: l.type };
    }
    const v = this.#rval(e.expr);
    if (T.isComplex(this.ty.decay(v.type))) {
      // `-z` negates both halves; `~z` is the CONJUGATE, which is what gcc makes it mean on a
      // complex value rather than a bitwise complement.
      const of = v.type.complexOf;
      const p = this.#cxParts(v, of);
      if (e.op === '+') return { js: `(${p.pin},${this.#cxMake(v.type, p.re, p.im).js})`, type: v.type };
      if (e.op === '-') return { js: `(${p.pin},${this.#cxMake(v.type, `-(${p.re})`, `-(${p.im})`).js})`, type: v.type };
      if (e.op === '~') return { js: `(${p.pin},${this.#cxMake(v.type, p.re, `-(${p.im})`).js})`, type: v.type };
      if (e.op === '!') return { js: `(${p.pin},((${p.re})===0&&(${p.im})===0)?1:0)`, type: this.ty.INT };
      unsup(`unary '${e.op}' on a complex value`);
    }
    const t = this.ty.promote(this.ty.decay(v.type));
    const V = coerce(this.ty, v.js, this.ty.decay(v.type), t);
    if (is64(t)) {
      switch (e.op) {
        case '+': return { js: V, type: t };
        case '-': return { js: mask64(`-(${V})`, t), type: t };
        case '~': return { js: mask64(`~(${V})`, t), type: t };
        case '!': return { js: `((${V})===0n?1:0)`, type: this.ty.INT };
      }
    }
    switch (e.op) {
      case '+': return { js: V, type: t };
      case '-': return T.isFloat(t) ? { js: `(-(${v.js}))`, type: t } : { js: fitInt(this.ty, `((0-(${v.js}))|0)`, t), type: t };
      case '~': return { js: fitInt(this.ty, `(~(${v.js}))`, t), type: t };
      case '!': return { js: `((${v.js})===0?1:0)`, type: this.ty.INT };
    }
    throw new EmitError(`unary '${e.op}'`);
  }

  #binary(e) {
    const op = e.op;
    /*
     * && and || FIRST, before either operand is emitted as a value. They used to come after
     * `#rval(e.a), #rval(e.b)`, whose results they never used: every operand was emitted twice,
     * once to be thrown away and once through #truth, so a chain of n of them cost 2^n. MAME
     * 0.37b5's fronthlp.c tests its command line with one `||` of several dozen strcmp's, and the
     * build did not end. Emitted once now -- which is also the only number of times an operand
     * that hoists a statement may be emitted.
     */
    if (op === '&&') return { js: `((${this.#truth(e.a)}&&${this.#truth(e.b)})?1:0)`, type: this.ty.INT };
    if (op === '||') return { js: `((${this.#truth(e.a)}||${this.#truth(e.b)})?1:0)`, type: this.ty.INT };
    let a = this.#rval(e.a), b = this.#rval(e.b);
    let at = this.ty.decay(a.type), bt = this.ty.decay(b.type);

    // Complex arithmetic works on the halves, so it cannot share the scalar paths below.
    if (T.isComplex(at) || T.isComplex(bt)) {
      if (op === '==' || op === '!=') return this.#cxCompare(a, b, op);
      return this.#cxBinary(a, b, op);
    }

    /*
     * A _seg pointer plus or minus an integer is Borland's one arithmetic on it, and its result is a
     * FAR pointer, seg:n*sizeof -- `map = mapsegs[0]+offset` is how Keen Dreams reaches a map cell.
     * So the paragraph becomes its address and the rest is ordinary far arithmetic. The difference of
     * two _seg pointers is not given a meaning here, and nothing in the corpus takes one.
     */
    if (isSeg(at) && isSeg(bt) && op === '-') unsup('arithmetic on a _seg pointer');
    if (isSeg(at) && T.isInteger(bt) && (op === '+' || op === '-')) {
      a = { js: addrOfPtr(a.js, at), type: at = this.ty.ptr(at.to, 'far') };
    } else if (isSeg(bt) && T.isInteger(at) && op === '+') {
      b = { js: addrOfPtr(b.js, bt), type: bt = this.ty.ptr(bt.to, 'far') };
    }
    // Pointer arithmetic scales by the pointee, and p - q divides by it.
    if (at.k === 'ptr' && T.isInteger(bt) && (op === '+' || op === '-')) {
      const s = at.to.size ?? 1;
      return { js: `((${a.js})${op}Math.imul(${indexJs(this.ty, b)},${s})|0)`, type: at };
    }
    if (bt.k === 'ptr' && T.isInteger(at) && op === '+') {
      const s = bt.to.size ?? 1;
      return { js: `((${b.js})+Math.imul(${indexJs(this.ty, a)},${s})|0)`, type: bt };
    }
    if (at.k === 'ptr' && bt.k === 'ptr' && op === '-') {
      const s = at.to.size ?? 1;
      // ptrdiff_t: a LONG between huge pointers, whose distance can pass 64K; an int otherwise --
      // two bytes under a 16-bit model (Watcom -mm: sizeof(hp - hp) 4, fp - fp and np - np 2).
      const d = (at.qual === 'huge' || bt.qual === 'huge') ? this.ty.LONG : this.ty.INT;
      return { js: fitInt(this.ty, `((((${a.js})-(${b.js}))|0)/${s}|0)`, d), type: d };
    }

    const CMP = { '==': '===', '!=': '!==', '<': '<', '>': '>', '<=': '<=', '>=': '>=' };
    if (op in CMP) {
      // A _seg pointer against another KIND of pointer compares addresses, so the paragraph is scaled;
      // against a _seg pointer or against 0 both sides are already paragraphs.
      if (isSeg(at) && bt.k === 'ptr' && !isSeg(bt)) a = { js: addrOfPtr(a.js, at), type: at };
      if (isSeg(bt) && at.k === 'ptr' && !isSeg(at)) b = { js: addrOfPtr(b.js, bt), type: bt };
      if (at.k === 'ptr' || bt.k === 'ptr') {
        return { js: `(((${a.js})>>>0)${CMP[op]}((${b.js})>>>0)?1:0)`, type: this.ty.INT };
      }
      const c = this.ty.usualArith(at, bt);
      const A = coerce(this.ty, a.js, at, c), B = coerce(this.ty, b.js, bt, c);
      if (T.isFloat(c)) return { js: `((${A})${CMP[op]}(${B})?1:0)`, type: this.ty.INT };
      // Both sides are already masked to the same 64-bit signedness, so a plain BigInt comparison
      // is correct — `>>>0` would throw on a BigInt.
      if (is64(c)) return { js: `((${A})${CMP[op]}(${B})?1:0)`, type: this.ty.INT };
      if (T.isUnsigned(c)) return { js: `(((${A})>>>0)${CMP[op]}((${B})>>>0)?1:0)`, type: this.ty.INT };
      return { js: `((${A})${CMP[op]}(${B})?1:0)`, type: this.ty.INT };
    }

    if (op === '<<' || op === '>>') {
      const t = this.ty.promote(at);
      const A = coerce(this.ty, a.js, at, t);
      if (is64(t)) {
        // The count is an ordinary integer and must be converted; the result is masked back to 64.
        const shb = `BigInt(${coerce(this.ty, b.js, bt, this.ty.INT)}&63)`;
        return { js: mask64(`((${A})${op === '<<' ? '<<' : '>>'}${shb})`, t), type: t };
      }
      // The COUNT is converted on its own -- a shift has no common type, C99 6.5.7p3 -- so a 64-bit
      // count on a 32-bit value becomes an ordinary number. Left as a BigInt, `&31` threw
      // "Cannot mix BigInt and other types" out of `(unsigned)a >> 3ULL` (gcc's pr82192.c).
      const sh = `((${coerce(this.ty, b.js, bt, this.ty.INT)})&31)`;
      if (op === '<<') return { js: fitInt(this.ty, `((${A})<<${sh})`, t), type: t };
      return { js: fitInt(this.ty, T.isUnsigned(t) ? `((${A})>>>${sh})` : `((${A})>>${sh})`, t), type: t };
    }

    const c = this.ty.usualArith(at, bt);
    const A = coerce(this.ty, a.js, at, c), B = coerce(this.ty, b.js, bt, c);
    if (T.isFloat(c)) {
      const raw = `((${A})${op}(${B}))`;
      return { js: c.name === 'float' ? `Math.fround(${raw})` : raw, type: c };
    }
    if (is64(c)) return { js: bin64(op, A, B, c), type: c };
    const u = T.isUnsigned(c);
    const fit = (js) => ({ js: fitInt(this.ty, js, c), type: c });
    switch (op) {
      case '+': return fit(`((${A})+(${B})|0)`);
      case '-': return fit(`((${A})-(${B})|0)`);
      case '*': return fit(`Math.imul(${A},${B})`);
      case '/': return fit(u ? `((((${A})>>>0)/((${B})>>>0))|0)` : `(((${A})/(${B}))|0)`);
      case '%': return fit(u ? `((((${A})>>>0)%((${B})>>>0))|0)` : `(((${A})%(${B}))|0)`);
      case '&': return fit(`((${A})&(${B}))`);
      case '|': return fit(`((${A})|(${B}))`);
      case '^': return fit(`((${A})^(${B}))`);
    }
    throw new EmitError(`binary '${op}'`);
  }

  #assign(e) {
    const l = this.#lval(e.lhs);
    if (l.bitfield) return this.#assignBitfield(l, e);
    const rhsType = l.type;

    if (e.op === '=') {
      if (T.isComplex(rhsType)) {
        const v = this.#cxConvert(this.#rval(e.rhs), rhsType);
        return { js: `M.copy(${l.addr},${v.js},${rhsType.size})`, type: rhsType };
      }
      if (T.isRecord(rhsType) || rhsType.k === 'array') {
        // Struct assignment is a byte copy; C allows it and game code uses it constantly.
        const r = this.#lval(e.rhs);
        return { js: `M.copy(${l.addr},${r.addr},${rhsType.size})`, type: rhsType };
      }
      const v = this.#rvalCoerced(e.rhs, rhsType);
      if (l.varJs) return { js: `(${l.varJs}=${v})`, type: rhsType };
      const t = this.newTmp();
      this.#declareTmp(t);
      return { js: `(${t}=${v},${storeExpr(l.addr, rhsType, t)},${t})`, type: rhsType };
    }

    /*
     * Compound assignment. The right-hand side is evaluated BEFORE the lvalue is read, which is what
     * gcc does and what real code depends on: MAME's Z80 core writes
     *
     *     R.PC.W.l += (offset)M_RDMEM_OPCODE();
     *
     * where the callee increments PC. Reading the lvalue first makes every relative jump one byte
     * short — DJNZ landed at 0x2310 instead of 0x2311, which is how Pac-Man never got past its
     * init. C leaves the order unspecified, so both are conforming; only one of them runs the code
     * this project exists to run.
     */
    const op = e.op.slice(0, -1);
    const rv = this.#rval(e.rhs);
    const rt = this.newTmp(); this.#declareTmp(rt);
    const rhsVal = { js: rt, type: rv.type };

    /*
     * `z += w` on a complex object. The result is a fresh complex value, so the assignment is the
     * COPY back into the object -- not a store, which is what the scalar path below would emit.
     */
    if (T.isComplex(rhsType)) {
      const at = this.newTmp(); this.#declareTmp(at);
      const combined = this.#cxBinary({ js: at, type: l.type }, rhsVal, op);
      const back = this.#cxConvert(combined, rhsType);
      return {
        js: `(${at}=${l.addr},${rt}=${rv.js},M.copy(${at},${back.js},${rhsType.size}),${at})`,
        type: rhsType,
      };
    }

    if (l.varJs) {
      const combined = this.#binaryWithValue({ js: l.varJs, type: l.type }, rhsVal, op);
      return {
        js: `(${rt}=${rv.js},${l.varJs}=${coerce(this.ty, combined.js, combined.type, rhsType)})`,
        type: rhsType,
      };
    }
    const at = this.newTmp(); this.#declareTmp(at);
    const t = this.newTmp(); this.#declareTmp(t);
    const combined = this.#binaryWithValue({ js: loadExpr(at, l.type), type: l.type }, rhsVal, op);
    // The address is computed once, before the right-hand side, so the lvalue is designated once.
    return {
      js: `(${at}=${l.addr},${rt}=${rv.js},${t}=${coerce(this.ty, combined.js, combined.type, rhsType)},` +
        `${storeExpr(at, rhsType, t)},${t})`,
      type: rhsType,
    };
  }

  /** Like #binary but with the left side already evaluated. */
  #binaryWith(a, rhsNode, op) {
    return this.#binaryWithValue(a, this.#rval(rhsNode), op);
  }

  /** Like #binaryWith but with BOTH sides already evaluated, so the caller controls the order. */
  #binaryWithValue(a, b, op) {
    const at = this.ty.decay(a.type), bt = this.ty.decay(b.type);
    if (T.isComplex(at) || T.isComplex(bt)) {
      if (op === '==' || op === '!=') return this.#cxCompare(a, b, op);
      return this.#cxBinary(a, b, op);
    }
    // ++, -- and += come through here, and their result would have to go back INTO the _seg pointer:
    // a far pointer at seg:n*sizeof is a paragraph again only when n*sizeof is a multiple of 16.
    if (isSeg(at) && (op === '+' || op === '-')) unsup('arithmetic on a _seg pointer');
    if (at.k === 'ptr' && T.isInteger(bt) && (op === '+' || op === '-')) {
      const s = at.to.size ?? 1;
      return { js: `((${a.js})${op}Math.imul(${indexJs(this.ty, b)},${s})|0)`, type: at };
    }
    if (op === '<<' || op === '>>') {
      const t = this.ty.promote(at);
      const A = coerce(this.ty, a.js, at, t);
      if (is64(t)) {
        const shb = `BigInt(${coerce(this.ty, b.js, bt, this.ty.INT)}&63)`;
        return { js: mask64(`((${A})${op}${shb})`, t), type: t };
      }
      const sh = `((${coerce(this.ty, b.js, bt, this.ty.INT)})&31)`;
      return { js: fitInt(this.ty, op === '<<' ? `((${A})<<${sh})` : (T.isUnsigned(t) ? `((${A})>>>${sh})` : `((${A})>>${sh})`), t), type: t };
    }
    const c = this.ty.usualArith(at, bt);
    const A = coerce(this.ty, a.js, at, c), B = coerce(this.ty, b.js, bt, c);
    if (T.isFloat(c)) {
      const raw = `((${A})${op}(${B}))`;
      return { js: c.name === 'float' ? `Math.fround(${raw})` : raw, type: c };
    }
    if (is64(c)) return { js: bin64(op, A, B, c), type: c };
    const u = T.isUnsigned(c);
    const table = {
      '+': `((${A})+(${B})|0)`, '-': `((${A})-(${B})|0)`, '*': `Math.imul(${A},${B})`,
      '/': u ? `((((${A})>>>0)/((${B})>>>0))|0)` : `(((${A})/(${B}))|0)`,
      '%': u ? `((((${A})>>>0)%((${B})>>>0))|0)` : `(((${A})%(${B}))|0)`,
      '&': `((${A})&(${B}))`, '|': `((${A})|(${B}))`, '^': `((${A})^(${B}))`,
    };
    if (!(op in table)) throw new EmitError(`compound operator '${op}='`);
    // Not fitted here: every caller converts the result to the lvalue's type, which truncates it.
    return { js: table[op], type: c };
  }

  #incdec(e) {
    const l = this.#lval(e.expr);
    if (l.bitfield) {
      // Read, adjust in the promoted type, store truncated, and yield the value that was STORED —
      // the same rule as a bitfield assignment, so `++m` on a `signed int m:11` wraps.
      const f = l.bitfield;
      const at = this.newTmp(); this.#declareTmp(at);
      const v = this.newTmp(); this.#declareTmp(v);
      const { unitOff, poke } = bitfieldPoke(f, at, v);
      const cur = this.#loadBitfield({ addr: l.addr, bitfield: f });
      const old = this.newTmp(); this.#declareTmp(old);
      const one = { n: 'num', value: 1n, type: this.ty.INT };
      const nv = coerce(this.ty, this.#binaryWith({ js: old, type: bitfieldPromoted(this.ty, f) }, one,
        e.op === '++' ? '+' : '-').js, bitfieldPromoted(this.ty, f), f.type);
      const readBack = this.#loadBitfield({ addr: l.addr, bitfield: f });
      return {
        js: `(${at}=(${l.addr}+${unitOff}|0),${old}=${cur},${v}=${nv},${poke},` +
          `${e.n === 'preinc' ? readBack : old})`,
        type: bitfieldPromoted(this.ty, f),
      };
    }
    const one = { n: 'num', value: 1n, type: this.ty.INT };
    const op = e.op === '++' ? '+' : '-';
    const cur = l.varJs ? { js: l.varJs, type: l.type } : null;

    if (l.varJs) {
      const nv = coerce(this.ty, this.#binaryWith(cur, one, op).js, l.type, l.type);
      if (e.n === 'preinc') return { js: `(${l.varJs}=${nv})`, type: l.type };
      const t = this.newTmp(); this.#declareTmp(t);
      return { js: `(${t}=${l.varJs},${l.varJs}=${nv},${t})`, type: l.type };
    }
    const at = this.newTmp(); this.#declareTmp(at);
    const old = this.newTmp(); this.#declareTmp(old);
    const loaded = loadExpr(at, l.type);
    const nv = coerce(this.ty, this.#binaryWith({ js: old, type: l.type }, one, op).js, l.type, l.type);
    if (e.n === 'preinc') {
      const nt = this.newTmp(); this.#declareTmp(nt);
      return { js: `(${at}=${l.addr},${old}=${loaded},${nt}=${nv},${storeExpr(at, l.type, nt)},${nt})`, type: l.type };
    }
    return { js: `(${at}=${l.addr},${old}=${loaded},${storeExpr(at, l.type, nv)},${old})`, type: l.type };
  }

  /*
   * A GNU statement expression, `({ ... })`. Its value is the last statement, and the last statement
   * is a STATEMENT -- so the thing JavaScript has no syntax for is exactly the thing this needs.
   *
   * It becomes an arrow function called on the spot. The obvious alternative, hoisting the body
   * ahead of the enclosing statement and leaving a temporary behind, is wrong wherever the
   * expression is not evaluated unconditionally: gcc's 950906-1.c puts one in a `while` condition,
   * where hoisting would run the body once instead of once per iteration, and `a ? ({...}) : b`
   * would run it even when the branch is not taken. An arrow evaluates where it is written.
   *
   * The body's locals are ordinary emitted `var`s, scoped to the arrow, and its frame slots are
   * this function's -- which is what 20020320-1.c checks by returning a struct from one statement
   * expression and reading it after a second one has run: slot offsets only grow, so the storage a
   * statement expression used is still there afterwards.
   *
   * A jump that LEAVES the body cannot be an arrow's: `return` would return from the arrow, and
   * `break`/`continue`/`goto` have no target across a function boundary. Each is refused by name.
   */
  #stmtExpr(e) {
    escapingJump(e.body);
    const outer = this.out;
    this.out = [];
    let value = null;
    try {
      this.#scoped(() => {
        const items = e.body.items;
        for (let i = 0; i < items.length; i++) {
          const tail = i === items.length - 1;
          if (tail && items[i].n === 'exprstmt') {
            value = this.#rval(items[i].expr);
            this.out.push(`return ${value.js};`);
          } else this.#item(items[i], this.escaped);
        }
      });
    } finally {
      var lines = this.out;
      this.out = outer;
    }
    // Joined onto ONE line, not for compactness: an emitted line that contains a newline is how
    // #captureInit tells a statement from an expression, and this is an expression whichever way it
    // is spelled. Every line the emitter produces already ends in `;` or a brace, and none of them
    // carry a `//` comment, so a space is a safe join.
    return { js: `(()=>{${lines.join(' ')}})()`, type: value ? value.type : T.VOID };
  }

  #declareTmp(name) {
    if (!this._tmps) this._tmps = new Set();
    // Initialised to 0, and reassigned before any use; a BigInt temp is written before it is read.
    if (!this._tmps.has(name)) { this._tmps.add(name); this.out.unshift(`var ${name}=0;`); }
  }

  #call(e) {
    /*
     * Borland's geninterrupt(n): `int n` with the registers the program loaded through _AX and
     * friends, answered by whatever the environment installed for that vector (interruptJs).
     */
    if (e.fn.n === 'ident' && e.fn.name === 'geninterrupt' && this.usesRegs && !this.locals.has('geninterrupt')) {
      const n = e.args?.length === 1 ? evalConstNumber(this.ty, e.args[0]) : null;
      if (n === null) unsup('geninterrupt with a vector that is not a constant');
      return { js: `(${interruptJs(Number(n) & 255)},0)`, type: T.VOID };
    }
    // A direct call by name; anything else goes through the function table.
    //
    // A global VARIABLE of function-pointer type is not a direct call: Quake's byte-order helpers are
    // `int (*LittleLong)(int)` assigned at start-up, and treating the name as a function made it an
    // undeclared-function error. In C a name is either a function or an object, so a hit in `globals`
    // settles it in favour of the indirect path.
    const calleeIsObject = !this.locals.has(e.fn.name) && this.ctx.globals.has(e.fn.name);
    if (e.fn.n === 'ident' && !this.locals.has(e.fn.name) && !calleeIsObject) {
      const name = e.fn.name;
      /*
       * A NESTED function of this one, or -- when this IS a nested function -- one of its siblings,
       * itself included. The frame it needs is `_fp` when the caller owns it and `_up` when the
       * caller is another nested function of the same parent.
       */
      const nest = this.nested.get(name) ?? this.parent?.nested.get(name);
      if (nest) {
        const frame = this.nested.has(name) ? '_fp' : '_up';
        const args = this.#callArgs(e, nest.decl.type);
        return { js: `${jsIdent(nest.jsName)}(${[frame, ...args].join(',')})`, type: nest.decl.type.ret };
      }
      const f = this.ctx.funcs.get(name);
      /*
       * A function the PROGRAM DEFINES wins over a runtime builtin of the same name. Checking the
       * builtin table first meant a program's own `osd_key_pressed` — or its own memcpy, or printf —
       * was silently replaced by PRISM's: that is how MAME's headless backend lost its "stop after N
       * frames" and ran for twelve hours. A mere PROTOTYPE does not win, so `int printf();` still
       * reaches the runtime.
       */
      const rt = (f && f.defined) ? null : this.ctx.builtins.get(name);
      if (rt?.setjmp) {
        // The registration was emitted by the planner; here the call is just its return value.
        if (!this.hasSetjmp) unsup('setjmp outside a statement the planner could lift');
        return { js: '_sjv', type: this.ty.INT };
      }
      if (rt?.vaStart) {
        if (!this.variadic) throw new EmitError('va_start outside a variadic function');
        return { js: '_va', type: this.ty.ptr(this.ty.CHAR) };
      }
      /*
       * `__builtin_classify_type(x)` is a constant naming the CLASS of x's type, and gcc does not
       * evaluate x -- so neither does this. The codes are gcc's own, confirmed against the reference
       * build rather than read off its header: every integer type is 1 (char, _Bool and an enum
       * included, where the header still lists separate classes), every floating type is 8, and an
       * array or a function is 5 because it has already decayed to a pointer.
       */
      /*
       * The complex builtins. `__builtin_conj(z)` is `~z`, and creal/cimag are the two halves --
       * the same three operations the operators already have, reached by name.
       */
      if (rt?.cx) {
        if (e.args.length !== 1) throw new EmitError(`${name} takes one argument`);
        const v = this.#rval(e.args[0]);
        if (!T.isComplex(this.ty.decay(v.type))) unsup(`${name} of a ${T.typeName(v.type)}`);
        const of = v.type.complexOf;
        if (rt.cx === 'conj') {
          const p = this.#cxParts(v, of);
          return { js: `(${p.pin},${this.#cxMake(v.type, p.re, `-(${p.im})`).js})`, type: v.type };
        }
        const t = this.newTmp(); this.#declareTmp(t);
        return {
          js: `(${t}=${v.js},${loadExpr(rt.cx === 'imag' ? `(${t}+${of.size}|0)` : t, of)})`,
          type: of,
        };
      }
      if (rt?.classify) {
        if (e.args.length !== 1) throw new EmitError(`${name} takes one argument`);
        const t = this.ty.decay(e.args[0].type ?? this.ty.INT);
        const code = t.k === 'ptr' ? 5
          : t.k === 'struct' ? 12
          : t.k === 'union' ? 13
          : t.k === 'void' ? 0
          : (t.k === 'scalar' && /float|double/.test(t.name ?? '')) ? 8
          : 1;
        return { js: String(code), type: this.ty.INT };
      }
      /*
       * The overflow builtins are TYPE-GENERIC, which is why they cannot be an ordinary table entry:
       * `__builtin_add_overflow(a, b, &r)` computes in infinite precision and reports whether the
       * result fits in whatever `r` is. So the width and signedness come from the third argument's
       * POINTEE, which only the emitter knows, and the arithmetic happens in BigInt because that is
       * the only thing here with the range to notice an overflow of a 64-bit type.
       */
      if (rt?.overflow) {
        if (e.args.length !== 3) throw new EmitError(`${name} takes three arguments`);
        const a = this.#rval(e.args[0]), b = this.#rval(e.args[1]), dst = this.#rval(e.args[2]);
        const to = dst.type?.k === 'ptr' ? dst.type.to : null;   /* a pointer's target is `to`; `of` is an array's */
        if (!to || to.k !== 'scalar') unsup(`${name} into a ${T.typeName(dst.type ?? this.ty.INT)}`);
        const isUnsigned = (t) => !!t && /^unsigned|^_Bool/.test(t.name ?? '');
        /*
         * Each operand carries ITS OWN type into the infinite-precision arithmetic -- there is no
         * common type here, which is the whole point of these builtins. A 32-bit value comes out of
         * the emitter as a signed i32, so an unsigned one has to be put back: 0xffffffffu read as -1
         * turns `0xffffffffu + 1u` into 0 and reports NO overflow, which is how gcc's pr85095.c
         * caught this.
         */
        const operand = (v) => (v.type?.k === 'scalar' && v.type.size <= 4 && isUnsigned(v.type)
          ? `((${v.js})>>>0)` : v.js);
        return {
          js: `M.rt.__prism_overflow(${JSON.stringify(rt.overflow)},${operand(a)},${operand(b)},` +
              `${dst.js},${to.size},${isUnsigned(to) ? 0 : 1})`,
          type: this.ty.INT,
        };
      }
      if (rt?.proto) {
        /*
         * A builtin whose types are the PROTOTYPE's: an environment for a 16-bit model cannot write
         * its signatures in the shared i386 types, where an int is four bytes, so it declares the
         * functions in its own header and lets the model the program was compiled for type them.
         */
        if (!f?.type?.params) unsup(`calling ${name} with no prototype in scope`);
        const args = e.args.map((a, i) => this.#rvalForCall(a, f.type.params[i]?.type));
        // The runtime returns a plain number, fitted here to the prototype's width: the 16-bit
        // conversions are not yet truncated anywhere else, and an int that reads 0xBEEF must be -16657.
        return { js: fitToWidth(f.type.ret, `M.rt.${rt.impl ?? name}(${args.join(',')})`), type: f.type.ret };
      }
      if (rt) {
        const args = e.args.map((a, i) => this.#rvalForCall(a, rt.params?.[i]));
        // A variadic runtime function takes its extras as one JS array, which is enough for
        // printf-family calls and is all tier-0 promises.
        const impl = rt.impl ?? name;
        if (rt.variadic) {
          const fixed = args.slice(0, rt.params.length);
          /*
           * Under a 16-bit model the tail is packed as Borland's caller pushes it and read back at the
           * widths the format asks for -- a JS array cannot say that a %d given a long reads its low
           * word. i386 keeps the array: there every width it reads is the same four bytes.
           */
          if (this.ty.INT.size === 2) {
            const packed = this.#packVarargs(e, { params: rt.params.map((t) => ({ type: t })) });
            return { js: `M.rt.${impl}(${[...fixed, `M.va(${packed})`].join(',')})`, type: rt.ret };
          }
          const rest = args.slice(rt.params.length);
          return { js: `M.rt.${impl}(${[...fixed, `[${rest.join(',')}]`].join(',')})`, type: rt.ret };
        }
        /*
         * The PROGRAM's prototype governs the result type when both say pointer.
         *
         * A builtin table cannot name `struct tm *` -- the struct belongs to whichever program
         * declared it -- so localtime is listed as returning a generic pointer, and that was
         * overruling `struct tm *localtime(const time_t *)` from PRISM's own time.h. The member
         * access then failed with "'char' has no member 'tm_mon'".
         *
         * Restricted to pointer-for-pointer on purpose. The float family declares sqrtf as taking
         * and returning FLOAT precisely so a store rounds, and that must keep winning over a
         * program that prototypes it in double.
         */
        const declared = f?.type?.ret;
        const ret = (declared && declared.k === 'ptr' && rt.ret?.k === 'ptr') ? declared : rt.ret;
        return { js: `M.rt.${impl}(${args.join(',')})`, type: ret };
      }
      if (f) {
        const ft = f.type;
        const args = this.#callArgs(e, ft);
        /*
         * A call to a name that is DECLARED and never DEFINED, and is not a runtime builtin either.
         * It compiles -- the call goes through F, which is exactly what a real linker's undefined
         * symbol would not do -- and then fails at run time as `F.name is not a function`.
         *
         * OpenDUNE is why this is recorded. `get_bios_keyboard_status` has its body in a Watcom
         * `#pragma aux`, which PRISM ignores, so the build reported "nothing unemitted" and the gap
         * appeared only when Video_Tick called it. A linker names its undefined symbols; so should
         * this. It is also the on-ramp to compiling the assembly: cross this list with the .asm
         * objects a makefile lists and you have exactly what the assembler was providing.
         */
        if (!f.defined) {
          const where = this.ctx.undefinedCalls;
          if (where) (where.get(f.name) ?? where.set(f.name, new Set()).get(f.name)).add(this.ctx.unit ?? '?');
        }
        /*
         * directCalls: an experiment, off by default, measuring one thing only.
         *
         * Every cross-function call normally goes through `F["name"]` on an object with as many
         * properties as the program has functions, which V8 keeps in dictionary mode -- and
         * `Builtin: LoadIC` is the largest accounted entry in the profile of the Z80 core. This
         * emits a direct call to the emitted function's own identifier instead, which is only
         * possible when the callee is DEFINED here: a declaration with no body resolves through F to
         * a runtime binding or a throwing stub.
         *
         * The cost of turning it on is not speed, it is observability: every harness in tools/
         * instruments a program by rebinding prog.F, and a direct call cannot see that.
         */
        if (this.ctx.directCalls && f.defined) {
          return { js: `${jsIdent(f.name)}(${args.join(',')})`, type: ft?.ret ?? this.ty.INT };
        }
        // The LINKAGE name, not the source name: a file-scope `static` is mangled per translation
        // unit, and using the source name here called a function that was never bound.
        return { js: `F[${JSON.stringify(f.name)}](${args.join(',')})`, type: ft?.ret ?? this.ty.INT };
      }
      throw new EmitError(`call to undeclared function '${name}'`);
    }
    const p = this.#rval(e.fn);
    let ft = this.ty.decay(p.type);
    if (ft.k === 'ptr' && ft.to.k === 'func') ft = ft.to;
    const args = this.#callArgs(e, ft);
    // Through a VARIADIC pointer type the last argument is the packed tail, which the runtime unpacks
    // when the function actually called is not variadic (M.icall).
    return { js: `M.icall(${p.js},[${args.join(',')}]${ft?.variadic ? ',1' : ''})`, type: ft?.ret ?? this.ty.INT };
  }

  /**
   * The argument list for one call, including the hidden sret buffer when the callee returns a
   * struct. Both the buffer and every by-value struct argument are allocated in the CALLER's frame:
   * the callee's frame is gone by the time the result is read, and C promises the callee its own
   * copy of each argument.
   */
  #callArgs(e, ft) {
    const args = [];
    // A variadic callee receives ONLY its fixed parameters positionally; the tail travels in the
    // packed buffer. Passing both made the buffer land in the wrong JS parameter.
    const positional = ft?.variadic ? Math.min(ft.params.length, e.args.length) : e.args.length;
    for (let i = 0; i < positional; i++) {
      const want = ft?.params?.[i]?.type;
      const node = e.args[i];
      const asRecord = want && T.isRecord(want) ? want
        : (!want && node.type && T.isRecord(node.type) ? node.type : null);
      args.push(asRecord ? this.#structArg(node, asRecord) : this.#rvalForCall(node, want));
    }
    /*
     * RIGHT TO LEFT when the target's compiler did so and it can be seen: C leaves the order
     * unspecified, and a demo replays only if the random numbers land where the original build put
     * them. Heretic's `P_SpawnMobj(x + ((P_Random()-P_Random())<<11), y + (...), ...)` gives the
     * FIRST pair to y in HERETIC.EXE (Watcom 10: y's calls, then x's, then the call). Only when two
     * or more arguments have side effects -- otherwise the order cannot be observed and the plain
     * form is kept. A variadic tail is the last element here and is packed last-first itself. The later arguments go to temporaries, evaluated inside the first argument's
     * slot, since JavaScript itself evaluates left to right.
     */
    if (this.ctx.argOrder === 'rtl' && args.length > 1
      && e.args.filter((n) => sideEffects(n)).length > 1) {
      const tmps = args.map(() => { const t = this.newTmp(); this.#declareTmp(t); return t; });
      const order = [];
      for (let i = args.length - 1; i >= 1; i--) order.push(`${tmps[i]}=${args[i]}`);
      args[0] = `(${order.join(',')},${args[0]})`;
      for (let i = 1; i < args.length; i++) args[i] = tmps[i];
    }
    if (ft && T.isRecord(ft.ret)) {
      const off = this.slot(ft.ret.size, ft.ret.align);
      args.unshift(`(_fp+${off}|0)`);
    }
    if (ft?.variadic) args.push(this.#packVarargs(e, ft));
    return args;
  }

  /**
   * Pack the variadic tail of a call into a caller-owned buffer and return its address. Each value
   * takes a whole number of int-sized slots after the DEFAULT ARGUMENT PROMOTIONS — a float is passed
   * as a double, anything narrower than int as an int — because that is what the callee's `va_arg`
   * will assume when it is handed a type to read. The slot is the model's int: four bytes on i386,
   * one 8086 stack word under a 16-bit model, where a long takes two and a near pointer one.
   */
  /**
   * Where each named parameter of a variadic function sits relative to its variadic block, in cdecl's
   * layout: in order, each in a whole number of int-sized slots (a struct by its size), the last
   * one ending where the variadic arguments begin. `below` is the distance down from that point.
   */
  #namedArgLayout(ft) {
    const unit = this.ty.INT.size;
    const sizes = ft.params.map((p) => Math.ceil((p.type.size ?? unit) / unit) * unit);
    const total = sizes.reduce((a, b) => a + b, 0);
    let off = 0;
    return ft.params.map((p, i) => { const below = total - off; off += sizes[i]; return { p, below, total }; });
  }

  #packVarargs(e, ft) {
    const fixed = ft.params.length;
    const tail = e.args.slice(fixed);
    const items = [];
    let total = 0;
    for (const node of tail) {
      // The TYPE comes from the parser's annotation, not from emitting the expression: calling
      // #rval here and again below would evaluate each argument twice, so `f(2, i++, i++)` would
      // increment four times.
      let t = this.ty.decay(node.type ?? this.ty.INT);
      if (T.isFloat(t) && t.name === 'float') t = this.ty.DOUBLE;          // default promotion
      else if (T.isInteger(t) && T.rank(t) < 3) t = this.ty.promote(t);
      const size = T.isRecord(t) ? t.size : (t.size ?? 4);
      const unit = this.ty.INT.size;
      items.push({ node, type: t, off: total });
      total += Math.ceil(size / unit) * unit;
    }
    // The named arguments' room in front (see #namedArgLayout), which the callee fills if it takes an
    // address -- so the block exists even when there is no variadic argument at all.
    const named = ft.params.length ? this.#namedArgLayout(ft)[0].total : 0;
    if (!total && !named) return '0';
    const base = this.slot(named + total, 8) + named;
    const parts = [];
    for (const it of items) {
      const addr = `(_fp+${base + it.off}|0)`;
      if (T.isRecord(it.type)) {
        const src = this.#lval(it.node);
        parts.push(`M.copy(${addr},${src.addr},${it.type.size})`);
      } else {
        parts.push(storeExpr(addr, it.type, this.#rvalCoerced(it.node, it.type)));
      }
    }
    // Right to left too when the target's compiler did so (see #callArgs).
    if (this.ctx.argOrder === 'rtl') parts.reverse();
    const t = this.newTmp(); this.#declareTmp(t);
    return `(${parts.map((p) => `${p},`).join('')}${t}=(_fp+${base}|0),${t})`;
  }

  /** Copy a struct argument into a caller-owned temporary and pass its address. */
  #structArg(node, type) {
    if (type.size == null) unsup('passing an incomplete struct by value');
    const off = this.slot(type.size, type.align);
    // A REAL argument for a complex parameter converts first: `foo(2)` where foo takes a
    // `_Complex unsigned` has no object to copy from until one is made.
    const src = T.isComplex(type) && !T.isComplex(this.ty.decay(node.type ?? this.ty.INT))
      ? { addr: this.#cxConvert(this.#rval(node), type).js }
      : this.#lval(node);
    const t = this.newTmp(); this.#declareTmp(t);
    return `(${t}=(_fp+${off}|0),M.copy(${t},${src.addr},${type.size}),${t})`;
  }

  #rvalForCall(node, want) {
    const v = this.#rval(node);
    const from = this.ty.decay(v.type);
    if (!want) {
      // No prototype for this parameter: the default argument promotions apply.
      if (T.isFloat(from) && from.name === 'float') return `+(${v.js})`;
      if (T.isInteger(from) && T.rank(from) < 3) return coerce(this.ty, v.js, from, this.ty.INT);
      return v.js;
    }
    return coerce(this.ty, v.js, from, this.ty.decay(want));
  }

  // ------------------------------------------------------------- complex
  /*
   * A complex value is a two-member record -- `{ __real, __imag }` -- so it travels as its ADDRESS,
   * exactly like a struct, and copies, arguments, returns and initialisers need nothing new. What
   * follows is only the arithmetic, which a struct does not have.
   */

  /** A fresh complex object in this frame, given its two halves. */
  #cxMake(cx, reJs, imJs) {
    const of = cx.complexOf;
    const off = this.slot(cx.size, cx.align);
    const at = `(_fp+${off}|0)`;
    return {
      js: `(${storeExpr(at, of, reJs)},${storeExpr(`(${at}+${of.size}|0)`, of, imJs)},${at})`,
      type: cx,
    };
  }

  /**
   * The two halves of a value, as JS expressions that may be used more than once.
   *
   * Pinning matters: complex multiplication mentions each half twice, and re-emitting the operand
   * would run its side effects twice. A complex operand is pinned by its address, a real one by its
   * value.
   */
  #cxParts(v, of) {
    const t = this.newTmp();
    this.#declareTmp(t);
    if (T.isComplex(v.type)) {
      const src = v.type.complexOf;
      const re = coerce(this.ty, loadExpr(t, src), src, of);
      const im = coerce(this.ty, loadExpr(`(${t}+${src.size}|0)`, src, src), src, of);
      return { pin: `${t}=${v.js}`, re, im };
    }
    return { pin: `${t}=${coerce(this.ty, v.js, this.ty.decay(v.type), of)}`, re: t, im: T.isFloat(of) ? '0' : '0' };
  }

  /** The arithmetic type the two halves are computed in. */
  #cxCommon(a, b) {
    const ab = T.isComplex(a) ? a.complexOf : a;
    const bb = T.isComplex(b) ? b.complexOf : b;
    const of = this.ty.usualArith(this.ty.promote(ab), this.ty.promote(bb));
    if (is64(of)) unsup('a complex type as wide as long long');
    return of;
  }

  /** `Math.fround` after every step for a float base -- a float complex is computed in float. */
  #cxRound(js, of) { return of.name === 'float' ? `Math.fround(${js})` : js; }

  #cxBinary(a, b, op) {
    const of = this.#cxCommon(this.ty.decay(a.type), this.ty.decay(b.type));
    const cx = T.complex(of);
    const A = this.#cxParts(a, of), B = this.#cxParts(b, of);
    const pins = `${A.pin},${B.pin}`;
    const R = (js) => this.#cxRound(js, of);
    const trunc = (js) => (T.isFloat(of) ? js : `((${js})|0)`);
    let re, im;
    if (op === '+' || op === '-') {
      re = trunc(R(`(${A.re})${op}(${B.re})`));
      im = trunc(R(`(${A.im})${op}(${B.im})`));
    } else if (op === '*') {
      re = trunc(R(`${R(`(${A.re})*(${B.re})`)}-${R(`(${A.im})*(${B.im})`)}`));
      im = trunc(R(`${R(`(${A.re})*(${B.im})`)}+${R(`(${A.im})*(${B.re})`)}`));
    } else if (op === '/') {
      /*
       * Smith's method, which is what libgcc's __divdc3 does: dividing by the LARGER of the two
       * denominator halves keeps the intermediate products in range. The naive formula overflows to
       * infinity for perfectly ordinary values, and gcc's own result is the reference here.
       */
      const t = this.newTmp(); this.#declareTmp(t);
      const d = this.newTmp(); this.#declareTmp(d);
      const big = `Math.abs(${B.re})>=Math.abs(${B.im})`;
      re = `(${big}?((${t}=(${B.im})/(${B.re})),(${d}=(${B.re})+(${B.im})*${t}),` +
           `${R(`((${A.re})+(${A.im})*${t})/${d}`)})` +
           `:((${t}=(${B.re})/(${B.im})),(${d}=(${B.re})*${t}+(${B.im})),` +
           `${R(`((${A.re})*${t}+(${A.im}))/${d}`)}))`;
      // The second half reuses the SAME t and d, so it must be computed after the first: the caller
      // emits real then imaginary, in that order, inside one comma expression.
      im = `(${big}?${R(`((${A.im})-(${A.re})*${t})/${d}`)}:${R(`((${A.im})*${t}-(${A.re}))/${d}`)})`;
      if (!T.isFloat(of)) { re = `((${re})|0)`; im = `((${im})|0)`; }
    } else unsup(`'${op}' on a complex value`);
    const made = this.#cxMake(cx, re, im);
    return { js: `(${pins},${made.js})`, type: cx };
  }

  /** `==` and `!=`: both halves, and nothing else compares. */
  #cxCompare(a, b, op) {
    const of = this.#cxCommon(this.ty.decay(a.type), this.ty.decay(b.type));
    const A = this.#cxParts(a, of), B = this.#cxParts(b, of);
    const eq = `((${A.re})===(${B.re})&&(${A.im})===(${B.im}))`;
    return { js: `(${A.pin},${B.pin},${op === '==' ? eq : `!${eq}`}?1:0)`, type: this.ty.INT };
  }

  /** A conversion INTO a complex type, and out of one. */
  #cxConvert(v, want) {
    if (T.isComplex(want)) {
      const of = want.complexOf;
      if (T.isComplex(v.type)) {
        const src = v.type.complexOf;
        if (src.name === of.name) return v;
        const p = this.#cxParts(v, of);
        return { js: `(${p.pin},${this.#cxMake(want, p.re, p.im).js})`, type: want };
      }
      // A real becomes a complex with a zero imaginary part.
      return this.#cxMake(want, coerce(this.ty, v.js, this.ty.decay(v.type), of), T.isFloat(of) ? '0' : '0');
    }
    // Out of a complex: the REAL part, which is what a cast to a real type takes.
    const of = v.type.complexOf;
    const t = this.newTmp(); this.#declareTmp(t);
    return { js: `(${t}=${v.js},${coerce(this.ty, loadExpr(t, of), of, want)})`, type: want };
  }

  #rvalCoerced(node, want) {
    const v = this.#rval(node);
    if (T.isComplex(want) || T.isComplex(v.type)) return this.#cxConvert(v, want).js;
    return coerce(this.ty, v.js, this.ty.decay(v.type), want);
  }

  // ------------------------------------------------------------- bitfields

  /*
   * A bitfield read.
   *
   * The fast path is a single 32-bit unit, which is what the layout produces for every ordinary
   * struct. It is NOT what `#pragma pack(1)` produces: packing removes the alignment that kept a
   * field inside one unit, so `int f:26` can start at bit 23 and run past the word boundary. That
   * used to be refused outright, which csmith hit in one program in six.
   *
   * The general path works in BYTES, because bytes are the only unit that always contains the field
   * -- at most five of them for a 32-bit-wide field -- and assembles them with multiplication rather
   * than shifts: JS shifts are 32-bit, and five bytes is 40.
   */
  #loadBitfield(l) {
    const f = l.bitfield;
    /*
     * A bitfield whose DECLARED TYPE is 64-bit goes through the runtime, whatever its width.
     *
     * Two reasons, and the first is not about width at all: `unsigned long long a:8` is eight bits
     * wide but its type is 64-bit, so the value has to arrive as a BigInt or the first arithmetic on
     * it throws "Cannot mix BigInt and other types" -- which is what six of gcc's torture programs
     * did. The second is that a field wider than 32 bits cannot be assembled in a Number at all
     * beyond 53 bits, and the byte path below multiplies rather than shifts precisely because JS
     * shifts are 32-bit.
     *
     * A bitfield is not a hot path, so a call is cheaper than emitting the BigInt arithmetic inline
     * and getting the sign extension wrong in two places instead of one.
     */
    if (is64(f.type)) {
      /*
       * WIDER THAN 32 BITS IS STILL REFUSED, and the reason is not the storage -- it is the
       * ARITHMETIC. C 6.7.2.1p9 makes a bitfield "an integer type consisting of the specified number
       * of bits", and gcc takes that literally: `unsigned long long b:40` shifted left by 32 is
       * computed in FORTY-bit precision, so 0x100 << 32 is 0, not 0x10000000000. Doing that needs a
       * width-parameterised integer type, which this type system does not have -- and pretending the
       * type is 64-bit produces a plausible wrong answer instead of a refusal (bitfld-5.c,
       * pr32244-1.c, pr34971.c). See docs/ROADMAP.md.
       */
      if (f.width > 32) unsup('a bitfield wider than 32 bits');
      const get = `M.rt.__prism_bf_get64((${l.addr}|0),${f.bitOffset},${f.width},${f.type.signed ? 1 : 0})`;
      // Narrow fields promote to int or unsigned int, so their value must arrive as a Number.
      return is64(bitfieldPromoted(this.ty, f)) ? get : `Number(${get})`;
    }
    const shift = f.bitOffset & 31;
    if (shift + f.width <= 32) {
      const unitOff = (f.bitOffset >> 5) * 4;
      const raw = `D.getUint32((${l.addr}+${unitOff}|0),1)`;
      if (f.type.signed) return `((${raw})<<${32 - shift - f.width}>>${32 - f.width})`;
      return `(((${raw})>>>${shift})&${(2 ** f.width - 1) >>> 0})`;
    }
    if (f.width > 32) unsup('a bitfield wider than 32 bits');
    const byteOff = f.bitOffset >> 3;
    const bit = f.bitOffset & 7;
    const nbytes = Math.ceil((bit + f.width) / 8);
    const at = this.newTmp(); this.#declareTmp(at);
    const parts = [];
    for (let i = 0; i < nbytes; i++) parts.push(`M.u8[${at}+${i}]*${2 ** (8 * i)}`);
    const raw = `(${parts.join('+')})`;
    // Math.floor, not >>>: the assembled value can exceed 32 bits.
    const field = `(Math.floor(${raw}/${2 ** bit})%${2 ** f.width})`;
    const body = f.type.signed
      // Sign-extend by hand; the value is a plain Number, so the <<>> trick is unavailable.
      ? `(${field}>=${2 ** (f.width - 1)}?${field}-${2 ** f.width}:${field})`
      : field;
    return `(${at}=(${l.addr}+${byteOff}|0),${body})`;
  }

  #assignBitfield(l, e) {
    const f = l.bitfield;
    const v = this.newTmp(); this.#declareTmp(v);
    const at = this.newTmp(); this.#declareTmp(at);
    /*
     * `b.f += x` is a read, an operation in the PROMOTED type, and a store back -- and the promotion
     * is where a bitfield differs from anything else: `unsigned f:3` promotes to `int`, so
     * `f -= 1` on a zero field is -1 in int and then truncates to 7, not to some 3-bit borrow.
     * bitfieldPromoted already knows that rule, so the arithmetic simply happens there.
     */
    const rhs = e.op === '='
      ? this.#rvalCoerced(e.rhs, f.type)
      : coerce(this.ty, 
          this.#binaryWithValue(
            { js: this.#loadBitfield(l), type: bitfieldPromoted(this.ty, f) },
            this.#rval(e.rhs), e.op.slice(0, -1),
          ).js,
          bitfieldPromoted(this.ty, f), f.type);
    const { unitOff, poke } = bitfieldPoke(f, at, v);
    // The result is the field READ BACK, not `v`: assigning 1081 to a `signed int m:11` yields -967,
    // and `(l.m = j) == j` must therefore be false (gcc's 921016-1.c).
    const readBack = this.#loadBitfield({ addr: l.addr, bitfield: f });
    return {
      js: `(${at}=(${l.addr}+${unitOff}|0),${v}=${rhs},${poke},${readBack})`,
      type: bitfieldPromoted(this.ty, f),
    };
  }

  /** Write a constant-position bitfield at a known address; used by brace initialisers. */
  #initBitfield(addrJs, f, valueJs) {
    const at = this.newTmp(); this.#declareTmp(at);
    const v = this.newTmp(); this.#declareTmp(v);
    const { unitOff, poke } = bitfieldPoke(f, at, v);
    this.out.push(`${at}=(${addrJs}+${unitOff}|0);${v}=${valueJs};${poke};`);
  }
}

// ---------------------------------------------------------------- helpers

const coerceTo = (ty, v, t) => coerce(ty, v.js, ty.decay(v.type), t);

/** Write one bitfield straight into the image, for a file-scope initialiser. */
function writeStaticBitfield(mod, base, f, value) {
  const shift = f.bitOffset & 31;
  if (shift + f.width <= 32) {
    const mask = (((2 ** f.width - 1) >>> 0) << shift) >>> 0;
    const at = base + (f.bitOffset >> 5) * 4;
    const cur = mod.dv.getUint32(at, true);
    mod.dv.setUint32(at, (((cur & ~mask) | ((value << shift) & mask)) >>> 0), true);
    return;
  }
  if (f.width > 32) unsup('a static bitfield wider than 32 bits');
  // Byte-wise, the same arithmetic as bitfieldPoke but executed here instead of emitted.
  const bit = f.bitOffset & 7;
  const nbytes = Math.ceil((bit + f.width) / 8);
  const at = base + (f.bitOffset >> 3);
  const v = Number(value) >>> 0;
  for (let i = 0; i < nbytes; i++) {
    const lo = Math.max(0, bit - 8 * i);
    const hi = Math.min(8, bit + f.width - 8 * i);
    const keep = (~(((1 << hi) - (1 << lo)) & 0xff)) & 0xff;
    const from = 8 * i - bit + lo;
    mod.u8[at + i] = (mod.u8[at + i] & keep) | (((Math.floor(v / 2 ** from) << lo) & (~keep & 0xff)));
  }
}

/** The type a bitfield read has after the integer promotions. */
/*
 * C99 6.3.1.1: a bitfield promotes to int if int can hold every value it has, otherwise to unsigned
 * int -- and otherwise to its own type, which is the case a 64-bit bitfield reaches. `long long
 * a:40` cannot fit in an int, so it stays 64-bit and its arithmetic stays BigInt; saying INT here
 * made every read mix a BigInt with a Number on the next operation.
 */
function bitfieldPromoted(ty, f) {
  if (f.type.k !== 'scalar') return ty.INT;
  /*
   * The rule is about VALUES, not about the declared type: int if int can represent every value the
   * field can hold, otherwise unsigned int, otherwise the field's own type. So a `long long a:8`
   * promotes to int like any other narrow field, and only a field wider than 32 bits stays 64-bit.
   *
   * Claiming the 64-bit type for narrow fields instead was tempting -- the read returns a BigInt
   * whatever the width -- and gcc has four programs that fail on it (bf-sign-2.c, bitfld-5.c,
   * pr32244-1.c, pr34971.c). #loadBitfield converts the BigInt down when the promotion says 32-bit;
   * the representation follows the type rather than deciding it.
   */
  if (is64(f.type)) {
    if (f.width < 32) return ty.INT;
    if (f.width === 32) return f.type.signed ? ty.INT : ty.UINT;
    return f.type;
  }
  if (f.type.signed) return ty.INT;
  return f.width < 32 ? ty.INT : ty.UINT;
}

/**
 * The read-modify-write for one bitfield, shared by assignment and initialisation.
 *
 * `unitOff` is what the caller adds to the object's address before poking, so the two paths below
 * differ in their unit as well as in their arithmetic: a 32-bit word for the aligned case, the
 * containing byte for the packed one.
 */
function bitfieldPoke(f, atVar, valVar) {
  /* The 64-bit twin of the read above: the value is a BigInt, so the store has to be too. */
  if (is64(f.type)) {
    if (f.width > 32) unsup('a bitfield wider than 32 bits');
    return { unitOff: 0, poke: `M.rt.__prism_bf_set64(${atVar},${f.bitOffset},${f.width},${valVar})` };
  }
  const shift = f.bitOffset & 31;
  if (shift + f.width <= 32) {
    const mask = (((2 ** f.width - 1) >>> 0) << shift) >>> 0;
    return {
      unitOff: (f.bitOffset >> 5) * 4,
      poke: `D.setUint32(${atVar},((D.getUint32(${atVar},1)&${(~mask) >>> 0})|((${valVar}<<${shift})&${mask}))>>>0,1)`,
    };
  }
  if (f.width > 32) unsup('a bitfield wider than 32 bits');
  // Byte-wise, for a field `#pragma pack` left straddling a word: only the bytes the field actually
  // covers are touched, and only the bits inside them.
  const bit = f.bitOffset & 7;
  const nbytes = Math.ceil((bit + f.width) / 8);
  const steps = [];
  for (let i = 0; i < nbytes; i++) {
    const lo = Math.max(0, bit - 8 * i);                       // first bit of this byte in the field
    const hi = Math.min(8, bit + f.width - 8 * i);             // one past the last
    const keep = (~(((1 << hi) - (1 << lo)) & 0xff)) & 0xff;   // bits of this byte NOT in the field
    const from = 8 * i - bit + lo;                             // bit of the value that lands at `lo`
    steps.push(`M.u8[${atVar}+${i}]=(M.u8[${atVar}+${i}]&${keep})|` +
      `((Math.floor(${valVar}/${2 ** from})<<${lo})&${(~keep) & 0xff})`);
  }
  return { unitOff: f.bitOffset >> 3, poke: `(${steps.join(',')})` };
}

function unifyCond(ty, a, b) {
  const at = ty.decay(a), bt = ty.decay(b);
  if (at.k === 'ptr') return at;
  if (bt.k === 'ptr') return bt;
  if (T.isArith(at) && T.isArith(bt)) return ty.usualArith(at, bt);
  return at;
}

/** The first `setjmp` call in this statement, if any. */
/**
 * Is there a setjmp call that a top-level statement does not evaluate first and unconditionally --
 * one inside a branch, a loop, a switch body or a nested block?
 */
function nestedSetjmp(body, builtins) {
  const has = (node) => findSetjmpCall(node, builtins) !== null;
  const top = (st) => {
    if (!st || typeof st !== 'object') return false;
    switch (st.n) {
      case 'label': return top(st.body);
      case 'if': return has(st.then) || has(st.els);
      case 'while': case 'do': case 'for': case 'block': return has(st);
      case 'switch': return has(st.body);
      default: return false;
    }
  };
  return body.items.some(top);
}

function findSetjmpCall(node, builtins) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const x of node) { const r = findSetjmpCall(x, builtins); if (r) return r; }
    return null;
  }
  if (node.n === 'call' && node.fn?.n === 'ident' && builtins?.get(node.fn.name)?.setjmp) return node;
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'sym' || k === 'loc') continue;
    const r = findSetjmpCall(node[k], builtins);
    if (r) return r;
  }
  return null;
}

/** A runtime's number, as a value of type t: truncated and sign-extended to t's own width. */
function fitToWidth(t, js) {
  if (!t || t.k === 'void') return js;
  const size = t.size ?? 4;
  const signed = t.k !== 'ptr' && t.signed;
  if (size === 4) return signed ? `((${js})|0)` : `((${js})>>>0)`;
  if (size === 1 || size === 2) {
    const sh = 32 - size * 8;
    return signed ? `(((${js})<<${sh})>>${sh})` : `((${js})&${size === 1 ? 255 : 65535})`;
  }
  return js;
}

/** Every name a declaration in this subtree introduces. */
/** The automatic variables a function body declares, in any block: not static, extern or typedef. */
function collectAutos(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) collectAutos(x, out); return; }
  if (node.n === 'vardecl' && node.name && !['static', 'extern', 'typedef'].includes(node.storage)) out.push(node);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'loc' || k === 'sym') continue;
    const v = node[k];
    if (v && typeof v === 'object') collectAutos(v, out);
  }
}

function collectDeclNames(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) collectDeclNames(x, out); return; }
  if (node.n === 'vardecl' && node.name) out.add(node.name);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'loc' || k === 'sym') continue;
    const v = node[k];
    if (v && typeof v === 'object') collectDeclNames(v, out);
  }
}

/** Does this subtree name a pseudo-register? */
function mentionsPseudo(node, isPseudo) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((x) => mentionsPseudo(x, isPseudo));
  if (node.n === 'ident' && isPseudo(node.name)) return true;
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'loc' || k === 'sym') continue;
    const v = node[k];
    if (v && typeof v === 'object' && mentionsPseudo(v, isPseudo)) return true;
  }
  return false;
}

/** Does this subtree call a function by this name? */
function callsName(node, name) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((x) => callsName(x, name));
  if (node.n === 'call' && node.fn?.n === 'ident' && node.fn.name === name) return true;
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'loc' || k === 'sym') continue;
    const v = node[k];
    if (v && typeof v === 'object' && callsName(v, name)) return true;
  }
  return false;
}

/** Does this subtree contain a goto? */
function findGoto(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(findGoto);
  if (node.n === 'goto' || node.n === 'gotoexpr') return true;
  return Object.keys(node).some(k => k !== 'type' && k !== 'sym' && k !== 'loc' && findGoto(node[k]));
}

/** Every label a goto in this subtree targets. */
function collectGotoTargets(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const x of node) collectGotoTargets(x, out); return out; }
  if (node.n === 'goto') out.add(node.label);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'sym' || k === 'loc') continue;
    collectGotoTargets(node[k], out);
  }
  return out;
}

/** Walk a function body and collect every name that has `&` applied to it. */
/**
 * Every identifier a NESTED FUNCTION mentions, because it can only reach the enclosing frame through
 * memory. A JS `var` in one function is invisible to another; a frame slot is not, since the nested
 * function is handed the frame pointer.
 *
 * Deliberately blunt: it marks names the nested function declares for itself too. Those are its own
 * locals and pinning the outer one of the same name costs a slot and nothing else, where being wrong
 * the other way costs a wrong answer.
 */
/** Every nested function definition in a body, at whatever block depth it sits. */
function nestedDefs(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const x of node) nestedDefs(x, out); return out; }
  if (node.n === 'func' && node.body) out.push(node);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'sym' || k === 'loc') continue;
    nestedDefs(node[k], out);
  }
  return out;
}

export function collectNestedRefs(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) collectNestedRefs(x, out); return; }
  if (node.n === 'ident' && node.name) out.add(node.name);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'sym' || k === 'loc') continue;
    collectNestedRefs(node[k], out);
  }
}

/**
 * Fold a constant expression whose value is COMPLEX, into its two halves.
 *
 * `_Complex double x = 1.0 + 2.0i;` is one initialiser and two numbers, which is why the ordinary
 * constant folder cannot answer it: it returns a number. Real constants come back as `{re, im: 0}`,
 * so a real sub-expression needs no special case anywhere below.
 *
 * Returns null for anything it cannot fold, which the caller reports as a refusal by name.
 */
function foldComplexConst(e) {
  if (!e) return null;
  switch (e.n) {
    case 'imaginary': return { re: 0, im: Number(e.value) };
    case 'float': return { re: Number(e.value), im: 0 };
    case 'num': return { re: Number(e.value), im: 0 };
    case 'cast': {
      const v = foldComplexConst(e.expr);
      if (!v) return null;
      // A cast to a REAL type drops the imaginary half; to a complex one it keeps both.
      return T.isComplex(e.type) ? v : { re: v.re, im: 0 };
    }
    case 'unary': {
      const v = foldComplexConst(e.expr);
      if (!v) return null;
      if (e.op === '+') return v;
      if (e.op === '-') return { re: -v.re, im: -v.im };
      if (e.op === '~') return { re: v.re, im: -v.im };      // conjugate, on a complex value
      return null;
    }
    case 'cxpart': {
      const v = foldComplexConst(e.expr);
      if (!v) return null;
      return { re: e.part ? v.im : v.re, im: 0 };
    }
    case 'bin': {
      const a = foldComplexConst(e.a), b = foldComplexConst(e.b);
      if (!a || !b) return null;
      switch (e.op) {
        case '+': return { re: a.re + b.re, im: a.im + b.im };
        case '-': return { re: a.re - b.re, im: a.im - b.im };
        case '*': return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
        case '/': {
          const d = b.re * b.re + b.im * b.im;
          return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
        }
        default: return null;
      }
    }
    default: return null;
  }
}

/**
 * The length a flexible array member takes from its own initialiser: the items it is given, or the
 * bytes of the string literal that fills it. `struct { int n; char s[]; } x = { 1, "abc" };` makes
 * `s` four bytes long, terminator included, exactly as if the `[]` had said 4.
 */
export function flexibleArrayType(at, value) {
  if (at?.k !== 'array') return at;
  const of = at.of;
  if (value?.n === 'initlist') return T.array(of, value.items.length);
  let e = value?.expr;
  while (e && e.n === 'cast') e = e.expr;
  if (e?.n === 'str' && e.type?.size) return T.array(of, Math.ceil(e.type.size / (of.size || 1)));
  return at;
}

/**
 * How many bytes BEYOND `sizeof(type)` an initialiser writes, because it fills a flexible array
 * member. The object needs that storage reserved before anything is written into it -- a linker
 * sizes such an object from its initialiser, and without this the next global sits on top of it.
 *
 * Zero for everything else, which is every object in every target: this is walked once per
 * file-scope definition and stops at the first member that cannot contain one.
 */
export function flexibleExtra(type, init) {
  let end = 0;
  const walk = (type, init, base) => {
    if (!init || init.n !== 'initlist' || !T.isRecord(type)) return;
    const named = type.fields.filter(f => f.width !== 0
      && (f.name || (f.bits === undefined && T.isRecord(f.type))));
    let k = 0;
    for (const it of init.items) {
      let f = named[k];
      if (it.designators?.[0]?.field) f = findField(type, it.designators[0].field);
      if (!f) break;
      k = named.indexOf(f) + 1;
      if (f.flexible) end = Math.max(end, base + f.offset + (flexibleArrayType(f.type, it.value).size ?? 0));
      else if (T.isRecord(f.type)) walk(f.type, it.value, base + f.offset);
      if (type.k === 'union') break;       // a union takes one item, into its first member
    }
  };
  walk(type, init, 0);
  return Math.max(0, end - (type.size ?? 0));
}

/**
 * Split one emitted line into the statements it holds, at its TOP-LEVEL semicolons.
 *
 * A single push is not always a single statement -- a bitfield store emits `_t0=addr; _t1=value;
 * D.setUint32(...)` as one line -- and a comma expression cannot hold a semicolon. Depth is tracked
 * because a semicolon inside an arrow function's body (a statement expression) belongs to that body,
 * not to this line.
 */
function topLevelStatements(line) {
  const out = [];
  let depth = 0, start = 0, quote = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = 0; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) { out.push(line.slice(start, i)); start = i + 1; }
  }
  const last = line.slice(start).trim();
  if (last) out.push(last);
  return out.map(x => x.trim()).filter(Boolean);
}

/**
 * Refuse a statement expression whose body jumps OUT of itself, naming the jump. Depth counts the
 * loops and switches the body opens for itself: a `break` inside one of those is the body's own.
 */
function escapingJump(body) {
  const walk = (node, depth, sw) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) walk(x, depth, sw); return; }
    switch (node.n) {
      case 'return': unsup('a `return` inside a statement expression');
      case 'goto': case 'gotoexpr': unsup('a `goto` out of a statement expression');
      case 'label': unsup('a label inside a statement expression');
      case 'case': case 'default':
        if (!sw) unsup('a case label inside a statement expression');
        walk(node.body, depth, sw);
        return;
      case 'break': if (!depth && !sw) unsup('a `break` out of a statement expression'); return;
      case 'continue': if (!depth) unsup('a `continue` out of a statement expression'); return;
      case 'while': case 'do': case 'for':
        walk(node.cond, depth, sw); walk(node.init, depth, sw); walk(node.step, depth, sw);
        walk(node.body, depth + 1, sw);
        return;
      case 'switch': walk(node.disc, depth, sw); walk(node.body, depth, true); return;
      // A nested statement expression checks itself when it is emitted.
      case 'stmtexpr': return;
      case 'func': return;
    }
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'sym' || k === 'loc') continue;
      walk(node[k], depth, sw);
    }
  };
  walk(body, 0, false);
}

/**
 * The first 16-bit segmented pointer model any node in a function body mentions, or null.
 *
 * Types are checked wherever a node carries one -- a declaration, an expression's type, a cast's
 * or a sizeof's target -- because a use can reach the pointer without declaring it: a call through
 * a function whose parameter is a `memptr`, a member of a struct that holds one.
 */
function segModelIn(root) {
  const seen = new Set();
  const walk = (n) => {
    if (!n || typeof n !== 'object' || seen.has(n)) return null;
    seen.add(n);
    if (Array.isArray(n)) { for (const x of n) { const m = walk(x); if (m) return m; } return null; }
    for (const k of ['type', 'target']) {
      if (n[k] && typeof n[k] === 'object' && typeof n[k].k === 'string') {
        const m = T.segModel(n[k]);
        if (m) return m;
      }
    }
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'target' || k === 'sym' || k === 'loc') continue;
      const m = walk(n[k]);
      if (m) return m;
    }
    return null;
  };
  return walk(root);
}

/** Does any node under `root` have kind `n`? Types are not walked: they hold no statements. */
function hasNode(root, n) {
  const seen = new Set();
  const walk = (x) => {
    if (!x || typeof x !== 'object' || seen.has(x)) return false;
    seen.add(x);
    if (Array.isArray(x)) return x.some(walk);
    if (x.n === n) return true;
    for (const k of Object.keys(x)) {
      if (k === 'type' || k === 'target' || k === 'sym' || k === 'loc') continue;
      if (walk(x[k])) return true;
    }
    return false;
  };
  return walk(root);
}

export function collectAddressTaken(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) collectAddressTaken(x, out); return; }
  if (node.n === 'unary' && node.op === '&') {
    let e = node.expr;
    // `&a`, `&a.b`, `&a[i]` all pin `a` in memory.
    while (e && (e.n === 'member' || e.n === 'index')) e = e.base;
    if (e?.n === 'ident') out.add(e.name);
  }
  // A cast ASSIGNED THROUGH -- `(unsigned)i = x`, `((int)u)++` -- reinterprets the object's bytes,
  // so the object must have bytes: pinned like `&i`.
  const target = node.n === 'assign' ? node.lhs : (node.n === 'preinc' || node.n === 'postinc') ? node.expr : null;
  if (target?.n === 'cast') {
    let e = target;
    while (e?.n === 'cast') e = e.expr;
    if (e?.n === 'ident') out.add(e.name);
  }
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'sym' || k === 'loc') continue;
    collectAddressTaken(node[k], out);
  }
}

/** The address `p->a.b` names when p is a constant (the offsetof idiom), or null. */
function constMemberAddress(ty, e) {
  if (e?.n !== 'member') return null;
  let base, rec;
  if (e.arrow) {
    try { base = evalConstNumber(ty, e.base); } catch { return null; }
    const pt = ty.decay(e.base.type ?? ty.INT);
    rec = pt.k === 'ptr' ? pt.to : null;
  } else {
    base = constMemberAddress(ty, e.base);
    rec = e.base.type;
  }
  if (base === null || !rec || !T.isRecord(rec)) return null;
  const f = findField(rec, e.field);
  return f && f.bits === undefined ? base + f.offset : null;
}

function evalConstNumber(ty, e) {
  switch (e.n) {
    case 'num': return Number(BigInt.asIntN(64, e.value));
    case 'char': return Number(e.value);
    case 'float': return e.value;
    // offsetof is an integer constant expression and may initialise a static: MAME 0.37b5's
    // ADSP-2100 core keeps a table of them (`offsetof(adsp2100_Regs, ax0.s)`) to find a register.
    case 'offsetof': return Number(constEval(e));
    case 'unary':
      if (e.op === '-') return -evalConstNumber(ty, e.expr);
      if (e.op === '+') return evalConstNumber(ty, e.expr);
      // `&((struct S *)0)->a.b`, offsetof written by hand, as a NUMBER -- so that it folds under an
      // operator too: `-(int)&((S *)0)->b` is how a C++ table records its offset to the whole object.
      if (e.op === '&') { const v = constMemberAddress(ty, e.expr); if (v !== null) return v; }
      if (e.op === '~') return ~evalConstNumber(ty, e.expr);
      if (e.op === '!') return evalConstNumber(ty, e.expr) === 0 ? 1 : 0;
      break;
    case 'cast': {
      // The cast's TYPE is the whole point: `(unsigned short) -4` is 65532, not -4. Dropping it made
      // `volatile unsigned long l2 = (unsigned short int) -4;` hold 0xFFFFFFFC (gcc's pr39240.c).
      const v = evalConstNumber(ty, e.expr);
      return castConst(ty, v, e.type);
    }
    case 'bin': {
      const a = evalConstNumber(ty, e.a);
      // `b` is deliberately not evaluated for && and || — see below.
      const b = (e.op === '&&' || e.op === '||') ? 0 : evalConstNumber(ty, e.b);
      // `1.0 / 32768.0` is NOT integer division. Folding it with `|0` made
      // `double d = 1024.0 - 1.0/32768.0;` equal 1024.0 exactly, which is what gcc's float-floor.c
      // catches. The node's own type decides, not the shape of the operands.
      const isFP = T.isFloat(e.type ?? ty.INT) || T.isFloat(e.a.type ?? ty.INT) || T.isFloat(e.b.type ?? ty.INT);
      /*
       * A 32-bit UNSIGNED operation is its own arithmetic, and JavaScript's operators are the
       * signed one: `(UINT32)0xff800000 >> 3` folded with `>>` is 0xfff00000, where C says
       * 0x1ff00000. MAME 0.34's TMS34010 memory maps are written exactly so -- TOBYTE(bitaddr) is
       * `((UINT32)(bitaddr) >> 3)` in a static table -- and Smash TV's reset vector was read from
       * outside its ROM. A shift takes its left operand's type; the others, either operand's.
       */
      const u32 = (t) => t?.k === 'scalar' && t.size === 4 && (t.name === 'unsigned int' || t.name === 'unsigned long');
      if (!isFP && (e.op === '<<' || e.op === '>>' ? u32(e.a.type) : u32(e.a.type) || u32(e.b.type))) {
        const A = a >>> 0, B = b >>> 0;
        switch (e.op) {
          case '+': return (A + B) >>> 0; case '-': return (A - B) >>> 0; case '*': return Math.imul(A, B) >>> 0;
          case '/': return B ? Math.floor(A / B) : 0; case '%': return B ? A % B : 0;
          case '<<': return (A << b) >>> 0; case '>>': return A >>> b;
          case '&': return (A & B) >>> 0; case '|': return (A | B) >>> 0; case '^': return (A ^ B) >>> 0;
          case '==': return A === B ? 1 : 0; case '!=': return A !== B ? 1 : 0;
          case '<': return A < B ? 1 : 0; case '>': return A > B ? 1 : 0;
          case '<=': return A <= B ? 1 : 0; case '>=': return A >= B ? 1 : 0;
        }
      }
      switch (e.op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b;
        case '/': return isFP ? a / b : (a / b) | 0;
        case '%': return a % b;
        case '<<': return a << b; case '>>': return a >> b;
        case '&': return a & b; case '|': return a | b; case '^': return a ^ b;
        /*
         * Comparisons and the logical operators are constant expressions in C, and leaving them out
         * meant a static initialised with something as ordinary as `0 == 1` was refused. SQLite's
         * amalgamation has one; so, it turns out, do a number of the torture programs.
         */
        case '==': return a === b ? 1 : 0;
        case '!=': return a !== b ? 1 : 0;
        case '<': return a < b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0;
        // Short-circuit for real: the unevaluated side may not be constant at all, and C does not
        // require it to be.
        case '&&': return a !== 0 && evalConstNumber(ty, e.b) !== 0 ? 1 : 0;
        case '||': return a !== 0 || evalConstNumber(ty, e.b) !== 0 ? 1 : 0;
      }
      break;
    }
    // Also short-circuiting: only the taken branch has to be a constant.
    case 'cond':
      return evalConstNumber(ty, e.cond) !== 0
        ? evalConstNumber(ty, e.then ?? e.cond)
        : evalConstNumber(ty, e.els);
    case 'sizeoftype': return e.target.size;
    case 'sizeofexpr': return e.expr.type?.size ?? 0;
  }
  throw new EmitError('not a constant initialiser');
}

/** The 64-bit operators, in BigInt, each masked back to the type's width. */
function bin64(op, A, B, t) {
  const m = (x) => mask64(x, t);
  switch (op) {
    case '+': return m(`(${A})+(${B})`);
    case '-': return m(`(${A})-(${B})`);
    case '*': return m(`(${A})*(${B})`);
    // BigInt `/` truncates toward zero and `%` takes the dividend's sign — the same as C99.
    case '/': return m(`(${A})/(${B})`);
    case '%': return m(`(${A})%(${B})`);
    case '&': return m(`(${A})&(${B})`);
    case '|': return m(`(${A})|(${B})`);
    case '^': return m(`(${A})^(${B})`);
  }
  throw new EmitError(`64-bit operator '${op}'`);
}

/** Apply a cast's truncation to a folded constant, matching `coerce`'s run-time behaviour. */
function castConst(ty, v, t) {
  if (!t) return v;
  if (T.isFloat(t)) return t.name === 'float' ? Math.fround(v) : v;
  if (t.k === 'ptr' || t.k === 'func' || t.k === 'enum') return v | 0;
  if (t.k !== 'scalar') return v;
  switch (t.name) {
    case '_Bool': return v !== 0 ? 1 : 0;
    case 'char': return ty.CHAR.signed ? (v << 24 >> 24) : (v & 255);
    case 'signed char': return v << 24 >> 24;
    case 'unsigned char': return v & 255;
    case 'short': return v << 16 >> 16;
    case 'unsigned short': return v & 65535;
    case 'unsigned int': case 'unsigned long': return v >>> 0;
    default: return v | 0;
  }
}

/**
 * Walk a designator chain PAST its first element.
 *
 * `.default_value.ival = 1` names a field of a field, and only the first designator was ever read --
 * so the value was written at the right offset with the OUTER member's type, which for PuTTY's
 * `ConfKeyInfo` is a union and stopped the build. C99 6.7.8p6 makes the chain arbitrarily long and
 * lets it mix the two forms, `.a[2].b`, so this walks whatever is there and returns where it lands.
 *
 * The caller keeps the FIRST-level field for its own bookkeeping: an item after a designated one
 * continues from the member following that outermost one, not from wherever the chain ended.
 */
function descendDesignators(field, rest) {
  let off = field.offset, type = field.type, f = field;
  for (const d of rest) {
    if (d.field !== undefined && d.field !== null) {
      if (!T.isRecord(type)) unsup(`a field designator '.${d.field}' on ${T.typeName(type)}`);
      const g = findField(type, d.field);
      if (!g) unsup(`no field '${d.field}' in ${T.typeName(type)}`);
      off += g.offset; type = g.type; f = g;
    } else if (d.index !== undefined && d.index !== null) {
      if (type.k !== 'array') unsup(`an array designator on ${T.typeName(type)}`);
      off += d.index * type.of.size; type = type.of; f = { ...type, bits: undefined, name: f.name };
    }
  }
  /*
   * The FIELD comes back, not a summary of it. Returning {off, type, bits, name} instead dropped
   * bitOffset, width and signedness, so every designated bitfield initialiser wrote zero -- and the
   * c-testsuite does not cover that shape, so only PuTTY's conf table noticed.
   */
  return { off, type, field: f };
}

function writeConst(mod, addr, type, v) {
  const a = accessor(type);
  if (!a) unsup(`a static ${T.typeName(type)}`);
  // The Big* setters demand a BigInt and the others demand a Number; neither converts.
  const val = a.set.startsWith('setBig') ? BigInt(v) : (typeof v === 'bigint' ? Number(v) : v);
  if (a.endian) mod.dv[a.set](addr, val, true); else mod.dv[a.set](addr, val);
}

// Literal decoding lives in src/util/charset.js — one place, because the parser (to size an
// array), the #if evaluator (for a character constant) and this emitter all need it, and three
// copies disagreed about wide literals.
export { isWideLiteral, literalBytes, literalUnits } from '../util/charset.js';
