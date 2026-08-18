// Basic in-memory store for Rate Limiting
const rateLimitMap = new Map();
const RATE_LIMIT_MS = 2 * 60 * 1000; // 2 minutes

module.exports = async (req, res) => {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // --- 1. RATE LIMITING (Based on IP Address) ---
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  
  if (rateLimitMap.has(ip)) {
    const lastSubTime = rateLimitMap.get(ip);
    if (now - lastSubTime < RATE_LIMIT_MS) {
      const timeLeft = Math.ceil((RATE_LIMIT_MS - (now - lastSubTime)) / 1000);
      return res.status(429).json({ error: `Please wait ${timeLeft} seconds before submitting again.` });
    }
  }
  // Record the time of this submission
  rateLimitMap.set(ip, now);

  // --- 2. GET DATA FROM FRONTEND ---
  const { author, title, type, desc, blueprint, thumbBase64, screensBase64 } = req.body;

  try {
    // --- 3. UPLOAD IMAGES TO IMGBB ---
    const imgbbKey = process.env.IMGBB_API_KEY; 
    
    if (!imgbbKey) {
       throw new Error("Server is missing IMGBB_API_KEY");
    }

    const uploadToImgBB = async (base64Str) => {
      const formData = new URLSearchParams();
      formData.append("key", imgbbKey);
      formData.append("image", base64Str);
      
      const response = await fetch("https://api.imgbb.com/1/upload", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();
      if (!data.success) throw new Error("Image Upload Failed");
      return data.data.url;
    };

    // Upload thumbnail
    const thumbUrl = await uploadToImgBB(thumbBase64);

    // Upload screenshots
    const screenUrls = [];
    for (let i = 0; i < screensBase64.length; i++) {
      const url = await uploadToImgBB(screensBase64[i]);
      screenUrls.push(url);
    }

    // --- 4. ASSEMBLE EMAIL MESSAGE ---
    const buildId = "hb-999";
    const addedIn = Math.floor(Date.now() / 1000);

    const screenshotPaths = screenUrls.map((_, i) => `"Interface\\\\AddOns\\\\HomeBound_Blueprints\\\\Assets\\\\${buildId}_${i + 1}"`);
    let screenshotsLuaBlock = "{}";
    
    if (screenshotPaths.length > 0) {
      screenshotsLuaBlock = `{\n    ${screenshotPaths.join(",\n    ")}\n  }`;
    }

    let plainTextLua = `{
  id = "${buildId}",
  title = "${title}",
  author = "${author}",
  code = "${blueprint}",
  description = "${desc}",
  type = "${type}",
  addedIn = ${addedIn},
  thumb = "Interface\\\\AddOns\\\\HomeBound_Blueprints\\\\Assets\\\\${buildId}_thumb",
  screenshots = ${screenshotsLuaBlock}
}

=== IMAGE LINKS ===
Thumbnail: ${thumbUrl}
`;
    screenUrls.forEach((url, i) => {
      plainTextLua += `Screenshot ${i + 1}: ${url}\n`;
    });

    // --- 5. SEND EMAIL VIA WEB3FORMS ---
    const web3formsKey = process.env.WEB3FORMS_KEY; 
    
    if (!web3formsKey) {
       throw new Error("Server is missing WEB3FORMS_KEY");
    }

    const emailRes = await fetch("https://api.web3forms.com/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        access_key: web3formsKey,
        subject: `New Blueprint: ${title} by ${author}`,
        from_name: "Home Bound Blueprints",
        name: author,
        message: plainTextLua,
      }),
    });

    const emailData = await emailRes.json();
    if (!emailData.success) throw new Error("Web3Forms Email Failed");

    // Success!
    res.status(200).json({ success: true, message: "Blueprint submitted successfully!" });

  } catch (error) {
    console.error(error);
    rateLimitMap.delete(ip); 
    res.status(500).json({ error: error.message || "An error occurred during submission." });
  }
};