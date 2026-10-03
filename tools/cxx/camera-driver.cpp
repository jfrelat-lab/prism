// camera-driver.cpp — runs Enemy Territory's camera splines (src/splines/splines.cpp) on camera files.
//
// PRISM's own file, not the game's. ET's shipped data has no camera file, so the game never reaches
// this code; this driver does, through the three functions the engine itself calls (loadCamera,
// startCamera, getCameraInfo), standing in for the engine: the file system serves three camera
// files from memory and "writes" to stdout, the console prints, and the GL entry points splines.cpp
// can draw its debug paths with are null (nothing here draws).
//
// What it leans on: idCameraDef and its idList members, the idCameraPosition hierarchy (three
// classes overriding virtual parse/getPosition/write), new and delete of them, idStr temporaries
// through va(), and a global array of 64 idCameraDef constructed before main.
//
// tools/gate-cxx-camera.mjs builds it with the unmodified library by g++ and by PRISM and compares.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <ctype.h>
#include "q_splineshared.h"
#include "splines.h"

static const char *SPLINE_CAMERA =
	"cameraPathDef {\n"
	"\ttime 8\n"
	"\tcamera_spline {\n"
	"\t\ttime 0\n\t\ttype 2\n\t\tname cam\n\t\tbaseVelocity 100\n"
	"\t\ttarget {\n\t\t\tgranularity 0.025\n"
	"\t\t\t( 0 0 0 )\n\t\t\t( 100 0 50 )\n\t\t\t( 200 100 50 )\n\t\t\t( 300 100 0 )\n\t\t\t( 400 0 0 )\n\t\t\t( 500 -50 20 )\n"
	"\t\t}\n\t}\n"
	"\ttarget_fixed {\n\t\ttime 0\n\t\ttype 0\n\t\tname tgt\n\t\tbaseVelocity 0\n\t\tpos ( 200 300 20 )\n\t}\n"
	"\tfov {\n\t\tfov 90\n\t\tstartFOV 90\n\t\tendFOV 60\n\t\ttime 4000\n\t}\n"
	"}\n";

static const char *INTERPOLATED_CAMERA =
	"cameraPathDef {\n"
	"\ttime 4\n"
	"\tcamera_interpolated {\n\t\ttime 0\n\t\ttype 1\n\t\tname mover\n\t\tbaseVelocity 0\n"
	"\t\tstartPos ( 0 0 64 )\n\t\tendPos ( 512 256 128 )\n\t}\n"
	"\ttarget_interpolated {\n\t\ttime 0\n\t\ttype 1\n\t\tname look\n\t\tbaseVelocity 0\n"
	"\t\tstartPos ( 100 0 0 )\n\t\tendPos ( 0 100 50 )\n\t}\n"
	"\tfov {\n\t\tfov 75\n\t\tstartFOV 75\n\t\tendFOV 75\n\t\ttime 0\n\t}\n"
	"}\n";

static const char *FIXED_CAMERA =
	"cameraPathDef {\n"
	"\ttime 2\n"
	"\tcamera_fixed {\n\t\ttime 0\n\t\ttype 0\n\t\tname still\n\t\tbaseVelocity 0\n\t\tpos ( 10 20 30 )\n\t}\n"
	"\ttarget_fixed {\n\t\ttime 0\n\t\ttype 0\n\t\tname at\n\t\tbaseVelocity 0\n\t\tpos ( 10 120 30 )\n\t}\n"
	"}\n";

