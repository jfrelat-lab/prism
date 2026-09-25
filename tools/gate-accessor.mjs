// gate-accessor.mjs — every load and store passes through one function, and it follows the width.
//
// accessor() used to switch on a type's NAME, which put i386 in the one place no value can avoid: a
// pointer was getInt32, and so were `int`, `long` and an enum. It now follows the type's width, so a
// model where an int is 2 bytes and an enum is 1 reads and writes the right number of bytes.
//
// The i386 column below is TRANSCRIBED FROM THE OLD FUNCTION, not from the new one. That is the
// point of it: a table copied out of the code it is meant to check would agree with anything.
import { accessorFor } from '../src/backend/emit.js';
import { makeTypes } from '../src/sema/types.js';

const i386 = makeTypes('i386');
const dos16 = makeTypes('dos16');

// name -> [get, set], exactly as the name-switching version answered.
const I386 = {
  'char': ['getInt8', 'setInt8'],                  // this host's char is signed
  'signed char': ['getInt8', 'setInt8'],
  'unsigned char': ['getUint8', 'setUint8'],
  'short': ['getInt16', 'setInt16'],
  'unsigned short': ['getUint16', 'setUint16'],
  'int': ['getInt32', 'setInt32'],
  'unsigned int': ['getInt32', 'setInt32'],        // a 4-byte integer is Int32 either way
  'long': ['getInt32', 'setInt32'],
  'unsigned long': ['getInt32', 'setInt32'],
  'float': ['getFloat32', 'setFloat32'],
  'double': ['getFloat64', 'setFloat64'],
  'long long': ['getBigInt64', 'setBigInt64'],
  'unsigned long long': ['getBigUint64', 'setBigUint64'],
  '_Bool': ['getUint8', 'setUint8'],
};

const DOS16 = {
  'char': ['getUint8', 'setInt8'],                 // unsigned in this model, measured
  'short': ['getInt16', 'setInt16'],
  'unsigned short': ['getUint16', 'setUint16'],
  'int': ['getInt16', 'setInt16'],                 // 2 bytes, and signed
  'unsigned int': ['getUint16', 'setUint16'],
  'long': ['getInt32', 'setInt32'],                // still 4
  'unsigned long': ['getInt32', 'setInt32'],
};

let bad = 0;
const check = (label, got, want) => {
  const ok = got && got.get === want[0] && got.set === want[1];
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${label.padEnd(30)} ${got ? `${got.get} / ${got.set}` : '(none)'}` +
    (ok ? '' : `   want ${want[0]} / ${want[1]}`));
};

for (const [n, want] of Object.entries(I386)) check(`i386 ${n}`, accessorFor(i386.scalar(n)), want);
check('i386 pointer', accessorFor(i386.ptr(i386.INT)), ['getInt32', 'setInt32']);
check('i386 enum', accessorFor(i386.enumType('e', [])), ['getInt32', 'setInt32']);

for (const [n, want] of Object.entries(DOS16)) check(`dos16 ${n}`, accessorFor(dos16.scalar(n)), want);
// An address is unsigned: an offset at or above 0x8000 read back negative would be a wrong answer.
check('dos16 pointer', accessorFor(dos16.ptr(dos16.INT)), ['getUint16', 'setUint16']);
// One byte and SIGNED when the constants fit a signed char -- measured, wcc -mm: `(enum {m = 127})200`
// is -56. This line used to want unsigned, on a rule that was never measured.
check('dos16 enum', accessorFor(dos16.enumType('e', [])), ['getInt8', 'setInt8']);
// ...and an unsigned byte when they fit only that: `(enum {w = 200})300` is 44.
check('dos16 enum {200}', accessorFor(dos16.enumType('e', [{ value: 200 }])), ['getUint8', 'setUint8']);

const total = Object.keys(I386).length + Object.keys(DOS16).length + 5;
console.log(bad ? `\n${bad} of ${total} WRONG`
  : `\nevery load and store follows the type's width: ${total}/${total}`);
process.exit(bad ? 1 : 0);
