# Agent Rules — pi-vision-router

## Project Scope
This is a pi extension that provides automatic vision model routing. Keep changes focused on the extension's core responsibility: intercepting image `read` results and delegating to vision-capable models.

## Code Style
- TypeScript with strict mode
- No external runtime dependencies beyond pi's bundled packages (`@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`)
- Follow patterns from the `second-o-pi-nion` extension for model resolution and API calls

## Testing
- Test by symlinking into `~/.pi/agent/extensions/` and running `/reload` in pi
- Verify: read an image file with a non-vision model → description should appear

## Git
- Follow conventional commits: `feat:`, `fix:`, `docs:`, `perf:`, `chore:`
- Version in `package.json` and `CHANGELOG.md` in lockstep
