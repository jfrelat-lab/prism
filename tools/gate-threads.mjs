// gate-threads.mjs — POSIX threads (src/runtime/threads.js): PRISM runs each program with its threads in
// Node workers over the shared image; gcc -pthread runs the same source in the i386 oracle. stdout and
// the exit status must agree. Every case's output is one the program itself makes independent of the
// interleaving -- joins, locks, queues -- so a correct run on any schedule prints the same thing.
//
//   node tools/gate-threads.mjs [--verbose] [--selftest] [filter]
//
// --selftest: the mutation that must turn it red -- the main thread's mutex made a no-op, so its
// increments race the other threads' across their usleep -- and mutex-counter must then FAIL.

import { compileRun } from './oracle.mjs';
import { compileProgram, threadImage } from '../src/compile.js';
import { buildEnv, envBuiltins } from '../src/env/registry.js';
import { nodeSpawn } from './threads-node.mjs';

const VERBOSE = process.argv.includes('--verbose');
const SELFTEST = process.argv.includes('--selftest');
const FILTER = SELFTEST ? 'mutex-counter' : process.argv.slice(2).find((a) => !a.startsWith('--')) ?? null;
const cases = [];
const C = (name, src, expect = null) => cases.push({ name, src, expect });

C('create-join-result', `
#include <stdio.h>
#include <pthread.h>
static void *twice(void *p) { return (void *)((long)p * 2); }
int main(void)
{
    pthread_t t[3]; void *r; long i;
    for (i = 0; i < 3; i++) if (pthread_create(&t[i], NULL, twice, (void *)(i + 20))) { printf("create failed\\n"); return 1; }
    for (i = 0; i < 3; i++) { pthread_join(t[i], &r); printf("%ld -> %ld\\n", i, (long)r); }
    printf("self is equal to itself: %d\\n", pthread_equal(pthread_self(), pthread_self()) != 0);
    return 0;
}
`);

C('mutex-counter', `
#include <stdio.h>
#include <unistd.h>
#include <pthread.h>
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static int counter;
static void *work(void *p)
{
    int i;
    for (i = 0; i < 500; i++) {
        pthread_mutex_lock(&lock);
        { int v = counter; if (i % 97 == 0) usleep(100); counter = v + 1; }
        pthread_mutex_unlock(&lock);
    }
    return p;
}
int main(void)
{
    pthread_t t[4]; int i;
    for (i = 0; i < 4; i++) pthread_create(&t[i], NULL, work, NULL);
    work(NULL);
    for (i = 0; i < 4; i++) pthread_join(t[i], NULL);
    printf("counter %d\\n", counter);
    return 0;
}
`);

C('condvar-queue', `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
static pthread_mutex_t m = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t nonempty = PTHREAD_COND_INITIALIZER, nonfull = PTHREAD_COND_INITIALIZER;
static char *q[4]; static int head, count;
static void put(char *s) { pthread_mutex_lock(&m); while (count == 4) pthread_cond_wait(&nonfull, &m); q[(head + count++) % 4] = s; pthread_cond_signal(&nonempty); pthread_mutex_unlock(&m); }
static char *take(void) { char *s; pthread_mutex_lock(&m); while (!count) pthread_cond_wait(&nonempty, &m); s = q[head]; head = (head + 1) % 4; count--; pthread_cond_signal(&nonfull); pthread_mutex_unlock(&m); return s; }
static void *producer(void *p)
{
    int i; char buf[32];
    for (i = 0; i < 12; i++) { sprintf(buf, "item %d", i * i); put(strdup(buf)); }
    put(NULL);
    return p;
}
int main(void)
{
    pthread_t t; char *s; int n = 0;
    pthread_create(&t, NULL, producer, NULL);
    while ((s = take()) != NULL) { printf("%s (%d)\\n", s, (int)strlen(s)); free(s); n++; }
    pthread_join(t, NULL);
    printf("%d taken\\n", n);
    return 0;
}
`);

/* The shape of Doom 3's sys/linux/main.cpp: an async thread that sleeps to the next 16 ms tick, runs the
   tick and signals an event the main loop waits on; at the end it is cancelled at pthread_testcancel. */
