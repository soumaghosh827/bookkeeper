import sharp from "sharp";
import pngToIco from "png-to-ico";
import { readFileSync, writeFileSync } from "node:fs";

const svg = readFileSync("resources/icon.svg");
const render = (s) =>
  sharp(svg, { density: 384 }).resize(s, s).png().toBuffer();

const sizes = [16, 24, 32, 48, 64, 128, 256];
writeFileSync(
  "resources/icon.ico",
  await pngToIco(await Promise.all(sizes.map(render))),
);
writeFileSync("resources/icon.png", await render(512));
console.log("Wrote resources/icon.ico and resources/icon.png");
