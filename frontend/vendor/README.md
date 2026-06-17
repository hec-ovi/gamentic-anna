# Vendored libraries

- `idiomorph.esm.js` - v0.7.4, 0BSD license, unmodified from
  https://github.com/bigskysoftware/idiomorph (via unpkg `idiomorph/dist/idiomorph.esm.js`).
  DOM morphing: render() diffs the real DOM against the fresh HTML instead of
  rebuilding it, so unchanged nodes keep their identity (focus, caret, scroll,
  mid-flight animations). To update: replace the file, bump this note, run the suite.
