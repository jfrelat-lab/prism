# workout.tcl -- a Tcl 8.4 script whose output tools/gate-tcl.mjs compares between two builds of the
# same Tcl sources: gcc's in the oracle, and PRISM's. PRISM's own file. Everything it prints is
# deterministic: no time of day, no process ids, no hash-order dependence (arrays are read sorted).

proc section {name} { puts "== $name" }

section strings
set s "The quick brown fox"
puts [string length $s]|[string toupper $s]|[string range $s 4 8]|[string index $s end]
puts [string map {quick slow brown red} $s]|[string first fox $s]|[string last o $s]
puts [string trim "  padded  "]|[string repeat ab 3]
puts [format "%5d|%-5d|%05.1f|%x|%o|%e|%c|%s|%10.4f" 42 42 3.14159 255 8 12345.678 65 str 2.5]
puts [string compare abc abd]|[string equal -nocase ABC abc]|[string match {a*[0-9]} abc7]
puts [string is integer 12]|[string is double 1e3]|[string is alpha ab1]|[string totitle hello]

section lists
set l {5 3 9 1 7}
puts [lsort -integer $l]|[lsort -integer -decreasing $l]|[lindex $l 2]|[llength $l]
puts [lrange $l 1 3]|[linsert $l 2 x y]|[lreplace $l 0 1 a]|[lsearch $l 9]
puts [join [lsort {pear Apple fig banana}] ,]|[join [lsort -dictionary {a10 a2 A1 b1}] ,]
puts [split "a,b;c" ",;"]|[concat {1 2} {3 {4 5}}]|[list a {b c} "d e"]
set nested {{1 2} {3 4} {5 6}}
foreach {a b} {1 2 3 4 5} { append acc "$a-$b " }
puts $acc|[lindex $nested 1 0]|[llength [lindex $nested end]]

section arithmetic
puts [expr {7 / 2}]|[expr {-7 / 2}]|[expr {7 % 3}]|[expr {-7 % 3}]|[expr {7.0 / 2}]
puts [expr {1 << 20}]|[expr {0xff & 0x0f}]|[expr {~5}]|[expr {5 ^ 3}]
puts [expr {sqrt(2)}]|[expr {sin(1.0)}]|[expr {atan2(1, 1)}]|[expr {pow(2, 0.5)}]|[expr {hypot(3, 4)}]
puts [expr {round(2.5)}]|[expr {round(-2.5)}]|[expr {int(3.99)}]|[expr {ceil(1.2)}]|[expr {floor(-1.2)}]
puts [expr {cosh(1)}]|[expr {tanh(0.5)}]|[expr {fmod(7.5, 2)}]|[expr {abs(-3)}]|[expr {double(1) / 3}]
puts [expr {wide(2147483647) + 1}]|[expr {wide(1) << 40}]|[expr {9223372036854775807}]|[expr {4294967296 * 3}]
puts [expr {3 > 2 && 2 > 1}]|[expr {"abc" < "abd"}]|[expr {5 == 5.0}]
puts [expr {1 ? "yes" : "no"}]|[expr {int("0x1f")}]|[expr {012 + 1}]

section procedures
proc fact {n} { expr {$n <= 1 ? 1 : $n * [fact [expr {$n - 1}]]} }
proc fib {n} { if {$n < 2} { return $n }; expr {[fib [expr {$n - 1}]] + [fib [expr {$n - 2}]]} }
proc swap {aName bName} { upvar 1 $aName a $bName b; set t $a; set a $b; set b $t }
proc sum {args} { set t 0; foreach x $args { incr t $x }; return $t }
proc defaults {a {b 10} {c 20}} { return "$a $b $c" }
set x 1; set y 2; swap x y
puts [fact 10]|[fib 15]|$x$y|[sum 1 2 3 4]|[defaults 1]|[defaults 1 2 3]
puts [info args defaults]|[info exists x]|[info exists nope]|[llength [info commands s*]]

section control
set out {}
for {set i 0} {$i < 10} {incr i} { if {$i == 3} continue; if {$i == 7} break; lappend out $i }
set i 0; while {$i < 3} { lappend out w$i; incr i }
switch -glob abc { a* { lappend out glob } default { lappend out none } }
switch -exact 2 { 1 { lappend out one } 2 { lappend out two } }
puts $out
puts [catch {error "boom" "" CODE} msg]|$msg|$::errorCode
puts [catch {expr {1 / 0}} msg]|$msg
puts [catch {unknown_command 1 2} msg]|$msg

section arrays
array set arr {one 1 two 2 three 3}
set arr(four) 4
foreach k [lsort [array names arr]] { append line "$k=$arr($k) " }
puts $line|[array size arr]|[info exists arr(one)]|[info exists arr(five)]
unset arr(two)
puts [lsort [array names arr t*]]

section regexp
puts [regexp {(\d+)-(\d+)} "tel 555-1234 x" all a b]|$all|$a|$b
puts [regsub -all {[aeiou]} "education" "*"]|[regexp -all -inline {\w+} "one two  three"]
puts [regexp -nocase {^HELLO} "hello world"]|[regsub {(\w+) (\w+)} "hello world" {\2 \1}]

section namespaces
namespace eval counter { variable n 0; proc next {} { variable n; incr n } }
counter::next; counter::next
puts [counter::next]|[namespace current]|[namespace eval counter { namespace current }]

section binary
binary scan [binary format i1s1c1 305419896 258 65] i1s1c1 bi bs bc
puts $bi|$bs|$bc|[string length [binary format a5 ab]]
binary scan [binary format d 3.5] d bd
puts $bd

section clock
puts [clock format 0 -gmt 1 -format {%Y-%m-%d %H:%M:%S %a %j}]
puts [clock format 1000000000 -gmt 1 -format {%Y-%m-%d %H:%M:%S}]|[clock scan "2001-09-09 01:46:40" -gmt 1]

section done
