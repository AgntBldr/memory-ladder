# Diagram sources

These six diagrams were made with [Archify v3.2.0](https://github.com/tt-a1i/archify), licensed under Apache-2.0. The light and dark PNGs are 1440 x 900. Validation, finalize with browser check, check and visual-check passed for the supplied renders.

To re-render one source, choose its Archify type and run from the kit root:

```sh
ARCHIFY_UPDATE_CHECK_DISABLED=1 node <archify>/archify/bin/archify.mjs finalize <type> docs/diagrams/<name>.json <out>.html --repo-root .
```

Interactive HTML is about 820 KB per diagram and is not committed. Re-render locally when interactive inspection is needed.
