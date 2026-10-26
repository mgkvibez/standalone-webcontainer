# Reference Abstracts — Clean Room Protocol

This directory is a conceptual "textbook." Every document here records
*what a problem was and how it was solved, in concept only*, so our own
MIT implementation can be written from scratch without reading the
original source while implementing.

## The protocol (working rule, locked Oct 26)

When studying a restricted or unlicensed repository:

1. **Extract the concept, not the code.** Read source only to understand
   how a problem was solved.
2. **Write an abstract summary.** Plain English or high-level
   pseudocode, in this directory.
3. **Close the source.** Restricted code never stays in context while
   writing our implementation.
4. **Implement from scratch.** Based only on the abstract here; zero
   syntactic or structural copying of the original.

Hard constraints: no code snippets from the studied repos; these repos
are never added as dependencies; every abstract awaits expert review
before it informs an ADR or any implementation.

## Index

| Document | Source repo | Source license | Why referenced |
|---|---|---|---|
| [lifo-persistence-pattern.md](lifo-persistence-pattern.md) | lifo-sh/lifo | None (unlicensed) | IndexedDB persistence + Node compat layering concepts for Phase 2 |
| [wanix-sw-routing-pattern.md](wanix-sw-routing-pattern.md) | tractordev/wanix | MIT | Service-worker relay + worker isolation + persistence schema concepts |
| [browsix-syscall-boundary.md](browsix-syscall-boundary.md) | plasma-umass/browsix | NOASSERTION (unclear) | Syscall-over-worker boundary concepts for the Runtime interface |

Unlicensed and unclear-licensed sources are treated as fully
restricted regardless of what their file headers claim. MIT sources are
also treated conceptually per protocol, for uniform discipline.
