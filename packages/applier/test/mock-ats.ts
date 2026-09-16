import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Submission {
  form: string;
  fields: Record<string, string | string[]>;
}

const GREENHOUSE_LIKE = `<!doctype html><html><body>
<h1>Senior Backend Engineer</h1>
<form id="application-form">
  <div class="field"><label for="first_name">First Name*</label><input id="first_name" aria-required="true"></div>
  <div class="field"><label for="last_name">Last Name*</label><input id="last_name" aria-required="true"></div>
  <div class="field"><label for="email">Email*</label><input id="email" type="text" aria-required="true"></div>
  <div class="field"><label for="phone">Phone*</label><input id="phone" type="tel" aria-required="true"></div>
  <div class="field"><div class="label">Resume/CV*</div><button type="button">Attach</button><input id="resume" type="file" style="display:none"></div>
  <div class="field"><div class="label">Cover Letter</div><button type="button">Attach</button><input id="cover_letter" type="file" style="display:none"></div>
  <div class="field"><label for="question_1">LinkedIn Profile</label><input id="question_1"></div>
  <div class="field select">
    <label for="question_2" id="q2-label">Are you legally authorized to work in the United States?*</label>
    <div class="select__control"><input id="question_2" role="combobox" aria-required="true" aria-controls="q2-list" aria-labelledby="q2-label" autocomplete="off">
    <div class="select__single-value" id="q2-value"></div></div>
    <div id="q2-list" role="listbox" hidden><div role="option">Yes</div><div role="option">No</div></div>
  </div>
  <div class="field select">
    <label for="gender" id="g-label">Gender</label>
    <div class="select__control"><input id="gender" role="combobox" aria-controls="g-list" aria-labelledby="g-label" autocomplete="off">
    <div class="select__single-value" id="g-value"></div></div>
    <div id="g-list" role="listbox" hidden><div role="option">Male</div><div role="option">Female</div><div role="option">Decline To Self Identify</div></div>
  </div>
  <div class="iti"><ul role="listbox"><li role="option">United States +1</li><li role="option">Canada +1</li></ul></div>
  <button type="submit">Submit application</button>
</form>
<script>
  for (const [inputId, listId, valueId] of [["question_2","q2-list","q2-value"],["gender","g-list","g-value"]]) {
    const input = document.getElementById(inputId), list = document.getElementById(listId), value = document.getElementById(valueId);
    input.addEventListener("click", () => { list.hidden = false; });
    input.addEventListener("keydown", (e) => { if (e.key === "Escape") list.hidden = true; });
    list.querySelectorAll("[role=option]").forEach((o) => o.addEventListener("click", () => {
      value.textContent = o.textContent; input.dataset.value = o.textContent; input.value = ""; list.hidden = true;
    }));
  }
  document.getElementById("application-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = {};
    for (const el of document.querySelectorAll("input")) {
      if (!el.id) continue;
      f[el.id] = el.type === "file" ? Array.from(el.files).map((x) => x.name).join(",") : (el.dataset.value || el.value);
    }
    const missing = ["first_name","last_name","email","phone","resume","question_2"].filter((k) => !f[k]);
    if (missing.length) { document.body.insertAdjacentHTML("beforeend", '<div role="alert">' + missing.join(", ") + ' is required</div>'); return; }
    await fetch("/submit/greenhouse", { method: "POST", body: JSON.stringify(f) });
    location.href = "/confirmation";
  });
</script></body></html>`;

const LEVER_LIKE = `<!doctype html><html><body>
<form id="lever" method="post">
  <ul>
    <li class="application-question"><label><div class="application-label">Full name<span>✱</span></div><div class="application-field"><input type="text" name="name" required></div></label></li>
    <li class="application-question"><label><div class="application-label">Email<span>✱</span></div><div class="application-field"><input type="email" name="email" required></div></label></li>
    <li class="application-question"><label><div class="application-label">Resume/CV ✱</div><div>ATTACH RESUME/CV</div><input type="file" name="resume"></label></li>
    <li class="application-question"><label><div class="application-label">Current company</div><input type="text" name="org"></label></li>
    <li class="application-question custom-question">
      <div class="application-label"><div class="text">Will you now or in the future require sponsorship for employment visa status?<span class="required">✱</span></div></div>
      <div class="application-field"><ul>
        <li><label><input type="radio" name="cards[abc][field0]" value="Yes" required><span>Yes</span></label></li>
        <li><label><input type="radio" name="cards[abc][field0]" value="No" required><span>No</span></label></li>
      </ul></div>
    </li>
    <li class="application-question custom-question">
      <div class="application-label"><div class="text">Have you worked here before?<span class="required">✱</span></div></div>
      <div class="application-field"><ul>
        <li><label><input type="radio" name="cards[abc][field1]" value="Yes" required><span>Yes</span></label></li>
        <li><label><input type="radio" name="cards[abc][field1]" value="No" required><span>No</span></label></li>
      </ul></div>
    </li>
    <li class="application-question" id="followup" hidden><label><div class="application-label">If yes, which team?✱</div><input type="text" name="team"></label></li>
    <li class="application-question custom-question">
      <div class="application-label"><div class="text">Why do you want to work at Acme?<span class="required">✱</span></div></div>
      <div class="application-field"><textarea name="cards[abc][field2]" required></textarea></div>
    </li>
  </ul>
  <button type="submit" id="btn-submit">Submit application</button>
</form>
<script>
  document.querySelectorAll('input[name="cards[abc][field1]"]').forEach((r) => r.addEventListener("change", () => {
    const show = document.querySelector('input[name="cards[abc][field1]"]:checked')?.value === "Yes";
    const fu = document.getElementById("followup"); fu.hidden = !show; fu.querySelector("input").required = show;
  }));
  document.getElementById("lever").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target); const f = {};
    for (const [k, v] of fd.entries()) f[k] = typeof v === "string" ? v : v.name;
    await fetch("/submit/lever", { method: "POST", body: JSON.stringify(f) });
    location.href = "/thanks";
  });
</script></body></html>`;

export async function startMockAts(): Promise<{ url: string; submissions: Submission[]; close: () => Promise<void> }> {
  const submissions: Submission[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/submit/")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        submissions.push({ form: req.url!.split("/").pop()!, fields: JSON.parse(body) });
        res.writeHead(200).end("ok");
      });
      return;
    }
    const html =
      req.url?.startsWith("/greenhouse") ? GREENHOUSE_LIKE
      : req.url?.startsWith("/lever") ? LEVER_LIKE
      : req.url?.startsWith("/confirmation") ? "<h1>Thank you for applying!</h1><p>Your application has been received.</p>"
      : req.url?.startsWith("/thanks") ? "<h1>Application submitted</h1><p>Thanks for applying.</p>"
      : null;
    if (!html) return void res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": "text/html" }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, submissions, close: () => new Promise((r) => server.close(() => r())) };
}
