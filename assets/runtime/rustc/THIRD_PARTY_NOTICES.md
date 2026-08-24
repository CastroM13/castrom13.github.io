# Rust workspace third-party notices

This directory is a locally modified production build of [Rubrc](https://github.com/oligamiq/rubrc) at commit `807ace9e9cf266b1b1004372abdefc2152785d69`. Rubrc runs WebAssembly-hosted `rustc`, Cargo, Clang/LLVM components, and supporting WASI infrastructure inside a browser worker. The bundled sysroot came from the Rubrc maintainer's [rust_wasm v0.2.0 distribution](https://github.com/oligamiq/rust_wasm).

Rubrc declares `MIT OR Apache-2.0`. The Rust toolchain and standard library are distributed under their upstream licenses, principally MIT or Apache-2.0, with LLVM exceptions where stated upstream. Source, authorship, dependency, and license details are available in the linked repositories and the [Rust project license index](https://www.rust-lang.org/policies/licenses).

The portfolio build changes only source handoff, same-origin asset URLs, the external-network policy, CSP, title, and packaging. Exact provenance, checksums, and changes are recorded in `RUNTIME-MANIFEST.json`.

## MIT License text

Copyright (c) Rubrc, rust_wasm, Rust project, and respective contributors.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
