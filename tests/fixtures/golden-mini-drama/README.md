# Golden mini-drama fixture

`scenario.json` is a **synthetic test specification**, not a saved MirrorOrder workspace and not production data.

It intentionally contains only logical IDs, synthetic script text, display filenames and human/derived facts needed to exercise cross-module production contracts. It contains no media bytes, device-local roots, absolute paths, model caches, credentials or copied customer artifacts.

The lifecycle test materializes this scenario under pytest `tmp_path`, writes authority through the first-party stores where applicable, then checks Script → Slate → Mapping → Review/Editorial → Coverage → Rough Cut → Assembly → Delivery and reopen behavior.

This fixture is allowed to evolve when the product contract evolves. Do not add compatibility fields merely to preserve an obsolete pre-V1 route or schema; update the fixture and the corresponding lifecycle assertions together.
