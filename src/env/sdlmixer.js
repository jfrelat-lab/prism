// sdlmixer.js — SDL_mixer, shared by the SDL 1.2 and SDL 2 environments.
//
// SDL_mixer is its OWN library, not part of SDL, and across the two SDL majors it did not change
// where these thirteen entry points are concerned. That is measured rather than assumed: the same
// prototypes were compiled beside the genuine headers of BOTH libsdl-mixer1.2-dev and
// libsdl2-mixer-dev, and a conflicting declaration is a compile error, so the file building twice
// IS the agreement. MIX_DEFAULT_FORMAT is 0x8010 and MIX_MAX_VOLUME is 128 in both.
//
// So it lives in one place and both environments name it. envHeaders() allows that on purpose: it
// refuses two environments that supply one header with DIFFERENT text, and identical text is not a
// conflict -- which is exactly the case a shared satellite library makes.
//
// WHAT IS HERE IS WHAT corpus/jumpnbump-sdl12 AND corpus/jumpnbump-sdl2 CALL, both of them the
// same thirteen. Sound is SILENT: Mix_LoadMUS returns NULL and the program copes -- it prints
// "Couldn't load music" and plays on -- which is the library's own failure path rather than an
// invented switch. The mixing callback is recorded and can be pulled; see pumpMixer.

export const MIXER_HEADERS = {
  'SDL_mixer.h': `
#ifndef _SDL_mixer_h
#define _SDL_mixer_h
#define MIX_DEFAULT_FORMAT 0x8010
#define MIX_MAX_VOLUME 128
typedef struct _Mix_Music Mix_Music;
int Mix_OpenAudio(int frequency, Uint16 format, int channels, int chunksize);
void Mix_CloseAudio(void);
int Mix_QuerySpec(int *frequency, Uint16 *format, int *channels);
void Mix_SetPostMix(void (*mix_func)(void *udata, Uint8 *stream, int len), void *arg);
Mix_Music *Mix_LoadMUS(const char *file);
void Mix_FreeMusic(Mix_Music *music);
int Mix_PlayMusic(Mix_Music *music, int loops);
int Mix_VolumeMusic(int volume);
int Mix_HaltMusic(void);
int Mix_FadeOutMusic(int ms);
int Mix_PlayingMusic(void);
int Mix_SetMusicCMD(const char *command);
#endif
`,
  'SDL2/SDL_mixer.h': null,   // filled in below; the two names serve one text
};
MIXER_HEADERS['SDL2/SDL_mixer.h'] = MIXER_HEADERS['SDL_mixer.h'];

/**
 * The implementations, over a `state` the caller owns — so an environment can keep the mixer's
 * bookkeeping beside its own rather than in a second place that has to be kept in step.
 */
export function mixerApi(M, state) {
  const dv = () => M.mod.dv;
  return {
    Mix_OpenAudio: () => { state.audioOpen = true; return 0; },
    Mix_CloseAudio: () => { state.audioOpen = false; },
    Mix_QuerySpec: (freq, fmt, ch) => {
      const d = dv();
      if (freq) d.setInt32(freq, 44100, true);
      if (fmt) d.setUint16(fmt, 0x8010, true);   // MIX_DEFAULT_FORMAT, as both headers define it
      if (ch) d.setInt32(ch, 2, true);
      return state.audioOpen ? 1 : 0;
    },
    Mix_SetPostMix: (fn, arg) => { state.postMix = fn | 0; state.postMixArg = arg | 0; },
    Mix_LoadMUS: () => 0,
    Mix_FreeMusic: () => 0,
    Mix_PlayMusic: () => { state.musicPlaying = true; return 0; },
    Mix_PlayingMusic: () => (state.musicPlaying ? 1 : 0),
    Mix_HaltMusic: () => { state.musicPlaying = false; return 0; },
    Mix_FadeOutMusic: () => { state.musicPlaying = false; return 1; },
    Mix_VolumeMusic: (v) => {
      const was = state.musicVolume;
      if ((v | 0) >= 0) state.musicVolume = v | 0;
      return was;
    },
    Mix_SetMusicCMD: () => 0,
  };
}

/** Pull the recorded mixing callback, the way a host with no audio thread has to. */
export function pumpMixer(M, state, buffer, bytes) {
  if (!state.postMix) return 0;
  M.icall(state.postMix, [state.postMixArg, buffer, bytes]);
  return bytes;
}

/** The fields mixerApi reads and writes, for an environment building its own state object. */
export const MIXER_STATE = {
  postMix: 0, postMixArg: 0, audioOpen: false, musicPlaying: false, musicVolume: 128,
};

export function mixerBuiltins(T) {
  const V = T.VOID, I = T.INT, P = T.ptr(T.CHAR);
  const f = (ret, ...params) => ({ ret, params });
  return {
    Mix_OpenAudio: f(I, I, T.USHORT, I, I),
    Mix_CloseAudio: f(V),
    Mix_QuerySpec: f(I, P, P, P),
    Mix_SetPostMix: f(V, P, P),
    Mix_LoadMUS: f(P, P),
    Mix_FreeMusic: f(V, P),
    Mix_PlayMusic: f(I, P, I),
    Mix_PlayingMusic: f(I),
    Mix_HaltMusic: f(I),
    Mix_FadeOutMusic: f(I, I),
    Mix_VolumeMusic: f(I, I),
    Mix_SetMusicCMD: f(I, P),
  };
}
