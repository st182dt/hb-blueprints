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

    // --- UPLOAD TO IMGBB ---
    const uploadToImgBB = async (base64Str) => {
      const formData = new FormData();
      formData.append("key", imgbbKey);
      formData.append("image", base64Str);
      
      const response = await fetch("https://api.imgbb.com/1/upload", {
        method: "POST",
        body: formData,
      });
      
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error(`ImgBB API Blocked Request (Status ${response.status}). Response: ${text.substring(0, 80)}...`);
      }

      if (!data.success) throw new Error("Image Upload Failed: " + (data.error?.message || "Unknown error"));
      return data.data.url;
    };

    // Sequential Upload to bypass Cloudflare rate-limits
    const allImages = [thumbBase64, ...(screensBase64 || [])];
    const uploadedUrls = [];
    
    for (let i = 0; i < allImages.length; i++) {
      const url = await uploadToImgBB(allImages[i]);
      uploadedUrls.push(url);
    }

    const thumbUrl = uploadedUrls[0];
    const screenUrls = uploadedUrls.slice(1);

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

    // --- SEND EMAIL TO WEB3FORMS ---
    // FIX: Convert from JSON to standard Form-Urlencoded. This prevents the LUA code
    // from triggering Cloudflare's malicious code injection filters.
    const emailParams = new URLSearchParams();
    emailParams.append("access_key", web3formsKey);
    emailParams.append("subject", `New Blueprint: ${title} by ${author}`);
    emailParams.append("from_name", "Home Bound Blueprints");
    emailParams.append("name", author);
    emailParams.append("message", plainTextLua);

    const emailRes = await fetch("https://api.web3forms.com/submit", {
      method: "POST",
      headers: { 
        "Content-Type": "application/x-www-form-urlencoded", 
        "Accept": "application/json",
        // Tell Cloudflare the request originates from your domain
        "Origin": req.headers.origin || "https://hb-blueprints.vercel.app"
      },
      body: emailParams.toString(),
    });

    // Read the response safely
    const emailText = await emailRes.text();
    let emailData;
    try {
      emailData = JSON.parse(emailText);
    } catch (err) {
      // Updated the error text so it's accurate this time
      throw new Error(`Web3Forms Cloudflare Block (${emailRes.status}). Response: ${emailText.substring(0, 80)}...`);
    }

    if (!emailData.success) throw new Error("Web3Forms Email Failed: " + (emailData.message || "Unknown error"));

    // Success!
    res.status(200).json({ success: true, message: "Blueprint submitted successfully!" });

  } catch (error) {
    console.error("Submission Error:", error);
    rateLimitMap.delete(ip); 
    res.status(500).json({ error: error.message || "An error occurred during submission." });
  }
};
