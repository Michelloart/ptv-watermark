import sharp from "sharp";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Pomoc: bezpečne zistíme absolútnu cestu k /public/logo.png
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGO_PATH = path.resolve(__dirname, "..", "public", "logo.png");

// jednoduchá pixelácia
async function pixelate(buffer, block = 20) {
  const base = sharp(buffer);
  const meta = await base.metadata();
  const w = Math.max(1, Math.round((meta.width || 200) / block));
  const h = Math.max(1, Math.round((meta.height || 200) / block));
  return sharp(buffer)
    .resize(w, h, { kernel: "nearest" })
    .resize(meta.width, meta.height, { kernel: "nearest" })
    .jpeg({ quality: 90 })
    .toBuffer();
}

export default async function handler(req, res) {
  try {
    const {
      url,                 // povinné: zdrojová fotka
      type = "blur",       // blur | pixelate | none
      sigma = "24",        // pri blur
      block = "25",        // pri pixelate
      logo,                // voliteľné: URL iného loga
      opacity = "0.05",    // 5 %
      scale = "0.35",      // 35 % kratšej strany
      key                  // jednoduchá ochrana
    } = req.query;

    // API key (ak je nastavený)
    if (process.env.API_KEY && key !== process.env.API_KEY) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!url || !/^https?:\/\//i.test(url)) {
      res.status(400).json({ error: "Missing or invalid 'url' parameter" });
      return;
    }

    // 1) stiahni zdrojovú fotku
    const srcResp = await fetch(url);
    if (!srcResp.ok) {
      res.status(400).json({ error: "Failed to fetch source image", status: srcResp.status });
      return;
    }
    const contentType = srcResp.headers.get("content-type") || "";
    if (!contentType.includes("image") && !contentType.includes("octet-stream")) {
      // občas Drive vráti octet-stream; to tolerujeme
      // HTML/JSON odmietneme
      res.status(415).json({ error: "URL is not an image", contentType });
      return;
    }
    const srcBuf = Buffer.from(await srcResp.arrayBuffer());

    // 2) priprav podklad (blur/pixelate/none)
    let baseBuf;
    if (type === "pixelate") {
      baseBuf = await pixelate(srcBuf, Number(block));
    } else if (type === "none") {
      baseBuf = await sharp(srcBuf).jpeg({ quality: 90 }).toBuffer();
    } else {
      const s = Math.max(1, Number(sigma) || 24);
      baseBuf = await sharp(srcBuf).blur(s).jpeg({ quality: 90 }).toBuffer();
    }

    const baseImg = sharp(baseBuf);
    const meta = await baseImg.metadata();
    const width = meta.width || 1000;
    const height = meta.height || 1000;
    const shorter = Math.min(width, height);

    // 3) načítaj logo
    let logoBuf;
    if (logo && /^https?:\/\//i.test(logo)) {
      const l = await fetch(logo);
      if (!l.ok) {
        res.status(400).json({ error: "Failed to fetch logo" });
        return;
      }
      logoBuf = Buffer.from(await l.arrayBuffer());
    } else {
      try {
        logoBuf = await readFile(LOGO_PATH);
      } catch (e) {
        res.status(500).json({ error: "Logo not found in /public/logo.png" });
        return;
      }
    }

    // 4) uprav veľkosť loga (scale*kratšia strana)
    const scaleNum = Math.max(0.05, Math.min(1, Number(scale) || 0.35));
    const target = Math.max(24, Math.round(shorter * scaleNum));
    const logoPrepared = await sharp(logoBuf)
      .resize(target, target, { fit: "inside", withoutEnlargement: true })
      .png() // zachovaj alfu
      .toBuffer();

    // 5) composite do stredu s opacity
    const opacityNum = Math.max(0, Math.min(1, Number(opacity) || 0.05));
    const outBuf = await baseImg
      .composite([{ input: logoPrepared, gravity: "center", blend: "over", opacity: opacityNum }])
      .jpeg({ quality: 90 })
      .toBuffer();

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(outBuf);
  } catch (err) {
    console.error("WM ERROR:", err);
    res.status(500).json({ error: "Server error", message: String(err?.message || err) });
  }
}
