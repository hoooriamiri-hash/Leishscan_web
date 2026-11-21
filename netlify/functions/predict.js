const REPO = "hoooriamiri-hash/leishscan-ai-api";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  body: JSON.stringify(body),
});

const MAX_B64 = 1_500_000;
const MAX_TOTAL_B64 = 5_600_000; // stays under the 6 MB function payload limit
const MAX_MICRO = 5;

async function uploadToImgBB(b64, name) {
  const cleanB64 = b64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "");
  const r = await fetch(
    `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}&expiration=300`,
    { method: "POST", body: new URLSearchParams({ image: cleanB64, name }) }
  );
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.success) throw new Error("ImgBB upload failed");
  return d.data.url;
}

const gh = (path, opts = {}) =>
  fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "leishscan-ai",
      ...(opts.headers || {}),
    },
  });

exports.handler = async (event) => {
  // CORS preflight (needed when index.html is opened from file:// or localhost)
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Invalid JSON" }); }
  const { action, requestId } = body;
  if (!requestId) return json(400, { error: "Missing requestId" });

  try {
    if (action === "start") {
      const { lesionBase64 } = body;

      // New format: microscopyBase64List (1-5). Old format: single microscopyBase64 string.
      let microList = Array.isArray(body.microscopyBase64List)
        ? body.microscopyBase64List
        : body.microscopyBase64
        ? [body.microscopyBase64]
        : [];
      microList = microList.filter((x) => typeof x === "string" && x.length > 0);

      if (!lesionBase64 || typeof lesionBase64 !== "string")
        return json(400, { error: "Clinical lesion image required" });
      if (microList.length < 1) return json(400, { error: "At least 1 microscopy image required" });
      if (microList.length > MAX_MICRO)
        return json(400, { error: `Maximum ${MAX_MICRO} microscopy images allowed` });
      if (lesionBase64.length > MAX_B64 || microList.some((m) => m.length > MAX_B64))
        return json(413, { error: "Image too large" });
      if (lesionBase64.length + microList.reduce((a, m) => a + m.length, 0) > MAX_TOTAL_B64)
        return json(413, { error: "Total upload too large" });

      // Upload lesion + all microscopy fields in parallel
      const [lesionUrl, ...microUrls] = await Promise.all([
        uploadToImgBB(lesionBase64, `${requestId}-lesion`),
        ...microList.map((m, i) => uploadToImgBB(m, `${requestId}-micro${i + 1}`)),
      ]);

      const r = await gh(`/actions/workflows/predict.yml/dispatches`, {
        method: "POST",
        body: JSON.stringify({
          ref: "main",
          inputs: {
            request_id: requestId,
            lesion_url: lesionUrl,
            microscopy_urls: JSON.stringify(microUrls),
          },
        }),
      });
      if (r.status !== 204) return json(502, { error: "Could not trigger analysis" });
      return json(200, { status: "started", requestId, microscopyCount: microUrls.length });
    }

    if (action === "poll") {
      const r = await gh(`/issues?state=all&per_page=20`);
      if (!r.ok) return json(502, { error: "Could not read issues" });
      const issues = await r.json();
      const match = issues.find((iss) => iss.title === `RESULT-${requestId}`);
      if (!match) return json(200, { status: "pending" });

      const raw = (match.body || "").replace(/```json|```/g, "").trim();
      const result = JSON.parse(raw);
      return json(200, { status: "completed", result });
    }

    return json(400, { error: "Unknown action" });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
