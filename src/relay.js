import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const config = {
  api: { bodyParser: false },
  supportsResponseStreaming: true,
  maxDuration: 55,
};

const DESTINATION = (process.env.TARGET_DOMAIN || "").replace(/\/+$/, "");

const SKIP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

function prepareHeaders(incoming) {
  const result = {};
  let senderIp = null;

  for (const rawKey of Object.keys(incoming)) {
    const k = rawKey.toLowerCase();
    const v = incoming[rawKey];

    if (SKIP_HEADERS.has(k)) continue;
    if (k.startsWith("x-vercel-")) continue;

    if (k === "x-real-ip") {
      senderIp = v;
      continue;
    }
    if (k === "x-forwarded-for") {
      if (!senderIp) senderIp = v;
      continue;
    }

    result[k] = Array.isArray(v) ? v.join(", ") : v;
  }

  if (senderIp) result["x-forwarded-for"] = senderIp;
  return result;
}

function methodHasBody(method) {
  return method !== "GET" && method !== "HEAD";
}

export default async function main(req, res) {
  if (!DESTINATION) {
    res.statusCode = 500;
    return res.end("Misconfigured: TARGET_DOMAIN env var is missing");
  }

  try {
    const targetUrl = DESTINATION + req.url;
    const method = req.method;
    const headers = prepareHeaders(req.headers);

    const options = { method, headers, redirect: "manual" };

    if (methodHasBody(method)) {
      options.body = Readable.toWeb(req);
      options.duplex = "half";
    }

    const response = await fetch(targetUrl, options);

    res.statusCode = response.status;

    for (const [k, v] of response.headers) {
      if (k.toLowerCase() === "transfer-encoding") continue;
      try {
        res.setHeader(k, v);
      } catch {
        // skip unwritable headers
      }
    }

    if (response.body) {
      await pipeline(Readable.fromWeb(response.body), res);
    } else {
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end("Bad Gateway: upstream unreachable");
    }
  }
}
