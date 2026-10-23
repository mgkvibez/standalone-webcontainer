# tests

Rules (charter section 4): every fixture runs in a fresh temp directory, never shared state.
Hard timeouts: install 180s, build 240s, run/preview 60s. Hanging processes produce TIMEOUT, never infinite waits.
Write the test before the implementation when possible; when not, same commit.

- unit/ — vitest unit tests
- browser/ — playwright browser-lane tests (require COOP/COEP headers for SharedArrayBuffer)
