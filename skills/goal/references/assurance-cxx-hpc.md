# C++ and HPC assurance profile

Select `cxx-hpc` for C++ and performance-sensitive native or HPC work. Define gates for:

- `complexity`: time and auxiliary-space complexity are stated for the changed hot paths and checked against representative scaling.
- `memory`: ownership, lifetime, bounds, allocation behavior, locality, and sanitizer-relevant risks are reviewed or measured.
- `numerical-correctness`: precision, overflow, determinism, tolerances, reductions, and edge cases match the intended numerical contract.
- `performance-measurement`: release-build benchmarks use representative inputs, warmup, repeated samples, and a recorded baseline; optimize measured bottlenecks.
- `toolchain-portability`: required standards, compilers, build modes, architecture assumptions, warnings, and relevant sanitizers are accounted for.

Add domain gates for threading, SIMD, MPI, accelerators, I/O, or memory resources when applicable. State the cost model before claiming an optimization. Report time complexity and space complexity explicitly, but do not substitute asymptotic notation for measurement when constants, bandwidth, cache behavior, synchronization, or vectorization dominate.
