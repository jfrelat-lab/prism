// headers-openal.js — <AL/al.h> and <AL/alc.h>, OpenAL 1.1 as the specification declares it: the headers a Linux
// system's OpenAL puts in /usr/include/AL.
//
// Doom 3's Linux build includes them and links no OpenAL: openal/stubs.cpp defines every entry point it calls to
// answer "no device", and its sound goes to OSS (sys/linux/sound.cpp). So these are declarations only; nothing
// here plays a sound. (Its Windows build uses the headers it ships, openal/include, which spell __cdecl.)

export const AL_H = `#ifndef _PRISM_AL_H
#define _PRISM_AL_H
#define AL_API
#define AL_APIENTRY
/* the 1.0 names 1.1 still defines, deprecated: EAX's headers look for OPENAL to take their OpenAL branch */
#define OPENAL
#define ALAPI AL_API
#define ALAPIENTRY AL_APIENTRY
#define AL_INVALID (-1)
#define AL_ILLEGAL_ENUM AL_INVALID_ENUM
#define AL_ILLEGAL_COMMAND AL_INVALID_OPERATION
typedef char ALboolean;
typedef char ALchar;
typedef signed char ALbyte;
typedef unsigned char ALubyte;
typedef short ALshort;
typedef unsigned short ALushort;
typedef int ALint;
typedef unsigned int ALuint;
typedef int ALsizei;
typedef int ALenum;
typedef float ALfloat;
typedef double ALdouble;
typedef void ALvoid;
#define AL_NONE 0
#define AL_FALSE 0
#define AL_TRUE 1
#define AL_SOURCE_RELATIVE 0x202
#define AL_CONE_INNER_ANGLE 0x1001
#define AL_CONE_OUTER_ANGLE 0x1002
#define AL_PITCH 0x1003
#define AL_POSITION 0x1004
#define AL_DIRECTION 0x1005
#define AL_VELOCITY 0x1006
#define AL_LOOPING 0x1007
#define AL_BUFFER 0x1009
#define AL_GAIN 0x100A
#define AL_MIN_GAIN 0x100D
#define AL_MAX_GAIN 0x100E
#define AL_ORIENTATION 0x100F
#define AL_SOURCE_STATE 0x1010
#define AL_INITIAL 0x1011
#define AL_PLAYING 0x1012
#define AL_PAUSED 0x1013
#define AL_STOPPED 0x1014
#define AL_BUFFERS_QUEUED 0x1015
#define AL_BUFFERS_PROCESSED 0x1016
#define AL_SEC_OFFSET 0x1024
#define AL_SAMPLE_OFFSET 0x1025
#define AL_BYTE_OFFSET 0x1026
#define AL_SOURCE_TYPE 0x1027
#define AL_STATIC 0x1028
#define AL_STREAMING 0x1029
#define AL_UNDETERMINED 0x1030
#define AL_FORMAT_MONO8 0x1100
#define AL_FORMAT_MONO16 0x1101
#define AL_FORMAT_STEREO8 0x1102
#define AL_FORMAT_STEREO16 0x1103
#define AL_REFERENCE_DISTANCE 0x1020
#define AL_ROLLOFF_FACTOR 0x1021
#define AL_CONE_OUTER_GAIN 0x1022
#define AL_MAX_DISTANCE 0x1023
#define AL_FREQUENCY 0x2001
#define AL_BITS 0x2002
#define AL_CHANNELS 0x2003
#define AL_SIZE 0x2004
#define AL_UNUSED 0x2010
#define AL_PENDING 0x2011
#define AL_PROCESSED 0x2012
#define AL_NO_ERROR 0
#define AL_INVALID_NAME 0xA001
#define AL_INVALID_ENUM 0xA002
#define AL_INVALID_VALUE 0xA003
#define AL_INVALID_OPERATION 0xA004
#define AL_OUT_OF_MEMORY 0xA005
#define AL_VENDOR 0xB001
#define AL_VERSION 0xB002
#define AL_RENDERER 0xB003
#define AL_EXTENSIONS 0xB004
#define AL_DOPPLER_FACTOR 0xC000
#define AL_DOPPLER_VELOCITY 0xC001
#define AL_SPEED_OF_SOUND 0xC003
#define AL_DISTANCE_MODEL 0xD000
#define AL_INVERSE_DISTANCE 0xD001
#define AL_INVERSE_DISTANCE_CLAMPED 0xD002
#define AL_LINEAR_DISTANCE 0xD003
#define AL_LINEAR_DISTANCE_CLAMPED 0xD004
#define AL_EXPONENT_DISTANCE 0xD005
#define AL_EXPONENT_DISTANCE_CLAMPED 0xD006
AL_API void AL_APIENTRY alEnable(ALenum capability);
AL_API void AL_APIENTRY alDisable(ALenum capability);
AL_API ALboolean AL_APIENTRY alIsEnabled(ALenum capability);
AL_API const ALchar *AL_APIENTRY alGetString(ALenum param);
AL_API void AL_APIENTRY alGetBooleanv(ALenum param, ALboolean *data);
AL_API void AL_APIENTRY alGetIntegerv(ALenum param, ALint *data);
AL_API void AL_APIENTRY alGetFloatv(ALenum param, ALfloat *data);
AL_API void AL_APIENTRY alGetDoublev(ALenum param, ALdouble *data);
AL_API ALboolean AL_APIENTRY alGetBoolean(ALenum param);
AL_API ALint AL_APIENTRY alGetInteger(ALenum param);
AL_API ALfloat AL_APIENTRY alGetFloat(ALenum param);
AL_API ALdouble AL_APIENTRY alGetDouble(ALenum param);
AL_API ALenum AL_APIENTRY alGetError(void);
AL_API ALboolean AL_APIENTRY alIsExtensionPresent(const ALchar *extname);
AL_API void *AL_APIENTRY alGetProcAddress(const ALchar *fname);
AL_API ALenum AL_APIENTRY alGetEnumValue(const ALchar *ename);
AL_API void AL_APIENTRY alListenerf(ALenum param, ALfloat value);
AL_API void AL_APIENTRY alListener3f(ALenum param, ALfloat value1, ALfloat value2, ALfloat value3);
AL_API void AL_APIENTRY alListenerfv(ALenum param, const ALfloat *values);
AL_API void AL_APIENTRY alListeneri(ALenum param, ALint value);
AL_API void AL_APIENTRY alListener3i(ALenum param, ALint value1, ALint value2, ALint value3);
AL_API void AL_APIENTRY alListeneriv(ALenum param, const ALint *values);
AL_API void AL_APIENTRY alGetListenerf(ALenum param, ALfloat *value);
AL_API void AL_APIENTRY alGetListener3f(ALenum param, ALfloat *value1, ALfloat *value2, ALfloat *value3);
AL_API void AL_APIENTRY alGetListenerfv(ALenum param, ALfloat *values);
AL_API void AL_APIENTRY alGetListeneri(ALenum param, ALint *value);
AL_API void AL_APIENTRY alGetListener3i(ALenum param, ALint *value1, ALint *value2, ALint *value3);
AL_API void AL_APIENTRY alGetListeneriv(ALenum param, ALint *values);
AL_API void AL_APIENTRY alGenSources(ALsizei n, ALuint *sources);
AL_API void AL_APIENTRY alDeleteSources(ALsizei n, const ALuint *sources);
AL_API ALboolean AL_APIENTRY alIsSource(ALuint source);
AL_API void AL_APIENTRY alSourcef(ALuint source, ALenum param, ALfloat value);
AL_API void AL_APIENTRY alSource3f(ALuint source, ALenum param, ALfloat value1, ALfloat value2, ALfloat value3);
AL_API void AL_APIENTRY alSourcefv(ALuint source, ALenum param, const ALfloat *values);
AL_API void AL_APIENTRY alSourcei(ALuint source, ALenum param, ALint value);
AL_API void AL_APIENTRY alSource3i(ALuint source, ALenum param, ALint value1, ALint value2, ALint value3);
AL_API void AL_APIENTRY alSourceiv(ALuint source, ALenum param, const ALint *values);
AL_API void AL_APIENTRY alGetSourcef(ALuint source, ALenum param, ALfloat *value);
AL_API void AL_APIENTRY alGetSource3f(ALuint source, ALenum param, ALfloat *value1, ALfloat *value2, ALfloat *value3);
AL_API void AL_APIENTRY alGetSourcefv(ALuint source, ALenum param, ALfloat *values);
AL_API void AL_APIENTRY alGetSourcei(ALuint source, ALenum param, ALint *value);
AL_API void AL_APIENTRY alGetSource3i(ALuint source, ALenum param, ALint *value1, ALint *value2, ALint *value3);
AL_API void AL_APIENTRY alGetSourceiv(ALuint source, ALenum param, ALint *values);
AL_API void AL_APIENTRY alSourcePlayv(ALsizei n, const ALuint *sources);
AL_API void AL_APIENTRY alSourceStopv(ALsizei n, const ALuint *sources);
AL_API void AL_APIENTRY alSourceRewindv(ALsizei n, const ALuint *sources);
AL_API void AL_APIENTRY alSourcePausev(ALsizei n, const ALuint *sources);
AL_API void AL_APIENTRY alSourcePlay(ALuint source);
AL_API void AL_APIENTRY alSourceStop(ALuint source);
AL_API void AL_APIENTRY alSourceRewind(ALuint source);
AL_API void AL_APIENTRY alSourcePause(ALuint source);
AL_API void AL_APIENTRY alSourceQueueBuffers(ALuint source, ALsizei nb, const ALuint *buffers);
AL_API void AL_APIENTRY alSourceUnqueueBuffers(ALuint source, ALsizei nb, ALuint *buffers);
AL_API void AL_APIENTRY alGenBuffers(ALsizei n, ALuint *buffers);
AL_API void AL_APIENTRY alDeleteBuffers(ALsizei n, const ALuint *buffers);
AL_API ALboolean AL_APIENTRY alIsBuffer(ALuint buffer);
AL_API void AL_APIENTRY alBufferData(ALuint buffer, ALenum format, const ALvoid *data, ALsizei size, ALsizei freq);
AL_API void AL_APIENTRY alBufferf(ALuint buffer, ALenum param, ALfloat value);
AL_API void AL_APIENTRY alBufferi(ALuint buffer, ALenum param, ALint value);
AL_API void AL_APIENTRY alGetBufferf(ALuint buffer, ALenum param, ALfloat *value);
AL_API void AL_APIENTRY alGetBufferi(ALuint buffer, ALenum param, ALint *value);
AL_API void AL_APIENTRY alDopplerFactor(ALfloat value);
AL_API void AL_APIENTRY alDopplerVelocity(ALfloat value);
AL_API void AL_APIENTRY alSpeedOfSound(ALfloat value);
AL_API void AL_APIENTRY alDistanceModel(ALenum distanceModel);
#endif
`;

