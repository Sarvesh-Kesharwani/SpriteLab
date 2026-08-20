// Pivot-correct a folder of frames and export an animation GIF.
//
// Pipeline per frame:
//   1. Detect the feet pivot (bottom-most opaque row, x = mean of that row).
//   2. Fit the ground line through the lowest opaque pixels; deskew by
//      rotating around the feet pivot (not the image center).
//   3. Reposition so every frame's feet pivot lands on the same ground line
//      and the canvas center.
//   4. Save corrected PNGs (--png-size) and a resized transparent GIF
//      (--gif-size) using the same gifenc encoding as the app.
//
// Usage:
//   node scripts/pivot-to-gif.mjs --frames "<frames dir>"
//     [--out "<output dir>"] [--prefix idle] [--png-size 512]
//     [--gif-size 256] [--delay 100] [--gif-name idle.gif]

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const gifenc = (await import("gifenc")).default;
const { GIFEncoder, quantize, applyPalette } = gifenc;

const IMAGE_RE = /\.(png|webp|jpe?g|gif)$/i;

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    args[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

function feetStats(data, width, height) {
  let feetY = -1;
  const pixels = [];
  const rowCount = new Array(height).fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(x + y * width) * 4 + 3] > 8) {
        pixels.push({ x, y });
        rowCount[y] += 1;
        if (y > feetY) feetY = y;
      }
    }
  }
  if (feetY < 0) return null;
  // Ignore sparse anti-aliased fringe: use the lowest row with a solid
  // foot contact band, falling back to the raw lowest row.
  const solidMin = 8;
  let solidY = -1;
  for (let y = feetY; y >= 0; y -= 1) {
    if (rowCount[y] >= solidMin) {
      solidY = y;
      break;
    }
  }
  if (solidY >= 0) feetY = solidY;
  // Feet pivot: x-center of the lowest few opaque rows (foot contact zone).
  const footPixels = pixels.filter((p) => p.y >= feetY - 3);
  const feetCx =
    footPixels.reduce((sum, p) => sum + p.x, 0) / footPixels.length;

  // Ground line through the lowest opaque band.
  const band = 6;
  const ground = pixels.filter((p) => p.y >= feetY - band);
  const n = ground.length;
  let tiltDeg = 0;
  if (n >= 8) {
    let sx = 0;
    let sy = 0;
    for (const p of ground) {
      sx += p.x;
      sy += p.y;
    }
    const mx = sx / n;
    const my = sy / n;
    let num = 0;
    let den = 0;
    for (const p of ground) {
      num += (p.x - mx) * (p.y - my);
      den += (p.x - mx) ** 2;
    }
    const slope = den > 0 ? num / den : 0;
    tiltDeg = (Math.atan(slope) * 180) / Math.PI;
  }
  return { feetCx, feetY, tiltDeg, count: pixels.length };
}

