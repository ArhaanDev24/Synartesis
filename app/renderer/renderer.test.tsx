import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown } from "./Markdown.js";
import { draftIsSaved, readDraft, saveDraft } from "./drafts.js";

const render = (text: string): string => renderToStaticMarkup(<Markdown text={text} />);
afterEach(() => { vi.unstubAllGlobals(); });

it("renders code as inert text, preserving whitespace and offering copy", () => {
  const html = render("```html\n<script>alert('bad')</script>\n  indented\n```");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("\n  indented");
  expect(html).toContain('aria-label="Copy code"');
});

it("keeps unfinished code fences readable as a reply streams", () => {
  expect(render("Before\n\n```ts\nconst value = 1;")).toContain("<code>const value = 1;</code>");
});

it("renders headings, nested lists, inline code, and emphasis", () => {
  const html = render("## Summary\n\n- **Changed** `report.txt`\n  - _North_ is zero\n- South is unchanged");
  expect(html).toContain("<h3>Summary</h3>");
  expect(html).toContain("<strong>Changed</strong>");
  expect(html).toContain("<code>report.txt</code>");
  expect(html.match(/<ul>/g)).toHaveLength(2);
  expect(html).toContain("<em>North</em>");
});

it("renders ordered lists and task states without creating interactive checkboxes", () => {
  const html = render("3. Inspect\n4. Restore\n\n- [x] Captured\n- [ ] Pending");
  expect(html).toContain('<ol start="3">');
  expect(html).toContain('aria-label="Completed"');
  expect(html).toContain('aria-label="Not completed"');
  expect(html).not.toContain("<input");
});

it("renders a table with semantic headers and a keyboard scroll target", () => {
  const html = render("| Region | Revenue |\n| --- | --- |\n| North | 0 |");
  expect(html).toContain('<th scope="col">Region</th>');
  expect(html).toContain("<td>0</td>");
  expect(html).toContain('tabindex="0"');
});

it("never loads images, renders raw HTML, or navigates model-supplied links", () => {
  const html = render('<img src="https://invalid.example/track">\n\n![Tracking](https://invalid.example/a) [Bad](javascript:alert) [Docs](https://invalid.example/docs)');
  expect(html).not.toContain("<img");
  expect(html).not.toContain("href=");
  expect(html).not.toMatch(/<[^>]+\ssrc=/);
  expect(html).toContain("[Image: Tracking]");
  expect(html).toContain("Copy link: https://invalid.example/docs");
});

it("restores a stored draft without looking at another conversation", () => {
  const getItem = vi.fn((key: string) => key.endsWith("stored-chat") ? "Saved words" : null);
  vi.stubGlobal("localStorage", { getItem });
  expect(readDraft("stored-chat")).toBe("Saved words");
  expect(readDraft("different-chat")).toBe("");
});

it("saves and clears only the selected conversation draft", () => {
  const setItem = vi.fn();
  const removeItem = vi.fn();
  vi.stubGlobal("localStorage", { setItem, removeItem });
  expect(saveDraft("chat-a", "A")).toBe(true);
  saveDraft("chat-b", "B");
  saveDraft("chat-a", "");
  expect(readDraft("chat-a")).toBe("");
  expect(readDraft("chat-b")).toBe("B");
  expect(removeItem).toHaveBeenCalledWith("synartesis.draft.v1.chat-a");
});

it("retains the current draft in memory when local persistence is unavailable", () => {
  vi.stubGlobal("localStorage", { setItem: () => { throw new Error("quota exceeded"); } });
  expect(saveDraft("unavailable-storage", "Do not lose this")).toBe(false);
  expect(readDraft("unavailable-storage")).toBe("Do not lose this");
  expect(draftIsSaved("unavailable-storage")).toBe(false);
  vi.stubGlobal("localStorage", { setItem: vi.fn() });
  expect(saveDraft("unavailable-storage", "Persisted again")).toBe(true);
  expect(draftIsSaved("unavailable-storage")).toBe(true);
});
