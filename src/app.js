"use strict";

const express = require("express");
const { extractPost, browserPool } = require("./extract");
const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
});

const PORT = Number(process.env.PORT || 3001);
const SERVICE_TOKEN =
  process.env.EXTRACTOR_SERVICE_TOKEN ||
  "619d733a921b2429c3e557458fa48d401b7ca1a432b2ef3927833116b2bea9c8";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

let inflight = 0;

function unauthorized(res) {
  return res.status(401).json({ error: "unauthorized" });
}

function requireToken(req, res, next) {
  if (!SERVICE_TOKEN) {
    return res.status(503).json({ error: "unavailable" });
  }

  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (token !== SERVICE_TOKEN) {
    return unauthorized(res);
  }

  return next();
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    pool: browserPool.status(),
    stealth: browserPool.stealth,
    inflight,
  });
});

app.post("/extract", requireToken, async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";

  if (!url) {
    return res.status(422).json({ error: "invalid_url" });
  }

  inflight += 1;
  const started = Date.now();
  try {
    const result = await extractPost(url);
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        extract_ms: Date.now() - started,
        inflight,
        postType: result.postType,
        items: result.items.length,
      }),
    );
    return res.json(result);
  } catch (error) {
    const notFound =
      error &&
      (error.code === "MEDIA_NOT_FOUND" || error.code === "VIDEO_NOT_FOUND");
    return res.status(notFound ? 422 : 502).json({
      error: notFound ? "media_not_found" : "extraction_failed",
    });
  } finally {
    inflight -= 1;
  }
});

browserPool
  .warmup()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error("browser pool warmup failed", error);
  })
  .finally(() => {
    app.listen(PORT, "0.0.0.0", () => {
      // eslint-disable-next-line no-console
      console.log(`extractor listening on ${PORT}`);
    });
  });