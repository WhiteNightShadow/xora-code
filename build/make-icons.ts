/**
 * Renders the app icon from its source, apps/desktop/build-resources/icon.svg, into what each platform takes:
 *
 *   build-resources/icon.png     1024 px, the macOS grid (the plate in the middle 824 px), also the README's icon
 *   build-resources/icon.icns    macOS, every size of an iconset, made with iconutil
 *   build-resources/icon.ico     Windows, 16 to 256 px, the plate filling the square
 *   build-resources/icon-linux.png   1024 px, the plate filling the square
 *   static/tray.png              32 px for the tray and menu bar (the shell scales it to 16)
 *
 * The SVG is drawn by Google Chrome through playwright-core, so gradients, filters and anti-aliasing look the same
 * at every size; each size is rendered from the vector rather than scaled down.
 *
 *   node build/make-icons.ts
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.join(repoRoot, 'apps', 'desktop', 'build-resources');
const source = await readFile(path.join(resources, 'icon.svg'), 'utf8');

/**
 * The macOS icon keeps Apple's margins; Windows and Linux icons fill the square, so their plate is cropped close
 * and has no drop shadow (it would be cut off at the edge, and small sizes read better without it).
 */
function variant(kind: 'mac' | 'full'): string {
    if (kind === 'mac') return source;
    return source.replace('viewBox="0 0 1024 1024"', 'viewBox="72 72 880 880"').replace(' filter="url(#drop)"', '');
}

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function render(kind: 'mac' | 'full', size: number): Promise<Buffer> {
    const svg = variant(kind).replace(/width="1024" height="1024"/, `width="${size}" height="${size}"`);
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
        `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`,
    );
    return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

/** An .ico whose entries are PNGs, which Windows reads from Vista on; 256 is written as 0 in the directory. */
function ico(images: ReadonlyArray<{ size: number; png: Buffer }>): Buffer {
    const header = Buffer.alloc(6 + 16 * images.length);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    images.forEach(({ size, png }, index) => {
        const entry = 6 + 16 * index;
        header.writeUInt8(size >= 256 ? 0 : size, entry);
        header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
        header.writeUInt8(0, entry + 2);
        header.writeUInt8(0, entry + 3);
        header.writeUInt16LE(1, entry + 4);
        header.writeUInt16LE(32, entry + 6);
        header.writeUInt32LE(png.length, entry + 8);
        header.writeUInt32LE(offset, entry + 12);
        offset += png.length;
    });
    return Buffer.concat([header, ...images.map((image) => image.png)]);
}

const work = await mkdtemp(path.join(tmpdir(), 'xora-icons-'));
try {
    await writeFile(path.join(resources, 'icon.png'), await render('mac', 1024));
    await writeFile(path.join(resources, 'icon-linux.png'), await render('full', 1024));

    // iconutil wants the standard names: icon_<points>x<points>[@2x].png.
    const iconset = path.join(work, 'icon.iconset');
    await mkdir(iconset);
    for (const points of [16, 32, 128, 256, 512]) {
        await writeFile(path.join(iconset, `icon_${points}x${points}.png`), await render('mac', points));
        await writeFile(path.join(iconset, `icon_${points}x${points}@2x.png`), await render('mac', points * 2));
    }
    if (process.platform === 'darwin') {
        execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'icon.icns')]);
    } else {
        console.warn('iconutil is macOS only: icon.icns was not made');
    }

    const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
    const images: Array<{ size: number; png: Buffer }> = [];
    for (const size of sizes) images.push({ size, png: await render('full', size) });
    await writeFile(path.join(resources, 'icon.ico'), ico(images));

    await writeFile(path.join(repoRoot, 'apps', 'desktop', 'static', 'tray.png'), await render('full', 32));
    console.log(`icons written to ${path.relative(repoRoot, resources)} and apps/desktop/static/tray.png`);
} finally {
    await browser.close();
    await rm(work, { recursive: true, force: true });
}
