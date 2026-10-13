// gate-preload.mjs — loaded by tools/gates.mjs before every gate (node --import).
//
// A gate that dies on something the repository does not ship has not failed: it has said nothing,
// which is what SKIP means (tools/gate-skip.mjs). Two things are not shipped: the corpus (a file
// under corpus/ that is not there, or src/target.js's PRISM_MISSING for a whole tree) and the oracle
// container (tools/oracle.mjs's PRISM_MISSING). Gates that check for their inputs first still skip by
// themselves; this covers the ones that find out by throwing. Any other error still kills the gate
// and stays red -- a golden the repository commits and cannot find included.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skip } from './gate-skip.mjs';

const CORPUS = join(dirname(dirname(fileURLToPath(import.meta.url))), 'corpus');

const onError = (e) => {
  if (e?.code === 'PRISM_MISSING') skip(e.message);
  if (e?.code === 'ENOENT' && typeof e.path === 'string' && e.path.startsWith(CORPUS)) {
    skip(`${e.path.slice(CORPUS.length - 6)} not fetched`, 'see the "fetch" line of the targets/*.json that names it');
  }
  throw e;
};
process.on('uncaughtException', onError);
process.on('unhandledRejection', onError);
