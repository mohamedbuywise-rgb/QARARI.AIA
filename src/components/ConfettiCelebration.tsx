import { useEffect, useRef } from "react";

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  rotationSpeed: number;
  color: string;
  size: number;
  shape: "rect" | "circle" | "star";
  opacity: number;
}

const CONFETTI_COLORS = [
  "#D4AF37", "#f6dfa0", "#fbbf24", "#10b981",
  "#D4AF37", "#f6dfa0", "#fbbf24", "#D4AF37",
];

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, rot: number) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const angle = (i * 4 * Math.PI) / 5 - Math.PI / 2;
    const x = r * Math.cos(angle);
    const y = r * Math.sin(angle);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.restore();
}

export function ConfettiCelebration({ onDone }: { onDone?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    const pieces: Piece[] = Array.from({ length: 120 }, () => ({
      x: W * 0.3 + Math.random() * W * 0.4,
      y: -10,
      vx: (Math.random() - 0.5) * 8,
      vy: 2 + Math.random() * 5,
      rotation: Math.random() * Math.PI * 2,
      rotationSpeed: (Math.random() - 0.5) * 0.2,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      size: 5 + Math.random() * 8,
      shape: (["rect", "circle", "star"] as const)[Math.floor(Math.random() * 3)],
      opacity: 1,
    }));

    let rafId: number;
    let startTime: number | null = null;
    const DURATION = 3500;

    const draw = (ts: number) => {
      if (!startTime) startTime = ts;
      const elapsed = ts - startTime;
      ctx.clearRect(0, 0, W, H);

      let alive = 0;
      for (const p of pieces) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.12; // gravity
        p.vx *= 0.99;
        p.rotation += p.rotationSpeed;
        p.opacity = Math.max(0, 1 - (elapsed - 2000) / 1500);

        if (p.y < H + 20) alive++;

        ctx.save();
        ctx.globalAlpha = Math.max(0, p.opacity);
        ctx.fillStyle = p.color;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);

        if (p.shape === "rect") {
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        } else if (p.shape === "circle") {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          drawStar(ctx, 0, 0, p.size / 2, 0);
          ctx.fill();
        }
        ctx.restore();
      }

      if (elapsed < DURATION && alive > 0) {
        rafId = requestAnimationFrame(draw);
      } else {
        ctx.clearRect(0, 0, W, H);
        onDone?.();
      }
    };

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [onDone]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-50 h-full w-full"
      aria-hidden="true"
    />
  );
}
