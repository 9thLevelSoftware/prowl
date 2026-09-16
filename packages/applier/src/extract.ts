import type { Frame, Page } from "playwright";

export type QuestionType = "text" | "email" | "tel" | "url" | "number" | "date" | "textarea" | "select" | "combobox" | "radio" | "checkbox" | "checkbox_single" | "file";

export interface FormQuestion {
  /** Handle set on the DOM as data-jh-q so fill steps can target it. */
  handle: string;
  label: string;
  type: QuestionType;
  required: boolean;
  options: string[];
  /** Raw name/id hints, useful for recognizing standard fields. */
  name: string;
  id: string;
  currentValue: string;
  frameIndex: number;
}

/*
 * Runs inside the page. Kept as a plain JS string so bundlers cannot inject helpers
 * (esbuild's __name) that do not exist in the browser.
 * Groups radios/checkboxes by name, resolves labels through for=, aria-labelledby, wrapping
 * labels, fieldset legends, and a nearest-ancestor heuristic, and tags each control with data-jh-q.
 */
const EXTRACT_SCRIPT = String.raw`(() => {
  const clean = (s) => (s || "").replace(/\s+/g, " ").replace(/[✱*]+\s*$/, "").trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (el.type === "file") return st.display !== "none" || !!el.closest("label, [class*=upload], [class*=Upload], [class*=file], [class*=File]");
    return st.visibility !== "hidden" && st.display !== "none" && (r.width > 0 || r.height > 0);
  };
  const textOf = (el) => clean(el ? el.innerText || el.textContent : "");
  // Label wrappers often include helper/error text on later lines ("No location found..."); keep the first line.
  const firstLine = (el) => clean(((el && (el.innerText || el.textContent)) || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "");
  const controlSel = "input, select, textarea, [role=combobox]";
  const labelFor = (el, groupMembers) => {
    const members = groupMembers || [el];
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l && members.length === 1) return firstLine(l);
    }
    const lb = el.getAttribute("aria-labelledby");
    if (lb && members.length === 1) {
      const t = lb.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(" ");
      if (t) return clean(t);
    }
    const fs = el.closest("fieldset");
    if (fs && members.every((m) => fs.contains(m))) {
      const lg = fs.querySelector("legend");
      if (lg) return textOf(lg);
    }
    if (members.length === 1) {
      const wrap = el.closest("label");
      if (wrap) {
        const t = firstLine(wrap);
        if (t) return t;
      }
      const al = el.getAttribute("aria-label");
      if (al) return clean(al);
    }
    // Nearest ancestor containing all members and a label-like element that is not an option label.
    let node = el.parentElement;
    for (let i = 0; i < 7 && node; i++, node = node.parentElement) {
      if (!members.every((m) => node.contains(m))) continue;
      const cands = node.querySelectorAll("label, legend, .application-label, [class*=label], [class*=Label], [class*=question], [class*=title]");
      for (const c of cands) {
        if (members.some((m) => c.contains(m) || (m.id && c.getAttribute("for") === m.id && members.length > 1))) continue;
        if (c.querySelector(controlSel)) continue;
        if (c.closest("button")) continue;
        const t = firstLine(c);
        if (t && t.length < 400 && !/^(attach|upload|dropbox|google drive|enter manually|browse)$/i.test(t)) return t;
      }
    }
    return clean(el.getAttribute("placeholder") || el.name || el.id || "");
  };
  const optionLabel = (el) => {
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) return textOf(l);
    }
    const wrap = el.closest("label");
    if (wrap) return textOf(wrap);
    const sib = el.nextElementSibling;
    return textOf(sib) || el.value || "";
  };
  const isRequired = (els, label) =>
    els.some((e) => e.required || e.getAttribute("aria-required") === "true") || /[*✱]\s*$/.test((label || "").trim()) || /\(required\)/i.test(label || "");

  const out = [];
  const seenGroups = new Set();
  let n = document.querySelectorAll("[data-jh-q]").length;
  const all = Array.from(document.querySelectorAll(controlSel));
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "input" && ["hidden", "submit", "button", "reset", "image", "search"].includes(type)) continue;
    if (el.closest("[aria-hidden=true]") && type !== "file") continue;
    if (el.name === "g-recaptcha-response" || /captcha/i.test(el.name || el.id || "")) continue;
    if (!visible(el) && type !== "file") continue;
    // react-select renders a hidden sibling input with required=true; skip inputs owned by a combobox container.
    if (tag === "input" && el.getAttribute("role") !== "combobox" && !el.id && !el.name && el.closest("[class*=select__], [class*=Select]")) continue;

    if (type === "radio" || (type === "checkbox" && el.name && document.querySelectorAll('input[type=checkbox][name="' + CSS.escape(el.name) + '"]').length > 1)) {
      const key = type + ":" + el.name;
      if (seenGroups.has(key)) continue;
      seenGroups.add(key);
      const members = Array.from(document.querySelectorAll('input[type=' + type + '][name="' + CSS.escape(el.name) + '"]'));
      const handle = "q" + n++;
      members.forEach((m) => m.setAttribute("data-jh-q", handle));
      const label = labelFor(el, members);
      out.push({
        handle, label, type: type === "radio" ? "radio" : "checkbox", required: isRequired(members, label),
        options: members.map(optionLabel), name: el.name || "", id: el.id || "",
        currentValue: members.filter((m) => m.checked).map(optionLabel).join("; "), frameIndex: 0,
      });
      continue;
    }
    if (el.hasAttribute("data-jh-q")) {
      // Already tagged by a previous pass: re-read it.
      const handle = el.getAttribute("data-jh-q");
      if (out.some((q) => q.handle === handle)) continue;
    }
    const handle = el.getAttribute("data-jh-q") || "q" + n++;
    el.setAttribute("data-jh-q", handle);
    let qtype;
    if (el.getAttribute("role") === "combobox" && tag === "input") qtype = "combobox";
    else if (tag === "select") qtype = "select";
    else if (tag === "textarea") qtype = "textarea";
    else if (type === "checkbox") qtype = "checkbox_single";
    else if (type === "file") qtype = "file";
    else if (["email", "tel", "url", "number", "date"].includes(type)) qtype = type;
    else qtype = "text";
    const label = qtype === "checkbox_single" ? (labelFor(el) || optionLabel(el)) : labelFor(el);
    out.push({
      handle, label, type: qtype, required: isRequired([el], label),
      options: tag === "select" ? Array.from(el.options).map((o) => clean(o.textContent)).filter((t) => t && !/^(select|choose|please select|--)/i.test(t)) : [],
      name: el.name || "", id: el.id || "",
      currentValue: qtype === "checkbox_single" ? (el.checked ? "checked" : "") : (tag === "select" ? clean(el.options[el.selectedIndex]?.textContent) : (el.value || "")),
      frameIndex: 0,
    });
  }
  return out;
})()`;