export const ALC_H = `#ifndef _PRISM_ALC_H
#define _PRISM_ALC_H
#define ALC_API
#define ALC_APIENTRY
#define ALCAPI ALC_API
#define ALCAPIENTRY ALC_APIENTRY
#define ALC_INVALID 0
#define ALC_VERSION_0_1 1
typedef struct ALCdevice_struct ALCdevice;
typedef struct ALCcontext_struct ALCcontext;
typedef char ALCboolean;
typedef char ALCchar;
typedef signed char ALCbyte;
typedef unsigned char ALCubyte;
typedef short ALCshort;
typedef unsigned short ALCushort;
typedef int ALCint;
typedef unsigned int ALCuint;
typedef int ALCsizei;
typedef int ALCenum;
typedef float ALCfloat;
typedef double ALCdouble;
typedef void ALCvoid;
#define ALC_FALSE 0
#define ALC_TRUE 1
#define ALC_FREQUENCY 0x1007
#define ALC_REFRESH 0x1008
#define ALC_SYNC 0x1009
#define ALC_MONO_SOURCES 0x1010
#define ALC_STEREO_SOURCES 0x1011
#define ALC_NO_ERROR 0
#define ALC_INVALID_DEVICE 0xA001
#define ALC_INVALID_CONTEXT 0xA002
#define ALC_INVALID_ENUM 0xA003
#define ALC_INVALID_VALUE 0xA004
#define ALC_OUT_OF_MEMORY 0xA005
#define ALC_DEFAULT_DEVICE_SPECIFIER 0x1004
#define ALC_DEVICE_SPECIFIER 0x1005
#define ALC_EXTENSIONS 0x1006
#define ALC_MAJOR_VERSION 0x1000
#define ALC_MINOR_VERSION 0x1001
#define ALC_ATTRIBUTES_SIZE 0x1002
#define ALC_ALL_ATTRIBUTES 0x1003
#define ALC_CAPTURE_DEVICE_SPECIFIER 0x310
#define ALC_CAPTURE_DEFAULT_DEVICE_SPECIFIER 0x311
#define ALC_CAPTURE_SAMPLES 0x312
ALC_API ALCcontext *ALC_APIENTRY alcCreateContext(ALCdevice *device, const ALCint *attrlist);
ALC_API ALCboolean ALC_APIENTRY alcMakeContextCurrent(ALCcontext *context);
ALC_API void ALC_APIENTRY alcProcessContext(ALCcontext *context);
ALC_API void ALC_APIENTRY alcSuspendContext(ALCcontext *context);
ALC_API void ALC_APIENTRY alcDestroyContext(ALCcontext *context);
ALC_API ALCcontext *ALC_APIENTRY alcGetCurrentContext(void);
ALC_API ALCdevice *ALC_APIENTRY alcGetContextsDevice(ALCcontext *context);
ALC_API ALCdevice *ALC_APIENTRY alcOpenDevice(const ALCchar *devicename);
ALC_API ALCboolean ALC_APIENTRY alcCloseDevice(ALCdevice *device);
ALC_API ALCenum ALC_APIENTRY alcGetError(ALCdevice *device);
ALC_API ALCboolean ALC_APIENTRY alcIsExtensionPresent(ALCdevice *device, const ALCchar *extname);
ALC_API void *ALC_APIENTRY alcGetProcAddress(ALCdevice *device, const ALCchar *funcname);
ALC_API ALCenum ALC_APIENTRY alcGetEnumValue(ALCdevice *device, const ALCchar *enumname);
ALC_API const ALCchar *ALC_APIENTRY alcGetString(ALCdevice *device, ALCenum param);
ALC_API void ALC_APIENTRY alcGetIntegerv(ALCdevice *device, ALCenum param, ALCsizei size, ALCint *values);
ALC_API ALCdevice *ALC_APIENTRY alcCaptureOpenDevice(const ALCchar *devicename, ALCuint frequency, ALCenum format, ALCsizei buffersize);
ALC_API ALCboolean ALC_APIENTRY alcCaptureCloseDevice(ALCdevice *device);
ALC_API void ALC_APIENTRY alcCaptureStart(ALCdevice *device);
ALC_API void ALC_APIENTRY alcCaptureStop(ALCdevice *device);
ALC_API void ALC_APIENTRY alcCaptureSamples(ALCdevice *device, ALCvoid *buffer, ALCsizei samples);
#endif
`;

export const OPENAL_HEADERS = { 'AL/al.h': AL_H, 'AL/alc.h': ALC_H };
