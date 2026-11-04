// headers-mmx.js — <mmintrin.h> and <xmmintrin.h>: the MMX intrinsics, and the integer MMX ones SSE
// added, written in C.
//
// .kkrieger's genbitmap.cpp blurs with them (_mm_madd_pi16, _mm_packs_pi32, _mm_mulhi_pu16...). Each
// is the instruction it names, lane by lane, as the Intel SDM defines it; tools/gate-mmintrin.mjs
// runs every one against gcc's own headers (-mmmx -msse) on edge and random operands.
//
// __m64 is Visual C++'s: a union of the lane views, under the member names its <mmintrin.h> gives
// them (m64_u64, m64_i16...). gcc's is a vector type, which C cannot spell; a union is what a
// program can do with one -- copy it, cast a pointer to it, pass it -- and no lane is ever read
// through the 64-bit member here, which in PRISM would be a BigInt. The MMX registers themselves
// are not involved: an intrinsic is a value computation, and _mm_empty has nothing to empty.
//
// Only these are declared. An intrinsic not written here is an undeclared function -- refused at
// compile time, by name -- never something approximated.

export const MMINTRIN_H = `#ifndef _PRISM_MMINTRIN_H
#define _PRISM_MMINTRIN_H
typedef union __m64 {
  unsigned long long m64_u64; float m64_f32[2];
  signed char m64_i8[8]; short m64_i16[4]; int m64_i32[2]; long long m64_i64;
  unsigned char m64_u8[8]; unsigned short m64_u16[4]; unsigned int m64_u32[2];
} __m64;

static __inline signed char __prism_ss8(int v) { return (signed char)(v < -128 ? -128 : v > 127 ? 127 : v); }
static __inline unsigned char __prism_us8(int v) { return (unsigned char)(v < 0 ? 0 : v > 255 ? 255 : v); }
static __inline short __prism_ss16(int v) { return (short)(v < -32768 ? -32768 : v > 32767 ? 32767 : v); }
static __inline unsigned short __prism_us16(int v) { return (unsigned short)(v < 0 ? 0 : v > 65535 ? 65535 : v); }
/* A shift count held in an __m64: all 64 bits of it, so anything past 32 bits is "too far". */
static __inline unsigned int __prism_count(__m64 c) { return c.m64_u32[1] ? 0xffffffffu : c.m64_u32[0]; }

static __inline void _mm_empty(void) {}
static __inline __m64 _mm_setzero_si64(void) { __m64 r; r.m64_u32[0] = 0; r.m64_u32[1] = 0; return r; }
static __inline __m64 _mm_cvtsi32_si64(int i) { __m64 r; r.m64_i32[0] = i; r.m64_i32[1] = 0; return r; }
static __inline int _mm_cvtsi64_si32(__m64 m) { return m.m64_i32[0]; }
static __inline __m64 _mm_set_pi32(int e1, int e0) { __m64 r; r.m64_i32[0] = e0; r.m64_i32[1] = e1; return r; }
static __inline __m64 _mm_set_pi16(short e3, short e2, short e1, short e0) {
  __m64 r; r.m64_i16[0] = e0; r.m64_i16[1] = e1; r.m64_i16[2] = e2; r.m64_i16[3] = e3; return r; }
static __inline __m64 _mm_set_pi8(char e7, char e6, char e5, char e4, char e3, char e2, char e1, char e0) {
  __m64 r; r.m64_i8[0] = e0; r.m64_i8[1] = e1; r.m64_i8[2] = e2; r.m64_i8[3] = e3;
  r.m64_i8[4] = e4; r.m64_i8[5] = e5; r.m64_i8[6] = e6; r.m64_i8[7] = e7; return r; }
static __inline __m64 _mm_setr_pi32(int e0, int e1) { return _mm_set_pi32(e1, e0); }
static __inline __m64 _mm_setr_pi16(short e0, short e1, short e2, short e3) { return _mm_set_pi16(e3, e2, e1, e0); }
static __inline __m64 _mm_setr_pi8(char e0, char e1, char e2, char e3, char e4, char e5, char e6, char e7) {
  return _mm_set_pi8(e7, e6, e5, e4, e3, e2, e1, e0); }
static __inline __m64 _mm_set1_pi32(int a) { return _mm_set_pi32(a, a); }
static __inline __m64 _mm_set1_pi16(short a) { return _mm_set_pi16(a, a, a, a); }
static __inline __m64 _mm_set1_pi8(char a) { return _mm_set_pi8(a, a, a, a, a, a, a, a); }

/* Wrapping and saturating arithmetic. */
#define __PRISM_LANES(name, n, view, expr) \\
  static __inline __m64 name(__m64 a, __m64 b) { __m64 r; int k; for (k = 0; k < n; k++) r.view[k] = expr; return r; }
__PRISM_LANES(_mm_add_pi8, 8, m64_u8, (unsigned char)(a.m64_u8[k] + b.m64_u8[k]))
__PRISM_LANES(_mm_add_pi16, 4, m64_u16, (unsigned short)(a.m64_u16[k] + b.m64_u16[k]))
__PRISM_LANES(_mm_add_pi32, 2, m64_u32, a.m64_u32[k] + b.m64_u32[k])
__PRISM_LANES(_mm_adds_pi8, 8, m64_i8, __prism_ss8(a.m64_i8[k] + b.m64_i8[k]))
__PRISM_LANES(_mm_adds_pi16, 4, m64_i16, __prism_ss16(a.m64_i16[k] + b.m64_i16[k]))
__PRISM_LANES(_mm_adds_pu8, 8, m64_u8, __prism_us8(a.m64_u8[k] + b.m64_u8[k]))
__PRISM_LANES(_mm_adds_pu16, 4, m64_u16, __prism_us16(a.m64_u16[k] + b.m64_u16[k]))
__PRISM_LANES(_mm_sub_pi8, 8, m64_u8, (unsigned char)(a.m64_u8[k] - b.m64_u8[k]))
__PRISM_LANES(_mm_sub_pi16, 4, m64_u16, (unsigned short)(a.m64_u16[k] - b.m64_u16[k]))
__PRISM_LANES(_mm_sub_pi32, 2, m64_u32, a.m64_u32[k] - b.m64_u32[k])
__PRISM_LANES(_mm_subs_pi8, 8, m64_i8, __prism_ss8(a.m64_i8[k] - b.m64_i8[k]))
__PRISM_LANES(_mm_subs_pi16, 4, m64_i16, __prism_ss16(a.m64_i16[k] - b.m64_i16[k]))
__PRISM_LANES(_mm_subs_pu8, 8, m64_u8, __prism_us8(a.m64_u8[k] - b.m64_u8[k]))
__PRISM_LANES(_mm_subs_pu16, 4, m64_u16, __prism_us16(a.m64_u16[k] - b.m64_u16[k]))
__PRISM_LANES(_mm_mullo_pi16, 4, m64_u16, (unsigned short)(a.m64_i16[k] * b.m64_i16[k]))
__PRISM_LANES(_mm_mulhi_pi16, 4, m64_i16, (short)((a.m64_i16[k] * b.m64_i16[k]) >> 16))
__PRISM_LANES(_mm_and_si64, 2, m64_u32, a.m64_u32[k] & b.m64_u32[k])
__PRISM_LANES(_mm_andnot_si64, 2, m64_u32, ~a.m64_u32[k] & b.m64_u32[k])
__PRISM_LANES(_mm_or_si64, 2, m64_u32, a.m64_u32[k] | b.m64_u32[k])
__PRISM_LANES(_mm_xor_si64, 2, m64_u32, a.m64_u32[k] ^ b.m64_u32[k])
__PRISM_LANES(_mm_cmpeq_pi8, 8, m64_u8, a.m64_u8[k] == b.m64_u8[k] ? 0xff : 0)
__PRISM_LANES(_mm_cmpeq_pi16, 4, m64_u16, a.m64_u16[k] == b.m64_u16[k] ? 0xffff : 0)
__PRISM_LANES(_mm_cmpeq_pi32, 2, m64_u32, a.m64_u32[k] == b.m64_u32[k] ? 0xffffffffu : 0)
__PRISM_LANES(_mm_cmpgt_pi8, 8, m64_u8, a.m64_i8[k] > b.m64_i8[k] ? 0xff : 0)
__PRISM_LANES(_mm_cmpgt_pi16, 4, m64_u16, a.m64_i16[k] > b.m64_i16[k] ? 0xffff : 0)
__PRISM_LANES(_mm_cmpgt_pi32, 2, m64_u32, a.m64_i32[k] > b.m64_i32[k] ? 0xffffffffu : 0)
/* Two products summed: -32768 * -32768 twice is 2^31, which wraps to INT_MIN, as pmaddwd gives. */
static __inline __m64 _mm_madd_pi16(__m64 a, __m64 b) {
  __m64 r; int k;
  for (k = 0; k < 2; k++) r.m64_u32[k] = (unsigned int)(a.m64_i16[2 * k] * b.m64_i16[2 * k]) + (unsigned int)(a.m64_i16[2 * k + 1] * b.m64_i16[2 * k + 1]);
  return r; }

/* Shifts: by an immediate, or by the 64-bit count in an __m64. Past the lane width a logical shift
   gives zero and an arithmetic one fills with the sign. */
#define __PRISM_SHIFTS(sfx, n, bits, view, sview) \\
  static __inline __m64 _mm_slli_##sfx(__m64 m, int c) { __m64 r; int k; unsigned u = (unsigned)c; \\
    for (k = 0; k < n; k++) r.view[k] = u >= bits ? 0 : m.view[k] << u; return r; } \\
  static __inline __m64 _mm_srli_##sfx(__m64 m, int c) { __m64 r; int k; unsigned u = (unsigned)c; \\
    for (k = 0; k < n; k++) r.view[k] = u >= bits ? 0 : m.view[k] >> u; return r; } \\
  static __inline __m64 _mm_srai_##sfx(__m64 m, int c) { __m64 r; int k; unsigned u = (unsigned)c; \\
    for (k = 0; k < n; k++) r.sview[k] = m.sview[k] >> (u >= bits ? bits - 1 : u); return r; } \\
  static __inline __m64 _mm_sll_##sfx(__m64 m, __m64 c) { unsigned u = __prism_count(c); return _mm_slli_##sfx(m, u > bits ? bits : (int)u); } \\
  static __inline __m64 _mm_srl_##sfx(__m64 m, __m64 c) { unsigned u = __prism_count(c); return _mm_srli_##sfx(m, u > bits ? bits : (int)u); } \\
  static __inline __m64 _mm_sra_##sfx(__m64 m, __m64 c) { unsigned u = __prism_count(c); return _mm_srai_##sfx(m, u > bits ? bits : (int)u); }
__PRISM_SHIFTS(pi16, 4, 16, m64_u16, m64_i16)
__PRISM_SHIFTS(pi32, 2, 32, m64_u32, m64_i32)
/* The whole quadword, through its two halves. */
static __inline __m64 _mm_slli_si64(__m64 m, int c) {
  __m64 r; unsigned u = (unsigned)c;
  if (u >= 64) return _mm_setzero_si64();
  if (u >= 32) { r.m64_u32[1] = m.m64_u32[0] << (u - 32); r.m64_u32[0] = 0; }
  else if (u == 0) r = m;
  else { r.m64_u32[1] = (m.m64_u32[1] << u) | (m.m64_u32[0] >> (32 - u)); r.m64_u32[0] = m.m64_u32[0] << u; }
  return r; }
static __inline __m64 _mm_srli_si64(__m64 m, int c) {
  __m64 r; unsigned u = (unsigned)c;
  if (u >= 64) return _mm_setzero_si64();
  if (u >= 32) { r.m64_u32[0] = m.m64_u32[1] >> (u - 32); r.m64_u32[1] = 0; }
  else if (u == 0) r = m;
  else { r.m64_u32[0] = (m.m64_u32[0] >> u) | (m.m64_u32[1] << (32 - u)); r.m64_u32[1] = m.m64_u32[1] >> u; }
  return r; }
static __inline __m64 _mm_sll_si64(__m64 m, __m64 c) { unsigned u = __prism_count(c); return _mm_slli_si64(m, u > 64 ? 64 : (int)u); }
static __inline __m64 _mm_srl_si64(__m64 m, __m64 c) { unsigned u = __prism_count(c); return _mm_srli_si64(m, u > 64 ? 64 : (int)u); }

/* Packs: the first operand's lanes fill the low half, the second's the high one. */
static __inline __m64 _mm_packs_pi16(__m64 a, __m64 b) {
  __m64 r; int k; for (k = 0; k < 4; k++) { r.m64_i8[k] = __prism_ss8(a.m64_i16[k]); r.m64_i8[4 + k] = __prism_ss8(b.m64_i16[k]); } return r; }
static __inline __m64 _mm_packs_pu16(__m64 a, __m64 b) {
  __m64 r; int k; for (k = 0; k < 4; k++) { r.m64_u8[k] = __prism_us8(a.m64_i16[k]); r.m64_u8[4 + k] = __prism_us8(b.m64_i16[k]); } return r; }
static __inline __m64 _mm_packs_pi32(__m64 a, __m64 b) {
  __m64 r; int k; for (k = 0; k < 2; k++) { r.m64_i16[k] = __prism_ss16(a.m64_i32[k]); r.m64_i16[2 + k] = __prism_ss16(b.m64_i32[k]); } return r; }
/* Unpacks: the lanes of the low (or high) halves of a and b, interleaved, a's first. */
#define __PRISM_UNPACK(sfx, n, view) \\
  static __inline __m64 _mm_unpacklo_##sfx(__m64 a, __m64 b) { __m64 r; int k; \\
    for (k = 0; k < n / 2; k++) { r.view[2 * k] = a.view[k]; r.view[2 * k + 1] = b.view[k]; } return r; } \\
  static __inline __m64 _mm_unpackhi_##sfx(__m64 a, __m64 b) { __m64 r; int k; \\
    for (k = 0; k < n / 2; k++) { r.view[2 * k] = a.view[n / 2 + k]; r.view[2 * k + 1] = b.view[n / 2 + k]; } return r; }
__PRISM_UNPACK(pi8, 8, m64_u8)
__PRISM_UNPACK(pi16, 4, m64_u16)
__PRISM_UNPACK(pi32, 2, m64_u32)
#endif
`;

