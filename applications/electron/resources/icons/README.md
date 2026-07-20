# Platform icon assets

`1024x1024.png` is the reviewed Xora Code master app icon. The Electron
builder consumes the synchronized `../icon.png` and creates platform packaging
assets on each native runner. Both PNG files must remain 1024 x 1024 RGBA with
transparent outer corners; an opaque RGB export makes the rounded tile appear
as a black square in launchers and packaged `.icns`/`.ico` assets.

The mark is intentionally independent from xAI/Grok branding: a white-night
orbit opens into a code arrow. Keep the app icon, the monochrome Agent glyph and
the splash artwork in the same visual family without scaling one asset into all
three roles.
