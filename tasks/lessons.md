# Lessons

- Keep completion reports concise: lead with the result and include only required acceptance evidence. Do not narrate implementation steps or add preamble.
- Compare real paths in ESM CLI entrypoint guards. Global npm bins are symlinks, so lexical `process.argv[1]` comparisons can silently skip startup.