// ---- the engine, as far as splines.cpp and q_parse.cpp ask for it
extern "C" {
int FS_ReadFile( const char *qpath, void **buffer ) {
	const char *text = NULL;
	if ( !strcmp( qpath, "cameras/spline.camera" ) ) {
		text = SPLINE_CAMERA;
	} else if ( !strcmp( qpath, "cameras/interpolated.camera" ) ) {
		text = INTERPOLATED_CAMERA;
	} else if ( !strcmp( qpath, "cameras/fixed.camera" ) ) {
		text = FIXED_CAMERA;
	}
	if ( !text ) {
		*buffer = NULL;
		return -1;
	}
	char *copy = (char *)malloc( strlen( text ) + 1 );
	strcpy( copy, text );
	*buffer = copy;
	return (int)strlen( text );
}
void FS_FreeFile( void *buffer ) {
	free( buffer );
}
fileHandle_t FS_FOpenFileWrite( const char *filename ) {
	printf( "--- written to %s\n", filename );
	return 1;
}
int FS_Write( const void *buffer, int len, fileHandle_t h ) {
	fwrite( buffer, 1, len, stdout );
	return len;
}
void FS_FCloseFile( fileHandle_t f ) {
	printf( "--- closed\n" );
}
void Cbuf_AddText( const char *text ) {
	printf( "[command] %s\n", text );
}
void Cbuf_Execute( void ) {
}
void QDECL Com_Printf( const char *msg, ... ) {
	va_list ap;
	va_start( ap, msg );
	printf( "[console] " );
	vprintf( msg, ap );
	va_end( ap );
}
void QDECL Com_Error( int level, const char *error, ... ) {
	va_list ap;
	va_start( ap, error );
	printf( "[error %d] ", level );
	vprintf( error, ap );
	va_end( ap );
	printf( "\n" );
	exit( 3 );
}
int Q_stricmp( const char *s1, const char *s2 ) {
	for ( ; ; s1++, s2++ ) {
		int a = tolower( (unsigned char)*s1 ), b = tolower( (unsigned char)*s2 );
		if ( a != b ) {
			return a < b ? -1 : 1;
		}
		if ( !a ) {
			return 0;
		}
	}
}
void Q_strncpyz( char *dest, const char *src, int destsize ) {
	strncpy( dest, src, destsize - 1 );
	dest[destsize - 1] = 0;
}
void Q_strcat( char *dest, int size, const char *src ) {
	int l1 = (int)strlen( dest );
	Q_strncpyz( dest + l1, src, size - l1 );
}
char * QDECL va( char *format, ... ) {
	static char string[2][4096];
	static int index;
	va_list ap;
	char *buf = string[index & 1];
	index++;
	va_start( ap, format );
	vsprintf( buf, format, ap );
	va_end( ap );
	return buf;
}
qboolean loadCamera( int camNum, const char *name );
void startCamera( int camNum, int time );
qboolean getCameraInfo( int camNum, int time, float *origin, float *angles, float *fov );
}

// splines.cpp draws its debug paths through these; nothing here does.
void ( APIENTRY * qglBegin )( GLenum mode );
void ( APIENTRY * qglEnd )( void );
void ( APIENTRY * qglCallLists )( GLsizei n, GLenum type, const GLvoid *lists );
void ( APIENTRY * qglColor3fv )( const GLfloat *v );
void ( APIENTRY * qglPointSize )( GLfloat size );
void ( APIENTRY * qglRasterPos3fv )( const GLfloat *v );
void ( APIENTRY * qglVertex3f )( GLfloat x, GLfloat y, GLfloat z );
void ( APIENTRY * qglVertex3fv )( const GLfloat *v );

extern idCameraDef camera[];

static void run( int cam, const char *file, int t0, int step, int count ) {
	printf( "== %s: load %d\n", file, (int)loadCamera( cam, file ) );
	startCamera( cam, t0 );
	for ( int i = 0; i < count; i++ ) {
		float origin[3] = { 0, 0, 0 }, angles[3] = { 0, 0, 0 }, fov = 0;
		int ok = (int)getCameraInfo( cam, t0 + i * step, origin, angles, &fov );
		printf( "t=%5d ok=%d origin %8.2f %8.2f %8.2f angles %7.2f %7.2f fov %6.2f\n", t0 + i * step, ok,
				origin[0], origin[1], origin[2], angles[0], angles[1], fov );
	}
}

int main() {
	run( 1, "cameras/spline.camera", 1000, 750, 13 );
	run( 2, "cameras/interpolated.camera", 0, 500, 10 );
	run( 3, "cameras/fixed.camera", 250, 600, 5 );
	printf( "== missing: load %d\n", (int)loadCamera( 4, "cameras/none.camera" ) );
	printf( "== out of range: load %d info %d\n", (int)loadCamera( 64, "cameras/fixed.camera" ), (int)getCameraInfo( -1, 0, NULL, NULL, NULL ) );
	// Loading again over a camera frees what it held (its positions, targets and events).
	printf( "== reload: %d\n", (int)loadCamera( 1, "cameras/interpolated.camera" ) );
	camera[1].save( "cameras/saved.camera" );
	printf( "targets %d total %.2f\n", camera[2].numTargets(), camera[2].getTotalTime() );
	return 0;
}
