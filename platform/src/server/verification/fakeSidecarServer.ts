/**
 * Contract-test inference sidecar (HTTP). Serves the verify-core wire contract
 * (/v1/analyse, /v1/templates, /v1/compare) backed by the deterministic
 * FakeProvider. Development and contract tests ONLY — refuses production and
 * processes no biometric data (fixtures are JSON documents).
 */
import { createServer } from "node:http";
import { FakeProvider } from "./providers";

if (process.env.NODE_ENV === "production") {
  throw new Error("The fake sidecar must never run in production.");
}

const provider = new FakeProvider();
const port = Number(process.env.PORT ?? 8090);

createServer(async (req, res) => {
  const respond = (status: number, body: object) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method !== "POST") return respond(405, { error: "POST only" });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");

    if (req.url === "/v1/analyse") {
      const analysis = await provider.analyseCapture(Buffer.from(String(body.image_b64 ?? ""), "base64"), String(body.challenge_id ?? "x"));
      return respond(200, {
        capture_ref: analysis.captureRef,
        model_id: analysis.modelId,
        model_sha256: analysis.modelSha256,
        quality: {
          face_detected: analysis.quality.faceDetected,
          score: analysis.quality.qualityScore,
          pose_degrees: analysis.quality.poseDegrees,
          occlusion_score: analysis.quality.occlusionScore,
        },
        passive_pad: {
          model_id: analysis.padModelId,
          model_sha256: analysis.padModelSha256,
          is_live: analysis.liveness.isLive,
          score: analysis.liveness.score,
          attack_type: analysis.liveness.attackType,
        },
      });
    }
    if (req.url === "/v1/templates") {
      const template = await provider.createTemplate(String(body.capture_ref));
      return respond(200, {
        template_ciphertext: template.templateCiphertext,
        model_id: template.modelId,
        model_sha256: template.modelSha256,
      });
    }
    if (req.url === "/v1/compare") {
      const { similarity } = await provider.compareTemplates(String(body.template_ciphertext), String(body.capture_ref));
      return respond(200, { similarity });
    }
    return respond(404, { error: "unknown route" });
  } catch (err) {
    return respond(500, { error: err instanceof Error ? err.message : "error" });
  }
}).listen(port, () => console.log(`[fake-sidecar] contract-test service on :${port} (no biometrics; dev only)`));