C('async-tick-cancel', `
#include <stdio.h>
#include <unistd.h>
#include <sys/time.h>
#include <pthread.h>
static pthread_mutex_t lock;
static pthread_cond_t event;
static int signaled, waiting, ticks;
static int ms(void) { struct timeval tv; static int base; gettimeofday(&tv, NULL); if (!base) base = tv.tv_sec; return (tv.tv_sec - base) * 1000 + tv.tv_usec / 1000; }
static void trigger(void) { pthread_mutex_lock(&lock); if (waiting) pthread_cond_signal(&event); else signaled = 1; pthread_mutex_unlock(&lock); }
static void waitEvent(void) { pthread_mutex_lock(&lock); if (!signaled) { waiting = 1; pthread_cond_wait(&event, &lock); waiting = 0; } else signaled = 0; pthread_mutex_unlock(&lock); }
static void *async(void *p)
{
    int now = ms(), ticked = now >> 4, to;
    for (;;) {
        now = ms();
        { int next = (now & ~15) + 16, want = (next - now - 1) * 1000; if (want > 0) usleep(want); }
        to = ms() >> 4;
        while (ticked < to) { pthread_mutex_lock(&lock); ticks++; pthread_mutex_unlock(&lock); ticked++; trigger(); }
        pthread_testcancel();
    }
    return p;
}
int main(void)
{
    pthread_t t; pthread_mutexattr_t a; void *r; int i, seen;
    pthread_mutexattr_init(&a); pthread_mutexattr_settype(&a, PTHREAD_MUTEX_ERRORCHECK);
    pthread_mutex_init(&lock, &a); pthread_mutexattr_destroy(&a);
    pthread_cond_init(&event, NULL);
    pthread_create(&t, NULL, async, NULL);
    for (i = 0; i < 6; i++) waitEvent();
    pthread_mutex_lock(&lock); seen = ticks; pthread_mutex_unlock(&lock);
    printf("waited 6 events, ticks >= 6: %d\\n", seen >= 6);
    pthread_cancel(t);
    pthread_join(t, &r);
    printf("joined, cancelled: %d\\n", r == PTHREAD_CANCELED);
    return 0;
}
`, /* The oracle cannot run this one: its i386 gcc build runs under qemu-user on this host, and glibc's
     forced unwind for a cancellation crashes there (SIGSEGV in a three-line pthread_cancel program).
     What Linux prints, by hand: */
  { code: 0, stdout: 'waited 6 events, ticks >= 6: 1\njoined, cancelled: 1\n' });

C('mutex-kinds-errors', `
#include <stdio.h>
#include <errno.h>
#include <pthread.h>
static pthread_mutex_t ec, rec;
static void *other(void *p)
{
    printf("trylock held: %s\\n", pthread_mutex_trylock(&ec) == EBUSY ? "EBUSY" : "?");
    printf("unlock not owner: %s\\n", pthread_mutex_unlock(&ec) == EPERM ? "EPERM" : "?");
    return p;
}
int main(void)
{
    pthread_mutexattr_t a; pthread_t t;
    pthread_mutexattr_init(&a);
    pthread_mutexattr_settype(&a, PTHREAD_MUTEX_ERRORCHECK); pthread_mutex_init(&ec, &a);
    pthread_mutexattr_settype(&a, PTHREAD_MUTEX_RECURSIVE); pthread_mutex_init(&rec, &a);
    pthread_mutex_lock(&ec);
    printf("relock: %s\\n", pthread_mutex_lock(&ec) == EDEADLK ? "EDEADLK" : "?");
    pthread_create(&t, NULL, other, NULL);
    pthread_join(t, NULL);
    printf("unlock owner: %d\\n", pthread_mutex_unlock(&ec));
    { int a1 = pthread_mutex_lock(&rec), a2 = pthread_mutex_lock(&rec), a3 = pthread_mutex_unlock(&rec), a4 = pthread_mutex_unlock(&rec);
      printf("recursive: %d %d %d %d, then not owner: %s\\n", a1, a2, a3, a4, pthread_mutex_unlock(&rec) == EPERM ? "EPERM" : "?"); }
    printf("join self: %s\\n", pthread_join(pthread_self(), NULL) == EDEADLK ? "EDEADLK" : "?");
    return 0;
}
`);

