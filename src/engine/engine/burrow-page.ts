const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Burrow</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f4f1ea; color: #1c1915; font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 42rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
  h1 { font-size: 1.85rem; font-weight: 650; letter-spacing: -0.03em; margin: 0 0 0.35rem; }
  h2 { font-size: 1.15rem; margin: 0 0 0.4rem; }
  p { margin: 0.4rem 0; }
  .eyebrow { color: #6b645c; font-size: 0.82rem; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 0.6rem; }
  .muted { color: #6b645c; }
  .card { background: #fff; border: 1px solid #e6e1d8; border-radius: 16px; padding: 1.1rem 1.2rem; margin: 1rem 0; }
  label { display: block; font-size: 0.92rem; margin: 0.85rem 0; }
  input { width: 100%; box-sizing: border-box; margin-top: 0.3rem; padding: 0.7rem 0.75rem; border-radius: 10px; border: 1px solid #d9d3c8; font: inherit; background: #fff; }
  button, .link { appearance: none; border: 0; background: #1c1915; color: #fff; border-radius: 999px; padding: 0.72rem 1.1rem; font: inherit; cursor: pointer; }
  button.ghost { background: transparent; color: #1c1915; border: 1px solid #e6e1d8; }
  .row { display: flex; justify-content: space-between; gap: 1rem; padding: 0.45rem 0; border-bottom: 1px solid #f0ece4; }
  .ok { color: #1f7a4d; }
  .warn { color: #9a6700; }
  .alert { background: #fff6e8; border-radius: 12px; padding: 0.75rem 0.9rem; margin: 0.8rem 0; }
  nav { display: flex; gap: 0.4rem; flex-wrap: wrap; margin: 1rem 0 0.4rem; }
  nav button { background: transparent; color: #1c1915; border: 1px solid #e6e1d8; padding: 0.4rem 0.75rem; }
  nav button[aria-current="true"] { background: #1c1915; color: #fff; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.86rem; word-break: break-all; }
  .actions { display: flex; gap: 0.6rem; align-items: center; margin-top: 1rem; }
  .matrix { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.6rem; margin-top: 1rem; }
  .cell { padding: 0.8rem; border-radius: 12px; border: 1px solid; }
  .cell.allow { background: #e5f6e9; border-color: #69b581; color: #16572d; }
  .cell.deny { background: #f9e9e5; border-color: #d99987; color: #81392b; }
  .scenario-buttons { display: flex; gap: 0.4rem; flex-wrap: wrap; margin: 0.8rem 0; }
  .scenario-buttons button { background: #fff; color: #1c1915; border: 1px solid #d9d3c8; padding: 0.4rem 0.7rem; }
  .scenario-buttons button[aria-pressed="true"] { background: #1c1915; color: #fff; }
</style>
</head>
<body>
<main>
  <p class="eyebrow">Armadillo / Burrow</p>
  <div id="app">
    <h1>Welcome to Armadillo</h1>
    <p class="muted">Checking this deployment…</p>
  </div>
</main>
<script>
(function () {
  var app = document.getElementById("app");
  var notice = "";
  var status = null;
  var section = "overview";

  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (key === "class") node.className = value;
      else if (key.slice(0, 2) === "on" && typeof value === "function") node.addEventListener(key.slice(2), value);
      else if (value != null && value !== false) node.setAttribute(key, String(value));
    });
    (children || []).forEach(function (child) {
      if (child == null || child === false) return;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  function api(path, options) {
    var headers = { "x-armadillo-auth-mode": "cookie" };
    if (options && options.body) headers["content-type"] = "application/json";
    if (options && options.headers) { for (var k in options.headers) headers[k] = options.headers[k]; }
    return fetch(path, {
      method: (options && options.method) || "GET",
      credentials: "same-origin",
      headers: headers,
      body: options && options.body ? JSON.stringify(options.body) : undefined
    }).then(function (response) {
      return response.text().then(function (text) {
        var payload = null;
        if (text) { try { payload = JSON.parse(text); } catch (error) { payload = null; } }
        if (!response.ok) {
          var message = payload && payload.error && payload.error.message ? payload.error.message : "Request failed";
          throw new Error(message);
        }
        return payload;
      });
    });
  }

  function alertBox() {
    return notice ? h("p", { class: "alert", role: "alert" }, [notice]) : null;
  }

  function mark(ok) {
    return h("span", { class: ok ? "ok" : "warn" }, [ok ? "✓" : "!"]);
  }

  function checks(infra) {
    var rows = [
      ["Deployment", true],
      ["Database", Boolean(infra && infra.database)],
      ["Files", Boolean(infra && infra.files)],
      ["Schema", Boolean(infra && infra.schema === "current")]
    ];
    return h("div", { class: "card" }, rows.map(function (row) {
      return h("div", { class: "row" }, [h("span", {}, [row[0]]), mark(row[1])]);
    }));
  }

  function welcome(ready) {
    app.replaceChildren(
      h("h1", {}, ["Welcome to Armadillo"]),
      h("p", { class: "muted" }, ["This deployment is the backend. Burrow is where ownership and credentials live."]),
      alertBox(),
      checks(status && status.infrastructure),
      ready ? null : h("p", { class: "muted" }, ["Open the setup link from deploy. The one-time secret stays in the address fragment and is exchanged once."]),
      h("div", { class: "actions" }, [h("button", { type: "button", onclick: function () {
        if (ready) ownerForm();
        else { notice = "Open the setup link from deploy. It ends in # and a one-time secret."; welcome(false); }
      } }, ["Verify bootstrap access"])])
    );
  }

  function ownerForm() {
    var name = h("input", { name: "name", autocomplete: "name", required: "true" });
    var email = h("input", { name: "email", type: "email", autocomplete: "email", required: "true" });
    var password = h("input", { name: "password", type: "password", autocomplete: "new-password", required: "true", minlength: "10" });
    var form = h("form", { class: "card", onsubmit: function (event) {
      event.preventDefault();
      notice = "";
      api("/v1/burrow/owner", { method: "POST", body: { name: name.value, email: email.value, password: password.value } })
        .then(load)
        .catch(function (error) { notice = error.message; ownerForm(); });
    } }, [
      h("h2", {}, ["Who owns this application?"]),
      h("label", {}, ["Name", name]),
      h("label", {}, ["Email", email]),
      h("label", {}, ["Password", password]),
      h("p", { class: "muted" }, ["You'll use this email and password to open Burrow. Google or GitHub can be added next."]),
      h("div", { class: "actions" }, [h("button", { type: "submit" }, ["Create owner"])])
    ]);
    app.replaceChildren(h("h1", {}, ["Welcome to Armadillo"]), alertBox(), form);
  }

  function fieldInput(field) {
    return h("input", {
      name: field.key,
      type: field.type === "secret" ? "password" : "text",
      autocomplete: "off",
      placeholder: field.configured ? "Configured" : ""
    });
  }

  function requirements(firstRun) {
    var inputs = [];
    var blocks = (status.requirements || []).map(function (requirement) {
      var nodes = [h("h2", {}, [requirement.title])];
      if (requirement.callbackUrl) {
        nodes.push(h("p", { class: "muted" }, ["Callback URL"]));
        nodes.push(h("p", {}, [h("code", {}, [requirement.callbackUrl])]));
      }
      requirement.fields.forEach(function (field) {
        var input = fieldInput(field);
        inputs.push({ key: field.key, input: input, configured: field.configured });
        nodes.push(h("label", {}, [field.label + (field.configured ? " · configured" : ""), input]));
      });
      return h("section", { class: "card" }, nodes);
    });
    var form = h("form", { onsubmit: function (event) {
      event.preventDefault();
      var values = {};
      inputs.forEach(function (item) {
        if (item.input.value.trim()) values[item.key] = item.input.value.trim();
      });
      if (!Object.keys(values).length) {
        notice = "Paste the missing credentials.";
        requirements(firstRun);
        return;
      }
      notice = "";
      api("/v1/burrow/secrets", { method: "POST", body: { values: values, verify: true } })
        .then(function () { return load(); })
        .catch(function (error) { notice = error.message; requirements(firstRun); });
    } }, blocks.concat([
      h("div", { class: "actions" }, [
        h("button", { type: "submit" }, ["Save & verify"]),
        firstRun ? null : h("button", { type: "button", class: "ghost", onclick: function () { section = "overview"; dashboard(); } }, ["Back"])
      ])
    ]));
    app.replaceChildren(
      h("h1", {}, [firstRun ? "What this application still needs" : "Secrets & integrations"]),
      h("p", { class: "muted" }, ["backend.ts declares these. Burrow only stores the values."]),
      alertBox(),
      form
    );
  }

  function ready() {
    var lines = [
      ["Owner created", true],
      ["Schema current", status.infrastructure && status.infrastructure.schema === "current"],
      ["Database healthy", status.infrastructure && status.infrastructure.database]
    ];
    (status.requirements || []).forEach(function (requirement) {
      var ok = requirement.fields.every(function (field) { return !field.required || field.configured; });
      lines.push([requirement.title + " configured", ok]);
    });
    app.replaceChildren(
      h("h1", {}, ["You're ready."]),
      alertBox(),
      h("div", { class: "card" }, lines.map(function (line) {
        return h("div", { class: "row" }, [h("span", {}, [line[0]]), mark(line[1])]);
      })),
      h("div", { class: "actions" }, [h("button", { type: "button", onclick: function () {
        sessionStorage.setItem("armadillo-burrow-entered", "1");
        section = "overview";
        dashboard();
      } }, ["Open Burrow"])])
    );
  }

  function signIn() {
    var email = h("input", { type: "email", autocomplete: "username" });
    var password = h("input", { type: "password", autocomplete: "current-password" });
    app.replaceChildren(
      h("h1", {}, ["Burrow"]),
      h("p", { class: "muted" }, ["Sign in as the application owner."]),
      alertBox(),
      h("form", { class: "card", onsubmit: function (event) {
        event.preventDefault();
        notice = "";
        api("/v1/auth/login", { method: "POST", body: { email: email.value, password: password.value } })
          .then(load)
          .catch(function (error) { notice = error.message; signIn(); });
      } }, [
        h("label", {}, ["Email", email]),
        h("label", {}, ["Password", password]),
        h("div", { class: "actions" }, [h("button", { type: "submit" }, ["Sign in"])])
      ])
    );
  }

  function size(bytes) {
    if (bytes == null) return "Unknown";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
    return (bytes / 1073741824).toFixed(2) + " GB";
  }

  function dashboard() {
    var names = ["Overview", "Users & Groups", "Agents", "Authentication", "Secrets & Integrations", "Database", "Permissions", "Files", "Deployments & Migrations", "Audit"];
    var keys = ["overview", "people", "agents", "authentication", "secrets", "database", "permissions", "files", "deployments", "audit"];
    var nav = h("nav", {}, names.map(function (name, index) {
      return h("button", {
        type: "button",
        "aria-current": keys[index] === section ? "true" : null,
        onclick: function () {
          section = keys[index];
          if (section === "secrets") requirements(false);
          else dashboard();
        }
      }, [name]);
    }));
    var body = panel();
    app.replaceChildren(
      h("h1", {}, ["Burrow"]),
      h("p", { class: "muted" }, [status.operator ? status.operator.title + (status.operator.name ? " · " + status.operator.name : "") : ""]),
      alertBox(),
      nav,
      body,
      h("div", { class: "actions" }, [h("button", { type: "button", class: "ghost", onclick: function () {
        api("/v1/auth/logout", { method: "POST", body: {} }).then(function () {
          sessionStorage.removeItem("armadillo-burrow-entered");
          return load();
        }).catch(function (error) { notice = error.message; dashboard(); });
      } }, ["Sign out"])])
    );
  }

  function panel() {
    if (section === "people") {
      var people = (status.users || []).map(function (user) {
        return h("div", { class: "row" }, [h("span", {}, [user.name || user.email]), h("span", { class: "muted" }, [user.email])]);
      });
      var groups = (status.groups || []).map(function (group) {
        return h("div", { class: "row" }, [h("span", {}, [group.name]), h("span", { class: "muted" }, [String(group.members) + " members"])]);
      });
      return h("div", {}, [h("section", { class: "card" }, [h("h2", {}, ["Users"])].concat(people.length ? people : [h("p", { class: "muted" }, ["No users."])])), h("section", { class: "card" }, [h("h2", {}, ["Groups"])].concat(groups))]);
    }
    if (section === "agents") {
      var agents = (status.agents || []).map(function (agent) {
        return h("div", { class: "row" }, [h("span", {}, [agent.name]), h("span", { class: "muted" }, [agent.revokedAt ? "revoked" : agent.prefix])]);
      });
      return h("section", { class: "card" }, [
        h("h2", {}, ["Agents"]),
        h("p", {}, ["API keys act as their owner. They are not a separate account."])
      ].concat(agents.length ? agents : [h("p", { class: "muted" }, ["No API keys."])]));
    }
    if (section === "authentication") {
      var authItems = (status.requirements || []).filter(function (item) { return item.kind === "authentication"; });
      return h("div", {}, authItems.map(function (item) {
        return h("section", { class: "card" }, [
          h("h2", {}, [item.title]),
          item.callbackUrl ? h("p", {}, [h("code", {}, [item.callbackUrl])]) : null
        ].concat(item.fields.map(function (field) {
          return h("div", { class: "row" }, [h("span", {}, [field.label]), mark(field.configured)]);
        })));
      }));
    }
    if (section === "database") {
      var host = h("div", {});
      var rows = (status.database && status.database.collections || []).map(function (collection) {
        return h("div", { class: "row" }, [
          h("span", {}, [collection.name]),
          h("span", {}, [
            String(collection.records) + (collection.records === 1 ? " record" : " records"),
            " ",
            h("button", { type: "button", class: "ghost", onclick: function () { showRecords(collection.name, host); } }, ["View records"])
          ])
        ]);
      });
      return h("section", { class: "card" }, [h("h2", {}, ["Database"]), h("p", { class: "muted" }, [size(status.database && status.database.bytes)])].concat(rows).concat([host]));
    }
    if (section === "permissions") {
      var policies = status.policies || [];
      if (!policies.length) return h("section", { class: "card" }, [h("h2", {}, ["Permissions"]), h("p", { class: "muted" }, ["Declare a table in schema.ts to preview its access rules."])]);
      var picker = h("select", { "aria-label": "Table" }, policies.map(function (policy) { return h("option", { value: policy.name }, [policy.name]); }));
      var host = h("div", {});
      function draw() {
        var policy = policies.find(function (item) { return item.name === picker.value; }) || policies[0];
        var current = 0;
        var result = h("div", {});
        var buttons = h("div", { class: "scenario-buttons" }, policy.scenarios.map(function (scenario, index) {
          return h("button", { type: "button", "aria-pressed": index === 0 ? "true" : "false", onclick: function () {
            current = index;
            Array.from(buttons.children).forEach(function (button, buttonIndex) { button.setAttribute("aria-pressed", String(buttonIndex === index)); });
            show();
          } }, [scenario.label]);
        }));
        function show() {
          var scenario = policy.scenarios[current];
          result.replaceChildren(h("div", { class: "matrix" }, [
            ["Read", scenario.read], ["Edit", scenario.edit], ["Create", scenario.create]
          ].map(function (entry) { return h("div", { class: "cell " + (entry[1] ? "allow" : "deny") }, [h("strong", {}, [entry[0]]), h("div", {}, [entry[1] ? "Allowed" : "Denied"])]); })));
        }
        show();
        host.replaceChildren(
          h("p", {}, ["View: " + policy.view]),
          h("p", {}, ["Edit: " + policy.edit]),
          h("p", { class: "muted" }, [policy.teamField ? "Team field: " + policy.teamField : "No team field"]),
          buttons, result
        );
      }
      picker.addEventListener("change", draw);
      draw();
      return h("section", { class: "card" }, [
        h("h2", {}, ["Permissions"]),
        h("p", { class: "muted" }, ["Explore the rules declared in schema.ts. These scenarios preview policy decisions; the local permission lab runs actual requests."]),
        h("label", {}, ["Table", picker]), host,
      ]);
    }
    if (section === "files") {
      var files = status.files || { count: 0, bytes: 0 };
      return h("section", { class: "card" }, [
        h("h2", {}, ["Files"]),
        h("p", {}, [String(files.count) + " files"]),
        h("p", { class: "muted" }, [size(files.bytes)])
      ]);
    }
    if (section === "deployments") {
      var deployment = status.deployment || {};
      var history = (deployment.migrations || []).map(function (item) {
        return h("div", { class: "row" }, [h("span", {}, [item.name]), h("span", { class: "muted" }, [item.appliedAt || ""])]);
      });
      return h("section", { class: "card" }, [
        h("h2", {}, ["Deployments & migrations"]),
        h("p", {}, ["Stage " + (deployment.stage || "unknown")]),
        h("p", { class: "muted" }, ["Schema " + (deployment.schemaVersion || "")])
      ].concat(history));
    }
    if (section === "audit") {
      var events = (status.audit || []).map(function (event) {
        return h("div", { class: "row" }, [h("span", {}, [event.action + " · " + event.subject]), h("span", { class: "muted" }, [event.createdAt])]);
      });
      return h("section", { class: "card" }, [h("h2", {}, ["Audit"])].concat(events.length ? events : [h("p", { class: "muted" }, ["No audit events yet."])]));
    }
    var issues = status.issues || [];
    return h("div", {}, [
      h("section", { class: "card" }, [
        h("h2", {}, ["Application health"]),
        h("p", {}, [issues.length ? String(issues.length) + (issues.length === 1 ? " issue" : " issues") : "Healthy"])
      ].concat(issues.map(function (issue) {
        return h("p", { class: issue.level === "error" ? "warn" : "warn" }, [issue.message]);
      }))),
      checks(status.infrastructure),
      h("p", { class: "muted" }, ["Backups are not managed in Burrow."])
    ]);
  }

  function showRecords(name, host) {
    host.replaceChildren(h("p", { class: "muted" }, ["Loading records…"]));
    api("/v1/burrow/records?collection=" + encodeURIComponent(name)).then(function (payload) {
      if (!payload.records.length) {
        host.replaceChildren(h("p", { class: "muted" }, ["No records."]));
        return;
      }
      host.replaceChildren.apply(host, payload.records.map(function (row) {
        return h("div", { class: "row" }, [h("code", {}, [row.id]), h("span", { class: "muted" }, [row.createdAt])]);
      }));
    }).catch(function (error) {
      host.replaceChildren(h("p", { class: "warn" }, [error.message]));
    });
  }

  function paint() {
    if (!status) {
      app.replaceChildren(h("h1", {}, ["Welcome to Armadillo"]), alertBox());
      return;
    }
    if (status.phase === "uninitialized") return welcome(false);
    if (status.phase === "bootstrapping") return welcome(true);
    if (!status.operator) return signIn();
    var missing = (status.requirements || []).some(function (item) {
      return item.fields.some(function (field) { return field.required && !field.configured; });
    });
    if (sessionStorage.getItem("armadillo-burrow-entered") !== "1") {
      if (missing) return requirements(true);
      return ready();
    }
    if (section === "secrets") return requirements(false);
    dashboard();
  }

  var requestedSection = new URLSearchParams(location.search).get("section");
  if (["overview", "people", "agents", "authentication", "secrets", "database", "permissions", "files", "deployments", "audit"].includes(requestedSection)) section = requestedSection;

  function load() {
    return api("/v1/burrow").then(function (payload) {
      status = payload;
      paint();
    });
  }

  // A malformed fragment (e.g. /burrow#%) must not throw before load(): treat a
  // failed decode as an empty fragment so the page still renders.
  var fragment = "";
  try {
    fragment = location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : "";
  } catch (error) {
    fragment = "";
  }
  if (fragment) history.replaceState(null, "", location.pathname);
  var exchanged = fragment
    ? api("/v1/burrow/session", { method: "POST", headers: { "x-armadillo-bootstrap-secret": fragment } }).catch(function (error) { notice = error.message; })
    : Promise.resolve();
  exchanged.then(load).catch(function (error) { notice = error.message; paint(); });
})();
</script>
</body>
</html>
`;

// SECURITY: the inline <script> in PAGE is allow-listed in the CSP by sha256
// hash. If the script bytes change, recompute the hash and update script-src
// (tests/local/ui-csp-hashes.test.mjs fails loudly on drift).
export function burrowPage(method: string): Response {
  return new Response(method === "HEAD" ? null : PAGE, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; script-src 'sha256-th/DCkE79kJ9JwqQLXY8mmqlIWiVpaHyxjgg0l1kk5g='; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}
