// splines-driver.cpp — exercises Enemy Territory's splines library (src/splines) and prints what it computes.
//
// PRISM's own file, not the game's: tools/gate-cxx-splines.mjs builds it with the library's unmodified
// sources twice, by g++ and by PRISM's C++ front end, and compares the output. Each block leans on a
// part of C++ the library uses: overloaded constructors and operators with temporaries (idStr),
// operators and conversion functions on small value classes (idVec3, angles_t, mat3_t, quat_t), and a
// class template with out-of-line members over three element types (idList).
#include <stdio.h>
#include "q_splineshared.h"
#include "util_list.h"
#include "util_str.h"

// splines.cpp defines this one; it is not linked here (it needs the engine), and idVec3's == uses it.
float Q_fabs( float f ) {
	return f < 0 ? -f : f;
}

static void pv( const char *what, const idVec3 &v ) {
	printf( "%s %.4f %.4f %.4f\n", what, v[0], v[1], v[2] );
}

static void strings() {
	idStr a( "Hello" ), b = "World", c;
	c = a + ", " + b;
	c += '!';
	idStr n( 42 ), f( 1.5f ), u( (unsigned)7 );
	printf( "%s|%d|%s|%s|%s\n", c.c_str(), c.length(), n.c_str(), f.c_str(), u.c_str() );
	idStr up = c, low = c;
	up.toupper();
	low.tolower();
	printf( "%s %s %d %d %d\n", up.c_str(), low.c_str(), up == low, up.icmp( low ), a != b );
	printf( "%c %d %d\n", c[1], c.icmpn( "HELLO", 5 ), idStr::cmp( "a", "b" ) );
	idStr path( "a\\b\\c" );
	path.BackSlashesToSlashes();
	idStr cut = path;
	cut.CapLength( 3 );
	printf( "%s %s %d %d %s\n", path.c_str(), cut.c_str(), idStr( "12.5" ).isNumeric(), idStr( "x1" ).isNumeric(),
			( a + 3 + 2.5f + 'c' + true ).c_str() );
	const char *raw = c;
	idStr d( c );
	d[0] = 'J';
	printf( "%s %s %d\n", raw, d.c_str(), c == d );
}

static void math() {
	idVec3 a( 1, 2, 3 ), b( -2, 0.5f, 4 ), c;
	c = a + b * 2 - ( -a );
	pv( "c", c );
	pv( "cross", a.Cross( b ) );
	printf( "dot %.4f len %.4f\n", a * b, c.Length() );
	c.Normalize();
	pv( "norm", c );
	c *= 3;
	c -= a;
	c += b;
	pv( "ops", c );
	printf( "eq %d %d\n", a == a, a != b );
	pv( "scaled", 2.0f * a );
	float *p = a;
	printf( "ptr %.1f %.1f\n", p[0], p[2] );

	angles_t ang( 30, 45, 10 );
	mat3_t m;
	toMatrix( ang, m );
	pv( "m0", m[0] );
	pv( "m1", m[1] );
	pv( "m2", m[2] );
	pv( "rotated", a * m );
	quat_t q;
	toQuat( m, q );
	printf( "quat %.4f %.4f %.4f %.4f\n", q.x, q.y, q.z, q.w );
	mat3_t back;
	toMatrix( q, back );
	pv( "back0", back[0] );
	angles_t ang2;
	toAngles( back, ang2 );
	printf( "angles %.3f %.3f %.3f\n", ang2.pitch, ang2.yaw, ang2.roll );
	pv( "forward", ang.toForward() );
	angles_t sum = ang + ang2 * 2.0f;
	sum.Normalize360();
	printf( "sum %.3f %.3f %.3f\n", sum.pitch, sum.yaw, sum.roll );
	m.Transpose();
	pv( "t0", m[0] );
}

static int cmpInt( const void *a, const void *b ) {
	return *(const int *)a - *(const int *)b;
}

static void lists() {
	idList<int> li( 2 );
	for ( int i = 0; i < 9; i++ ) {
		li.Append( ( i * 5 ) % 9 );
	}
	li.AddUnique( 3 );
	li.AddUnique( 100 );
	li.Sort( cmpInt );
	li.RemoveIndex( 0 );
	li.Remove( 100 );
	for ( int i = 0; i < li.Num(); i++ ) {
		printf( "%d ", li[i] );
	}
	int idx = -1;
	int *found = li.Find( 5, &idx );
	printf( "| %d %d %d\n", li.Num(), found ? *found : -1, idx );

	idList<idStr> ls;
	ls.Append( idStr( "one" ) );
	ls.Append( "two" );
	ls.Append( idStr( "three" ) + "!" );
	for ( int i = 0; i < ls.Num(); i++ ) {
		printf( "%s ", ls[i].c_str() );
	}
	idVec3 v( 1, 2, 3 );
	idList<idVec3 *> lp;
	lp.Append( &v );
	printf( "| %.1f %d\n", ( *lp[0] )[2], lp.Num() );
}

int main() {
	strings();
	math();
	lists();
	return 0;
}
