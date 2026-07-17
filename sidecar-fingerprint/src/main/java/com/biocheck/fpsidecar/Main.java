package com.biocheck.fpsidecar;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.dataformat.cbor.databind.CBORMapper;
import com.machinezoo.sourceafis.FingerprintImage;
import com.machinezoo.sourceafis.FingerprintMatcher;
import com.machinezoo.sourceafis.FingerprintTemplate;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * BioCheck fingerprint sidecar - implements the wire contract defined by
 * biocheck_engine/providers/fingerprint.py.
 *
 * POST /v1/analyse  {image_b64, challenge_id, retain_image:false}
 *   -> {template_b64, model_id, model_sha256,
 *       quality:{finger_detected, score, minutiae_count}, pad:null}
 * POST /v1/compare  {template_a_b64, template_b_b64}
 *   -> {score, matcher_model_id, matcher_model_sha256}
 * GET  /healthz -> {status, model_id, model_sha256, score_mapping}
 *
 * Design rules (mirror of the engine's discipline):
 *  - images are never written to disk or logged; processed in memory and dropped
 *  - retain_image=true is refused
 *  - Bearer auth required on /v1/*; key from FP_SIDECAR_API_KEY
 *  - model_sha256 is the SHA-256 of the actual SourceAFIS jar on the classpath,
 *    computed at startup, so the engine's model registry pins the exact
 *    deployed algorithm build
 *  - PAD is never synthesised: pad is always null here (scanner-side PAD, when
 *    available, enters through the capture agent path, not this service)
 *
 * SCORE MAPPING (documented, placeholder until FP-006 calibration):
 *   SourceAFIS raw similarity is unbounded (vendor guidance: threshold ~40
 *   corresponds to FMR ~0.01%). We expose normalised = min(raw, 100) / 100.
 *   The mapping is linear and monotonic, so policy thresholds express raw
 *   scores divided by 100. Current engine placeholders (approve 0.80, review
 *   0.55) therefore mean raw 80 / raw 55 - deliberately conservative until
 *   calibrated on pilot data.
 *
 * QUALITY (documented proxy, placeholder until NFIQ2 integration):
 *   quality.score = min(1, minutiae_count / 40). This is a transparent proxy,
 *   not NFIQ2. The engine's min_quality gate of 0.60 therefore currently
 *   requires >= 24 detected minutiae. NFIQ2 integration is a planned upgrade
 *   and is tracked in FINGERPRINT_BUILD_STATUS.md.
 */
public final class Main {

    static final int MAX_BODY = 6 * 1024 * 1024;
    static final int MAX_CAPTURE = 4 * 1024 * 1024;
    static final int MAX_TEMPLATE = 64 * 1024;

    static final ObjectMapper JSON = new ObjectMapper();
    static final ObjectMapper CBOR = new CBORMapper();

    static String modelId = "sourceafis-java-unknown";
    /** The registry keys cards by model_id with one authorised purpose each, so
     *  extraction and matching report distinct IDs (same jar, same hash). */
    static String matcherModelId = "sourceafis-java-unknown-matcher";
    static String modelSha256 = "";
    static String apiKey;

    public static void main(String[] args) throws Exception {
        apiKey = System.getenv("FP_SIDECAR_API_KEY");
        if (apiKey == null || apiKey.isBlank())
            throw new IllegalStateException("FP_SIDECAR_API_KEY is required; refusing to start without auth.");
        int port = Integer.parseInt(System.getenv().getOrDefault("FP_SIDECAR_PORT", "8081"));

        resolveModelIdentity();

        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.setExecutor(Executors.newFixedThreadPool(4));
        server.createContext("/healthz", Main::health);
        server.createContext("/v1/analyse", ex -> authed(ex, Main::analyse));
        server.createContext("/v1/compare", ex -> authed(ex, Main::compare));
        server.start();
        System.out.println("fp-sidecar listening on :" + port + " model=" + modelId + " sha256=" + modelSha256);
    }

    /** Locate the SourceAFIS jar on the classpath and hash it. */
    static void resolveModelIdentity() throws Exception {
        String cp = System.getProperty("java.class.path");
        Path jar = null;
        for (String entry : cp.split(java.io.File.pathSeparator)) {
            String name = Path.of(entry).getFileName() == null ? "" : Path.of(entry).getFileName().toString();
            if (name.startsWith("sourceafis-") && name.endsWith(".jar")) { jar = Path.of(entry); break; }
        }
        if (jar == null) {
            // running from jar manifest classpath: resolve via code source
            var src = FingerprintTemplate.class.getProtectionDomain().getCodeSource();
            if (src != null && src.getLocation() != null)
                jar = Path.of(src.getLocation().toURI());
        }
        if (jar == null || !Files.isRegularFile(jar))
            throw new IllegalStateException("Cannot locate sourceafis jar to compute model hash; refusing to start.");
        String file = jar.getFileName().toString();
        modelId = file.replace(".jar", "").replace("sourceafis-", "sourceafis-java-");
        matcherModelId = modelId + "-matcher";
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        md.update(Files.readAllBytes(jar));
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format("%02x", b));
        modelSha256 = sb.toString();
    }

    // ------------------------------------------------------------- transport

    interface Handler { void handle(HttpExchange ex, JsonNode body) throws Exception; }

    static void authed(HttpExchange ex, Handler h) throws IOException {
        try {
            if (!"POST".equals(ex.getRequestMethod())) { send(ex, 405, err("method_not_allowed")); return; }
            String auth = ex.getRequestHeaders().getFirst("Authorization");
            if (auth == null || !constantTimeEquals(auth, "Bearer " + apiKey)) {
                send(ex, 401, err("unauthorised")); return;
            }
            byte[] raw = readBounded(ex.getRequestBody());
            JsonNode body = JSON.readTree(raw);
            h.handle(ex, body);
        } catch (ApiError e) {
            send(ex, e.status, err(e.getMessage()));
        } catch (Exception e) {
            // never leak internals or biometric data in errors
            send(ex, 500, err("internal_error"));
        }
    }

    static boolean constantTimeEquals(String a, String b) {
        byte[] x = a.getBytes(StandardCharsets.UTF_8);
        byte[] y = b.getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(x, y);
    }

    static byte[] readBounded(InputStream in) throws IOException {
        byte[] data = in.readNBytes(MAX_BODY + 1);
        if (data.length > MAX_BODY) throw new ApiError(413, "payload_too_large");
        return data;
    }

    static class ApiError extends RuntimeException {
        final int status;
        ApiError(int status, String code) { super(code); this.status = status; }
    }

    static ObjectNode err(String code) {
        ObjectNode n = JSON.createObjectNode();
        n.put("error", code);
        return n;
    }

    static void send(HttpExchange ex, int status, JsonNode body) throws IOException {
        byte[] out = JSON.writeValueAsBytes(body);
        ex.getResponseHeaders().set("Content-Type", "application/json");
        ex.sendResponseHeaders(status, out.length);
        try (var os = ex.getResponseBody()) { os.write(out); }
    }

    // ------------------------------------------------------------- endpoints

    static void health(HttpExchange ex) throws IOException {
        ObjectNode n = JSON.createObjectNode();
        n.put("status", "ok");
        n.put("model_id", modelId);
        n.put("matcher_model_id", matcherModelId);
        n.put("model_sha256", modelSha256);
        n.put("score_mapping", "normalised = min(raw, 100) / 100 (linear; placeholder until FP-006 calibration)");
        n.put("quality_mapping", "score = min(1, minutiae_count / 40) (proxy; NFIQ2 planned)");
        send(ex, 200, n);
    }

    static void analyse(HttpExchange ex, JsonNode body) throws Exception {
        if (body.path("retain_image").asBoolean(false))
            throw new ApiError(400, "retain_image_not_supported");
        String b64 = body.path("image_b64").asText(null);
        if (b64 == null) throw new ApiError(400, "image_b64_required");
        byte[] image;
        try { image = Base64.getDecoder().decode(b64); }
        catch (IllegalArgumentException e) { throw new ApiError(400, "image_b64_invalid"); }
        if (image.length == 0 || image.length > MAX_CAPTURE) throw new ApiError(400, "image_size_invalid");

        FingerprintTemplate template;
        try {
            template = new FingerprintTemplate(new FingerprintImage(image));
        } catch (Exception e) {
            throw new ApiError(422, "image_undecodable"); // PNG/JPEG/BMP grayscale expected
        }
        byte[] serialised = template.toByteArray();
        if (serialised.length > MAX_TEMPLATE) throw new ApiError(422, "template_too_large");

        int minutiae = countMinutiae(serialised);
        double quality = Math.min(1.0, minutiae / 40.0);

        ObjectNode q = JSON.createObjectNode();
        q.put("finger_detected", minutiae > 0);
        q.put("score", quality);
        q.put("minutiae_count", minutiae);

        ObjectNode n = JSON.createObjectNode();
        n.put("template_b64", Base64.getEncoder().encodeToString(serialised));
        n.put("model_id", modelId);
        n.put("model_sha256", modelSha256);
        n.set("quality", q);
        n.putNull("pad"); // PAD is never synthesised by this service
        send(ex, 200, n);
        // image and template references go out of scope here; nothing persisted
    }

    static void compare(HttpExchange ex, JsonNode body) throws Exception {
        byte[] a = decodeTemplate(body, "template_a_b64");
        byte[] b = decodeTemplate(body, "template_b_b64");
        FingerprintTemplate ta, tb;
        try {
            ta = new FingerprintTemplate(a);
            tb = new FingerprintTemplate(b);
        } catch (Exception e) {
            throw new ApiError(422, "template_undecodable");
        }
        double raw = new FingerprintMatcher(ta).match(tb);
        double normalised = Math.min(raw, 100.0) / 100.0; // documented linear mapping

        ObjectNode n = JSON.createObjectNode();
        n.put("score", normalised);
        n.put("raw_score", raw); // extra diagnostic; engine ignores unknown fields
        n.put("matcher_model_id", matcherModelId);
        n.put("matcher_model_sha256", modelSha256);
        send(ex, 200, n);
    }

    static byte[] decodeTemplate(JsonNode body, String field) {
        String b64 = body.path(field).asText(null);
        if (b64 == null) throw new ApiError(400, field + "_required");
        byte[] t;
        try { t = Base64.getDecoder().decode(b64); }
        catch (IllegalArgumentException e) { throw new ApiError(400, field + "_invalid"); }
        if (t.length == 0 || t.length > MAX_TEMPLATE) throw new ApiError(400, field + "_size_invalid");
        return t;
    }

    /** Count minutiae by decoding the SourceAFIS CBOR template. Prefers the
     *  "types" array; falls back to the largest top-level array. */
    static int countMinutiae(byte[] serialisedTemplate) throws IOException {
        JsonNode root = CBOR.readTree(serialisedTemplate);
        JsonNode types = root.get("types");
        if (types != null && types.isArray()) return types.size();
        int best = 0;
        Iterator<Map.Entry<String, JsonNode>> fields = root.fields();
        while (fields.hasNext()) {
            JsonNode v = fields.next().getValue();
            if (v.isArray()) best = Math.max(best, v.size());
        }
        return best;
    }

    private Main() {}
}
