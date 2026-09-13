// getopt.js — POSIX getopt, supplied as C rather than as a runtime function.
//
// WHY C. getopt is pure logic over argv with no host interaction at all, and its state is three
// GLOBALS the calling program reads directly -- optarg, optind, optopt. A JavaScript implementation
// would have to find those globals in guest memory and write them there, which is plumbing in
// exchange for nothing. As C it is simply linked, and what it does is visible in the language the
// program is written in.
//
// WHY AN ENV RATHER THAN ALWAYS. Adding a translation unit to every program that includes <stdio.h>
// would change the JavaScript every existing target emits, and this project has just spent some
// effort making sure a target that asks for nothing gets byte-identical output. So a target names
// `getopt` and pays for it; nothing else notices.
//
// The declarations live in <unistd.h> and <getopt.h>; the definitions are here. That split is the
// same one errno has, and for the same reason: the names have to EXIST somewhere, and no unit of
// the program being compiled defines them.
//
// Short options only, which is what POSIX getopt is -- long options are getopt_long, a GNU
// extension, and nothing in the corpus asks for it. A program that did would get an unemittable
// call naming it, rather than a quiet wrong answer.

export const GETOPT_VARS = `
#include <getopt.h>
#include <string.h>
#include <stdio.h>

char *optarg = 0;
int optind = 1;
int opterr = 1;
int optopt = 0;

/* Where we are inside a cluster like -abc: 0 means "at the start of the next argv element". */
static int prism_optpos = 0;

int getopt(int argc, char * const argv[], const char *optstring)
{
    const char *spec;
    char c;

    if (optind == 0) { optind = 1; prism_optpos = 0; }      /* glibc's reinitialise convention */

    if (prism_optpos == 0) {
        if (optind >= argc) return -1;
        if (argv[optind] == 0) return -1;
        if (argv[optind][0] != '-' || argv[optind][1] == 0) return -1;   /* not an option, or "-" */
        if (argv[optind][1] == '-' && argv[optind][2] == 0) {            /* "--" ends the options */
            optind++;
            return -1;
        }
        prism_optpos = 1;
    }

    c = argv[optind][prism_optpos++];
    if (argv[optind][prism_optpos] == 0) { optind++; prism_optpos = 0; }

    spec = strchr(optstring, c);
    if (spec == 0 || c == ':') {
        optopt = c;
        if (opterr && optstring[0] != ':') fprintf(stderr, "illegal option -- %c\\n", c);
        return '?';
    }

    if (spec[1] != ':') return c;                            /* no argument wanted */

    /* An argument: the rest of this element if there is one, otherwise the next element. */
    if (prism_optpos != 0) {
        optarg = (char *)&argv[optind][prism_optpos];
        optind++;
        prism_optpos = 0;
        return c;
    }
    if (optind >= argc) {
        optopt = c;
        if (opterr && optstring[0] != ':') fprintf(stderr, "option requires an argument -- %c\\n", c);
        return optstring[0] == ':' ? ':' : '?';
    }
    optarg = (char *)argv[optind++];
    return c;
}
`;
