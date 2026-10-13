# PRISM — Documentation

Two kinds of document live here, and they are kept apart on purpose.

## Reference

These describe the project **as it is**. When the code changes, they change.

| Document | Answers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | How is it built? The design, the file map, the hard parts. Start here. |
| [COMPAT.md](COMPAT.md) | What runs, how far, what holds it there, and when was that recorded? |
| [TESTING.md](TESTING.md) | What are the gates, the oracles, and the measured facts behind the ABIs? |
| [ROADMAP.md](ROADMAP.md) | What is open? One line per task. |

## Record

[LOG.md](LOG.md) holds the long form of every roadmap row written before 2026-09-27: the
measurements, the dead ends, the defects found. After that date a row's story is in its commit
message. The record is not revised afterwards.

## The rule

A fact about the present goes in a reference document, without its story. The story goes in the
record: the symptom, the hypotheses, the measurements, the cause. When the two disagree, the
record is the older one.