export const XMMINTRIN_H = `#ifndef _PRISM_XMMINTRIN_H
#define _PRISM_XMMINTRIN_H
#include <mmintrin.h>
/* The integer MMX instructions SSE added (a Pentium III's). The SSE floating-point half is not
   here: no __m128. */
__PRISM_LANES(_mm_max_pi16, 4, m64_i16, a.m64_i16[k] > b.m64_i16[k] ? a.m64_i16[k] : b.m64_i16[k])
__PRISM_LANES(_mm_min_pi16, 4, m64_i16, a.m64_i16[k] < b.m64_i16[k] ? a.m64_i16[k] : b.m64_i16[k])
__PRISM_LANES(_mm_max_pu8, 8, m64_u8, a.m64_u8[k] > b.m64_u8[k] ? a.m64_u8[k] : b.m64_u8[k])
__PRISM_LANES(_mm_min_pu8, 8, m64_u8, a.m64_u8[k] < b.m64_u8[k] ? a.m64_u8[k] : b.m64_u8[k])
__PRISM_LANES(_mm_avg_pu8, 8, m64_u8, (unsigned char)((a.m64_u8[k] + b.m64_u8[k] + 1) >> 1))
__PRISM_LANES(_mm_avg_pu16, 4, m64_u16, (unsigned short)((a.m64_u16[k] + b.m64_u16[k] + 1) >> 1))
__PRISM_LANES(_mm_mulhi_pu16, 4, m64_u16, (unsigned short)(((unsigned int)a.m64_u16[k] * b.m64_u16[k]) >> 16))
static __inline __m64 _mm_sad_pu8(__m64 a, __m64 b) {
  __m64 r; int k; unsigned s = 0;
  for (k = 0; k < 8; k++) s += a.m64_u8[k] > b.m64_u8[k] ? a.m64_u8[k] - b.m64_u8[k] : b.m64_u8[k] - a.m64_u8[k];
  r.m64_u32[0] = s; r.m64_u32[1] = 0; return r; }
static __inline __m64 _mm_shuffle_pi16(__m64 a, int n) {
  __m64 r; int k; for (k = 0; k < 4; k++) r.m64_u16[k] = a.m64_u16[(n >> (2 * k)) & 3]; return r; }
static __inline int _mm_extract_pi16(__m64 a, int n) { return a.m64_u16[n & 3]; }
static __inline __m64 _mm_insert_pi16(__m64 a, int d, int n) { a.m64_u16[n & 3] = (unsigned short)d; return a; }
static __inline int _mm_movemask_pi8(__m64 a) {
  int m = 0, k; for (k = 0; k < 8; k++) m |= (a.m64_u8[k] >> 7) << k; return m; }
#define _MM_SHUFFLE(z, y, x, w) (((z) << 6) | ((y) << 4) | ((x) << 2) | (w))
#endif
`;
