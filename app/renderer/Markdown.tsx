import { Fragment, type ReactNode } from "react";

import { Copy } from "./Copy.js";

/**
 * A deliberately inert Markdown view. Nodes are React text, never HTML; links
 * copy their address and images show their caption, so model output cannot
 * navigate this window or start a remote request. Unfinished fences still
 * render while a reply streams. Unsupported syntax stays readable as text.
 */
function inline(text: string, depth = 0): ReactNode {
  if (depth > 8) return text;
  const pattern = /(`+)([^`]+?)\1|!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*([^*\n]+)\*|_([^_\n]+)_/g;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(at, match.index));
    let node: ReactNode;
    if (match[2] !== undefined) node = <code>{match[2]}</code>;
    else if (match[3] !== undefined) node = <span className="image-caption">[Image: {match[3] || "image"}]</span>;
    else if (match[5] !== undefined && match[6] !== undefined) {
      const url = match[6];
      node = /^(https?:\/\/|mailto:)/i.test(url)
        ? <Copy text={url} label={match[5]} title={`Copy link: ${url}`} />
        : <span>{match[5]} ({url})</span>;
    } else if (match[7] !== undefined || match[8] !== undefined) {
      node = <strong>{inline(match[7] ?? match[8] ?? "", depth + 1)}</strong>;
    } else if (match[9] !== undefined) node = <del>{inline(match[9], depth + 1)}</del>;
    else node = <em>{inline(match[10] ?? match[11] ?? "", depth + 1)}</em>;
    parts.push(<Fragment key={match.index}>{node}</Fragment>);
    at = match.index + match[0].length;
  }
  parts.push(text.slice(at));
  return parts;
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

const listItem = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/;
const startsBlock = /^(?:\s*(?:`{3,}|~{3,})|#{1,6}\s|>\s?|\s*(?:[-+*]|\d+[.)])\s|\s*(?:---+|\*\*\*+|___+)\s*$)/;

function blocks(source: string, depth = 0): ReactNode[] {
  if (depth > 12) return [<p key="plain">{source}</p>];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] ?? "";
    const start = at;
    if (line.trim() === "") { at++; continue; }
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? "```";
      const language = (fence[2] ?? "").trim();
      const code: string[] = [];
      at++;
      while (at < lines.length) {
        const next = lines[at] ?? "";
        if (next.trim().startsWith(marker) && next.trim().replaceAll(marker[0] ?? "`", "") === "") { at++; break; }
        code.push(next);
        at++;
      }
      const text = code.join("\n");
      nodes.push(<div className="code-block" key={start}>
        <div className="code-head"><span>{language || "Code"}</span><Copy text={text} title="Copy code" /></div>
        <pre tabIndex={0} aria-label={`${language || "Plain text"} code`}><code>{text}</code></pre>
      </div>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      // The conversation title owns h1; Markdown headings stay beneath it.
      const content = inline(heading[2] ?? "");
      nodes.push((heading[1]?.length ?? 1) <= 2
        ? <h3 key={start}>{content}</h3> : <h4 key={start}>{content}</h4>);
      at++; continue;
    }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      nodes.push(<hr key={start} />); at++; continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (at < lines.length && lines[at]?.startsWith(">")) {
        quote.push((lines[at] ?? "").replace(/^>\s?/, "")); at++;
      }
      nodes.push(<blockquote key={start}>{blocks(quote.join("\n"), depth + 1)}</blockquote>);
      continue;
    }
    const separator = lines[at + 1];
    if (line.includes("|") && separator !== undefined && cells(separator).every((cell) => /^:?-{3,}:?$/.test(cell))) {
      const headers = cells(line);
      const rows: string[][] = [];
      at += 2;
      while (at < lines.length && lines[at]?.includes("|")) { rows.push(cells(lines[at] ?? "")); at++; }
      nodes.push(<div className="table-wrap" key={start} tabIndex={0} role="region" aria-label="Message table">
        <table><thead><tr>{headers.map((cell, index) => <th scope="col" key={index}>{inline(cell)}</th>)}</tr></thead>
          <tbody>{rows.map((row, index) => <tr key={index}>{headers.map((_, column) => <td key={column}>{inline(row[column] ?? "")}</td>)}</tr>)}</tbody>
        </table>
      </div>);
      continue;
    }
    const item = listItem.exec(line);
    if (item !== null) {
      const indent = item[1]?.length ?? 0;
      const ordered = /^\d/.test(item[2] ?? "");
      const items: ReactNode[] = [];
      while (at < lines.length) {
        const entry = listItem.exec(lines[at] ?? "");
        if (entry === null || (entry[1]?.length ?? 0) !== indent || /^\d/.test(entry[2] ?? "") !== ordered) break;
        const body = [entry[3] ?? ""];
        const key = at++;
        while (at < lines.length) {
          const continuation = lines[at] ?? "";
          if (continuation.trim() === "" || (continuation.match(/^\s*/)?.[0].length ?? 0) <= indent) break;
          body.push(continuation.slice(indent + 2)); at++;
        }
        const task = /^\[([ xX])\]\s+/.exec(body[0] ?? "");
        if (task !== null) body[0] = (body[0] ?? "").slice(task[0].length);
        items.push(<li key={key}>{task === null ? null : <span role="img" aria-label={task[1] === " " ? "Not completed" : "Completed"}>{task[1] === " " ? "☐ " : "☑ "}</span>}{blocks(body.join("\n"), depth + 1)}</li>);
      }
      nodes.push(ordered ? <ol start={Number.parseInt(item[2] ?? "1", 10)} key={start}>{items}</ol> : <ul key={start}>{items}</ul>);
      continue;
    }
    const paragraph = [line];
    at++;
    while (at < lines.length && lines[at]?.trim() !== "" && !startsBlock.test(lines[at] ?? "")) {
      if (lines[at]?.includes("|") && cells(lines[at + 1] ?? "").every((cell) => /^:?-{3,}:?$/.test(cell))) break;
      paragraph.push(lines[at] ?? ""); at++;
    }
    nodes.push(<p key={start}>{paragraph.map((part, index) => <Fragment key={index}>{index > 0 ? <br /> : null}{inline(part)}</Fragment>)}</p>);
  }
  return nodes;
}

export function Markdown({ text }: { text: string }): React.JSX.Element {
  return <div className="markdown">{blocks(text)}</div>;
}
