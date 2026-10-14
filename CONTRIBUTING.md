# Contributing to 2pixelshorts

Start with the [installation guide](docs/installation.md). The repository root
contains the application; use `npm ci` there and keep both lockfiles committed.

## Development

- `npm run tauri -- dev`: native desktop app with real Python/Rust operations.
- `npm run dev`: browser interface with simulated desktop operations.
- `npm run build`: TypeScript check and production frontend build.
- `npm run brand:generate`: regenerate icons from `public/brand/logo-source.png`.

The [architecture guide](docs/project-structure.md) maps the frontend, IPC,
backend jobs, publishing, credential store, and Python engine.

## Validate a change

Run `npm test` and `npm run build` for frontend changes. Run
`cargo test --manifest-path src-tauri/Cargo.toml` for backend or IPC changes.
Run the Python suite for engine changes:

```sh
video-use/.venv/bin/python -m unittest discover -s video-use/tests
```

On Windows use `video-use/.venv/Scripts/python.exe`. FFmpeg and FFprobe must
be on PATH for real render checks; the full framing suite needs OpenCV.
Use synthetic fixtures and an isolated QA application for tests that alter
credentials or saved data. The existing review documents the QA build command.

Preserve the application identifier, credential namespace, storage keys, and
managed Python directory unless implementing and testing a data migration.
Keep helper resource paths aligned with `src-tauri/tauri.conf.json`.

## Submit a contribution

Open an issue for larger behavior changes and submit a pull request explaining
the problem, resulting behavior, and validation performed. Add focused regression
coverage for functional fixes. Never run live publishing tests against somebody
else's account or upload private footage as a fixture.

Do not commit secrets, environments, caches, compiled bundles, downloaded
installers, production transcripts, or personal media. If a secret is accidentally
committed, revoke it immediately; removing the file does not remove Git history.

Contributions are licensed under the project's [MIT license](LICENSE).
