import sharp from "sharp";

// pomocné: pixelácia (mozaika)
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
      url,                 // URL pôvodného obrázka (povinné)
      type = "blur",       // "blur" | "pixelate" | "none"
      sigma = "20",        // sila blur (pri type=blur)
      block = "20",        // veľkosť kociek (pri type=pixelate)
      logo,                // voliteľné: URL loga (ak nechceš použiť /public/logo.png)
      opacity = "0.05",    // priehľadnosť loga (0..1), default 5 %
      scale = "0.35",      // veľkosť loga voči kratšej strane (0..1), default 35 %
      key                  // jednoduchá ochrana
    } = req.query;

    // jednoduchý "key" (voliteľné) – nastav vo Verceli API_KEY
    if (process.env.API_KEY && key !== process.env.API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: "Missing or invalid 'url' parameter" });
    }

    // 1) načítaj zdrojový obrázok
    const srcResp = await fetch(url);
    if (!srcResp.ok) {
      return res.status(400).json({ error: "Failed to fetch source image" });
    }
    const srcBuf = Buffer.from(await srcResp.arrayBuffer());

    // 2) priprav základ (blur/pixelate/none) + meta
    let baseBuf;
    if (type === "pixelate") {
      baseBuf = await pixelate(srcBuf, Number(block));
    } else if (type === "none") {
      baseBuf = await sharp(srcBuf).jpeg({ quality: 90 }).toBuffer();
    } else {
      // blur (sigma >= 1, ak by niekto poslal 0, dáme min 1)
      const s = Math.max(1, Number(sigma) || 20);
      baseBuf = await sharp(srcBuf).blur(s).jpeg({ quality: 90 }).toBuffer();
    }

    const baseImg = sharp(baseBuf);
    const meta = await baseImg.metadata();
    const width = meta.width || 1000;
    const height = meta.height || 1000;
    const shorter = Math.min(width, height);

    // 3) načítaj/ pripravené logo
    let logoBuf;
    if (logo && /^https?:\/\//i.test(logo)) {
      const logoResp = await fetch(logo);
      if (!logoResp.ok) return res.status(400).json({ error: "Failed to fetch logo" });
      logoBuf = Buffer.from(await logoResp.arrayBuffer());
    } else {
      // lokálne logo z public
      // Vercel pri deployi sprístupní /public; čítame súbor priamo z FS
      logoBuf = await sharp("./public/logo.png").png().toBuffer();
    }

    // spočítaj cieľovú veľkosť loga (napr. 35 % kratšej strany)
    const scaleNum = Math.max(0.05, Math.min(1, Number(scale) || 0.35));
    const targetSize = Math.max(24, Math.round(shorter * scaleNum));

    // uprav logo: sprav PNG s alfou, kvôli opacity v composite
    const logoPrepared = await sharp(logoBuf)
      .resize(targetSize, targetSize, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();

    // 4) composite – logo doprostred, s opacity (default 5 %)
    const opacityNum = Math.max(0, Math.min(1, Number(opacity) || 0.05));

    const outBuf = await baseImg
      .composite([
        {
          input: logoPrepared,
          gravity: "center",
          blend: "over",
          opacity: opacityNum
        }
      ])
      .jpeg({ quality: 90 })
      .toBuffer();

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(outBuf);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
