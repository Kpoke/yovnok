# Music credits

Moved: every asset's attribution — music included — now lives in
[`ASSETS.md`](../../../ASSETS.md) at the project root, generated from
`assets.json` by `npm run licensecheck -- --write`. The same list feeds the
in-game **CREDITS** screen.

To add a track: drop the file here, add it to `lobby` or `match` in
`playlist.json`, add an entry to `assets.json`, and run
`npm run licensecheck -- --write`. Only CC0, CC BY or CC BY-SA music is accepted;
NC and ND licences fail the check.
