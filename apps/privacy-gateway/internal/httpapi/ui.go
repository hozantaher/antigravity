package httpapi

import (
	"io"
	"net/http"
)

const localUIShellHTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Privacy Gateway Local Shell</title>
  <style>
    :root {
      --paper: #f6f0e7;
      --ink: #1b1b19;
      --accent: #0f766e;
      --accent-soft: #d5ebe8;
      --warning: #8a3b12;
      --panel: rgba(255,255,255,0.82);
      --line: rgba(27,27,25,0.12);
      --shadow: 0 18px 48px rgba(27,27,25,0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(15,118,110,0.16), transparent 28%),
        radial-gradient(circle at top right, rgba(138,59,18,0.14), transparent 24%),
        linear-gradient(180deg, #fbf7f1 0%, var(--paper) 100%);
    }
    .shell {
      max-width: 1280px;
      margin: 0 auto;
      padding: 28px 18px 72px;
    }
    .hero {
      display: grid;
      gap: 14px;
      padding: 28px;
      border: 1px solid var(--line);
      background: linear-gradient(135deg, rgba(255,255,255,0.9), rgba(213,235,232,0.7));
      box-shadow: var(--shadow);
    }
    .eyebrow {
      font-family: "Avenir Next Condensed", "Trebuchet MS", sans-serif;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 12px;
      color: var(--accent);
    }
    h1 {
      margin: 0;
      font-size: clamp(34px, 5vw, 60px);
      line-height: 0.95;
    }
    .hero p {
      margin: 0;
      max-width: 820px;
      font-size: 18px;
      line-height: 1.55;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 18px;
      margin-top: 20px;
    }
    .panel {
      border: 1px solid var(--line);
      background: var(--panel);
      box-shadow: var(--shadow);
      padding: 18px;
    }
    .panel h2 {
      margin: 0 0 10px;
      font-size: 23px;
      line-height: 1.1;
    }
    .panel p {
      margin: 0 0 14px;
      line-height: 1.5;
    }
    .controls {
      display: grid;
      gap: 10px;
      margin-bottom: 14px;
    }
    label {
      display: grid;
      gap: 6px;
      font-family: "Avenir Next Condensed", "Trebuchet MS", sans-serif;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    input {
      width: 100%;
      padding: 12px 13px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.92);
      font: inherit;
      color: inherit;
    }
    button {
      appearance: none;
      border: 0;
      padding: 12px 14px;
      background: var(--accent);
      color: white;
      cursor: pointer;
      font-family: "Avenir Next Condensed", "Trebuchet MS", sans-serif;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      font-size: 13px;
    }
    button.secondary {
      background: var(--warning);
    }
    pre {
      margin: 0;
      min-height: 220px;
      max-height: 540px;
      overflow: auto;
      padding: 14px;
      border: 1px solid var(--line);
      background: rgba(27,27,25,0.92);
      color: #f5f3ef;
      font-family: "SFMono-Regular", "Menlo", monospace;
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .status {
      margin-top: 10px;
      font-family: "Avenir Next Condensed", "Trebuchet MS", sans-serif;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--warning);
    }
    .action-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 12px 0 0;
    }
    .action-list button {
      padding: 10px 11px;
      font-size: 11px;
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div class="eyebrow">Local Operator Shell</div>
      <h1>Privacy Gateway</h1>
      <p>Lightweight local shell over the frozen read models. Use your operator token for <code>/v1/dashboard</code> and your intake token for the intake-specific workflow views.</p>
    </section>

    <section class="grid">
      <article class="panel">
        <h2>Operator Surface</h2>
        <p>Loads the tenant-scoped dashboard for aliases, channels, problems, and recent activity.</p>
        <div class="controls">
          <label>Operator Token
            <input id="operatorToken" placeholder="dev-token">
          </label>
          <button id="loadOperator">Load Operator Dashboard</button>
          <button class="secondary" id="loadOperatorTimeline">Load First Alias Timeline</button>
        </div>
        <pre id="operatorOutput">Waiting for operator fetch.</pre>
      </article>

      <article class="panel">
        <h2>Intake Surface</h2>
        <p>Loads the secure intake dashboard and queue view for store-and-forward triage.</p>
        <div class="controls">
          <label>Intake Token
            <input id="intakeToken" placeholder="intake-token">
          </label>
          <label>Submission ID
            <input id="intakeSubmissionId" placeholder="sub_xxx">
          </label>
          <label>Queue Metadata Profile
            <input id="intakeQueueMetadataProfile" placeholder="minimized_strict">
          </label>
          <label>Queue Limit
            <input id="intakeQueueLimit" placeholder="5">
          </label>
          <label>Retryable Only
            <input id="intakeQueueRetryableOnly" placeholder="true or false">
          </label>
          <button id="loadIntake">Load Intake Dashboard</button>
          <button class="secondary" id="loadIntakeQueue">Load Intake Queue</button>
          <button id="loadIntakeDetail">Open Intake Detail</button>
          <button class="secondary" id="loadIntakeTimeline">Open Intake Timeline</button>
        </div>
        <pre id="intakeOutput">Waiting for intake fetch.</pre>
        <div class="action-list" id="intakeActions"></div>
      </article>
      <article class="panel">
        <h2>Inbox</h2>
        <p>View inbound messages matched against aliases. Trigger IMAP sync to fetch new messages.</p>
        <div class="controls">
          <button id="loadInbox">Load Inbox</button>
          <button class="secondary" id="syncInbox">Sync IMAP</button>
        </div>
        <pre id="inboxOutput">Waiting for inbox fetch.</pre>
      </article>

      <article class="panel">
        <h2>Batch Workflow</h2>
        <p>Queue, release, and relay eligible submissions. Uses Intake Token above. Pipeline runs all three steps sequentially.</p>
        <div class="controls">
          <label>Batch Limit
            <input id="batchLimit" placeholder="10" value="10">
          </label>
        </div>
        <div class="action-list">
          <button id="batchQueue">Queue All Accepted</button>
          <button id="batchRelease">Release All Queued</button>
          <button class="secondary" id="batchRelay">Relay All Released</button>
          <button class="secondary" id="batchPipeline">Pipeline: Queue → Release → Relay</button>
        </div>
        <pre id="batchOutput">Waiting for batch operation.</pre>
      </article>
    </section>

    <div class="status" id="statusLine">Ready.</div>
  </main>

  <script>
    const storageKeys = {
      operatorToken: "privacyGateway.operatorToken",
      intakeToken: "privacyGateway.intakeToken",
      intakeQueueMetadataProfile: "privacyGateway.intakeQueueMetadataProfile",
      intakeQueueLimit: "privacyGateway.intakeQueueLimit",
      intakeQueueRetryableOnly: "privacyGateway.intakeQueueRetryableOnly"
    };
    const statusLine = document.getElementById("statusLine");
    let lastOperatorDashboard = null;
    let lastIntakeDashboard = null;
    let lastIntakeQueue = null;

    function persistInput(id, storageKey) {
      const element = document.getElementById(id);
      const saved = window.localStorage.getItem(storageKey);
      if (saved) {
        element.value = saved;
      }
      element.addEventListener("input", () => {
        window.localStorage.setItem(storageKey, element.value);
      });
    }

    function buildIntakeQueuePath() {
      const params = new URLSearchParams();
      const metadataProfile = document.getElementById("intakeQueueMetadataProfile").value.trim();
      const limit = document.getElementById("intakeQueueLimit").value.trim();
      const retryableOnly = document.getElementById("intakeQueueRetryableOnly").value.trim();
      if (metadataProfile) {
        params.set("metadata_profile", metadataProfile);
      }
      if (limit) {
        params.set("limit", limit);
      }
      if (retryableOnly) {
        params.set("retryable_only", retryableOnly);
      }
      const query = params.toString();
      return query ? "/v1/intake/queue?" + query : "/v1/intake/queue";
    }

    async function fetchJSON(path, token) {
      const response = await fetch(path, {
        headers: token ? { Authorization: "Bearer " + token } : {}
      });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch (_) {
        body = text;
      }
      return {
        status: response.status,
        ok: response.ok,
        body
      };
    }

    function renderIntakeActions(items) {
      const container = document.getElementById("intakeActions");
      container.innerHTML = "";
      const first = Array.isArray(items) ? items.find((item) => item && item.action_targets) : null;
      if (!first || !first.action_targets) {
        return;
      }
      if (first.id) {
        document.getElementById("intakeSubmissionId").value = first.id;
      }
      const token = document.getElementById("intakeToken").value.trim();
      const addAction = (label, path, method = "GET") => {
        if (!path) {
          return;
        }
        const button = document.createElement("button");
        button.textContent = label;
        button.addEventListener("click", async () => {
          statusLine.textContent = "Running " + label + "...";
          try {
            const result = await fetchJSONWithMethod(path, token, method);
            document.getElementById("intakeOutput").textContent = JSON.stringify(result, null, 2);
            statusLine.textContent = label + " finished with HTTP " + result.status + ".";
          } catch (error) {
            document.getElementById("intakeOutput").textContent = String(error);
            statusLine.textContent = label + " failed.";
          }
        });
        container.appendChild(button);
      };
      addAction("Open Detail", first.action_targets.view_detail, "GET");
      addAction("Open Timeline", first.action_targets.view_timeline, "GET");
      addAction("Queue First", first.action_targets.queue_for_relay, "POST");
      addAction("Release First", first.action_targets.release_to_relay, "POST");
      addAction("Relay First", first.action_targets.relay_now, "POST");
    }

    async function fetchJSONWithMethod(path, token, method) {
      const response = await fetch(path, {
        method,
        headers: token ? { Authorization: "Bearer " + token } : {}
      });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch (_) {
        body = text;
      }
      return {
        status: response.status,
        ok: response.ok,
        body
      };
    }

    async function load(path, token, outputId, label, onResult) {
      statusLine.textContent = "Loading " + label + "...";
      const output = document.getElementById(outputId);
      try {
        const result = await fetchJSON(path, token);
        output.textContent = JSON.stringify(result, null, 2);
        if (onResult) {
          onResult(result);
        }
        statusLine.textContent = label + " loaded with HTTP " + result.status + ".";
      } catch (error) {
        output.textContent = String(error);
        statusLine.textContent = label + " failed.";
      }
    }

    document.getElementById("loadOperator").addEventListener("click", () => {
      load("/v1/dashboard", document.getElementById("operatorToken").value.trim(), "operatorOutput", "operator dashboard", (result) => {
        lastOperatorDashboard = result.body;
      });
    });
    document.getElementById("loadIntake").addEventListener("click", () => {
      load("/v1/intake/dashboard", document.getElementById("intakeToken").value.trim(), "intakeOutput", "intake dashboard", (result) => {
        lastIntakeDashboard = result.body;
        renderIntakeActions(result.body && result.body.problem_submissions ? result.body.problem_submissions : result.body && result.body.recent_submissions);
      });
    });
    document.getElementById("loadIntakeQueue").addEventListener("click", () => {
      load(buildIntakeQueuePath(), document.getElementById("intakeToken").value.trim(), "intakeOutput", "intake queue", (result) => {
        lastIntakeQueue = result.body;
        renderIntakeActions(result.body && result.body.submissions);
      });
    });
    document.getElementById("loadIntakeDetail").addEventListener("click", () => {
      const token = document.getElementById("intakeToken").value.trim();
      const id = document.getElementById("intakeSubmissionId").value.trim();
      if (!id) {
        document.getElementById("intakeOutput").textContent = "Enter or discover a submission ID first.";
        statusLine.textContent = "Intake detail needs a submission ID.";
        return;
      }
      load("/v1/intake/submissions/" + id, token, "intakeOutput", "intake detail");
    });
    document.getElementById("loadIntakeTimeline").addEventListener("click", () => {
      const token = document.getElementById("intakeToken").value.trim();
      const id = document.getElementById("intakeSubmissionId").value.trim();
      if (!id) {
        document.getElementById("intakeOutput").textContent = "Enter or discover a submission ID first.";
        statusLine.textContent = "Intake timeline needs a submission ID.";
        return;
      }
      load("/v1/intake/submissions/" + id + "/timeline", token, "intakeOutput", "intake timeline");
    });
    document.getElementById("loadOperatorTimeline").addEventListener("click", () => {
      const token = document.getElementById("operatorToken").value.trim();
      const firstAlias = lastOperatorDashboard && Array.isArray(lastOperatorDashboard.channels) && lastOperatorDashboard.channels[0] && lastOperatorDashboard.channels[0].alias;
      if (!firstAlias || !firstAlias.id) {
        document.getElementById("operatorOutput").textContent = "Load operator dashboard first to discover an alias timeline.";
        statusLine.textContent = "Operator timeline needs a loaded dashboard first.";
        return;
      }
      load("/v1/aliases/" + firstAlias.id + "/timeline", token, "operatorOutput", "operator alias timeline");
    });

    // Inbox
    document.getElementById("loadInbox").addEventListener("click", () => {
      load("/v1/messages/inbox", document.getElementById("operatorToken").value.trim(), "inboxOutput", "inbox");
    });
    document.getElementById("syncInbox").addEventListener("click", async () => {
      const token = document.getElementById("operatorToken").value.trim();
      statusLine.textContent = "Syncing IMAP...";
      try {
        const result = await fetchJSONWithMethod("/v1/messages/inbox/sync", token, "POST");
        document.getElementById("inboxOutput").textContent = JSON.stringify(result, null, 2);
        statusLine.textContent = "IMAP sync finished with HTTP " + result.status + ".";
      } catch (error) {
        document.getElementById("inboxOutput").textContent = String(error);
        statusLine.textContent = "IMAP sync failed.";
      }
    });

    // Batch workflow
    function getBatchToken() {
      return document.getElementById("intakeToken").value.trim();
    }

    async function batchAction(statusFilter, actionPath, actionLabel) {
      const token = getBatchToken();
      const limit = parseInt(document.getElementById("batchLimit").value.trim()) || 10;
      const output = document.getElementById("batchOutput");

      if (actionPath === "relay_now" && !confirm("This will send real emails. Proceed with batch relay?")) {
        statusLine.textContent = "Batch relay cancelled.";
        return { processed: 0 };
      }

      statusLine.textContent = "Fetching queue for batch " + actionLabel + "...";
      try {
        const queueResult = await fetchJSON("/v1/intake/queue?limit=" + limit, token);
        if (!queueResult.ok || !queueResult.body || !queueResult.body.submissions) {
          output.textContent = "Queue fetch failed: " + JSON.stringify(queueResult, null, 2);
          statusLine.textContent = "Batch " + actionLabel + " aborted.";
          return { processed: 0 };
        }
        const eligible = queueResult.body.submissions.filter(function(s) {
          return s.status === statusFilter;
        });
        if (eligible.length === 0) {
          output.textContent = "No submissions with status '" + statusFilter + "' found.";
          statusLine.textContent = "Batch " + actionLabel + ": nothing to do.";
          return { processed: 0 };
        }
        const results = [];
        for (const sub of eligible) {
          const target = sub.action_targets && sub.action_targets[actionPath];
          if (!target) {
            results.push({id: sub.id, result: "no action target"});
            continue;
          }
          const r = await fetchJSONWithMethod(target, token, "POST");
          results.push({id: sub.id, status: r.status, ok: r.ok});
        }
        output.textContent = JSON.stringify({action: actionLabel, processed: results.length, results: results}, null, 2);
        statusLine.textContent = "Batch " + actionLabel + ": " + results.length + " processed.";
        return { processed: results.length };
      } catch (error) {
        output.textContent = String(error);
        statusLine.textContent = "Batch " + actionLabel + " failed.";
        return { processed: 0 };
      }
    }

    document.getElementById("batchQueue").addEventListener("click", () => batchAction("accepted", "queue_for_relay", "queue"));
    document.getElementById("batchRelease").addEventListener("click", () => batchAction("queued", "release_to_relay", "release"));
    document.getElementById("batchRelay").addEventListener("click", () => batchAction("sanitized", "relay_now", "relay"));
    document.getElementById("batchPipeline").addEventListener("click", async () => {
      if (!confirm("Pipeline will queue, release, and relay all eligible submissions. This sends real emails. Continue?")) {
        statusLine.textContent = "Pipeline cancelled.";
        return;
      }
      const output = document.getElementById("batchOutput");
      output.textContent = "Running pipeline: queue → release → relay...";

      const q = await batchAction("accepted", "queue_for_relay", "pipeline/queue");
      const r = await batchAction("queued", "release_to_relay", "pipeline/release");
      const s = await batchAction("sanitized", "relay_now", "pipeline/relay");

      output.textContent = JSON.stringify({
        pipeline: "complete",
        queued: q.processed,
        released: r.processed,
        relayed: s.processed
      }, null, 2);
      statusLine.textContent = "Pipeline complete: " + q.processed + " queued, " + r.processed + " released, " + s.processed + " relayed.";
    });

    persistInput("operatorToken", storageKeys.operatorToken);
    persistInput("intakeToken", storageKeys.intakeToken);
    persistInput("intakeQueueMetadataProfile", storageKeys.intakeQueueMetadataProfile);
    persistInput("intakeQueueLimit", storageKeys.intakeQueueLimit);
    persistInput("intakeQueueRetryableOnly", storageKeys.intakeQueueRetryableOnly);
    persistInput("batchLimit", "privacyGateway.batchLimit");
  </script>
</body>
</html>
`

func (s *Server) handleUI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, localUIShellHTML)
}
