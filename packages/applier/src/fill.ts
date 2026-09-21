import type { Page, Locator } from "playwright";
import { randomBetween, sleep } from "@prowl/shared";
import { formFrames, scopedOptions, type FormQuestion } from "./extract";
import { matchOption, type PlannedAnswer } from "./answers";

export interface FillResult {
  handle: string;
  ok: boolean;
  readBack: string;
  error?: string;
}

const human = () => sleep(randomBetween(120, 420));

function loc(page: Page, frameIndex: number, handle: string): Locator {
  const frame = formFrames(page)[frameIndex] ?? page.mainFrame();
  return frame.locator(`[data-jh-q="${handle}"]`);
}

async function typeInto(l: Locator, value: string): Promise<void> {
  await l.scrollIntoViewIfNeeded().catch(() => undefined);
  await l.click({ timeout: 5000 }).catch(() => undefined);
  await l.fill("");
  // Long text is filled at once; short values are typed so JS listeners (autocomplete, validation) fire.
  if (value.length > 80) await l.fill(value);
  else await l.pressSequentially(value, { delay: randomBetween(25, 70) });
}

async function chooseCombobox(page: Page, q: FormQuestion, l: Locator, value: string): Promise<void> {
  await l.scrollIntoViewIfNeeded().catch(() => undefined);
  await l.click({ timeout: 5000 });
  await sleep(300);
  let options = await scopedOptions(page, q);
  let target = options.length ? matchOption(options, value) : null;
  if (!target) {
    // Async/autocomplete comboboxes: type to search, then pick the best match (or the first result).
    await l.fill("");
    await l.pressSequentially(value.slice(0, 40), { delay: randomBetween(30, 80) });
    for (let i = 0; i < 10 && !options.length; i++) {
      await sleep(400);
      options = await scopedOptions(page, q);
    }
    target = matchOption(options, value) ?? options[0] ?? null;
  }
  if (!target) throw new Error(`No option matching "${value}"`);
  const frame = formFrames(page)[q.frameIndex] ?? page.mainFrame();
  const optionLoc = frame.getByRole("option", { name: target, exact: true }).first();
  if (await optionLoc.count()) await optionLoc.click({ timeout: 5000 });
  else {
    await l.press("ArrowDown");
    await l.press("Enter");
  }
}

async function readBack(page: Page, q: FormQuestion): Promise<string> {
  const frame = formFrames(page)[q.frameIndex] ?? page.mainFrame();
  const script = String.raw`(handle) => {
    const els = Array.from(document.querySelectorAll('[data-jh-q="' + handle + '"]'));
    if (!els.length) return "";
    const el = els[0];
    const labelOf = (e) => {
      if (e.id) { const l = document.querySelector('label[for="' + CSS.escape(e.id) + '"]'); if (l) return l.innerText.trim(); }
      const w = e.closest("label"); return w ? w.innerText.trim() : (e.value || "");
    };
    if (el.type === "radio" || el.type === "checkbox") {
      if (els.length === 1 && el.type === "checkbox") return el.checked ? "checked" : "";
      return els.filter((e) => e.checked).map(labelOf).join("; ");
    }
    if (el.type === "file") return el.files && el.files.length ? Array.from(el.files).map((f) => f.name).join(", ") : "";
    if (el.tagName === "SELECT") return (el.options[el.selectedIndex] || {}).textContent || "";
    if (el.getAttribute("role") === "combobox") {
      // react-select shows the chosen value in a sibling "single-value" element.
      let node = el.parentElement;
      for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
        const sv = node.querySelector("[class*=single-value], [class*=singleValue], [class*=multi-value__label]");
        if (sv) return sv.textContent.trim();
      }
      return el.value || "";
    }
    return el.value || "";
  }`;
  return ((await frame.evaluate(`(${script})(${JSON.stringify(q.handle)})`).catch(() => "")) as string).trim();
}

export async function fillAnswer(page: Page, q: FormQuestion, a: PlannedAnswer): Promise<FillResult> {
  const l = loc(page, q.frameIndex, q.handle);
  try {
    if (a.filePath) {
      await l.first().setInputFiles(a.filePath);
      await sleep(1200); // uploads often trigger async parsing/validation
    } else if (!a.value) {
      return { handle: q.handle, ok: true, readBack: await readBack(page, q) };
    } else {
      switch (q.type) {
        case "text":
        case "email":
        case "tel":
        case "url":
        case "number":
        case "date":
        case "textarea":
          await typeInto(l.first(), a.value);
          break;
        case "select": {
          const target = matchOption(q.options, a.value) ?? a.value;
          await l.first().selectOption({ label: target });
          break;
        }
        case "combobox":
          await chooseCombobox(page, q, l.first(), a.value);
          break;
        case "radio":
        case "checkbox": {
          const wanted = a.value.split(";").map((s) => s.trim()).filter(Boolean);
          const count = await l.count();
          for (let i = 0; i < count; i++) {
            const opt = l.nth(i);
            const label = q.options[i] ?? "";
            const should = wanted.some((w) => matchOption([label], w) === label);
            const checked = await opt.isChecked().catch(() => false);
            if (should !== checked && (should || q.type === "checkbox")) {
              await opt.scrollIntoViewIfNeeded().catch(() => undefined);
              // Custom-styled inputs are often visually hidden; force the click on the input itself.
              await opt.check({ force: true, timeout: 5000 }).catch(async () => opt.click({ force: true }));
              if (!should) await opt.uncheck({ force: true }).catch(() => undefined);
            }
          }
          break;
        }
        case "checkbox_single": {
          const want = /^(yes|true|checked|agree|i agree|accept|1)$/i.test(a.value) || a.value === "checked";
          if (want) await l.first().check({ force: true });
          else await l.first().uncheck({ force: true }).catch(() => undefined);
          break;
        }
        case "file":
          break;
      }
    }
    await human();
    const rb = await readBack(page, q);
    const ok = a.filePath ? rb.length > 0 : q.type === "checkbox_single" ? true : rb.length > 0;
    return { handle: q.handle, ok, readBack: rb, error: ok ? undefined : "Value did not stick" };
  } catch (err) {
    return { handle: q.handle, ok: false, readBack: await readBack(page, q), error: (err as Error).message.split("\n")[0] };
  }
}
