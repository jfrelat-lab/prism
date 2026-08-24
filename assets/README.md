# assets

`vga-rom-8x16.bin` — the IBM VGA 8x16 text font: 256 glyphs, 16 rows each, one byte per row,
MSB = leftmost pixel. 4096 bytes.

Taken from MIRAGE (`~/Projects/mirage/assets/`), where it was extracted **graphically** from DOSBox's
rendered output by `tools/build-fonts.mjs` rather than copied from anyone's source. That is the same
discipline this repository uses for every reference: observe what the reference produces, do not lift
how it produces it.

It is here rather than fetched from MIRAGE so PRISM stays runnable on its own. 4 KB is a cheaper price
than a hard dependency on a sibling checkout's layout.
