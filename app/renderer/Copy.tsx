import { useEffect, useRef, useState } from "react";

export function Copy({ text, label = "Copy", title = "Copy message" }: {
  text: string;
  label?: string;
  title?: string;
}): React.JSX.Element {
  const [state, setState] = useState<"ready" | "copied" | "failed">("ready");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { clearTimeout(timer.current); }, []);
  return (
    <button className="copy" title={title} aria-label={title} onClick={() => {
      navigator.clipboard.writeText(text).then(() => {
        setState("copied");
        clearTimeout(timer.current);
        timer.current = setTimeout(() => { setState("ready"); }, 2000);
      }, () => { setState("failed"); });
    }}>
      <span aria-live="polite">{state === "copied" ? "Copied ✓" : state === "failed" ? "Select text to copy" : label}</span>
    </button>
  );
}
