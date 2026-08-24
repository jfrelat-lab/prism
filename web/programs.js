// programs.js — what the shell can load, as DATA.
//
// The shell (index.html + app.js + worker.js) knows nothing about any particular program. It knows
// how to compile C, how to display an 8-bit framebuffer, and how to deliver scan codes. Everything
// specific to a program lives here, and every field mirrors what the program's own makefile says —
// a descriptor is a transcription, not a port.
//
// Adding a program means adding an entry, and a platform layer under src/env/ if it needs one.

export const PROGRAMS = {
  'mame-0.1': {
    title: 'MAME 0.1 (1997)',
    // The corpus lives outside the repository (it is gitignored); the dev server exposes it.
    root: 'corpus/mame01',
    // The makefile's own object list, minus the platform backend PRISM replaces.
    units: [
      'src/mame.c', 'src/common.c', 'src/machine.c', 'src/driver.c',
      'src/Z80/Z80.c',
      'src/pacman/machine.c', 'src/pacman/driver.c',
      'src/crush/machine.c', 'src/crush/driver.c',
      'src/pengo/machine.c', 'src/pengo/vidhrdw.c', 'src/pengo/sndhrdw.c', 'src/pengo/driver.c',
      'src/ladybug/machine.c', 'src/ladybug/vidhrdw.c', 'src/ladybug/sndhrdw.c',
      'src/ladybug/driver.c',
    ],
    includeDirs: ['src', 'src/Z80', 'src/msdos'],
    defines: { LSB_FIRST: '1' },      // NOT X86_ASM: that selects the x86 assembly path
    // The data half of the platform backend — ordinary objects with external linkage that
    // src/msdos/msdos.c would have defined. Written in C because that is what they are.
    extraUnits: {
      'prism-osd-vars.c':
        'int play_sound = 1;\n' +
        'int osd_joy_up = 0, osd_joy_down = 0, osd_joy_left = 0, osd_joy_right = 0;\n' +
        'int osd_joy_b1 = 0, osd_joy_b2 = 0, osd_joy_b3 = 0, osd_joy_b4 = 0;\n',
    },
    platform: 'mame-osd',
    memory: 256 * 1024 * 1024,
    argv: ['mame', 'pacman'],
    // Data files the program reads with fopen. Supplied by the user, never fetched: these are
    // copyrighted ROM images. The shell reads whatever the user hands it.
    needsData: {
      hint: 'Pac-Man ROM set — pacman.6e .6f .6h .6j, plus 5e/5f for the tiles',
      names: ['pacman.6e', 'pacman.6f', 'pacman.6h', 'pacman.6j', 'pacman.5e', 'pacman.5f'],
    },
    // What the program does with the keyboard, for the shell's own help line. Documentation only.
    // Read off src/pacman/machine.c (pacman_IN0_r / pacman_IN1_r) and src/machine.c, not from
    // habit: MAME 0.1's coin key is OSD_KEY_3, and a modern MAME's 5 does nothing here.
    controls: [
      ['3', 'insert coin'], ['1', 'start 1P'], ['2', 'start 2P'], ['arrows', 'move'],
      ['Ctrl', 'fire'], ['P', 'pause'], ['Tab', 'dip switches'], ['F3', 'reset'], ['Esc', 'quit'],
    ],
  },
};
