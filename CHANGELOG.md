# Changelog

All notable changes to pi-vision-router will be documented in this file.

## [0.1.1] - 2026-07-26

### Security
- Replace FNV-1a hash with SHA-256 for cache keys to prevent collisions
- Add untrusted-input warning prefix to all image descriptions to mitigate prompt injection
- Remove debug console.log statements that leaked metadata

## [0.1.0] - 2026-07-25

### Added
- Initial release
- Automatic vision model routing for image `read` results
- Transparent delegation to vision-capable models (Gemma 4 31B, Qwen3.6 35B, Kimi K2.6, Kimi K2.7)
- LRU description cache to avoid repeated API calls for the same image
- Graceful degradation when no vision model is available
- Status line integration for active routing count
- Retry with exponential backoff for failed vision model calls
- FNV-1a hash-based cache key computation
