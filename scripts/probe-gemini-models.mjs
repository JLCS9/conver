#!/usr/bin/env node
/**
 * Lists Gemini models available to the given API key and highlights the
 * ones that support `bidiGenerateContent` (= Live API). Queries both
 * `v1beta` and `v1alpha` so we know which API version to point our
 * voice-gateway at.
 *
 * Usage:
 *   GEMINI_API_KEY=AIza... node scripts/probe-gemini-models.mjs
 */

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("Missing GEMINI_API_KEY env var.");
  process.exit(1);
}

const versions = ["v1beta", "v1alpha"];

for (const v of versions) {
  console.log(`\n========== ${v} ==========`);
  const url = `https://generativelanguage.googleapis.com/${v}/models?pageSize=200&key=${encodeURIComponent(apiKey)}`;

  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.error(`fetch failed: ${e.message ?? e}`);
    continue;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    continue;
  }

  const json = await res.json();
  const models = Array.isArray(json.models) ? json.models : [];

  const liveCapable = models.filter((m) =>
    Array.isArray(m.supportedGenerationMethods) &&
    m.supportedGenerationMethods.some((meth) =>
      /bidi|live|realtime/i.test(meth),
    ),
  );

  if (liveCapable.length === 0) {
    console.log(`(no models in this version expose a live/bidi method)`);
  } else {
    console.log(`MODELS SUPPORTING LIVE / BIDI in ${v}:`);
    for (const m of liveCapable) {
      console.log(`  • ${m.name}`);
      console.log(`    methods: ${m.supportedGenerationMethods.join(", ")}`);
      if (m.displayName) console.log(`    displayName: ${m.displayName}`);
      if (m.description) {
        console.log(`    description: ${m.description.slice(0, 140)}…`);
      }
    }
  }

  // Also surface any model whose name contains "3.5" so we see if our
  // assumption about the version exists at all.
  const generation35 = models.filter((m) => /3\.5/.test(m.name));
  if (generation35.length > 0) {
    console.log(`\n  Any gemini-3.5-* in ${v}:`);
    for (const m of generation35) {
      console.log(`    - ${m.name} → methods: [${m.supportedGenerationMethods?.join(", ") ?? "?"}]`);
    }
  } else {
    console.log(`\n  (no gemini-3.5-* found in ${v})`);
  }
}

console.log("\nDone.");