/** Extract questions from the page and any same-origin or ATS iframes (Greenhouse embeds). */
export async function extractQuestions(page: Page): Promise<FormQuestion[]> {
  const frames = formFrames(page);
  const all: FormQuestion[] = [];
  for (let i = 0; i < frames.length; i++) {
    const qs = (await frames[i]!.evaluate(EXTRACT_SCRIPT).catch(() => [])) as FormQuestion[];
    for (const q of qs) all.push({ ...q, frameIndex: i });
  }
  return all.filter((q) => q.label || q.type === "file");
}

export function formFrames(page: Page): Frame[] {
  const main = page.mainFrame();
  const children = page.frames().filter((f) => f !== main && /greenhouse|lever|ashby|workday|apply|job/i.test(f.url()));
  return [main, ...children];
}

/**
 * Options that belong to one open combobox. Prefers aria-controls/aria-owns, then the nearest
 * container that holds both the input and a listbox. Excludes always-present widgets such as the
 * phone-country list (intl-tel-input) that would otherwise pollute a global [role=option] query.
 */
const SCOPED_OPTIONS_SCRIPT = String.raw`(handle) => {
  const input = document.querySelector('[data-jh-q="' + handle + '"]');
  if (!input) return [];
  const read = (root) => Array.from(root.querySelectorAll("[role=option]"))
    .filter((o) => !o.closest(".iti, .iti__dropdown-content, [class*=country-list]"))
    .map((o) => (o.innerText || o.textContent || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const ctl = input.getAttribute("aria-controls") || input.getAttribute("aria-owns");
  if (ctl) {
    const lb = document.getElementById(ctl);
    if (lb) return read(lb);
  }
  let node = input.parentElement;
  for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
    if (node.querySelector("[role=listbox], [role=option]")) {
      const opts = read(node);
      if (opts.length) return opts;
    }
  }
  return [];
}`;

export async function scopedOptions(page: Page, q: FormQuestion): Promise<string[]> {
  const frame = formFrames(page)[q.frameIndex] ?? page.mainFrame();
  const fn = `(${SCOPED_OPTIONS_SCRIPT})(${JSON.stringify(q.handle)})`;
  return ((await frame.evaluate(fn).catch(() => [])) as string[]).slice(0, 400);
}

/** Open a combobox and read its options without choosing one. */
export async function readComboboxOptions(page: Page, q: FormQuestion): Promise<string[]> {
  const frame = formFrames(page)[q.frameIndex] ?? page.mainFrame();
  const input = frame.locator(`[data-jh-q="${q.handle}"]`).first();
  try {
    await input.click({ timeout: 5000 });
    await page.waitForTimeout(500);
    const opts = await scopedOptions(page, q);
    await input.press("Escape").catch(() => undefined);
    return [...new Set(opts)];
  } catch {
    return [];
  }
}

export function questionKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/\(required\)|\(optional\)|[✱*]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
