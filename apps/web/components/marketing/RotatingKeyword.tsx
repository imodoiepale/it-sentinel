"use client";

import { useEffect, useState } from "react";

const WORDS = ["broken", "failing", "offline"];

export function RotatingKeyword() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % WORDS.length);
    }, 2400);
    return () => window.clearInterval(id);
  }, []);

  return (
    <span className="inline-block min-w-[7ch] transition-opacity duration-300">{WORDS[index]}</span>
  );
}
