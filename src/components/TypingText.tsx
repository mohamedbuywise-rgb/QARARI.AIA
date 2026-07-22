import { useEffect, useState } from "react";

interface TypingTextProps {
  texts: string[];
  className?: string;
  speed?: number;
  pauseMs?: number;
}

export function TypingText({ texts, className = "", speed = 60, pauseMs = 2000 }: TypingTextProps) {
  const [displayed, setDisplayed] = useState("");
  const [textIdx, setTextIdx] = useState(0);
  const [charIdx, setCharIdx] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) {
      const t = setTimeout(() => { setPaused(false); setDeleting(true); }, pauseMs);
      return () => clearTimeout(t);
    }

    const currentText = texts[textIdx];

    if (!deleting) {
      if (charIdx < currentText.length) {
        const t = setTimeout(() => {
          setDisplayed(currentText.slice(0, charIdx + 1));
          setCharIdx((c) => c + 1);
        }, speed);
        return () => clearTimeout(t);
      } else {
        setPaused(true);
      }
    } else {
      if (charIdx > 0) {
        const t = setTimeout(() => {
          setDisplayed(currentText.slice(0, charIdx - 1));
          setCharIdx((c) => c - 1);
        }, speed / 2);
        return () => clearTimeout(t);
      } else {
        setDeleting(false);
        setTextIdx((i) => (i + 1) % texts.length);
      }
    }
  }, [charIdx, deleting, paused, textIdx, texts, speed, pauseMs]);

  return (
    <span className={`typing-cursor ${className}`}>
      {displayed}
    </span>
  );
}