async function loadRaw(file) {
  return sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.frames) {
    console.error("Missing --frames <dir>");
    process.exit(1);
  }
  const framesDir = args.frames;
  const outDir = args.out || framesDir;
  const prefix = args.prefix || "frame";
  const pngSize = Number(args["png-size"] || 512);
  const gifSize = Number(args["gif-size"] || 256);
  const delay = Number(args.delay || 100);
  const gifName = args["gif-name"] || `${prefix}.gif`;
  const alignX = args["align-x"] || "body";
  const alphaThreshold = Number(args["alpha-threshold"] || 127);

  const files = fs
    .readdirSync(framesDir)
    .filter((name) => IMAGE_RE.test(name))
    .sort(naturalCompare);
  if (!files.length) {
    console.error(`No images in ${framesDir}`);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const frames = [];
  for (const file of files) {
    const { data, info } = await loadRaw(path.join(framesDir, file));
    const stats = feetStats(data, info.width, info.height);
    if (!stats) {
      console.error(`Skipping empty frame ${file}`);
      continue;
    }
    frames.push({
      file,
      data,
      width: info.width,
      height: info.height,
      ...stats,
    });
  }
  if (!frames.length) {
    console.error("No frames with opaque content found.");
    process.exit(1);
  }

  const groundY = Math.max(...frames.map((f) => f.feetY));

  console.log(
    `Frames: ${frames.length} | canvas ${frames[0].width}x${frames[0].height}`,
  );
  console.log(
    `Feet Y range: ${Math.min(...frames.map((f) => f.feetY))}-${groundY}`,
  );
  console.log(
    `Tilt range: ${Math.min(...frames.map((f) => f.tiltDeg)).toFixed(2)}..` +
      `${Math.max(...frames.map((f) => f.tiltDeg)).toFixed(2)} deg`,
  );

  // Rotate every frame about its feet pivot (sharp expands the canvas to fit
  // the rotated image), then place all frames on one shared canvas.
  const rotatedFrames = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const { width, height } = frame;
    // sharp: positive angle rotates clockwise on screen. Point mapping after
    // rotation about the original center is p' = c' + R_ccw(angle) * (p - c).
    const thetaDeg = -frame.tiltDeg;
    const theta = (thetaDeg * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const rotatedImg = await sharp(frame.data, {
      raw: { width, height, channels: 4 },
    })
      .rotate(thetaDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const rw = rotatedImg.info.width;
    const rh = rotatedImg.info.height;
    const px =
      rw / 2 + cos * (frame.feetCx - width / 2) - sin * (frame.feetY - height / 2);
    const py =
      rh / 2 + sin * (frame.feetCx - width / 2) + cos * (frame.feetY - height / 2);
    rotatedFrames.push({
      index,
      file: frame.file,
      data: rotatedImg.data,
      rw,
      rh,
      px,
      py,
      thetaDeg,
    });
    console.log(
      `${frame.file} rotate ${thetaDeg.toFixed(2)} deg ` +
        `-> rotated ${rw}x${rh}`,
    );
  }

  const canvasWidth = Math.max(...rotatedFrames.map((r) => r.rw));
  const canvasHeight = Math.max(...rotatedFrames.map((r) => r.rh));
  const offsets = rotatedFrames.map((r) => ({
    ox: Math.round((canvasWidth - r.rw) / 2),
    oy: Math.round((canvasHeight - r.rh) / 2),
  }));
  const pivots = rotatedFrames.map((r, i) => ({
    x: offsets[i].ox + r.px,
    y: offsets[i].oy + r.py,
  }));
  const groundRow = Math.max(...pivots.map((p) => p.y));
  const centerX = canvasWidth / 2;
  console.log(`Shared canvas ${canvasWidth}x${canvasHeight}`);
  console.log(
    `Ground line target: x=${centerX} y=${groundRow} ` +
      `(x-align: ${alignX === "pivot" ? "feet pivot" : "body center"})`,
  );

  const corrected = [];
  for (let index = 0; index < rotatedFrames.length; index += 1) {
    const r = rotatedFrames[index];
    const dx =
      alignX === "pivot" ? Math.round(centerX - pivots[index].x) : 0;
    const dy = Math.round(groundRow - pivots[index].y);
    const left = offsets[index].ox + dx;
    const top = offsets[index].oy + dy;
    if (process.env.PIVOT_DEBUG) {
      console.error(
        `  debug ${r.file}: feetY=${frames[index].feetY.toFixed(1)} ` +
          `tilt=${frames[index].tiltDeg.toFixed(2)} py=${r.py.toFixed(1)} ` +
          `P.y=${pivots[index].y.toFixed(1)} dy=${dy}`,
      );
    }
    const canvas = await sharp({
      create: {
        width: canvasWidth,
        height: canvasHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: r.data,
          raw: { width: r.rw, height: r.rh, channels: 4 },
          left,
          top,
        },
      ])
      .png()
      .toBuffer({ resolveWithObject: true });

    const outName = `${prefix}-${String(index + 1).padStart(3, "0")}.png`;
    await sharp(canvas.data).resize(pngSize, pngSize, { fit: "fill" }).png().toFile(path.join(outDir, outName));
    corrected.push({ outName, buffer: canvas.data, size: pngSize });
    console.log(
      `${r.file} -> ${outName} (place at ${left},${top})`,
    );
  }

  const gifPath = path.join(outDir, gifName);
  const gif = GIFEncoder();
  for (const frame of corrected) {
    const resized = await sharp(frame.buffer)
      .resize(gifSize, gifSize, { fit: "fill" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { data } = resized;
    const palette = quantize(data, 256, {
      format: "rgba4444",
      oneBitAlpha: alphaThreshold,
    });
    const index = applyPalette(data, palette, "rgba4444");
    const transparentIndex = palette.findIndex((color) => color[3] === 0);
    gif.writeFrame(index, gifSize, gifSize, {
      palette,
      delay,
      transparent: transparentIndex >= 0,
      transparentIndex: Math.max(transparentIndex, 0),
    });
  }
  gif.finish();
  fs.writeFileSync(gifPath, Buffer.from(gif.bytes()));

  const gifMeta = await sharp(gifPath).metadata();
  console.log(
    `GIF: ${gifPath} | ${gifMeta.width}x${gifMeta.height} | ` +
      `${gifMeta.pages} frames | ${delay}ms/frame`,
  );
}

await main();
