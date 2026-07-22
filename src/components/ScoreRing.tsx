import { useEffect, useRef, useState } from "react";

interface ScoreRingProps {
  score: number; // 0-100
  size?: number;
  strokeWidth?: number;
  label?: string;
}

export function ScoreRing({ score, size = 90, strokeWidth = 7, label }: ScoreRingProps) {
  const [displayScore, setDisplayScore] = useState(0);
  const [animated, setAnimated] = useState(false);
  const ref = useRef<SVGCircleElement>(null);

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clampedScore = Math.max(0, Math.min(100, score));
  const offset = circumference - (clampedScore / 100) * circumference;

  const getColor = (s: number) => {
    if (s >= 70) return "#10b981"; // green
    if (s >= 45) return "#f59e0b"; // amber
    return "#ef4444"; // red
  };

  const getTrackColor = (s: number) => {
    if (s >= 70) return "rgba(16,185,129,0.15)";
    if (s >= 45) return "rgba(245,158,11,0.15)";
    return "rgba(239,68,68,0.15)";
  };

  const color = getColor(clampedScore);
  const trackColor = getTrackColor(clampedScore);

  // Animate score count-up
  useEffect(() => {
    const duration = 1400;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayScore(Math.round(eased * clampedScore));
      if (t < 1) requestAnimationFrame(step);
      else setAnimated(true);
    };
    const id = setTimeout(() => requestAnimationFrame(step), 200);
    return () => clearTimeout(id);
  }, [clampedScore]);

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="-rotate-90"
        >
          {/* Glow filter */}
          <defs>
            <filter id="ring-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Track */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={trackColor}
            strokeWidth={strokeWidth}
          />

          {/* Animated fill */}
          <circle
            ref={ref}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={animated ? offset : circumference}
            filter="url(#ring-glow)"
            style={{
              transition: "stroke-dashoffset 1.4s cubic-bezier(0.4, 0, 0.2, 1) 0.2s, stroke 0.3s ease",
            }}
          />
        </svg>

        {/* Center score */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className="text-xl font-bold leading-none"
            style={{ color, textShadow: `0 0 12px ${color}55` }}
          >
            {displayScore}
          </span>
          <span className="text-[9px] text-zinc-500 uppercase tracking-wider mt-0.5">/ 100</span>
        </div>
      </div>
      {label && (
        <span className="text-[11px] text-zinc-400 text-center leading-tight">{label}</span>
      )}
    </div>
  );
}
