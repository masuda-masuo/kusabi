# Vendored third-party YAML parser

The opt-in OpenCode free worker profile (`free-worker-profile.mjs` /
`free-worker-yaml.mjs`) parses agent frontmatter with the maintained `yaml`
package instead of a hand-written line/regex parser. Kusabi does not resolve
dependencies at runtime, and the root `package.json` intentionally declares no
runtime dependencies, so the parser is vendored as one self-contained ESM
bundle.

## Upstream

- Package: `yaml` (eemeli/yaml), <https://eemeli.org/yaml/>
- Version: **2.9.1**
- License: ISC (see `yaml.LICENSE` in this directory)
- Source entry: the published browser ESM build at `browser/dist/index.js`
  inside the npm tarball `yaml-2.9.1.tgz`
  (`https://registry.npmjs.org/yaml/-/yaml-2.9.1.tgz`)
- Tarball integrity (npm `dist.integrity`):
  `sha512-3NxN8+78OdzbT7C/WjGsyfPAtJaN3FNDsWxv7Y7mcDsT/oOmgW8BpyQQFFBnvZE3j9Y2Sdz1ULFLezL7Eb2yFw==`
- Tarball shasum: `c16233fb31944e705cfefaff38795587f57588ce`

## Artifact

`yaml-esm.mjs` is the single-file ESM bundle of the official browser ESM
build. It has no imports of Node builtins or other packages and no dynamic
`require`; it exports `parseAllDocuments`, `parseDocument`, `visit`, the node
identity helpers (`isMap`, `isScalar`, `isSeq`, `isAlias`, ...), and the rest
of the package's public API.

SHA-256 of `yaml-esm.mjs`:

```
da22bf7db0465c842c48c2b0680d9c5fbb35e181c55060d289577bd0696bfdb7  yaml-esm.mjs
```

## Reproducible build

```bash
# Fetch the pinned upstream tarball and verify it.
npm pack yaml@2.9.1                     # -> yaml-2.9.1.tgz
#   sha512-3NxN8+78OdzbT7C/WjGsyfPAtJaN3FNDsWxv7Y7mcDsT/oOmgW8BpyQQFFBnvZE3j9Y2Sdz1ULFLezL7Eb2yFw==
tar xzf yaml-2.9.1.tgz

# Bundle the official browser ESM build into one file (esbuild 0.25.0).
npx --yes esbuild@0.25.0 \
  package/browser/dist/index.js \
  --bundle --format=esm --platform=neutral --target=es2020 \
  --legal-comments=none \
  --outfile=yaml-esm.mjs
```

Only the published upstream sources are bundled; no upstream tests are copied
and no code was authored. The bundle is generated output and lives outside the
linted `scripts/` directory, separated from the authored policy modules that
consume it.
