export function AmbientOrbs() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
      {/* Top-left gold orb */}
      <div
        className="orb-float absolute -top-32 -left-32 h-96 w-96 rounded-full opacity-[0.06]"
        style={{
          background: "radial-gradient(circle, #D4AF37 0%, transparent 70%)",
          animationDelay: "0s",
        }}
      />
      {/* Top-right subtle orb */}
      <div
        className="orb-float absolute -top-20 -right-20 h-72 w-72 rounded-full opacity-[0.04]"
        style={{
          background: "radial-gradient(circle, #f6dfa0 0%, transparent 70%)",
          animationDelay: "-3s",
        }}
      />
      {/* Bottom-center orb */}
      <div
        className="orb-float absolute -bottom-40 left-1/2 -translate-x-1/2 h-80 w-80 rounded-full opacity-[0.05]"
        style={{
          background: "radial-gradient(circle, #D4AF37 0%, transparent 70%)",
          animationDelay: "-5s",
        }}
      />
    </div>
  );
}
