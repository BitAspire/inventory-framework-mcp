# Contributing

Contributions are welcome — whether it's a bug report, a feature request, or a pull request.

## How to Contribute

### Issues

Found a bug or have an idea? [Open an issue](https://github.com/anomalyco/inventory-framework-mcp/issues) and include:

- A clear title and description
- If reporting a bug: the Java IF code that triggered it, expected vs actual behavior, and any error output
- If suggesting a feature: the use case and how it fits the IF ecosystem

### Pull Requests

1. Fork the repository
2. Create a new branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run the build (`npm run build`) and make sure it compiles cleanly
5. Test your changes with the stdio or HTTP mode
6. Commit and push, then open a pull request

### What We'd Love Help With

- **More validation rules** — the `src/validator/engine.ts` is easy to extend with new checks
- **Additional GUI types** — support for custom IF pane types or GUI containers
- **Better parsing** — the regex tokenizer in `src/parser/` has known limitations; a proper AST would be ideal
- **Texture updates** — if you have higher-quality or missing Minecraft textures
- **More item atlas entries** — the atlas in `src/renderer/item-atlas.ts` covers most vanilla items, but gaps exist
- **IF documentation** — the `resources/if-docs.json` could always use more examples

### Code Style

- The project uses TypeScript with strict mode
- Follow the existing code conventions (import style, naming, etc.)
- No comments unless the code is non-obvious
- Keep the build clean (`npm run build` should pass with zero errors)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
