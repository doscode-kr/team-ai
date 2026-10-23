// Must be the first import of the entry point: libuv sizes its thread pool on
// first use and never again. The pool runs both getaddrinfo (every upstream
// connection's DNS lookup) and every fs call, and its default is 4. On
// 2026-10-22 a flaky network left lookups hanging, the 4 threads filled, and a
// state save queued behind them for minutes — long enough to finish after a
// re-login and write the stale token back over it. A wider pool keeps file I/O
// moving while lookups stall. An explicit setting from the environment wins.
process.env.UV_THREADPOOL_SIZE ??= '32';
