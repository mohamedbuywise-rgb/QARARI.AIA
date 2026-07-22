import { useEffect, useRef } from "react";

interface Particle {
  x: number;
  y: number;
  size: number;
  speedY: number;
  speedX: number;
  opacity: number;
  opacitySpeed: number;
  color: string;
}

const COLORS = [
  "rgba(212,175,55,",
  "rgba(246,223,160,",
  "rgba(251,191,36,",
  "rgba(180,140,20,",
];

export function FloatingParticles({ count = 35 }: { count?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    let W = window.innerWidth;
    let H = window.innerHeight;

    const resize = () => {
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W * DPR;
      canvas.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    };
    resize();

    const particles: Particle[] = Array.from({ length: count }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      size: 0.5 + Math.random() * 2,
      speedY: -(0.1 + Math.random() * 0.4),
      speedX: (Math.random() - 0.5) * 0.2,
      opacity: Math.random(),
      opacitySpeed: 0.003 + Math.random() * 0.007,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    }));

    let rafId: number;
    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      for (const p of particles) {
        p.y += p.speedY;
        p.x += p.speedX;
        p.opacity += p.opacitySpeed;
        if (p.opacity > 1 || p.opacity < 0) p.opacitySpeed *= -1;
        if (p.y < -10) { p.y = H + 10; p.x = Math.random() * W; }
        if (p.x < -10) p.x = W + 10;
        if (p.x > W + 10) p.x = -10;

        const alpha = Math.max(0, Math.min(1, p.opacity)) * 0.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `${p.color}${alpha})`;
        ctx.fill();
      }
      rafId = requestAnimationFrame(draw);
    };
    rafId = requestAnimationFrame(draw);

    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
    };
  }, [count]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-0 h-full w-full"
      aria-hidden="true"
    />
  );
}
