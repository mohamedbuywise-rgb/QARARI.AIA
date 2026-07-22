import { useState, useRef, useEffect, useCallback } from "react";
import { useApp } from "@/lib/AppContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MessageCircle, Send, Mic, ChevronLeft, Bot, Brain, X, Lock, Zap, ShieldCheck, TrendingUp, RefreshCw
} from "lucide-react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function AdvisorScreen() {
  const { t, lang, dir, navigate, session, isPremium, showToast, requireAuth, user } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const starterQuestions = lang === "ar" ? [
    "معايا 30 ألف وعايز لابتوب للدراسة، إيه أفضل خيار؟",
    "إيه أحسن موبايل كاميرا في 25 ألف؟",
    "فرق إيه بين iPhone 15 و iPhone 14؟ يستاهل؟",
    "عايز سماعات بلوتوث تحت 2000 جنيه، أيها أحسن؟",
  ] : [
    "I have 30K EGP and need a laptop for studying, what's best?",
    "What's the best camera phone under 25K EGP?",
    "iPhone 15 vs 14? Is the upgrade worth it?",
    "I need Bluetooth earphones under 2000 EGP?",
  ];

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleSend = () => {
    if (!input.trim() || loading) return;
    requireAuth(async () => {
      const question = input.trim();
      setMessages((prev) => [...prev, { role: "user", content: question }]);
      setInput("");
      setLoading(true);
      
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;

        const res = await fetch("/api/ask", {
          method: "POST",
          headers,
          body: JSON.stringify({
            question,
            mode: "advisor",
            language: lang,
            history: messages.slice(-8),
          }),
        });

        if (!res.ok) throw new Error();
        const data = await res.json();
        setMessages((prev) => [...prev, { role: "assistant", content: data.answer }]);
        setShowSuggestions(false);
      } catch {
        setMessages((prev) => [...prev, { role: "assistant", content: lang === "ar" ? "حدث خطأ، حاول مرة أخرى" : "Error, please try again" }]);
      } finally {
        setLoading(false);
      }
    });
  };

  return (
    <div className="mx-auto flex h-[calc(100vh-80px)] max-w-3xl flex-col px-4 py-4 slide-up">
      {/* Premium Header */}
      <div className="mb-4 flex items-center justify-between rounded-2xl bg-gradient-to-r from-amber-500/10 to-amber-600/5 p-4 border border-amber-500/20 shadow-lg shadow-amber-500/10 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-400 text-black shadow-lg shadow-amber-500/20">
              <Bot className="h-7 w-7" />
            </div>
            <div className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 border-2 border-[#0B0B0F]">
              <Zap className="h-3 w-3 text-white fill-white" />
            </div>
          </div>
          <div>
            <h1 className="font-serif text-lg font-bold text-amber-400">
              {lang === "ar" ? "المساعد الشخصي الذكي" : "Smart AI Advisor"}
            </h1>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-bold uppercase tracking-wider">
                <ShieldCheck className="h-3 w-3" /> {lang === "ar" ? "متصل بأسعار السوق" : "Market Live Sync"}
              </span>
            </div>
          </div>
        </div>
        {isPremium && (
          <div className="hidden sm:flex items-center gap-2 rounded-full bg-amber-400/10 px-3 py-1 border border-amber-400/20">
            <Zap className="h-3 w-3 text-amber-400" />
            <span className="text-[10px] font-bold text-amber-400 uppercase">Premium Member</span>
          </div>
        )}
      </div>

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto rounded-3xl border border-zinc-800 bg-zinc-900/40 p-6 mb-4 space-y-6 scrollbar-hide backdrop-blur-sm">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="mb-6 relative">
              <div className="absolute inset-0 blur-3xl bg-amber-500/20 rounded-full" />
              <div className="relative flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-amber-400 to-amber-600 shadow-2xl shadow-amber-500/40">
                <Brain className="h-10 w-10 text-black" />
              </div>
            </div>
            <h2 className="font-serif text-2xl font-bold text-zinc-100 mb-2">
              {lang === "ar" ? "أهلاً بك في المستقبل" : "Welcome to the Future"}
            </h2>
            <p className="text-sm text-zinc-500 max-w-xs mb-8">
              {lang === "ar" 
                ? "أنا مساعدك الشخصي، هساعدك تشتري صح وتوفر فلوسك ببيانات حقيقية من السوق."
                : "I'm your personal advisor, helping you buy smart and save money with real market data."}
            </p>
            
            <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
              {starterQuestions.map((q, i) => (
                <button
                  key={i}
                  onClick={() => { setInput(q); }}
                  className="card-hover rounded-2xl border border-zinc-800 bg-zinc-800/30 p-4 text-right text-xs text-zinc-400 transition-all hover:border-amber-500/30 hover:bg-amber-500/5 hover:text-amber-400"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-2xl px-5 py-3 shadow-sm ${
              msg.role === "user" 
                ? "bg-amber-500 text-black font-medium rounded-tr-none" 
                : "bg-zinc-800 text-zinc-100 border border-zinc-700 rounded-tl-none"
            }`}>
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-zinc-800 border border-zinc-700 rounded-2xl rounded-tl-none px-5 py-3 flex gap-1">
              <div className="h-1.5 w-1.5 bg-amber-400 rounded-full animate-bounce" />
              <div className="h-1.5 w-1.5 bg-amber-400 rounded-full animate-bounce [animation-delay:0.2s]" />
              <div className="h-1.5 w-1.5 bg-amber-400 rounded-full animate-bounce [animation-delay:0.4s]" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="relative">
        <div className="absolute -top-12 left-0 right-0 flex justify-center px-4 pointer-events-none">
          <div className="bg-zinc-900/80 backdrop-blur-md border border-amber-500/20 rounded-full px-4 py-1.5 flex items-center gap-2 shadow-xl pointer-events-auto">
            <TrendingUp className="h-3 w-3 text-emerald-400" />
            <span className="text-[10px] font-bold text-zinc-300 uppercase tracking-wider">
              {lang === "ar" ? "أسعار السوق محدثة الآن" : "Market prices updated now"}
            </span>
          </div>
        </div>
        
        <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-900 p-2 shadow-2xl focus-within:border-amber-500/50 transition-colors">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder={lang === "ar" ? "اسألني أي حاجة..." : "Ask me anything..."}
            className="flex-1 border-none bg-transparent text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-0 h-12"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            className="cta-glow flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 text-black transition-all hover:from-amber-300 hover:to-amber-500 disabled:opacity-40 shadow-lg shadow-amber-500/20"
          >
            {loading ? <RefreshCw className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
          </button>
        </div>
        <p className="mt-2 text-center text-[10px] text-zinc-600">
          Powered by Qarari Intelligence • Egyptian Market Data v2.4
        </p>
      </div>
    </div>
  );
}
