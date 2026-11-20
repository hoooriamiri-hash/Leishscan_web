const REPO = "hoooriamiri-hash/leishscan-ai-api";

const json = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

const MAX_B64 = 1_500_000;

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
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Invalid JSON" }); }
  const { action, requestId } = body;
  if (!requestId) return json(400, { error: "Missing requestId" });

  try {
    if (action === "start") {
      const { lesionBase64, microscopyBase64 } = body;
      if (!lesionBase64 || !microscopyBase64) return json(400, { error: "Both images required" });
      if (lesionBase64.length > MAX_B64 || microscopyBase64.length > MAX_B64)
        return json(413, { error: "Image too large" });

      const [lesionUrl, microUrl] = await Promise.all([
        uploadToImgBB(lesionBase64, `${requestId}-lesion`),
        uploadToImgBB(microscopyBase64, `${requestId}-micro`),
      ]);

      const r = await gh(`/actions/workflows/predict.yml/dispatches`, {
        method: "POST",
        body: JSON.stringify({
          ref: "main",
          inputs: { request_id: requestId, lesion_url: lesionUrl, microscopy_url: microUrl },
        }),
      });
      if (r.status !== 204) return json(502, { error: "Could not trigger analysis" });
      return json(200, { status: "started", requestId });
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
