const rateLimitMap = new Map();
const RATE_LIMIT_MS = 2 * 60 * 1000; // 2 minutes

module.exports = async (req, res) => {
  // Only allow POST requests
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
       throw new Error("Server is missing IMGBB_API_KEY or WEB3FORMS_KEY in Vercel Environment Variables!");
    }

    // --- 2. UPLOAD TO IMGBB ---
    const uploadToImgBB = async (base64Str) => {
      const formData = new FormData();
      formData.append("key", imgbbKey);
      formData.append("image", base64Str);
      
      const response = await fetch("https://api.imgbb.com/1/upload", {
        method: "POST",
        body: formData,
      });
      
      const data = await response.json();
      if (!data.success) throw new Error("Image Upload Failed: " + (data.error?.message || "Unknown error"));
      return data.data.url;
    };

    // Sequential Upload to bypass rate-limits
    const allImages = [thumbBase64, ...(screensBase64 || [])];
    const uploadedUrls = [];
    
    for (let i = 0; i < allImages.length; i++) {
      if (!allImages[i]) continue;
      const url = await uploadToImgBB(allImages[i]);
      uploadedUrls.push(url);
    }

    const thumbUrl = uploadedUrls[0] || "";
    const screenUrls = uploadedUrls.slice(1);

    // --- 3. ASSEMBLE LUA EMAIL ---
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

    // --- 4. SEND EMAIL VIA WEB3FORMS ---
    const origin = req.headers.origin || "https://hb-blueprints.vercel.app";

    const emailRes = await fetch("https://api.web3forms.com/submit", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json", 
        "Accept": "application/json",
        // Agressive Browser Spoofing Headers to bypass Cloudflare
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Origin": origin,
        "Referer": origin + "/",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
        "Accept-Language": "en-US,en;q=0.9"
      },
      // Using JSON payload instead of Form Data as required by Web3Forms docs
      body: JSON.stringify({
        access_key: web3formsKey,
        subject: `New Blueprint: ${title} by ${author}`,
        from_name: "Home Bound Blueprints",
        name: author,
        message: plainTextLua
      }),
    });

    // Read the response safely
    const emailText = await emailRes.text();
    let emailData;
    try {
      emailData = JSON.parse(emailText);
    } catch (err) {
      throw new Error(`Cloudflare Web3Forms Block (${emailRes.status}). Ensure you aren't blocked by Web3Forms' free tier limitations. Response: ${emailText.substring(0, 80)}...`);
    }

    if (!emailData.success) {
       throw new Error("Web3Forms Email Failed: " + (emailData.message || "Unknown error"));
    }

    // Success!
    res.status(200).json({ success: true, message: "Blueprint submitted successfully!" });

  } catch (error) {
    console.error("Submission Error:", error);
    rateLimitMap.delete(ip); 
    res.status(500).json({ error: error.message || "An error occurred during submission." });
  }
};
