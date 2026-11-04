/**
 * Renders the app icon from its source, apps/desktop/build-resources/icon.svg, into what each platform takes:
 *
 *   build-resources/icon.png     1024 px, the macOS grid (the plate in the middle 824 px), also the README's icon
 *   build-resources/icon.icns    macOS, every size of an iconset, made with iconutil; 16 and 32 px draw the
 *                                moon and star alone, in a bolder line (the wires vanish at that size)
 *   build-resources/icon.ico     Windows, 16 to 256 px, the plate filling the square
 *   build-resources/icon-linux.png   1024 px, the plate filling the square
 *   static/tray.png              32 px for the Windows and Linux tray (the shell scales it to 16)
 *   static/trayTemplate.png      18 and 36 px (@2x) for the macOS menu bar: a template image, the drawing alone in
 *                                black, which macOS tints for a light or dark menu bar
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
function variant(kind: 'mac' | 'full' | 'small' | 'tray'): string {
    if (kind === 'mac') return source;
    if (kind === 'full') {
        return source.replace('viewBox="0 0 1024 1024"', 'viewBox="72 72 880 880"').replace(' filter="url(#drop)"', '');
    }
    // The small drawing: the moon in a bolder line and a larger star, without the wires and nodes, centred again.
    const small = must(
        source
            .replace('stroke-width="22" stroke-linejoin="round"', 'stroke-width="46" stroke-linejoin="round"')
            .replace(/\s*<g fill="none" stroke="#111111" stroke-width="7"[\s\S]*?<\/g>/, '')
            .replace(/\s*<circle [^>]*\/>/g, '')
            .replace(
                /(<path d="M628 340C[^"]*" fill="#111111"\/>)/,
                '<g transform="translate(628 440) scale(1.3) translate(-628 -440)">$1</g>',
            )
            .replace(
                'translate(522 507) scale(0.92) translate(-507 -541)',
                'translate(518 510) scale(0.92) translate(-484 -541)',
            ),
        source,
    );
    if (kind === 'small') return small;
    // The menu bar: the drawing alone, in black on nothing, the plate and its rim dropped.
    return must(
        small
            .replace(/\s*<g filter="url\(#drop\)">[\s\S]*?<\/g>/, '')
            .replace(/\s*<use href="#shape" fill="none"[^>]*\/>/, '')
            .replace('viewBox="0 0 1024 1024"', 'viewBox="225.5 220 580 580"')
            .replaceAll('#111111', '#000000'),
        small,
    );
}

/** A variant must differ from what it was made from: a source that no longer matches fails loudly. */
function must(changed: string, from: string): string {
    if (changed === from) throw new Error('icon.svg changed: build/make-icons.ts no longer finds what it adapts');
    return changed;
}

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function render(kind: 'mac' | 'full' | 'small' | 'tray', size: number): Promise<Buffer> {
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
        // 16 and 32 px images draw the simpler drawing; 64 px and up the whole one.
        const kind = (pixels: number) => (pixels <= 32 ? 'small' : 'mac');
        await writeFile(path.join(iconset, `icon_${points}x${points}.png`), await render(kind(points), points));
        await writeFile(
            path.join(iconset, `icon_${points}x${points}@2x.png`),
            await render(kind(points * 2), points * 2),
        );
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

    const statics = path.join(repoRoot, 'apps', 'desktop', 'static');
    await writeFile(path.join(statics, 'tray.png'), await render('full', 32));
    await writeFile(path.join(statics, 'trayTemplate.png'), await render('tray', 18));
    await writeFile(path.join(statics, 'trayTemplate@2x.png'), await render('tray', 36));
    console.log(`icons written to ${path.relative(repoRoot, resources)} and ${path.relative(repoRoot, statics)}`);
} finally {
    await browser.close();
    await rm(work, { recursive: true, force: true });
}
