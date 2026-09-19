#!/usr/bin/env bash
# One-shot build of llama-server with the CUDA backend.
#
# Requirements:
#   - cmake >= 3.25 (use a newer one, e.g. `pip install cmake`, when building
#     against a very recent CUDA toolkit - old cmake may fail to locate it)
#   - a CUDA toolkit (nvcc). The build auto-detects the GPU in this machine.
#
# Usage:
#   ./scripts/build.sh                 # build for the GPU attached here
#   CMAKE=cmake CUDA_ARCHITECTURES=89;120a ./scripts/build.sh
#
# Artifacts land in build/bin (llama-server + backend libraries).
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="${BUILD_DIR:-$SRC/build}"

CMAKE="${CMAKE:-cmake}"
CUDA_ARCHITECTURES="${CUDA_ARCHITECTURES:-local}"

"$CMAKE" -S "$SRC" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_CUDA=ON \
  -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCHITECTURES" \
  -DLLAMA_CURL=OFF

"$CMAKE" --build "$BUILD" -j "$(nproc)" --target llama-server
echo "OK: $BUILD/bin/llama-server"
