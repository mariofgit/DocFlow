# Sample files for local demos

Place a small PDF here as `local-demo.pdf` and run from repo root:

```bash
export DOCLING_API_KEY=...   # same value as in `.env`
./scripts/demo-convert.sh samples/local-demo.pdf
```

Any PDF under 10 MB works for the synchronous endpoint.
