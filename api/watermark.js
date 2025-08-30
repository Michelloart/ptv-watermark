import sharp from "sharp";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGO_PATH = path.resolve(__dirname, "..", "public", "logo.png");

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
      url,
      type = "blur",
      sigma = "24",
      block = "25",
      logo,
      opacity = "0.05",
      scale = "0.35",
      key
    } = req.query;

    if (process.env.API_KEY && key !== process.env.API_KEY) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!url || !/^https?:\/\//i.test(url)) {
      res.status(400).json({ error: "Missing or invalid 'url' parameter" });
      return;
    }

    const srcResp = await fetch(url);
    if (!srcResp.ok) {
      res.status(400).json({ error: "Failed to fetch source image", status: srcResp.status });
      return;
    }
    const ct = srcResp.headers.get("content-type") || "";
    if (!ct.includes("image") && !ct.includes("octet-stream")) {
      res.status(415).json({ error: "URL is not an image", contentType: ct });
      return;
    }
    const srcBuf = Buffer.from(await srcResp.arrayBuffer());

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

    let logoBuf;
    if (logo && /^https?:\/\//i.test(logo)) {
      const lr = await fetch(logo);
      if (!lr.ok) {
        res.status(400).json({ error: "Failed to fetch logo" });
        return;
      }
      logoBuf = Buffer.from(await lr.arrayBuffer());
    } else {
      try {
        logoBuf = await readFile(LOGO_PATH);
      } catch {
        res.status(500).json({ error: "Logo not found in /public/logo.png" });
        return;
      }
    }

    // 4) uprav veľkosť loga (scale*kratšia strana)
const scaleNum = Math.max(0.05, Math.min(1, Number(scale) || 0.35));
const target = Math.max(24, Math.round(shorter * scaleNum));

const logoPrepared = await sharp(logoBuf)
  .resize(target, target, { fit: "inside", withoutEnlargement: true })
  .ensureAlpha() // pridaj alfa kanál
  .modulate({ opacity: Number(opacity) || 0.05 }) // zníž nepriehľadnosť
  .png()
  .toBuffer();

const outBuf = await baseImg
  .composite([
    {
      input: logoPrepared,
      gravity: "center",
      blend: "over"
    }
  ])
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

