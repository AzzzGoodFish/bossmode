# Contributing to Bossmode

Thanks for contributing.

## Before opening a pull request

1. Open an issue or discussion for substantial behavior or architecture changes.
2. Keep changes focused and do not include local runtime data, credentials, internal working documents, generated packages, screenshots, logs, or `.bossmode-attachments`.
3. Install both dependency sets:
   ```bash
   npm ci
   npm ci --prefix web
   ```
4. Run the repository gates:
   ```bash
   npm run check:repo-hygiene
   npm run build
   npm test -- --run --no-file-parallelism
   ```
5. Explain the user impact, tests, and any migration or compatibility considerations in the pull request.

## Security reports

Do not report vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md).

## License

By submitting a contribution, you agree that it is provided under the repository's [Apache License 2.0](LICENSE). Bossmode does not require a Contributor License Agreement for the initial public release.

Third-party code retains its own license. In particular, the `vendor/pi-mcp-adapter` submodule remains MIT-licensed by its upstream project.
