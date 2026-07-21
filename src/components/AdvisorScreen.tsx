import { useState, useRef, useEffect, useCallback } from "react";
import { useApp } from "@/lib/AppContext";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MessageCircle, Send, Mic, ChevronLeft, Bot, Brain, Sparkles, X, Lock,
} from "lucide-react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function AdvisorScreen() {
  const { t, lang, dir, navigate, session, isPremium, showToast, requireAuth } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [maxMsgs, setMaxMsgs] = useState<number>(300);
  const [limitHit, setLimitHit] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [proactiveSuggestion, setProactiveSuggestion] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Suggested starter questions
  const starterQuestionsAr = [
    "معايا 30 ألف وعايز لابتوب للدراسة، إيه أفضل خيار؟",
    "إيه أحسن موبايل كاميرا في 25 ألف؟",
    "عايز أشتري شاشة TV بحجم 55 بوصة، إيه أفضل ماركات؟",
    "فرق إيه بين iPhone 15 و iPhone 14؟ يستاهل الفلوس الزيادة؟",
    "عايز سماعات بلوتوث تحت 2000 جنيه، أيها أحسن؟",
    "هل Samsung S24 أحسن من iPhone 15 بنفس السعر؟",
  ];

  const starterQuestionsEn = [
    "I have 30K EGP and need a laptop for studying, what's the best option?",
    "What's the best camera phone under 25K EGP?",
    "I want a 55-inch TV, what are the best brands?",
    "What's the difference between iPhone 15 and iPhone 14? Is the upgrade worth it?",
    "I need Bluetooth earphones under 2000 EGP, which ones are best?",
    "Is Samsung S24 better than iPhone 15 at the same price?",
  ];

  const starterQuestions = lang === "ar" ? starterQuestionsAr : starterQuestionsEn;

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Fetch remaining advisor messages
  useEffect(() => {
    async function fetchRemaining() {
      try {
        const headers: Record<string, string> = {};
        if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({
            question: "ping",
            mode: "advisor",
            language: lang,
          }),
        });
        // 401 means not authed — expected for guests
        if (res.status === 401) return;
        // 403 means limit hit
        if (res.status === 403) {
          const data = await res.json();
          setLimitHit(true);
          setRemaining(data.remaining || 0);
          return;
        }
      } catch {
        // silent
      }
    }
    fetchRemaining();
  }, [session, lang]);

  // Generate a proactive suggestion after first AI response
  useEffect(() => {
    if (messages.length >= 2) {
      // Show a proactive hint after user has asked at least one question
      const hintsAr = [
        "💡 لو قولتلي الميزانية بالظبط، هقدر أدلك على خيارات أدق!",
        "💡 عندي مقارنة بين المنتجات، يلا نعمل مقارنة؟",
        "💡 ممكن أساعدك تلاقي أفضل عرض في السوق!",
        "💡 لو عايز تحفظ المنتج ده، أضيفه على المراقبة؟",
      ];
      const hintsEn = [
        "💡 If you tell me your exact budget, I can give more precise options!",
        "💡 Want me to compare products side by side?",
        "💡 I can help you find the best deal in the market!",
        "💡 Want me to add this to your watchlist?",
      ];
      const hints = lang === "ar" ? hintsAr : hintsEn;
      const randomHint = hints[Math.floor(Math.random() * hints.length)];
      setTimeout(() => setProactiveSuggestion(randomHint), 2000);
    }
  }, [messages.length, lang]);

  const handleStarterClick = async (question: string) => {
    // Check auth first
    requireAuth(async () => {
      setMessages((prev) => [...prev, { role: "user", content: question }]);
      setInput("");
      setLoading(true);
      await sendQuestion(question);
    });
  };

  const handleSend = () => {
    if (!input.trim() || loading) return;
    if (limitHit && !isPremium) return;

    // Check auth first
    requireAuth(async () => {
      const question = input.trim();
      setMessages((prev) => [...prev, { role: "user", content: question }]);
      setInput("");
      setLoading(true);
      await sendQuestion(question);
    });
  };

  const sendQuestion = async (question: string) => {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (session?.access_token) {
        headers.Authorization = `Bearer ${session.access_token}`;
      }

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

      if (res.status === 401) {
        showToast(lang === "ar" ? "من فضلك سجّل دخول لاستخدام المساعد الذكي" : "Please sign in to use the smart advisor");
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: lang === "ar" ? "عشان أقدر أفتكر اهتماماتك وأقدملك نصائح مخصصة ليك، ياريت تسجل دخولك" : "To remember your interests and provide personalized advice, please sign in" },
        ]);
        navigate("login");
        return;
      }

      if (res.status === 403) {
        const data = await res.json();
        setLimitHit(true);
        setRemaining(data.remaining || 0);
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: lang === "ar" ? "وصلت للحد الشهري. يلا نعمل upgrade!" : "You've reached the monthly limit. Let's upgrade!" },
        ]);
        return;
      }

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: lang === "ar" ? "حدث خطأ، حاول مرة أخرى" : "Something went wrong, please retry" },
        ]);
        return;
      }

      const data = await res.json();
      setMessages((prev) => [...prev, { role: "assistant", content: data.answer }]);
      setShowSuggestions(false);
      setProactiveSuggestion(null); // Reset old suggestions

      if (!data.unlimited && typeof data.remaining === "number") {
        setRemaining(data.remaining);
        setMaxMsgs(data.max || 300);
        if (data.remaining <= 0) setLimitHit(true);
      }

      // Generate contextual proactive suggestions based on conversation
      setTimeout(() => {
        const lastQuestion = messages[messages.length - 1]?.content || question;
        const contextHintsAr: Record<string, string> = {
          "موبايل": "💡 شفت إنك بتدوّر على موبايل، في عرض جديد على iPhone 14 دلوقت!",
          "iphone": "💡 شفت إنك مهتم بـ iPhone، في نسخة أحدث نزلت، تحب أقارنلك؟",
          "لابتوب": "💡 لابتوبات للدراسة، الـ Acer و Lenovo معمولين عليهم عروض كويسة دلوقت!",
          "laptop": "💡 Great laptops for studying — Acer and Lenovo have good deals right now!",
          "سماعات": "💡 سماعات الـ AirPods Pro عليها خصم في أكتر من محل دلوقت!",
          "تلفزيون": "💡 تلفزيونات Samsung QLED عليها عروض نهاية شهر!",
        };
        const contextHintsEn: Record<string, string> = {
          "موبايل": "💡 I noticed you're looking for a phone — there's a new deal on iPhone 14 right now!",
          "iphone": "💡 I see you're interested in iPhone — a newer version is available, want me to compare?",
          "لابتوب": "💡 For study laptops — Acer and Lenovo have great deals right now!",
          "laptop": "💡 Great laptops for studying — Acer and Lenovo have good deals right now!",
          "سماعات": "💡 AirPods Pro are on sale at multiple stores right now!",
          "تلفزيون": "💡 Samsung QLED TVs have end-of-month promotions!",
        };

        const hints = lang === "ar" ? contextHintsAr : contextHintsEn;
        let matchedHint = null;
        for (const [keyword, hint] of Object.entries(hints)) {
          if (lastQuestion.toLowerCase().includes(keyword)) {
            matchedHint = hint;
            break;
          }
        }
        // Fallback generic proactive hints
        if (!matchedHint) {
          const genericAr = [
            "💡 لو عايز أقارن بين منتج معين وده، قوللي!",
            "💡 هل تحب أحفظ المنتج ده في المفضلة؟",
            "💡 ممكن أساعدك تلاقي عرض أفضل!",
            "💡 لو عندك جهاز حالي وتبدله، ممكن توفّر أكتر!",
          ];
          const genericEn = [
            "💡 Want me to compare this with another product?",
            "💡 Should I add this to your favorites?",
            "💡 I can help you find a better deal!",
            "💡 Trading in your current device could save you more!",
          ];
          const generic = lang === "ar" ? genericAr : genericEn;
          matchedHint = generic[Math.floor(Math.random() * generic.length)];
        }
        setProactiveSuggestion(matchedHint);
      }, 1500);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: lang === "ar" ? "تعذر الاتصال بالخادم" : "Couldn't reach the server" },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 flex flex-col" style={{ minHeight: "calc(100vh - 140px)" }}>
      {/* Header */}
      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={() => navigate("input")}
          className="flex items-center gap-1 text-sm text-zinc-400 hover:text-amber-400"
        >
          <ChevronLeft className={`h-4 w-4 ${dir === "rtl" ? "rotate-180" : ""}`} />
          {t("back")}
        </button>
        <div className="flex-1 flex items-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 shadow-lg shadow-amber-500/20">
            <Bot className="h-5 w-5 text-[#0B0B0F]" />
          </div>
          <div>
            <h1 className="font-serif text-lg font-bold text-amber-400">
              {lang === "ar" ? "المساعد الشخصي" : "Personal Advisor"}
            </h1>
            <p className="text-xs text-zinc-500">
              {lang === "ar" ? "اسألني أي سؤال عن الشراء" : "Ask me anything about shopping"}
            </p>
          </div>
        </div>
        {isPremium && (
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-[10px] font-bold text-emerald-400">
            <Sparkles className="h-3 w-3" /> {lang === "ar" ? "غير محدود" : "Unlimited"}
          </span>
        )}
      </div>

      {/* Memory indicator */}
      {session?.user && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-500/15 bg-amber-500/5 px-3 py-2">
          <Brain className="h-4 w-4 text-amber-400" />
          <p className="text-xs text-amber-300">
            {lang === "ar" ? "الذاكرة الذكية نشطة — هفتكر اهتماماتك!" : "Smart memory active — I'll remember your interests!"}
          </p>
        </div>
      )}

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto rounded-2xl border border-amber-500/15 bg-zinc-900/40 p-4 mb-4 space-y-3">
        {messages.length === 0 && showSuggestions ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="mb-6 text-center">
              <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400/20 to-amber-600/20">
                <MessageCircle className="h-7 w-7 text-amber-400" />
              </div>
              <h2 className="font-serif text-xl font-bold text-amber-400 mb-1">
                {lang === "ar" ? "أهلاً! أنا مساعدك الشخصي" : "Hi! I'm your personal advisor"}
              </h2>
              <p className="text-sm text-zinc-400 max-w-sm">
                {lang === "ar"
                  ? "اسألني عن أي منتج، ميزانية، أو مقارنة وأنا هساعدك تلاقي أفضل خيار"
                  : "Ask me about any product, budget, or comparison and I'll help you find the best option"}
              </p>
            </div>

            {/* Login prompt for non-authenticated users */}
            {!session?.user && (
              <div className="mb-5 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-center max-w-sm">
                <Lock className="h-5 w-5 text-amber-400 mx-auto mb-2" />
                <p className="text-sm text-amber-300">
                  {lang === "ar"
                    ? "عشان أقدر أفتكر اهتماماتك وأقدملك نصائح مخصصة ليك، ياريت تسجل دخولك"
                    : "To remember your interests and provide personalized advice, please sign in"}
                </p>
                <Button
                  onClick={() => navigate("login")}
                  className="mt-3 bg-gradient-to-r from-amber-400 to-amber-600 text-[#0B0B0F] font-bold text-sm hover:from-amber-300 hover:to-amber-500"
                >
                  {lang === "ar" ? "سجّل دخولك" : "Sign In"}
                </Button>
              </div>
            )}

            {/* Suggested questions */}
            <div className="w-full max-w-md space-y-2">
              {starterQuestions.map((q, i) => (
                <button
                  key={i}
                  onClick={() => handleStarterClick(q)}
                  className="w-full text-start rounded-xl border border-zinc-700/50 bg-zinc-800/50 px-4 py-3 text-sm text-zinc-300 hover:border-amber-500/30 hover:bg-amber-500/5 hover:text-amber-300 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm ${
                    msg.role === "user"
                      ? "bg-amber-500/20 text-amber-100 rounded-br-sm"
                      : "bg-zinc-800 text-zinc-200 rounded-bl-sm"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}

            {/* Proactive suggestion */}
            {proactiveSuggestion && (
              <div className="flex justify-start animate-in">
                <div className="max-w-[85%] rounded-xl px-4 py-2 text-xs bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 rounded-bl-sm">
                  {proactiveSuggestion}
                </div>
              </div>
            )}

            {loading && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-xl bg-zinc-800 px-4 py-2.5 text-sm text-zinc-400 flex items-center gap-2">
                  <div className="flex gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                  {lang === "ar" ? "بفكر..." : "Thinking..."}
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Usage counter */}
      {!isPremium && remaining !== null && (
        <div className="mb-2 text-center">
          <span className={`text-xs ${remaining <= 20 ? "text-red-400" : "text-zinc-500"}`}>
            {lang === "ar" ? `متبقي ${remaining} رسالة من ${maxMsgs}` : `${remaining} messages left of ${maxMsgs}`}
          </span>
        </div>
      )}

      {/* Input */}
      <div className="flex items-center gap-2 rounded-2xl border border-amber-500/20 bg-zinc-900/80 p-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          placeholder={lang === "ar" ? "اسألني أي سؤال..." : "Ask me anything..."}
          disabled={loading || (limitHit && !isPremium)}
          className="flex-1 border-0 bg-transparent text-zinc-100 placeholder:text-zinc-600 focus:ring-0 text-sm"
        />
        <button
          onClick={handleSend}
          disabled={loading || !input.trim() || (limitHit && !isPremium)}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-r from-amber-400 to-amber-600 text-[#0B0B0F] hover:from-amber-300 hover:to-amber-500 disabled:opacity-30 transition-all"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>

      {/* Upgrade prompt if limit hit */}
      {limitHit && !isPremium && (
        <button
          onClick={() => navigate("upgrade")}
          className="mt-3 w-full rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-400 hover:bg-amber-500/15 transition-colors"
        >
          {lang === "ar" ? "👑 ارفع حدك — اشترك بريميوم لرسائل غير محدودة!" : "👑 Upgrade to premium for unlimited messages!"}
        </button>
      )}
    </div>
  );
}
