// 模拟 v0.21 客户端与 prod admin v1.5.0 + 新网关的全链路（契约与集成 worktree 客户端一致）
import { createHmac, createHash, hkdfSync, createDecipheriv, randomUUID, randomInt } from "node:crypto";
import { execSync } from "node:child_process";

// Release-gate probe: one real managed AI request through the production
// billing chain (login -> llm-connections -> admit -> gateway chat -> usage
// settlement -> finish). Catches cross-service contract drift (admin admission
// SQL vs gateway endpoint vs client request shape) that mocked tests cannot.
//
// Required env:
//   PHONE_HMAC_SECRET   HMAC key used by phone_verification_codes
//   SIM_SPACE_ID        target enterprise product space UUID
//   SIM_PHONE           test tenant phone (+86…)
// Optional env (defaults):
//   SIM_ADMIN_BASE      default https://polo-admin.z-h-ai.com
//   SIM_MODEL           default deepseek-flash
//   SIM_PG_CONTAINER    default vrmtxfwgyi9ebkhtkiyerzzk-polo-admin-prod-postgres-1
//   SIM_PG_DB           default polo_admin_prod_db
//   SIM_SSH_HOST        default gz-main (ssh alias for the Coolify host)
// The probe plants a one-time phone code via ssh (test tenant only), spends a
// few hundred micros of the tenant's credit, and prints the run/request ids.
const BASE = process.env.SIM_ADMIN_BASE ?? "https://polo-admin.z-h-ai.com";
const SPACE = process.env.SIM_SPACE_ID;
const PHONE = process.env.SIM_PHONE;
const MODEL = process.env.SIM_MODEL ?? "deepseek-flash";
const PG = process.env.SIM_PG_CONTAINER ?? "vrmtxfwgyi9ebkhtkiyerzzk-polo-admin-prod-postgres-1";
const DB = process.env.SIM_PG_DB ?? "polo_admin_prod_db";
const SSH_HOST = process.env.SIM_SSH_HOST ?? "gz-main";
if (!SPACE || !PHONE) throw new Error("SIM_SPACE_ID and SIM_PHONE required");
const SECRET = process.env.PHONE_HMAC_SECRET;
if (!SECRET) throw new Error("PHONE_HMAC_SECRET required");

const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const log = (...a) => console.log("[sim]", ...a);

function plantCode() {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const hash = createHmac("sha256", SECRET).update(`${PHONE}\nphone_auth\n${code}`, "utf8").digest("hex");
  execSync(`ssh ${SSH_HOST} "docker exec -i ${PG} psql -U polo_admin_owner -d ${DB} -t -A -v ON_ERROR_STOP=1"`, {
    input: `INSERT INTO phone_verification_codes (id, phone, purpose, "codeHash", attempts, "expiresAt", "requestedAt", "requestIpHash") VALUES (gen_random_uuid(), '${PHONE}', 'phone_auth', '${hash}', 0, now() + interval '5 minutes', now(), repeat('0', 64));\n`,
    stdio: ["pipe", "ignore", "pipe"],
  });
  return code;
}

async function api(name, method, path, { body, bearer, expect = 200 } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status !== expect) throw new Error(`${name}: HTTP ${res.status} != ${expect}: ${JSON.stringify(json).slice(0, 500)}`);
  log(name, "OK", typeof json === "object" ? Object.keys(json).join(",") : "");
  return { json, headers: res.headers };
}

const code = plantCode();
log("code planted");
const verify = await api("phone/verify", "POST", "/api/auth/phone/verify", { body: { phone: PHONE, code } });
const jwt = verify.json.accessToken;
if (!jwt) throw new Error("no accessToken");
const transit = (envelope) => {
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(jwt, "utf8"), Buffer.from("polo-llm-key-encryption", "utf8"), Buffer.from("aes-256-gcm", "utf8"), 32));
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "hex"));
  d.setAuthTag(Buffer.from(envelope.tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(envelope.ciphertext, "hex")), d.final()]).toString("utf8");
};

const conn = await api("llm-connections", "GET", `/api/llm-connections?productSpaceId=${SPACE}`, { bearer: jwt });
const connection = conn.json.connections?.[0];
if (!connection) throw new Error("llm-connections returned EMPTY: " + JSON.stringify(conn.json).slice(0, 300));
log("connection", connection.slug, connection.baseUrl, "models:", connection.models?.map((m) => m.id).join(","));
const apiKey = transit(connection.apiKey);
log("key decrypted", apiKey.slice(0, 8) + "...", "fingerprint", sha256hex(apiKey).slice(0, 12));

const body = { model: MODEL, messages: [{ role: "user", content: "用一句话介绍你自己" }], max_tokens: 16, stream: false };
const wire = Buffer.from(JSON.stringify(body));
const requestBounds = {
  maxInputTokens: wire.length + 256 + body.messages.length * 64,
  maxOutputTokens: body.max_tokens,
  bodySha256: sha256hex(wire),
};
const runId = randomUUID(), requestId = randomUUID();

await api("billing/runs", "POST", "/api/billing/runs", {
  bearer: jwt,
  body: { productSpaceId: SPACE, runId, subjectKind: "polo_assistant" },
  expect: 201,
});
const admit = await api("billing/admit", "POST", `/api/billing/runs/${runId}/requests`, {
  bearer: jwt,
  body: {
    productSpaceId: SPACE, requestId, model: MODEL,
    hostRequestId: "host-" + randomUUID(),
    transportBaseUrl: connection.baseUrl,
    credentialFingerprint: sha256hex(apiKey),
    requestBounds,
  },
  expect: 201,
});
const nonce = admit.json.request?.providerCorrelation?.nonce;
if (!nonce) throw new Error("no nonce: " + JSON.stringify(admit.json).slice(0, 300));
log("admitted, nonce", nonce);

const chat = await fetch(connection.baseUrl.replace(/\/$/, "") + "/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, "x-polo-request-id": nonce },
  body: wire,
});
const chatJson = await chat.json();
const rid = chat.headers.get("x-oneapi-request-id");
log("chat", chat.status, "model:", chatJson.model, "usage:", JSON.stringify(chatJson.usage), "rid:", rid);
if (chat.status !== 200) throw new Error("chat failed: " + JSON.stringify(chatJson).slice(0, 400));
if (chatJson.model !== MODEL) throw new Error(`actualModel ${chatJson.model} != admitted ${MODEL}`);

const usage = await api("billing/usage", "POST", "/api/billing/usage", {
  bearer: jwt,
  body: {
    productSpaceId: SPACE, runId, requestId,
    inputTokens: chatJson.usage.prompt_tokens, outputTokens: chatJson.usage.completion_tokens,
    actualModel: chatJson.model,
    providerObservation: { version: 1, state: "observed", providerRequestId: rid, responseStatus: chat.status },
    outputDisposition: "usable", provenance: "provider_final",
  },
});
log("usage settlement:", JSON.stringify(usage.json));

await api("billing/finish", "PATCH", `/api/billing/runs/${runId}`, { bearer: jwt, body: { status: "completed" } });
console.log("\nSIM-E2E PASS — runId:", runId, "requestId:", requestId, "nonce:", nonce);