C('once-and-keys', `
#include <stdio.h>
#include <stdlib.h>
#include <pthread.h>
static pthread_once_t once = PTHREAD_ONCE_INIT;
static pthread_key_t key;
static pthread_mutex_t m = PTHREAD_MUTEX_INITIALIZER;
static int inits, freed;
static void dtor(void *v) { pthread_mutex_lock(&m); freed += *(int *)v; pthread_mutex_unlock(&m); free(v); }
static void init(void) { inits++; pthread_key_create(&key, dtor); }
static void *body(void *p)
{
    int *mine = malloc(sizeof *mine);
    pthread_once(&once, init);
    *mine = (int)(long)p;
    pthread_setspecific(key, mine);
    return (void *)(long)(*(int *)pthread_getspecific(key) + 1);
}
int main(void)
{
    pthread_t t[3]; void *r; int i, sum = 0;
    for (i = 0; i < 3; i++) pthread_create(&t[i], NULL, body, (void *)(long)((i + 1) * 10));
    for (i = 0; i < 3; i++) { pthread_join(t[i], &r); sum += (int)(long)r; }
    printf("inits %d sum %d freed %d main's value %p\\n", inits, sum, freed, pthread_getspecific(key));
    return 0;
}
`);

C('exit-from-a-thread', `
#include <stdio.h>
#include <stdlib.h>
#include <pthread.h>
static void bye(void) { printf("atexit ran\\n"); }
static void *quit(void *p) { printf("thread exits\\n"); fflush(stdout); exit(5); return p; }
int main(void)
{
    pthread_t t;
    atexit(bye);
    pthread_create(&t, NULL, quit, NULL);
    pthread_join(t, NULL);
    printf("not reached\\n");
    return 0;
}
`);

C('detached-and-exit', `
#include <stdio.h>
#include <unistd.h>
#include <pthread.h>
static pthread_mutex_t m = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t c = PTHREAD_COND_INITIALIZER;
static int done;
static void finish(void) { pthread_mutex_lock(&m); done++; pthread_cond_broadcast(&c); pthread_mutex_unlock(&m); }
static void *viaexit(void *p) { finish(); pthread_exit((void *)7); return p; }
static void *detached(void *p) { usleep(2000); finish(); return p; }
int main(void)
{
    pthread_t a, b; pthread_attr_t at; void *r;
    pthread_attr_init(&at); pthread_attr_setdetachstate(&at, PTHREAD_CREATE_DETACHED);
    pthread_create(&b, &at, detached, NULL);
    pthread_attr_destroy(&at);
    pthread_create(&a, NULL, viaexit, NULL);
    pthread_join(a, &r);
    pthread_mutex_lock(&m); while (done < 2) pthread_cond_wait(&c, &m); pthread_mutex_unlock(&m);
    printf("pthread_exit value %ld, both finished: %d\\n", (long)r, done);
    return 0;
}
`);

const ENVS = ['stdio', 'pthread'];
let pass = 0, fail = 0;
for (const k of cases) {
  if (FILTER && !k.name.includes(FILTER)) continue;
  const want = k.expect ?? compileRun(k.src, { extra: '-pthread' });
  let got;
  try {
    const program = compileProgram([{ file: `${k.name}.c`, source: k.src }], { shared: true, extraBuiltins: envBuiltins(ENVS) });
    if (program.failures.length) throw new Error(`compile: ${program.failures.map((f) => f.message ?? f).join('; ')}`);
    if (program.undefined.length) throw new Error(`undefined: ${program.undefined.map((u) => u.name).join(' ')}`);
    const env = buildEnv(program.M, ENVS, { pthread: { spawn: nodeSpawn, image: threadImage(program) } });
    if (SELFTEST) program.M.rt.pthread_mutex_lock = program.M.rt.pthread_mutex_unlock = () => 0;
    try {
      const r = program.run([k.name]);
      got = { code: r.code, stdout: r.stdout };
    } finally { env.pthread.shutdown(); }
  } catch (e) { got = { code: -1, stdout: '', error: e?.stack ?? String(e) }; }
  const ok = !got.error && got.code === want.code && got.stdout === want.stdout;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${k.name}`);
  if (!ok || VERBOSE) {
    console.log(`  gcc   (${want.code}): ${JSON.stringify(want.stdout)}`);
    console.log(`  prism (${got.code}): ${JSON.stringify(got.stdout)}`);
    if (got.error) console.log(`  ${got.error.split('\n').slice(0, 8).join('\n  ')}`);
  }
}
if (SELFTEST) {
  console.log(fail ? '\nselftest: the mutation is caught (red, as it must be)' : '\nselftest: the mutation went UNNOTICED -- the gate is vacuous');
  process.exit(fail ? 0 : 1);
}
console.log(`\n${pass} of ${pass + fail} agree with gcc -pthread`);
process.exit(fail ? 1 : 0);
