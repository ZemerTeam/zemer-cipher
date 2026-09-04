// The monitor's issue bookkeeping, shared by two workflow steps that differ only in TOKEN:
//   mode "create"  - opens NEW detection issues as the Zemer-Dude App (bot avatar)
//   mode "comment" - comments on EXISTING ones with the built-in GITHUB_TOKEN (the App token is
//                    not granted comment/close: 'Resource not accessible by integration')
// Titles come from decide.mjs (one definition); the plan/scan/drift files come from the run.
//
//   await require(`${process.env.GITHUB_WORKSPACE}/tools/clients/issues.cjs`)({ github, context, core, mode })

module.exports = async function syncIssues({ github, context, core, mode }) {
  const fs = require("fs");
  const path = require("path");
  const { pathToFileURL } = require("url");
  const decide = await import(pathToFileURL(path.join(process.env.GITHUB_WORKSPACE, "tools/clients/decide.mjs")).href);
  const plan = JSON.parse(fs.readFileSync("/tmp/plan.json", "utf8"));
  const scan = JSON.parse(fs.readFileSync("/tmp/scan.json", "utf8"));
  const drift = JSON.parse(fs.readFileSync("/tmp/drift.json", "utf8"));
  const open = new Map(JSON.parse(process.env.OPEN_TITLES || "[]").map(([n, t]) => [t, n]));
  const deployMode = process.env.DEPLOY_MODE || "(disabled)";
  const run = process.env.RUN_URL;
  const { owner, repo } = context.repo;

  const reasons = (key) => (scan.clients.find((c) => c.key === key)?.results || [])
    .map((r) => `- \`${r.video}\`: ${r.kind}${r.reason ? " — " + r.reason : ""}`).join("\n");
  const sabrReasons = (key) => (scan.clients.find((c) => c.key === key)?.sabrResults || [])
    .map((r) => `- \`${r.video}\` (SABR): ${r.kind}${r.reason ? " — " + r.reason : ""}`).join("\n");

  const upsert = async (title, body, comment) => {
    if (open.has(title)) {
      if (mode !== "comment") return;
      await github.rest.issues.createComment({ owner, repo, issue_number: open.get(title), body: comment });
      core.info(`updated #${open.get(title)}: ${title}`);
    } else {
      if (mode !== "create") return;
      // No labels: the App token may not create labels, and titles are the dedup key.
      const { data } = await github.rest.issues.create({ owner, repo, title, body });
      core.info(`opened #${data.number}: ${title}`);
    }
  };

  for (const key of plan.dead) {
    const benched = plan.bench.includes(key);
    const refusal = (plan.refused.find((r) => r.key === key) || {}).reason || "see plan";
    await upsert(decide.issueTitle(key),
      [`## Stream client \`${key}\` fails every validation video`, "", reasons(key), "",
       `Benched automatically on the NEXT run if it is still failing (deploy mode: \`${deployMode}\`). Devices pick a bench up within 6 h, or at once after a total resolution failure.`, "", `Run: ${run}`].join("\n"),
      benched ? `Still failing — **benching now** (deploy mode \`${deployMode}\`).\n\n${reasons(key)}\n\nRun: ${run}`
              : `Still failing on this run (not benched: ${refusal}).\n\n${reasons(key)}\n\nRun: ${run}`);
  }
  for (const key of plan.revived) {
    await upsert(decide.revivedTitle(key),
      [`## Benched entry \`${key}\` drains whole songs again`, "", reasons(key), "", `Un-benched automatically on the NEXT run if still whole (deploy mode: \`${deployMode}\`).`, "", `Run: ${run}`].join("\n"),
      plan.unbench.includes(key) ? `Still whole — **un-benching now** (deploy mode \`${deployMode}\`).\n\nRun: ${run}` : `Still whole on this run.\n\nRun: ${run}`);
  }
  for (const key of plan.sabrDead || []) {
    const benched = (plan.sabrBench || []).includes(key);
    const refusal = (plan.refused.find((r) => r.key === key && /^SABR/.test(r.reason)) || {}).reason || "see plan";
    await upsert(decide.sabrIssueTitle(key),
      [`## \`${key}\` fails every validation video over SABR`, "", sabrReasons(key), "",
       `Its SABR capability (\`sabr.enabled: false\`) is benched automatically on the NEXT run if still failing (deploy mode: \`${deployMode}\`); the entry keeps streaming progressively.`, "", `Run: ${run}`].join("\n"),
      benched ? `Still failing over SABR — **benching the SABR capability now** (deploy mode \`${deployMode}\`).\n\n${sabrReasons(key)}\n\nRun: ${run}`
              : `Still failing over SABR on this run (not benched: ${refusal}).\n\n${sabrReasons(key)}\n\nRun: ${run}`);
  }
  for (const key of plan.sabrRevived || []) {
    await upsert(decide.sabrRevivedTitle(key),
      [`## \`${key}\` drains whole songs over SABR again (capability benched)`, "", sabrReasons(key), "", `Un-benched automatically on the NEXT run if still whole (deploy mode: \`${deployMode}\`).`, "", `Run: ${run}`].join("\n"),
      (plan.sabrUnbench || []).includes(key) ? `Still whole — **un-benching the SABR capability now** (deploy mode \`${deployMode}\`).\n\nRun: ${run}` : `Still whole over SABR on this run.\n\nRun: ${run}`);
  }
  for (const key of plan.resurrected) {
    await upsert(decide.resurrectedTitle(key),
      [`## Retired client \`${key}\` drained a whole song`, "", reasons(key), "", "The app removed this client as dead. Re-adding it is a validated table change (`node tests/validate-stream-clients.mjs` against a candidate file) — never automatic.", "", `Run: ${run}`].join("\n"),
      `Still working on this run.\n\nRun: ${run}`);
  }
  for (const d of drift.drift || []) {
    const verified = plan.bumps.some((b) => b.key === d.key);
    const what = Object.entries(d.changes || {}).map(([f, c]) => `- \`${f}\`: \`${c.from}\` → \`${c.to}\``).join("\n");
    if (verified && deployMode !== "(disabled)") { core.info(`${d.key}: verified bump, deploying (mode ${deployMode})`); continue; }
    await upsert(decide.driftTitle(d.key),
      [`## \`${d.key}\` is behind yt-dlp master (\`${d.ytdlpKey}\`)`, "", what, "",
       verified ? `The candidate drained whole songs on every validation video — it would deploy, but auto-deploy is off (AUTO_DEPLOY_CLIENTS=\`${deployMode}\`).`
                : `The candidate could NOT be verified from this runner: ${d.verify || "no result"}. It is retried every run; with SCAN_PROXY (residential egress) login-less clients become verifiable.`,
       "", `Run: ${run}`].join("\n"),
      `${verified ? "Verified but not deployed (auto-deploy off)" : "Still not verified: " + (d.verify || "no result")}.\n\nRun: ${run}`);
  }
  const authFailed = scan.clients.filter((c) => (c.role || "live") === "live" && [...(c.results || []), ...(c.sabrResults || [])].some((r) => r.kind === "auth-failed")).map((c) => c.key);
  if (authFailed.length) {
    await upsert(decide.COOKIE_TITLE,
      [`## The session cookie no longer authenticates`, "", `${authFailed.join(", ")} answered a sign-in demand although the cookie was sent. Refresh the \`YT_COOKIE\` / \`YT_VISITOR_DATA\` secrets (dump a fresh session). Until then the login clients are inconclusive - nothing is benched on their account.`, "", `Run: ${run}`].join("\n"),
      `Still failing to authenticate (${authFailed.join(", ")}).\n\nRun: ${run}`);
  }
  if (!plan.conclusive) {
    await upsert(decide.INCONCLUSIVE_TITLE,
      ["## No client drained a whole song on any validation video", "", "Nothing was benched — the runner, cookie, or cipher is suspect, not the table. Check the cookie secrets, `SCAN_PROXY`, `VALIDATION_VIDEO_IDS`, and the scan log artifact.", "", `Run: ${run}`].join("\n"),
      `Still inconclusive.\n\nRun: ${run}`);
  }
};
