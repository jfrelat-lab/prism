// dj.js — the DOS sound library Jump 'n Bump links against, shimmed at the library boundary.
//
// WHY A SHIM AND NOT A COMPILE. `dj` ships in the original tree as `dos/libdj.a` and nothing else:
// there is no source for it anywhere in the project's history. The binary names its own six
// translation units -- dj.c, mixer.c, mod.c, sb.c, sb_dma.c, sfx.c -- a Sound Blaster DMA mixer with
// MOD playback, and none of them survived. That is the Allegro and SEAL situation exactly (P1.7):
// the library is a boundary, so it is answered rather than rebuilt, and the GAME's own C is
// compiled untouched on the other side of it.
//
// SILENT, AND THAT IS THE LIBRARY'S OWN OPTION. `dj_set_nosound` is part of the API and main.c
// calls it, so a build with no audio is a switch dj offers rather than something invented here.
// (`NOSOUND` is not the switch: it appears in the later SDL ports' config.h and is tested nowhere in
// any of this code.) What this file does NOT do is mix a MOD or a sample -- when sound arrives it
// belongs on src/env/dsp.js, next to SEAL's mixer, and the frame that plays it is a measurement
// nobody has taken yet.
//
// THE RETURN CONVENTION IS MEASURED, not assumed. Of the 26 functions the game calls, exactly two
// have their result read -- `dj_load_mod` and `dj_load_sfx`, both tested `!= 0` into an error path
// that gives up on the file. So zero is success, and the other twenty-four are called as statements
// whose result is never looked at.

/**
 * Install the dj API.
 *
 * Every entry answers success and silence. The three that take a pointer leave the memory alone:
 * the game writes those structures itself before passing them, and reads nothing back that it did
 * not put there.
 */
export function installDj(M) {
  const ok = () => 0;
  const nothing = () => {};
  const api = {
    // --- lifecycle
    dj_init: ok,
    dj_deinit: nothing,
    dj_start: nothing,
    dj_stop: nothing,
    dj_autodetect_sd: ok,

    // --- mixer settings. dj_set_mixing_freq answers with the frequency it was handed, which is
    // what a real mixer does when it can honour the request exactly.
    dj_set_mixing_freq: (freq) => freq,
    dj_set_stereo: ok,
    dj_set_auto_mix: nothing,
    dj_set_dma_time: nothing,
    dj_get_mixing_info: ok,
    dj_mix: nothing,
    dj_mix_needed: ok,

    // --- modules
    dj_load_mod: ok,
    dj_free_mod: nothing,
    dj_ready_mod: ok,
    dj_start_mod: ok,
    dj_stop_mod: nothing,
    dj_set_mod_volume: nothing,

    // --- samples
    dj_load_sfx: ok,
    dj_free_sfx: nothing,
    dj_play_sfx: nothing,
    dj_stop_sfx_channel: nothing,
    dj_set_num_sfx_channels: ok,
    dj_set_sfx_volume: nothing,
    dj_set_sfx_channel_volume: nothing,
    dj_get_sfx_settings: ok,
    dj_set_sfx_settings: ok,

    // --- and the switch this build stands on
    dj_set_nosound: nothing,
  };
  Object.assign(M.rt, api);
  return api;
}

/*
 * The THIRD thing, without which the other two are invisible.
 *
 * A runtime function needs a declaration the program can see, an implementation, AND an entry in
 * compile.js's BUILTINS table. Miss the table and the call is emitted as a lookup through F on a
 * name nothing defines, so the CALLER becomes the thing that fails -- and the build reports the
 * symbol as undefined even though the shim beside it is complete. The signatures come from the
 * program's own dos/dj.h; `char` returns are INT here because that is the width a call site reads.
 */
export function djBuiltins(T) {
  const P = T.ptr(T.CHAR), I = T.INT, U = T.UINT, V = T.VOID;
  const f = (ret, ...params) => ({ ret, params });
  return {
    dj_init: f(I), dj_deinit: f(V), dj_start: f(V), dj_stop: f(V),
    dj_autodetect_sd: f(I),

    dj_set_mixing_freq: f(U, U), dj_set_stereo: f(I, I),
    dj_set_auto_mix: f(V, I), dj_set_dma_time: f(V, U),
    dj_get_mixing_info: f(I, P), dj_mix: f(V), dj_mix_needed: f(I),

    dj_load_mod: f(I, P, P, I), dj_free_mod: f(V, I), dj_ready_mod: f(I, I),
    dj_start_mod: f(I), dj_stop_mod: f(V), dj_set_mod_volume: f(V, I),

    dj_load_sfx: f(I, P, P, I, I, U), dj_free_sfx: f(V, U),
    dj_play_sfx: f(V, U, U, I, I, U, I), dj_stop_sfx_channel: f(V, I),
    dj_set_num_sfx_channels: f(I, I), dj_set_sfx_volume: f(V, I),
    dj_set_sfx_channel_volume: f(V, I, I),
    dj_get_sfx_settings: f(I, U, P), dj_set_sfx_settings: f(I, U, P),

    dj_set_nosound: f(V, I),
  };
}
