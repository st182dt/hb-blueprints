const rateLimitMap = new Map();
const RATE_LIMIT_MS = 2 * 60 * 1000; // 2 minutes

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // --- 1. RATE LIMITING ---
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  
  if (rateLimitMap.has(ip)) {
    const lastSubTime = rateLimitMap.get(ip);
    if (now - lastSubTime < RATE_LIMIT_MS) {
      const timeLeft = Math.ceil((RATE_LIMIT_MS - (now - lastSubTime)) / 1000);
      return res.status(429).json({ error: `Please wait ${timeLeft} seconds before submitting again.` });
    }
  }
  rateLimitMap.set(ip, now);

  const { author, title, type, desc, blueprint, thumbBase64, screensBase64 } = req.body;

  try {
    const imgbbKey = process.env.IMGBB_API_KEY; 
    const web3formsKey = process.env.WEB3FORMS_KEY; 
    
    if (!imgbbKey || !web3formsKey) {
       throw new Error("Server is missing API Keys in Vercel Environment Variables!");
    }

    // Upload function
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

    // --- FASTER UPLOAD: Do them all at the exact same time ---
    // Start the thumbnail upload
    const thumbPromise = uploadToImgBB(thumbBase64);
    
    // Start all screenshot uploads
    const screenPromises = screensBase64.map(base64 => uploadToImgBB(base64));
    
    // Wait for all of them to finish simultaneously
    const [thumbUrl, ...screenUrls] = await Promise.all([thumbPromise, ...screenPromises]);


    // --- ASSEMBLE LUA EMAIL ---
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

    // --- SEND EMAIL ---
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
